import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createCodexSearchPreference, installCodexSearchPreference } from '../src/web-search-routing.js'
import { UserError } from '../src/accounts.js'

const account = character => ({ id: `account-${character.repeat(32)}`, route: `codex-sub-${character.repeat(32)}`, remote: `remote-${character}` })
const a = account('a'), b = account('b')
const result = { sources: [], truncated: false }
const setup = ({ issue, live, dshReady = true, isActive } = {}) => {
  const storage = new AsyncLocalStorage(), calls = []
  const routes = new Map([a, b].map(entry => [entry.id, entry]))
  const searchProviders = new Map([
    ['deepseek-official', { available: () => true, ready: async () => dshReady, search: async (request, signal) => { calls.push({ dsh: request, signal }); return result } }],
    ['deepseek-search-api', { available: () => true, search: async () => assert.fail('must not call metered fallback') }],
  ])
  const provider = createCodexSearchPreference({ web: { searchProviders },
    subscriptions: { routes, usageCredential: issue ?? (async id => ({ access: `token-${id}`, accountId: routes.get(id).remote })) },
    accounts: { read: async id => ({ credential: { accountId: routes.get(id).remote } }) },
    getInitiator: () => storage.getStore(), isActive,
    searchLive: live ?? (async value => { calls.push(value); return result }),
  })
  const request = (entry, model, signal, actual = entry) => storage.run({ session: {
    id: `session-${actual.remote}`, requestContext: () => ({ provider: actual.route, model }),
  } }, () => provider.search({ query: `query-${entry.remote}`, llmProvider: entry.route, maxResults: 3 }, signal))
  return { provider, calls, routes, request }
}

test('Codex Live uses the exact initiating model, session and OAuth account on concurrent requests', async () => {
  const f = setup(), signal = new AbortController().signal
  await Promise.all([f.request(a, 'model-A', signal), f.request(b, 'model-B', signal)])
  for (const [entry, model] of [[a, 'model-A'], [b, 'model-B']]) {
    const request = f.calls.find(call => call.sessionId === `session-${entry.remote}`)
    assert.deepEqual(request, { model, query: `query-${entry.remote}`, sessionId: `session-${entry.remote}`,
      credential: { access: `token-${entry.id}`, accountId: entry.remote }, signal })
  }
})

test('unavailable Codex routes and cross-session context only fall back to ready server-side DSH', async () => {
  let issued = 0
  const f = setup({ issue: async () => { ++issued; throw new UserError('Synthetic missing') } })
  const signal = new AbortController().signal
  await f.request(a, 'model-A', signal, b)
  await f.request(a, 'model-A', signal)
  f.routes.delete(a.id)
  await f.request(a, 'model-A', signal)
  assert.equal(issued, 1)
  assert.deepEqual(f.calls, Array.from({ length: 3 }, () => ({ dsh: { query: `query-${a.remote}`, llmProvider: a.route, maxResults: 3 }, signal })))
  const unready = setup({ dshReady: false })
  unready.routes.delete(a.id)
  assert.equal(await unready.provider.ready(a.route), false)
  await assert.rejects(unready.request(a, 'model-A', signal), { code: 'WEB_PROVIDER_UNAVAILABLE' })
})

test('Live failure or cancellation cannot dispatch a second search', async () => {
  const f = setup({ live: async () => { throw new Error('Live request failed') } })
  await assert.rejects(f.request(a, 'model-A'), /Live request failed/)
  await assert.rejects(f.request(a, 'model-A', AbortSignal.abort()), { code: 'WEB_ABORTED' })
  assert.deepEqual(f.calls, [])
})

test('disabling during credential resolution does not issue a Live or fallback request', async () => {
  let active = true
  let notify
  const entered = new Promise(resolve => { notify = resolve })
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const f = setup({ isActive: () => active, issue: () => { notify(); return pending } })
  const response = f.request(a, 'model-A')
  await entered
  active = false
  finish({ access: 'token', accountId: a.remote })
  await assert.rejects(response, { code: 'WEB_PROVIDER_UNAVAILABLE' })
  assert.deepEqual(f.calls, [])
})

test('adapter leaves legacy and incompatible DSH runtimes entirely untouched', () => {
  const old = { config: { searchProvider: { get: () => undefined } }, searchProviderEnv: undefined, searchProviders: new Map(), selectSearchProvider() {} }
  const original = old.selectSearchProvider
  assert.equal(installCodexSearchPreference(old, {}), undefined)
  assert.equal(old.selectSearchProvider, original)
})
