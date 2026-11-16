import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot =
  process.env.DNAFORGE_CONTRACT_REPO ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourceScripts = join(sourceRoot, 'apps/desktop/scripts');
function put(root, file, text) {
  const destination = join(root, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
  return destination;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function streamPaths(value, labels = [], output = { stdout: [], stderr: [] }) {
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) streamPaths(child, [...labels, key], output);
  else if (typeof value === 'string')
    for (const stream of ['stdout', 'stderr'])
      if (labels.some((label) => label.toLowerCase().includes(stream))) output[stream].push(value);
  return output;
}
async function failureFixture(t, mode) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dna4244-guard-diagnostics-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appDir = join(root, 'apps/desktop');
  for (const file of [
    'dev-single-instance-guard.cjs',
    'dev-windows-stack.cjs',
    'background-electron-launch.cjs',
    'background-window-policy.cjs',
    'dev-launch-profile.cjs',
  ])
    copyFileSync(join(sourceScripts, file), put(appDir, `scripts/${file}`, ''));
  put(root, 'package.json', '{"private":true}');
  put(
    root,
    'scripts/check-worktree-port-identity.mjs',
    'export function checkWorktreePortIdentity(){return {ok:true};}\n'
  );
  put(
    appDir,
    'scripts/dev-native-build-cache.cjs',
    'module.exports={inspectNativeBuild:()=>({reusable:true,source:"fixture",environment:"fixture"})};\n'
  );
  put(
    appDir,
    'scripts/dev-app-runtime.cjs',
    'module.exports={prepareDevelopmentApplication:async({electronBinary})=>({electronBinary,env:{}})};\n'
  );
  for (const file of ['ensure-dugite-git.cjs', 'prepare-opendataloader-runtime.cjs'])
    put(appDir, `scripts/${file}`, 'process.exitCode=0;\n');
  const binary = put(
    appDir,
    '.cache/fake-runtime/Electron.app/Contents/MacOS/Electron',
    'never executed'
  );
  put(appDir, 'node_modules/electron/package.json', '{"main":"index.cjs"}');
  put(
    appDir,
    'node_modules/electron/index.cjs',
    'module.exports=' + JSON.stringify(binary) + ';\n'
  );
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [renderer, debug, hmr] = ports;
  put(
    appDir,
    '.env.local',
    `DESKTOP_DEV_PORT=${renderer}\nDESKTOP_DEBUG_PORT=${debug}\nDESKTOP_HMR_PORT=${hmr}\n`
  );
  const bootstrap = put(
    root,
    'platform.cjs',
    "Object.defineProperty(process,'platform',{value:'darwin'});\n"
  );
  const childSource = `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const appDir=process.cwd();
const cache=path.join(appDir,'.cache/dnaforge-dev-runtime');const attempts=path.join(cache,'launches');fs.mkdirSync(attempts,{recursive:true,mode:0o700});
const attempt=fs.mkdtempSync(path.join(attempts,'attempt-'));
const metadata={applicationRoot:process.env.DNAFORGE_BACKGROUND_ELECTRON_APP_PATH,launcherPid:process.pid,startedAt:new Date(Date.now()-(process.env.FIXTURE_DIAGNOSTICS_MODE==='stale'?60000:0)).toISOString(),stdout:path.join(attempt,'stdout.log'),stderr:path.join(attempt,'stderr.log')};
fs.writeFileSync(metadata.stdout,'native stdout fixture\\n',{mode:0o600});fs.writeFileSync(metadata.stderr,'native stderr fixture\\n',{mode:0o600});
fs.writeFileSync(path.join(attempt,'launch.json'),JSON.stringify(metadata),{mode:0o600});const temporary=path.join(attempt,'last-launch.tmp');fs.writeFileSync(temporary,JSON.stringify(metadata),{mode:0o600});fs.renameSync(temporary,path.join(cache,'last-launch.json'));
fs.writeFileSync(path.join(appDir,'child-observation.json'),JSON.stringify({pid:process.pid,backgroundSafe:process.env.DNAFORGE_BACKGROUND_LAUNCH_SAFE,worktreeCwd:process.env.DNAFORGE_BACKGROUND_WORKTREE_CWD}));
process.exitCode=0;
`;
  const pnpm = put(root, 'bin/pnpm', childSource);
  chmodSync(pnpm, 0o755);
  const result = spawnSync(
    process.execPath,
    [join(appDir, 'scripts/dev-single-instance-guard.cjs')],
    {
      cwd: appDir,
      env: {
        PATH: join(root, 'bin') + ':' + process.env.PATH,
        NODE_OPTIONS: '--require=' + JSON.stringify(bootstrap),
        NODE_ENV: 'development',
        DNAFORGE_BACKGROUND_WINDOW: '1',
        DNAFORGE_DEV_STARTUP_TIMEOUT_MS: '5000',
        FIXTURE_DIAGNOSTICS_MODE: mode,
      },
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }
  );
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 2, output);
  assert.ok(!output.includes('ELECTRON_DEV_READY '), output);
  const line = output.split(/\r?\n/).find((line) => line.startsWith('ELECTRON_DEV_START_FAILED '));
  assert.ok(line, output);
  const final = JSON.parse(line.slice('ELECTRON_DEV_START_FAILED '.length));
  assert.match(final.reason, /exited:\s*0/i);
  const child = JSON.parse(readFileSync(join(appDir, 'child-observation.json'), 'utf8'));
  assert.equal(final.childPid, child.pid);
  assert.equal(child.backgroundSafe, '1');
  assert.equal(child.worktreeCwd, appDir);
  const metadata = JSON.parse(
    readFileSync(join(appDir, '.cache/dnaforge-dev-runtime/last-launch.json'), 'utf8')
  );
  console.log(JSON.stringify({ mode, final, metadata, child }));
  return { final, metadata };
}
test(
  'a background child exiting zero reports both current native diagnostic paths',
  { timeout: 15000 },
  async (t) => {
    const { final, metadata } = await failureFixture(t, 'current');
    const found = streamPaths(final);
    assert.ok(
      found.stdout.includes(metadata.stdout),
      `Final startup failure omits current native stdout: ${JSON.stringify(final)}`
    );
    assert.ok(
      found.stderr.includes(metadata.stderr),
      `Final startup failure omits current native stderr: ${JSON.stringify(final)}`
    );
  }
);
test(
  'a background child exit never attributes stale native diagnostic paths to the new launch',
  { timeout: 15000 },
  async (t) => {
    const { final, metadata } = await failureFixture(t, 'stale');
    const found = streamPaths(final);
    assert.ok(
      !found.stdout.includes(metadata.stdout),
      'A prior native stdout path was attributed to this launch'
    );
    assert.ok(
      !found.stderr.includes(metadata.stderr),
      'A prior native stderr path was attributed to this launch'
    );
  }
);
