import test from 'node:test'
import assert from 'node:assert/strict'
import { Accounts, routeOf } from '../src/accounts.js'
import { Subscriptions } from '../src/subscriptions.js'

function fixture() {
  const records = new Map()
  const credentials = {
    listRecords: async () => [...records.keys()].map(key => ({ key, kind: 'grant' })),
    readRecord: async key => structuredClone(records.get(key)),
    modifyRecord: async (key, update) => {
      const next = await update(structuredClone(records.get(key)))
      if (next !== undefined) records.set(key, structuredClone(next))
      return structuredClone(records.get(key))
    },
    deleteRecord: async key => { records.delete(key) },
  }
  const accounts = new Accounts(credentials, id => `own/${id}`, key => key.startsWith('own/') ? key.slice(4) : undefined)
  const providers = new Map([['openai-codex', 'original plugin']]), updates = []
  const llm = { registerAdapter(routes, adapter) {
    const route = routes[0]
    providers.set(route, adapter)
    const dispose = () => providers.delete(route)
    dispose.replace = next => { updates.push(next); assert.equal(next[0], route) }
    return dispose
  } }
  const subscriptions = new Subscriptions({ accounts, llm, adapterFactory: options => options,
    authFactory: () => ({ getAuth() { throw new Error('Metadata operations must not resolve tokens or query quotas') } }) })
  const add = suffix => accounts.add(suffix, { type: 'oauth', accountId: suffix, access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000 })
  return { accounts, records, providers, subscriptions, add, updates }
}
test('provider labels update single → multiple → single while adapter identities and route IDs remain fixed', async () => {
  const { providers, subscriptions, add, updates } = fixture()
  const a = await add('personal')
  await subscriptions.sync()
  const firstAdapter = providers.get(routeOf(a))
  assert.equal(firstAdapter.label(), 'Codex')
  const b = await add('work')
  await subscriptions.sync()
  assert.equal(firstAdapter.label(), 'Codex-personal')
  assert.equal(providers.get(routeOf(a)), firstAdapter)
  assert.equal(providers.get(routeOf(b)).label(), 'Codex-work')
  await subscriptions.manage({ action: 'remove', id: b })
  assert.equal(firstAdapter.label(), 'Codex')
  assert.equal(providers.get(routeOf(a)), firstAdapter)
  assert.deepEqual(updates, [[routeOf(a)], [routeOf(a)]])
  subscriptions.dispose()
  assert.deepEqual([...providers], [['openai-codex', 'original plugin']])
})
test('sign out all removes only this plugin’s records/routes and returns the same empty list operation', async () => {
  const { records, providers, subscriptions, add } = fixture()
  records.set('other/account-00000000000000000000000000000000', { kind: 'grant', payload: 'unrelated' })
  await add('personal'); await add('work'); await subscriptions.sync()
  assert.equal(providers.size, 3)
  const value = await subscriptions.manage({ action: 'remove-all' })
  assert.deepEqual(value, { accounts: [] })
  assert.deepEqual(await subscriptions.manage({ action: 'list' }), value)
  assert.equal(records.size, 1)
  assert.deepEqual([...providers], [['openai-codex', 'original plugin']])
  assert.equal(subscriptions.routes.size, 0)
  subscriptions.dispose()
})
