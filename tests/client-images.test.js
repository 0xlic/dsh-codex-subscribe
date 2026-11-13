import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const defaults = { enabled: false, model: 'gpt-image-2', quality: 'auto', accountId: '' }
const accounts = [{ id: 'account-one', label: 'codex-one' }, { id: 'account-two', label: 'codex-two', email: 'two@example.com' }]
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
const selects = tree => nodes(tree).filter(node => node.type === 'select')
const switchOf = tree => nodes(tree).find(node => node.props.role === 'switch')
const flush = () => new Promise(resolve => setImmediate(resolve))

// Exercise the actual plain-JavaScript Client module without installing React or
// modifying a profile. This harness models component state/effect dependencies;
// it is not a browser layout or native keyboard accessibility test.
function fixture({ language = 'en', initial = defaults, handler } = {}) {
  let definition, Section, ImageResult, dictionaries, state = [], cursor = 0, effectCursor = 0, tracking = false
  const effects = [], pending = [], calls = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }),
    Fragment: 'fragment', useSyncExternalStore() {},
    useState(initialValue) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef(initialValue) {
      const index = cursor++
      if (!(index in state)) state[index] = { current: initialValue }
      return state[index]
    },
    useEffect(fn, dependencies) {
      if (!tracking) return
      const index = effectCursor++, previous = effects[index]
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        previous?.cleanup?.()
        effects[index] = { dependencies }
        pending.push(() => { effects[index].cleanup = fn() })
      }
    },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { definition = value } } }, setTimeout, clearTimeout,
  })
  const ctx = {
    effect: fn => fn(),
    locale: {
      register: (namespace, value) => { dictionaries = value },
      bind: () => key => dictionaries[language][key], subscribe() {}, getSnapshot() {},
    },
    get: name => {
      assert.equal(name, 'connection')
      return { rpc: { call: async (path, method, input) => {
        assert.equal(path, '/api'); assert.equal(method, 'codex-subscribe/manage')
        calls.push(JSON.parse(JSON.stringify(input)))
        if (handler) return handler(input)
        return { ok: true, value: input.action === 'images-settings' ? { ...initial } : { ...input.settings } }
      } } }
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        if (options.name === 'settings.section') Section = component
        if (options.name === 'tool.call.toolview') ImageResult = component
      },
    },
  }
  definition.factory(() => React).apply(ctx)
  const sectionTree = Section()
  const component = nodes(sectionTree).find(node => node.type?.name === 'ImageSettings').type
  state = []; tracking = true
  const props = {
    accounts: [...accounts],
    t: key => {
      assert.equal(typeof dictionaries.en[key], 'string', `Missing English: ${key}`)
      assert.equal(typeof dictionaries.zh[key], 'string', `Missing Chinese: ${key}`)
      return dictionaries[language][key]
    },
  }
  return {
    calls, props, dictionaries, sectionTree,
    render() { cursor = 0; effectCursor = 0; const tree = component(props); pending.splice(0).forEach(fn => fn()); return tree },
    renderResult(resultProps) { cursor = 0; return ImageResult(resultProps) },
    dispose() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

test('image settings are an independent card beside the accounts card', () => {
  const f = fixture()
  const accountCard = f.sectionTree.children.find(node => node.props.className === 'csm-card')
  const imageSettings = f.sectionTree.children.find(node => node.type?.name === 'ImageSettings')
  assert.ok(accountCard)
  assert.ok(imageSettings, 'ImageSettings must be a direct sibling, not nested in the accounts card')
  assert.equal(nodes(accountCard).some(node => node.type?.name === 'ImageSettings'), false)
  assert.equal(f.render().props.className, 'csm-card csm-images')
  f.dispose()
})

for (const language of ['en', 'zh']) {
  test(`image settings load with localized controls (${language})`, async () => {
    const f = fixture({ language })
    let tree = f.render()
    assert.equal(switchOf(tree).props.disabled, true)
    await flush(); tree = f.render()
    assert.deepEqual(f.calls, [{ action: 'images-settings' }])
    assert.equal(tree.props['aria-label'], f.dictionaries[language].images)
    assert.equal(switchOf(tree).props['aria-label'], f.dictionaries[language].imagesEnable)
    assert.deepEqual(selects(tree)[0].children.map(option => option.props.value), ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    assert.equal(selects(tree)[2].children[0].props.value, '')
    assert.equal(selects(tree)[2].children[0].children[0], f.dictionaries[language].imagesAuto)
    f.dispose()
  })
}

test('switch and account changes apply automatically without a save button', async () => {
  const f = fixture(); f.render(); await flush()
  let tree = f.render()
  assert.equal(tree.type, 'section')
  assert.equal(tree.props.onSubmit, undefined)
  assert.equal(nodes(tree).some(node => node.type === 'button' && node.children.includes(f.dictionaries.en.save)), false)
  const saving = switchOf(tree).props.onClick()
  tree = f.render()
  assert.equal(switchOf(tree).props['aria-checked'], true)
  assert.equal(switchOf(tree).props.disabled, true)
  await saving
  assert.deepEqual(f.calls.at(-1), { action: 'images-settings-save', settings: { ...defaults, enabled: true } })
  tree = f.render()
  await selects(tree)[2].props.onChange({ target: { value: 'account-two' } })
  assert.deepEqual(f.calls.at(-1), { action: 'images-settings-save', settings: { ...defaults, enabled: true, accountId: 'account-two' } })
  assert.ok(nodes(f.render()).some(node => node.props.role === 'status' && node.children.includes(f.dictionaries.en.imagesSaved)))
  await selects(f.render())[2].props.onChange({ target: { value: '' } })
  assert.equal(f.calls.at(-1).settings.accountId, '')
  await switchOf(f.render()).props.onClick()
  assert.equal(f.calls.at(-1).settings.enabled, false)
  f.dispose()
})

test('both 2.5 models expose extended qualities and downgrade resets unsupported quality', async () => {
  const f = fixture(); f.render(); await flush()
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    for (const quality of ['xhigh', 'max']) {
      await selects(f.render())[0].props.onChange({ target: { value: model } })
      let tree = f.render()
      assert.deepEqual(selects(tree)[1].children.map(option => option.props.value), ['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
      await selects(tree)[1].props.onChange({ target: { value: quality } })
      assert.equal(f.calls.at(-1).settings.quality, quality)
      await selects(f.render())[0].props.onChange({ target: { value: 'gpt-image-2' } })
      assert.deepEqual(f.calls.at(-1).settings, { ...defaults, model: 'gpt-image-2', quality: 'auto' })
      tree = f.render()
      assert.equal(selects(tree)[1].props.value, 'auto')
      assert.deepEqual(selects(tree)[1].children.map(option => option.props.value), ['auto', 'low', 'medium', 'high'])
    }
  }
  await selects(f.render())[1].props.onChange({ target: { value: 'high' } })
  await selects(f.render())[0].props.onChange({ target: { value: 'gpt-image-2.5-flare' } })
  assert.equal(selects(f.render())[1].props.value, 'high')
  f.dispose()
})

test('pending auto-apply prevents overlapping stale writes and unlocks after completion', async () => {
  let complete
  const f = fixture({ handler: input => input.action === 'images-settings'
    ? { ok: true, value: { ...defaults } }
    : new Promise(resolve => { complete = () => resolve({ ok: true, value: input.settings }) }) })
  f.render(); await flush()
  const tree = f.render()
  const pending = switchOf(tree).props.onClick()
  // Even callbacks from the same pre-render state cannot race the first write.
  await selects(tree)[2].props.onChange({ target: { value: 'account-two' } })
  assert.equal(f.calls.length, 2)
  assert.equal(f.render().props['aria-busy'], true)
  assert.ok(selects(f.render()).every(node => node.props.disabled))
  complete(); await pending
  assert.equal(f.render().props['aria-busy'], false)
  assert.equal(selects(f.render())[2].props.value, '')
  f.dispose()
})

test('load failure is visible and retry loads settings', async () => {
  let failed = true
  const f = fixture({ handler: input => failed ? { ok: false, error: { message: 'Settings unavailable' } } : { ok: true, value: defaults } })
  f.render(); await flush()
  let tree = f.render()
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && node.children.includes('Settings unavailable')))
  failed = false
  nodes(tree).find(node => node.type === 'button' && node.children.includes('Retry')).props.onClick()
  f.render(); await flush(); tree = f.render()
  assert.equal(selects(tree).length, 3)
  assert.equal(f.calls.length, 2)
  f.dispose()
})

test('auto-apply failure rolls back to effective settings and removed account remains explicit', async () => {
  const f = fixture({ initial: { ...defaults, accountId: 'removed-account' }, handler: input => input.action === 'images-settings'
    ? { ok: true, value: { ...defaults, accountId: 'removed-account' } }
    : { ok: false, error: { message: 'Account was removed' } } })
  f.render(); await flush()
  let tree = f.render()
  const missing = selects(tree)[2].children.find(option => option.props.value === 'removed-account')
  assert.equal(missing.props.disabled, true)
  assert.equal(missing.children[0], f.dictionaries.en.imagesMissingAccount)
  await switchOf(tree).props.onClick()
  tree = f.render()
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && node.children.includes('Account was removed')))
  assert.equal(switchOf(tree).props['aria-checked'], false)
  assert.equal(selects(tree)[2].props.value, 'removed-account')
  assert.equal(nodes(tree).some(node => node.children.includes(f.dictionaries.en.imagesSaved)), false)
  f.dispose()
})


const previewAttachment = { attachmentId: 'sha256:preview', mediaType: 'image/png', bytes: 1024, width: 640, height: 480 }
const textOf = tree => tree && typeof tree === 'object' ? tree.children.map(textOf).join('') : String(tree ?? '')
// Native details hides its descendants, but does not prevent their mounting.
const visibleText = tree => tree && typeof tree === 'object'
  ? (tree.type === 'details' && !tree.props.open ? tree.children.filter(child => child.type === 'summary') : tree.children).map(visibleText).join('')
  : String(tree ?? '')
function resultFixture({ language = 'en', text = 'Image generated', image = previewAttachment, extra = [], isError = false, phase = 'result' } = {}) {
  const f = fixture({ language }), galleryCalls = [], opened = [], disclosures = []
  let disclosureCursor = 0
  const props = {
    // Model the native owner Hook contract: independent initially-closed state,
    // reset by the enclosing Turn (not by a local component useState).
    useDisclosure() {
      const index = disclosureCursor++
      disclosures[index] ??= false
      const setExpanded = value => { disclosures[index] = value }
      return { expanded: disclosures[index], setExpanded, toggle: () => setExpanded(!disclosures[index]) }
    },
    phase, toolName: 'codex_image_generate', block: { isError, content: [
      { type: 'text', text }, ...(image ? [{ type: 'image', attachment: image }] : []), ...extra,
    ] },
    loadImage() {}, openFile: path => opened.push(path),
    renderFactorySlot: (name, value) => { galleryCalls.push({ name, value }); return { type: 'gallery', props: {}, children: [] } },
  }
  return {
    ...f, props, galleryCalls, opened,
    resetTurn() { disclosures.fill(false) },
    render() { disclosureCursor = 0; return f.renderResult(props) },
  }
}
for (const language of ['en', 'zh']) {
  test(`image result is lightweight and lazily mounts preview only while opened (${language})`, () => {
    const f = resultFixture({ language, text: 'Image generated using private-model. Host metadata', extra: [{ type: 'file', attachment: { name: 'original.png', attachmentId: 'sha256:original' } }] })
    let tree = f.render()
    assert.match(visibleText(tree), new RegExp(f.dictionaries[language].imageReady))
    assert.ok(!visibleText(tree).includes('private-model'))
    assert.ok(!visibleText(tree).includes('sha256:original'))
    assert.equal(f.galleryCalls.length, 0)
    assert.equal(nodes(tree).filter(node => node.type === 'details').length, 2)
    const preview = nodes(tree).find(node => node.type === 'details' && node.children[0].children.includes(f.dictionaries[language].imagePreview))
    assert.equal(preview.props.open, false)
    const target = { open: true }
    preview.props.onToggle({ target, currentTarget: target })
    tree = f.render()
    assert.equal(f.galleryCalls.length, 1)
    assert.equal(f.galleryCalls[0].name, 'conversation.images.content')
    assert.equal(f.galleryCalls[0].value.images[0].attachment.attachmentId, previewAttachment.attachmentId)
    assert.equal(f.galleryCalls[0].value.loadImage, f.props.loadImage)
    assert.equal(nodes(tree).filter(node => node.type === 'gallery').length, 1)
    const openPreview = nodes(tree).find(node => node.type === 'details' && node.props.open)
    const closed = { open: false }
    openPreview.props.onToggle({ target: closed, currentTarget: closed })
    tree = f.render()
    assert.equal(f.galleryCalls.length, 1, 'closing must not invoke or retain the gallery')
    assert.equal(nodes(tree).some(node => node.type === 'gallery'), false)
    const technical = nodes(tree).find(node => node.type === 'details' && node.children[0].children.includes(f.dictionaries[language].imageDetails))
    assert.ok(!technical.props.open)
    assert.match(textOf(technical), /private-model/)
    assert.match(textOf(technical), /sha256:preview/)
    assert.match(textOf(technical), /sha256:original/)
    for (const key of ['imagePreview', 'imageDetails', 'imageSavedFile', 'imageOriginal', 'imagePreviewSize', 'imageOriginalSize']) {
      assert.equal(typeof f.dictionaries[language][key], 'string')
    }
  })
}

test('Saved file JSON path takes precedence and is displayed as safe text', () => {
  const saved = '/images/<img src=x onerror=alert(1)> & \"quoted\".png'
  const host = '/host/original.png'
  const f = resultFixture({ text: `Host file: ${JSON.stringify(host)}\nSaved file: ${JSON.stringify(saved)}` })
  const tree = f.render()
  const filename = nodes(tree).find(node => node.type === 'span' && node.props.title === saved)
  assert.ok(filename)
  assert.equal(filename.children[0], `${f.dictionaries.en.imageSavedFile}: ${saved.split('/').pop()}`)
  assert.equal(nodes(tree).some(node => node.props.dangerouslySetInnerHTML), false)
  nodes(tree).find(node => node.type === 'button').props.onClick()
  assert.deepEqual(f.opened, [saved])
})

test('historical Host file paths, malformed Saved file and Windows filenames remain supported', () => {
  for (const saved of ['', 'Saved file: null\n', 'Saved file: {"path":"not-a-string"}\n', 'Saved file: "unterminated\n', 'Saved file: "   "\n']) {
    const host = 'C:\\images\\old image.png'
    const f = resultFixture({ text: `${saved}Host file: ${JSON.stringify(host)}\r\n` })
    const tree = f.render()
    assert.ok(visibleText(tree).includes('old image.png'))
    nodes(tree).find(node => node.type === 'button').props.onClick()
    assert.deepEqual(f.opened, [host])
  }
})

test('preview dimensions are never mislabeled as original dimensions', () => {
  const f = resultFixture()
  let tree = f.render()
  assert.ok(visibleText(tree).includes('Preview dimensions: 640 × 480'))
  assert.ok(!visibleText(tree).includes('Original dimensions'))
  f.props.block.content[1].attachment = { ...previewAttachment, originalDimensions: { width: 2048, height: 1536 } }
  tree = f.render()
  assert.ok(visibleText(tree).includes('Original dimensions: 2048 × 1536'))
  f.props.block.content[1].attachment.originalDimensions = { width: -1, height: 1536 }
  assert.ok(!visibleText(f.render()).includes('Original dimensions'))
})

test('save warnings stay visible without leaking technical text, including warning-first history', () => {
  for (const text of ['Image generated using private-model.\nWarning: Could not save PNG: permission denied', 'Warning: Could not save PNG: permission denied']) {
    const f = resultFixture({ text })
    const tree = f.render()
    assert.ok(visibleText(tree).includes('Warning: Could not save PNG: permission denied'))
    assert.ok(!visibleText(tree).includes('private-model'))
    assert.equal(nodes(tree).filter(node => node.props.role === 'alert').length, 1)
    assert.equal(f.galleryCalls.length, 0)
  }
})

test('failed and historical text-only results keep raw errors inside technical disclosure', () => {
  for (const isError of [false, true]) {
    const f = resultFixture({ image: null, isError, text: 'Internal request JSON and secret diagnostic' })
    const tree = f.render()
    assert.ok(visibleText(tree).includes(f.dictionaries.en.imageFailed))
    assert.ok(!visibleText(tree).includes('secret diagnostic'))
    assert.ok(textOf(tree).includes('secret diagnostic'))
    assert.equal(f.galleryCalls.length, 0)
  }
})

test('preparing and running views have only a localized status line', () => {
  for (const phase of ['preparing', 'running']) {
    const f = resultFixture({ phase })
    const tree = f.render()
    assert.equal(tree.children.length, 1)
    assert.ok(visibleText(tree).includes(f.dictionaries.en[phase === 'preparing' ? 'imagePreparing' : 'imageWorking']))
    assert.equal(f.galleryCalls.length, 0)
  }
})

test('saved-file-only historical result still offers file opening without a preview', () => {
  const f = resultFixture({ image: null, text: 'Saved file: "/images/result.png"' })
  const tree = f.render()
  assert.ok(visibleText(tree).includes(f.dictionaries.en.imageReady))
  nodes(tree).find(node => node.type === 'button').props.onClick()
  assert.deepEqual(f.opened, ['/images/result.png'])
  assert.equal(f.galleryCalls.length, 0)
})


test('native Turn reset closes preview and technical details before reopening the Turn', () => {
  const f = resultFixture({ text: 'Internal technical metadata' })
  const tree = f.render()
  for (const details of nodes(tree).filter(node => node.type === 'details')) {
    const target = { open: true }
    details.props.onToggle({ target, currentTarget: target })
  }
  const expanded = f.render()
  assert.equal(nodes(expanded).filter(node => node.type === 'details' && node.props.open).length, 2)
  assert.equal(f.galleryCalls.length, 1)
  assert.ok(visibleText(expanded).includes('Internal technical metadata'))
  f.resetTurn()
  const reopened = f.render()
  assert.equal(nodes(reopened).filter(node => node.type === 'details' && node.props.open).length, 0)
  assert.equal(nodes(reopened).some(node => node.type === 'gallery'), false)
  assert.equal(f.galleryCalls.length, 1, 'Turn reopen must not even invoke the gallery slot')
  assert.ok(!visibleText(reopened).includes('Internal technical metadata'))
})

for (const language of ['en', 'zh']) {
  test(`original-file-only fallback is successful and keeps its preview warning visible (${language})`, () => {
    const warning = 'Warning: Could not save image preview; original PNG attachment is available.'
    const f = resultFixture({ language, image: null, text: `Image generated using private-model.\n${warning}`, extra: [
      { type: 'file', attachment: { attachmentId: 'sha256:original-only', name: 'original.png', bytes: 4096, mediaType: 'image/png' } },
    ] })
    const tree = f.render()
    assert.ok(visibleText(tree).includes(f.dictionaries[language].imageReady))
    assert.ok(!visibleText(tree).includes(f.dictionaries[language].imageFailed))
    assert.ok(visibleText(tree).includes(warning))
    assert.ok(!visibleText(tree).includes('private-model'))
    assert.equal(nodes(tree).filter(node => node.type === 'details').length, 1)
    assert.ok(textOf(tree).includes('sha256:original-only'))
    assert.equal(nodes(tree).some(node => node.type === 'button'), false, 'no invented local file path')
    assert.equal(f.galleryCalls.length, 0)
  })
}

test('an explicit failed block stays failed even with an original file attachment', () => {
  const f = resultFixture({ image: null, isError: true, extra: [{ type: 'file', attachment: { attachmentId: 'sha256:original-only' } }] })
  assert.ok(visibleText(f.render()).includes(f.dictionaries.en.imageFailed))
})
