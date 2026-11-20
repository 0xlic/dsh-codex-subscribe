// Pure host-side chat failover core. All I/O (accounts, quota, preparation,
// time) is injected; this module never fetches, stores secrets, or parses
// provider error message text as routing evidence.
import { LlmError, QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { prepareChatAccount } from './chat-account.js'

/** Machine proof code the account adapter emits on structured SSE `usage_limit_reached`. */
export const QUOTA_PROOF_CODE = 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED'
/** Terminal wrap code: verified quota exhaustion left no retryable route. */
export const CHAT_FAILOVER_QUOTA_EXHAUSTED = 'CHAT_FAILOVER_QUOTA_EXHAUSTED'
/** Terminal wrap code: retry suppressed (output already streamed, or non-quota failure after routing). */
export const CHAT_FAILOVER_NO_RETRY = 'CHAT_FAILOVER_NO_RETRY'
/** DSH content chunk types; the first of these commits an attempt. */
export const CONTENT_CHUNK_TYPES = ['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end']

/** Terminal failover error. `code` is stable for outer retry normalization; `.cause` keeps the original failure. */
export class ChatFailoverError extends LlmError {
  constructor(message, code, options) {
    super(message, code, options)
    this.noRetry = true
  }
}

function isAbortFailure(error, signal) {
  if (signal?.aborted) return true
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

/**
 * dsh-llm-pi-ai delivers terminal failures as plain `{ message, code }` objects
 * on error/aborted finish chunks. Lift the machine code without echoing the
 * message text (provider bodies may be sensitive).
 */
export function finishFailure(reason) {
  const payload = reason?.failure
  if (payload instanceof Error) return payload
  if (payload && typeof payload === 'object' && typeof payload.code === 'string' && payload.code) {
    const status = Number(payload.status)
    const error = new LlmError('Response stream reported a terminal failure', payload.code, { cause: payload })
    if (Number.isFinite(status)) error.status = status
    return error
  }
  return new LlmError(`Response stream failed before completing (${reason?.kind ?? 'finish'})`, 'PROVIDER_ERROR')
}

/**
 * Classify a stream failure by machine-routable evidence only.
 * pi-ai promotes generic HTTP 429 responses to usage-limit *text*; message
 * wording is deliberately never inspected — suspected codes require fresh
 * quota corroboration before failover, proof codes are trusted outright.
 */
export function classifyChatQuotaFailure(error, { proofCodes = [QUOTA_PROOF_CODE], suspectCodes = [QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE] } = {}) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (proofCodes.includes(code)) return 'proven'
  const status = Number(error?.status ?? error?.statusCode)
  if (suspectCodes.includes(code) || status === 429) return 'suspected'
  return 'none'
}

function resetEpochMs(resetsAt) {
  const value = Number(resetsAt ?? NaN)
  if (!Number.isFinite(value) || value <= 0) return undefined
  // Usage DTOs mix epoch seconds and milliseconds; normalize once.
  return value > 1e12 ? value : value * 1000
}

/**
 * Conservative default model→limit matching. The usage service exposes the
 * account-wide Codex chat quota (id `codex`) plus scoped extras (code review,
 * metered features like Spark); chat routing considers a limit only when it
 * names the exact model or is that account-wide chat quota — never a
 * review/Spark limit.
 */
export function defaultLimitMatchesModel(limit, model) {
  if (model === undefined) return true
  const target = String(model).toLowerCase()
  for (const label of [limit?.id, limit?.name]) {
    if (typeof label !== 'string' || !label) continue
    const value = label.toLowerCase()
    if (value === target || value.startsWith(`${target}:`) || value.startsWith(`${target}/`) || value.endsWith(`:${target}`)) return true
  }
  return String(limit?.id ?? '').toLowerCase() === 'codex'
}

/**
 * A single account is unusable for `model` when a limit that belongs to that
 * exact model is exhausted (never a review/Spark limit), ignoring windows
 * whose reset already passed. No matching limit is treated as unknown, not
 * exhausted, so foreign-model evidence never blocks routing.
 */
export function isQuotaExhausted(quota, { model, exhaustedRemainingPercent = 0, now = Date.now, matches = defaultLimitMatchesModel } = {}) {
  if (!Array.isArray(quota?.rateLimits)) return false
  const relevant = quota.rateLimits.filter(limit => matches(limit, model))
  if (relevant.length === 0) return false
  return relevant.some(limit => {
    if (!limit || typeof limit !== 'object') return false
    if (limit.limitReached === true) return true
    return (Array.isArray(limit.windows) ? limit.windows : []).some(window => {
      const remaining = Number(window?.remainingPercent)
      if (!Number.isFinite(remaining)) return false
      const resetsAt = resetEpochMs(window?.resetsAt ?? window?.resetAt)
      if (resetsAt !== undefined && resetsAt <= now()) return false // stale window: it already reset
      return remaining <= exhaustedRemainingPercent
    })
  })
}

/**
 * Bounded sticky memory: exact-key recall plus a recency fallback for Auto
 * effort (model.current() may omit reasoningEffort even when the adapter
 * materialized a default). Keys are structured; entries are LRU-bounded.
 */
export function createSessionMemory({ maxEntries = 512 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer')
  const entries = new Map()
  const keyOf = key => `${key.sessionId}\u0000${key.provider}\u0000${key.model}\u0000${key.reasoningEffort ?? ''}`
  return {
    recall(key) {
      return entries.get(keyOf(key))?.effective
    },
    recallLatest({ sessionId, provider, model }) {
      let latest
      for (const entry of entries.values()) {
        if (entry.sessionId === sessionId && entry.provider === provider && entry.model === model) latest = entry
      }
      return latest?.effective
    },
    remember(key, effective) {
      if (typeof effective !== 'string' || !effective) throw new TypeError('effective provider is required')
      const stored = { sessionId: key.sessionId, provider: key.provider, model: key.model, reasoningEffort: key.reasoningEffort, effective }
      entries.delete(keyOf(key))
      entries.set(keyOf(key), stored)
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
      return effective
    },
    forget({ sessionId, provider, model }) {
      for (const [key, entry] of entries) {
        if (entry.sessionId === sessionId && entry.provider === provider && entry.model === model) entries.delete(key)
      }
    },
    get size() { return entries.size },
    dispose() { entries.clear() },
  }
}

/** Link a parent signal with a timeout guard; `cancel()` disarms the timeout so the response stream keeps the parent signal only. */
function linkSignal(parent, timeoutMs) {
  if (typeof AbortSignal?.any === 'function') {
    const timer = AbortSignal.timeout(Math.max(0, timeoutMs))
    return { signal: AbortSignal.any(parent ? [parent, timer] : [timer]), cancel() {} }
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('failover preparation deadline exceeded')), Math.max(0, timeoutMs))
  timer.unref?.()
  return { signal: controller.signal, cancel() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort) } }
}

/** Rejects when a preparation guard signal fires; never settles otherwise, so a cancelled guard is inert. */
function deadlineRejection(signal) {
  return new Promise((_, reject) => {
    const reason = () => reject(signal.reason ?? new Error('failover preparation deadline exceeded'))
    if (signal.aborted) reason()
    else signal.addEventListener('abort', reason, { once: true })
  })
}

/**
 * Route one prepared chat call across compatible same-model subscription
 * accounts. Failover happens only before any output chunk has been emitted
 * and only for quota failures that are machine-proven or corroborated by a
 * fresh quota read for the exact requested model; usage and other
 * non-content metadata stay buffered until an attempt commits, so a
 * discarded attempt never leaks chunks. Single-account scope streams
 * through unchanged.
 */
export function createChatRouter({
  listAccounts,
  prepare = prepareChatAccount,
  getQuota,
  readQuota,
  sessionMemory = createSessionMemory(),
  beginSelectionSwitch,
  onRoute,
  maxHops = 2,
  exhaustedRemainingPercent = 0,
  contentTypes = CONTENT_CHUNK_TYPES,
  proofCodes = [QUOTA_PROOF_CODE],
  suspectCodes = [QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE],
  quotaLimitMatches = defaultLimitMatchesModel,
  quotaProbeTimeoutMs = 3000,
  switchBudgetMs = 8000,
  now = Date.now,
} = {}) {
  if (typeof listAccounts !== 'function') throw new TypeError('listAccounts is required')
  if (typeof prepare !== 'function') throw new TypeError('prepare must be a function')
  if (typeof getQuota !== 'function') throw new TypeError('getQuota is required')
  if (typeof readQuota !== 'function') throw new TypeError('readQuota is required')
  if (typeof sessionMemory?.recall !== 'function' || typeof sessionMemory?.remember !== 'function') throw new TypeError('sessionMemory with recall/remember is required')
  if (!Number.isInteger(maxHops) || maxHops < 0) throw new TypeError('maxHops must be a non-negative integer')
  if (typeof quotaLimitMatches !== 'function') throw new TypeError('quotaLimitMatches must be a function')
  if (!(quotaProbeTimeoutMs > 0) || !Number.isFinite(quotaProbeTimeoutMs)) throw new TypeError('quotaProbeTimeoutMs must be positive')
  if (!(switchBudgetMs > 0) || !Number.isFinite(switchBudgetMs)) throw new TypeError('switchBudgetMs must be positive')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const emit = event => { try { onRoute?.(event) } catch { /* observability must never break routing */ } }
  const accountInfo = new Map() // last-known safe account facts for effectiveAccount()
  let disposed = false
  // Corroboration and preflight both evaluate quota for the exact model requested by the in-flight call.
  const exhaustedFor = (quota, model) => isQuotaExhausted(quota, { model, exhaustedRemainingPercent, now, matches: quotaLimitMatches })

  async function corroborateExhausted(provider, model, signal, deadline) {
    let quota
    try { quota = getQuota(provider) } catch { quota = undefined }
    if (exhaustedFor(quota, model)) return true
    const guard = linkSignal(signal, Math.min(quotaProbeTimeoutMs, Math.max(1, deadline - now())))
    try {
      // The probe is bounded even if the implementation ignores its signal; the race loser stays handled.
      const settled = Promise.resolve(readQuota(provider, { force: true }, guard.signal))
      settled.catch(() => {})
      quota = await Promise.race([settled, deadlineRejection(guard.signal)])
    }
    catch { return false } // probe failure or timeout never proves exhaustion
    finally { guard.cancel() }
    return exhaustedFor(quota, model)
  }

  async function* runRouted(options, primary) {
    const signal = options.signal
    signal?.throwIfAborted()
    const originalProvider = options.provider
    const triple = { sessionId: options.sessionId, provider: originalProvider, model: options.model }
    let switchSelection
    try { switchSelection = beginSelectionSwitch?.(options) } catch { /* dispatch does not depend on model persistence */ }

    let accounts = []
    try { accounts = await listAccounts(signal) } catch (error) { if (isAbortFailure(error, signal)) throw error }
    signal?.throwIfAborted()
    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (account?.provider) accountInfo.set(account.provider, { id: account.id, provider: account.provider, label: account.label })
    }
    const alternatives = new Map((Array.isArray(accounts) ? accounts : []).filter(account => account?.provider && account.provider !== originalProvider).map(account => [account.provider, account]))

    // Explicit multi-account scope only: without a registered alternative the dispatched call streams through unchanged.
    if (alternatives.size === 0) {
      if (sessionMemory.recall({ ...triple, reasoningEffort: options.reasoningEffort }) !== undefined || sessionMemory.recallLatest(triple) !== undefined) {
        sessionMemory.forget?.(triple) // stale stickiness pointed at a removed account
      }
      yield* primary.stream(options)
      return
    }
    const stickyProvider = sessionMemory.recall({ ...triple, reasoningEffort: options.reasoningEffort }) ?? sessionMemory.recallLatest(triple)

    // Attempt order: recalled sticky account, the dispatched original route, then remaining accounts.
    const chain = []
    if (stickyProvider && stickyProvider !== originalProvider && alternatives.has(stickyProvider)) chain.push({ provider: stickyProvider, entry: alternatives.get(stickyProvider), sticky: true })
    chain.push({ provider: originalProvider, primary: true })
    for (const [provider, entry] of alternatives) if (provider !== stickyProvider) chain.push({ provider, entry })

    const content = new Set(contentTypes)
    let attemptsUsed = 0
    let routed = false
    let deadline = null
    let skippedExhausted = false
    let untriedAlternatives = 0
    let lastFailure = null
    let lastInBand = null

    for (let index = 0; index < chain.length; index++) {
      const item = chain[index]
      if (attemptsUsed >= maxHops + 1) { untriedAlternatives = chain.length - index; break }
      let callable = null
      if (disposed) { untriedAlternatives = chain.length - index; break }
      // Use only fresh cached evidence before dispatch (including the selected account).
      let cached
      try { cached = getQuota(item.provider) } catch { cached = undefined }
      if (exhaustedFor(cached, options.model)) {
        skippedExhausted = true
        if (item.sticky) sessionMemory.forget?.(triple)
        emit({ type: 'skip', sessionId: options.sessionId, provider: item.provider, reason: 'quota-exhausted' })
        continue
      }
      if (!item.primary) {
        if (deadline === null) deadline = now() + switchBudgetMs
        if (now() > deadline) { untriedAlternatives = chain.length - index; break }
        const guard = linkSignal(signal, deadline - now())
        try {
          // Preparation races the deadline under the original request options; the fallback response stream itself is started later with the request signal.
          const settled = Promise.resolve(prepare(item.entry, options, primary))
          settled.catch(() => {}) // the race loser must stay handled
          callable = await Promise.race([settled, deadlineRejection(guard.signal)])
        } catch (error) {
          if (signal?.aborted) throw error
          if (guard.signal.aborted || disposed) { untriedAlternatives = chain.length - index; break } // preparation deadline or disposal, not user cancellation
          if (isAbortFailure(error, signal)) throw error
          emit({ type: 'skip', sessionId: options.sessionId, provider: item.provider, reason: 'prepare-failed' })
          continue
        }
        finally { guard.cancel() }
        if (disposed) { untriedAlternatives = chain.length - index; break } // plugin stopped mid-preparation: never start a further account
        if (typeof callable !== 'function') {
          emit({ type: 'skip', sessionId: options.sessionId, provider: item.provider, reason: 'incompatible' })
          continue
        }
      }

      attemptsUsed += 1
      if (!item.primary) {
        routed = true
        emit({ type: 'route', sessionId: options.sessionId, model: options.model, reasoningEffort: options.reasoningEffort, from: originalProvider, to: item.provider, reason: item.sticky ? 'sticky' : 'quota-failover', attempt: attemptsUsed })
      }

      let committed = false
      const buffered = []
      let failure = null
      let inBand = null
      let endedInBand = false
      let finishedSuccessfully = false
      try {
        // The fallback stream keeps the original request signal; the deadline guard never reaches it.
        const attemptStream = item.primary ? primary.stream(options) : callable(signal)
        for await (const chunk of attemptStream) {
          if (committed) {
            if (chunk?.type === 'finish') finishedSuccessfully = ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind)
            // Never hand the outer retry layer a retryable code after output.
            if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
              yield { type: 'finish', reason: { kind: 'error', failure: {
                code: CHAT_FAILOVER_NO_RETRY,
                message: 'Codex response failed after output started; not retried to avoid duplicate output.',
              } } }
              return
            }
            yield chunk
            if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') endedInBand = true
            continue
          }
          if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            // Terminal chunks carry the machine fact in reason.failure (plain object or Error); classify that exact fact.
            failure = finishFailure(chunk.reason)
            inBand = chunk
            break
          }
          if (chunk?.type === 'finish') finishedSuccessfully = ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind)
          if (content.has(chunk?.type)) {
            committed = true
            for (const metadata of buffered) yield metadata // preserve original order
            buffered.length = 0
            yield chunk
          }
          else if (chunk?.type === 'finish') {
            committed = true
            for (const metadata of buffered) yield metadata
            yield chunk
          }
          else buffered.push(chunk) // usage and unknown metadata stay private until commit
        }
      }
      catch (error) {
        if (isAbortFailure(error, signal)) throw error // user cancellation is never wrapped or failed over
        failure = error
      }
      if (failure !== null && isAbortFailure(failure, signal)) throw failure

      if (failure === null) {
        if (endedInBand) return // surfaced verbatim after commit: neither a success nor a failover candidate
        if (committed) {
          if (item.primary) sessionMemory.forget?.(triple) // the dispatched route recovered; drop stale stickiness
          else if (finishedSuccessfully && !disposed && !signal?.aborted) {
            if (beginSelectionSwitch) {
              // Never silently pin a route that the session picker cannot show.
              try { switchSelection?.(item.entry) } catch { /* a local write failure cannot invalidate the reply */ }
              sessionMemory.forget?.(triple)
            } else sessionMemory.remember({ ...triple, reasoningEffort: options.reasoningEffort }, item.provider)
          }
          emit({ type: 'success', sessionId: options.sessionId, provider: item.provider, origin: item.primary ? 'primary' : item.sticky ? 'sticky' : 'alternative', attempts: attemptsUsed })
          return
        }
        failure = new LlmError('Response stream ended before any output', EMPTY_RESPONSE_CODE)
      }
      lastFailure = failure
      lastInBand = inBand
      signal?.throwIfAborted()

      // After any committed output a restart would duplicate tool/text/reasoning: suppress outer retry.
      if (committed) {
        const error = new ChatFailoverError(`Subscription response failed after output started; retry suppressed to avoid duplicate output (route ${item.provider}, attempt ${attemptsUsed})`, CHAT_FAILOVER_NO_RETRY, { cause: failure })
        emit({ type: 'terminal', sessionId: options.sessionId, code: error.code, attempts: attemptsUsed, output: true })
        throw error
      }

      const verdict = classifyChatQuotaFailure(failure, { proofCodes, suspectCodes })
      let verified = verdict === 'proven'
      if (!verified && verdict === 'suspected') {
        if (deadline === null) deadline = now() + switchBudgetMs
        verified = await corroborateExhausted(item.provider, options.model, signal, deadline)
        signal?.throwIfAborted()
      }
      if (!verified) {
        if (inBand !== null) {
          // In-band terminal failures keep the provider's own finish as the raw surface: pass it through verbatim for outer retry normalization.
          emit({ type: 'raw', sessionId: options.sessionId, code: failure?.code, attempts: attemptsUsed })
          yield inBand
          return
        }
        if (item.primary && attemptsUsed === 1) {
          emit({ type: 'raw', sessionId: options.sessionId, code: failure?.code, attempts: attemptsUsed })
          throw failure // preserve the raw primary failure for outer retry normalization
        }
        const error = new ChatFailoverError(`Subscription account failover stopped after ${attemptsUsed} attempts (${String(failure?.code ?? 'unknown')} on ${item.provider}); not retried automatically`, CHAT_FAILOVER_NO_RETRY, { cause: failure })
        emit({ type: 'terminal', sessionId: options.sessionId, code: error.code, attempts: attemptsUsed, output: false })
        throw error
      }
      if (item.sticky) sessionMemory.forget?.(triple) // stickiness pointed at an exhausted account
    }

    // Chain exhausted without a successful attempt: verified quota with every eligible account exhausted or unreached is terminal; with no eligible alternative at all the raw primary failure survives.
    if (skippedExhausted || (lastFailure !== null && (routed || untriedAlternatives > 0))) {
      const error = new ChatFailoverError('Codex quota is exhausted and no compatible backup account is available for this request.', CHAT_FAILOVER_QUOTA_EXHAUSTED, { cause: lastFailure })
      emit({ type: 'terminal', sessionId: options.sessionId, code: error.code, attempts: attemptsUsed, output: false })
      throw error
    }
    if (lastFailure === null) throw new LlmError('No subscription account could be prepared for this request', 'NO_ADAPTER')
    if (lastInBand !== null) {
      // Verified quota but no eligible alternative: the provider's terminal finish is the raw surface.
      emit({ type: 'raw', sessionId: options.sessionId, code: lastFailure.code, attempts: attemptsUsed })
      yield lastInBand
      return
    }
    emit({ type: 'raw', sessionId: options.sessionId, code: lastFailure.code, attempts: attemptsUsed })
    throw lastFailure
  }

  function chatRouter(options, primary) {
    // Only conversation turns with a session take the routed path; auxiliary calls stream untouched.
    if (!options?.sessionId || options.purpose !== undefined || typeof primary?.stream !== 'function') return primary.stream(options)
    return runRouted(options, primary)
  }
  /** Sticky lookup for UI: which account serves this session's next turn. Safe fields only; exact key first, then the latest effort for the same choice/model. */
  chatRouter.effectiveAccount = function effectiveAccount({ sessionId, provider, model, reasoningEffort }) {
    const effective = sessionMemory.recall({ sessionId, provider, model, reasoningEffort }) ?? sessionMemory.recallLatest({ sessionId, provider, model })
    if (effective === undefined || effective === provider) return undefined
    return { provider: effective, ...accountInfo.get(effective) }
  }
  chatRouter.dispose = () => { disposed = true; sessionMemory.dispose?.(); accountInfo.clear() }
  return chatRouter
}
