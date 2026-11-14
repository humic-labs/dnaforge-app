import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import type { MigrationRun } from '../../shared/benchling-migration';
import { createFileTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { LocalBenchlingMigrationCoordinator } from './coordinator';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import {
  createLocalBenchlingExportIntakeDescriptor,
  intakeLocalBenchlingExportBundle,
} from './local-export-bundle';
import { createMigrationStagingWorkspace } from './staging-workspace';
import { transitionMigrationRun } from './state-machine';
import { migrationDatabasePath, MigrationStore } from './store';

const NOW = '2026-08-14T18:00:02.000Z';
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function readyRun(): MigrationRun {
  return {
    version: 1,
    id: 'migration-recovery',
    workspaceId: 'workspace-recovery',
    workspacePath: '/tmp/migration-recovery/repo',
    displayName: 'Recovery fixture',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: { id: 'local-export-recovery', url: 'urn:recovery', objectType: 'notebook' },
    },
    binding: null,
    state: 'ready_to_unlock',
    resumeState: null,
    attempt: 3,
    converterVersions: { artifact: '1' },
    createdAt: '2026-08-14T18:00:00.000Z',
    updatedAt: '2026-08-14T18:00:01.000Z',
    startedAt: '2026-08-14T18:00:00.000Z',
    unlockedAt: null,
    lastError: null,
    localExportArtifact: {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: 'source.zip',
      sha256: `sha256:${'1'.repeat(64)}`,
      sizeBytes: 1,
      immutableLocalPath: '/tmp/migration-recovery/source.zip',
      capturedAt: '2026-08-14T18:00:00.000Z',
      archive: { entryCount: 1, totalCompressedEntryBytes: 1, totalUncompressedEntryBytes: 1 },
      resources: [],
    },
  };
}

function failedRun(): MigrationRun {
  return transitionMigrationRun(readyRun(), 'failed', NOW, {
    code: 'internal_invariant',
    message: 'Migration execution failed internally.',
    blocking: true,
  });
}

function fileStore(run: MigrationRun) {
  const file = createFileTestDb('migration-recovery');
  cleanup.push(file.cleanup);
  const store = new MigrationStore(file.db);
  store.saveRun(run);
  return { store, file };
}

function retry(store: MigrationStore, run: MigrationRun): MigrationRun {
  const retryRun: MigrationRun = {
    ...run,
    state: 'parsing',
    resumeState: null,
    updatedAt: NOW,
    unlockedAt: null,
    lastError: null,
  };
  store.restoreFailedLocalRunForRetry({ failedRun: run, retryRun });
  return retryRun;
}

function rollback(store: MigrationStore, unlockedRun: MigrationRun, ready: MigrationRun): void {
  store.restoreReadyRunAfterFailedUnlock({ unlockedRun, readyRun: ready });
}

describe('migration recovery authority', () => {
  it('retries preserved ZIP evidence durably without changing source or attempt identity', () => {
    const failed = failedRun();
    const { store, file } = fileStore(failed);
    const resumed = retry(store, failed);
    expect(resumed).toEqual({
      ...failed,
      state: 'parsing',
      resumeState: null,
      updatedAt: NOW,
      unlockedAt: null,
      lastError: null,
    });
    file.db.close();
    const reopened = openFileTestDb(file.dbPath);
    cleanup.push(() => reopened.close());
    expect(new MigrationStore(reopened).getRun()).toEqual(resumed);
  });

  it.each(['state', 'issue', 'remote', 'missing-zip', 'html'] as const)(
    'rejects ineligible retry (%s) without writing',
    (reason) => {
      let failed = failedRun();
      if (reason === 'state') failed = { ...failed, state: 'discarded' };
      if (reason === 'issue') failed = { ...failed, lastError: null };
      if (reason === 'remote')
        failed = { ...failed, scope: { ...failed.scope, acquisition: undefined } };
      if (reason === 'missing-zip') failed = { ...failed, localExportArtifact: undefined };
      if (reason === 'html')
        failed = {
          ...failed,
          localExportArtifact: { ...failed.localExportArtifact!, format: 'html' },
        };
      const { store } = fileStore(failed);
      expect(() => retry(store, failed)).toThrow();
      expect(store.getRun()).toEqual(JSON.parse(JSON.stringify(failed)));
    }
  );

  it.each(['retry', 'rollback'] as const)(
    'rejects stale %s even when the state is unchanged',
    (kind) => {
      const ready = readyRun();
      const expected =
        kind === 'retry' ? failedRun() : transitionMigrationRun(ready, 'unlocked', NOW);
      const { store, file } = fileStore(expected);
      const otherDb = openFileTestDb(file.dbPath);
      cleanup.push(() => otherDb.close());
      const otherStore = new MigrationStore(otherDb);
      const newer = { ...expected, displayName: 'Updated by another connection' };
      otherStore.saveRun(newer);
      expect(() =>
        kind === 'retry' ? retry(store, expected) : rollback(store, expected, ready)
      ).toThrow('compare-and-set');
      expect(store.getRun()).toEqual(newer);
    }
  );

  it('restores the exact ready snapshot durably and permits the next unlock', () => {
    const ready = readyRun();
    const unlocked = { ...transitionMigrationRun(ready, 'unlocked', NOW), workspaceDbId: 7 };
    const { store, file } = fileStore(unlocked);
    rollback(store, unlocked, ready);
    expect(store.getRun()).toEqual(ready);
    expect(() => rollback(store, unlocked, ready)).toThrow('compare-and-set');
    file.db.close();
    const reopened = openFileTestDb(file.dbPath);
    cleanup.push(() => reopened.close());
    const recoveredStore = new MigrationStore(reopened);
    expect(recoveredStore.getRun()).toEqual(ready);
    recoveredStore.saveRun(unlocked);
    expect(recoveredStore.getRun()).toEqual(unlocked);
  });

  it.each(['source-state', 'target-state', 'run-id', 'source-identity'] as const)(
    'rejects invalid unlock rollback (%s) without writing',
    (reason) => {
      let ready = readyRun();
      const unlocked = transitionMigrationRun(ready, 'unlocked', NOW);
      const { store } = fileStore(unlocked);
      if (reason === 'target-state') ready = { ...ready, state: 'parsing' };
      if (reason === 'run-id') ready = { ...ready, id: 'another-run' };
      if (reason === 'source-identity')
        ready = {
          ...ready,
          localExportArtifact: {
            ...ready.localExportArtifact!,
            sha256: `sha256:${'2'.repeat(64)}`,
          },
        };
      expect(() => rollback(store, reason === 'source-state' ? ready : unlocked, ready)).toThrow();
      expect(store.getRun()).toEqual(unlocked);
    }
  );

  it.each(['retry', 'rollback'] as const)('rejects %s through ordinary persistence', (kind) => {
    const ready = readyRun();
    const expected =
      kind === 'retry' ? failedRun() : transitionMigrationRun(ready, 'unlocked', NOW);
    const { store } = fileStore(expected);
    expect(() =>
      store.saveRun(kind === 'retry' ? { ...expected, state: 'parsing' } : ready)
    ).toThrow('illegal run transition');
    expect(store.getRun()).toEqual(expected);
  });

  it('resumes a failed local ZIP through the coordinator and completes its workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-recovery-coordinator-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const globalFile = createFileTestDb('migration-recovery-global');
    cleanup.push(globalFile.cleanup);
    const globalDb = globalFile.db;
    ensureSchema(globalDb, globalFile.dbPath);
    const openStore = (workspacePath: string) => {
      mkdirSync(join(workspacePath, '.dnaforge/migration'), { recursive: true });
      return new MigrationStore(openFileTestDb(migrationDatabasePath(workspacePath)), true);
    };
    const sourcePath = join(root, 'source.zip');
    writeFileSync(
      sourcePath,
      buildSyntheticNativeExportZip([
        {
          path: 'Entry (etr_RECOVERY).html',
          bytes: '<!doctype html><html><body><h1>Recovered notebook</h1></body></html>',
        },
      ]).bytes
    );
    const intake = await createLocalBenchlingExportIntakeDescriptor({
      sourcePath,
      selectedAt: NOW,
    });
    const initial = await createMigrationStagingWorkspace({
      scope: {
        version: 1,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: 'local-export-pending-recovery',
          url: 'urn:recovery',
          objectType: 'notebook',
        },
      },
      displayName: 'Recovered notebook',
      localExportIntake: intake,
      deps: { managedRootDir: root, globalDb, openStore, now: () => NOW },
    });
    const artifact = await intakeLocalBenchlingExportBundle({
      workspacePath: initial.workspacePath,
      sourcePath,
      expectedDescriptor: intake,
    });
    const { localExportIntake: _intake, ...completed } = initial;
    const digest = artifact.sha256.slice('sha256:'.length);
    const prepared: MigrationRun = {
      ...completed,
      scope: {
        ...initial.scope,
        kind: 'file',
        source: {
          id: `local-export-${digest}`,
          url: `urn:dnaforge:benchling-local-export:sha256:${digest}`,
          objectType: 'notebook',
        },
      },
      localExportArtifact: { ...artifact, capturedAt: NOW },
    };
    const failed = transitionMigrationRun(prepared, 'failed', NOW, {
      code: 'internal_invariant',
      message: 'Interrupted executor',
      blocking: true,
    });
    const store = openStore(initial.workspacePath);
    store.saveRun(prepared);
    store.saveRun(failed);
    store.close();
    const coordinator = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore,
      renderValidator: async ({ selectedSourceObjectIds }) =>
        selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: true })),
      now: () => NOW,
    });
    await coordinator.resume(failed.id);
    await vi.waitFor(
      async () =>
        expect(['failed', 'unlocked']).toContain((await coordinator.getRun(failed.id)).state),
      { timeout: 10000, interval: 20 }
    );
    const result = await coordinator.getRun(failed.id);
    expect(result).toMatchObject({
      state: 'unlocked',
      id: failed.id,
      attempt: failed.attempt + 1,
      scope: failed.scope,
      localExportArtifact: failed.localExportArtifact,
      lastError: null,
    });
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 1,
    });
  }, 15000);
});
