import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { EXPORT_SCRIPT, prepareImageExport } from '../src/image-export.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FoAAAAASUVORK5CYII=', 'base64')
function fixture(overrides = {}) {
  const calls = [], policy = { mode: 'workspace-write', workspaceRoot: '/workspace' }
  const services = {
    fs: {
      sandboxMode: 'workspace-write', processPathFromHostPath: p => p,
      async resolve(path, { cwd }) { return { displayPath: resolve(cwd, path) } },
      async lstat() {}, processPath: t => t.displayPath,
    },
    shell: {
      sandboxMode: 'workspace-write', resolve: request => request,
      async execute(request) { calls.push(request); return { result: async () => ({ exitCode: 0, stdout: { text: 'saved' }, stderr: { text: '' } }) } },
    },
    workingDirectory: { ensure: async () => '/workspace' },
    sandboxPolicy: { resolve: () => policy },
    ...overrides,
  }
  const exec = { agent: { session: { id: 's' } }, signal: new AbortController().signal }
  return { services, calls, policy, exec, ctx: { get: key => services[key] } }
}
test('export resolves current directory, passes session sandbox and uses bounded foreground shell', async () => {
  const f = fixture()
  const save = await prepareImageExport(f.ctx, 'assets/icon.png', f.exec)
  assert.equal(await save(png, f.exec.signal), '/workspace/assets/icon.png')
  assert.equal(f.calls.length, 1)
  const request = f.calls[0]
  assert.deepEqual(request.sandboxPolicy, f.policy)
  assert.equal(request.workdir, '/workspace'); assert.equal(request.onExpiry, 'kill')
  assert.equal(request.timeoutMs, 30000)
  assert.deepEqual(JSON.parse(request.stdin), { destination: '/workspace/assets/icon.png', png: png.toString('base64') })
  assert.match(request.command, /ELECTRON_RUN_AS_NODE=1/)
})
test('export fails closed for missing services, unmapped runtimes, existing paths and read-only policy', async () => {
  for (const change of [f => { f.services.shell = undefined }, f => { f.services.fs.processPathFromHostPath = () => undefined }, f => { f.services.fs.lstat = async () => ({ type: 'file' }) }, f => { f.policy.mode = 'read-only' }, f => { f.services.shell.sandboxMode = undefined }, f => { f.services.sandboxPolicy = undefined }]) {
    const f = fixture(); change(f)
    await assert.rejects(prepareImageExport(f.ctx, 'icon.png', f.exec))
    assert.equal(f.calls.length, 0)
  }
})
test('a session becoming read-only after generation still cannot export', async () => {
  const f = fixture(), save = await prepareImageExport(f.ctx, 'icon.png', f.exec)
  f.policy.mode = 'read-only'
  await assert.rejects(save(png, f.exec.signal), /denied/)
  assert.equal(f.calls.length, 0)
})
test('denials and failed shell results never invoke another write path', async () => {
  for (const result of [
    { exitCode: 1, sandbox: { denied: true } },
    { exitCode: 1, stderr: { text: 'EEXIST' } },
    { exitCode: 0, timedOut: true },
    { exitCode: 0, aborted: true },
    { exitCode: 0, stdout: { text: 'unexpected' } },
  ]) {
    const f = fixture()
    f.services.shell.execute = async request => {
      f.calls.push(request)
      return { result: async () => ({ stdout: { text: '' }, stderr: { text: 'secret' }, ...result }) }
    }
    const save = await prepareImageExport(f.ctx, 'icon.png', f.exec)
    await assert.rejects(save(png, f.exec.signal), error => !error.message.includes('secret'))
    assert.equal(f.calls.length, 1)
  }
})
async function runExport(destination, data = png) {
  const child = spawn(process.execPath, ['-e', EXPORT_SCRIPT], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 })
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
  const done = new Promise((res, rej) => { child.on('error', rej); child.on('close', code => res({ code, stdout, stderr })) })
  child.stdin.end(JSON.stringify({ destination, png: data.toString('base64') }))
  return done
}
test('real binary publisher creates parents, preserves bytes, refuses existing files/symlinks and cleans temps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-export-'))
  try {
    const target = join(root, 'assets with spaces', "icon'<>.png")
    assert.deepEqual(await runExport(target), { code: 0, stdout: 'saved', stderr: '' })
    assert.deepEqual(await readFile(target), png)
    assert.deepEqual(await runExport(target, Buffer.from('different')), { code: 1, stdout: '', stderr: 'EEXIST' })
    assert.deepEqual(await readFile(target), png)
    const victim = join(root, 'victim.png'), link = join(root, 'assets with spaces', 'link.png')
    await writeFile(victim, 'keep'); await symlink(victim, link)
    assert.equal((await runExport(link)).stderr, 'EEXIST')
    assert.equal(await readFile(victim, 'utf8'), 'keep')
    assert.deepEqual((await readdir(join(root, 'assets with spaces'))).sort(), ["icon'<>.png", 'link.png'].sort())
    const race = join(root, 'race.png')
    const results = await Promise.all([runExport(race), runExport(race)])
    assert.deepEqual(results.map(r => r.code).sort(), [0, 1])
    assert.deepEqual(await readFile(race), png)
  } finally {
    // root is the exact unique directory returned by mkdtemp in this test.
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-image-export-')))
    await rm(root, { recursive: true, force: true })
  }
})
