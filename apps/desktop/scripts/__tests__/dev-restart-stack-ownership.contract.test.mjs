import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const appSource = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptsSource = join(appSource, 'scripts');
const stackFixture = join(scriptsSource, '__tests__/fixtures/dev-restart-stack-child.cjs');
const stubbornMainFixture = join(scriptsSource, '__tests__/fixtures/dev-restart-stubborn-main.cjs');

function put(root, relative, value) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  );
  return file;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function until(read, label, output, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${label}:\n${output()}`);
}

for (const stubbornMain of [false, true]) {
  test(
    stubbornMain
      ? 'explicit stale restart escalates a main that ignores SIGTERM and preserves unrelated service'
      : 'stale restart releases the entire owned stack before replacement and preserves unrelated service',
    { timeout: stubbornMain ? 15000 : 12000 },
    async (t) => {
      const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dev-stack-restart-')));
      const appDir = join(repoRoot, 'apps/desktop');
      const unrelatedDir = join(repoRoot, 'unrelated-service');
      mkdirSync(unrelatedDir, { recursive: true });
      const children = [];
      let output = '';
      let replacementPid;
      t.after(async () => {
        if (existsSync(join(appDir, 'replacement-boundary.json'))) {
          replacementPid = JSON.parse(
            readFileSync(join(appDir, 'replacement-boundary.json'), 'utf8')
          ).pid;
        }
        if (replacementPid) {
          try {
            process.kill(replacementPid, 'SIGTERM');
          } catch {}
        }
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        }
        await Promise.all(
          children.map((child) =>
            child.exitCode !== null || child.signalCode !== null
              ? null
              : Promise.race([once(child, 'exit'), delay(500)])
          )
        );
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await Promise.race([once(child, 'exit'), delay(500)]);
          }
        }
        rmSync(repoRoot, { recursive: true, force: true });
      });
      for (const name of [
        'dev-single-instance-guard.cjs',
        'dev-windows-stack.cjs',
        'dev-launch-profile.cjs',
        'background-electron-launch.cjs',
        'background-window-policy.cjs',
        'dev-app-runtime.cjs',
        '../src/main/automation-profile.cjs',
        'dev-native-build-cache.cjs',
      ])
        copyFileSync(join(scriptsSource, name), put(appDir, `scripts/${name}`, ''));
      copyFileSync(
        resolve(appSource, '../../scripts/check-worktree-port-identity.mjs'),
        put(repoRoot, 'scripts/check-worktree-port-identity.mjs', '')
      );
      for (const name of ['prepare-opendataloader-runtime.cjs', 'ensure-dugite-git.cjs']) {
        put(appDir, `scripts/${name}`, 'process.stdout.write("fixture preflight complete\\n");\n');
      }
      put(appDir, 'node_modules/electron/package.json', { main: 'index.cjs' });
      put(appDir, 'node_modules/electron/index.cjs', 'module.exports = process.execPath;\n');
      put(appDir, 'launch-control.json', {
        pageLoaded: true,
        shellReady: true,
        loadId: 'dev-stack-replacement-load',
      });
      const ports = {};
      for (const role of ['main', 'renderer', 'hmr', 'api']) ports[role] = await freePort();
      const unrelatedPort = await freePort();
      put(
        appDir,
        '.env.local',
        `DESKTOP_DEV_PORT=${ports.renderer}\nDESKTOP_DEBUG_PORT=${ports.main}\nDESKTOP_HMR_PORT=${ports.hmr}\nAPI_PORT=${ports.api}\nVITE_API_URL=http://127.0.0.1:${ports.api}\n`
      );
      const oldPids = {};
      for (const role of ['main', 'renderer', 'hmr', 'api', 'unrelated']) {
        const cwd = role === 'unrelated' ? unrelatedDir : appDir;
        const record = join(repoRoot, `${role}.json`);
        const child = spawn(
          process.execPath,
          [
            role === 'main' && stubbornMain ? stubbornMainFixture : stackFixture,
            role,
            String(role === 'unrelated' ? unrelatedPort : ports[role]),
            String(ports.renderer),
            record,
          ],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        children.push(child);
        child.stderr.on('data', (bytes) => {
          output += bytes;
        });
        const started = await until(
          () => existsSync(record) && JSON.parse(readFileSync(record, 'utf8')),
          `old ${role} listener`,
          () => output
        );
        assert.equal(started.cwd, cwd);
        assert.equal(started.pid, child.pid);
        if (role !== 'unrelated') oldPids[role] = child.pid;
      }
      const unrelated = children.at(-1);
      const configPath = put(appDir, 'restart-contract.json', {
        ports,
        oldPids,
        unrelatedPort,
        unrelatedPid: unrelated.pid,
      });
      const pnpm = put(repoRoot, 'bin/pnpm', readFileSync(stackFixture));
      chmodSync(pnpm, 0o755);
      const successFixture = put(
        repoRoot,
        'bin/ready-child.cjs',
        readFileSync(join(scriptsSource, '__tests__/fixtures/dev-launch-child.cjs'))
      );
      const launcher = spawn(
        process.execPath,
        [join(appDir, 'scripts/dev-single-instance-guard.cjs'), '--restart-stale'],
        {
          cwd: appDir,
          env: {
            PATH: `${join(repoRoot, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
            HOME: repoRoot,
            NODE_ENV: 'test',
            DNAFORGE_DEV_STARTUP_TIMEOUT_MS: '3000',
            DEV_STACK_RESTART_CONFIG: configPath,
            DEV_STACK_SUCCESS_FIXTURE: successFixture,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      children.push(launcher);
      launcher.stdout.on('data', (bytes) => {
        output += bytes;
      });
      launcher.stderr.on('data', (bytes) => {
        output += bytes;
      });
      const ignoredSignalFile = join(repoRoot, 'main.json.signals');
      if (stubbornMain) {
        await until(
          () => existsSync(ignoredSignalFile),
          'stale main receiving SIGTERM',
          () => output
        );
        const ignored = JSON.parse(readFileSync(ignoredSignalFile, 'utf8'));
        assert.equal(ignored.pid, oldPids.main);
        assert.deepEqual(ignored.ignored, ['SIGTERM']);
      }
      const boundaryFile = join(appDir, 'replacement-boundary.json');
      const boundary = await until(
        () => {
          if (existsSync(boundaryFile)) return JSON.parse(readFileSync(boundaryFile, 'utf8'));
          if (launcher.exitCode !== null || launcher.signalCode !== null) {
            assert.fail(`explicit stale restart exited before replacement:\n${output}`);
          }
          return null;
        },
        'replacement launch boundary',
        () => output
      );
      replacementPid = boundary.pid;
      assert.match(output, /ELECTRON_DEV_STALE_RENDERER/);
      assert.equal(boundary.unrelatedAlive, true, 'restart killed an unrelated PID');
      assert.equal(boundary.unrelatedListening, true, 'restart stopped an unrelated listener');
      assert.equal(
        await (await fetch(`http://127.0.0.1:${unrelatedPort}`)).text(),
        'dev-stack-unrelated'
      );
      assert.deepEqual(
        boundary.oldAlive,
        [],
        `replacement launched while old owned processes remained alive:\n${JSON.stringify(boundary, null, 2)}\n${output}`
      );
      assert.deepEqual(
        boundary.ports.filter((entry) => entry.bound),
        [],
        'every old stack port must be free before replacement launch'
      );
      await until(
        () => output.includes('ELECTRON_DEV_READY '),
        'replacement shell acknowledgement',
        () => output
      );
      const line = output.split(/\r?\n/).find((value) => value.startsWith('ELECTRON_DEV_READY '));
      const ready = JSON.parse(line.slice('ELECTRON_DEV_READY '.length));
      assert.equal(ready.childPid, replacementPid);
      assert.deepEqual(ready.debugPids, [replacementPid]);
      assert.deepEqual(ready.rendererPids, [replacementPid]);
      assert.ok(!output.includes('ELECTRON_DEV_START_FAILED'), output);
      assert.equal(unrelated.exitCode, null);
      assert.equal(
        await (await fetch(`http://127.0.0.1:${unrelatedPort}`)).text(),
        'dev-stack-unrelated'
      );
    }
  );
}
