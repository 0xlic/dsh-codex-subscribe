'use strict'

// Run with the verified Desktop Electron runtime and installation anchor:
// ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/storage-domain-runtime.cjs
// Uses installed storage classes and only a newly-created OS temp directory.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

async function main() {
  assert.ok(process.versions.electron, 'Use the verified ASAR-aware Electron executable')
  const anchor = process.env.DSH_INSTALL_DIR
  assert.ok(anchor && path.isAbsolute(anchor), 'DSH_INSTALL_DIR must be an absolute verified installation anchor')
  const manifest = JSON.parse(readFileSync(path.join(anchor, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@deepseek-ai/dsh')
  const installedRequire = createRequire(path.join(anchor, 'package.json'))
  const { DomainFacility, defineDomain } = await import(pathToFileURL(installedRequire.resolve('@deepseek-ai/dsh-storage-domain')))
  const { JsonStorageBackend } = await import(pathToFileURL(installedRequire.resolve('@deepseek-ai/dsh-storage-json')))
  const workspace = path.resolve(__dirname, '..')
  const { IMAGE_ACCOUNT_DOMAIN, openImageAccountMemory } = await import(pathToFileURL(path.join(workspace, 'src/image-accounts.js')))
  assert.equal(IMAGE_ACCOUNT_DOMAIN.name, 'codex_subscribe_image_accounts')

  const temporaryBase = await fs.realpath(os.tmpdir())
  const prefix = path.join(temporaryBase, 'dsh-image-domain-regression-')
  const temporaryRoot = await fs.mkdtemp(prefix)
  const checkedRoot = await fs.realpath(temporaryRoot)
  assert.equal(checkedRoot, temporaryRoot)
  assert.equal(path.dirname(checkedRoot), temporaryBase)
  assert.ok(path.basename(checkedRoot).startsWith('dsh-image-domain-regression-'))
  let backend
  const messages = []
  const createFacility = () => {
    backend = new JsonStorageBackend(checkedRoot)
    return new DomainFacility({
      storage: { backend: { get(name) { assert.equal(name, 'json'); return backend } } },
      emit() {},
      logger: { warn() {}, error() {} },
    }, { backend: 'json', routes: {} })
  }
  try {
    let facility = createFacility()
    const invalid = { ...IMAGE_ACCOUNT_DOMAIN, name: 'codex-subscribe-image-accounts' }
    assert.throws(() => defineDomain(invalid), /must match/)
    await assert.rejects(facility.open(invalid), error => {
      assert.equal(error.name, 'StorageError')
      assert.equal(error.code, 'malformed-medium')
      assert.equal(error.message, "invalid unit name 'codex-subscribe-image-accounts'")
      messages.push({ test: 'original domain rejected', name: error.name, code: error.code, message: error.message })
      return true
    })
    assert.deepEqual(await fs.readdir(checkedRoot), [], 'invalid name must fail before backend I/O')
    assert.equal(defineDomain(IMAGE_ACCOUNT_DOMAIN), IMAGE_ACCOUNT_DOMAIN)
    const memory = await openImageAccountMemory(facility)
    assert.equal(memory.preferred(), '')
    const id = `account-${'a'.repeat(32)}`
    await memory.remember(id)
    assert.equal(memory.preferred(), id)
    await memory.close()
    await backend.close()

    // Fresh backend and facility recreate the installation restart boundary.
    facility = createFacility()
    const restored = await openImageAccountMemory(facility)
    assert.equal(restored.preferred(), id)
    await restored.close()
    await backend.close()
    backend = undefined
    messages.push({ test: 'fixed domain open, remember, close, fresh-backend reopen', passed: true, preferenceRestored: true })
    console.log(JSON.stringify({ dshVersion: manifest.version, electronVersion: process.versions.electron, tests: messages }, null, 2))
  } finally {
    await backend?.close()
    // Delete only the exact, freshly-created temp root after re-verifying it.
    const resolved = await fs.realpath(checkedRoot)
    assert.equal(resolved, checkedRoot)
    assert.equal(path.dirname(resolved), temporaryBase)
    assert.ok(path.basename(resolved).startsWith('dsh-image-domain-regression-'))
    await fs.rm(resolved, { recursive: true, force: false })
    console.log(JSON.stringify({ tempDirectoryRemoved: true }))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
