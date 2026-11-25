import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelCatalog } from '../src/model-catalog.js'

const base = [
  { id: 'legacy-spark', name: 'Spark', api: 'spark-api', provider: 'openai-codex', baseUrl: 'spark', input: ['text'], reasoning: true, contextWindow: 128000, maxTokens: 32000, cost: { input: 99 } },
  { id: 'known', name: 'Known', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', input: ['text', 'image'], reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 2, output: 10, cacheRead: 1, cacheWrite: 0 }, compat: { supportsToolSearch: true } },
]
const remote = (slug = 'future-codex') => ({ slug, visibility: 'list', display_name: 'Future', context_window: 250000, max_context_window: 500000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], default_reasoning_level: 'medium' })
const payload = (...entries) => ({ models: entries.length ? entries : [remote()] })
const response = (body = payload(), options = {}) => new Response(JSON.stringify(body), { status: 200, ...options })
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(options = {}) {
  let id = 'account-a'
  let time = 1000
  let calls = 0
  let updates = 0
  const requests = []
  const disk = new Map()
  const writes = []
  const removed = []
  const catalog = createModelCatalog({
    baseModels: () => base,
    getCredential: async () => ({ accountId: id, access: 'private-token' }),
    readCredential: async () => ({ accountId: id }),
    cache: {
      read: async key => disk.get(key),
      write: async (key, value) => { writes.push([key, value]); disk.set(key, value) },
      remove: async key => { removed.push(key); disk.delete(key) },
    },
    onUpdated: () => { updates++ }, now: () => time,
    fetch: async (...args) => { calls++; requests.push(args); return response() },
    ...options,
  })
  return { catalog, disk, writes, removed, requests, set id(value) { id = value }, set time(value) { time = value }, get calls() { return calls }, get updates() { return updates } }
}

test('lazy builtin fallback and dynamic slug merging preserve only known transport/cost metadata', async () => {
  const f = fixture()
  assert.deepEqual(f.catalog.status(), { source: 'builtin', refresh: 'idle', count: 2 })
  assert.equal(f.calls, 0)
  await f.catalog.ready()
  assert.deepEqual(f.catalog.status(), { source: 'online', refresh: 'ok', count: 1 })
  const model = f.catalog.getModels().find(value => value.id === 'future-codex')
  assert.equal(model.api, 'openai-codex-responses', 'never use Spark template for new slugs')
  assert.equal(model.contextWindow, 250000)
  assert.equal(model.maxTokens, 64000)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(model.compat, undefined, 'do not invent tool-search capabilities')
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null })
  assert.equal(model.reasoning, true)
  assert.equal(f.catalog.getModels().find(value => value.id === 'known'), undefined, 'removed builtins must not stay visible')
  assert.throws(() => model.input.push('invalid'), TypeError)
  assert.equal(f.catalog.getModels(), f.catalog.getModels(), 'snapshot reference is stable until publication')
  assert.deepEqual(f.catalog.getModels().at(-1).input, ['text', 'image'])
  assert.equal(base.length, 2)
})

test('effective context percentage is applied once, including after cache restart', async () => {
  const first = fixture({ fetch: async () => response(payload({ ...remote(), effective_context_window_percent: 95 })) })
  await first.catalog.ready()
  assert.equal(first.catalog.getModels()[0].contextWindow, 237500)
  const cached = first.writes[0][1]
  const second = fixture({ cache: { read: async () => cached }, fetch: async () => { throw new Error('offline') } })
  await second.catalog.ready()
  assert.equal(second.catalog.getModels()[0].contextWindow, 237500)
  assert.equal(second.catalog.status().source, 'cached')
})

test('the default client version sits above every 0.x catalog gate', async () => {
  // Sending the plugin's own version (0.3.x) made the backend hide every model.
  const f = fixture()
  await f.catalog.ready()
  assert.equal(new URL(f.requests[0][0]).searchParams.get('client_version'), '0.999.0')
})

test('a cached empty catalog from the version-gating bug is discarded instead of blanking the picker', async () => {
  const f = fixture({ cache: { read: async () => ({ savedAt: 999, rawCatalog: { models: [] } }), write: async () => {}, remove: async () => {} },
    fetch: async () => { throw new Error('offline') } })
  await f.catalog.ready()
  assert.deepEqual(f.catalog.getModels(), base)
  assert.equal(f.catalog.status().source, 'builtin')
})

test('official endpoint, account header, redirect policy and client version', async () => {
  const f = fixture({ clientVersion: 'custom version' })
  await f.catalog.ready()
  const [url, options] = f.requests[0]
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/models?client_version=custom+version')
  assert.deepEqual(options.headers, { Authorization: 'Bearer private-token', 'chatgpt-account-id': 'account-a', Accept: 'application/json', originator: 'pi' })
  assert.equal(options.method, 'GET')
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal)
  const stored = JSON.stringify(f.writes)
  assert.equal(stored.includes('private-token'), false)
  assert.equal(stored.includes('access'), false)
})

test('exact model updates preserve transport, compatibility and correct model pricing', async () => {
  const f = fixture({ fetch: async () => response(payload({ ...remote('known'), context_window: undefined, max_context_window: 300000, supported_reasoning_levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] })) })
  await f.catalog.ready()
  const model = f.catalog.getModels().find(value => value.id === 'known')
  assert.deepEqual(model.compat, base[1].compat)
  assert.deepEqual(model.cost, base[1].cost)
  assert.equal(model.contextWindow, 300000)
  assert.deepEqual(model.thinkingLevelMap, { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
})

test('only validated visible slugs are accepted; unknown optional capabilities are not invented', async () => {
  const f = fixture({ fetch: async () => response(payload(
    { ...remote(), visibility: 'hide' }, remote('../unsafe'), remote('has space'), remote('a'.repeat(129)),
    { slug: 'new-public-model', visibility: 'list', default_reasoning_level: 'none', context_window: -1 },
    { slug: 'audio-model', visibility: 'list', input_modalities: ['audio', 'video'] },
    { ...remote('new-public-model'), context_window: 999 },
  )) })
  await f.catalog.ready()
  const added = f.catalog.getModels().at(-1)
  assert.equal(added.id, 'new-public-model')
  assert.equal(added.contextWindow, 200000)
  assert.deepEqual(added.input, ['text'])
  assert.equal(added.reasoning, false)
  assert.equal(added.thinkingLevelMap.off, 'none')
  assert.equal(added.thinkingLevelMap.high, null)
  assert.equal(f.catalog.getModels().length, 1)
})

test('ready suppresses network/auth failures; manual refresh returns only a safe generic error', async () => {
  const f = fixture({ fetch: async () => { throw new Error('Bearer secret-token account-private') } })
  await f.catalog.ready()
  assert.deepEqual(f.catalog.status(), { source: 'builtin', refresh: 'failed', count: 2 })
  assert.deepEqual(f.catalog.getModels(), base)
  await assert.rejects(f.catalog.refresh(), error => error.message === 'Unable to refresh the Codex model catalog' && error.cause === undefined)
  const auth = fixture({ getCredential: async () => { throw new Error('secret credential') } })
  await auth.catalog.ready()
  assert.equal(auth.catalog.status().refresh, 'failed')
})

test('failed revalidation preserves online models and does not log/store response secrets', async () => {
  let fail = false
  const f = fixture({ fetch: async () => { if (fail) return new Response('secret body', { status: 401 }); return response({ ...payload(), access: 'server-secret' }) } })
  await f.catalog.ready()
  fail = true
  await assert.rejects(f.catalog.refresh(), /Unable to refresh/)
  assert.deepEqual(f.catalog.status(), { source: 'online', refresh: 'failed', count: 1 })
  assert.equal(JSON.stringify(f.writes).includes('server-secret'), false)
})

test('ready uses TTL without refetching every call; manual refresh bypasses TTL', async () => {
  const f = fixture({ ttlMs: 100 })
  await f.catalog.ready()
  await f.catalog.ready()
  assert.equal(f.calls, 1)
  f.time = 1100
  await f.catalog.ready()
  assert.equal(f.calls, 2)
  await f.catalog.refresh()
  assert.equal(f.calls, 3)
})

test('fresh account-scoped cache is visible even if remote fails', async () => {
  const f = fixture({ fetch: async () => { throw Error('offline') } })
  f.disk.set('account-a', { savedAt: 900, rawCatalog: payload(remote('cached-model')), etag: '"cached"' })
  f.disk.set('account-b', { savedAt: 900, rawCatalog: payload(remote('other-model')) })
  await f.catalog.ready()
  assert.deepEqual(f.catalog.status(), { source: 'cached', refresh: 'failed', count: 1 })
  assert.equal(f.catalog.getModels().at(-1).id, 'cached-model')
  f.id = 'account-b'
  await f.catalog.ready()
  assert.equal(f.catalog.getModels().at(-1).id, 'other-model')
  assert.equal(f.updates, 3, 'switching away from an account invalidates its published snapshot')
})

test('expired, future and malformed caches are removed without losing builtins', async () => {
  for (const cached of [
    { savedAt: 1000 - 86400000, rawCatalog: payload() },
    { savedAt: 1001, rawCatalog: payload() },
    { savedAt: 900, rawCatalog: { models: 'invalid' } },
  ]) {
    const f = fixture({ fetch: async () => { throw Error('offline') } })
    f.disk.set('account-a', cached)
    await f.catalog.ready()
    assert.deepEqual(f.catalog.getModels(), base)
    assert.deepEqual(f.removed, ['account-a'])
  }
})

test('ETag sent from disk; 304 reuses catalog and refreshes cache timestamp', async () => {
  const f = fixture({ fetch: async (url, options) => {
    assert.equal(options.headers['If-None-Match'], '"old"')
    return new Response(null, { status: 304, headers: { etag: '"new"' } })
  } })
  const rawCatalog = payload()
  for (const model of rawCatalog.models) model.additional_speed_tiers = model.slug === 'future-codex' ? ['priority'] : []
  f.disk.set('account-a', { savedAt: 900, etag: '"old"', rawCatalog })
  await f.catalog.ready()
  assert.equal(f.catalog.status().source, 'online')
  assert.equal(f.disk.get('account-a').etag, '"new"')
  assert.equal(f.disk.get('account-a').savedAt, 1000)
  assert.equal(f.catalog.getModels().at(-1).id, 'future-codex')
  assert.equal(f.catalog.supportsFast('future-codex'), true)
  assert.equal(f.catalog.supportsFast('unknown'), false)
})

test('old caches re-fetch speed metadata; Ultrafast alone does not enable Fast', async () => {
  const f = fixture({ fetch: async (_url, options) => {
    assert.equal(options.headers['If-None-Match'], undefined)
    return response({ models: [
      { slug: 'fast', visibility: 'list', additional_speed_tiers: ['fast'] },
      { slug: 'priority', visibility: 'list', service_tiers: [{ id: 'priority' }] },
      { slug: 'ultrafast', visibility: 'list', additional_speed_tiers: ['ultrafast'] },
    ] })
  } })
  f.disk.set('account-a', { savedAt: 900, etag: '"legacy"', rawCatalog: payload() })
  assert.equal(f.catalog.supportsFast('known'), false)
  await f.catalog.ready()
  assert.equal(f.catalog.supportsFast('fast'), true)
  assert.equal(f.catalog.supportsFast('priority'), true)
  assert.equal(f.catalog.supportsFast('ultrafast'), false)
})

test('ETag from 200 is reused on manual refresh, 304 without prior catalog fails safely', async () => {
  let count = 0
  const f = fixture({ fetch: async (url, options) => {
    if (++count === 1) return response(payload(), { headers: { etag: '"one"' } })
    assert.equal(options.headers['If-None-Match'], '"one"')
    return new Response(null, { status: 304 })
  } })
  await f.catalog.ready()
  await f.catalog.refresh()
  assert.equal(f.disk.get('account-a').etag, '"one"')
  const empty = fixture({ fetch: async () => new Response(null, { status: 304 }) })
  await empty.catalog.ready()
  assert.equal(empty.catalog.status().refresh, 'failed')
})

test('singleflight shares ready/refresh and one waiter cancellation cannot abort shared work', async () => {
  const started = deferred()
  const finish = deferred()
  let requests = 0
  let sharedSignal
  const f = fixture({ fetch: async (url, options) => { requests++; sharedSignal = options.signal; started.resolve(); return finish.promise } })
  const abort = new AbortController()
  const first = f.catalog.ready({ signal: abort.signal })
  const second = f.catalog.ready()
  const manual = f.catalog.refresh()
  await started.promise
  assert.equal(f.catalog.status().refresh, 'refreshing')
  abort.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(sharedSignal.aborted, false)
  finish.resolve(response())
  await Promise.all([second, manual])
  assert.equal(requests, 1)
  assert.equal(f.updates, 1)
})

test('pre-aborted calls reject without credential reads or network requests', async () => {
  const controller = new AbortController()
  controller.abort()
  let reads = 0
  const f = fixture({ readCredential: async () => { reads++; return { accountId: 'a' } } })
  await assert.rejects(f.catalog.ready({ signal: controller.signal }), { name: 'AbortError' })
  await assert.rejects(f.catalog.refresh({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(reads, 0)
  assert.equal(f.calls, 0)
})

test('timeout bounds fetch even if implementation ignores AbortSignal; late result cannot write', async () => {
  const finish = deferred()
  let signal
  const f = fixture({ timeoutMs: 10, fetch: async (url, options) => { signal = options.signal; return finish.promise } })
  await f.catalog.ready()
  assert.equal(signal.aborted, true)
  assert.equal(f.catalog.status().refresh, 'failed')
  await assert.rejects(f.catalog.refresh(), /Unable to refresh/)
  finish.resolve(response())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 0)
  assert.equal(f.updates, 0)
})

test('dispose aborts flight, prevents late writes/notifications and rejects subsequent calls', async () => {
  const started = deferred()
  const finish = deferred()
  let signal
  const f = fixture({ fetch: async (url, options) => { signal = options.signal; started.resolve(); return finish.promise } })
  const pending = f.catalog.ready()
  await started.promise
  f.catalog.dispose()
  f.catalog.dispose()
  assert.equal(signal.aborted, true)
  await assert.rejects(pending, { name: 'AbortError' })
  finish.resolve(response())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 0)
  assert.equal(f.updates, 0)
  await assert.rejects(f.catalog.ready(), { name: 'AbortError' })
})

test('account change invalidates old flight and prevents cross-account ETags, cache writes and notification', async () => {
  const started = deferred()
  const finish = deferred()
  let count = 0
  const f = fixture({ fetch: async (url, options) => {
    if (++count === 1) { started.resolve(); return finish.promise }
    assert.equal(options.headers['chatgpt-account-id'], 'account-b')
    assert.equal(options.headers['If-None-Match'], undefined)
    return response(payload(remote('b-model')))
  } })
  const old = f.catalog.ready()
  const rejected = assert.rejects(old, { name: 'AbortError' })
  await started.promise
  f.id = 'account-b'
  await f.catalog.ready()
  finish.resolve(response(payload(remote('old-model'))))
  await rejected
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.catalog.getModels().at(-1).id, 'b-model')
  assert.deepEqual(f.writes.map(([id]) => id), ['account-b'])
  assert.equal(f.updates, 1)
})

test('identity change discovered at completion drops stale response without another caller', async () => {
  const started = deferred()
  const finish = deferred()
  const f = fixture({ fetch: async () => { started.resolve(); return finish.promise } })
  const old = f.catalog.ready()
  await started.promise
  f.id = 'account-b'
  finish.resolve(response())
  await assert.rejects(old, { name: 'AbortError' })
  assert.deepEqual(f.catalog.status(), { source: 'builtin', refresh: 'idle', count: 2 })
  assert.equal(f.writes.length, 0)
  assert.equal(f.updates, 0)
})

test('credential identity mismatch never issues an authenticated request', async () => {
  const f = fixture({ getCredential: async () => ({ accountId: 'wrong-account', access: 'wrong-token' }) })
  await f.catalog.ready()
  assert.equal(f.calls, 0)
  assert.equal(f.catalog.status().refresh, 'failed')
})

test('bounds remote bytes and entry count and rejects malformed JSON and visible slugs', async () => {
  for (const fetch of [
    async () => new Response('not-json'),
    async () => response({ models: [remote('../invalid')] }),
    async () => response({ models: Array.from({ length: 1001 }, (_, index) => remote(`model-${index}`)) }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    async () => response(payload(), { headers: { 'content-length': '3000000' } }),
  ]) {
    const f = fixture({ fetch })
    await f.catalog.ready()
    assert.deepEqual(f.catalog.getModels(), base)
    assert.equal(f.catalog.status().refresh, 'failed')
    assert.equal(f.writes.length, 0)
  }
})

test('cache read/write errors and notification errors cannot break an online catalog', async () => {
  const f = fixture({ cache: { read: async () => { throw Error('disk') }, write: async () => { throw Error('disk') } }, onUpdated: () => { throw Error('host') } })
  await f.catalog.ready()
  assert.equal(f.catalog.status().source, 'online')
  assert.equal(f.catalog.status().count, 1)
})

test('failed automatic refresh retries after a bounded cooldown rather than waiting a full day', async () => {
  let requests = 0
  const f = fixture({ fetch: async () => { requests++; throw Error('offline') } })
  await f.catalog.ready()
  f.time = 60000
  await f.catalog.ready()
  assert.equal(requests, 1)
  f.time = 61000
  await f.catalog.ready()
  assert.equal(requests, 2)
})

test('builtin and published snapshots are stable, deeply immutable, and replaced only on publication', async () => {
  const f = fixture()
  const before = f.catalog.getModels()
  assert.equal(before, f.catalog.getModels())
  assert.ok(Object.isFrozen(before))
  assert.ok(Object.isFrozen(before[0].cost))
  await f.catalog.ready()
  const after = f.catalog.getModels()
  assert.notEqual(after, before)
  assert.equal(after, f.catalog.getModels())
  assert.ok(Object.isFrozen(after[0].thinkingLevelMap))
  await f.catalog.ready()
  assert.equal(after, f.catalog.getModels())
})

test('successful remote catalog does not resurrect hidden builtins', async () => {
  const f = fixture({ fetch: async () => response(payload({ ...remote('known'), visibility: 'hide' }, remote('new'))) })
  await f.catalog.ready()
  assert.deepEqual(f.catalog.getModels().map(value => value.id), ['new'])
})

test('an empty, all-hidden or unsupported-modality catalog is a failed refresh, never an empty picker', async () => {
  // The backend reports an under-privileged client version as {"models":[]} with
  // HTTP 200, so publishing it would hide every built-in model.
  for (const body of [{ models: [] }, payload({ ...remote('known'), visibility: 'hide' }), payload({ ...remote('audio'), input_modalities: ['audio'] })]) {
    const f = fixture({ fetch: async () => response(body) })
    await f.catalog.ready()
    assert.deepEqual(f.catalog.getModels(), base)
    assert.equal(f.catalog.status().refresh, 'failed')
    assert.equal(f.catalog.status().source, 'builtin')
    assert.equal(f.writes.length, 0)
    await assert.rejects(f.catalog.refresh(), /Unable to refresh/)
  }
  for (const body of [{ models: [null] }, { models: [{}] }, { models: [remote('../bad')] }]) {
    const f = fixture({ fetch: async () => response(body) })
    await f.catalog.ready()
    assert.deepEqual(f.catalog.getModels(), base)
    assert.equal(f.catalog.status().refresh, 'failed')
  }
})

test('initial identity reads are bounded by timeout and disposed reads reject immediately', async () => {
  const hung = deferred()
  const f = fixture({ timeoutMs: 10, readCredential: () => hung.promise })
  await f.catalog.ready()
  assert.equal(f.catalog.status().refresh, 'failed')
  await assert.rejects(f.catalog.refresh(), /Unable to refresh/)
  const g = fixture({ readCredential: () => hung.promise })
  const pending = g.catalog.ready()
  g.catalog.dispose()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(f.calls, 0)
  assert.equal(g.calls, 0)
})

test('timeouts also bound credential acquisition and suppress late authenticated fetches', async () => {
  const hung = deferred()
  const f = fixture({ timeoutMs: 10, getCredential: () => hung.promise })
  await f.catalog.ready()
  assert.equal(f.catalog.status().refresh, 'failed')
  hung.resolve({ accountId: 'account-a', access: 'private-token' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls, 0)
  assert.equal(f.updates, 0)
})
