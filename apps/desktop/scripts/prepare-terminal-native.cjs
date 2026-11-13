const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function prepareSpawnHelpers(packageRoot) {
  const helpers = [path.join(packageRoot, 'build', 'Release', 'spawn-helper')];
  const prebuilds = path.join(packageRoot, 'prebuilds');
  if (fs.existsSync(prebuilds))
    for (const directory of fs.readdirSync(prebuilds)) {
      helpers.push(path.join(prebuilds, directory, 'spawn-helper'));
    }
  for (const helper of helpers) {
    if (!fs.existsSync(helper)) continue;
    const stat = fs.statSync(helper);
    if (!stat.isFile() || (stat.mode & 0o111) === 0o111) continue;
    if (stat.nlink > 1) {
      const temporary = `${helper}.dnaforge-${process.pid}`;
      fs.copyFileSync(helper, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, helper);
    }
    fs.chmodSync(helper, stat.mode | 0o111);
  }
}

function prepareTerminalNative(monoRoot, targetArch = process.arch) {
  const packageRoot = path.join(monoRoot, 'node_modules', 'node-pty');
  if (!fs.existsSync(packageRoot)) return;
  prepareSpawnHelpers(packageRoot);
  if (targetArch !== process.arch) return;
  const electron = require(path.join(monoRoot, 'node_modules', 'electron'));
  const script =
    `const p=require(${JSON.stringify(packageRoot)}).spawn(` +
    `process.platform==='win32'?'cmd.exe':'/bin/sh',` +
    `process.platform==='win32'?['/d','/c','echo DNAFORGE_PTY_READY']:['-c','printf DNAFORGE_PTY_READY'],` +
    `{cols:80,rows:24,cwd:require('node:os').tmpdir(),env:{PATH:process.env.PATH||'',TERM:'xterm-256color'}});` +
    `p.onData(d=>process.stdout.write(d));p.onExit(e=>process.exit(e.exitCode));`;
  const probe = () =>
    spawnSync(electron, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 15_000,
    });
  let result = probe();
  if (
    result.status !== 0 &&
    /Failed to load native module|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|Module did not self-register/u.test(
      result.stderr ?? ''
    )
  ) {
    const cli = path.join(
      path.dirname(require.resolve('@electron/rebuild', { paths: [monoRoot] })),
      'cli.js'
    );
    const { version } = require(path.join(monoRoot, 'node_modules', 'electron', 'package.json'));
    const rebuilt = spawnSync(
      process.execPath,
      [
        cli,
        '--force',
        '--only',
        'node-pty',
        '--module-dir',
        path.join(monoRoot, 'apps', 'desktop'),
        '--arch',
        targetArch,
        '--version',
        version,
      ],
      {
        cwd: monoRoot,
        env: process.env,
        stdio: 'inherit',
        timeout: 120_000,
      }
    );
    if (rebuilt.status !== 0)
      throw new Error(
        `Terminal native rebuild failed: ${rebuilt.error?.message || rebuilt.status}`
      );
    prepareSpawnHelpers(packageRoot);
    result = probe();
  }
  if (result.status !== 0 || !result.stdout.includes('DNAFORGE_PTY_READY')) {
    throw new Error(
      `Native terminal failed under Electron: ${result.error?.message || result.stderr || result.status}`
    );
  }
  console.log('[terminal-native] real PTY spawn/output/exit passed under Electron');
}

module.exports = { prepareTerminalNative };
if (require.main === module) prepareTerminalNative(path.resolve(__dirname, '../../..'));
