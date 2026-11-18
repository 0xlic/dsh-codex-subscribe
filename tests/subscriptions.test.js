import test from 'node:test'
import assert from 'node:assert/strict'
import { Accounts, routeOf } from '../src/accounts.js'
import { Subscriptions } from '../src/subscriptions.js'

function fixture(options = {}) {
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
    authFactory: () => ({ getAuth() { throw new Error('Metadata operations must not resolve tokens or query quotas') } }), ...options })
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

test('model refresh is account scoped and suppresses disposed notifications', async () => {
  const catalogs = [], pruned = []
  const f = fixture({
    catalogFactory: options => {
      let disposed = false, refreshed = false
      const catalog = { options, disposed: () => disposed,
        status: () => ({ source: refreshed ? 'online' : 'builtin', refresh: refreshed ? 'ok' : 'idle', count: 2 }),
        async refresh() { refreshed = true; options.onUpdated() }, dispose() { disposed = true },
      }
      catalogs.push(catalog)
      return catalog
    },
    pruneCatalogCache: async accounts => { pruned.push(accounts.map(a => a.id)) },
  })
  const a = await f.add('personal'), b = await f.add('work')
  await f.subscriptions.sync()
  const value = await f.subscriptions.manage({ action: 'refresh-models', id: a })
  assert.equal(value.accounts.find(account => account.id === a).modelCatalog.source, 'online')
  assert.equal(value.accounts.find(account => account.id === b).modelCatalog.source, 'builtin')
  assert.deepEqual(f.updates, [[routeOf(a)]])
  const own = catalogs.find(catalog => catalog.status().source === 'online')
  await f.subscriptions.manage({ action: 'remove', id: a })
  assert.equal(own.disposed(), true)
  assert.deepEqual(pruned, [[b]])
  const count = f.updates.length
  own.options.onUpdated()
  assert.equal(f.updates.length, count)
  await assert.rejects(f.subscriptions.manage({ action: 'refresh-models', id: a }), /unavailable/)
  f.subscriptions.dispose()
  assert.ok(catalogs.every(catalog => catalog.disposed()))
})

test('failed refresh never exposes server or credential errors', async () => {
  const f = fixture({ catalogFactory: () => ({ status: () => ({ source: 'builtin', refresh: 'failed', count: 1 }),
    async refresh() { throw new Error('secret-token-and-server-body') }, dispose() {} }) })
  await f.add('personal')
  await assert.rejects(f.subscriptions.manage({ action: 'refresh-models' }), error => {
    assert.match(error.message, /refresh failed/)
    assert.ok(!error.message.includes('secret'))
    return true
  })
  f.subscriptions.dispose()
})
