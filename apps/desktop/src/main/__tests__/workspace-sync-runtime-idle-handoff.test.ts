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
import { createTestDb } from './test-db';
import { WorkspaceSyncRuntime } from '../workspace-sync-runtime';
it('keeps the idle barrier pending for a public start admitted while the upload-worker drain is pending', async () => {
  const db = createTestDb();
  let releaseStart: () => void = () => {};
  let releaseUpload: () => void = () => {};
  const watcher = {
    ensureWatching: vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          releaseStart = () => resolve(undefined);
        })
    ),
    stopWatching: vi.fn(),
    stopAll: vi.fn(),
  };
  const runtime = new WorkspaceSyncRuntime(db, {
    deviceId: 'independent-review',
    appVersion: '1.0.0',
    watcher,
    getActiveAccountId: () => null,
  });
  const worker = Reflect.get(runtime, 'uploadWorker') as {
    waitForIdle(workspaceUuid?: string): Promise<void>;
  };
  const drain = vi.spyOn(worker, 'waitForIdle').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseUpload = resolve;
      })
  );
  let idleSettled = false;
  let startSettled = false;
  const idle = runtime.waitForIdle('A').then(() => {
    idleSettled = true;
  });
  expect(drain).toHaveBeenCalledOnce();
  const start = runtime.ensureWatchingWorkspace('A').then(() => {
    startSettled = true;
  });
  try {
    releaseUpload();
    for (let n = 0; n < 8; n += 1) await Promise.resolve();
    console.log(
      JSON.stringify({
        idleSettled,
        startSettled,
        starts: watcher.ensureWatching.mock.calls.length,
      })
    );
    expect(idleSettled).toBe(false);
    releaseStart();
    await Promise.all([idle, start]);
  } finally {
    releaseStart();
    releaseUpload();
    await Promise.all([idle, start]);
    await runtime.stop();
    db.close();
  }
});
