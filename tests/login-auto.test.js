import test from 'node:test'
import assert from 'node:assert/strict'
import { Login } from '../src/login.js'

test('new account sign-in does not require a user-supplied name; suffix allocation stays in the account store', async () => {
  let added, changed = false
  const login = new Login({
    providerFactory: () => ({}),
    createModels: ({ credentials }) => ({ setProvider() {}, async login() {
      await credentials.modify('openai-codex', async () => ({ type: 'oauth', accountId: 'a', access: 'synthetic', refresh: 'synthetic', expires: 9999999999999 }))
    } }),
    accounts: { async add(label, credential) { added = { label, credential }; return 'account-00000000000000000000000000000000' } },
    changed: async () => { changed = true },
  })
  const initial = login.start({ method: 'browser' })
  await login.session.run
  assert.equal(login.read(initial.id).phase, 'authenticated')
  assert.equal(added.label, undefined)
  assert.equal(added.credential.type, 'oauth')
  assert.equal(changed, true)
})
