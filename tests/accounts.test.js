import test from 'node:test'
import assert from 'node:assert/strict'
import { Accounts, routeOf, validateLabel } from '../src/accounts.js'
import { Subscriptions } from '../src/subscriptions.js'

const grant = (name, access = name) => ({ type: 'oauth', accountId: name, access, refresh: `refresh-${name}`, expires: Date.now() + 3600000 })
function fixture() {
  const records = new Map(), locks = new Map()
  const serialize = (key, fn) => {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    locks.set(key, next.catch(() => {}))
    return next
  }
  const credentials = {
    listRecords: async () => [...records].map(([key, value]) => ({ key, kind: value.kind })),
    readRecord: async key => structuredClone(records.get(key)),
    modifyRecord: (key, fn) => serialize(key, async () => {
      const next = await fn(structuredClone(records.get(key)))
      if (next !== undefined) records.set(key, structuredClone(next))
      return structuredClone(records.get(key))
    }),
    deleteRecord: key => serialize(key, () => { records.delete(key) }),
  }
  const accounts = new Accounts(credentials, id => `ours/${id}`, key => key.startsWith('ours/') ? key.slice(5) : undefined)
  return { accounts, credentials, records }
}
test('accounts have fixed independent routes; listing never leaks grants or other scope records', async () => {
  const { accounts, records } = fixture()
  records.set('other/account-00000000000000000000000000000000', { kind: 'grant', payload: 'unrelated' })
  const a = await accounts.add('Personal', grant('a')), b = await accounts.add('Work', grant('b'))
  assert.notEqual(a, b); assert.notEqual(routeOf(a), routeOf(b))
  assert.equal((await accounts.list()).length, 2)
  assert.equal(JSON.stringify(await accounts.list()).includes('refresh'), false)
  assert.equal((await accounts.store(a).read('openai-codex')).access, 'a')
  assert.equal((await accounts.store(b).read('openai-codex')).access, 'b')
  const before = routeOf(a)
  await accounts.rename(a, 'Renamed')
  assert.equal(routeOf(a), before)
  assert.equal((await accounts.read(a)).label, 'Renamed')
  await accounts.remove(a)
  assert.equal((await accounts.list()).length, 1)
  assert.equal(records.size, 2)
})
test('refreshes serialize on their own account record and cannot restore a deleted account', async () => {
  const { accounts } = fixture()
  const id = await accounts.add('A', grant('a', '0'))
  const store1 = accounts.store(id), store2 = accounts.store(id)
  const increment = store => store.modify('openai-codex', async credential => {
    await Promise.resolve()
    return { ...credential, access: String(Number(credential.access) + 1) }
  })
  await Promise.all([increment(store1), increment(store2)])
  assert.equal((await store1.read('openai-codex')).access, '2')
  const refresh = increment(store1)
  await accounts.remove(id)
  await refresh
  assert.equal(await store1.read('openai-codex'), undefined)
  await assert.rejects(increment(store1), /no longer exists/)
})
test('renewal preserves identity and current label; invalid inputs do not mutate records', async () => {
  const { accounts } = fixture()
  const id = await accounts.add('Original', grant('a'))
  await assert.rejects(accounts.renew(id, grant('b')), /original subscription/)
  await accounts.rename(id, 'Latest')
  await accounts.renew(id, grant('a', 'new'))
  assert.equal((await accounts.read(id)).label, 'Latest')
  assert.equal((await accounts.read(id)).credential.access, 'new')
  await assert.rejects(accounts.rename(id, ' '), /1–32/)
  await assert.rejects(accounts.remove('../other'), /Invalid/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(accounts.add('A', grant('a'), controller.signal))
  assert.equal((await accounts.list()).length, 1)
})
test('subscriptions register distinct adapters, refresh rename metadata, and dispose only removed route', async () => {
  const { accounts } = fixture()
  const a = await accounts.add('Personal', grant('a')), b = await accounts.add('Work', grant('b'))
  const registered = new Map(), replacements = []
  const llm = { registerAdapter(routes, adapter) {
    const route = routes[0]
    assert.equal(registered.has(route), false)
    registered.set(route, adapter)
    const dispose = () => registered.delete(route)
    dispose.replace = routes => replacements.push(routes)
    return dispose
  } }
  const subscriptions = new Subscriptions({ accounts, llm, adapterFactory: options => options,
    authFactory: store => ({ getAuth: async () => ({ auth: { apiKey: (await store.read('openai-codex')).access } }) }) })
  await subscriptions.sync()
  assert.equal(registered.size, 2)
  const adapterA = registered.get(routeOf(a)), adapterB = registered.get(routeOf(b))
  assert.notEqual(adapterA, adapterB)
  assert.equal((await adapterA.getCredential()).access, 'a')
  assert.equal((await adapterB.getCredential()).access, 'b')
  await subscriptions.manage({ action: 'rename', id: a, label: 'New-name' })
  assert.equal(adapterA.label(), 'Codex-New-name')
  assert.deepEqual(replacements, [[routeOf(a)]])
  await subscriptions.manage({ action: 'remove', id: a })
  assert.equal(registered.size, 1)
  assert.equal(registered.get(routeOf(b)), adapterB)
  const restarted = new Subscriptions({ accounts, llm: { registerAdapter: () => Object.assign(() => {}, { replace() {} }) }, adapterFactory: x => x, authFactory: () => ({}) })
  await restarted.sync()
  assert.equal(restarted.routes.size, 1)
  subscriptions.dispose(); restarted.dispose()
  assert.equal(registered.size, 0)
})

test('automatic suffixes persist across single/multiple display names and restarts', async () => {
  const { accounts, credentials } = fixture()
  const a = await accounts.add(undefined, grant('a'))
  const [single] = await accounts.list()
  assert.equal(single.label, 'Codex')
  assert.match(single.suffix, /^[a-z]{8}$/)
  const b = await accounts.add(undefined, grant('b'))
  const multiple = await accounts.list()
  assert.notEqual(multiple[0].suffix, multiple[1].suffix)
  const first = multiple.find(account => account.id === a)
  assert.equal(first.suffix, single.suffix)
  assert.equal(first.provider, single.provider)
  assert.equal(first.label, `Codex-${single.suffix}`)
  const restarted = new Accounts(credentials, accounts.keyOf, accounts.keyId)
  assert.deepEqual(await restarted.list(), multiple)
  await accounts.remove(b)
  assert.deepEqual(await accounts.list(), [single])
  assert.equal((await accounts.read(a)).version, 2)
})

test('suffix validation and duplicate checks apply to add/rename, including concurrent operations', async () => {
  const { accounts } = fixture()
  const a = await accounts.add('work', grant('a'))
  const b = await accounts.add('personal', grant('b'))
  for (const invalid of ['', ' ', 'work name', '-work', 'a'.repeat(33), 'codex', 'CODEX', 'codex-work', 'CODEX-work']) {
    assert.throws(() => validateLabel(invalid), /Suffix/)
    await assert.rejects(accounts.rename(a, invalid), /Suffix/)
  }
  assert.equal(validateLabel('Work_2-ok'), 'Work_2-ok')
  await assert.rejects(accounts.add('WORK', grant('c')), /already in use/)
  await assert.rejects(accounts.rename(b, 'WoRk'), /already in use/)
  await accounts.rename(a, 'WORK')
  const added = await Promise.allSettled([accounts.add('shared', grant('c')), accounts.add('SHARED', grant('d'))])
  assert.equal(added.filter(result => result.status === 'fulfilled').length, 1)
  const renamed = await Promise.allSettled([accounts.rename(a, 'same'), accounts.rename(b, 'SAME')])
  assert.equal(renamed.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await accounts.store(a).read('openai-codex')).access, 'a')
})

const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
test('v1 migration preserves names where possible, tokens and durable provider routes', async () => {
  const { accounts, records } = fixture()
  const legacy = ['Work', 'codex-team', 'codex', 'name with spaces']
  const ids = legacy.map((label, i) => {
    const id = `account-${String(i + 1).padStart(32, '0')}`
    records.set(`ours/${id}`, { kind: 'grant', payload: { version: 1, label,
      credential: grant(`legacy-${i}`, jwt({ email: `User${i}@Example.com` })) } })
    return id
  })
  const listed = await accounts.list()
  for (let i = 0; i < ids.length; i++) {
    const current = listed.find(account => account.id === ids[i])
    assert.equal(current.provider, routeOf(ids[i]))
    assert.equal(current.email, `user${i}@example.com`)
    if (i < 2) assert.equal(current.suffix, ['Work', 'team'][i])
    else assert.match(current.suffix, /^[a-z]{8}$/)
    const p = await accounts.read(ids[i])
    assert.equal(p.version, 2)
    assert.equal(p.credential.refresh, `refresh-legacy-${i}`)
    assert.equal(p.credential.access, jwt({ email: `User${i}@Example.com` }))
  }
  assert.deepEqual(await accounts.list(), listed)
})

test('migration resolves duplicate v1 suffixes and reserves later v2 suffixes without changing routes or grants', async () => {
  const { accounts, records } = fixture()
  const labels = ['Work', 'work', 'codex-TEAM', 'team']
  const ids = labels.map((label, i) => {
    const id = `account-${String(i + 10).padStart(32, '0')}`
    records.set(`ours/${id}`, { kind: 'grant', payload: { version: i === 3 ? 2 : 1, label,
      credential: { ...grant(`legacy-${i}`), email: `User${i}@Example.com` } } })
    return id
  })
  // Refresh and renewal must not prematurely migrate v1 outside list's naming
  // lock, where they would bypass duplicate resolution against other records.
  await accounts.store(ids[1]).modify('openai-codex', async credential => ({ ...credential, access: 'refreshed-secret' }))
  await accounts.renew(ids[2], grant('legacy-2', 'renewed-secret'))
  const listed = await accounts.list()
  assert.equal(new Set(listed.map(account => account.suffix.toLowerCase())).size, 4)
  assert.equal(listed.find(account => account.id === ids[0]).suffix, 'Work')
  assert.equal(listed.find(account => account.id === ids[3]).suffix, 'team')
  assert.match(listed.find(account => account.id === ids[1]).suffix, /^[a-z]{8}$/)
  assert.match(listed.find(account => account.id === ids[2]).suffix, /^[a-z]{8}$/)
  for (let i = 0; i < ids.length; i++) {
    const account = listed.find(account => account.id === ids[i])
    assert.equal(account.provider, routeOf(ids[i]))
    assert.equal(account.email, `user${i}@example.com`)
    const p = await accounts.read(ids[i])
    assert.equal(p.version, 2)
    assert.equal(p.credential.refresh, `refresh-legacy-${i}`)
    assert.equal(p.credential.access, i === 1 ? 'refreshed-secret' : i === 2 ? 'renewed-secret' : `legacy-${i}`)
  }
  assert.equal(JSON.stringify(listed).includes('secret'), false)
  assert.equal(JSON.stringify(listed).includes('refresh-legacy'), false)
  assert.deepEqual(await accounts.list(), listed)
})

test('list migrates the locked current v1 record rather than overwriting a newer refresh', async () => {
  const { accounts, credentials, records } = fixture()
  const id = `account-${'a'.repeat(32)}`
  records.set(`ours/${id}`, { kind: 'grant', payload: { version: 1, label: 'codex', credential: grant('a', 'old') } })
  const read = credentials.readRecord
  let injected = false
  credentials.readRecord = async key => {
    const stale = await read(key)
    if (!injected) {
      injected = true
      await credentials.modifyRecord(key, async current => ({ ...current,
        payload: { ...current.payload, credential: grant('a', 'fresh') } }))
    }
    return stale
  }
  await accounts.list()
  assert.equal((await accounts.read(id)).credential.access, 'fresh')
  assert.equal((await accounts.read(id)).credential.refresh, 'refresh-a')
  assert.equal((await accounts.read(id)).version, 2)
})

test('public account metadata contains no secrets; email survives refresh and renewal without email', async () => {
  const { accounts } = fixture()
  const access = jwt({ 'https://api.openai.com/profile': { email: ' User@Example.COM ' }, email: 'fallback@example.org' })
  const id = await accounts.add('work', { ...grant('a', access), email: 'credential@example.org' })
  let [account] = await accounts.list()
  assert.deepEqual(Object.keys(account).sort(), ['id', 'provider', 'label', 'suffix', 'email', 'authStatus', 'expiresAt'].sort())
  assert.equal(account.email, 'user@example.com')
  assert.equal(account.authStatus, 'valid')
  assert.equal(JSON.stringify(account).includes(access), false)
  assert.equal(JSON.stringify(account).includes('refresh-a'), false)
  await accounts.store(id).modify('openai-codex', async current => ({ ...current, access: 'opaque', email: undefined, expires: 0 }))
  ;[account] = await accounts.list()
  assert.equal(account.email, 'user@example.com')
  assert.equal(account.authStatus, 'refresh-needed')
  assert.equal((await accounts.read(id)).email, 'user@example.com')
  await accounts.renew(id, grant('a', 'renewed'))
  assert.equal((await accounts.list())[0].email, 'user@example.com')
  await accounts.store(id).modify('openai-codex', async current => ({ ...current, access: jwt({ email: 'next@example.net' }) }))
  assert.equal((await accounts.read(id)).email, 'next@example.net')
})

test('email extraction ignores malformed JWTs and invalid/unbounded email hints', async () => {
  for (const email of ['bad', 'a@@example.com', 'a b@example.com', 'a..b@example.com', `${'a'.repeat(250)}@example.com`]) {
    const { accounts } = fixture()
    await accounts.add(undefined, { ...grant('a', jwt({ email })), email })
    assert.equal((await accounts.list())[0].email, '')
  }
  const { accounts } = fixture()
  const id = await accounts.add(undefined, { ...grant('a', 'header.not-json.signature'), email: 'Fallback@Example.com' })
  assert.equal((await accounts.list())[0].email, 'fallback@example.com')
  assert.equal((await accounts.read(id)).email, 'fallback@example.com')
})
