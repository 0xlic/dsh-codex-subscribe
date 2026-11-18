'use strict'
// Validate new catalog storage and dynamic model resolution against the running
// installation, using only synthetic credentials and a uniquely owned temp root.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

async function main() {
  assert.ok(process.versions.electron, 'Run with DSH_NODE_EXECUTABLE and ELECTRON_RUN_AS_NODE=1')
  const anchor = process.env.DSH_INSTALL_DIR
  assert.ok(anchor && path.isAbsolute(anchor))
  const manifest = JSON.parse(await fs.readFile(path.join(anchor, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@deepseek-ai/dsh')
  const runtimeRequire = createRequire(path.join(anchor, 'package.json'))
  const installed = name => import(pathToFileURL(runtimeRequire.resolve(name)))
  const { DomainFacility } = await installed('@deepseek-ai/dsh-storage-domain')
  const { JsonStorageBackend } = await installed('@deepseek-ai/dsh-storage-json')
  const { PiAiAdapter } = await installed('@deepseek-ai/dsh-llm-pi-ai')
  // pi-ai 1.3 exposes import-only subpaths and does not export its manifest.
  const piPath = path.resolve(anchor, '../../@earendil-works/pi-ai')
  assert.equal(JSON.parse(await fs.readFile(path.join(piPath, 'package.json'), 'utf8')).name, '@earendil-works/pi-ai')
  const { openaiCodexProvider } = await import(pathToFileURL(path.join(piPath, 'dist/providers/openai-codex.js')))
  const { openModelCatalogStore } = await import('../src/model-catalog-store.js')
  const { createModelCatalog } = await import('../src/model-catalog.js')
  const { createAccountAdapter } = await import('../src/adapter.js')
  const temporaryBase = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(temporaryBase, 'dsh-catalog-regression-'))
  let backend, store, catalog
  const facility = () => {
    backend = new JsonStorageBackend(root)
    return new DomainFacility({ storage: { backend: { get() { return backend } } }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'json', routes: {} })
  }
  try {
    store = await openModelCatalogStore(facility())
    const native = openaiCodexProvider()
    catalog = createModelCatalog({ baseModels: () => native.getModels(), cache: store,
      readCredential: async () => ({ accountId: 'synthetic-account' }),
      getCredential: async () => ({ accountId: 'synthetic-account', access: 'synthetic-token' }),
      fetch: async () => Response.json({ models: [{ slug: 'future-runtime-model', visibility: 'list', display_name: 'Future', context_window: 600000, input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'medium' }] }] }),
    })
    const route = 'codex-sub-runtime-test'
    const adapter = createAccountAdapter({ route, label: 'Runtime test', catalog,
      getCredential: async () => ({ type: 'oauth', access: 'synthetic-token' }),
      providerFactory: openaiCodexProvider, adapterFactory: config => new PiAiAdapter(config) })
    assert.deepEqual((await adapter.listModels(route)).map(model => model.id), ['future-runtime-model'])
    assert.equal((await adapter.resolveModel(route, 'future-runtime-model')).context.contextWindow, 600000)
    const prepared = await adapter.prepareCall(route, 'future-runtime-model')
    assert.equal(prepared.model.id, 'future-runtime-model')
    assert.deepEqual(prepared.model.reasoning.efforts.map(effort => effort.id), ['medium'])
    catalog.dispose()
    await store.close(); await backend.close()
    store = await openModelCatalogStore(facility())
    assert.equal(store.read('synthetic-account').rawCatalog.models[0].slug, 'future-runtime-model')
    assert.equal(store.read('other-account'), undefined)
    await store.retain([])
    assert.equal(store.read('synthetic-account'), undefined)
    console.log(JSON.stringify({ dshVersion: manifest.version, storageRestart: true, accountIsolation: true, dynamicModelResolved: true, preparedModel: prepared.model.id }))
  } finally {
    catalog?.dispose(); await store?.close(); await backend?.close()
    const checked = await fs.realpath(root)
    assert.equal(checked, root)
    assert.equal(path.dirname(checked), temporaryBase)
    assert.ok(path.basename(checked).startsWith('dsh-catalog-regression-'))
    await fs.rm(checked, { recursive: true, force: false })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
