import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { apply } from '../src/index.js'
import { Login } from '../src/login.js'
import { createAccountAdapter } from '../src/adapter.js'

test('host uses a composable exact authenticated route; UI and tool share management operations', async () => {
  let route, tool, usage
  const effects = []
  const ctx = {
    credentials: { listRecords: async () => [], readRecord: async () => undefined, deleteRecord: async () => {} },
    llm: { registerAdapter: () => { throw new Error('No saved accounts expected') } },
    connection: { fetch: { register(value) { route = value; return async () => { route = undefined } } }, rpc: { intercept() { throw new Error('Core owns this interceptor') } } },
    tools: { register(value) { tool = value; return () => { tool = undefined } } },
    effect(fn) { effects.push(fn()) },
    provide(name, value) { assert.equal(name, 'codexUsage'); usage = value; return () => { usage = undefined } },
  }
  await apply(ctx)
  assert.deepEqual(Object.keys(usage).sort(), ['effectiveAccount', 'list', 'listResetCards', 'read', 'useResetCard', 'version'])
  assert.deepEqual(await usage.list('codex-sub-00000000000000000000000000000000'), [])
  assert.equal(route.path, '/api/codex-subscribe/manage')
  assert.deepEqual(route.methods, ['POST'])
  const request = input => new Request('http://dsh.internal/api/codex-subscribe/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const rpc = payload => route.fetch(request({ type: 'client-request', rpcId: randomUUID(), method: 'codex-subscribe/manage', payload }))
  const result = await (await rpc({ action: 'list' })).json()
  assert.deepEqual(result.result, { ok: true, value: { accounts: [], chatFailover: false, codexLiveSearch: true, codexLiveSearchAvailable: false } })
  assert.deepEqual(await tool.execute({ action: 'list' }), { accounts: [] })
  await assert.rejects(tool.execute({ action: 'codex-live-search-save', enabled: false }), /Unknown operation/)
  await assert.rejects(tool.execute({ action: 'chat-failover-save', enabled: true }), /Unknown operation/)
  assert.equal((await route.fetch(request({ invalid: true }))).status, 400)
  const wrong = await route.fetch(request({ type: 'client-request', rpcId: randomUUID(), method: 'wrong', payload: {} }))
  assert.equal(wrong.status, 400)
  assert.equal((await (await rpc({ action: 'unknown' })).json()).result.ok, false)
  await assert.rejects(tool.execute({ action: 'login', method: 'browser', label: 'Forbidden' }), /Unknown operation/)
  for (const dispose of effects.reverse()) await dispose()
  assert.equal(route, undefined); assert.equal(tool, undefined)
})
test('credential resolution errors never expose raw OAuth responses', async () => {
  let options
  createAccountAdapter({ route: 'codex-sub-test', label: 'Test', getCredential: async () => { throw new Error('secret-refresh-token') }, adapterFactory: value => { options = value; return {} } })
  await assert.rejects(options.resolveApiKey(), error => {
    assert.equal(error.code, 'AUTH_FAILED')
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})
test('cancellation after commit starts reports final durable success rather than cancelled', async () => {
  let finishSave
  const save = new Promise(resolve => { finishSave = resolve })
  const credential = { type: 'oauth', accountId: 'a', access: 'secret-access', refresh: 'secret-refresh', expires: 9999999999999 }
  const login = new Login({
    createModels: ({ credentials }) => ({ setProvider() {}, async login() { await credentials.modify('openai-codex', async () => credential) } }),
    providerFactory: () => ({}),
    accounts: { async add() { await save; return 'account-00000000000000000000000000000000' } }, changed: async () => {},
  })
  const view = login.start({ method: 'browser', label: 'A' })
  // Advance only the known microtask chain; no timers or polling are involved.
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(login.read(view.id).phase, 'finalizing')
  assert.equal(login.cancel(view.id).phase, 'finalizing')
  finishSave()
  await login.session.run
  assert.equal(login.read(view.id).phase, 'authenticated')
  assert.equal(JSON.stringify(login.read(view.id)).includes('secret'), false)
})
