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

async function* accountStream(stream, route) {
  for await (const chunk of stream) {
    if (chunk.type !== 'finish' || chunk.replayState === undefined) yield chunk
    else yield { ...chunk, replayState: replayProvider(chunk.replayState, NATIVE_PROVIDER, route) }
  }
}

/** One instance per immutable account id, never a shared mutable active account. */
class AccountAdapter extends LlmAdapter {
  constructor(route, label, inner) {
    super()
    this.route = route
    this.label = typeof label === 'function' ? label : () => label
    this.inner = inner
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
    return (await this.inner.listModels(NATIVE_PROVIDER)).map(model => ({ ...model, provider: this.route }))
  }

  async resolveModel(provider, model, signal) {
    this.assertRoute(provider)
    return { ...await this.inner.resolveModel(NATIVE_PROVIDER, model, signal), provider: this.route }
  }

  async prepareCall(provider, model, signal) {
    this.assertRoute(provider)
    const prepared = await this.inner.prepareCall(NATIVE_PROVIDER, model, signal)
    return {
      model: { ...prepared.model, provider: this.route },
      stream: options => {
        this.assertRoute(options.provider)
        return accountStream(prepared.stream(nativeRequest(options, this.route)), this.route)
      },
    }
  }

  stream(options) {
    this.assertRoute(options.provider)
    return accountStream(this.inner.stream(nativeRequest(options, this.route)), this.route)
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
  providerFactory = openaiCodexProvider,
  adapterFactory = config => new PiAiAdapter(config),
}) {
  if (typeof route !== 'string' || !/^codex-sub-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) {
    throw new TypeError('Expected a stable codex-sub- account provider route')
  }
  if (typeof getCredential !== 'function') throw new TypeError('getCredential is required')
  const native = providerFactory()
  const codexOptions = (options = {}) => {
    // The Codex subscription endpoint rejects temperature (including the value
    // used by generic DSH auxiliary calls such as auto-review).
    const { temperature: _unsupported, ...supported } = options
    return supported
  }
  // A native OAuth-only provider ignores PiAiAdapter's apiKey override. Keep
  // native transport/models/OAuth intact and accept only the resolved token.
  const piProvider = {
    ...native,
    stream: (model, context, options) => native.stream(model, context, codexOptions(options)),
    streamSimple: (model, context, options) => native.streamSimple(model, context, codexOptions(options)),
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
  const profiles = new Map([[NATIVE_PROVIDER, {
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
  }]])
  const inner = adapterFactory({
    profiles: () => profiles,
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
  return new AccountAdapter(route, label, inner)
}
