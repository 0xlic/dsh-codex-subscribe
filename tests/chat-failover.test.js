import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createChatRouter, createSessionMemory, classifyChatQuotaFailure, isQuotaExhausted,
  QUOTA_PROOF_CODE, CHAT_FAILOVER_QUOTA_EXHAUSTED, CHAT_FAILOVER_NO_RETRY, ChatFailoverError,
} from '../src/chat-failover.js'

// Offline unit tests only: every account, quota, and stream is injected; the
// real network must stay unreachable even if injection is accidentally lost.
const realFetch = globalThis.fetch
test.before(() => { globalThis.fetch = async () => { throw new Error('Real network is forbidden in chat failover tests') } })
test.after(() => { globalThis.fetch = realFetch })

const PRIMARY = 'codex-sub-a', B = 'codex-sub-b', C = 'codex-sub-c'
const MODEL = 'gpt-5.2-codex'
const SESSION = 'session-1'
const proofError = () => Object.assign(new Error('structured usage_limit_reached'), { code: QUOTA_PROOF_CODE })
const quotaError = () => Object.assign(new Error('generic HTTP 429'), { code: 'QUOTA' })
const text = t => ({ type: 'text-delta', text: t })
const usage = tokens => ({ type: 'usage', usage: { totalTokens: tokens } })
const finish = (kind = 'stop', reason = {}) => ({ type: 'finish', reason: { kind, ...reason } })

/** One attempt as a chunk array; `{ $throw: error }` throws mid-stream. */
async function* attempt(spec) {
  for (const item of spec) {
    if (item && item.$throw) throw item.$throw
    yield item
  }
}

function quotaDto(model, remainingPercent, { resetsAt, limitReached, id } = {}) {
  return {
    fetchedAt: 1,
    rateLimits: [{
      id: id ?? `${model}:primary`,
      name: model,
      ...(limitReached === undefined ? {} : { limitReached }),
      windows: resetsAt === undefined && remainingPercent === undefined ? [] : [{
        remainingPercent, windowSeconds: 300, ...(resetsAt === undefined ? {} : { resetsAt }),
      }],
    }],
  }
}

function fixture({
  accounts = [{ id: 'account-a', provider: PRIMARY, label: 'A' }, { id: 'account-b', provider: B, label: 'B' }, { id: 'account-c', provider: C, label: 'C' }],
  primarySpecs = {},       // provider PRIMARY -> queue of attempt specs
  specs = {},              // provider -> queue of attempt specs (alternatives)
  quotas = {},             // provider -> fresh-cached quota DTO (getQuota)
  readQuotas = {},         // provider -> value/function for readQuota
  incompatible = [],       // providers whose prepare resolves undefined
  prepareHook,             // called inside prepare (may dispose the router)
  memory = createSessionMemory(),
  routerOptions = {},
} = {}) {
  const calls = { primary: [], prepare: [], streams: [], getQuota: [], readQuota: [], events: [], listAccounts: 0 }
  const primary = {
    model: { id: MODEL },
    stream: options => {
      calls.primary.push(options)
      const spec = (primarySpecs[PRIMARY] ?? []).shift()
      return attempt(spec ?? [finish()])
    },
  }
  const chatRouter = createChatRouter({
    listAccounts: async () => { calls.listAccounts++; return accounts },
    getQuota: provider => { calls.getQuota.push(provider); return quotas[provider] },
    readQuota: async (provider, opts, signal) => {
      calls.readQuota.push({ provider, opts, signal })
      const value = readQuotas[provider]
      if (typeof value === 'function') return value(provider, opts, signal)
      if (value === undefined) throw new Error('offline quota read failed')
      return value
    },
    prepare: async (entry, options, prepPrimary) => {
      calls.prepare.push({ entry, options, primary: prepPrimary })
      prepareHook?.(entry)
      if (incompatible.includes(entry.provider)) return undefined
      return signal => {
        calls.streams.push({ provider: entry.provider, signal })
        return attempt((specs[entry.provider] ?? []).shift() ?? [finish()])
      }
    },
    sessionMemory: memory,
    onRoute: event => calls.events.push(event),
    ...routerOptions,
  })
  const run = (overrides = {}) => chatRouter({
    provider: PRIMARY, model: MODEL, sessionId: SESSION, messages: [], reasoningEffort: 'high',
    ...overrides,
  }, primary)
  return { chatRouter, calls, run }
}
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const rejection = async stream => { try { await collect(stream) } catch (error) { return error } throw new Error('expected rejection') }
const rejectionWithChunks = async stream => { const chunks = []; try { for await (const chunk of stream) chunks.push(chunk) } catch (error) { return { chunks, error } } throw new Error('expected rejection') }

test('classification: only machine codes count, promoted usage-limit text never does', () => {
  assert.equal(classifyChatQuotaFailure(proofError()), 'proven')
  assert.equal(classifyChatQuotaFailure(quotaError()), 'suspected')
  assert.equal(classifyChatQuotaFailure(Object.assign(new Error('x'), { code: 'ACCOUNT_QUOTA' })), 'suspected')
  assert.equal(classifyChatQuotaFailure(Object.assign(new Error('x'), { status: 429 })), 'suspected')
  assert.equal(classifyChatQuotaFailure(Object.assign(new Error('You have hit your ChatGPT usage limit'), { code: 'RATE_LIMIT' })), 'none')
  assert.equal(classifyChatQuotaFailure(new Error('You have hit your ChatGPT usage limit')), 'none')
  assert.equal(classifyChatQuotaFailure(proofError(), { proofCodes: ['OTHER_PROOF'] }), 'none')
})

test('quota exhaustion is scoped to the exact model and honors resets and limitReached', () => {
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 0), { model: MODEL }), true)
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 50), { model: MODEL }), false)
  // A review/Spark limit must never block the requested model.
  assert.equal(isQuotaExhausted(quotaDto('gpt-5.2-spark', 0), { model: MODEL }), false)
  assert.equal(isQuotaExhausted({ rateLimits: [] }, { model: MODEL }), false)
  assert.equal(isQuotaExhausted(undefined, { model: MODEL }), false)
  // Stale windows already reset; future resets still block.
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 0, { resetsAt: (Date.now() - 1000) / 1000 }), { model: MODEL }), false)
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 0, { resetsAt: Date.now() + 60000 }), { model: MODEL }), true)
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 0, { resetsAt: Date.now() + 60000 }), { model: MODEL, now: () => Date.now() + 120000 }), false)
  assert.equal(isQuotaExhausted(quotaDto(MODEL, undefined, { limitReached: true }), { model: MODEL }), true)
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 3), { model: MODEL, exhaustedRemainingPercent: 5 }), true)
  assert.equal(isQuotaExhausted(quotaDto(MODEL, 6), { model: MODEL, exhaustedRemainingPercent: 5 }), false)
  assert.equal(isQuotaExhausted(quotaDto('spark', 0, { id: `other:${MODEL}` }), { model: MODEL }), true, 'delimited secondary id still matches')
})

test('machine-proven quota failure fails over pre-output with no leaked chunks, then sticks per session', async () => {
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[usage(9), { $throw: proofError() }]] },
    specs: { [B]: [[usage(1), text('hi'), usage(2), finish()], [text('again'), finish()]] },
  })
  const first = await collect(f.run())
  assert.deepEqual(first.map(chunk => chunk.type), ['usage', 'text-delta', 'usage', 'finish'])
  assert.equal(first.includes(usage(9)), false, 'failed attempt metadata must stay buffered and be discarded')
  assert.deepEqual(f.calls.primary.map(options => options.provider), [PRIMARY])
  assert.deepEqual(f.calls.streams.map(entry => entry.provider), [B])
  assert.deepEqual(f.calls.events.filter(event => event.type !== 'skip').map(event => `${event.type}:${event.to ?? event.provider ?? event.code}`), [`route:${B}`, `success:${B}`])
  // Second turn: stickiness serves B first; the exhausted primary is never dispatched.
  const second = await collect(f.run())
  assert.deepEqual(second.map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(f.calls.primary.length, 1)
  assert.deepEqual(f.calls.streams.map(entry => entry.provider), [B, B])
  assert.deepEqual(f.chatRouter.effectiveAccount({ sessionId: SESSION, provider: PRIMARY, model: MODEL, reasoningEffort: 'high' }), { id: 'account-b', provider: B, label: 'B' })
})

test('suspected generic 429 fails over only with fresh quota corroboration for the exact model', async () => {
  const corroborated = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: quotaError() }]] },
    specs: { [B]: [[text('ok'), finish()]] },
    readQuotas: { [PRIMARY]: () => quotaDto(MODEL, 0) },
  })
  assert.deepEqual((await collect(corroborated.run())).map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(corroborated.calls.readQuota.length, 1)
  assert.equal(corroborated.calls.readQuota[0].provider, PRIMARY)
  assert.deepEqual(corroborated.calls.readQuota[0].opts, { force: true })
  // A cached healthy observation may precede the failure. Recheck once; without proof leave the primary failure unchanged.
  const healthy = fixture({ primarySpecs: { [PRIMARY]: [[{ $throw: quotaError() }]] }, quotas: { [PRIMARY]: quotaDto(MODEL, 50) } })
  const error = await rejection(healthy.run())
  assert.equal(error.code, 'QUOTA')
  assert.equal(healthy.calls.prepare.length, 0)
  assert.equal(healthy.calls.readQuota.length, 1)
  // Corroboration quoting a different model's limit never proves exhaustion.
  const foreign = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: quotaError() }]] },
    readQuotas: { [PRIMARY]: () => quotaDto('gpt-5.2-spark', 0) },
  })
  assert.equal((await rejection(foreign.run())).code, 'QUOTA')
  assert.equal(foreign.calls.prepare.length, 0)
})

test('after-output failures suppress outer retry even on the untouched primary route', async () => {
  const thrown = Object.assign(new Error('mid-stream transport'), { code: 'RATE_LIMIT' })
  const f = fixture({ primarySpecs: { [PRIMARY]: [[text('partial'), { $throw: thrown }]] } })
  const seen = []
  const { chunks, error } = await rejectionWithChunks(f.run())
  assert.ok(error instanceof ChatFailoverError)
  assert.equal(error.code, CHAT_FAILOVER_NO_RETRY)
  assert.equal(error.noRetry, true)
  assert.equal(error.cause, thrown)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['text-delta'])
  assert.equal(f.calls.prepare.length, 0)
})

test('a post-commit error finish suppresses outer retry and never records success', async () => {
  const failure = { message: 'SECRET body detail', code: 'QUOTA' }
  const f = fixture({ primarySpecs: { [PRIMARY]: [[text('partial'), finish('error', { failure })]] } })
  const chunks = await collect(f.run())
  assert.deepEqual(chunks[0], text('partial'))
  assert.equal(chunks[1].reason.failure.code, CHAT_FAILOVER_NO_RETRY)
  assert.equal(f.calls.prepare.length, 0)
  assert.equal(f.chatRouter.effectiveAccount({ sessionId: SESSION, provider: PRIMARY, model: MODEL, reasoningEffort: 'high' }), undefined)
})

test('a pre-commit error finish chunk carries reason.failure into classification', async () => {
  // Plain-object payload with the proof code (the dsh-llm-pi-ai shape) fails over.
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[finish('error', { failure: { message: 'SECRET structured body', code: QUOTA_PROOF_CODE } })]] },
    specs: { [B]: [[text('rescued'), finish()]] },
  })
  assert.deepEqual((await collect(f.run())).map(chunk => chunk.type), ['text-delta', 'finish'])
  // Suspected payload corroborated by a fresh quota read for the exact model also fails over.
  const corroborated = fixture({
    primarySpecs: { [PRIMARY]: [[finish('error', { failure: { message: 'SECRET generic body', code: 'QUOTA' } })]] },
    readQuotas: { [PRIMARY]: quotaDto(MODEL, 0) },
    specs: { [B]: [[text('also rescued'), finish()]] },
  })
  assert.deepEqual((await collect(corroborated.run())).map(chunk => chunk.type), ['text-delta', 'finish'])
  // Unrelated in-band failures surface the provider's own finish verbatim: single dispatch, no wrap.
  const genericFailure = { message: 'SECRET transport detail', code: 'RATE_LIMIT' }
  const generic = fixture({ primarySpecs: { [PRIMARY]: [[finish('error', { failure: genericFailure })]] } })
  assert.deepEqual(await collect(generic.run()), [finish('error', { failure: genericFailure })])
  assert.equal(generic.calls.prepare.length, 0)
})

test('non-quota pre-output primary failure is preserved raw for outer retry normalization', async () => {
  const thrown = Object.assign(new Error('auth expired'), { code: 'AUTH_FAILED' })
  const f = fixture({ primarySpecs: { [PRIMARY]: [[{ $throw: thrown }]] } })
  assert.equal(await rejection(f.run()), thrown)
  assert.equal(f.calls.prepare.length, 0)
})

test('non-quota failure on a routed account is terminal no-retry, never a silent second hop', async () => {
  const thrown = Object.assign(new Error('remote rejected'), { code: 'AUTH_FAILED' })
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }]] },
    specs: { [B]: [[{ $throw: thrown }]] },
  })
  const error = await rejection(f.run())
  assert.ok(error instanceof ChatFailoverError)
  assert.equal(error.code, CHAT_FAILOVER_NO_RETRY)
  assert.equal(error.cause, thrown)
  assert.equal(f.calls.streams.map(entry => entry.provider).includes(C), false)
})

test('fresh-cached exhausted alternatives are skipped without any request; verified exhaustion everywhere is terminal', async () => {
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }]] },
    quotas: { [B]: quotaDto(MODEL, 0), [C]: quotaDto(MODEL, 40) },
    specs: { [C]: [[text('via c'), finish()]] },
  })
  assert.deepEqual((await collect(f.run())).map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.deepEqual(f.calls.getQuota, [PRIMARY, B, C])
  assert.equal(f.calls.readQuota.length, 0)
  assert.deepEqual(f.calls.streams.map(entry => entry.provider), [C])
  assert.ok(f.calls.events.some(event => event.type === 'skip' && event.provider === B && event.reason === 'quota-exhausted'))
})

test('all eligible accounts quota-exhausted with the primary: terminal no-retry, raw primary error preserved otherwise', async () => {
  const thrown = proofError()
  const all = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: thrown }]] },
    quotas: { [B]: quotaDto(MODEL, 0), [C]: quotaDto(MODEL, 0) },
  })
  const error = await rejection(all.run())
  assert.equal(error.code, CHAT_FAILOVER_QUOTA_EXHAUSTED)
  assert.equal(error.noRetry, true)
  assert.equal(error.cause, thrown)
  assert.equal(all.calls.streams.length, 0)
  assert.equal(all.calls.readQuota.length, 0)
  // No alternative registered at all -> raw primary failure for outer retry.
  const soloThrown = proofError()
  const solo = fixture({
    accounts: [{ id: 'account-a', provider: PRIMARY, label: 'A' }],
    primarySpecs: { [PRIMARY]: [[{ $throw: soloThrown }]] },
  })
  assert.equal(await rejection(solo.run()), soloThrown)
  assert.equal(solo.calls.listAccounts, 1)
  // Alternatives registered but incompatible -> still no eligible alternative.
  const incompatible = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: thrown }]] },
    incompatible: [B, C],
  })
  assert.equal(await rejection(incompatible.run()), thrown)
  assert.equal(incompatible.calls.streams.length, 0)
})

test('single-account scope streams through unchanged without routing machinery', async () => {
  const f = fixture({
    accounts: [{ id: 'account-a', provider: PRIMARY, label: 'A' }],
    primarySpecs: { [PRIMARY]: [[usage(5), text('solo'), finish()], [{ $throw: proofError() }]] },
  })
  assert.deepEqual((await collect(f.run())).map(chunk => chunk.type), ['usage', 'text-delta', 'finish'])
  const error = await rejection(f.run())
  assert.equal(error.code, QUOTA_PROOF_CODE)
  assert.ok(!(error instanceof ChatFailoverError))
})

test('hops are bounded: a third account is never reached beyond maxHops', async () => {
  const f = fixture({
    routerOptions: { maxHops: 1 },
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }]] },
    specs: { [B]: [[{ $throw: proofError() }]], [C]: [[text('never'), finish()]] },
  })
  const error = await rejection(f.run())
  assert.equal(error.code, CHAT_FAILOVER_QUOTA_EXHAUSTED)
  assert.deepEqual(f.calls.streams.map(entry => entry.provider), [B])
  assert.equal(f.calls.getQuota.includes(C), false)
})

test('user cancellation aborts raw without failover or wrapping, even with a quota-shaped error', async () => {
  const controller = new AbortController()
  const abortError = Object.assign(new Error('user cancelled'), { name: 'AbortError' })
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: Object.assign(abortError, { code: QUOTA_PROOF_CODE }) }]] },
  })
  const error = await rejection(f.run({ signal: controller.signal }))
  assert.equal(error, abortError)
  assert.equal(f.calls.prepare.length, 0)
})

test('sticky memory: Auto effort without reasoningEffort still recalls the last effective account', async () => {
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }]] },
    specs: { [B]: [[text('ok'), finish()], [text('auto'), finish()]] },
  })
  await collect(f.run({ reasoningEffort: 'high' }))
  assert.deepEqual(f.calls.streams.map(entry => entry.provider), [B])
  await collect(f.run({ reasoningEffort: undefined }))
  assert.equal(f.calls.primary.length, 1, 'second turn must serve sticky B first')
  assert.deepEqual(f.calls.streams.map(entry => entry.provider), [B, B])
  assert.equal(f.calls.prepare.at(-1).options.reasoningEffort, undefined)
  assert.deepEqual(f.chatRouter.effectiveAccount({ sessionId: SESSION, provider: PRIMARY, model: MODEL }), { id: 'account-b', provider: B, label: 'B' })
  assert.equal(f.chatRouter.effectiveAccount({ sessionId: SESSION, provider: PRIMARY, model: 'other-model' }), undefined)
})

test('sticky account failing verified-quota drops stickiness and falls back to the dispatched route', async () => {
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }], [text('primary recovered'), finish()]] },
    specs: { [B]: [[text('ok'), finish()], [{ $throw: proofError() }]] },
  })
  await collect(f.run())
  const second = await collect(f.run())
  assert.deepEqual(second.map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(second[0].text, 'primary recovered')
  assert.equal(f.calls.primary.length, 2)
  assert.equal(f.chatRouter.effectiveAccount({ sessionId: SESSION, provider: PRIMARY, model: MODEL, reasoningEffort: 'high' }), undefined)
})

test('session memory: bounded LRU, effort-scoped recall, latest fallback, forget', () => {
  const memory = createSessionMemory({ maxEntries: 2 })
  const key = { sessionId: SESSION, provider: PRIMARY, model: MODEL }
  memory.remember({ ...key, reasoningEffort: 'high' }, B)
  memory.remember({ ...key, reasoningEffort: 'medium' }, C)
  assert.equal(memory.recall({ ...key, reasoningEffort: 'high' }), B)
  assert.equal(memory.recallLatest(key), C)
  memory.remember({ ...key, reasoningEffort: 'high' }, B) // refresh recency
  memory.remember({ sessionId: 'session-2', provider: PRIMARY, model: MODEL, reasoningEffort: 'high' }, B)
  assert.equal(memory.size, 2)
  assert.equal(memory.recall({ sessionId: 'session-2', provider: PRIMARY, model: MODEL, reasoningEffort: 'high' }), B)
  assert.equal(memory.recallLatest(key), B, 'oldest medium entry was evicted, refreshed high entry survived')
  memory.forget(key)
  assert.equal(memory.recallLatest(key), undefined)
  assert.throws(() => memory.remember(key, ''))
})

test('switch preparation is time-bounded: quota probe timeout and total switch budget', async () => {
  let watchdog
  // A hanging quota probe must not hang the router: corroborate stays bounded.
  const hanging = fixture({
    routerOptions: { quotaProbeTimeoutMs: 5 },
    primarySpecs: { [PRIMARY]: [[{ $throw: quotaError() }]] },
    readQuotas: { [PRIMARY]: () => new Promise(() => {}) },
  })
  try {
    const error = await Promise.race([rejection(hanging.run()), new Promise((_, no) => { watchdog = setTimeout(() => no(new Error('quota probe was not bounded')), 1000) })])
    assert.equal(error.code, 'QUOTA', 'unproven suspicion falls back to the raw primary failure')
    assert.equal(hanging.calls.prepare.length, 0)
  } finally { clearTimeout(watchdog) }
  // Total switch budget: once exhausted, no further account is prepared.
  let t = 0
  const budget = fixture({
    routerOptions: { now: () => (t += 5000) },
    primarySpecs: { [PRIMARY]: [[{ $throw: quotaError() }]] },
    readQuotas: { [PRIMARY]: quotaDto(MODEL, 0) },
    specs: { [B]: [[text('never'), finish()]] },
  })
  const error = await rejection(budget.run())
  assert.equal(error.code, CHAT_FAILOVER_QUOTA_EXHAUSTED)
  assert.equal(budget.calls.prepare.length, 0, 'corroborated exhaustion but no budget left to prepare an alternative')
  assert.equal(budget.calls.streams.length, 0)
})

test('disposal during preparation stops the switch without starting the prepared stream', async () => {
  let f
  f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }]] },
    specs: { [B]: [[text('never started'), finish()]] },
    prepareHook: () => f.chatRouter.dispose(),
  })
  const error = await rejection(f.run())
  assert.equal(error.code, CHAT_FAILOVER_QUOTA_EXHAUSTED)
  assert.deepEqual(f.calls.streams, [])
  assert.equal(f.chatRouter.effectiveAccount({ sessionId: SESSION, provider: PRIMARY, model: MODEL }), undefined)
})

test('auxiliary purpose or missing session bypasses the router entirely', async () => {
  const f = fixture({ primarySpecs: { [PRIMARY]: [[usage(1), text('aux'), finish()], [usage(1), text('aux'), finish()]] } })
  const aux = await collect(f.run({ purpose: 'review', sessionId: SESSION }))
  assert.deepEqual(aux.map(chunk => chunk.type), ['usage', 'text-delta', 'finish'])
  assert.equal(f.calls.listAccounts, 0)
  const noSession = await collect(f.run({ sessionId: undefined }))
  assert.equal(noSession.length, 3)
  assert.equal(f.calls.listAccounts, 0)
})

test('fallback response stream receives the original request signal, not a preparation guard', async () => {
  const controller = new AbortController()
  const f = fixture({
    primarySpecs: { [PRIMARY]: [[{ $throw: proofError() }]] },
    specs: { [B]: [[text('ok'), finish()]] },
  })
  await collect(f.run({ signal: controller.signal }))
  assert.equal(f.calls.streams[0].signal, controller.signal)
  assert.equal(f.calls.prepare[0].options.signal, controller.signal)
})
