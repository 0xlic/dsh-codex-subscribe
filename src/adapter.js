import { AsyncLocalStorage } from 'node:async_hooks'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

const NATIVE_PROVIDER = 'openai-codex'

function replayProvider(state, from, to) {
  if (state?.response?.provider !== from) return state
  return { ...state, response: { ...state.response, provider: to } }
}

function nativeRequest(options, route) {
  return {
    ...options,
    provider: NATIVE_PROVIDER,
    messages: options.messages.map(message => {
      if (message.role !== 'assistant') return message
      const source = message.source
      if (source.provider === route) {
        return { ...message, source: {
          ...source,
          provider: NATIVE_PROVIDER,
          ...(source.replayState === undefined ? {} : {
            replayState: replayProvider(source.replayState, route, NATIVE_PROVIDER),
          }),
        } }
      }
      // Defense in depth: the LLM service normally removes cross-adapter replay.
      // Never translate another account (or the stock Codex route) into this one.
      const { replayState: _discard, ...foreign } = source
      return { ...message, source: foreign }
    }),
  }
}

const requestContext = new AsyncLocalStorage()

function codexStreamOptions(options) {
  const { temperature: _unsupported, ...supported } = options ?? {}
  const { evidence, fast } = requestContext.getStore() ?? {}
  if (fast) {
    supported.serviceTier = 'priority'
    // pi-ai's streamSimple drops the top-level tier when it builds base options.
    // onPayload survives that conversion and updates the outgoing Codex body.
    const onPayload = supported.onPayload
    supported.onPayload = async (payload, model) => ({
      ...((await onPayload?.(payload, model)) ?? payload), service_tier: 'priority',
    })
  }
  if (!evidence) return supported
  const existing = supported.onProviderStreamEvent
  return { ...supported, async onResponse(response, model) {
    evidence.http429 = response.status === 429
    await supported.onResponse?.(response, model)
  }, async onProviderStreamEvent(event, model) {
    const error = event?.type === 'response.failed' ? event.response?.error : event?.type === 'error' ? event.error ?? event : undefined
    if (error?.code === 'usage_limit_reached' || error?.type === 'usage_limit_reached') evidence.exhausted = true
    await existing?.(event, model)
  } }
}

async function* accountStream(start, route, trackQuota = false, fast = false) {
  const evidence = trackQuota ? {} : undefined
  const run = callback => requestContext.run({ evidence, fast }, callback)
  const iterator = run(() => start()[Symbol.asyncIterator]())
  let done = false
  try {
    while (true) {
      const next = await run(() => iterator.next())
      if (next.done) { done = true; break }
      const chunk = next.value
      if (chunk.type !== 'finish') { yield chunk; continue }
      if (evidence?.exhausted && chunk.reason?.kind === 'error') {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED', message: 'Codex subscription quota is exhausted.',
        } } }
      } else if (evidence?.http429 && chunk.reason?.kind === 'error') {
        yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, status: 429 } } }
      } else if (chunk.replayState === undefined) yield chunk
      else yield { ...chunk, replayState: replayProvider(chunk.replayState, NATIVE_PROVIDER, route) }
    }
  } finally {
    if (!done) await run(() => iterator.return?.())
  }
}

/** One instance per immutable account id, never a shared mutable active account. */
class AccountAdapter extends LlmAdapter {
  constructor(route, label, inner, catalog, chatRouter, isFastEnabled) {
    super()
    this.route = route
    this.label = typeof label === 'function' ? label : () => label
    this.inner = inner
    this.catalog = catalog
    this.chatRouter = chatRouter
    this.isFastEnabled = isFastEnabled
  }

  useFast(options) {
    return options.purpose === undefined && !!options.sessionId
      && this.catalog?.supportsFast?.(options.model) === true
      && this.isFastEnabled?.(options) === true
  }

  assertRoute(provider) {
    if (provider !== this.route) throw new LlmError('Account adapter does not own this provider', 'NO_ADAPTER')
  }

  providerInfo(provider) {
    this.assertRoute(provider)
    return { id: this.route, name: this.label() }
  }

  providerRetryPolicy(provider) {
    this.assertRoute(provider)
    return this.inner.providerRetryPolicy(NATIVE_PROVIDER)
  }

  imageRequestPricing(provider, model) {
    this.assertRoute(provider)
    return this.inner.imageRequestPricing(NATIVE_PROVIDER, model)
  }

  imageRequestTarget(provider, model, image) {
    this.assertRoute(provider)
    return this.inner.imageRequestTarget(NATIVE_PROVIDER, model, image)
  }

  async listModels(provider) {
    this.assertRoute(provider)
    await this.catalog?.ready()
    return (await this.inner.listModels(NATIVE_PROVIDER)).map(model => ({ ...model, provider: this.route }))
  }

  async resolveModel(provider, model, signal) {
    this.assertRoute(provider)
    await this.catalog?.ready({ signal })
    return { ...await this.inner.resolveModel(NATIVE_PROVIDER, model, signal), provider: this.route }
  }

  async prepareSingle(provider, model, signal) {
    this.assertRoute(provider)
    await this.catalog?.ready({ signal })
    const prepared = await this.inner.prepareCall(NATIVE_PROVIDER, model, signal)
    return {
      model: { ...prepared.model, provider: this.route },
      stream: options => {
        this.assertRoute(options.provider)
        return accountStream(() => prepared.stream(nativeRequest(options, this.route)), this.route,
          !!this.chatRouter && !!options.sessionId && options.purpose === undefined, this.useFast(options))
      },
    }
  }

  async prepareCall(provider, model, signal) {
    const primary = await this.prepareSingle(provider, model, signal)
    if (!this.chatRouter) return primary
    return { ...primary, stream: options => {
      this.assertRoute(options.provider)
      return this.chatRouter(options, primary)
    } }
  }

  async *stream(options) {
    this.assertRoute(options.provider)
    if (this.chatRouter && options.sessionId && options.purpose === undefined) {
      yield* (await this.prepareCall(options.provider, options.model, options.signal)).stream(options)
      return
    }
    await this.catalog?.ready({ signal: options.signal })
    yield* accountStream(() => this.inner.stream(nativeRequest(options, this.route)), this.route, false, this.useFast(options))
  }
}

/**
 * getCredential returns this account's already-refreshed pi-ai OAuth grant.
 * Credential refresh/persistence belongs to the caller's account-scoped lock.
 * Factory overrides are dependency-injection seams for offline tests only.
 */
export function createAccountAdapter({
  route,
  label,
  getCredential,
  resolveAttachments,
  catalog,
  chatRouter,
  isFastEnabled,
  providerFactory = openaiCodexProvider,
  adapterFactory = config => new PiAiAdapter(config),
}) {
  if (typeof route !== 'string' || !/^codex-sub-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) {
    throw new TypeError('Expected a stable codex-sub- account provider route')
  }
  if (typeof getCredential !== 'function') throw new TypeError('getCredential is required')
  const native = providerFactory()
  // The Codex subscription endpoint rejects temperature (including the value
  // used by generic DSH auxiliary calls such as auto-review).
  // A native OAuth-only provider ignores PiAiAdapter's apiKey override. Keep
  // native transport/models/OAuth intact and accept only the resolved token.
  const piProvider = {
    ...native,
    stream: (model, context, options) => native.stream(model, context, codexStreamOptions(options)),
    streamSimple: (model, context, options) => native.streamSimple(model, context, codexStreamOptions(options)),
    auth: {
      ...native.auth,
      apiKey: {
        name: 'Account-scoped Codex OAuth request token',
        async resolve({ credential }) {
          if (credential?.type !== 'api_key' || !credential.key) return undefined
          return { auth: { apiKey: credential.key }, source: 'Account-scoped OAuth' }
        },
      },
    },
  }
  const profile = {
    provider: NATIVE_PROVIDER,
    displayName: 'ChatGPT subscription',
    piProvider,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20 * 1024 * 1024,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    streamIdleTimeoutMs: 300_000,
    cacheRetention: 'short',
    transport: 'sse',
  }
  // PiAiAdapter caches collections by Map identity. Publish a new immutable
  // profile snapshot when the directory changes; prepared requests retain theirs.
  let models, profiles
  const currentProfiles = () => {
    if (!catalog) return profiles ??= new Map([[NATIVE_PROVIDER, profile]])
    const next = catalog.getModels()
    if (next !== models) {
      models = next
      const captured = next
      profiles = new Map([[NATIVE_PROVIDER, { ...profile, piProvider: { ...piProvider, getModels: () => captured } }]])
    }
    return profiles
  }
  const inner = adapterFactory({
    profiles: currentProfiles,
    async resolveApiKey() {
      // PiAiAdapter's resolver does not expose the request AbortSignal.
      let credential
      try { credential = await getCredential({}) } catch {
        // OAuth responses can contain sensitive data; never project raw SDK
        // failures into the durable model-call error or conversation log.
        throw new LlmError('Subscription authorization failed; sign in again if the problem persists', 'AUTH_FAILED')
      }
      if (credential === undefined) throw new LlmError('Account is not signed in', 'MISSING_CREDENTIAL')
      if (credential.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access) {
        throw new LlmError('Account credential is invalid', 'AUTH_FAILED')
      }
      return credential.access
    },
    auth: { authContext: { env: async () => undefined, fileExists: async () => false } },
    resolveAttachments,
  })
  return new AccountAdapter(route, label, inner, catalog, chatRouter, isFastEnabled)
}
