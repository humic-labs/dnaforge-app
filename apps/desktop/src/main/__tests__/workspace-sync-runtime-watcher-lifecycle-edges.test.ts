import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));

import { WorkspaceSyncRuntime } from '../workspace-sync-runtime';

const fixtures: Array<{
  db: ReturnType<typeof createTestDb>;
  runtime: WorkspaceSyncRuntime;
  gates: Array<{ resolve: () => void; reject: (error: Error) => void }>;
}> = [];
function fixture() {
  const db = createTestDb();
  const gates: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const watcher = {
    ensureWatching: vi.fn(
      () =>
        new Promise<undefined>((resolve, reject) => {
          gates.push({ resolve: () => resolve(undefined), reject });
        })
    ),
    stopWatching: vi.fn(),
    stopAll: vi.fn(),
  };
  const runtime = new WorkspaceSyncRuntime(db, {
    deviceId: 'edge-device',
    appVersion: '1.0.0',
    watcher,
    getActiveAccountId: () => null,
  });
  const result = { db, runtime, watcher, gates };
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.gates.forEach((gate) => gate.resolve());
    await f.runtime.stop();
    f.db.close();
  }
});

it('drains one workspace public initialization without waiting for another root', async () => {
  const f = fixture();
  const first = f.runtime.ensureWatchingWorkspace('A');
  const second = f.runtime.ensureWatchingWorkspace('B');
  let secondSettled = false;
  const secondIdle = f.runtime.waitForIdle('B').then(() => {
    secondSettled = true;
  });
  f.gates[0].resolve();
  await first;
  await f.runtime.waitForIdle('A');
  expect(secondSettled).toBe(false);
  f.gates[1].resolve();
  await Promise.all([second, secondIdle]);
});

it('retains both generations in the runtime drain until each public start settles', async () => {
  const f = fixture();
  const old = f.runtime.ensureWatchingWorkspace('A');
  f.runtime.stopWatchingWorkspace('A');
  const current = f.runtime.ensureWatchingWorkspace('A');
  let drained = false;
  const idle = f.runtime.waitForIdle('A').then(() => {
    drained = true;
  });
  f.gates[1].resolve();
  await current;
  await Promise.resolve();
  expect(drained).toBe(false);
  f.gates[0].resolve();
  await Promise.all([old, idle]);
  expect(drained).toBe(true);
});

it('removes a rejected public initialization from subsequent idle and stop waits', async () => {
  const f = fixture();
  const pending = f.runtime.ensureWatchingWorkspace('A');
  const rejection = expect(pending).rejects.toThrow('initialization failed');
  f.gates[0].reject(new Error('initialization failed'));
  await rejection;
  await f.runtime.waitForIdle('A');
  await f.runtime.stop();
  await expect(f.runtime.ensureWatchingWorkspace('A')).resolves.toBeUndefined();
  expect(f.watcher.ensureWatching).toHaveBeenCalledOnce();
});
