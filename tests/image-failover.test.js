import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createImageTool } from '../src/images.js'
import { openImageAccountMemory, IMAGE_ACCOUNT_DOMAIN } from '../src/image-accounts.js'
import { IMAGE_DEFAULTS } from '../src/image-settings.js'

// No test may escape to the real network, even if injection is accidentally lost.
const realFetch = globalThis.fetch
let realNetworkAttempts = 0
before(() => {
  globalThis.fetch = async () => {
    realNetworkAttempts++
    throw new Error('Real network is forbidden in image failover tests')
  }
})
after(() => {
  globalThis.fetch = realFetch
  assert.equal(realNetworkAttempts, 0, 'all requests must use the injected offline fetch')
})

const A = `account-${'a'.repeat(32)}`
const B = `account-${'b'.repeat(32)}`
const C = `account-${'c'.repeat(32)}`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FoAAAAASUVORK5CYII=', 'base64')
const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }
const success = () => Response.json({ data: [{ b64_json: png.toString('base64') }] })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function memory(initial = '') {
  let current = initial
  const writes = []
  return { preferred: () => current, async remember(id) { current = id; writes.push(id) }, writes }
}
function fixture({ ids = [A, B], settings = {}, accountMemory, credential, fetchImage, attemptTimeoutMs } = {}) {
  const auth = [], requests = [], writes = [], reads = []
  const service = {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1024, maxMessageImageBytes: 2048 },
    async readImage(input) { reads.push(input); return { ref: input, data: png } },
    async validateImage(input) { assert.deepEqual(Buffer.from(input.data), png) },
    async saveFile(input) { writes.push('file'); assert.deepEqual(Buffer.from(input.data), png); return { attachmentId: `sha256:${'b'.repeat(64)}`, bytes: png.length, name: input.name } },
    async saveImage() { writes.push('image'); return ref },
    fileHostPath: () => '/offline/generated.png',
  }
  const controller = new AbortController()
  const tool = createImageTool({
    getSettings: () => ({ ...IMAGE_DEFAULTS, enabled: true, ...settings }),
    accounts: { list: async () => ids.map(id => ({ id, provider: `codex-${id}` })) },
    getCredential: async (id, signal) => {
      auth.push(id)
      return credential ? credential(id, signal) : { access: `secret-access-${id}`, accountId: `remote-${id}` }
    },
    // Automatic image routing must not depend on the conversation LLM provider.
    getSession: () => ({ requestContext: () => ({ provider: 'anthropic', model: 'claude-sonnet' }), deriveMessages: () => [{ role: 'user', content: [{ type: 'image', attachment: ref }] }] }),
    attachments: () => service,
    fetchImage: async (url, options) => {
      requests.push({ url, options })
      assert.equal(new URL(url).origin, 'https://chatgpt.com')
      return fetchImage ? fetchImage(url, options) : success()
    },
    accountMemory,
    ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
  })
  const exec = { agent: { id: 'offline-session' }, callId: 'offline-call', signal: controller.signal }
  return { tool, exec, controller, auth, requests, writes, reads, service, run: (args = { prompt: 'draw a cat' }) => tool.execute(args, exec) }
}

test('non-ChatGPT conversations use multiple subscriptions; auth failure A falls back to B', async () => {
  const f = fixture({ credential: async id => {
    if (id === A) throw new Error('secret refresh token')
    return { access: 'secret-B', accountId: 'remote-B' }
  } })
  assert.equal((await f.run()).accountId, B)
  assert.deepEqual(f.auth, [A, B])
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].options.headers['chatgpt-account-id'], 'remote-B')
  assert.deepEqual(f.writes, ['file', 'image'])
  assert.equal(f.tool.timeoutMs, 30 * 60 * 1000)
})

test('A HTTP429 then B succeeds; subsequent calls start with remembered B', async () => {
  const accountMemory = memory()
  const f = fixture({ accountMemory, fetchImage: async (_url, options) => options.headers['chatgpt-account-id'] === `remote-${A}` ? new Response('secret quota body', { status: 429 }) : success() })
  assert.equal((await f.run()).accountId, B)
  assert.equal((await f.run()).accountId, B)
  assert.deepEqual(f.auth, [A, B, B])
  assert.deepEqual(accountMemory.writes, [B, B])
  assert.equal(accountMemory.preferred(), B)
})

test('without persistent memory the same tool still remembers the last success', async () => {
  const f = fixture({ fetchImage: async (_url, options) => options.headers['chatgpt-account-id'] === `remote-${A}` ? new Response('', { status: 429 }) : success() })
  await f.run()
  await f.run()
  assert.deepEqual(f.auth, [A, B, B])
})

test('failed cached B tries each remaining account once, even with duplicate account records', async () => {
  const accountMemory = memory(B)
  const f = fixture({ ids: [A, B, C, A, B], accountMemory, fetchImage: async (_url, options) => options.headers['chatgpt-account-id'] === `remote-${C}` ? success() : new Response('', { status: 503 }) })
  assert.equal((await f.run()).accountId, C)
  assert.deepEqual(f.auth, [B, A, C])
  assert.equal(new Set(f.auth).size, f.auth.length)
  assert.deepEqual(accountMemory.writes, [C])
})

test('all failures report the account count and only sanitized reasons', async () => {
  const accountMemory = memory(B)
  const f = fixture({ ids: [A, B, C], accountMemory,
    credential: async id => {
      if (id === B) throw new Error('SECRET-auth-refresh-token')
      return { access: 'SECRET-access-token', accountId: id }
    },
    fetchImage: async (_url, options) => {
      if (options.headers['chatgpt-account-id'] === A) return new Response('SECRET-backend-body', { status: 429 })
      throw new Error('SECRET-transport-detail')
    },
  })
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /All 3 image accounts failed/)
    for (const id of [A, B, C]) assert.ok(error.message.includes(id))
    assert.match(error.message, /authentication failed/)
    assert.match(error.message, /HTTP 429/)
    assert.match(error.message, /network request failed/)
    assert.doesNotMatch(error.message, /SECRET|Bearer/)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.deepEqual(f.auth, [B, A, C])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(accountMemory.writes, [])
})

test('invalid image responses fall back to a usable account without publishing partial output', async () => {
  for (const response of [() => new Response('not JSON'), () => Response.json({ data: [] }), () => Response.json({ data: [{ b64_json: 'AAAA' }] })]) {
    let attempts = 0
    const f = fixture({ fetchImage: async () => ++attempts === 1 ? response() : success() })
    assert.equal((await f.run()).accountId, B)
    assert.deepEqual(f.auth, [A, B])
    assert.deepEqual(f.writes, ['file', 'image'])
  }
})

test('disable during a failed request stops immediately instead of switching accounts', async () => {
  const settings = { enabled: true }
  const f = fixture({ settings, fetchImage: async () => { settings.enabled = false; return new Response('', { status: 429 }) } })
  await assert.rejects(f.run(), /disabled/)
  assert.deepEqual(f.auth, [A])
  assert.deepEqual(f.writes, [])
})

test('fixed account success does not overwrite automatic-mode routing memory', async () => {
  const accountMemory = memory(A)
  const f = fixture({ settings: { accountId: B }, accountMemory })
  assert.equal((await f.run()).accountId, B)
  assert.deepEqual(f.auth, [B])
  assert.deepEqual(accountMemory.writes, [])
  assert.equal(accountMemory.preferred(), A)
})

test('unknown network outcomes are disclosed even when a later account succeeds', async () => {
  let attempts = 0
  const f = fixture({ fetchImage: async () => {
    if (++attempts === 1) throw new Error('SECRET network details')
    return success()
  } })
  const result = await f.run()
  assert.equal(result.accountId, B)
  assert.match(result.warning, /unknown outcome.*extra quota/)
  assert.doesNotMatch(result.warning, /SECRET/)
})

test('fixed B failure never attempts A or changes remembered preference', async () => {
  const accountMemory = memory(A)
  const f = fixture({ settings: { accountId: B }, accountMemory, fetchImage: async () => new Response('private', { status: 403 }) })
  await assert.rejects(f.run(), /Fixed image account failed.*HTTP 403/)
  assert.deepEqual(f.auth, [B])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(accountMemory.writes, [])
})

test('removed cached account is ignored; zero accounts do not authenticate or fetch', async () => {
  const f = fixture({ ids: [A, C], accountMemory: memory(B) })
  assert.equal((await f.run()).accountId, A)
  assert.deepEqual(f.auth, [A])
  const empty = fixture({ ids: [], accountMemory: memory(B) })
  await assert.rejects(empty.run(), /Sign in/)
  assert.deepEqual(empty.auth, [])
  assert.deepEqual(empty.requests, [])
  assert.deepEqual(empty.writes, [])
})

test('invalid edit references never authenticate, dispatch or fall back', async () => {
  for (const referenceImages of [[], ['local.png'], [null], [ref.attachmentId, ref.attachmentId], [`sha256:${'f'.repeat(64)}`], Array(6).fill(ref.attachmentId)]) {
    const f = fixture({ accountMemory: memory(B) })
    await assert.rejects(f.run({ prompt: 'edit', referenceImages }))
    assert.deepEqual(f.auth, [])
    assert.deepEqual(f.requests, [])
    assert.deepEqual(f.writes, [])
  }
})

test('edits reuse identical image bytes and request body across account attempts', async () => {
  let attempts = 0
  const f = fixture({ fetchImage: async () => ++attempts === 1 ? new Response('', { status: 429 }) : success() })
  assert.equal((await f.run({ prompt: '  turn the sky blue  ', referenceImages: [ref.attachmentId] })).accountId, B)
  assert.deepEqual(f.auth, [A, B])
  assert.equal(f.reads.length, 1, 'resolve source images once before retrying')
  const [first, second] = f.requests
  assert.match(first.url, /\/edits$/)
  assert.equal(first.url, second.url)
  assert.equal(first.options.body, second.options.body)
  assert.equal(first.options.headers['x-codex-image-turn-id'], second.options.headers['x-codex-image-turn-id'])
  assert.deepEqual(JSON.parse(first.options.body), { prompt: 'turn the sky blue', model: 'gpt-image-2', quality: 'auto', size: 'auto', background: 'auto', images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }] })
  assert.notEqual(first.options.headers.authorization, second.options.headers.authorization)
  assert.deepEqual(f.writes, ['file', 'image'])
})

test('cancellation while the first request rejects must not start fallback', async () => {
  const entered = deferred(), response = deferred()
  const f = fixture({ fetchImage: () => { entered.resolve(); return response.promise } })
  const running = f.run()
  await entered.promise
  f.controller.abort(new Error('user cancelled request'))
  response.reject(new Error('SECRET transport rejection during cancellation'))
  await assert.rejects(running, /user cancelled request/)
  assert.deepEqual(f.auth, [A])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.writes, [])
})

test('local saveFile failure is not retried or remembered after remote success', async () => {
  const accountMemory = memory()
  const f = fixture({ accountMemory })
  f.service.saveFile = async () => { throw new Error('local disk unavailable') }
  await assert.rejects(f.run(), /local disk unavailable/)
  assert.deepEqual(f.auth, [A])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(accountMemory.writes, [])
})

test('memory persistence failure returns a sanitized warning, not a fallback generation', async () => {
  const f = fixture({ accountMemory: { preferred: () => '', remember: async () => { throw new Error('SECRET storage failure') } } })
  const result = await f.run()
  assert.equal(result.accountId, A)
  assert.match(result.warning, /preferred account could not be saved/)
  assert.doesNotMatch(JSON.stringify(result), /SECRET|secret-access/)
  assert.deepEqual(f.auth, [A])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.writes, ['file', 'image'])
})

test('per-account timeout aborts the first offline fetch and permits B', async () => {
  let aborted = false
  const f = fixture({ attemptTimeoutMs: 5, fetchImage: async (_url, options) => {
    if (options.headers['chatgpt-account-id'] !== `remote-${A}`) return success()
    return new Promise((resolve, reject) => {
      const onAbort = () => { aborted = true; reject(options.signal.reason) }
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    })
  } })
  // AbortSignal.timeout uses an unref'ed timer. This bounded watchdog keeps the
  // event loop alive and is always cleared; no sleeping or polling is involved.
  let watchdog
  try {
    const result = await Promise.race([f.run(), new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error('attempt timeout did not fire')), 1000) })])
    assert.equal(result.accountId, B)
    assert.equal(aborted, true)
    assert.deepEqual(f.auth, [A, B])
  } finally { clearTimeout(watchdog) }
})

function storageFixture(initial = { lastSuccessfulAccountId: '' }, setHook) {
  let persisted = structuredClone(initial)
  const definitions = [], writes = [], events = []
  const storageDomain = {
    async open(definition) {
      definitions.push(definition)
      // Match DSH storage UNIT_NAME_RE; the old mock missed invalid hyphenated names.
      assert.match(definition.name, /^[a-z][a-z0-9_]*$/)
      definition.global.schema.parse(persisted)
      return {
        global: {
          get: () => structuredClone(persisted),
          async set(value) {
            definition.global.schema.parse(value)
            writes.push(structuredClone(value))
            events.push(`start:${value.lastSuccessfulAccountId}`)
            await setHook?.(value, writes.length)
            persisted = structuredClone(value)
            events.push(`end:${value.lastSuccessfulAccountId}`)
          },
        },
        async close() { events.push('close') },
      }
    },
  }
  return { storageDomain, definitions, writes, events, persisted: () => structuredClone(persisted) }
}

test('image account memory opens its schema domain, persists only an ID and survives reopen', async () => {
  const store = storageFixture()
  const first = await openImageAccountMemory(store.storageDomain)
  assert.equal(store.definitions[0], IMAGE_ACCOUNT_DOMAIN)
  assert.deepEqual(IMAGE_ACCOUNT_DOMAIN.tables, {})
  assert.deepEqual(IMAGE_ACCOUNT_DOMAIN.global.initial, { lastSuccessfulAccountId: '' })
  assert.equal(IMAGE_ACCOUNT_DOMAIN.version, 1)
  assert.equal(IMAGE_ACCOUNT_DOMAIN.name, 'codex_subscribe_image_accounts')
  assert.equal(first.preferred(), '')
  await first.remember(B)
  assert.equal(first.preferred(), B)
  assert.deepEqual(store.writes, [{ lastSuccessfulAccountId: B }])
  assert.deepEqual(Object.keys(store.persisted()), ['lastSuccessfulAccountId'])
  assert.doesNotMatch(JSON.stringify(store.persisted()), /access|refresh|token|secret|credential/i)
  await first.close()
  const reopened = await openImageAccountMemory(store.storageDomain)
  assert.equal(reopened.preferred(), B)
  const f = fixture({ accountMemory: reopened })
  assert.equal((await f.run()).accountId, B)
  assert.deepEqual(f.auth, [B], 'restarted image tool prefers persisted account')
  await reopened.close()
})

test('image account memory validates IDs, serializes writes and close drains exactly once', async () => {
  const firstStarted = deferred(), releaseFirst = deferred(), secondStarted = deferred()
  const store = storageFixture(undefined, async (_value, index) => {
    if (index === 1) { firstStarted.resolve(); await releaseFirst.promise }
    else secondStarted.resolve()
  })
  const state = await openImageAccountMemory(store.storageDomain)
  for (const invalid of ['secret-access-token', '../account', '', `account-${'z'.repeat(32)}`]) assert.throws(() => state.remember(invalid))
  assert.equal(store.writes.length, 0)
  const one = state.remember(A)
  await firstStarted.promise
  const two = state.remember(B)
  assert.equal(state.preferred(), B, 'in-memory preference updates before persistence')
  assert.deepEqual(store.writes, [{ lastSuccessfulAccountId: A }], 'second write must wait behind first')
  const closing = state.close()
  assert.equal(store.events.includes('close'), false, 'close must wait for queued writes')
  await assert.rejects(state.remember(C), /closed/)
  releaseFirst.resolve()
  await secondStarted.promise
  await Promise.all([one, two, closing])
  await state.close()
  assert.deepEqual(store.events, [`start:${A}`, `end:${A}`, `start:${B}`, `end:${B}`, 'close'])
  assert.deepEqual(store.persisted(), { lastSuccessfulAccountId: B })
})

test('failed memory persistence keeps process preference and does not poison subsequent writes or close', async () => {
  const store = storageFixture(undefined, async (_value, index) => { if (index === 1) throw new Error('offline storage rejected') })
  const state = await openImageAccountMemory(store.storageDomain)
  await assert.rejects(state.remember(A), /offline storage rejected/)
  assert.equal(state.preferred(), A)
  assert.deepEqual(store.persisted(), { lastSuccessfulAccountId: '' })
  await state.remember(B)
  assert.equal(state.preferred(), B)
  assert.deepEqual(store.persisted(), { lastSuccessfulAccountId: B })
  await state.close()
  assert.equal(store.events.at(-1), 'close')
})
