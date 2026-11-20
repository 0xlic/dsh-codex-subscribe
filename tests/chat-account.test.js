import test from 'node:test'
import assert from 'node:assert/strict'
import { compatibleChatModel, prepareChatAccount } from '../src/chat-account.js'

const model = { id: 'gpt', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' }, inputModalities: ['text', 'image'], context: { contextWindow: 100 } }

test('alternative accounts must match model, reasoning and admission capabilities', () => {
  assert.equal(compatibleChatModel(model, { ...model }, 'high'), true)
  assert.equal(compatibleChatModel(model, { ...model, id: 'other' }, 'high'), false)
  assert.equal(compatibleChatModel(model, { ...model, reasoning: { efforts: [] } }, 'high'), false)
  assert.equal(compatibleChatModel(model, { ...model, context: { contextWindow: 90 } }), false)
  assert.equal(compatibleChatModel(model, { ...model, inputModalities: ['text'] }), false)
  assert.equal(compatibleChatModel(model, { ...model, toolUpdate: 'addition-only' }), false)
})

test('fallback routes canonical conversation history without replay in either direction', async () => {
  let observed
  const entry = { provider: 'backup', adapter: { async prepareSingle() {
    return { model, async *stream(options) {
      observed = options
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { provider: 'backup' } } }
    } }
  } } }
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'history' }], source: { provider: 'first', model: 'gpt', replayState: { response: { private: true } } } }]
  const stream = await prepareChatAccount(entry, { provider: 'first', model: 'gpt', messages, reasoningEffort: 'high' }, { model })
  const chunks = await Array.fromAsync(stream())
  assert.equal(observed.provider, 'backup')
  assert.equal('replayState' in observed.messages[0].source, false)
  assert.equal('replayState' in messages[0].source, true)
  assert.equal('replayState' in chunks[0], false)
})
