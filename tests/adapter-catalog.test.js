import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountAdapter } from '../src/adapter.js'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

const route = 'codex-sub-test'
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

test('dynamic catalog resolves unknown models through real PiAiAdapter and freezes prepared model snapshots', async () => {
  const native = openaiCodexProvider()
  const base = native.getModels().find(model => !model.id.includes('spark'))
  let models = [{ ...base, id: 'future-model', name: 'Future model', contextWindow: 100000 }]
  let readyCalls = 0
  const captures = []
  const catalog = { async ready() { readyCalls++ }, getModels: () => models }
  const adapter = createAccountAdapter({ route, label: 'Test', catalog,
    getCredential: async () => ({ type: 'oauth', access: 'synthetic-token' }),
    providerFactory: () => ({ ...native, async *streamSimple(model, context, options) {
      captures.push({ model, options })
      yield { type: 'done', reason: 'stop', message: { role: 'assistant', api: model.api,
        provider: 'openai-codex', model: model.id, content: [{ type: 'text', text: 'OK' }],
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 0 } }
    } }),
  })
  assert.deepEqual((await adapter.listModels(route)).map(model => model.id), ['future-model'])
  assert.equal((await adapter.resolveModel(route, 'future-model')).context.contextWindow, 100000)
  const prepared = await adapter.prepareCall(route, 'future-model')
  models = [{ ...models[0], contextWindow: 200000 }]
  assert.equal((await adapter.resolveModel(route, 'future-model')).context.contextWindow, 200000)
  const request = { provider: route, model: 'future-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] }
  await collect(prepared.stream(request))
  await collect(adapter.stream(request))
  assert.equal(captures[0].model.contextWindow, 100000)
  assert.equal(captures[1].model.contextWindow, 200000)
  assert.equal(captures[1].options.apiKey, 'synthetic-token')
  assert.equal(readyCalls, 5)
})

test('all asynchronous adapter entry points wait for catalog readiness and respect cancellation', async () => {
  const calls = []
  const failure = new DOMException('cancelled', 'AbortError')
  const catalog = { async ready(options) { calls.push(options); throw failure }, getModels: () => [] }
  const adapter = createAccountAdapter({ route, label: 'Test', catalog, getCredential: async () => {},
    adapterFactory: () => ({ listModels() { assert.fail('not ready') }, resolveModel() { assert.fail('not ready') },
      prepareCall() { assert.fail('not ready') }, stream() { assert.fail('not ready') } }),
  })
  const signal = new AbortController().signal
  await assert.rejects(adapter.listModels(route), { name: 'AbortError' })
  await assert.rejects(adapter.resolveModel(route, 'm', signal), { name: 'AbortError' })
  await assert.rejects(adapter.prepareCall(route, 'm', signal), { name: 'AbortError' })
  await assert.rejects(collect(adapter.stream({ provider: route, model: 'm', messages: [], signal })), { name: 'AbortError' })
  assert.equal(calls.length, 4)
  assert.equal(calls[1].signal, signal)
})
