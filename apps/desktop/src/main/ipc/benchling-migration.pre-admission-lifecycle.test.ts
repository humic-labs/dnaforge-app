import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  owners: new Map<unknown, unknown>(),
  path: vi.fn(async (path: string) => path),
  dialog: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (sender: unknown) => transport.owners.get(sender) },
  dialog: { showOpenDialog: transport.dialog },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test', exit: vi.fn() },
}));
vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (contract: { name: string }, handlers: Record<string, Function>) => {
    for (const [name, handler] of Object.entries(handlers))
      transport.handlers.set(contract.name + ':' + name, handler);
    return () => {};
  },
  mainIpc: { on: vi.fn(), handle: vi.fn() },
  sendRendererIpc: vi.fn(),
}));
vi.mock('../boot-log', () => ({ appendBootLog: vi.fn() }));
vi.mock('../diagnostics-upload', () => ({ notifyBootSucceeded: vi.fn() }));
vi.mock('./path-allowlist', () => ({ assertSafePath: transport.path }));
vi.mock('@sentry/electron/main', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  getCurrentScope: () => ({ setTag: vi.fn(), setContext: vi.fn() }),
}));
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { MigrationStore } from '../benchling-migration/store';
import { buildSyntheticNativeExportZip } from '../benchling-migration/__fixtures__/native-export-zip-fixture';
import * as lease from '../workspace-sync-mutation-lease';
import { LocalBenchlingMigrationCoordinator } from '../benchling-migration/coordinator';
import { registerBenchlingMigrationHandlers } from './benchling-migration';
import * as nativeOwner from './shell-readiness';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dna2393-append-quiescent-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'Keep.txt'), 'Unrelated scientific source α 007');
  const zip = join(root, 'source.zip');
  writeFileSync(
    zip,
    buildSyntheticNativeExportZip([
      {
        path: 'Notebook (etr_contract01)/entry.html',
        bytes: '<html><body><h1>Test</h1><p>α 007</p></body></html>',
      },
    ]).bytes
  );
  const db = createTestDb();
  cleanup.push(() => db.close());
  ensureSchema(db, ':memory:');
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES(7,'Existing',?,1)").run(
    workspace
  );
  const migrationDb = createTestDb();
  cleanup.push(() => migrationDb.close());
  const store = new MigrationStore(migrationDb);
  const openStore = vi.fn(() => store);
  const append = vi.fn(async (run: import('../../shared/benchling-migration').MigrationRun) => run);
  const coordinator = new LocalBenchlingMigrationCoordinator({
    globalDb: db,
    managedRootDir: root,
    openStore,
    appendWorkspaceExports: append,
    renderValidator: async () => [],
    discardWorkspace: async () => undefined,
  });
  return { root, workspace, zip, db, store, openStore, append, coordinator };
}
beforeEach(() => {
  transport.handlers.clear();
  transport.owners.clear();
  transport.path.mockReset().mockImplementation(async (path: string) => path);
  transport.dialog.mockReset();
});
async function subject() {
  const f = fixture();
  let destroyed = false;
  const url = 'file:///app/renderer/index.html';
  const frame = { url };
  const contents = Object.assign(new EventEmitter(), {
    id: 42,
    mainFrame: frame,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    getURL: () => frame.url,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => destroyed,
  });
  transport.owners.set(contents, window);
  Reflect.apply(nativeOwner.installShellReadiness, undefined, [window, url]);
  contents.emit(
    'did-start-navigation',
    { isMainFrame: true, isSameDocument: false },
    url,
    false,
    true
  );
  let expected: unknown = window;
  const getMainWindow = () => expected;
  const prepare = vi.fn(async (path: string) => ({
    archivePath: path,
    sourceDisplayName: 'source.zip',
    managed: false,
  }));
  Reflect.apply(registerBenchlingMigrationHandlers, undefined, [
    { coordinator: f.coordinator, getMainWindow, prepareLocalExportSource: prepare },
  ]);
  const handler = transport.handlers.get('benchlingMigration:importLocalBundle');
  assert(handler);
  const event = { sender: contents, senderFrame: frame };
  const call = (ev: unknown = event, request: unknown = { sourcePath: f.zip, workspaceDbId: 7 }) =>
    Reflect.apply(handler, undefined, [ev, request]);
  const invoke = vi.spyOn(f.coordinator, 'importLocalBundleToWorkspace');
  return {
    ...f,
    contents,
    frame,
    window,
    event,
    call,
    prepare,
    invoke,
    setExpected(value: unknown) {
      expected = value;
    },
    destroy() {
      destroyed = true;
      contents.emit('destroyed');
    },
  };
}
function observe(promise: Promise<unknown>) {
  const box: { kind: string; value?: unknown; error?: unknown } = { kind: 'pending' };
  void promise.then(
    (value) => Object.assign(box, { kind: 'resolved', value }),
    (error) => Object.assign(box, { kind: 'rejected', error })
  );
  return box;
}
function navigate(f: Awaited<ReturnType<typeof subject>>, kind: string) {
  if (kind === 'destroy') f.destroy();
  else if (kind === 'gone') f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  else
    f.contents.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: false },
      f.frame.url,
      false,
      true
    );
}
it.each(['foreign', 'copied-frame', 'subframe', 'untrusted-url', 'destroyed'] as const)(
  'actual IPC refuses %s before any source preparation or coordinator admission',
  async (kind) => {
    const f = await subject();
    let event: unknown = f.event;
    if (kind === 'foreign') {
      const foreign = Object.assign(new EventEmitter(), {
        id: 43,
        isDestroyed: () => false,
        mainFrame: { url: f.frame.url },
      });
      transport.owners.set(foreign, { webContents: foreign });
      event = { sender: foreign, senderFrame: foreign.mainFrame };
    }
    if (kind === 'copied-frame' || kind === 'subframe')
      event = { sender: f.contents, senderFrame: { url: f.frame.url } };
    if (kind === 'untrusted-url') f.frame.url = 'https://untrusted.invalid/';
    if (kind === 'destroyed') f.destroy();
    await expect(f.call(event)).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(transport.path).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.openStore).not.toHaveBeenCalled();
  }
);
it.each(['navigation', 'gone', 'destroy'] as const)(
  'document %s during source preparation aborts before coordinator/source intake',
  async (kind) => {
    const f = await subject();
    let finish:
      | ((value: { archivePath: string; sourceDisplayName: string; managed: boolean }) => void)
      | undefined;
    f.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const promise = f.call();
    const state = observe(promise);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    navigate(f, kind);
    assert(finish);
    finish({ archivePath: f.zip, sourceDisplayName: 'source.zip', managed: false });
    await expect(promise).rejects.toThrow();
    expect(state.kind).toBe('rejected');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.openStore).not.toHaveBeenCalled();
  }
);
it.each(['navigation', 'gone', 'destroy'] as const)(
  'native %s cancels actual queued coordinator acceptance and removes the waiter',
  async (kind) => {
    const f = await subject();
    const release = await lease.acquireWorkspaceMutationShared(f.workspace);
    const promise = f.call();
    const state = observe(promise);
    try {
      await vi.waitFor(() =>
        expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(1)
      );
      expect(f.openStore).not.toHaveBeenCalled();
      navigate(f, kind);
      await vi.waitFor(() => expect(state.kind).toBe('rejected'), { timeout: 1500, interval: 5 });
      expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(0);
      expect(f.openStore).not.toHaveBeenCalled();
      expect(f.append).not.toHaveBeenCalled();
    } finally {
      release();
      await promise.catch(() => undefined);
    }
  }
);
it('expected native main-window replacement while queued is revalidated before adoption', async () => {
  const f = await subject();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  const promise = f.call();
  observe(promise);
  try {
    await vi.waitFor(() => expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(1));
    f.setExpected({ webContents: { id: 999 } });
    release();
    await expect(promise).rejects.toThrow();
    expect(f.openStore).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  } finally {
    release();
    await promise.catch(() => undefined);
  }
});
it('pre-admission signal is native-owned and unchanged subframe/same-document activity does not cancel import', async () => {
  const f = await subject();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  const promise = f.call();
  observe(promise);
  try {
    await vi.waitFor(() => expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(1));
    const observedCall: readonly unknown[] = f.invoke.mock.calls[0] ?? [];
    const options = Reflect.get(observedCall, 3);
    assert(options && typeof options === 'object');
    const signal = Reflect.get(options, 'signal');
    assert(signal instanceof AbortSignal);
    expect(signal.aborted).toBe(false);
    f.contents.emit(
      'did-start-navigation',
      { isMainFrame: false, isSameDocument: false },
      f.frame.url,
      false,
      false
    );
    f.contents.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: true },
      f.frame.url,
      true,
      true
    );
    expect(signal.aborted).toBe(false);
    release();
    await promise;
    expect(f.append).toHaveBeenCalledOnce();
  } finally {
    release();
    await promise.catch(() => undefined);
  }
});
it('after adoption native document shutdown does not revoke the persisted background import', async () => {
  const f = await subject();
  let finish: ((value: unknown) => void) | undefined;
  f.append.mockImplementation(
    (run) =>
      new Promise((resolve) => {
        finish = () => resolve(run);
      })
  );
  const promise = f.call();
  observe(promise);
  try {
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
    expect(f.store.getRun()).not.toBeNull();
    navigate(f, 'navigation');
    assert(finish);
    finish(undefined);
    await expect(promise).resolves.toHaveProperty('run');
    expect(f.store.getRun()).not.toBeNull();
  } finally {
    finish?.(undefined);
    await promise.catch(() => undefined);
  }
});
it('repeat completed requests install one native lifecycle set rather than per-request listener leaks', async () => {
  const f = await subject();
  await f.call();
  const events = [
    'did-start-navigation',
    'did-frame-navigate',
    'did-stop-loading',
    'render-process-gone',
    'destroyed',
  ];
  const counts = events.map((name) => f.contents.listenerCount(name));
  for (let i = 0; i < 4; i++) await f.call();
  expect(events.map((name) => f.contents.listenerCount(name))).toEqual(counts);
  expect(f.append).toHaveBeenCalledTimes(5);
});
it.each([false, true])(
  'native picker acceptance preserves native admission options with reviewed choices %s',
  async (reviewed) => {
    const f = await subject();
    transport.dialog.mockResolvedValue({ canceled: false, filePaths: [f.zip] });
    const request = { workspaceDbId: 7, ...(reviewed ? { reviewedTables: [] } : {}) };
    const result = await f.call(undefined, request);
    expect(result).toHaveProperty('run');
    expect(transport.dialog).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    const call = f.invoke.mock.calls[0];
    assert(call);
    const options = Reflect.get(call, 3);
    assert(options && typeof options === 'object');
    expect(Reflect.get(options, 'signal')).toBeInstanceOf(AbortSignal);
    expect(Reflect.get(options, 'assertCurrent')).toBeTypeOf('function');
    expect(call[2]).toEqual(reviewed ? [] : undefined);
    expect(f.append).toHaveBeenCalledOnce();
  }
);
it('native picker navigation revocation prevents source preparation after user selection resolves', async () => {
  const f = await subject();
  let finish: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined;
  transport.dialog.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const promise = f.call(undefined, { workspaceDbId: 7 });
  observe(promise);
  await vi.waitFor(() => expect(transport.dialog).toHaveBeenCalledOnce());
  navigate(f, 'navigation');
  assert(finish);
  finish({ canceled: false, filePaths: [f.zip] });
  await expect(promise).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});
it('navigation during dropped-path authorization refuses before source preparation', async () => {
  const f = await subject();
  let finish: ((path: string) => void) | undefined;
  transport.path.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const promise = f.call();
  observe(promise);
  await vi.waitFor(() => expect(transport.path).toHaveBeenCalledOnce());
  navigate(f, 'navigation');
  assert(finish);
  finish(f.zip);
  await expect(promise).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});
