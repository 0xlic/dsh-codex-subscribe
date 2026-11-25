import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { apply } from '../src/index.js'
import { Accounts, SCOPE } from '../src/accounts.js'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'

// Exercise the shipped Host wiring with real pi-ai OAuth resolution, but only
// synthetic grants and a local fetch stub. No real account or model request.
test('Host RPC and tool share dynamic refresh, account cache and native adapter metadata', async () => {
  const records = new Map(), adapters = new Map(), effects = [], domains = new Map()
  let route, tool, updates = 0, requests = 0, selection
  const tiers = []
  const agents = new Map(['a', 'b'].map(id => [id, { session: {}, model: { current: () => selection } }]))
  const access = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.test`
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
  const id = await accounts.add('test', { type: 'oauth', access, refresh: 'synthetic-refresh', accountId: 'synthetic-account', expires: Date.now() + 3600000 })
  const ctx = {
    credentials,
    get: name => name === 'agents' ? agents : undefined,
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
    if (new URL(url).pathname.endsWith('/codex/responses')) {
      const body = new Headers(options.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(options.body) : options.body
      tiers.push(JSON.parse(body).service_tier)
      const done = { type: 'response.completed', response: { status: 'completed', id: 'resp_test', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      const item = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply', annotations: [] }] }
      const events = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_text.delta', output_index: 0, delta: 'Reply' },
        { type: 'response.output_item.done', output_index: 0, item }, done,
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    requests++
    assert.equal(new URL(url).pathname, '/backend-api/codex/models')
    assert.equal(options.headers.Authorization, `Bearer ${access}`)
    assert.equal(options.headers['chatgpt-account-id'], 'synthetic-account')
    return Response.json({ models: [{ slug: 'gpt-future-new', display_name: 'Future', visibility: 'list',
      additional_speed_tiers: ['fast'], input_modalities: ['text'], context_window: 600000, supported_reasoning_levels: [{ effort: 'medium' }] }] }, { headers: { etag: 'test-etag' } })
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
    async function rpc(payload) {
      const reply = await route.fetch(new Request('http://dsh.internal/api/codex-subscribe/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'codex-subscribe/manage', payload }) }))
      return (await reply.json()).result
    }
    const result = await rpc({ action: 'refresh-models', id })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, refresh)
    assert.equal(requests, 2)
    assert.ok(updates >= 2)
    const provider = refresh.accounts[0].provider, model = 'gpt-future-new'
    selection = { provider, model }
    const pair = { provider, model, sessionId: 'a' }
    const prepared = await adapter.prepareCall(provider, model)
    const stream = async (sessionId, purpose, direct = false) => {
      const options = { ...pair, sessionId, purpose, messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] }
      const chunks = await Array.fromAsync(direct ? adapter.stream(options) : prepared.stream(options))
      assert.notEqual(chunks.at(-1)?.reason?.kind, 'error', JSON.stringify(chunks))
    }
    assert.deepEqual((await rpc({ action: 'fast-get', ...pair })).value, { supported: true, enabled: false })
    await stream('a')
    assert.deepEqual((await rpc({ action: 'fast-set', ...pair, enabled: true })).value, { supported: true, enabled: true })
    await Promise.all([stream('a'), stream('b'), stream('a', 'review'), stream('a', undefined, true)])
    assert.equal(tiers.slice(1).filter(value => value === 'priority').length, 2)
    assert.equal(tiers.slice(1).filter(value => value === undefined).length, 2)
    assert.equal(tiers[0], undefined)
    assert.equal((await rpc({ action: 'fast-set', ...pair, model: 'other', enabled: true })).ok, false)
    assert.deepEqual((await rpc({ action: 'fast-get', ...pair, provider: 'deepseek' })).value, { supported: false, enabled: false })
    assert.deepEqual((await rpc({ action: 'fast-set', ...pair, enabled: false })).value, { supported: true, enabled: false })
    await stream('a')
    assert.equal(tiers.at(-1), undefined)
    const persisted = JSON.stringify([...domains.values()])
    for (const secret of [access, 'synthetic-refresh', 'synthetic-account']) assert.ok(!persisted.includes(secret))
    await tool.execute({ action: 'remove', id })
    assert.deepEqual([...domains.values()][0], { entries: {} })
  } finally {
    for (const dispose of effects.reverse()) await dispose()
    globalThis.fetch = previousFetch
  }
})
