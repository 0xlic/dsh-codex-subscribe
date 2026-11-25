import { WebError } from '@deepseek-ai/dsh-web'
import { searchCodexLive } from './codex-search.js'
import { UserError } from './accounts.js'

const CODEX_ROUTE = /^codex-sub-([a-f0-9]{32})$/u
const accountOf = route => typeof route === 'string' ? CODEX_ROUTE.exec(route)?.[1] : undefined
const valid = value => typeof value === 'string' && value.trim() !== ''

function checkAbort(signal) {
  if (signal?.aborted) throw new WebError('Web search was cancelled', 'WEB_ABORTED')
}

export function createCodexSearchPreference({ web, subscriptions, accounts, getInitiator, isActive = () => true, searchLive = searchCodexLive }) {
  function checkActive(signal) {
    checkAbort(signal)
    if (!isActive()) throw new WebError('Codex Live search is disabled', 'WEB_PROVIDER_UNAVAILABLE')
  }
  const entryFor = route => {
    const suffix = accountOf(route)
    return suffix === undefined ? undefined : subscriptions.routes.get(`account-${suffix}`)
  }
  // Only for the Codex pre-dispatch fallback. Never route a DeepSeek request
  // ourselves, nor opt into the per-call Search API as a hidden fallback.
  async function readyDsh(route) {
    const provider = web.searchProviders?.get?.('deepseek-official')
    if (provider?.available() !== true) return undefined
    return (await provider.ready?.(route) ?? true) ? provider : undefined
  }
  async function credentialExists(entry) {
    if (!entry) return false
    try { return valid((await accounts.read(entry.id)).credential.accountId) }
    catch { return false }
  }
  return {
    id: 'codex-subscribe-live',
    available: () => true,
    async ready(route) { return isActive() && (await credentialExists(entryFor(route)) || !!(await readyDsh(route))) },
    async search(request, signal) {
      checkActive(signal)
      const route = request.llmProvider
      const entry = entryFor(route)
      const session = getInitiator()?.session
      const context = session?.requestContext?.()
      let credential
      if (context && context.provider === route && valid(context.model) && valid(session.id) && await credentialExists(entry)) {
        checkActive(signal)
        try { credential = await subscriptions.usageCredential(entry.id, signal) }
        catch (error) {
          checkActive(signal)
          if (!(error instanceof UserError)) throw new WebError('Codex search could not authenticate the selected subscription', 'WEB_PROVIDER_ERROR')
        }
      }
      checkActive(signal)
      if (valid(credential?.access) && valid(credential.accountId) && entryFor(route) === entry) {
        // Once a request is sent, neither another account nor DSH retries it.
        return searchLive({ query: request.query, model: context.model, sessionId: session.id, credential, signal })
      }
      const dsh = await readyDsh(route)
      checkActive(signal)
      if (dsh) return dsh.search(request, signal)
      throw new WebError('Codex Live needs a signed-in subscription and an initiating model request; DSH server-side search is not ready', 'WEB_PROVIDER_UNAVAILABLE')
    },
  }
}

function searchSelector(web) {
  if (!web || typeof web.config?.searchProvider?.get !== 'function'
    || !('searchProviderEnv' in web) || !(web.searchProviders instanceof Map)) return undefined
  const previous = Object.getOwnPropertyDescriptor(web, 'selectSearchProvider')
  const prototype = Object.getPrototypeOf(web)
  const original = (previous ?? (prototype && Object.getOwnPropertyDescriptor(prototype, 'selectSearchProvider')))?.value
  // Older 0.2.2 builds select with no model-route argument. Leave them native.
  if (typeof original !== 'function' || original.length !== 1 || previous?.configurable === false || (!previous && !Object.isExtensible(web))) return undefined
  return { previous, original }
}

/**
 * DSH 0.2.2 has no public per-route preference hook. Interpose only selection
 * for this bundle's routes in Automatic, preserving the original receiver and
 * forwarding every explicit selection and other route to DSH unchanged. Do
 * not put Codex in the registry: it would affect DSH's sole-provider fallback.
 */
export function installCodexSearchPreference(web, provider, enabled = () => true) {
  const selector = searchSelector(web)
  if (!selector) return undefined
  const { previous, original } = selector
  function select(route) {
    if (accountOf(route) === undefined || !enabled() || (this.config.searchProvider.get() ?? this.searchProviderEnv) !== undefined) {
      return Reflect.apply(original, this, arguments)
    }
    return provider
  }
  try {
    Object.defineProperty(web, 'selectSearchProvider', { value: select, configurable: true, writable: true })
  } catch { return undefined }
  return () => {
    if (Object.getOwnPropertyDescriptor(web, 'selectSearchProvider')?.value !== select) return
    if (previous) Object.defineProperty(web, 'selectSearchProvider', previous)
    else Reflect.deleteProperty(web, 'selectSearchProvider')
  }
}
