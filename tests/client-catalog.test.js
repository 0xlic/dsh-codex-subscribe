import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
const text = tree => tree && typeof tree === 'object' ? tree.children.map(text).join('') : String(tree ?? '')
const flush = () => new Promise(resolve => setImmediate(resolve))
const baseAccount = { id: 'account-one', label: 'codex-one', suffix: 'one', email: 'one@example.test', expiresAt: 0,
  modelCatalog: { source: 'builtin', refresh: 'idle', count: 12 } }

// Actual Client module with component-local Hook state, effect cleanup and RPC.
// This is an offline behavior test, not a browser layout/accessibility audit.
function fixture({ language = 'en', account = baseAccount, handler } = {}) {
  let definition, Section, dictionaries, current
  const calls = [], runners = [], listeners = new Map()
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }),
    Fragment: 'fragment', useSyncExternalStore() {},
    useRef(initial) {
      const owner = current, index = owner.cursor++
      return owner.state[index] ??= { current: initial }
    },
    useState(initial) {
      const owner = current, index = owner.cursor++
      if (!(index in owner.state)) owner.state[index] = typeof initial === 'function' ? initial() : initial
      return [owner.state[index], value => { owner.state[index] = typeof value === 'function' ? value(owner.state[index]) : value }]
    },
    useEffect(fn, dependencies) {
      const owner = current, index = owner.effectCursor++, previous = owner.effects[index]
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        previous?.cleanup?.()
        owner.effects[index] = { dependencies }
        owner.pending.push(() => { owner.effects[index].cleanup = fn() })
      }
    },
  }
  function runner() {
    const owner = { state: [], effects: [], pending: [] }
    runners.push(owner)
    return (component, props) => {
      current = owner; owner.cursor = 0; owner.effectCursor = 0
      const tree = component(props)
      owner.pending.splice(0).forEach(fn => fn())
      return tree
    }
  }
  vm.runInNewContext(source, { window: {
    __ModuleLoader__: { load: value => { definition = value } },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  }, setTimeout, clearTimeout })
  definition.factory(() => React).apply({
    effect: fn => fn(),
    locale: {
      register: (_namespace, value) => { dictionaries = value },
      bind: () => key => {
        assert.equal(typeof dictionaries.en[key], 'string', `Missing English: ${key}`)
        assert.equal(typeof dictionaries.zh[key], 'string', `Missing Chinese: ${key}`)
        return dictionaries[language][key]
      }, subscribe() {}, getSnapshot() {},
    },
    get: name => {
      assert.equal(name, 'connection')
      return { rpc: { call: async (path, method, input) => {
        assert.equal(path, '/api'); assert.equal(method, 'codex-subscribe/manage')
        calls.push(JSON.parse(JSON.stringify(input)))
        if (handler) return handler(input)
        assert.equal(input.action, 'list')
        return { ok: true, value: { accounts: [structuredClone(account)] } }
      } } }
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => { if (options.name === 'settings.section') Section = component },
    },
  })
  const renderSection = runner(), renderRow = runner()
  return {
    calls, dictionaries, listeners,
    render() {
      const section = renderSection(Section)
      const row = nodes(section).find(node => node.type?.name === 'AccountRow')
      return { section, row: row ? renderRow(row.type, row.props) : null }
    },
    refreshButton(section) { return nodes(section).find(node => node.type === 'button' && text(node) === dictionaries[language].refreshModels) },
    dispose() { runners.forEach(owner => owner.effects.forEach(effect => effect.cleanup?.())) },
  }
}

for (const language of ['en', 'zh']) {
  for (const [sourceName, label] of [['builtin', 'catalogBuiltin'], ['cached', 'catalogCached'], ['online', 'catalogOnline']]) {
    test(`account row renders localized ${sourceName} count beside one shared refresh action (${language})`, async () => {
      const f = fixture({ language, account: { ...baseAccount, modelCatalog: { source: sourceName, refresh: 'ok', count: 7 } } })
      assert.equal(f.render().row, null)
      await flush()
      const { row, section } = f.render()
      assert.ok(nodes(row).some(node => node.props.role === 'status' && text(node).includes(`${f.dictionaries[language][label]} · 7 ${f.dictionaries[language].modelCount}`)))
      assert.equal(nodes(row).filter(node => node.type === 'button' && text(node) === f.dictionaries[language].refreshModels).length, 0, 'per-account refresh is replaced by one header action')
      assert.equal(f.refreshButton(section).props.disabled, false)
      assert.deepEqual(f.calls, [{ action: 'list' }], 'viewing settings must not refresh models')
      f.dispose()
      assert.equal(f.listeners.size, 0)
    })
  }

  test(`one header action refreshes every account without per-account targeting (${language})`, async () => {
    let catalog = { source: 'cached', refresh: 'idle', count: 3 }, complete
    const f = fixture({ language, handler: input => {
      if (input.action === 'list') return { ok: true, value: { accounts: [{ ...baseAccount, modelCatalog: { ...catalog } }] } }
      assert.equal(input.action, 'refresh-models')
      return new Promise(resolve => { complete = () => { catalog = { source: 'online', refresh: 'ok', count: 8 }; resolve({ ok: true, value: {} }) } })
    } })
    f.render(); await flush()
    const pending = f.refreshButton(f.render().section).props.onClick()
    assert.deepEqual(f.calls.at(-1), { action: 'refresh-models' }, 'refreshes the whole plugin, not one account')
    const pendingButtons = nodes(f.render().section).filter(node => node.type === 'button')
    const busy = pendingButtons.find(node => text(node) === f.dictionaries[language].refreshingModels)
    assert.ok(busy, 'pending refresh shows localized progress text')
    assert.equal(busy.props['aria-busy'], true)
    assert.equal(busy.props.disabled, true)
    complete(); await pending
    const { row, section } = f.render()
    assert.ok(text(row).includes(`${f.dictionaries[language].catalogOnline} · 8 ${f.dictionaries[language].modelCount}`))
    assert.equal(nodes(section).some(node => node.props.role === 'alert'), false)
    assert.deepEqual(f.calls.map(call => call.action), ['list', 'refresh-models', 'list'])
    f.dispose()
  })

  test(`failed refresh still reloads prior catalog, renders localized failure and unlocks (${language})`, async () => {
    let failed = false
    const f = fixture({ language, handler: input => {
      if (input.action === 'list') return { ok: true, value: { accounts: [{ ...baseAccount, modelCatalog: { source: failed ? 'builtin' : 'cached', refresh: failed ? 'failed' : 'ok', count: failed ? 12 : 4 } }] } }
      failed = true
      return { ok: false, error: { message: 'Refresh unavailable (offline test)' } }
    } })
    f.render(); await flush()
    await f.refreshButton(f.render().section).props.onClick()
    const { row, section } = f.render()
    assert.deepEqual(f.calls.map(call => call.action), ['list', 'refresh-models', 'list'])
    assert.ok(text(row).includes(`${f.dictionaries[language].catalogBuiltin} · 12 ${f.dictionaries[language].modelCount}`), 'failed refresh keeps a usable catalog instead of zero models')
    assert.ok(text(row).includes(f.dictionaries[language].catalogFailed))
    assert.ok(nodes(section).some(node => node.props.role === 'alert' && text(node) === 'Refresh unavailable (offline test)'))
    assert.equal(f.refreshButton(section).props.disabled, false)
    f.dispose()
  })
}

test('conversation quota failover is saved through a user-only switch and a failed save leaves it unchanged', async () => {
  let permit = false
  const f = fixture({ handler: input => {
    if (input.action === 'list') return { ok: true, value: { accounts: [baseAccount], chatFailover: false } }
    assert.deepEqual(JSON.parse(JSON.stringify(input)), { action: 'chat-failover-save', enabled: true })
    return permit ? { ok: true, value: { chatFailover: true } } : { ok: false, error: { message: 'Save denied' } }
  } })
  const toggle = () => nodes(f.render().section).find(node => node.props.role === 'switch')
  f.render(); await flush()
  assert.equal(toggle().props['aria-checked'], false)
  await toggle().props.onClick()
  assert.equal(toggle().props['aria-checked'], false)
  assert.ok(nodes(f.render().section).some(node => node.props.role === 'alert' && text(node) === 'Save denied'))
  permit = true
  await toggle().props.onClick()
  assert.equal(toggle().props['aria-checked'], true)
  f.dispose()
})

test('active sign-in and an empty account list disable the shared refresh action', async () => {
  const signingIn = fixture({ handler: () => ({ ok: true, value: { accounts: [baseAccount], login: { id: 'login-one', phase: 'waiting_browser' } } }) })
  signingIn.render(); await flush()
  assert.equal(signingIn.refreshButton(signingIn.render().section).props.disabled, true)
  signingIn.dispose()
  const empty = fixture({ handler: () => ({ ok: true, value: { accounts: [] } }) })
  empty.render(); await flush()
  assert.equal(empty.refreshButton(empty.render().section).props.disabled, true)
  empty.dispose()
})

test('older account responses without catalog metadata keep the shared refresh action', async () => {
  const { modelCatalog: _catalog, ...account } = baseAccount
  const f = fixture({ account })
  f.render(); await flush()
  const { row, section } = f.render()
  assert.ok(f.refreshButton(section))
  assert.equal(text(row).includes('undefined'), false)
  f.dispose()
})

test('refresh transport rejection also reloads and renders a visible error', async () => {
  const f = fixture({ handler: input => {
    if (input.action === 'list') return { ok: true, value: { accounts: [baseAccount] } }
    throw new Error('RPC transport failed')
  } })
  f.render(); await flush()
  await f.refreshButton(f.render().section).props.onClick()
  assert.deepEqual(f.calls.map(call => call.action), ['list', 'refresh-models', 'list'])
  const view = f.render()
  assert.ok(nodes(view.section).some(node => node.props.role === 'alert' && text(node) === 'RPC transport failed'))
  assert.equal(f.refreshButton(view.section).props.disabled, false)
  f.dispose()
})

test('reload failure after refresh is visible and does not leave the refresh action locked', async () => {
  let lists = 0
  const f = fixture({ handler: input => {
    if (input.action === 'refresh-models') return { ok: true, value: {} }
    return ++lists === 1 ? { ok: true, value: { accounts: [baseAccount] } } : { ok: false, error: { message: 'Reload failed' } }
  } })
  f.render(); await flush()
  await f.refreshButton(f.render().section).props.onClick()
  const view = f.render()
  assert.ok(nodes(view.section).some(node => node.props.role === 'alert' && text(node) === 'Reload failed'))
  assert.equal(f.refreshButton(view.section).props.disabled, false)
  f.dispose()
})

test('a failed refresh keeps its own error visible even when the follow-up reload also fails', async () => {
  let lists = 0
  const f = fixture({ handler: input => {
    if (input.action === 'refresh-models') return { ok: false, error: { message: 'Catalog refresh failed' } }
    return ++lists === 1 ? { ok: true, value: { accounts: [baseAccount] } } : { ok: false, error: { message: 'Reload failed' } }
  } })
  f.render(); await flush()
  await f.refreshButton(f.render().section).props.onClick()
  const view = f.render()
  assert.ok(nodes(view.section).some(node => node.props.role === 'alert' && text(node) === 'Catalog refresh failed'))
  assert.equal(f.refreshButton(view.section).props.disabled, false)
  f.dispose()
})
