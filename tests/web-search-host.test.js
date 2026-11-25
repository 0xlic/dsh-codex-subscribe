import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

const ownedRoute = `codex-sub-${'a'.repeat(32)}`
const rpcRequest = payload => new Request('http://dsh.internal/api/codex-subscribe/manage', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', method: 'codex-subscribe/manage', rpcId: 'dsh-web-test', payload }),
})

test('default-on Host preference can be saved off without changing native web settings', async () => {
  const original = route => `native:${route}`
  const liveConfig = { get: () => persisted.codexLiveSearch ?? true }
  const web = {
    selectSearchProvider: original, searchProviders: new Map(), searchProviderEnv: undefined,
    config: { searchProvider: { get: () => undefined }, fetchProvider: { get: () => 'http' } },
  }
  let persisted = { chatFailover: true, images: { enabled: false } }, rpcRoute
  const editor = { async edit(entry, update) { assert.equal(entry, 'codex-subscribe'); persisted = update(persisted) } }
  async function mount(config) {
    const effects = []
    const effect = fn => { effects.push(fn()); return () => {} }
    await apply({ credentials: { listRecords: async () => [] }, llm: {}, storageDomain: {},
      connection: { fetch: { register(value) { rpcRoute = value; return () => {} } } },
      tools: { register: () => () => {} }, effect,
      inject(deps, fn) { assert.deepEqual(deps, ['web']); fn({ web, effect }) },
      get: name => ({ web, configEditor: editor })[name], fiber: { entry: 'codex-subscribe' },
    }, { ...config, codexLiveSearch: liveConfig })
    return async () => { for (const dispose of effects.reverse()) await dispose?.() }
  }
  const rpc = async payload => (await (await rpcRoute.fetch(rpcRequest(payload))).json()).result
  const dispose = await mount(persisted)
  try {
    assert.equal((await rpc({ action: 'list' })).value.codexLiveSearch, true)
    assert.equal(web.selectSearchProvider(ownedRoute).id, 'codex-subscribe-live')
    assert.equal(web.selectSearchProvider('deepseek-account'), 'native:deepseek-account')
    assert.equal((await rpc({ action: 'codex-live-search-save', enabled: 'false' })).ok, false)
    assert.equal(persisted.codexLiveSearch, undefined)
    assert.deepEqual(await rpc({ action: 'codex-live-search-save', enabled: false }),
      { ok: true, value: { codexLiveSearch: false, codexLiveSearchAvailable: true } })
    assert.deepEqual(persisted, { chatFailover: true, images: { enabled: false }, codexLiveSearch: false })
    assert.equal(web.selectSearchProvider(ownedRoute), `native:${ownedRoute}`, 'the same running Host applies the switch')
    assert.equal((await rpc({ action: 'list' })).value.codexLiveSearch, false)
  } finally { await dispose() }
  assert.equal(web.selectSearchProvider, original)
  const disposeDisabled = await mount(persisted)
  try {
    assert.equal(web.selectSearchProvider(ownedRoute), `native:${ownedRoute}`)
    assert.equal((await rpc({ action: 'list' })).value.codexLiveSearch, false)
    assert.equal(web.config.fetchProvider.get(), 'http')
  } finally { await disposeDisabled() }
})
