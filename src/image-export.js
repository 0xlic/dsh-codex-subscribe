import { UserError } from './accounts.js'

// ctx.fs has no binary write operation in DSH 0.2.2. Publish through the
// mounted shell instead, so session file confinement still applies. Never
// fall back to an in-process host write after a denial.
export const EXPORT_SCRIPT = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let temp, owned = false;
  try {
    const { destination, png } = JSON.parse(input);
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    temp = path.join(parent, '.dsh-image-' + crypto.randomUUID() + '.tmp');
    const fd = fs.openSync(temp, 'wx', 0o644);
    owned = true;
    try { fs.writeFileSync(fd, Buffer.from(png, 'base64')); } finally { fs.closeSync(fd); }
    // Linking publishes the complete bytes atomically and refuses any existing
    // destination (including symlinks). No replace/delete of user files.
    fs.linkSync(temp, destination);
    process.stdout.write('saved');
  } catch (error) {
    const errors = { EEXIST: 'EEXIST', EACCES: 'EACCES: permission denied', EPERM: 'EPERM: operation not permitted', EROFS: 'EROFS: read-only file system' };
    process.stderr.write(errors[error.code] || 'EXPORT_FAILED');
    process.exitCode = 1;
  } finally {
    if (owned) { try { fs.unlinkSync(temp); } catch {} }
  }
});
`
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

export async function prepareImageExport(ctx, outputPath, exec) {
  const fs = ctx.get('fs'), shell = ctx.get('shell'), workingDirectory = ctx.get('workingDirectory')
  if (!fs || !shell || !workingDirectory) throw new UserError('Saving images requires filesystem, shell and working-directory services')
  // Host runtime paths are not portable to an unrelated remote execution world.
  const runtime = fs.processPathFromHostPath(process.execPath)
  if (!runtime) throw new UserError('Saving images is unavailable in this execution environment; use the attached PNG')
  if (fs.sandboxMode !== undefined && shell.sandboxMode === undefined) throw new UserError('Saving images requires a sandbox-aware shell for this filesystem')
  const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
  const target = await fs.resolve(outputPath, { cwd, signal: exec.signal })
  if (await fs.lstat(outputPath, { cwd }, exec.signal)) throw new UserError('Output path already exists; choose a new PNG filename. Existing files are never overwritten')
  const destination = fs.processPath(target)
  const policyService = ctx.get('sandboxPolicy')
  if (shell.sandboxMode !== undefined && !policyService) throw new UserError('Image export sandbox policy is unavailable')
  const resolvePolicy = () => {
    const policy = policyService?.resolve({ session: exec.agent.session })
    if (policy?.mode === 'read-only') throw new UserError('Image export was denied by the read-only session file policy; do not retry with another write method')
    if (policy && policy.mode !== 'danger-full-access' && shell.sandboxMode === undefined) throw new UserError('Image export requires a sandbox-aware shell for this session policy')
    return policy
  }
  resolvePolicy()
  return async (data, signal) => {
    const sandboxPolicy = resolvePolicy()
    const execution = await shell.execute(shell.resolve({
      command: `ELECTRON_RUN_AS_NODE=1 ${quote(runtime)} -e ${quote(EXPORT_SCRIPT)}`,
      workdir: cwd, timeoutMs: 30000, onExpiry: 'kill', signal,
      stdin: JSON.stringify({ destination, png: data.toString('base64') }),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    }))
    const result = await execution.result()
    if (result.exitCode !== 0 || result.aborted || result.timedOut || result.stdout.text !== 'saved') {
      if (result.sandbox?.denied || /^(EACCES|EPERM|EROFS):/.test(result.stderr.text)) throw new UserError('Image export was denied by file permissions or the session sandbox; do not retry with another write method')
      if (result.stderr.text === 'EEXIST') throw new UserError('Output path already exists; existing files are never overwritten')
      throw new UserError('Could not save the PNG to the requested path (permission, timeout or filesystem error)')
    }
    return target.displayPath
  }
}
