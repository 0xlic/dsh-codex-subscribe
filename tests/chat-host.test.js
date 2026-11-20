import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { Accounts, SCOPE } from '../src/accounts.js'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'

const model = 'gpt-chat-failover-test'
const sse = (...events) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const message = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply', annotations: [] }] }
const textStart = { type: 'response.output_item.added', output_index: 0, item: message }
const text = { type: 'response.output_text.delta', output_index: 0, delta: 'Reply' }
const textEnd = { type: 'response.output_item.done', output_index: 0, item: message }
const done = { type: 'response.completed', response: { status: 'completed', id: 'resp_test', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
const limited = { type: 'error', code: 'usage_limit_reached', message: 'Synthetic usage limit' }
const grant = account => ({ type: 'oauth', accountId: account, access: `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.test`, refresh: 'fake', expires: Date.now() + 3600000 })

async function setup(t, reply, quotaUsed = 5, nativeSelection = false) {
  const records = new Map(), adapters = new Map(), effects = [], calls = [], agents = new Map(), listeners = [], selections = []
  let service, selection
  const credentials = {
    listRecords: async () => [...records.keys()].map(key => ({ key, kind: 'grant' })),
    readRecord: async key => structuredClone(records.get(key)),
    modifyRecord: async (key, update) => {
      const next = await update(structuredClone(records.get(key)))
      if (next !== undefined) records.set(key, structuredClone(next))
      return structuredClone(records.get(key))
    },
  }
  const accounts = new Accounts(credentials, id => credentialKey(SCOPE, id), key => credentialKeyScope(key) === SCOPE ? credentialKeyId(key) : undefined)
  await accounts.add('primary', grant('primary'))
  await accounts.add('backup', grant('backup'))
  const rows = await accounts.list()
  const primary = rows.find(row => row.suffix === 'primary').provider
  const backup = rows.find(row => row.suffix === 'backup').provider
  selection = { provider: primary, model, reasoningEffort: 'medium' }
  const previousFetch = globalThis.fetch
  t.after(async () => { try { for (const dispose of effects.reverse()) await dispose?.() } finally { globalThis.fetch = previousFetch } })
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname
    const account = new Headers(options.headers).get('chatgpt-account-id')
    if (path.endsWith('/codex/models')) return Response.json({ models: [{ slug: model, visibility: 'list', display_name: 'Failover Test', context_window: 400000, input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'medium' }] }] })
    calls.push([path, account])
    if (path.endsWith('/wham/usage')) return Response.json({ rate_limit: { primary_window: { used_percent: typeof quotaUsed === 'function' ? quotaUsed(account) : quotaUsed, limit_window_seconds: 604800 } } })
    assert.ok(path.endsWith('/codex/responses'), path)
    return reply(account)
  }
  await apply({ credentials, storageDomain: {},
    llm: { registerAdapter([route], adapter) {
      adapters.set(route, adapter)
      return Object.assign(() => adapters.delete(route), { replace() {} })
    } },
    effect(fn) { effects.push(fn()) }, provide(_name, value) { service = value; return () => {} },
    connection: { fetch: { register: () => () => {} } }, tools: { register: () => () => {} },
    on(event, handler) { assert.equal(event, 'session/event'); listeners.push(handler) },
    get: name => name === 'agents' ? { get: sessionId => nativeSelection ? agentFor(sessionId) : { model: { current: () => selection } } } : undefined,
  }, { chatFailover: true })
  function agentFor(sessionId) {
    if (!agents.has(sessionId)) {
      const session = { id: sessionId, requestHeader: () => session.header }
      let choice = nativeSelection === 'auto' ? { provider: primary, model } : selection
      agents.set(sessionId, { session, model: {
        current: () => ({ ...choice }),
        select(next) {
          choice = { ...next }
          const event = { type: 'model/selection', data: choice }
          selections.push({ sessionId, ...event })
          for (const listener of listeners) listener(session, event)
        },
      } })
    }
    return agents.get(sessionId)
  }
  async function* stream(sessionId, purpose, signal = new AbortController().signal, { defaultEffort, beforeDispatch } = {}) {
    const agent = nativeSelection ? agentFor(sessionId) : undefined
    const choice = agent?.model.current() ?? selection
    const prepared = await adapters.get(choice.provider).prepareCall(choice.provider, model, signal)
    const defaulted = choice.reasoningEffort === undefined && defaultEffort !== undefined
    const config = defaulted ? { ...choice, reasoningEffort: defaultEffort } : choice
    if (agent) agent.session.header = { config, ...(defaulted ? { adapterDefaults: { reasoningEffort: true } } : {}) }
    if (defaulted) assert.equal(prepared.model.reasoning.defaultEffort, undefined)
    beforeDispatch?.(agent)
    yield* prepared.stream({ ...config, sessionId, purpose, signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Local test' }] }] })
  }
  const request = (...args) => Array.fromAsync(stream(...args))
  return { primary, backup, service, calls, request, stream, agentFor, selections }
}

test('Host dispatch uses another physical account on structured exhaustion and persists it per session', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, textEnd, done), 5, true)
  const chunks = await f.request('session-one')
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Reply'), true)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal('replayState' in chunks.at(-1), false)
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary', 'backup'])
  assert.deepEqual(f.agentFor('session-one').model.current(), { provider: f.backup, model, reasoningEffort: 'medium' })
  await f.request('session-one')
  await f.request('session-two')
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary', 'backup', 'backup', 'primary', 'backup'])
})

test('Host preserves single dispatch after partial output and does not confuse generic 429 with exhausted quota', async t => {
  let partial = true
  const f = await setup(t, account => {
    assert.equal(account, 'primary')
    return partial ? sse(textStart, text, limited) : Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 })
  })
  assert.equal((await f.request('partial')).some(chunk => chunk.type === 'text-delta'), true)
  partial = false
  assert.equal((await f.request('ordinary-429')).at(-1).reason.kind, 'error')
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary', 'primary'])
})

test('Host preserves a retryable finish after the Codex adapter has streamed text', async t => {
  const f = await setup(t, account => {
    assert.equal(account, 'primary')
    return sse(textStart, text, { type: 'error', code: 'server_error', message: 'Connection timed out' })
  }, 5, true)
  const chunks = await f.request('transient')
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), true)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
  assert.equal(f.selections.length, 0)
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary'])
})

test('a real HTTP usage failure is corroborated against the weekly-only limit before changing accounts', async t => {
  const f = await setup(t, account => account === 'primary'
    ? Response.json({ error: { code: 'usage_limit_reached', message: 'Synthetic exhausted quota' } }, { status: 429 })
    : sse(textStart, text, textEnd, done), account => account === 'primary' ? 100 : 1)
  assert.equal((await f.request('weekly')).at(-1).reason.kind, 'stop')
  assert.deepEqual(f.calls.map(([path, account]) => [path.split('/').at(-1), account]), [
    ['responses', 'primary'], ['usage', 'primary'], ['responses', 'backup'],
  ])
})

test('a quota snapshot obtained by the usage service skips the selected exhausted account before dispatch', async t => {
  const f = await setup(t, account => {
    assert.equal(account, 'backup')
    return sse(textStart, text, textEnd, done)
  }, account => account === 'primary' ? 100 : 1)
  await f.service.read({ provider: f.primary })
  assert.equal((await f.request('cached-weekly')).at(-1).reason.kind, 'stop')
  assert.deepEqual(f.calls.map(([path, account]) => [path.split('/').at(-1), account]), [
    ['usage', 'primary'], ['responses', 'backup'],
  ])
})

test('successful backup writes native selection before the next step, preserving Auto and session isolation', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, textEnd, done), 5, 'auto')
  assert.equal((await f.request('one')).at(-1).reason.kind, 'stop')
  assert.deepEqual(f.selections, [{ sessionId: 'one', type: 'model/selection', data: { provider: f.backup, model } }])
  assert.deepEqual(f.agentFor('two').model.current(), { provider: f.primary, model })
  await f.request('one')
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary', 'backup', 'backup'])
  assert.equal(f.selections.length, 1)
})

test('fallback persists Auto when DSH applied a scoped default absent from the raw adapter', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, textEnd, done), 5, 'auto')
  const request = () => f.request('one', undefined, undefined, { defaultEffort: 'medium' })
  assert.equal((await request()).at(-1).reason.kind, 'stop')
  assert.deepEqual(f.selections, [{ sessionId: 'one', type: 'model/selection', data: { provider: f.backup, model } }])
  assert.deepEqual(f.agentFor('one').model.current(), { provider: f.backup, model })
  await request()
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary', 'backup', 'backup'])
})

test('an explicit in-flight effort does not overwrite a manual switch to Auto before dispatch', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, textEnd, done), 5, true)
  const manual = { provider: f.primary, model }
  const result = await f.request('one', undefined, undefined, { beforeDispatch: agent => agent.model.select(manual) })
  assert.equal(result.at(-1).reason.kind, 'stop')
  assert.deepEqual(f.calls.filter(([path]) => path.endsWith('/responses')).map(([, account]) => account), ['primary', 'backup'])
  assert.deepEqual(f.agentFor('one').model.current(), manual)
  assert.deepEqual(f.selections, [{ sessionId: 'one', type: 'model/selection', data: manual }])
})

test('a manual away-and-back selection during fallback is not overwritten', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, textEnd, done), 5, true)
  const agent = f.agentFor('one')
  const stream = f.stream('one')
  assert.equal((await stream.next()).value.type, 'block-start')
  const original = agent.model.current()
  agent.model.select({ ...original, provider: 'manual-other' })
  agent.model.select(original)
  assert.equal((await Array.fromAsync(stream)).at(-1).reason.kind, 'stop')
  assert.deepEqual(agent.model.current(), original)
  assert.equal(f.selections.length, 2)
})

test('cancellation during the backup stream leaves native selection untouched', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, textEnd, done), 5, true)
  const controller = new AbortController()
  const stream = f.stream('one', undefined, controller.signal)
  assert.equal((await stream.next()).value.type, 'block-start')
  controller.abort()
  try { await Array.fromAsync(stream) } catch (error) { assert.equal(error.name, 'AbortError') }
  assert.equal(f.agentFor('one').model.current().provider, f.primary)
  assert.equal(f.selections.length, 0)
})

test('an incomplete backup never writes native selection', async t => {
  const f = await setup(t, account => account === 'primary' ? sse(limited) : sse(textStart, text, limited), 5, true)
  assert.equal((await f.request('one')).at(-1).reason.kind, 'error')
  assert.equal(f.agentFor('one').model.current().provider, f.primary)
  assert.equal(f.selections.length, 0)
})
