import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@sentry/electron/main', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  getCurrentScope: () => ({ setTag: vi.fn(), setContext: vi.fn() }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test', exit: vi.fn() },
}));
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { MigrationStore } from './store';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import * as lease from '../workspace-sync-mutation-lease';
import { LocalBenchlingMigrationCoordinator } from './coordinator';
import { acquireEligibleMigrationWorkspace } from './adopt-workspace-history';
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
function start(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  const state:
    | { kind: 'pending' }
    | { kind: 'resolved'; value: unknown }
    | { kind: 'rejected'; error: unknown } = { kind: 'pending' };
  const box: {
    state:
      | typeof state
      | { kind: 'resolved'; value: unknown }
      | { kind: 'rejected'; error: unknown };
  } = { state };
  const promise = Reflect.apply(f.coordinator.importLocalBundleToWorkspace, f.coordinator, [
    f.zip,
    7,
    undefined,
    { signal },
  ]);
  void promise.then(
    (value: unknown) => {
      box.state = { kind: 'resolved', value };
    },
    (error: unknown) => {
      box.state = { kind: 'rejected', error };
    }
  );
  return { box, promise };
}
async function queued(f: ReturnType<typeof fixture>, pending: ReturnType<typeof start>) {
  await vi.waitFor(
    () => {
      expect(pending.box.state.kind).toBe('pending');
      expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(1);
    },
    { timeout: 1500, interval: 5 }
  );
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  expect(readdirSync(f.workspace)).toEqual(['Keep.txt']);
  expect(readFileSync(join(f.workspace, 'Keep.txt'), 'utf8')).toBe(
    'Unrelated scientific source α 007'
  );
}
it.each(['shared', 'exclusive'] as const)(
  'accepted existing-workspace append waits for actual %s ownership before adoption',
  async (mode) => {
    const f = fixture();
    const release = await (mode === 'shared'
      ? lease.acquireWorkspaceMutationShared(f.workspace)
      : lease.acquireWorkspaceSyncMutationLease(f.workspace));
    cleanup.push(release);
    const pending = start(f);
    await queued(f, pending);
    release();
    const run = await pending.promise;
    expect(run.workspaceDbId).toBe(7);
    expect(run.workspacePath).toBe(f.workspace);
    expect(f.append).toHaveBeenCalledOnce();
    expect(f.openStore).toHaveBeenCalled();
    await vi.waitFor(() => expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(0));
    const next = lease.tryAcquireWorkspaceMutationShared(f.workspace);
    assert(next);
    next();
  }
);
it.each(['archived', 'trashed', 'path', 'repo'] as const)(
  'queued append rejects changed %s binding before adoption',
  async (kind) => {
    const f = fixture();
    const release = await lease.acquireWorkspaceMutationShared(f.workspace);
    cleanup.push(release);
    const pending = start(f);
    await queued(f, pending);
    if (kind === 'archived') f.db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=7').run();
    if (kind === 'trashed') f.db.prepare('UPDATE workspaces SET trashed_at=1 WHERE id=7').run();
    if (kind === 'path') {
      const other = join(f.root, 'other');
      mkdirSync(other);
      f.db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(other);
    }
    if (kind === 'repo')
      f.db.prepare("UPDATE workspaces SET repo_uuid='changed-repository' WHERE id=7").run();
    release();
    await expect(pending.promise).rejects.toThrow();
    expect(f.openStore).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
    const next = lease.tryAcquireWorkspaceMutationShared(f.workspace);
    assert(next);
    next();
  }
);
it('queued append rejects changed ZIP bytes before silent history adoption', async () => {
  const f = fixture();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  cleanup.push(release);
  const pending = start(f);
  await queued(f, pending);
  const bytes = readFileSync(f.zip);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(f.zip, bytes);
  release();
  await expect(pending.promise).rejects.toThrow();
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});
it('cancelled queued acceptance is removed and never adopts even after owner release', async () => {
  const f = fixture();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  cleanup.push(release);
  const abort = new AbortController();
  const pending = start(f, abort.signal);
  await queued(f, pending);
  abort.abort();
  await expect(pending.promise).rejects.toThrow();
  expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(0);
  release();
  await Promise.resolve();
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});
it('abort on lease grant is rechecked before any history adoption and releases ownership', async () => {
  const f = fixture();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  cleanup.push(release);
  const abort = new AbortController();
  const pending = start(f, abort.signal);
  await queued(f, pending);
  const unsubscribe = lease.subscribeWorkspaceMutationReleased((root) => {
    if (root === lease.workspaceMutationRootIdentity(f.workspace)) abort.abort();
  });
  cleanup.push(unsubscribe);
  release();
  unsubscribe();
  await expect(pending.promise).rejects.toThrow();
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  const next = lease.tryAcquireWorkspaceMutationShared(f.workspace);
  assert(next);
  next();
});
it('retains failclosed try/default admission and the existing bounded waiter limit', async () => {
  const f = fixture();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  cleanup.push(release);
  expect(lease.tryAcquireWorkspaceMutationShared(f.workspace)).toBeNull();
  await expect(acquireEligibleMigrationWorkspace(f.db, 7)).rejects.toThrow('workspace_busy');
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const waiters = Array.from({ length: lease.MAX_WORKSPACE_MUTATION_WAITERS_PER_ROOT }, () =>
    lease
      .waitForWorkspaceMutationShared(f.workspace, { signal: abort.signal })
      .catch((error) => error)
  );
  expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(64);
  await expect(lease.waitForWorkspaceMutationShared(f.workspace)).rejects.toThrow(
    'WORKSPACE_MUTATION_WAIT_QUEUE_FULL'
  );
  abort.abort();
  await Promise.all(waiters);
  expect(lease.workspaceMutationWaiterCountForTest(f.workspace)).toBe(0);
});
it('accepted coordinator append retains owner waiter capacity rejection without adoption', async () => {
  const f = fixture();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  cleanup.push(release);
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const waiters = Array.from({ length: lease.MAX_WORKSPACE_MUTATION_WAITERS_PER_ROOT }, () =>
    lease
      .waitForWorkspaceMutationShared(f.workspace, { signal: abort.signal })
      .catch((error) => error)
  );
  const pending = start(f);
  await expect(pending.promise).rejects.toThrow('WORKSPACE_MUTATION_WAIT_QUEUE_FULL');
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  abort.abort();
  await Promise.all(waiters);
});
