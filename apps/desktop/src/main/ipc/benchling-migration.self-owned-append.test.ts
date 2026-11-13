import assert from 'node:assert/strict';
import {
  symlinkSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
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
import { workspaceMutationCapabilities as registry } from './workspace-mutation-capability';
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
function own(f: Awaited<ReturnType<typeof subject>>, root: string, owner = f.contents.id) {
  return lease.acquireWorkspaceMutationShared(root).then((release) => {
    const canonical = lease.workspaceMutationRootIdentity(root);
    const token = registry.issue(owner, canonical, release);
    return { token, owner, canonical, release: () => registry.release(token, owner) };
  });
}
async function refusedBeforeRelease(
  f: Awaited<ReturnType<typeof subject>>,
  promise: Promise<unknown>
) {
  const state = observe(promise);
  await vi.waitFor(() => expect(state.kind).toBe('rejected'), { timeout: 1500, interval: 5 });
  await expect(promise).rejects.toThrow(/busy|mutation|already/i);
  expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(0);
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
}
it('same native caller owning the same root is refused before waiting and can append after release', async () => {
  const f = await subject();
  const held = await own(f, f.workspace);
  const promise = f.call();
  observe(promise);
  try {
    expect(registry.resolveOwnedWorkspaceRoot(held.token, f.contents.id)).toBe(held.canonical);
    expect(lease.tryAcquireWorkspaceMutationShared(f.workspace)).toBeNull();
    await refusedBeforeRelease(f, promise);
  } finally {
    held.release();
    await promise.catch(() => undefined);
  }
  await f.call();
  expect(f.append).toHaveBeenCalledOnce();
});
it('reentry tokens do not hide the same caller session owning the target root', async () => {
  const f = await subject();
  const held = await own(f, f.workspace);
  const second = registry.issueReentry(held.token, f.contents.id, held.canonical);
  assert(second);
  held.release();
  const promise = f.call();
  observe(promise);
  try {
    expect(registry.resolveOwnedWorkspaceRoot(second, f.contents.id)).toBe(held.canonical);
    await refusedBeforeRelease(f, promise);
  } finally {
    registry.release(second, f.contents.id);
    await promise.catch(() => undefined);
  }
});
it('closing tokenless session still holding an active physical operation rejects self-owned append', async () => {
  const f = await subject();
  const held = await own(f, f.workspace);
  let finish: (() => void) | undefined;
  const operation = registry.runWithToken(
    held.token,
    f.contents.id,
    held.canonical,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  assert(finish);
  held.release();
  expect(registry.resolveOwnedWorkspaceRoot(held.token, f.contents.id)).toBeNull();
  expect(registry.activeCountForTest(f.contents.id)).toBe(1);
  expect(lease.tryAcquireWorkspaceMutationShared(f.workspace)).toBeNull();
  const promise = f.call();
  observe(promise);
  try {
    await refusedBeforeRelease(f, promise);
  } finally {
    finish();
    await operation;
    await promise.catch(() => undefined);
  }
  expect(registry.activeCountForTest(f.contents.id)).toBe(0);
});
it('same caller canonical alias ownership is refused without accepting a different path spelling', async () => {
  const f = await subject();
  const alias = join(f.root, 'workspace-alias');
  symlinkSync(f.workspace, alias, 'dir');
  const held = await own(f, alias);
  const promise = f.call();
  observe(promise);
  try {
    expect(held.canonical).toBe(lease.workspaceMutationRootIdentity(f.workspace));
    await refusedBeforeRelease(f, promise);
  } finally {
    held.release();
    await promise.catch(() => undefined);
  }
});
it('same caller ownership of another root does not reject this idle target', async () => {
  const f = await subject();
  const other = join(f.root, 'other');
  mkdirSync(other);
  const held = await own(f, other);
  try {
    await expect(f.call()).resolves.toHaveProperty('run');
    expect(f.append).toHaveBeenCalledOnce();
    expect(registry.resolveOwnedWorkspaceRoot(held.token, f.contents.id)).toBe(held.canonical);
    expect(lease.tryAcquireWorkspaceMutationShared(other)).toBeNull();
  } finally {
    held.release();
  }
});
it.each(['foreign', 'native-background'] as const)(
  'accepted append still waits behind %s ownership instead of refusing it as self-owned',
  async (kind) => {
    const f = await subject();
    const release = await lease.acquireWorkspaceMutationShared(f.workspace);
    const token =
      kind === 'foreign'
        ? registry.issue(
            f.contents.id + 1,
            lease.workspaceMutationRootIdentity(f.workspace),
            release
          )
        : null;
    const promise = f.call();
    const state = observe(promise);
    try {
      await vi.waitFor(() =>
        expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(1)
      );
      expect(state.kind).toBe('pending');
      expect(f.openStore).not.toHaveBeenCalled();
      expect(f.append).not.toHaveBeenCalled();
      if (token) registry.release(token, f.contents.id + 1);
      else release();
      await expect(promise).resolves.toHaveProperty('run');
      expect(f.append).toHaveBeenCalledOnce();
    } finally {
      if (token) registry.release(token, f.contents.id + 1);
      else release();
      await promise.catch(() => undefined);
    }
  }
);
it('self-ownership acquired while native source preparation awaits is rechecked before queueing', async () => {
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
  observe(promise);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  const held = await own(f, f.workspace);
  assert(finish);
  finish({ archivePath: f.zip, sourceDisplayName: 'source.zip', managed: false });
  try {
    await refusedBeforeRelease(f, promise);
  } finally {
    held.release();
    await promise.catch(() => undefined);
  }
});
