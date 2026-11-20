import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createCodexUsage, parseCodexUsage, CODEX_USAGE_URL, CODEX_RESET_CARDS_URL, CODEX_CONSUME_RESET_CARD_URL } from '../src/codex-usage.js'

const id = `account-${'a'.repeat(32)}`, provider = `codex-sub-${'a'.repeat(32)}`
const weekly = { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2000000000 }, secondary_window: null } }
function fixture(fetch) {
  const row = { id, provider, label: 'Codex', suffix: 'demo', email: '' }
  let enabled = true
  let credential = { access: 'access', accountId: 'acct', expires: 2000000000 }
  const service = createCodexUsage({
    accounts: { list: async () => enabled ? [row] : [], read: async () => ({ credential }), withCredentialLock: async (_id, fn) => fn(credential) },
    getCredential: async () => ({ ...credential }), isEnabled: value => enabled && value === provider, fetch,
  })
  return { service, remove() { enabled = false; service.invalidate(provider) }, rotate() { credential = { ...credential, access: 'rotated' } } }
}

test('weekly-only quota is preserved and shared by the UI and the routing snapshot', async t => {
  let requests = 0
  const { service, remove } = fixture(async url => {
    assert.equal(url, CODEX_USAGE_URL)
    requests++
    return Response.json(weekly)
  })
  t.after(() => service.dispose())
  assert.equal(service.getQuota(provider), undefined)
  const [quota, ui] = await Promise.all([service.readQuota(provider), service.read({ provider })])
  assert.equal(requests, 1)
  assert.deepEqual(ui.rows[0].usage, quota)
  assert.deepEqual(service.getQuota(provider), quota)
  assert.deepEqual(parseCodexUsage(weekly).rateLimits[0].windows.map(window => window.windowSeconds), [604800])
  remove()
  assert.equal(service.getQuota(provider), undefined)
  assert.equal((await service.read({ provider })).signedOut, true)
})

test('reset cards remain manual, survive OAuth rotation and dedupe redemption', async t => {
  let release, started, posts = 0
  const dispatched = new Promise(resolve => { started = resolve })
  const { service, rotate } = fixture(async (url, options) => {
    if (url === CODEX_USAGE_URL) return Response.json(weekly)
    if (url === CODEX_RESET_CARDS_URL) return Response.json({ credits: [{ id: 'card-1', status: 'available', reset_type: 'codex_rate_limits' }] })
    assert.equal(url, CODEX_CONSUME_RESET_CARD_URL)
    assert.equal(options.headers.authorization, 'Bearer rotated')
    posts++
    started()
    return new Promise(resolve => { release = () => resolve(Response.json({ code: 'reset' })) })
  })
  t.after(() => service.dispose())
  await service.readQuota(provider)
  const cards = await service.listResetCards({ provider })
  assert.equal(posts, 0)
  rotate()
  const query = { provider, creditId: cards.cards[0].id, accountRevision: cards.accountRevision, requestId: randomUUID() }
  const controller = new AbortController()
  const first = service.useResetCard(query, controller.signal)
  await dispatched
  controller.abort()
  const second = service.useResetCard(query)
  assert.equal(first, second)
  assert.throws(() => service.useResetCard({ ...query, requestId: randomUUID() }), { code: 'usage/unavailable' })
  release()
  assert.deepEqual(await second, { code: 'reset' })
  assert.equal(posts, 1)
  assert.equal(service.getQuota(provider), undefined)
})
