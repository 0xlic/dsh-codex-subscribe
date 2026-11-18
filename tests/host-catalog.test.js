import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { apply } from '../src/index.js'
import { Accounts, SCOPE } from '../src/accounts.js'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'

// Exercise the shipped Host wiring with real pi-ai OAuth resolution, but only
// synthetic grants and a local fetch stub. No real account or model request.
test('Host RPC and tool share dynamic refresh, account cache and native adapter metadata', async () => {
  const records = new Map(), adapters = new Map(), effects = [], domains = new Map()
  let route, tool, updates = 0, requests = 0
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
  const accounts = new Accounts(credentials, id => credentialKey(SCOPE, id), key => credentialKeyScope(key) === SCOPE ? credentialKeyId(key) : undefined)
  const id = await accounts.add('test', { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', accountId: 'synthetic-account', expires: Date.now() + 3600000 })
  const ctx = {
    credentials,
    storageDomain: { async open(definition) {
      let value = domains.get(definition.name) ?? structuredClone(definition.global.initial)
      return { global: { get: () => value, async set(next) { value = definition.global.schema.parse(next); domains.set(definition.name, value) } }, async close() {} }
    } },
    llm: { registerAdapter(routes, adapter) {
      adapters.set(routes[0], adapter)
      const dispose = () => adapters.delete(routes[0]); dispose.replace = () => { updates++ }; return dispose
    } },
    connection: { fetch: { register(value) { route = value; return () => {} } } },
    tools: { register(value) { tool = value; return () => {} } },
    effect(fn) { effects.push(fn()) },
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requests++
    assert.equal(new URL(url).pathname, '/backend-api/codex/models')
    assert.equal(options.headers.Authorization, 'Bearer synthetic-access')
    assert.equal(options.headers['chatgpt-account-id'], 'synthetic-account')
    return Response.json({ models: [{ slug: 'gpt-future-new', display_name: 'Future', visibility: 'list',
      input_modalities: ['text'], context_window: 600000, supported_reasoning_levels: [{ effort: 'medium' }] }] }, { headers: { etag: 'test-etag' } })
  }
  try {
    await apply(ctx)
    assert.equal(requests, 0, 'listing account metadata must not authenticate or fetch')
    const before = await tool.execute({ action: 'list' })
    assert.equal(before.accounts[0].modelCatalog.source, 'builtin')
    const refresh = await tool.execute({ action: 'refresh-models', id })
    assert.equal(refresh.accounts[0].modelCatalog.source, 'online')
    assert.equal(refresh.accounts[0].modelCatalog.count, 1)
    assert.equal(requests, 1)
    const adapter = adapters.get(refresh.accounts[0].provider)
    assert.deepEqual((await adapter.listModels(refresh.accounts[0].provider)).map(m => m.id), ['gpt-future-new'])
    assert.equal(requests, 1, 'ready respects refresh TTL')
    const rpc = await route.fetch(new Request('http://dsh.internal/api/codex-subscribe/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'codex-subscribe/manage', payload: { action: 'refresh-models', id } }) }))
    const result = (await rpc.json()).result
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, refresh)
    assert.equal(requests, 2)
    assert.ok(updates >= 2)
    const persisted = JSON.stringify([...domains.values()])
    for (const secret of ['synthetic-access', 'synthetic-refresh', 'synthetic-account']) assert.ok(!persisted.includes(secret))
    await tool.execute({ action: 'remove', id })
    assert.deepEqual([...domains.values()][0], { entries: {} })
  } finally {
    for (const dispose of effects.reverse()) await dispose()
    globalThis.fetch = previousFetch
  }
})
