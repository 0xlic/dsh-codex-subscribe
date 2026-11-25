import test from 'node:test'
import assert from 'node:assert/strict'
import { WebError } from '@deepseek-ai/dsh-web'
import { CODEX_SEARCH_URL, searchCodexLive } from '../src/codex-search.js'

const input = Object.freeze({
  query: '  live café results?  ',
  model: 'active-codex-model',
  sessionId: 'session-exact',
  credential: Object.freeze({ access: 'example-access-token', accountId: 'exact-oauth-account' }),
})
const invoke = (fetchSearch, options) => searchCodexLive({ ...input, ...options, fetchSearch })
const errorIs = (code, message) => error => {
  assert.ok(error instanceof WebError)
  assert.equal(error.code, code)
  assert.equal(error.message, message)
  assert.equal(error.cause, undefined)
  return true
}

const providerError = 'WEB_PROVIDER_ERROR'
const aborted = errorIs('WEB_ABORTED', 'Codex search aborted')
const unreadable = errorIs(providerError, 'Codex returned an unreadable search response')
const tooLarge = errorIs(providerError, 'Codex search response exceeds 1 MiB')

test('Codex live search makes one redirect-prohibited POST with the exact OAuth account, active model and session', async () => {
  const { signal } = new AbortController()
  const calls = []
  const result = await invoke(async (...args) => {
    calls.push(args)
    return Response.json({ results: [] })
  }, { signal })
  assert.deepEqual(result, { sources: [], truncated: false })
  assert.equal(calls.length, 1)
  assert.equal(CODEX_SEARCH_URL, 'https://chatgpt.com/backend-api/codex/alpha/search')
  const [[url, init]] = calls
  assert.equal(url, CODEX_SEARCH_URL)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  assert.equal(init.signal, signal)
  const headers = new Headers(init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${input.credential.access}`)
  assert.equal(headers.get('chatgpt-account-id'), input.credential.accountId)
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(headers.get('accept'), 'application/json')
  assert.equal(headers.get('originator'), 'pi')
  assert.match(headers.get('user-agent'), /^dsh-codex-subscribe\//)
  assert.deepEqual(JSON.parse(init.body), {
    id: input.sessionId,
    model: input.model,
    input: input.query,
    commands: { search_query: [{ q: input.query }], response_length: 'short' },
    settings: { allowed_callers: ['direct'], external_web_access: true },
    max_output_tokens: 4096,
  })
})

test('Codex live search normalizes safe citations and deduplicates by canonical document URL', async () => {
  const response = Response.json({
    summary: 'not the citation result',
    results: [
      { url: ' HTTPS://EXAMPLE.ORG:443/a/../news#lead ', title: '  Main\n story ', snippet: ' first\t line  ', published_at: ' 2026-10-01 ', publishedAt: 'ignored' },
      { url: 'https://example.org/news#duplicate', title: 'dropped' },
      { url: 'http://EXAMPLE.COM:80', published_at: ' ', publishedAt: 'X'.repeat(128), snippet: ' ' },
      { url: 'https://example.org/news?q=fresh', title: 42 },
      { url: 'https://user:pass@example.org' }, { url: 'https://@example.org' },
      { url: 'ftp://example.org' }, { url: 'javascript:alert(1)' }, { url: '//example.org' },
      { url: 'https:example.org' }, { url: 'https:///example.org' }, { url: 'https://example.org:65536' },
      { url: 'https://examp\nle.org' }, { url: 'https://examp le.org' }, { url: 'https://\\example.org' },
      null, {}, { url: 123 },
    ],
  })
  assert.deepEqual(await invoke(async () => response), {
    sources: [
      { url: 'https://example.org/news#lead', title: 'Main story', snippet: 'first line', publishedAt: '2026-10-01' },
      { url: 'http://example.com/', title: 'example.com', publishedAt: `${'X'.repeat(63)}…` },
      { url: 'https://example.org/news?q=fresh', title: 'example.org' },
    ],
    truncated: false,
  })
})

test('Codex live search rejects missing or unsafe inputs before any dispatch', async () => {
  const noFetch = () => assert.fail('must not dispatch')
  const missing = errorIs('WEB_PROVIDER_CREDENTIAL_MISSING', 'Codex search requires a signed-in subscription account')
  for (const credential of [undefined, {}, { access: 'valid' }, { ...input.credential, access: 'bad\r\nheader' }, { ...input.credential, accountId: 'account\n' }]) {
    await assert.rejects(invoke(noFetch, { credential }), missing)
  }
  for (const options of [{ model: '' }, { sessionId: undefined }, { query: ' ' }]) {
    await assert.rejects(invoke(noFetch, options), errorIs(providerError, 'Codex search requires a query, active model, and session ID'))
  }
  const controller = new AbortController()
  controller.abort(new Error('private abort reason'))
  await assert.rejects(invoke(noFetch, { signal: controller.signal, credential: undefined }), aborted)
})

test('Codex live search never retries or exposes error details after dispatch', async () => {
  for (const status of [302, 401, 403, 429, 503]) {
    let calls = 0
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    await assert.rejects(invoke(async () => {
      calls++
      return new Response(body, { status, headers: { location: 'https://other.invalid/private', 'x-request-id': 'private' } })
    }), errorIs(providerError, `Codex search request failed (HTTP ${status})`))
    assert.equal(calls, 1)
    assert.equal(cancelled, true)
  }
  const unknownFailure = errorIs(providerError, 'Codex search request failed')
  let calls = 0
  await assert.rejects(invoke(async () => {
    calls++
    throw new Error(`private fetch detail: ${input.query} ${input.credential.access}`)
  }), unknownFailure)
  assert.equal(calls, 1)
  const redirected = Response.json({ results: [] })
  Object.defineProperty(redirected, 'redirected', { value: true })
  await assert.rejects(invoke(async () => redirected), unknownFailure)
  assert.equal(redirected.bodyUsed, true)
})

test('Codex live search rejects unreadable JSON and wrong response shape with sanitized WebErrors', async () => {
  for (const body of ['{"private":"never echoed"', null, new Uint8Array([0xff])]) {
    await assert.rejects(invoke(async () => new Response(body)), unreadable)
  }
  for (const payload of [{ results: {} }, {}, [], null]) {
    await assert.rejects(invoke(async () => Response.json(payload)), errorIs(providerError, 'Codex returned a malformed search response'))
  }
})

test('Codex live search allows exactly 1 MiB but cancels oversized responses, even with a smaller declared length', async () => {
  const limit = 1024 * 1024
  const json = '{"results":[]}'
  const atLimit = json.padEnd(limit)
  assert.deepEqual(await invoke(async () => new Response(atLimit, { headers: { 'content-length': limit } })), { sources: [], truncated: false })

  for (const declared of [1, limit + 1]) {
    let cancelled = false
    let queued = 0
    const body = new ReadableStream({
      pull(controller) {
        queued++
        controller.enqueue(new Uint8Array(queued === 1 ? limit : 1).fill(32))
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    await assert.rejects(invoke(async () => new Response(body, { headers: { 'content-length': declared } })), tooLarge)
    assert.equal(cancelled, true)
    assert.equal(queued, declared > limit ? 0 : 2)
  }
})

test('Codex live search can abort an outstanding request and releases a late response', async () => {
  const controller = new AbortController()
  let release, markDispatched, markCancelled
  const dispatched = new Promise(resolve => { markDispatched = resolve })
  const cancelled = new Promise(resolve => { markCancelled = resolve })
  const pending = invoke((_url, init) => {
    assert.equal(init.signal, controller.signal)
    markDispatched()
    return new Promise(resolve => { release = resolve })
  }, { signal: controller.signal })
  await dispatched
  controller.abort(new Error('private abort reason'))
  await assert.rejects(pending, aborted)
  release(new Response(new ReadableStream({ cancel() { markCancelled() } })))
  await cancelled
})

test('Codex live search aborts a pending body read and cancels its stream', async () => {
  const controller = new AbortController()
  let markReading, cancelled = false
  const reading = new Promise(resolve => { markReading = resolve })
  const body = new ReadableStream({
    pull() { markReading() },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const pending = invoke(async () => new Response(body), { signal: controller.signal })
  await reading
  controller.abort('private abort reason')
  await assert.rejects(pending, aborted)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})
