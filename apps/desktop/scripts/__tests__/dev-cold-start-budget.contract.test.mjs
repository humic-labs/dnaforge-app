import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as url from 'node:url';
import vm from 'node:vm';

const guardPath = url.fileURLToPath(new URL('../dev-single-instance-guard.cjs', import.meta.url));
const guardSource = readFileSync(guardPath, 'utf8');

async function driveReadiness({ timeout, readyAt = 150_000, exitAt = Infinity } = {}) {
  const startedAt = 1_000_000;
  let now = startedAt;
  const child = { pid: 4242, exitCode: null, signalCode: null };
  const observed = { probes: 0, acknowledgements: 0, sleeps: 0 };
  const unavailable = new Proxy(Object.create(null), {
    get(_target, name) {
      return () => {
        throw new Error(`Unexpected external I/O: ${String(name)}`);
      };
    },
  });
  const require = (name) => {
    if (name === 'node:path') return path;
    if (name === 'node:url') return url;
    return unavailable;
  };
  require.main = {};
  const hooks = {
    async probe() {
      observed.probes++;
      return {
        kind: now - startedAt >= 80_000 ? 'healthy' : 'empty',
        debugPids: [child.pid],
        rendererPids: [child.pid],
        targetPage: { webSocketDebuggerUrl: 'ws://127.0.0.1:47111/test' },
      };
    },
    async acknowledge() {
      observed.acknowledgements++;
      return {
        pageLoaded: true,
        shellReady: now - startedAt >= readyAt,
        loadId: 'cold-source-start',
      };
    },
    async sleep(milliseconds) {
      assert.ok(Number.isFinite(milliseconds) && milliseconds > 0);
      observed.sleeps++;
      now += milliseconds;
      if (now - startedAt >= exitAt) child.exitCode = 23;
      assert.ok(now - startedAt <= 15 * 60_000, 'startup remains bounded for a hung child');
    },
  };
  const context = vm.createContext({
    require,
    module: { exports: {} },
    __filename: guardPath,
    __dirname: path.dirname(guardPath),
    process: {
      env: timeout === undefined ? {} : { DNAFORGE_DEV_STARTUP_TIMEOUT_MS: String(timeout) },
      platform: process.platform,
      execPath: process.execPath,
    },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    hooks,
  });
  new vm.Script(guardSource, { filename: guardPath }).runInContext(context);
  vm.runInContext(
    'probe = hooks.probe; readStartupAcknowledgement = hooks.acknowledge; sleep = hooks.sleep;',
    context
  );
  const outcome = await context.module.exports.waitForDevReady({
    child,
    startedAt,
    rendererPort: 1420,
    debugPort: 47111,
  });
  return { outcome, observed };
}

test('cold source startup waits for the renderer shell beyond two minutes by default', async () => {
  const { outcome, observed } = await driveReadiness();
  assert.equal(outcome.ready, true, JSON.stringify({ outcome, observed }));
  assert.equal(outcome.loadId, 'cold-source-start');
  assert.ok(outcome.elapsedMs >= 150_000);
  assert.ok(observed.probes > 0 && observed.acknowledgements > 0);
});

test('an explicit shorter startup deadline still refuses a late renderer shell', async () => {
  const { outcome } = await driveReadiness({ timeout: 90_000 });
  assert.equal(outcome.ready, false);
  assert.match(outcome.reason, /Startup deadline exceeded/u);
  assert.ok(outcome.elapsedMs >= 90_000 && outcome.elapsedMs < 91_000);
  assert.equal(outcome.loadId, undefined);
});

test('a launcher child that exits during compilation fails promptly', async () => {
  const { outcome } = await driveReadiness({ exitAt: 45_000 });
  assert.equal(outcome.ready, false);
  assert.match(outcome.reason, /Launcher child exited: 23/u);
  assert.ok(outcome.elapsedMs >= 45_000 && outcome.elapsedMs < 46_000);
});

test('healthy renderer transport without a ready shell fails within a finite default deadline', async () => {
  const { outcome, observed } = await driveReadiness({ readyAt: Infinity });
  assert.equal(outcome.ready, false);
  assert.match(outcome.reason, /Startup deadline exceeded/u);
  assert.ok(outcome.elapsedMs > 0 && outcome.elapsedMs <= 15 * 60_000);
  assert.ok(observed.acknowledgements > 0);
  assert.equal(outcome.loadId, undefined);
});
