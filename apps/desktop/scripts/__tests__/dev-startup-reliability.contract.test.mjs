import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerDevProcessFreshnessTests } from './dev-process-freshness.contract.mjs';

registerDevProcessFreshnessTests(test);

const require = createRequire(import.meta.url);
const appSource = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptsSource = join(appSource, 'scripts');
const readyToken = 'ELECTRON_DEV_READY';
const failureToken = 'ELECTRON_DEV_START_FAILED';

function put(root, relative, value) {
  const destination = join(root, relative);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  );
  return destination;
}

function fixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dev-stack-startup-'));
  const appDir = join(repoRoot, 'apps/desktop');
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  put(repoRoot, 'package.json', { name: 'startup-contract-workspace', private: true });
  put(
    repoRoot,
    '.gitignore',
    'node_modules/\nout/\nbin/\nlaunch-control.json*\nlaunch-child.json*\ncdp-requests.jsonl\n'
  );
  put(repoRoot, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/**'\n");
  put(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  apps/desktop: {}\n");
  put(appDir, 'package.json', {
    name: '@waypoint/desktop',
    version: '1.0.0',
    type: 'module',
    main: 'out/main/index.js',
    dependencies: { '@waypoint/startup-fixture': 'workspace:*', electron: '38.0.0' },
    devDependencies: { 'electron-vite': '4.0.0', vite: '7.0.0' },
  });
  put(
    appDir,
    'src/main/index.ts',
    "import './worker';\nimport '@waypoint/startup-fixture';\nexport const main = 'one';\n"
  );
  put(appDir, 'src/main/worker.ts', "import '../shared/contract';\nexport const worker = 'one';\n");
  put(
    appDir,
    'src/preload/index.ts',
    "import '../shared/contract';\nexport const preload = 'one';\n"
  );
  put(appDir, 'src/shared/contract.ts', "export const contract = 'one';\n");
  put(appDir, 'electron.vite.config.ts', 'export default {main: {}, preload: {}, renderer: {}};\n');
  put(appDir, 'tsconfig.json', { compilerOptions: { target: 'ES2022' } });
  put(appDir, 'tsconfig.node.json', { extends: './tsconfig.json' });
  put(repoRoot, 'tsconfig.base.json', { compilerOptions: { strict: true } });
  put(appDir, 'distribution.json', { distribution: 'normal' });
  put(appDir, 'update-authority.json', { stable: 'https://example.invalid/update' });
  put(appDir, '.env', 'VITE_API_URL=http://127.0.0.1:8012\n');
  put(appDir, '.env.local', 'DESKTOP_DEV_PORT=1591\nDESKTOP_DEBUG_PORT=9391\n');
  put(repoRoot, 'packages/core/startup-fixture/package.json', {
    name: '@waypoint/startup-fixture',
    version: '1.0.0',
    exports: './src/index.ts',
    dependencies: { '@waypoint/startup-leaf': 'workspace:*' },
  });
  put(
    repoRoot,
    'packages/core/startup-fixture/src/index.ts',
    "export { leaf } from '@waypoint/startup-leaf';\n"
  );
  put(repoRoot, 'packages/core/startup-leaf/package.json', {
    name: '@waypoint/startup-leaf',
    version: '1.0.0',
    exports: './src/index.ts',
  });
  put(repoRoot, 'packages/core/startup-leaf/src/index.ts', "export const leaf = 'one';\n");
  put(appDir, 'node_modules/electron/package.json', {
    name: 'electron',
    version: '38.0.0',
    main: 'index.cjs',
  });
  put(appDir, 'node_modules/electron/index.cjs', 'module.exports = process.execPath;\n');
  put(appDir, 'node_modules/electron-vite/package.json', {
    name: 'electron-vite',
    version: '4.0.0',
  });
  put(appDir, 'node_modules/vite/package.json', { name: 'vite', version: '7.0.0' });
  put(appDir, 'out/main/index.js', "import './product-initial.js';\n");
  put(
    appDir,
    'out/main/product-initial.js',
    "import './chunks/worker.js';\nexport const main = 'one';\n"
  );
  put(appDir, 'out/main/chunks/worker.js', "export const worker = 'one';\n");
  put(appDir, 'out/preload/index.js', "globalThis.preloadContract = 'one';\n");
  put(appDir, 'node_modules/.vite/deps/cache-sentinel.js', 'preoptimized-dependency-v1\n');
  for (const name of [
    'dev-single-instance-guard.cjs',
    'dev-launch-profile.cjs',
    'background-electron-launch.cjs',
    'background-window-policy.cjs',
    'dev-app-runtime.cjs',
    '../src/main/automation-profile.cjs',
    'dev-native-build-cache.cjs',
  ]) {
    if (existsSync(join(scriptsSource, name))) {
      copyFileSync(join(scriptsSource, name), put(appDir, `scripts/${name}`, ''));
    }
  }
  copyFileSync(
    resolve(appSource, '../../scripts/check-worktree-port-identity.mjs'),
    put(repoRoot, 'scripts/check-worktree-port-identity.mjs', '')
  );
  for (const name of ['prepare-opendataloader-runtime.cjs', 'ensure-dugite-git.cjs']) {
    put(appDir, `scripts/${name}`, 'process.stdout.write("fixture preflight complete\\n");\n');
  }
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  git('init', '--quiet', '--initial-branch=dev');
  git('add', '.');
  git(
    '-c',
    'user.name=Startup Contract',
    '-c',
    'user.email=startup-contract@example.invalid',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '--no-verify',
    '-m',
    'fixture source'
  );
  return {
    appDir,
    repoRoot,
    env: {
      NODE_ENV: 'test',
      DESKTOP_DEV_PORT: '1591',
      DESKTOP_DEBUG_PORT: '9391',
      DNAFORGE_DEV_TARGET: 'unmanaged',
      VITE_DNAFORGE_DEV_TARGET: 'unmanaged',
      SENTRY_DSN: 'https://initial@example.invalid/1',
    },
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function until(read, label, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function launch(t, { state = {}, timeoutMs = 1200, warm = false } = {}) {
  const f = fixture(t);
  const rendererPort = await freePort();
  const debugPort = await freePort();
  put(
    f.appDir,
    '.env.local',
    `DESKTOP_DEV_PORT=${rendererPort}\nDESKTOP_DEBUG_PORT=${debugPort}\n`
  );
  const controlPath = put(f.appDir, 'launch-control.json', state);
  const shim = put(
    f.repoRoot,
    'bin/pnpm',
    readFileSync(join(scriptsSource, '__tests__/fixtures/dev-launch-child.cjs'))
  );
  chmodSync(shim, 0o755);
  if (warm) {
    const cacheFile = join(scriptsSource, 'dev-native-build-cache.cjs');
    assert.ok(existsSync(cacheFile), 'shared native build cache must exist before warm launch');
    require(cacheFile).recordNativeBuild({
      ...f,
      env: {
        ...f.env,
        DESKTOP_DEV_PORT: String(rendererPort),
        DESKTOP_DEBUG_PORT: String(debugPort),
      },
    });
  }
  const child = spawn(process.execPath, [join(f.appDir, 'scripts/dev-single-instance-guard.cjs')], {
    cwd: f.appDir,
    env: {
      PATH: `${join(f.repoRoot, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      HOME: f.repoRoot,
      NODE_ENV: 'test',
      DNAFORGE_DEV_STARTUP_TIMEOUT_MS: String(timeoutMs),
      SENTRY_DSN: f.env.SENTRY_DSN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const recordFile = join(f.appDir, 'launch-child.json');
  let ownedPid;
  t.after(async () => {
    if (existsSync(recordFile)) ownedPid = JSON.parse(readFileSync(recordFile, 'utf8')).pid;
    for (const pid of [ownedPid, child.pid].filter(Boolean)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await Promise.race([once(child, 'exit').catch(() => {}), delay(500)]);
  });
  const record = await until(() => {
    if (existsSync(recordFile)) return JSON.parse(readFileSync(recordFile, 'utf8'));
    if (child.exitCode !== null) assert.fail(`launcher exited before starting child: ${output}`);
    return null;
  }, 'owned pnpm child');
  ownedPid = record.pid;
  return {
    ...f,
    rendererPort,
    debugPort,
    child,
    record,
    output: () => output,
    setState: (value) => {
      writeFileSync(`${controlPath}.tmp`, JSON.stringify(value));
      renameSync(`${controlPath}.tmp`, controlPath);
    },
  };
}

function finalRecord(output, token) {
  const line = output.split(/\r?\n/).find((value) => value.startsWith(`${token} `));
  assert.ok(line, `missing final ${token} JSON record:\n${output}`);
  return JSON.parse(line.slice(token.length + 1));
}

function assertOwnedFinal(f, token) {
  const output = f.output();
  assert.equal(output.split(token).length - 1, 1, `must publish exactly one ${token}:\n${output}`);
  const record = finalRecord(output, token);
  assert.equal(record.rendererPort, f.rendererPort);
  assert.equal(record.debugPort, f.debugPort);
  assert.equal(record.childPid, f.record.pid);
  assert.deepEqual(record.debugPids, [f.record.pid]);
  assert.deepEqual(record.rendererPids, [f.record.pid]);
  assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
  return record;
}

test(
  'ordinary shared launcher preserves valid Vite dependency cache through real preflight and spawn',
  { timeout: 7000 },
  async (t) => {
    const f = await launch(t);
    assert.equal(
      f.record.cache,
      'preoptimized-dependency-v1\n',
      'ordinary start destroyed the valid optimized dependency cache before spawning renderer'
    );
    assert.equal(
      readFileSync(join(f.appDir, 'node_modules/.vite/deps/cache-sentinel.js'), 'utf8'),
      f.record.cache
    );
  }
);

test('native output reuse requires unchanged real inputs and every output byte', async (t) => {
  const modulePath = join(scriptsSource, 'dev-native-build-cache.cjs');
  assert.ok(existsSync(modulePath), 'shared launcher has no native output validity contract');
  const cache = require(modulePath);
  assert.equal(typeof cache.recordNativeBuild, 'function');
  assert.equal(typeof cache.inspectNativeBuild, 'function');
  const f = fixture(t);
  assert.equal(cache.inspectNativeBuild(f).reusable, false, 'unrecorded output cannot be reused');
  cache.recordNativeBuild(f);
  assert.equal(
    cache.inspectNativeBuild(f).reusable,
    true,
    'fresh recorded output should be reusable'
  );
  const original = readFileSync(join(f.appDir, 'src/main/worker.ts'));
  const before = statSync(join(f.appDir, 'src/main/worker.ts'));
  put(f.appDir, 'src/main/worker.ts', original.toString().replace('one', 'two'));
  utimesSync(join(f.appDir, 'src/main/worker.ts'), before.atime, before.mtime);
  assert.equal(
    cache.inspectNativeBuild(f).reusable,
    false,
    'equal-size source mutation with restored mtime must invalidate'
  );
  put(f.appDir, 'src/main/worker.ts', original);
  assert.equal(cache.inspectNativeBuild(f).reusable, true);
  const changes = [
    [f.appDir, 'src/main/new-worker.ts'],
    [f.appDir, 'src/preload/index.ts'],
    [f.appDir, 'src/shared/contract.ts'],
    [f.appDir, 'electron.vite.config.ts'],
    [f.appDir, 'tsconfig.node.json'],
    [f.appDir, 'package.json'],
    [f.appDir, 'distribution.json'],
    [f.appDir, 'update-authority.json'],
    [f.appDir, '.env.local'],
    [f.appDir, 'scripts/background-electron-launch.cjs'],
    [f.repoRoot, 'pnpm-lock.yaml'],
    [f.repoRoot, 'pnpm-workspace.yaml'],
    [f.repoRoot, 'tsconfig.base.json'],
    [f.repoRoot, 'packages/core/startup-fixture/src/index.ts'],
    [f.repoRoot, 'packages/core/startup-leaf/src/index.ts'],
    [f.appDir, 'node_modules/electron/package.json'],
    [f.appDir, 'node_modules/electron-vite/package.json'],
    [f.appDir, 'out/main/index.js'],
    [f.appDir, 'out/main/product-initial.js'],
    [f.appDir, 'out/main/chunks/worker.js'],
    [f.appDir, 'out/preload/index.js'],
  ];
  for (const [root, relative] of changes) {
    const file = join(root, relative);
    const bytes = existsSync(file) ? readFileSync(file) : null;
    put(
      root,
      relative,
      bytes ? Buffer.concat([bytes, Buffer.from('\nchanged\n')]) : 'new native input'
    );
    const verdict = cache.inspectNativeBuild(f);
    assert.equal(verdict.reusable, false, `${relative} changed but native output was reused`);
    assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0);
    if (bytes) writeFileSync(file, bytes);
    else rmSync(file);
    assert.equal(
      cache.inspectNativeBuild(f).reusable,
      true,
      `${relative} restore did not restore validity`
    );
  }
  for (const relative of [
    'src/main/index.ts',
    'electron.vite.config.ts',
    'out/main/index.js',
    'out/main/chunks/worker.js',
    'out/preload/index.js',
  ]) {
    const file = join(f.appDir, relative);
    renameSync(file, `${file}.saved`);
    assert.equal(
      cache.inspectNativeBuild(f).reusable,
      false,
      `missing ${relative} must fail closed`
    );
    renameSync(`${file}.saved`, file);
  }
  for (const [key, value] of [
    ['SENTRY_DSN', 'https://changed@example.invalid/2'],
    ['NODE_ENV', 'production'],
    ['DESKTOP_DEV_PORT', '1592'],
    ['DNAFORGE_DEV_TARGET', 'hosted-staging'],
  ]) {
    assert.equal(
      cache.inspectNativeBuild({ ...f, env: { ...f.env, [key]: value } }).reusable,
      false,
      `changed build environment ${key} must invalidate`
    );
  }
  const missing = fixture(t);
  rmSync(join(missing.appDir, 'out/preload/index.js'));
  assert.throws(
    () => cache.recordNativeBuild(missing),
    /preload|output|missing/i,
    'a partial native build cannot create a usable receipt'
  );
});

for (const warm of [false, true]) {
  test(
    `${warm ? 'warm' : 'cold'} launch waits for the real shell acknowledgement before one owned ready result`,
    { timeout: 20000 },
    async (t) => {
      const f = await launch(t, {
        warm,
        timeoutMs: 10000,
        state: { pageLoaded: true, shellReady: false },
      });
      await delay(180);
      assert.ok(
        !f.output().includes(readyToken),
        `HTML and a CDP page are not shell readiness:\n${f.output()}`
      );
      f.setState({ pageLoaded: true, shellReady: true, loadId: '' });
      await delay(100);
      assert.ok(
        !f.output().includes(readyToken),
        'an acknowledgement without a load identity is not ready'
      );
      f.setState({ pageLoaded: true, shellReady: true, loadId: 'dev-stack-current-load' });
      try {
        await until(() => f.output().includes(readyToken), 'final shell ready', 12000);
      } catch (error) {
        const diagnosticFile = (name) => {
          try {
            const file = join(f.appDir, name);
            return existsSync(file) ? readFileSync(file, 'utf8') : '<missing>';
          } catch (readError) {
            return `<unreadable: ${readError.message}>`;
          }
        };
        error.message += `\nLauncher output:\n${f.output()}\nFinal launch-control.json:\n${diagnosticFile('launch-control.json')}\nCDP requests:\n${diagnosticFile('cdp-requests.jsonl')}`;
        throw error;
      }
      assertOwnedFinal(f, readyToken);
      assert.ok(!f.output().includes(failureToken));
      assert.equal(
        f.record.args.includes('--rendererOnly'),
        warm,
        `only validated warm output may bypass native compilation:\n${f.output()}`
      );
      assert.match(
        readFileSync(join(f.appDir, 'cdp-requests.jsonl'), 'utf8'),
        /electronAPI.*startup(?:\?\.|\.)getState/
      );
    }
  );
}

test(
  'a blank renderer reaches a concrete bounded failure instead of ready',
  { timeout: 7000 },
  async (t) => {
    const f = await launch(t, { state: { pageLoaded: false, shellReady: false }, timeoutMs: 800 });
    await until(() => f.output().includes(failureToken), 'bounded startup failure', 3500);
    const final = assertOwnedFinal(f, failureToken);
    assert.match(final.reason, /timeout|deadline|shell|ready/i);
    assert.ok(final.elapsedMs < 3000, 'startup deadline must bound the final outcome');
    assert.ok(!f.output().includes(readyToken));
  }
);

test(
  'an exited launcher child produces a concrete final failure rather than silent exit',
  { timeout: 7000 },
  async (t) => {
    const f = await launch(t, { state: { exitCode: 23 }, timeoutMs: 1500 });
    await until(() => f.output().includes(failureToken), 'child exit failure', 3200);
    const final = finalRecord(f.output(), failureToken);
    assert.equal(final.childPid, f.record.pid);
    assert.match(final.reason, /exit|23/i);
    assert.ok(!f.output().includes(readyToken));
  }
);
