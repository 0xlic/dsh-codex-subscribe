import test from 'node:test'
import assert from 'node:assert/strict'
import { Login, authUrl } from '../src/login.js'
import { UserError } from '../src/accounts.js'

const id = `account-${'a'.repeat(32)}`
const grant = { type: 'oauth', access: 'SECRET-ACCESS', refresh: 'SECRET-REFRESH', expires: 123456, accountId: 'account-one' }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(run, overrides = {}) {
  const saves = []
  let changed = 0
  const accounts = {
    read: async () => ({ credential: grant }),
    add: async (label, credential, signal) => { signal.throwIfAborted(); saves.push({ label, credential }); return id },
    renew: async (key, credential, signal) => { signal.throwIfAborted(); saves.push({ key, credential }) },
    ...overrides.accounts,
  }
  const login = new Login({
    accounts,
    providerFactory: () => ({ id: 'openai-codex' }),
    changed: async () => { changed++ },
    createModels: ({ credentials, authContext }) => ({
      setProvider: provider => assert.equal(provider.id, 'openai-codex'),
      login: async (provider, method, interaction) => {
        assert.equal(provider, 'openai-codex')
        assert.equal(method, 'oauth')
        assert.equal(await authContext.env('OPENAI_API_KEY'), undefined)
        const result = await run(interaction)
        if (result) await credentials.modify(provider, async () => result)
      },
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'accounts')),
  })
  return { login, saves, get changed() { return changed } }
}

function publicWithoutSecrets(value) {
  const text = JSON.stringify(value)
  assert.ok(!text.includes('SECRET-ACCESS'))
  assert.ok(!text.includes('SECRET-REFRESH'))
  assert.ok(!text.includes('SECRET-NETWORK'))
}

test('cancelled old completion cannot save credentials or overwrite a newer attempt', async () => {
  const gates = [deferred(), deferred()]
  const entered = [deferred(), deferred()]
  let n = 0
  const f = fixture(async interaction => {
    const index = n++
    entered[index].resolve()
    await gates[index].promise // deliberately ignore AbortSignal, simulating a late SDK completion
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?late=1' })
    return grant
  })
  const old = f.login.start({ label: 'Old', method: 'browser' })
  const oldRun = f.login.session.run
  await entered[0].promise
  assert.equal(f.login.cancel(old.id).phase, 'cancelled')
  const current = f.login.start({ label: 'New', method: 'browser' })
  await entered[1].promise
  gates[0].resolve()
  await oldRun
  assert.equal(f.saves.length, 0)
  assert.equal(f.login.read(current.id).phase, 'starting')
  assert.throws(() => f.login.read(old.id), UserError)
  gates[1].resolve()
  await f.login.session.run
  assert.equal(f.login.read(current.id).phase, 'authenticated')
  assert.equal(f.saves.length, 1)
  assert.equal(f.saves[0].label, 'New')
  assert.equal(f.changed, 1)
  publicWithoutSecrets(f.login.read(current.id))
})

test('cancellation before the queued start prevents SDK initialization entirely', async () => {
  let initialized = false
  const f = fixture(async () => grant, { createModels: () => { initialized = true; throw new Error('must not run') } })
  const view = f.login.start({ label: 'Account', method: 'browser' })
  f.login.cancel(view.id)
  await f.login.session.run
  assert.equal(initialized, false)
  assert.equal(f.login.read(view.id).phase, 'cancelled')
  assert.equal(f.saves.length, 0)
})

test('renewal rejected for a different account fails without adding a new route', async () => {
  const f = fixture(async () => ({ ...grant, accountId: 'wrong-account' }), { accounts: {
    renew: async () => { throw new UserError('Sign in with the original subscription account') },
  } })
  const view = f.login.start({ renewId: id, method: 'device_code' })
  await f.login.session.run
  const result = f.login.read(view.id)
  assert.equal(result.phase, 'failed')
  assert.equal(result.error, 'Sign in with the original subscription account')
  assert.equal(f.saves.length, 0)
  assert.equal(f.changed, 0)
  publicWithoutSecrets(result)
})

test('an SDK prompt AbortSignal rejects the prompt and removes its answer callback', async () => {
  const started = deferred()
  const promptController = new AbortController()
  const f = fixture(async interaction => {
    const answer = interaction.prompt({ type: 'manual_code', message: 'Paste callback', signal: promptController.signal })
    started.resolve()
    await answer
    return grant
  })
  const view = f.login.start({ label: 'Account', method: 'browser' })
  await started.promise
  assert.equal(f.login.read(view.id).phase, 'waiting_input')
  promptController.abort()
  await f.login.session.run
  assert.equal(f.login.session.answer, undefined)
  assert.equal(f.login.read(view.id).phase, 'failed')
  assert.throws(() => f.login.submit(view.id, 'SECRET-ACCESS'), UserError)
  assert.equal(f.saves.length, 0)
})

test('cancel releases a pending prompt and clears the public URL/code', async () => {
  const started = deferred()
  const f = fixture(async interaction => {
    interaction.notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' })
    const answer = interaction.prompt({ type: 'manual_code', message: 'Paste callback' })
    started.resolve()
    await answer
    return grant
  })
  const view = f.login.start({ label: 'Account', method: 'device_code' })
  await started.promise
  const result = f.login.cancel(view.id)
  await f.login.session.run
  assert.deepEqual(result, { id: view.id, phase: 'cancelled' })
  assert.equal(f.login.session.answer, undefined)
  assert.equal(f.saves.length, 0)
})

test('select and submit complete sign-in without persisting prompt input in views', async () => {
  const started = deferred()
  const f = fixture(async interaction => {
    assert.equal(await interaction.prompt({ type: 'select', options: [{ id: 'browser' }, { id: 'device_code' }] }), 'device_code')
    const answer = interaction.prompt({ type: 'secret', message: 'Response' })
    started.resolve()
    assert.equal(await answer, 'SECRET-ACCESS')
    return grant
  })
  const view = f.login.start({ label: 'Account', method: 'device_code' })
  await started.promise
  publicWithoutSecrets(f.login.submit(view.id, '  SECRET-ACCESS  '))
  await f.login.session.run
  const result = f.login.read(view.id)
  assert.equal(result.phase, 'authenticated')
  assert.equal(result.prompt, undefined)
  publicWithoutSecrets(result)
})

test('SDK errors and initialization errors are sanitized and allow the next attempt', async () => {
  for (const where of ['login', 'createModels', 'providerFactory']) {
    const raw = new Error('SECRET-NETWORK SECRET-ACCESS SECRET-REFRESH')
    const options = where === 'login' ? {} : { [where]: () => { throw raw } }
    const f = fixture(async () => { throw raw }, options)
    const view = f.login.start({ label: 'Account', method: 'browser' })
    await f.login.session.run
    const result = f.login.read(view.id)
    assert.equal(result.phase, 'failed', where)
    publicWithoutSecrets(result)
    assert.doesNotThrow(() => f.login.start({ label: 'Retry', method: 'browser' }))
    await f.login.session.run
  }
})

test('overlapping starts reject without replacing the active attempt', async () => {
  const gate = deferred()
  const f = fixture(async () => { await gate.promise; return grant })
  const view = f.login.start({ label: 'First', method: 'browser' })
  const run = f.login.session.run
  assert.throws(() => f.login.start({ label: 'Second', method: 'browser' }), /already running/)
  assert.equal(f.login.session.view.id, view.id)
  f.login.cancel(view.id)
  gate.resolve()
  await run
})

test('auth URL permits only exact HTTPS OpenAI/ChatGPT hosts with no userinfo or nondefault port', () => {
  for (const url of ['https://auth.openai.com/oauth/authorize?state=x', 'https://chatgpt.com/codex/device']) {
    assert.equal(authUrl(url), url)
  }
  for (const url of [
    'javascript:alert(1)', 'data:text/html,test', 'http://auth.openai.com/oauth/authorize',
    'https://auth.openai.com.evil.test/', 'https://evil.test/auth.openai.com',
    'https://user:password@auth.openai.com/', 'https://auth.openai.com:444/',
    'https://auth.openai.com./', '//auth.openai.com/', 'not a URL',
  ]) assert.throws(() => authUrl(url), UserError, url)
})

test('an unsafe SDK sign-in URL is rejected before it can enter the public view', async () => {
  const f = fixture(async interaction => {
    interaction.notify({ type: 'auth_url', url: 'https://evil.test/?SECRET-ACCESS' })
    return grant
  })
  const view = f.login.start({ label: 'Account', method: 'browser' })
  await f.login.session.run
  const result = f.login.read(view.id)
  assert.equal(result.phase, 'failed')
  assert.equal(result.authUrl, undefined)
  publicWithoutSecrets(result)
  assert.equal(f.saves.length, 0)
})
