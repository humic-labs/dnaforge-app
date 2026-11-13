import assert from 'node:assert/strict';
import {
  renameSync,
  symlinkSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
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
it('queued workspace root replacement cannot transfer the held old-root lease to a new symlink target', async () => {
  const f = fixture();
  const release = await lease.acquireWorkspaceMutationShared(f.workspace);
  cleanup.push(release);
  const pending = start(f);
  await queued(f, pending);
  const original = join(f.root, 'original-root');
  renameSync(f.workspace, original);
  const other = join(f.root, 'other-root');
  mkdirSync(other);
  writeFileSync(join(other, 'Keep.txt'), 'Other scientific workspace');
  symlinkSync(other, f.workspace, 'dir');
  release();
  await expect(pending.promise).rejects.toThrow();
  expect(f.openStore).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  expect(readFileSync(join(other, 'Keep.txt'), 'utf8')).toBe('Other scientific workspace');
  expect(readFileSync(join(original, 'Keep.txt'), 'utf8')).toBe(
    'Unrelated scientific source α 007'
  );
});
