import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import {
  isValidationReportV2,
  type MigrationRun,
  type MigrationScope,
} from '../../shared/benchling-migration';
import { createTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { seedLimsBuiltinsInDb } from '../lims-engine-core';
import { isCoordinatorActiveRunCandidate, LocalBenchlingMigrationCoordinator } from './coordinator';
import { createMigrationStagingWorkspace } from './staging-workspace';
import { advanceMigrationRun, transitionMigrationRun } from './state-machine';
import { migrationDatabasePath, MigrationStore } from './store';
import type { LinkedItemRecoveryAttempt } from './store';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { acquireWorkspaceMutationShared } from '../workspace-sync-mutation-lease';
import { runLocalProjectionWorkerJob } from './local-projection-worker-job';
import { ContentArchive } from './content-archive';
import { appendBenchlingExportsToWorkspace } from './workspace-append-executor';
import { initManagedRepo, commitAllIfDirty } from '../workspace-git';
import { readCatalogReviewedTableSource } from '../catalog-reviewed-table-source';
import {
  viewExternalProviderSource,
  loadExternalSourceHistoryRecord,
} from './external-source-viewer';
import { surveyImportDestinations } from './import-destination-survey';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';

function createGlobalDb() {
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  return db;
}

function createStoreRegistry() {
  const stores = new Map<string, MigrationStore>();
  const databases: ReturnType<typeof createTestDb>[] = [];
  return {
    openStore(workspacePath: string) {
      const existing = stores.get(workspacePath);
      if (existing) return existing;
      const db = createTestDb();
      databases.push(db);
      const store = new MigrationStore(db);
      stores.set(workspacePath, store);
      return store;
    },
    materializeDiscoveryMarker(workspacePath: string) {
      mkdirSync(join(workspacePath, '.dnaforge', 'migration'), { recursive: true });
      writeFileSync(migrationDatabasePath(workspacePath), 'test store marker');
    },
    close() {
      for (const db of databases) db.close();
    },
  };
}

function openOwnedFileStore(workspacePath: string): MigrationStore {
  mkdirSync(join(workspacePath, '.dnaforge', 'migration'), { recursive: true });
  const db = openFileTestDb(migrationDatabasePath(workspacePath));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return new MigrationStore(db, true);
}

const REMOTE_SCOPE: MigrationScope = {
  version: 1,
  kind: 'file',
  source: {
    id: 'etr_retired',
    url: 'https://example.benchling.com/example/etr_retired',
    objectType: 'notebook_entry',
  },
};

const LOCAL_SCOPE: MigrationScope = {
  version: 1,
  kind: 'file',
  acquisition: 'local_bundle',
  source: {
    id: 'local-export-pending-test',
    url: 'urn:dnaforge:benchling-local-export:pending:test',
    objectType: 'notebook',
  },
};

describe('LocalBenchlingMigrationCoordinator ZIP-only boundary', () => {
  let root: string;
  let globalDb: ReturnType<typeof createGlobalDb>;
  let stores: ReturnType<typeof createStoreRegistry>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'benchling-coordinator-zip-only-'));
    globalDb = createGlobalDb();
    stores = createStoreRegistry();
  });

  afterEach(() => {
    stores.close();
    globalDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  function coordinator() {
    return new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      now: () => '2026-08-14T18:00:00.000Z',
    });
  }

  it('adopts an ordinary workspace by database id and reuses its owner', async () => {
    const workspacePath = join(root, 'ordinary-workspace');
    mkdirSync(workspacePath, { recursive: true });
    globalDb
      .prepare(
        `INSERT INTO workspaces
           (id, name, path, repo_uuid, created_at, archived_at, trashed_at)
         VALUES (7, 'Caspian', ?, NULL, 1, NULL, NULL)`
      )
      .run(workspacePath);
    const appendWorkspaceExports = vi.fn(async (run: MigrationRun) => run);
    const subject = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      appendWorkspaceExports,
      now: () => '2026-08-14T18:00:00.000Z',
    });

    const firstZip = join(root, 'first-valid.zip');
    const secondZip = join(root, 'second-valid.zip');
    for (const path of [firstZip, secondZip])
      writeFileSync(
        path,
        buildSyntheticNativeExportZip([
          {
            path: 'Entry (etr_fixture01)/entry.html',
            bytes: '<html><body><p>Retained test source</p></body></html>',
          },
        ]).bytes
      );
    const first = await subject.importLocalBundleToWorkspace(firstZip, 7);
    const second = await subject.importLocalBundleToWorkspace(secondZip, 7);

    expect(first.id).toMatch(/^migration-adopted-[a-f0-9-]{36}$/u);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      workspaceDbId: 7,
      repoUuid: null,
      projectionScopeId: 'ws7',
      baseline: { kind: 'adopted_workspace' },
    });
    expect(appendWorkspaceExports).toHaveBeenCalledTimes(2);

    stores.materializeDiscoveryMarker(workspacePath);
    const afterRestart = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
    });
    await expect(afterRestart.listRuns()).resolves.toEqual([
      expect.objectContaining({ id: first.id, workspaceDbId: 7 }),
    ]);
  });
  it('persists a destination answer before a restarted coordinator resumes the same append', async () => {
    const workspacePath = join(root, 'restart-choice-workspace');
    mkdirSync(workspacePath, { recursive: true });
    globalDb
      .prepare(
        `INSERT INTO workspaces
           (id, name, path, repo_uuid, created_at, archived_at, trashed_at)
         VALUES (8, 'Restart choice', ?, NULL, 1, NULL, NULL)`
      )
      .run(workspacePath);
    const firstExecutor = vi.fn(async (run: MigrationRun) => run);
    const firstCoordinator = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      appendWorkspaceExports: firstExecutor,
      now: () => '2026-08-14T18:00:00.000Z',
    });
    const firstZip = join(root, 'restart-valid.zip');
    writeFileSync(
      firstZip,
      buildSyntheticNativeExportZip([
        {
          path: 'Entry (etr_fixture01)/entry.html',
          bytes: '<html><body><p>Retained test source</p></body></html>',
        },
      ]).bytes
    );
    const run = await firstCoordinator.importLocalBundleToWorkspace(firstZip, 8);
    const hash = `sha256:${'a'.repeat(64)}` as const;
    const attempt: LinkedItemRecoveryAttempt = {
      schema: 'dnaforge.benchling.linked-item-recovery-attempt.v1',
      id: 'workspace-append-restart-choice',
      runId: run.id,
      mode: 'workspace_append',
      state: 'awaiting_conflict_resolution',
      resumeState: null,
      recoveryPlan: null,
      intakeDescriptors: [
        {
          schema: 'dnaforge.benchling.local-export-intake.v1',
          sourcePath: '/Users/scientist/Downloads/restart-choice.zip',
          logicalFilename: 'restart-choice.zip',
          format: 'zip',
          selectedAt: '2026-08-14T18:00:00.000Z',
          sourceIdentity: {
            deviceId: '1',
            inode: '2',
            sizeBytes: 100,
            modifiedTimeNs: '3',
            changedTimeNs: '4',
          },
          plannedResources: [],
          plannedCopyBytes: 100,
        },
      ],
      fileResults: [
        {
          fileIndex: 0,
          outcome: 'rejected',
          artifactId: null,
          failure: {
            code: 'unsafe_archive',
            message: 'Synthetic rejected source retained only for restart-state coverage.',
            retryable: false,
          },
        },
      ],
      artifactIds: [],
      selectedFileCount: 1,
      processedFileCount: 1,
      recoveredUniqueObjectCount: 0,
      repairedRelationshipCount: 0,
      retainedExistingObjectCount: 0,
      retainedExistingObjects: [],
      corroboratedExistingObjectCount: 0,
      pendingImportDecision: {
        kind: 'unbound_exact_match',
        sourceObjectId: 'seq_INCOMING1',
        sourceDisplayName: 'Incoming sequence',
        candidateEntityId: 'entity-existing',
        candidateDisplayName: 'Existing sequence',
        expectedCandidateScientificSha256: hash,
      },
      pendingImportDecisionResumeState: 'reconciling',
      versionConflictResolution: { kind: 'none' },
      createdAt: '2026-08-14T18:00:01.000Z',
      updatedAt: '2026-08-14T18:00:02.000Z',
      completedAt: null,
      safeFailure: null,
    };
    const historyStore = stores.openStore(workspacePath);
    historyStore.putLinkedItemRecoveryAttempt({
      ...attempt,
      state: 'copying',
      processedFileCount: 0,
      fileResults: [],
      pendingImportDecision: null,
      pendingImportDecisionResumeState: null,
      updatedAt: attempt.createdAt,
    });
    historyStore.putLinkedItemRecoveryAttempt({
      ...attempt,
      state: 'parsing',
      pendingImportDecision: null,
      pendingImportDecisionResumeState: null,
      updatedAt: '2026-08-14T18:00:01.500Z',
    });
    historyStore.putLinkedItemRecoveryAttempt(attempt);
    stores.materializeDiscoveryMarker(workspacePath);

    const resumedExecutor = vi.fn(
      async (resumedRun: MigrationRun, sourcePaths: readonly string[]) => {
        expect(sourcePaths).toEqual([]);
        expect(stores.openStore(workspacePath).listImportDecisions(run.id, attempt.id)).toEqual([
          expect.objectContaining({ kind: 'unbound_exact_match', policy: 'link_existing' }),
        ]);
        return resumedRun;
      }
    );
    const restarted = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      appendWorkspaceExports: resumedExecutor,
      now: () => '2026-08-14T18:00:03.000Z',
    });

    await restarted.resolveImportDecision(run.id, attempt.id, {
      kind: 'unbound_exact_match',
      sourceObjectId: 'seq_INCOMING1',
      candidateEntityId: 'entity-existing',
      expectedCandidateScientificSha256: hash,
      expectedBindingState: 'unbound',
      policy: 'link_existing',
    });

    expect(resumedExecutor).toHaveBeenCalledOnce();
    expect(firstExecutor).toHaveBeenCalledOnce();
  });
});
