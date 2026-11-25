import { WebError } from '@deepseek-ai/dsh-web'
import manifest from '../package.json' with { type: 'json' }

// Endpoint and wire format reference: WSL043/dsh-codex-subscription (MIT),
// https://github.com/WSL043/dsh-codex-subscription/blob/348b6ede5e4c814d98880463a7cb65341ac6abdb/src/codex-search.js
export const CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'

const MAX_RESPONSE_BYTES = 1024 * 1024
const aborted = () => new WebError('Codex search aborted', 'WEB_ABORTED')
const failed = message => new WebError(message, 'WEB_PROVIDER_ERROR')
const present = value => typeof value === 'string' && value.trim().length > 0
const credentialField = value => typeof value === 'string' && value.length > 0 && !/[^!-~]/.test(value)

function discard(stream) {
  try { void stream?.cancel().catch(() => {}) } catch { /* cleanup must not replace the public error */ }
}

async function dispatch(fetchSearch, init) {
  const { signal } = init
  let onAbort
  try {
    const cancellation = signal && new Promise((_, reject) => {
      onAbort = () => reject(aborted())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const request = Promise.resolve().then(() => {
      if (signal?.aborted) throw aborted()
      return fetchSearch(CODEX_SEARCH_URL, init)
    }).then(response => {
      if (signal?.aborted) discard(response?.body)
      return response
    })
    return await (cancellation ? Promise.race([request, cancellation]) : request)
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw aborted()
    throw failed('Codex search request failed')
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function readSearchResponse(response, signal) {
  const body = response?.body
  if (signal?.aborted) {
    discard(body)
    throw aborted()
  }
  if (response?.redirected || !response?.ok) {
    discard(body)
    const status = response?.status
    // Even an authentication rejection is terminal once the request was sent.
    throw failed(!response?.redirected && Number.isInteger(status) && status >= 300 && status <= 599
      ? `Codex search request failed (HTTP ${status})`
      : 'Codex search request failed')
  }
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) {
    discard(body)
    throw failed('Codex search response exceeds 1 MiB')
  }
  if (!body) throw failed('Codex returned an unreadable search response')

  let reader
  let tooLarge = false
  const stop = () => discard(reader)
  try {
    reader = body.getReader()
    signal?.addEventListener('abort', stop, { once: true })
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    while (!signal?.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        tooLarge = true
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    if (!signal?.aborted && !tooLarge) return JSON.parse(text + decoder.decode())
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw aborted()
    throw failed('Codex returned an unreadable search response')
  } finally {
    signal?.removeEventListener('abort', stop)
    discard(reader)
    reader?.releaseLock()
  }
  if (signal?.aborted) throw aborted()
  throw failed('Codex search response exceeds 1 MiB')
}

function sourceUrl(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const authority = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1]
  if (!authority || authority.includes('@') || /[\x00-\x20\x7f\\]/.test(text)) return undefined
  try {
    const url = new URL(text)
    if (!url.username && !url.password) return url
  } catch { /* skip invalid entries */ }
}

function displayText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() || undefined : undefined
}

function normalizeSources(payload) {
  if (!Array.isArray(payload?.results)) throw failed('Codex returned a malformed search response')
  const sources = new Map()
  for (const result of payload.results) {
    const url = sourceUrl(result?.url)
    if (!url) continue
    const href = url.href
    url.hash = '' // Fragments in citations can be useful, but identify the same document.
    if (sources.has(url.href)) continue
    const source = { url: href, title: displayText(result.title) ?? url.hostname }
    const snippet = displayText(result.snippet)
    if (snippet !== undefined) source.snippet = snippet
    const date = displayText(result.published_at) ?? displayText(result.publishedAt)
    if (date !== undefined) source.publishedAt = date.length > 64 ? `${date.slice(0, 63)}…` : date
    sources.set(url.href, source)
  }
  return { sources: [...sources.values()], truncated: false }
}

export async function searchCodexLive({ query, model, sessionId, credential, signal, fetchSearch = fetch }) {
  if (signal?.aborted) throw aborted()
  const { access, accountId } = credential ?? {}
  if (!credentialField(access) || !credentialField(accountId)) {
    throw new WebError('Codex search requires a signed-in subscription account', 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
  if (![query, model, sessionId].every(present)) throw failed('Codex search requires a query, active model, and session ID')
  const response = await dispatch(fetchSearch, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      authorization: `Bearer ${access}`,
      'chatgpt-account-id': accountId,
      accept: 'application/json',
      'content-type': 'application/json',
      originator: 'pi',
      'user-agent': `dsh-codex-subscribe/${manifest.version}`,
    },
    body: JSON.stringify({
      id: sessionId,
      model,
      input: query,
      commands: { search_query: [{ q: query }], response_length: 'short' },
      settings: { allowed_callers: ['direct'], external_web_access: true },
      max_output_tokens: 4096,
    }),
  })
  const payload = await readSearchResponse(response, signal)
  if (signal?.aborted) throw aborted()
  return normalizeSources(payload)
}
