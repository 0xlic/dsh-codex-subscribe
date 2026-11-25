const DAY = 24 * 60 * 60 * 1000
/**
 * The Codex backend filters its catalog by `client_version`, dropping every
 * model whose minimal client version is higher; an unknown or too-old client
 * version comes back as `{"models":[]}` with HTTP 200. This value stays in the
 * 0.x line (1.x answers with settings no release gets) and sits above every 0.x
 * gate, so an account sees the models its subscription is entitled to.
 */
export const CODEX_CATALOG_CLIENT_VERSION = '0.999.0'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 1000
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const failure = () => new Error('Unable to refresh the Codex model catalog')
const aborted = () => new DOMException('Model catalog operation aborted', 'AbortError')
const level = value => value === 'none' ? 'off' : LEVELS.includes(value) ? value : undefined
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000
const account = value => typeof value?.accountId === 'string' && value.accountId.length > 0 ? value.accountId : undefined
const etagValue = value => typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value) ? value : undefined

// A waiter's cancellation must not cancel the shared fetch (or another waiter).
function waitFor(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    // Work may already have been queued; observe its eventual rejection too.
    promise.catch(() => {})
    return Promise.reject(aborted())
  }
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()) }
    const cleanup = () => signal.removeEventListener('abort', cancel)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

// Keep only public model metadata in memory/disk; never persist credentials or
// arbitrary server fields. The same validation is applied to untrusted caches.
function parseCatalog(payload) {
  if (JSON.stringify(payload)?.length > MAX_BYTES) throw failure()
  const entries = Array.isArray(payload) ? payload : payload?.models
  if (!Array.isArray(entries) || entries.length > MAX_MODELS) throw failure()
  const models = []
  const seen = new Set()
  let validEntries = 0
  for (const entry of entries) {
    if (!entry || !['list', 'hide', 'hidden'].includes(entry.visibility) || typeof entry.slug !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.slug) || seen.has(entry.slug)) continue
    validEntries++
    seen.add(entry.slug)
    if (entry.visibility !== 'list') continue
    if (Array.isArray(entry.input_modalities) && !entry.input_modalities.some(value => value === 'text' || value === 'image')) continue
    const speedTiers = [
      ...(Array.isArray(entry.additional_speed_tiers) ? entry.additional_speed_tiers : []),
      ...(Array.isArray(entry.service_tiers) ? entry.service_tiers.map(tier => tier?.id) : []),
    ]
    const model = { slug: entry.slug, visibility: 'list',
      additional_speed_tiers: speedTiers.some(tier => tier === 'fast' || tier === 'priority') ? ['priority'] : [],
    }
    if (typeof entry.display_name === 'string' && entry.display_name.length <= 256 && !/[\x00-\x1f]/.test(entry.display_name)) model.display_name = entry.display_name
    for (const key of ['context_window', 'max_context_window']) if (positive(entry[key])) model[key] = entry[key]
    if (Number.isFinite(entry.effective_context_window_percent) && entry.effective_context_window_percent > 0 && entry.effective_context_window_percent <= 100) model.effective_context_window_percent = entry.effective_context_window_percent
    if (Array.isArray(entry.input_modalities)) model.input_modalities = [...new Set(entry.input_modalities.filter(value => value === 'text' || value === 'image'))]
    if (Array.isArray(entry.supported_reasoning_levels)) {
      model.supported_reasoning_levels = [...new Set(entry.supported_reasoning_levels.map(value => level(typeof value === 'string' ? value : value?.effort)).filter(Boolean))]
    }
    const defaultLevel = level(entry.default_reasoning_level)
    if (defaultLevel) model.default_reasoning_level = defaultLevel
    models.push(model)
  }
  // The backend answers an under-privileged or unknown client version with an
  // empty list, so an empty (or all-hidden) catalog is never proof that this
  // account owns no models. Treat it as a failed refresh instead of publishing
  // an empty picker that would also hide the built-in fallback.
  if (!models.length) throw failure()
  if (entries.length && !validEntries) throw failure()
  return { models }
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function mergeModels(base, raw) {
  // A successful catalog is authoritative. Builtins are transport templates and
  // an offline fallback, not a way to reintroduce hidden or removed models.
  const result = new Map()
  const template = base.find(model => !/spark/i.test(model.id) && (!model.type || model.type === 'chat'))
  for (const remote of raw.models) {
    const existing = base.find(model => model.id === remote.slug)
    const source = existing ?? template
    if (!source) continue // No known working transport: builtin fallback still works.
    const model = existing ? structuredClone(existing) : {
      id: remote.slug, name: remote.slug,
      api: source.api, provider: source.provider, baseUrl: source.baseUrl,
      ...(source.type ? { type: source.type } : {}),
      ...(source.headers ? { headers: structuredClone(source.headers) } : {}),
      input: ['text'], reasoning: false,
      contextWindow: source.contextWindow, maxTokens: source.maxTokens,
      // Unknown subscription pricing must not inherit another model's prices.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    model.name = remote.display_name || model.name
    const context = remote.context_window ?? remote.max_context_window
    if (context) {
      model.contextWindow = Math.max(1, Math.floor(context * (remote.effective_context_window_percent ?? 100) / 100))
      model.maxTokens = Math.min(model.maxTokens, model.contextWindow)
    }
    if (remote.input_modalities?.length) model.input = [...remote.input_modalities]
    const supported = remote.supported_reasoning_levels ?? (remote.default_reasoning_level ? [remote.default_reasoning_level] : undefined)
    if (supported) {
      model.thinkingLevelMap = Object.fromEntries(LEVELS.map(value => [value, supported.includes(value) ? (value === 'off' ? 'none' : value) : null]))
      model.reasoning = supported.some(value => value !== 'off')
    }
    result.set(model.id, model)
  }
  return freeze([...result.values()])
}

async function readPayload(response) {
  const size = Number(response.headers?.get('content-length'))
  if (size > MAX_BYTES) throw failure()
  if (!response.body?.getReader) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw failure()
    return JSON.parse(text)
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BYTES) throw failure()
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Account-scoped, lazy Codex catalog. No timers or I/O until ready/refresh. */
export function createModelCatalog({
  baseModels, getCredential, readCredential, cache, onUpdated = () => {},
  fetch: request = globalThis.fetch, now = Date.now, timeoutMs = 15_000,
  ttlMs = DAY, clientVersion = CODEX_CATALOG_CLIENT_VERSION,
}) {
  if (typeof baseModels !== 'function' || typeof getCredential !== 'function' || typeof readCredential !== 'function') throw new TypeError('Model catalog credential and model readers are required')
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0) || !(Number.isFinite(ttlMs) && ttlMs >= 0)) throw new TypeError('Invalid model catalog timing')
  let models
  let source = 'builtin'
  let refreshState = 'idle'
  let identity
  let generation = 0
  let disposed = false
  const lifetime = new AbortController()
  let flight
  let loadedCache = false
  let entry
  let attemptedAt
  const builtin = () => freeze(structuredClone(baseModels()))
  const currentModels = () => (models ??= builtin())
  const notify = () => { try { onUpdated() } catch { /* Host notification is best-effort. */ } }
  function reset(id) {
    const hadCatalog = source !== 'builtin'
    generation++
    flight?.controller.abort()
    flight = undefined
    identity = id
    models = undefined
    entry = undefined
    loadedCache = false
    attemptedAt = undefined
    source = 'builtin'
    refreshState = 'idle'
    if (hadCatalog && !disposed) notify()
  }
  async function identify(signal) {
    // Identity reads happen before joining a flight so an account switch can
    // invalidate a request already in progress. Bound these reads as well.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const combined = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])])
    try {
      const id = account(await waitFor(Promise.resolve().then(readCredential), combined))
      if (disposed) throw aborted()
      if (identity !== id) reset(id)
      return id
    } catch {
      if (disposed || signal?.aborted) throw aborted()
      throw failure()
    } finally { clearTimeout(timer) }
  }
  async function run(id, epoch, signal) {
    const current = () => !disposed && generation === epoch && !signal.aborted
    const verify = async () => {
      if (!current()) throw aborted()
      const idNow = account(await readCredential())
      if (!current()) throw aborted()
      if (idNow !== id) { reset(idNow); throw aborted() }
    }
    if (!id) throw failure()
    if (!loadedCache) {
      loadedCache = true
      let cached
      try { cached = await cache?.read(id) } catch { /* Disk failure cannot break the builtin fallback. */ }
      await verify()
      if (cached) {
        try {
          if (!Number.isFinite(cached.savedAt) || cached.savedAt > now() || now() - cached.savedAt >= ttlMs) throw failure()
          const rawCatalog = parseCatalog(cached.rawCatalog)
          // Older versions discarded speed metadata. Fetch a full catalog once
          // instead of perpetually revalidating that incomplete entry with 304.
          const hasSpeedMetadata = Array.isArray(cached.rawCatalog?.models)
            && cached.rawCatalog.models.every(model => Array.isArray(model?.additional_speed_tiers))
          entry = { savedAt: cached.savedAt, etag: hasSpeedMetadata ? etagValue(cached.etag) : undefined, rawCatalog }
          models = mergeModels(baseModels(), rawCatalog)
          source = 'cached'
          notify()
        } catch {
          try { await cache?.remove(id) } catch { /* Invalid cache is simply ignored. */ }
        }
      }
    }
    const credential = await getCredential({ signal })
    await verify()
    if (account(credential) !== id || typeof credential?.access !== 'string' || !credential.access || /[\r\n]/.test(credential.access) || /[\r\n]/.test(id)) throw failure()
    const headers = { Authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': id, Accept: 'application/json', originator: 'pi' }
    if (entry?.etag) headers['If-None-Match'] = entry.etag
    const url = new URL('https://chatgpt.com/backend-api/codex/models')
    url.searchParams.set('client_version', clientVersion)
    const response = await request(url.href, { method: 'GET', headers, signal, redirect: 'error' })
    let rawCatalog
    if (response.status === 304) {
      if (!entry) throw failure()
      rawCatalog = entry.rawCatalog
    } else {
      if (!response.ok) throw failure()
      rawCatalog = parseCatalog(await readPayload(response))
    }
    await verify()
    const next = { savedAt: now(), rawCatalog }
    const etag = etagValue(response.headers?.get('etag')) ?? (response.status === 304 ? entry?.etag : undefined)
    if (etag) next.etag = etag
    // Recheck identity before disk write and again before publishing. No stale
    // request can publish/notify after account changes or disposal.
    try { await cache?.write(id, structuredClone(next)) } catch { /* Online metadata remains usable without disk. */ }
    await verify()
    entry = next
    models = mergeModels(baseModels(), rawCatalog)
    source = 'online'
    refreshState = 'ok'
    notify()
  }
  async function invoke(force, signal) {
    if (disposed || signal?.aborted) throw aborted()
    let id
    try { id = await identify(signal) } catch (error) {
      if (disposed || signal?.aborted || error?.name === 'AbortError') throw aborted()
      refreshState = 'failed'
      if (force) throw failure()
      return
    }
    const cooldown = refreshState === 'failed' ? Math.min(ttlMs, 60_000) : ttlMs
    if (!flight && !force && attemptedAt !== undefined && now() - attemptedAt < cooldown) return
    if (!flight) {
      const controller = new AbortController()
      const epoch = generation
      attemptedAt = now()
      refreshState = 'refreshing'
      const active = { controller }
      flight = active
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      active.promise = waitFor(Promise.resolve().then(() => run(id, epoch, controller.signal)), controller.signal)
        .catch(() => {
          controller.abort()
          if (disposed || generation !== epoch) throw aborted()
          refreshState = 'failed'
          throw failure()
        }).finally(() => {
          clearTimeout(timer)
          if (flight === active) flight = undefined
        })
    }
    try { await waitFor(flight.promise, signal) } catch (error) {
      if (disposed || signal?.aborted || error?.name === 'AbortError') throw aborted()
      if (force) throw failure()
    }
  }
  return {
    ready: ({ signal } = {}) => invoke(false, signal),
    refresh: ({ signal } = {}) => invoke(true, signal),
    getModels: currentModels,
    supportsFast: model => entry?.rawCatalog.models.some(item => item.slug === model && item.additional_speed_tiers.includes('priority')) === true,
    status: () => ({ source, refresh: refreshState, count: currentModels().length }),
    dispose() { if (!disposed) { disposed = true; generation++; lifetime.abort(); flight?.controller.abort() } },
  }
}
