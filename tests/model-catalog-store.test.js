import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { MODEL_CATALOG_DOMAIN, openModelCatalogStore } from '../src/model-catalog-store.js'

const entry = (savedAt = 1) => ({ savedAt, etag: '"models-v1"', rawCatalog: { models: [{ id: 'example', nested: [null, true, 1] }] } })
const keyOf = id => createHash('sha256').update(id).digest('hex')
function fixture() {
  const disk = new Map(), events = []
  let fail = false, release, blocked = false
  return {
    disk, events,
    failNext() { fail = true },
    blockNext() { blocked = true; return () => release() },
    facility: {
      async open(spec) {
        assert.equal(spec.name, 'codex_subscribe_model_catalog')
        assert.equal(spec.version, 1)
        assert.deepEqual(spec.tables, {})
        let value = structuredClone(disk.get(spec.name) ?? spec.global.initial)
        value = spec.global.schema.parse(value)
        let closed = false
        return {
          global: {
            get() { assert.equal(closed, false); return value },
            async set(next) {
              assert.equal(closed, false)
              events.push('set-start')
              if (blocked) { blocked = false; await new Promise(resolve => { release = resolve }) }
              if (fail) { fail = false; events.push('set-fail'); throw new Error('storage unavailable') }
              spec.global.schema.parse(next)
              disk.set(spec.name, structuredClone(next))
              value = next
              events.push('set-end')
            },
          },
          async close() { assert.equal(closed, false); closed = true; events.push('close') },
        }
      },
    },
  }
}

test('domain schema uses valid global JSON and hashes actual OAuth IDs across restart', async () => {
  const f = fixture()
  let store = await openModelCatalogStore(f.facility)
  const account = 'actual-oauth-subject-not-provider-route'
  assert.equal(store.read(account), undefined)
  await store.write(account, entry())
  const persisted = f.disk.get(MODEL_CATALOG_DOMAIN.name)
  assert.deepEqual(Object.keys(persisted.entries), [keyOf(account)])
  assert.equal(JSON.stringify(persisted).includes(account), false)
  assert.equal(JSON.stringify(persisted).includes('token'), false)
  assert.equal(MODEL_CATALOG_DOMAIN.global.schema.safeParse(JSON.parse(JSON.stringify(persisted))).success, true)
  await store.close()
  store = await openModelCatalogStore(f.facility)
  assert.deepEqual(store.read(account), entry())
  assert.equal(store.read('different-oauth-account'), undefined)
  await store.close()
})

test('read and queued write isolate nested mutations', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  const input = entry()
  const pending = store.write('a', input)
  input.rawCatalog.models[0].id = 'tampered'
  await pending
  const output = store.read('a')
  output.rawCatalog.models[0].nested.push('tampered')
  assert.deepEqual(store.read('a'), entry())
  await store.close()
})

test('read-modify-write is serialized for concurrent accounts and removals', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.write(`account-${i}`, entry(i))))
  assert.equal(Object.keys(f.disk.get(MODEL_CATALOG_DOMAIN.name).entries).length, 20)
  await Promise.all([store.write('keep', entry()), store.remove('account-1'), store.retain(['keep', 'account-2'])])
  assert.deepEqual(Object.keys(f.disk.get(MODEL_CATALOG_DOMAIN.name).entries).sort(), ['keep', 'account-2'].map(keyOf).sort())
  await store.remove('not-present')
  await store.retain([])
  assert.deepEqual(Object.keys(f.disk.get(MODEL_CATALOG_DOMAIN.name).entries), [])
  await store.close()
})

test('known persistence failure does not change reads or poison subsequent operations', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  await store.write('a', entry(1))
  f.failNext()
  const failed = store.write('a', entry(2))
  const next = store.write('b', entry(3))
  await assert.rejects(failed, /storage unavailable/)
  await next
  assert.equal(store.read('a').savedAt, 1)
  assert.equal(store.read('b').savedAt, 3)
  f.failNext()
  await assert.rejects(store.remove('a'), /storage unavailable/)
  assert.equal(store.read('a').savedAt, 1)
  await store.remove('a')
  assert.equal(store.read('a'), undefined)
  await store.close()
})

test('close drains queued writes, shares teardown and rejects all later access', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  const unblock = f.blockNext()
  const write = store.write('a', entry())
  await Promise.resolve()
  const close = store.close()
  assert.equal(store.close(), close)
  assert.equal(f.events.includes('close'), false)
  assert.throws(() => store.read('a'), /closed/)
  await assert.rejects(store.write('b', entry()), /closed/)
  await assert.rejects(store.remove('a'), /closed/)
  await assert.rejects(store.retain([]), /closed/)
  unblock()
  await write
  await close
  assert.deepEqual(f.events, ['set-start', 'set-end', 'close'])
})

test('close still closes domain after failed writes', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  f.failNext()
  const failed = store.write('a', entry())
  const close = store.close()
  await assert.rejects(failed, /storage unavailable/)
  await close
  assert.equal(f.events.at(-1), 'close')
})

test('invalid identities and entries never persist or destructively prune', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  await store.write('a', entry())
  const invalid = [null, [], { ...entry(), savedAt: NaN }, { ...entry(), savedAt: -1 },
    { ...entry(), token: 'never-store' }, { ...entry(), rawCatalog: new Date() },
    { ...entry(), rawCatalog: { bad: undefined } }, { ...entry(), rawCatalog: { bad: Infinity } },
    { ...entry(), rawCatalog: { bad: 1n } }, { ...entry(), rawCatalog: { huge: 'é'.repeat(2 * 1024 * 1024) } }]
  const cycle = {}; cycle.self = cycle
  invalid.push({ ...entry(), rawCatalog: cycle })
  for (const value of invalid) await assert.rejects(store.write('a', value))
  for (const id of ['', '  ', null, 1]) {
    await assert.rejects(store.write(id, entry()))
    await assert.rejects(store.remove(id))
    assert.throws(() => store.read(id))
  }
  await assert.rejects(store.retain(['a', null]))
  await assert.rejects(store.retain(new Set(['a'])))
  assert.deepEqual(store.read('a'), entry())
  assert.equal(f.events.filter(value => value === 'set-end').length, 1)
  await store.close()
})

test('global schema safely rejects malformed persisted cache', async () => {
  const f = fixture()
  f.disk.set(MODEL_CATALOG_DOMAIN.name, { entries: { [keyOf('a')]: { ...entry(), rawCatalog: [] } } })
  await assert.rejects(openModelCatalogStore(f.facility))
  assert.equal(MODEL_CATALOG_DOMAIN.global.schema.safeParse({ entries: { 'plain-account-id': entry() } }).success, false)
  assert.equal(MODEL_CATALOG_DOMAIN.global.schema.safeParse(null).success, false)
})

test('read skips corrupt entries from a non-validating domain and maintenance drops them', async () => {
  let value = { entries: { [keyOf('bad')]: { ...entry(), savedAt: 'corrupt' }, [keyOf('good')]: entry(), 'plaintext-id': entry() } }
  const store = await openModelCatalogStore({ async open() {
    return { global: { get: () => value, set: async next => { value = next } }, close: async () => {} }
  } })
  assert.equal(store.read('bad'), undefined)
  assert.deepEqual(store.read('good'), entry())
  await store.remove('absent')
  assert.deepEqual(Object.keys(value.entries), [keyOf('good')])
  await store.close()
})

test('account count is bounded by oldest savedAt eviction and retain persists', async () => {
  const f = fixture(), store = await openModelCatalogStore(f.facility)
  for (let i = 0; i < 70; i++) await store.write(`a${i}`, entry(i))
  assert.equal(Object.keys(f.disk.get(MODEL_CATALOG_DOMAIN.name).entries).length, 64)
  assert.equal(store.read('a0'), undefined)
  assert.deepEqual(store.read('a69'), entry(69))
  await store.retain(['a69'])
  await store.close()
  const restored = await openModelCatalogStore(f.facility)
  assert.equal(restored.read('a68'), undefined)
  assert.deepEqual(restored.read('a69'), entry(69))
  await restored.close()
})
