import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageTool, decodePng, sessionImages } from '../src/images.js'
import { Config, IMAGE_DEFAULTS, validateImageSettings, imageAccountCandidates, imageSettingsOperations } from '../src/image-settings.js'
import { apply } from '../src/index.js'

const A = `account-${'a'.repeat(32)}`, B = `account-${'b'.repeat(32)}`
const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'source.png' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FoAAAAASUVORK5CYII=', 'base64')
const accountList = [{ id: A, provider: 'provider-a' }, { id: B, provider: 'provider-b' }]
function fixture(overrides = {}) {
  const calls = [], writes = []
  let settings = { ...IMAGE_DEFAULTS, enabled: true }
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: ref }] }]
  const service = {
    imageLimits: { maxImageBytes: 1024, maxMessageImageBytes: 2048, mediaTypes: ['image/png'] },
    async readImage(input) { assert.deepEqual(input, ref); return { ref, data: png } },
    async validateImage(input) { writes.push('validate'); assert.deepEqual(Buffer.from(input.data), png) },
    async saveFile(input) { writes.push('original'); assert.deepEqual(Buffer.from(input.data), png); return { attachmentId: `sha256:${'b'.repeat(64)}`, bytes: png.length, name: input.name } },
    async saveImage() { writes.push('preview'); return { ...ref, name: 'codex-generated.png' } },
    fileHostPath: () => '/storage/original.png',
  }
  const tool = createImageTool({
    getSettings: () => settings, accounts: { list: async () => accountList },
    getCredential: async (id, signal) => { signal.throwIfAborted(); assert.equal(id, A); return { access: 'secret-access', accountId: 'remote-a' } },
    getSession: () => ({ deriveMessages: () => messages, requestContext: () => ({ provider: 'provider-a' }) }),
    attachments: () => service,
    fetchImage: async (url, options) => { calls.push({ url, options }); return Response.json({ data: [{ b64_json: png.toString('base64') }] }) },
    ...overrides,
  })
  const exec = { agent: { id: 'session-test' }, callId: 'call-test', signal: new AbortController().signal }
  return { tool, exec, calls, writes, service, setSettings: value => { settings = value } }
}
test('image settings default off; supported model/quality pairs are validated', () => {
  assert.deepEqual(Config({}), { images: IMAGE_DEFAULTS })
  assert.deepEqual(validateImageSettings(IMAGE_DEFAULTS), IMAGE_DEFAULTS)
  assert.throws(() => validateImageSettings({ ...IMAGE_DEFAULTS, quality: 'max' }), /Invalid/)
  assert.equal(validateImageSettings({ ...IMAGE_DEFAULTS, model: 'gpt-image-2.5-flare', quality: 'max' }).quality, 'max')
  for (const extra of [{ enabled: 'true' }, { accountId: '../other' }, { model: '__proto__' }, { unexpected: true }]) assert.throws(() => validateImageSettings({ ...IMAGE_DEFAULTS, ...extra }))
})
test('automatic candidates prefer last success, ignore missing preferences and fixed mode stays fixed', async () => {
  const accounts = { list: async () => accountList }
  assert.deepEqual(await imageAccountCandidates(accounts, IMAGE_DEFAULTS, B), [B, A])
  assert.deepEqual(await imageAccountCandidates(accounts, { ...IMAGE_DEFAULTS, accountId: A }, B), [A])
  assert.deepEqual(await imageAccountCandidates(accounts, IMAGE_DEFAULTS, 'removed-account'), [A, B])
  assert.deepEqual(await imageAccountCandidates({ list: async () => [accountList[0]] }, IMAGE_DEFAULTS), [A])
  await assert.rejects(imageAccountCandidates({ list: async () => [] }, IMAGE_DEFAULTS), /Sign in/)
  await assert.rejects(imageAccountCandidates({ list: async () => [] }, { ...IMAGE_DEFAULTS, accountId: A }), /removed/)
})
test('settings writes use configEditor preserving unrelated fields; rejection stays visible', async () => {
  let saved
  const ctx = { fiber: { entry: { id: 'entry' } }, get: () => ({ async edit(entry, change) { assert.equal(entry.id, 'entry'); saved = change({ other: 42 }) } }) }
  const ops = imageSettingsOperations(ctx, IMAGE_DEFAULTS, { list: async () => accountList })
  const next = { ...IMAGE_DEFAULTS, enabled: true, accountId: A }
  assert.deepEqual(await ops.save(next), next)
  assert.deepEqual(saved, { other: 42, images: next })
  const cause = new Error('secret storage detail')
  const logs = []
  const fail = imageSettingsOperations({ ...ctx, logger: { warn: (...args) => logs.push(args) }, get: () => ({ edit: async () => { throw cause } }) }, IMAGE_DEFAULTS, { list: async () => [] })
  await assert.rejects(fail.save(IMAGE_DEFAULTS), error => /could not be saved/.test(error.message) && !error.message.includes('secret') && !error.message.includes('permissions') && error.cause === cause)
  assert.deepEqual(logs, [['Image settings update failed', cause]])
  await assert.rejects(imageSettingsOperations({}, IMAGE_DEFAULTS, {}).save(IMAGE_DEFAULTS), /cannot be saved/)
})
test('text-to-image posts once with settings and private headers, preserving original bytes', async () => {
  const { tool, exec, calls, writes } = fixture()
  const value = await tool.execute({ prompt: ' a small cat ' }, exec)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/generations$/)
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-access')
  assert.deepEqual(JSON.parse(calls[0].options.body), { prompt: 'a small cat', model: 'gpt-image-2', quality: 'auto', size: 'auto', background: 'auto' })
  assert.deepEqual(writes, ['validate', 'original', 'preview'])
  assert.equal(value.accountId, A)
  const blocks = tool.output.render({}, value)
  assert.deepEqual(blocks.map(block => block.type), ['text', 'image', 'file'])
  assert.equal(JSON.stringify(value).includes('secret'), false)
})
test('image output supplies final-reply Markdown without losing native editing attachments', async () => {
  const { tool, exec } = fixture()
  const value = await tool.execute({ prompt: 'cat' }, exec)
  const blocks = tool.output.render({}, { ...value, localPath: '/a folder/cat<1>%\n.png' })
  assert.match(tool.description, /display the returned Markdown image in your final reply/i)
  assert.ok(blocks[0].text.includes('![Generated image](</a folder/cat%3C1%3E%25%0A.png>)'))
  assert.ok(!blocks[0].text.includes('[Original PNG]('))
  assert.deepEqual(blocks[1], { type: 'image', attachment: value.image })
  assert.deepEqual(blocks[2], { type: 'file', attachment: value.original })
  const noPath = tool.output.render({}, { ...value, localPath: undefined })[0].text
  assert.match(noPath, /Do not invent an image URL/)
  assert.ok(!noPath.includes('!['))
})
test('project output defaults to file delivery and exports original bytes exactly once', async () => {
  const exports = []
  const f = fixture({ prepareExport: async (path, exec) => {
    assert.equal(path, 'assets/icon.png'); assert.equal(exec.agent.id, 'session-test')
    return async data => { exports.push(data); return '/workspace/assets/icon.png' }
  } })
  const value = await f.tool.execute({ prompt: 'icon', outputPath: 'assets/icon.png' }, f.exec)
  assert.equal(value.delivery, 'file'); assert.equal(value.savedPath, '/workspace/assets/icon.png')
  assert.deepEqual(exports, [png]); assert.equal(f.calls.length, 1)
  const blocks = f.tool.output.render({}, value)
  assert.match(blocks[0].text, /Saved file: "\/workspace\/assets\/icon.png"/)
  assert.match(blocks[0].text, /\[Saved PNG\]\(<\/workspace\/assets\/icon.png>\)/)
  assert.ok(!blocks[0].text.includes('!['))
  assert.deepEqual(blocks.map(b => b.type), ['text', 'image', 'file'])
})
test('file delivery without a destination links the original; explicit image delivery wins', async () => {
  const f = fixture({ prepareExport: async () => async () => '/workspace/icon.png' })
  const file = await f.tool.execute({ prompt: 'icon', delivery: 'file' }, f.exec)
  assert.match(f.tool.output.render({}, file)[0].text, /\[Original PNG\]/)
  assert.ok(!f.tool.output.render({}, file)[0].text.includes('!['))
  const image = await f.tool.execute({ prompt: 'icon', outputPath: 'icon.png', delivery: 'image' }, f.exec)
  assert.match(f.tool.output.render({}, image)[0].text, /!\[Generated image\]\(<\/workspace\/icon.png>\)/)
})
test('invalid delivery/PNG destinations and unavailable export fail before dispatch', async () => {
  for (const args of [{ delivery: 'auto' }, { outputPath: '' }, { outputPath: 'a.svg' }, { outputPath: 'a.ico' }, { outputPath: 'a\n.png' }, { outputPath: null }, { outputPath: 'icon.png' }]) {
    const f = fixture()
    await assert.rejects(f.tool.execute({ prompt: 'icon', ...args }, f.exec))
    assert.equal(f.calls.length, 0)
  }
  const f = fixture({ prepareExport: async () => { throw new Error('existing target') } })
  await assert.rejects(f.tool.execute({ prompt: 'icon', outputPath: 'icon.png' }, f.exec), /existing target/)
  assert.equal(f.calls.length, 0)
})
test('post-generation export failure retains attachments and never retries generation', async () => {
  const f = fixture({ prepareExport: async () => async () => { throw new Error('secret disk details') } })
  const value = await f.tool.execute({ prompt: 'icon', outputPath: 'icon.png' }, f.exec)
  assert.equal(f.calls.length, 1); assert.equal(value.savedPath, undefined)
  assert.match(value.saveError, /original is still attached/)
  const text = f.tool.output.render({}, value)[0].text
  assert.match(text, /saving failed/); assert.match(text, /do not regenerate/)
  assert.ok(!text.includes('secret')); assert.match(text, /\[Original PNG\]/)
  assert.ok(value.image && value.original)
})
test('image edits send selected verified source bytes, not a new text-only image', async () => {
  const { tool, exec, calls } = fixture()
  await tool.execute({ prompt: 'make the sky blue', referenceImages: [ref.attachmentId] }, exec)
  assert.match(calls[0].url, /\/edits$/)
  assert.deepEqual(JSON.parse(calls[0].options.body).images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }])
})
test('invalid, missing, duplicate and empty edit references fail before network I/O', async () => {
  for (const referenceImages of [[], [ref.attachmentId, ref.attachmentId], ['source.png'], [`sha256:${'c'.repeat(64)}`], [null]]) {
    const { tool, exec, calls } = fixture()
    await assert.rejects(tool.execute({ prompt: 'edit', referenceImages }, exec))
    assert.equal(calls.length, 0)
  }
})
test('disabled, detached and aborted calls cannot dispatch', async () => {
  const f = fixture()
  f.setSettings(IMAGE_DEFAULTS)
  await assert.rejects(f.tool.execute({ prompt: 'cat' }, f.exec), /disabled/)
  f.setSettings({ ...IMAGE_DEFAULTS, enabled: true })
  await assert.rejects(f.tool.execute({ prompt: 'cat' }, { ...f.exec, agent: undefined }), /session-owned/)
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(f.tool.execute({ prompt: 'cat' }, { ...f.exec, signal: controller.signal }), /cancelled/)
  assert.equal(f.calls.length, 0)
})
test('disable while authentication is pending prevents dispatch', async () => {
  let f
  f = fixture({ getCredential: async () => { f.setSettings(IMAGE_DEFAULTS); return { access: 'secret', accountId: 'a' } } })
  await assert.rejects(f.tool.execute({ prompt: 'cat' }, f.exec), /disabled before dispatch/)
  assert.equal(f.calls.length, 0)
})
test('fixed-account HTTP failures are sanitized and never switch accounts', async () => {
  for (const status of [401, 403, 429, 500]) {
    let attempts = 0
    const { tool, exec, writes, setSettings } = fixture({ fetchImage: async () => { attempts++; return new Response('secret-backend-body', { status }) } })
    setSettings({ ...IMAGE_DEFAULTS, enabled: true, accountId: A })
    await assert.rejects(tool.execute({ prompt: 'cat' }, exec), error => error.message.includes(`HTTP ${status}`) && !error.message.includes('secret'))
    assert.equal(attempts, 1); assert.deepEqual(writes, [])
  }
})
test('auth and transport errors cannot leak credentials or raw responses', async () => {
  for (const overrides of [{ getCredential: async () => { throw new Error('secret-auth') } }, { fetchImage: async () => { throw new Error('secret-transport') } }]) {
    const { tool, exec } = fixture(overrides)
    await assert.rejects(tool.execute({ prompt: 'cat' }, exec), error => !error.message.includes('secret') && error.cause === undefined)
  }
})
test('malformed PNG/JSON and oversized responses are rejected before storage', async () => {
  for (const response of [() => new Response('invalid-json'), () => Response.json({ data: [{ b64_json: 'AAAA' }] }), () => new Response('x'.repeat(1050000)), () => new Response('{}', { headers: { 'content-length': '999999999' } })]) {
    const { tool, exec, writes } = fixture({ fetchImage: async () => response() })
    await assert.rejects(tool.execute({ prompt: 'cat' }, exec)); assert.deepEqual(writes, [])
  }
  assert.deepEqual(decodePng(png.toString('base64'), 1024), png)
  assert.throws(() => decodePng(png.toString('base64'), 8))
})
test('image lookup includes prior native tool-result images, not arbitrary text IDs', () => {
  assert.equal(sessionImages([{ content: [{ type: 'tool-result', content: [{ type: 'image', attachment: ref }] }, { type: 'text', text: `sha256:${'c'.repeat(64)}` }] }]).size, 1)
})
test('cancellation during asynchronous raster validation prevents all durable writes', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.service.validateImage = async () => { controller.abort(new Error('cancelled during validation')) }
  await assert.rejects(f.tool.execute({ prompt: 'cat' }, { ...f.exec, signal: controller.signal }), /cancelled during validation/)
  assert.deepEqual(f.writes, [])
})
test('editing a prior generated result uses the verbatim original rather than the normalized preview', async () => {
  const f = fixture()
  const original = { attachmentId: `sha256:${'b'.repeat(64)}`, bytes: png.length, name: 'codex-generated.png' }
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'previous-call', name: 'codex_image_generate' }] },
    { role: 'tool', source: { callId: 'previous-call' }, content: [{ type: 'image', attachment: ref }, { type: 'file', attachment: original }] },
  ]
  f.service.readImage = async () => { throw new Error('Must not read the normalized preview') }
  f.service.readFileStream = async function* (value) { assert.deepEqual(value, original); yield png }
  const tool = createImageTool({
    getSettings: () => ({ ...IMAGE_DEFAULTS, enabled: true }), accounts: { list: async () => [accountList[0]] },
    getCredential: async () => ({ access: 'secret', accountId: 'a' }),
    getSession: () => ({ deriveMessages: () => messages, requestContext: () => ({ provider: 'provider-a' }) }),
    attachments: () => f.service,
    fetchImage: async (url, options) => {
      assert.match(url, /edits$/)
      assert.equal(JSON.parse(options.body).images[0].image_url, `data:image/png;base64,${png.toString('base64')}`)
      return Response.json({ data: [{ b64_json: png.toString('base64') }] })
    },
  })
  await tool.execute({ prompt: 'edit the original', referenceImages: [ref.attachmentId] }, f.exec)
})
test('preview or Host-path failures after original storage degrade to recoverable attachment delivery', async () => {
  for (const failPreview of [true, false]) {
    const f = fixture()
    if (failPreview) f.service.saveImage = async () => { throw new Error('secret preview failure') }
    else f.service.fileHostPath = () => { throw new Error('secret path failure') }
    const value = await f.tool.execute({ prompt: 'cat' }, f.exec)
    assert.equal(f.calls.length, 1); assert.ok(value.original)
    assert.match(value.warning, /original PNG|original PNG/i)
    assert.ok(!value.warning.includes('secret'))
    const blocks = f.tool.output.render({}, value)
    assert.ok(blocks.some(b => b.type === 'file'))
    assert.ok(!blocks.some(b => b.type === 'image' && !b.attachment))
    if (failPreview) assert.equal(value.image, undefined)
    else assert.equal(value.localPath, undefined)
  }
})
test('cancel or disable during original persistence retains original but skips optional writes', async () => {
  for (const cancel of [true, false]) {
    let remember = 0, exportCount = 0
    const f = fixture({ accountMemory: { preferred: () => '', remember: async () => { remember++ } }, prepareExport: async () => async () => { exportCount++; return '/target.png' } })
    const controller = new AbortController(), saveFile = f.service.saveFile
    f.service.saveFile = async input => {
      const file = await saveFile(input)
      if (cancel) controller.abort(new Error('cancelled'))
      else f.setSettings(IMAGE_DEFAULTS)
      return file
    }
    const value = await f.tool.execute({ prompt: 'cat', outputPath: 'icon.png' }, { ...f.exec, signal: controller.signal })
    assert.ok(value.original); assert.equal(value.image, undefined)
    assert.equal(remember, 0); assert.equal(exportCount, 0)
    assert.deepEqual(f.writes, ['validate', 'original'])
    assert.match(value.warning, /Cancelled or disabled/)
    assert.match(value.saveError, /cancelled|disabled/)
    assert.equal(f.calls.length, 1)
  }
})
test('cancel during preview storage prevents subsequent memory and export writes', async () => {
  let remember = 0, exports = 0
  const f = fixture({ accountMemory: { preferred: () => '', remember: async () => { remember++ } }, prepareExport: async () => async () => { exports++; return '/target.png' } })
  const controller = new AbortController(), saveImage = f.service.saveImage
  f.service.saveImage = async input => { const image = await saveImage(input); controller.abort(); return image }
  const value = await f.tool.execute({ prompt: 'cat', outputPath: 'icon.png' }, { ...f.exec, signal: controller.signal })
  assert.ok(value.image && value.original)
  assert.equal(remember, 0); assert.equal(exports, 0)
  assert.match(value.warning, /Cancelled or disabled/)
})
test('host registers exactly one new tool only when enabled, and settings remain user-only', async () => {
  for (const enabled of [false, true]) {
    const tools = new Map(), disposers = []
    let route
    const ctx = {
      storageDomain: { async open() { return { global: { get: () => ({ lastSuccessfulAccountId: '' }) }, close: async () => {} } } },
      credentials: { listRecords: async () => [] }, llm: {},
      connection: { fetch: { register(value) { route = value; return () => {} } } },
      tools: { register(value) { tools.set(value.name, value); return () => tools.delete(value.name) } },
      effect(fn) { disposers.push(fn()) }, get() {},
    }
    await apply(ctx, { images: { ...IMAGE_DEFAULTS, enabled } })
    assert.deepEqual([...tools.keys()].sort(), enabled ? ['codex_image_generate', 'codex_subscriptions'] : ['codex_subscriptions'])
    await assert.rejects(tools.get('codex_subscriptions').execute({ action: 'images-settings-save', settings: IMAGE_DEFAULTS }), /Unknown operation/)
    const response = await route.fetch(new Request('http://localhost/api/codex-subscribe/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'settings-test', method: 'codex-subscribe/manage', payload: { action: 'images-settings' } }) }))
    assert.deepEqual((await response.json()).result.value, { ...IMAGE_DEFAULTS, enabled })
    for (const dispose of disposers.reverse()) await dispose()
    assert.equal(tools.size, 0)
  }
})
