import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountAdapter } from '../src/adapter.js'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

const route = 'codex-sub-account-a'
const native = 'openai-codex'
const replay = provider => ({ response: { kind: 'pi-ai', version: 2, provider, model: 'm' }, blocks: [] })
const assistant = provider => ({ role: 'assistant', content: [], source: { kind: 'model', provider, model: 'm', replayState: replay(provider) } })

function fixture(options = {}) {
  let config
  let request
  const model = { provider: native, id: 'm', name: 'Model', context: { contextWindow: 100 } }
  const inner = {
    listModels: async provider => { assert.equal(provider, native); return [model] },
    resolveModel: async (provider, id) => { assert.equal(provider, native); assert.equal(id, 'm'); return model },
    prepareCall: async (provider, id) => { assert.equal(provider, native); assert.equal(id, 'm'); return { model, stream: inner.stream } },
    async *stream(options) { request = options; yield { type: 'finish', reason: { kind: 'stop' }, replayState: replay(native) } },
    providerRetryPolicy: provider => { assert.equal(provider, native); return undefined },
    imageRequestPricing: () => undefined,
    imageRequestTarget: () => ({ width: 100, height: 100, maxBytes: 1024 }),
  }
  const adapter = createAccountAdapter({ route, label: 'Account A', getCredential: async () => ({ type: 'oauth', access: 'test-token' }),
    providerFactory: () => ({ id: native, auth: { oauth: {} } }),
    adapterFactory: value => { config = value; return inner }, ...options,
  })
  return { adapter, inner, get config() { return config }, get request() { return request } }
}

const collect = async iterable => { const items = []; for await (const item of iterable) items.push(item); return items }

test('account routes expose native model metadata without changing route identity', async () => {
  let label = 'First'
  const { adapter } = fixture({ label: () => label })
  assert.equal(adapter.providerInfo(route).name, 'First')
  label = 'Renamed'
  assert.equal(adapter.providerInfo(route).name, 'Renamed')
  assert.equal((await adapter.listModels(route))[0].provider, route)
  assert.equal((await adapter.resolveModel(route, 'm')).provider, route)
  assert.throws(() => adapter.providerInfo('codex-sub-other'), { code: 'NO_ADAPTER' })
})

test('maps only own history and rewrites durable replay back to account identity', async () => {
  const f = fixture()
  const messages = [assistant(route), assistant('codex-sub-account-b'), assistant(native)]
  const before = structuredClone(messages)
  const output = await collect(f.adapter.stream({ provider: route, model: 'm', messages }))
  assert.equal(f.request.provider, native)
  assert.equal(f.request.messages[0].source.provider, native)
  assert.equal(f.request.messages[0].source.replayState.response.provider, native)
  assert.equal(f.request.messages[1].source.provider, 'codex-sub-account-b')
  assert.equal(f.request.messages[1].source.replayState, undefined)
  assert.equal(f.request.messages[2].source.replayState, undefined)
  assert.equal(output[0].replayState.response.provider, route)
  assert.deepEqual(messages, before, 'durable history must not be mutated')
})

test('prepared call preserves account route and uses the captured native preparation', async () => {
  const f = fixture()
  const prepared = await f.adapter.prepareCall(route, 'm')
  assert.equal(prepared.model.provider, route)
  const output = await collect(prepared.stream({ provider: route, model: 'm', messages: [assistant(route)] }))
  assert.equal(f.request.provider, native)
  assert.equal(output[0].replayState.response.provider, route)
  assert.throws(() => prepared.stream({ provider: 'codex-sub-other', model: 'm', messages: [] }), { code: 'NO_ADAPTER' })
})

test('distinct accounts have distinct adapters, profiles and resolved tokens', async () => {
  const a = fixture()
  const b = fixture({ route: 'codex-sub-account-b', getCredential: async () => ({ type: 'oauth', access: 'second-token' }) })
  assert.notEqual(a.adapter, b.adapter)
  assert.notEqual(a.inner, b.inner)
  assert.notEqual(a.config.profiles(), b.config.profiles())
  assert.deepEqual([...a.config.profiles().keys()], [native])
  assert.equal(await a.config.resolveApiKey(), 'test-token')
  assert.equal(await b.config.resolveApiKey(), 'second-token')
  const provider = a.config.profiles().get(native).piProvider
  assert.equal((await provider.auth.apiKey.resolve({ credential: { type: 'api_key', key: 'resolved' } })).auth.apiKey, 'resolved')
  assert.equal(await provider.auth.apiKey.resolve({ credential: undefined }), undefined)
  assert.equal(await a.config.auth.authContext.env('OPENAI_API_KEY'), undefined)
})

test('missing and malformed grants fail without ambient credential fallback', async () => {
  const missing = fixture({ getCredential: async () => undefined })
  await assert.rejects(missing.config.resolveApiKey(), { code: 'MISSING_CREDENTIAL' })
  const invalid = fixture({ getCredential: async () => ({ type: 'api_key', key: 'wrong' }) })
  await assert.rejects(invalid.config.resolveApiKey(), { code: 'AUTH_FAILED' })
})

test('native provider stream methods remove only unsupported temperature', () => {
  const calls = []
  const f = fixture({ providerFactory: () => ({ id: native, auth: { oauth: {} },
    stream: (...args) => { calls.push(args); return 'stream' },
    streamSimple: (...args) => { calls.push(args); return 'simple' },
  }) })
  const provider = f.config.profiles().get(native).piProvider
  const options = { temperature: 0, maxTokens: 42, apiKey: 'token', transport: 'sse' }
  assert.equal(provider.stream('model', 'context', options), 'stream')
  assert.equal(provider.streamSimple('model', 'context', options), 'simple')
  for (const call of calls) assert.deepEqual(call, ['model', 'context', { maxTokens: 42, apiKey: 'token', transport: 'sse' }])
  assert.equal(options.temperature, 0, 'caller options are immutable')
})

test('structured Codex quota evidence is request-scoped and never derives from message text', async () => {
  const original = openaiCodexProvider(), model = original.getModels()[0]
  const account = createAccountAdapter({ route, label: 'A', getCredential: async () => ({ type: 'oauth', access: 'test' }),
    chatRouter: (options, primary) => primary.stream(options),
    providerFactory: () => ({ ...original, async *streamSimple(requestModel, context, options) {
      const event = context.messages.some(message => message.role === 'user' && message.content === 'verified')
        ? { type: 'response.failed', response: { error: { code: 'usage_limit_reached' } } }
        : { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }
      await options.onProviderStreamEvent?.(event, requestModel)
      const message = { role: 'assistant', api: requestModel.api, provider: native, model: requestModel.id, content: [],
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'error',
        errorMessage: 'You have hit your ChatGPT usage limit', timestamp: 0 }
      yield { type: 'error', reason: 'error', error: message }
    } }),
  })
  const prepared = await account.prepareCall(route, model.id)
  const run = text => collect(prepared.stream({ provider: route, model: model.id, sessionId: text,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }] }))
  const [verified, ambiguous] = await Promise.all([run('verified'), run('ambiguous')])
  assert.equal(verified.at(-1).reason.failure.code, 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED')
  assert.notEqual(ambiguous.at(-1).reason.failure.code, 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED')
})

test('real PiAiAdapter resolves native Codex models and authenticates a local stub stream', async () => {
  let captured
  const original = openaiCodexProvider()
  const model = original.getModels()[0]
  const account = createAccountAdapter({
    route,
    label: 'Account A',
    getCredential: async () => ({ type: 'oauth', access: 'synthetic-account-token' }),
    providerFactory: () => ({ ...original,
      async *streamSimple(requestModel, context, options) {
        captured = { requestModel, context, options }
        const message = {
          role: 'assistant', api: requestModel.api, provider: native, model: requestModel.id,
          content: [{ type: 'text', text: 'Local reply', textSignature: 'own-signature' }],
          usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: 0,
        }
        yield { type: 'done', reason: 'stop', message }
      },
    }),
  })
  const listed = await account.listModels(route)
  assert.ok(listed.length > 0)
  assert.equal(listed[0].provider, route)
  const resolved = await account.resolveModel(route, model.id)
  assert.equal(resolved.provider, route)
  assert.equal(resolved.context.contextWindow, model.contextWindow)
  const own = { role: 'assistant', content: [{ type: 'text', text: 'Own history' }], source: {
    kind: 'model', provider: route, model: model.id,
    replayState: { response: { kind: 'pi-ai', version: 2, provider: route, api: model.api, model: model.id, stopReason: 'stop' },
      blocks: [{ type: 'text', textSignature: 'own-history-signature' }] },
  } }
  const foreign = { ...own, source: { ...own.source, provider: 'codex-sub-account-b',
    replayState: { ...own.source.replayState, response: { ...own.source.replayState.response, provider: 'codex-sub-account-b' } } } }
  const output = await collect(account.stream({ provider: route, model: model.id, temperature: 0,
    messages: [own, foreign, { role: 'user', content: [{ type: 'text', text: 'Reply' }] }] }))
  assert.equal(captured.requestModel.provider, native)
  assert.equal(captured.options.apiKey, 'synthetic-account-token')
  assert.equal(captured.options.temperature, undefined)
  assert.equal(captured.options.transport, 'sse')
  const history = captured.context.messages.filter(message => message.role === 'assistant')
  assert.equal(history[0].content[0].textSignature, 'own-history-signature')
  assert.equal(history[1].content[0].textSignature, undefined)
  assert.equal(history[1].api, 'dsh-foreign')
  const finish = output.find(chunk => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(finish.replayState.response.provider, route)
  assert.equal(finish.replayState.blocks[0].textSignature, 'own-signature')
})
