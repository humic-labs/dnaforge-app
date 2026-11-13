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

  it.each(['new', 'existing'] as const)(
    'publishes reviewed same-name table rows into a %s workspace from durable choices',
    async (destination) => {
      seedLimsBuiltinsInDb(globalDb);
      const zip = join(root, 'reviewed.zip');
      writeFileSync(
        zip,
        buildSyntheticNativeExportZip([
          { path: 'Records.csv', bytes: 'Name,Amount,Amount,\nSame,0,007,α\nSame,2,008,β\n' },
        ]).bytes
      );
      const survey = await surveyImportDestinations({
        globalDb,
        archivePath: zip,
        managedRootDir: root,
      });
      const candidate = survey.registryTables[0];
      if (candidate.status !== 'ready') throw new Error('Expected readable fixture.');
      const { archiveSha256, entryPath, entrySha256, entrySizeBytes } = candidate;
      const decision: RegistryTableMappingDecision = {
        kind: 'registry_table_mapping',
        version: 1,
        source: { archiveSha256, entryPath, entrySha256, entrySizeBytes },
        outcome: {
          kind: 'records',
          headersSha256: candidate.headersSha256,
          rowCount: candidate.rowCount,
          columns: [
            { kind: 'name' },
            { kind: 'field', label: 'Amount', type: 'number' },
            { kind: 'field', label: 'Code', type: 'text' },
            { kind: 'source_only', reason: 'Keep original note' },
          ],
        },
      };
      const importer = new LocalBenchlingMigrationCoordinator({
        globalDb,
        managedRootDir: root,
        openStore: openOwnedFileStore,
        discardWorkspace: async () => undefined,
        renderValidator: async ({ selectedSourceObjectIds }) =>
          selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: true })),
        buildLocalProjectionPlans: async (job) => runLocalProjectionWorkerJob(job),
      });
      if (destination === 'existing') {
        const workspacePath = join(root, 'existing');
        mkdirSync(workspacePath);
        writeFileSync(join(workspacePath, 'Keep.txt'), 'Unrelated data');
        await initManagedRepo(workspacePath);
        await commitAllIfDirty(workspacePath, 'Initialize fixture workspace');
        globalDb
          .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (7, ?, ?, 1)')
          .run('Existing', workspacePath);
      }
      try {
        const run =
          destination === 'new'
            ? await importer.importLocalBundle(zip, undefined, 'Reviewed records', [decision])
            : await importer.importLocalBundleToWorkspace(zip, 7, [decision]);
        const store = openOwnedFileStore(run.workspacePath);
        try {
          const actionId =
            destination === 'new' ? run.id : store.listLinkedItemRecoveryAttempts(run.id)[0].id;
          expect(store.listImportDecisions(run.id, actionId)).toEqual([decision]);
        } finally {
          store.close();
        }
        await vi.waitFor(
          async () => {
            const current = await importer.getRun(run.id);
            expect(current.lastError).toBeNull();
            expect(current.state).toBe('unlocked');
            if (destination === 'existing')
              expect(current.linkedItemRecovery?.state).toBe('completed');
          },
          { timeout: 30_000, interval: 50 }
        );
        const records = globalDb
          .prepare("SELECT id, name FROM catalog_entities WHERE type = 'record'")
          .all() as Array<{ id: string; name: string }>;
        expect(records).toHaveLength(2);
        expect(new Set(records.map((row) => row.id)).size).toBe(2);
        expect(globalDb.prepare('SELECT * FROM catalog_provider_bindings').all()).toEqual([]);
        const fields = globalDb
          .prepare(
            "SELECT fields FROM lims_entity WHERE id IN (SELECT id FROM catalog_entities WHERE type = 'record')"
          )
          .all() as Array<{ fields: string }>;
        expect(fields.map((row) => JSON.parse(row.fields))).toEqual(
          expect.arrayContaining([
            { column_2: 0, column_3: '007' },
            { column_2: 2, column_3: '008' },
          ])
        );
        for (const record of records) {
          const source = readCatalogReviewedTableSource(globalDb, record.id);
          expect(source).not.toBeNull();
          if (!source) throw new Error('Expected local table source authority.');
          const history = await loadExternalSourceHistoryRecord(
            {
              ...source,
              workspaceId: source.request.workspaceId,
              reviewedTableActionId: source.reviewedTable.actionId,
            },
            openOwnedFileStore
          );
          expect(history?.reviewedTableDecisions).toEqual([decision]);
          expect(
            history?.entries.some(
              (entry) =>
                entry.entryPath === source.reviewedTable.source.entryPath &&
                entry.sizeBytes === source.reviewedTable.source.entrySizeBytes
            )
          ).toBe(true);
          const preview = await viewExternalProviderSource(globalDb, source.request, {
            loadHistorySource: (input) =>
              loadExternalSourceHistoryRecord(input, openOwnedFileStore),
          });
          expect(preview.status).toBe('ready');
          if (preview.status !== 'ready') throw new Error(preview.message);
          const original = JSON.parse(preview.text);
          expect(original).toMatchObject({
            columns: [
              { column: 1, header: 'Name', value: 'Same' },
              { column: 2, header: 'Amount', value: expect.any(String) },
              { column: 3, header: 'Amount', value: expect.stringMatching(/^00[78]$/) },
              { column: 4, header: '', value: expect.stringMatching(/^[αβ]$/) },
            ],
          });
          expect(source.request).not.toHaveProperty('sourcePath');
        }
        await Promise.all([
          ...importer['running'].values(),
          ...importer['recoveringLinkedItems'].values(),
        ]);
        await importer.appendWorkspaceExports(run.id, [zip], [decision]);
        await Promise.all(importer['recoveringLinkedItems'].values());
        const repeated = await importer.getRun(run.id);
        expect(repeated.lastError).toBeNull();
        expect(repeated.linkedItemRecovery?.state).not.toBe('awaiting_conflict_resolution');
        expect(repeated.linkedItemRecovery?.state).toBe('completed');
        expect(
          globalDb.prepare("SELECT id, name FROM catalog_entities WHERE type = 'record'").all()
        ).toEqual(records);
      } finally {
        for (const [attemptId, pending] of importer['pendingImportDecisionResolutions']) {
          await importer.resolveImportDecision(pending.runId, attemptId, {
            kind: 'provider_version_conflict',
            policy: 'keep_existing',
          });
        }
        await Promise.all([
          ...importer['running'].values(),
          ...importer['recoveringLinkedItems'].values(),
        ]);
      }
    },
    35_000
  );

  it.each([
    { name: 'one folder', folders: ['Yeast'], notebookCount: 1 },
    { name: 'flat sequence-only', folders: [''], notebookCount: 0 },
    { name: 'multiple folders and notebooks', folders: ['Yeast', 'Other'], notebookCount: 2 },
  ])(
    'imports $name through new-workspace validation and global publication',
    async ({ folders, notebookCount }) => {
      const destinationDb = createTestDb();
      ensureSchema(destinationDb, ':memory:');
      seedLimsBuiltinsInDb(destinationDb);
      const zip = join(root, 'new-workspace.zip');
      writeFileSync(
        zip,
        buildSyntheticNativeExportZip([
          ...folders.map((folder) => ({
            path: [folder, 'YEN1 (seq_NEWWORKSPACE).gb'].filter(Boolean).join('/'),
            bytes:
              'LOCUS       YEN1       8 bp    DNA     circular\nDEFINITION  YEN1.\nFEATURES             Location/Qualifiers\nORIGIN\n        1 acgtacgt\n//\n',
          })),
          ...Array.from({ length: notebookCount }, (_, index) => ({
            path: [folders[index % folders.length], `Notes (etr_NEWWORKSPACE${index}).html`]
              .filter(Boolean)
              .join('/'),
            bytes: '<html><body><h1>New workspace notes</h1><p>Native import.</p></body></html>',
          })),
        ]).bytes
      );
      const importer = new LocalBenchlingMigrationCoordinator({
        globalDb: destinationDb,
        managedRootDir: root,
        openStore: openOwnedFileStore,
        discardWorkspace: async () => undefined,
        renderValidator: async ({ selectedSourceObjectIds }) =>
          selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: true })),
        buildLocalProjectionPlans: async (job) => runLocalProjectionWorkerJob(job),
      });
      try {
        const run = await importer.importLocalBundle(zip, undefined, 'New native import');
        expect(destinationDb.prepare('SELECT id FROM workspaces').all()).toEqual([]);
        await vi.waitFor(
          async () => {
            const current = await importer.getRun(run.id);
            expect(current.lastError).toBeNull();
            expect(current.state, JSON.stringify(current.lastError)).toBe('unlocked');
          },
          { timeout: 30_000, interval: 50 }
        );
        const registered = destinationDb.prepare('SELECT id, name FROM workspaces').all();
        expect(registered).toEqual([{ id: expect.any(Number), name: 'New native import' }]);
        const store = openOwnedFileStore(run.workspacePath);
        try {
          expect(store.getValidationReport(run.id)?.passed).toBe(true);
          expect(store.listSourceObjects(run.id)).toHaveLength(1 + notebookCount);
        } finally {
          store.close();
        }
      } finally {
        await Promise.all(importer['running'].values());
        destinationDb.close();
      }
    },
    35_000
  );

  it('automatically preserves one failed record as a file and imports its valid sibling', async () => {
    const destinationDb = createTestDb();
    ensureSchema(destinationDb, ':memory:');
    seedLimsBuiltinsInDb(destinationDb);
    const zip = join(root, 'retry-source.zip');
    const badPath = 'Lab/Bad sequence (seq_BADSEQ12).gb';
    const goodPath = 'Lab/Good sequence (seq_GOODSEQ12).gb';
    const original = buildSyntheticNativeExportZip([
      {
        path: badPath,
        bytes:
          'LOCUS       seq_BADSEQ12       8 bp    DNA     linear\nDEFINITION  Bad.\nORIGIN\n        1 acgtacgt\n//\n',
      },
      {
        path: goodPath,
        bytes:
          'LOCUS       seq_GOODSEQ12       8 bp    DNA     linear\nDEFINITION  Good.\nORIGIN\n        1 ttttaaaa\n//\n',
      },
    ]).bytes;
    writeFileSync(zip, original);
    const discardWorkspace = vi.fn(async () => undefined);
    const importer = new LocalBenchlingMigrationCoordinator({
      globalDb: destinationDb,
      managedRootDir: root,
      openStore: openOwnedFileStore,
      discardWorkspace,
      renderValidator: async ({ selectedSourceObjectIds, receipts }) =>
        selectedSourceObjectIds.map((sourceObjectId) => ({
          sourceObjectId,
          passed:
            sourceObjectId !== 'seq_BADSEQ12' ||
            receipts.some(
              (receipt) =>
                receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
            ),
          ...(sourceObjectId === 'seq_BADSEQ12' &&
          !receipts.some(
            (receipt) =>
              receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
          )
            ? { message: 'This sequence failed render validation.' }
            : {}),
        })),
      buildLocalProjectionPlans: async (job) => runLocalProjectionWorkerJob(job),
    });
    try {
      const first = await importer.importLocalBundle(zip, undefined, 'Retry fixture');
      let completed: MigrationRun | undefined;
      await vi.waitFor(
        async () => {
          completed = (await importer.listRuns()).find(
            (run) => run.localBestEffortFallback?.priorRunId === first.id
          );
          expect(completed?.state, JSON.stringify(completed?.lastError)).toBe('unlocked');
        },
        { timeout: 30_000, interval: 50 }
      );
      if (!completed) throw new Error('Best-effort successor missing.');
      await vi.waitFor(() => expect(discardWorkspace).toHaveBeenCalledTimes(1));
      expect(completed.localBestEffortFallback).toEqual({
        zipSha256: (await importer.getRun(first.id)).externalZipSource?.zipSha256,
        entryPaths: [badPath],
        priorRunId: first.id,
        rootRunId: first.id,
      });
      const store = openOwnedFileStore(completed.workspacePath);
      try {
        expect(
          store
            .listSourceObjects(completed.id)
            .map((object) => object.sourcePath)
            .sort()
        ).toEqual([badPath, goodPath]);
        expect(
          store.listSourceObjects(completed.id).find((object) => object.sourcePath === badPath)
            ?.sourceType
        ).toBe('unsupported_object');
        expect(store.getValidationReport(completed.id)?.passed).toBe(true);
        expect(store.getSourceSnapshot(completed.id)?.localExportWarnings).toContain(
          'Bad sequence (seq_BADSEQ12).gb was preserved as a file because it could not become an editable record.'
        );
      } finally {
        store.close();
      }
      expect((await importer.getRun(first.id)).state).toBe('failed');
      expect(readFileSync(zip)).toEqual(Buffer.from(original));
      writeFileSync(zip, Buffer.from(original).subarray(0, original.length - 1));
      await expect(importer.retryLocalBundleWithoutFailedFile(first.id)).rejects.toThrow();
    } finally {
      destinationDb.close();
    }
  }, 70_000);

  it('automatically keeps a failed appended record as a file in an existing workspace', async () => {
    const destinationDb = createTestDb();
    ensureSchema(destinationDb, ':memory:');
    seedLimsBuiltinsInDb(destinationDb);
    const initialZip = join(root, 'append-initial.zip');
    writeFileSync(
      initialZip,
      buildSyntheticNativeExportZip([
        {
          path: 'Lab/Original (seq_APPENDORIGINAL).gb',
          bytes:
            'LOCUS       seq_APPENDORIGINAL       8 bp    DNA     linear\nORIGIN\n        1 acgtacgt\n//\n',
        },
      ]).bytes
    );
    const badPath = 'Lab/Bad sequence (seq_APPENDBAD).gb';
    const goodPath = 'Lab/Good sequence (seq_APPENDGOOD).gb';
    const appendZip = join(root, 'append-best-effort.zip');
    writeFileSync(
      appendZip,
      buildSyntheticNativeExportZip([
        {
          path: badPath,
          bytes:
            'LOCUS       seq_APPENDBAD       8 bp    DNA     linear\nORIGIN\n        1 cccccccc\n//\n',
        },
        {
          path: goodPath,
          bytes:
            'LOCUS       seq_APPENDGOOD       8 bp    DNA     linear\nORIGIN\n        1 ttttaaaa\n//\n',
        },
      ]).bytes
    );
    const importer = new LocalBenchlingMigrationCoordinator({
      globalDb: destinationDb,
      managedRootDir: root,
      openStore: openOwnedFileStore,
      discardWorkspace: async () => undefined,
      renderValidator: async ({ selectedSourceObjectIds, receipts }) =>
        selectedSourceObjectIds.map((sourceObjectId) => ({
          sourceObjectId,
          passed:
            sourceObjectId !== 'seq_APPENDBAD' ||
            receipts.some(
              (receipt) =>
                receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
            ),
          ...(sourceObjectId === 'seq_APPENDBAD' &&
          !receipts.some(
            (receipt) =>
              receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
          )
            ? { message: 'This sequence failed render validation.' }
            : {}),
        })),
      buildLocalProjectionPlans: async (job) => runLocalProjectionWorkerJob(job),
    });
    try {
      const initial = await importer.importLocalBundle(initialZip, undefined, 'Append destination');
      await vi.waitFor(
        async () => expect((await importer.getRun(initial.id)).state).toBe('unlocked'),
        { timeout: 30_000, interval: 50 }
      );
      await importer.appendWorkspaceExports(initial.id, [appendZip]);
      await vi.waitFor(
        async () =>
          expect((await importer.getRun(initial.id)).linkedItemRecovery?.state).toBe('completed'),
        { timeout: 30_000, interval: 50 }
      );
      const store = openOwnedFileStore(initial.workspacePath);
      try {
        expect(
          store.listSourceObjects(initial.id).find((source) => source.sourcePath === badPath)
            ?.sourceType
        ).toBe('unsupported_object');
        expect(store.listProjectionReceipts(initial.id)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ sourceObjectId: 'seq_APPENDBAD', projection: 'fallback' }),
            expect.objectContaining({ sourceObjectId: 'seq_APPENDGOOD', projection: 'native' }),
          ])
        );
        const report = store.getValidationReport(initial.id);
        expect(report?.passed).toBe(true);
        if (!report || !isValidationReportV2(report)) throw new Error('Expected native report.');
        expect(report.nativeImport?.fileOutcomes?.preserved).toEqual([
          {
            fileName: 'Bad sequence (seq_APPENDBAD).gb',
            reason: 'Could not become an editable record.',
          },
        ]);
      } finally {
        store.close();
      }
    } finally {
      destinationDb.close();
    }
  }, 70_000);

  it('resumes a pending file-local append fallback after app restart', async () => {
    const destinationDb = createTestDb();
    ensureSchema(destinationDb, ':memory:');
    seedLimsBuiltinsInDb(destinationDb);
    const initialZip = join(root, 'restart-initial.zip');
    const appendZip = join(root, 'restart-append.zip');
    const badPath = 'Lab/Bad (seq_RESTARTBAD).gb';
    writeFileSync(
      initialZip,
      buildSyntheticNativeExportZip([
        {
          path: 'Lab/Original (seq_RESTARTORIGINAL).gb',
          bytes:
            'LOCUS       seq_RESTARTORIGINAL       8 bp    DNA     linear\nORIGIN\n        1 acgtacgt\n//\n',
        },
      ]).bytes
    );
    writeFileSync(
      appendZip,
      buildSyntheticNativeExportZip([
        {
          path: badPath,
          bytes:
            'LOCUS       seq_RESTARTBAD       8 bp    DNA     linear\nORIGIN\n        1 cccccccc\n//\n',
        },
        {
          path: 'Lab/Good (seq_RESTARTGOOD).gb',
          bytes:
            'LOCUS       seq_RESTARTGOOD       8 bp    DNA     linear\nORIGIN\n        1 ttttaaaa\n//\n',
        },
      ]).bytes
    );
    const renderValidator: NonNullable<
      ConstructorParameters<typeof LocalBenchlingMigrationCoordinator>[0]['renderValidator']
    > = async ({ selectedSourceObjectIds, receipts }) =>
      selectedSourceObjectIds.map((sourceObjectId) => ({
        sourceObjectId,
        passed:
          sourceObjectId !== 'seq_RESTARTBAD' ||
          receipts.some(
            (receipt) =>
              receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
          ),
        ...(sourceObjectId === 'seq_RESTARTBAD' &&
        !receipts.some(
          (receipt) =>
            receipt.sourceObjectId === sourceObjectId && receipt.projection === 'fallback'
        )
          ? { message: 'This sequence failed render validation.' }
          : {}),
      }));
    const deps = {
      globalDb: destinationDb,
      managedRootDir: root,
      openStore: openOwnedFileStore,
      discardWorkspace: async () => undefined,
      renderValidator,
      buildLocalProjectionPlans: async (job: Parameters<typeof runLocalProjectionWorkerJob>[0]) =>
        runLocalProjectionWorkerJob(job),
    };
    try {
      const importer = new LocalBenchlingMigrationCoordinator(deps);
      const original = await importer.importLocalBundle(
        initialZip,
        undefined,
        'Restart destination'
      );
      await vi.waitFor(
        async () => expect((await importer.getRun(original.id)).state).toBe('unlocked'),
        {
          timeout: 30_000,
          interval: 50,
        }
      );
      const store = openOwnedFileStore(original.workspacePath);
      try {
        await expect(
          appendBenchlingExportsToWorkspace(await importer.getRun(original.id), [appendZip], {
            store,
            archive: new ContentArchive(
              join(original.workspacePath, '.dnaforge', 'migration', 'archive')
            ),
            renderValidator,
            destinationDb,
            now: () => new Date().toISOString(),
          })
        ).rejects.toMatchObject({ code: 'linked_item_recovery_validation_failed' });
        expect(
          store.listLinkedItemRecoveryAttempts(original.id).at(-1)?.safeFailure
            ?.bestEffortFallbackSources
        ).toEqual([{ zipSha256: expect.stringMatching(/^sha256:/u), entryPaths: [badPath] }]);
      } finally {
        store.close();
      }
      const restarted = new LocalBenchlingMigrationCoordinator(deps);
      await restarted.getActiveRun();
      await vi.waitFor(
        async () => {
          const run = await restarted.getRun(original.id);
          expect(run.linkedItemRecovery?.state).toBe('completed');
        },
        { timeout: 30_000, interval: 50 }
      );
      const verified = openOwnedFileStore(original.workspacePath);
      try {
        expect(verified.listLinkedItemRecoveryAttempts(original.id)).toHaveLength(2);
        expect(verified.getValidationReport(original.id)?.passed).toBe(true);
      } finally {
        verified.close();
      }
    } finally {
      destinationDb.close();
    }
  }, 70_000);

  async function createRun(scope: MigrationScope, workspaceId: string): Promise<MigrationRun> {
    const run = await createMigrationStagingWorkspace({
      scope,
      displayName: 'Boundary fixture',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => workspaceId,
        openStore: stores.openStore,
        now: () => '2026-08-14T17:59:00.000Z',
      },
    });
    stores.materializeDiscoveryMarker(run.workspacePath);
    return run;
  }

  it('fails a retired provider run closed without trying to resume it', async () => {
    const original = await createRun(REMOTE_SCOPE, 'retired-provider-run');

    const recovered = await coordinator().getActiveRun();

    expect(recovered).toMatchObject({
      id: original.id,
      state: 'failed',
      lastError: {
        code: 'migration_interrupted',
        blocking: true,
        message:
          'This migration used a retired provider-based flow. Start a new migration and choose the original Benchling export ZIP.',
      },
    });
    expect(stores.openStore(original.workspacePath).getRun()).toEqual(recovered);
  });

  it('reads retired provider history without changing its durable state', async () => {
    const original = await createRun(REMOTE_SCOPE, 'retired-provider-history');

    await expect(
      coordinator().getReport(original.id, { preserveRunState: true })
    ).resolves.toBeNull();

    expect(stores.openStore(original.workspacePath).getRun()).toEqual(original);
  });

  it('fails a local draft with missing copy authority closed and asks for the export again', async () => {
    const original = await createRun(LOCAL_SCOPE, 'incomplete-local-run');

    const recovered = await coordinator().getActiveRun();

    expect(recovered).toMatchObject({
      id: original.id,
      state: 'failed',
      lastError: {
        code: 'migration_interrupted',
        blocking: true,
      },
    });
    expect(recovered?.lastError?.message).toContain('Choose the original ZIP export again');
  });

  it('rejects standalone HTML at the ZIP-only intake boundary', async () => {
    await expect(coordinator().importLocalBundle('/tmp/Benchling export.html')).rejects.toThrow(
      'Select one original Benchling ZIP export.'
    );
  });

  async function persistInterrupted(
    workspaceId: string,
    state: 'action_required' | 'paused'
  ): Promise<MigrationRun> {
    const original = await createRun(LOCAL_SCOPE, workspaceId);
    const store = stores.openStore(original.workspacePath);
    let current = original;
    while (current.state !== 'parsing') {
      current = advanceMigrationRun(current, '2026-08-14T18:00:00.000Z');
      store.saveRun(current);
    }
    const interrupted = transitionMigrationRun(
      current,
      state,
      '2026-08-14T18:00:01.000Z',
      state === 'action_required'
        ? {
            code: 'migration_interrupted',
            message: 'The local ZIP could not be read completely.',
            blocking: true,
          }
        : null
    );
    store.saveRun(interrupted);
    return interrupted;
  }

  function coordinatorForNewZip(sourcePath: string, selectedAt: string) {
    return new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      now: () => selectedAt,
      planLocalBundle: async () => ({
        schema: 'dnaforge.benchling.local-export-intake.v1',
        sourcePath,
        logicalFilename: 'next-import.zip',
        format: 'zip',
        selectedAt,
        sourceIdentity: {
          deviceId: '1',
          inode: '2',
          sizeBytes: 3,
          modifiedTimeNs: '4',
          changedTimeNs: '5',
        },
        plannedResources: [],
        plannedCopyBytes: 3,
      }),
    });
  }

  it('retires an older blocking local ZIP error without occupying the exclusive import slot', async () => {
    const blocked = await persistInterrupted('blocked-action-required', 'action_required');

    expect(isCoordinatorActiveRunCandidate(blocked)).toBe(false);
    await expect(coordinator().getActiveRun()).resolves.toBeNull();
    expect(stores.openStore(blocked.workspacePath).getRun()).toMatchObject({
      id: blocked.id,
      state: 'failed',
    });
  });

  it('ends an older local validation failure and removes it from the current migration slot', async () => {
    const blocked = await persistInterrupted('legacy-validation-failure', 'action_required');
    const store = stores.openStore(blocked.workspacePath);
    store.saveRun({
      ...blocked,
      lastError: {
        code: 'validation_failed',
        message: 'The selected ZIP failed validation.',
        blocking: true,
      },
    });

    await expect(coordinator().getActiveRun()).resolves.toBeNull();
    expect(store.getRun()).toMatchObject({
      id: blocked.id,
      state: 'failed',
      resumeState: null,
      lastError: { code: 'validation_failed' },
    });
  });

  it('does not show another terminal local import failure as Current migration', async () => {
    const blocked = await persistInterrupted('failed-internal-zip', 'action_required');
    const store = stores.openStore(blocked.workspacePath);
    const failed = transitionMigrationRun(blocked, 'failed', '2026-08-14T18:00:02.000Z', {
      code: 'internal_invariant',
      message: 'Migration execution failed internally.',
      blocking: true,
    });
    store.saveRun(failed);

    await expect(coordinator().getActiveRun()).resolves.toBeNull();
    expect(store.getRun()).toEqual(failed);
  });

  it('lets a new ZIP import start while a leftover action_required run is still preserved', async () => {
    const blocked = await persistInterrupted('blocked-action-required-import', 'action_required');
    const sourcePath = join(root, 'next-import.zip');
    const selectedAt = '2026-08-14T18:00:02.000Z';
    const created = await coordinatorForNewZip(sourcePath, selectedAt)[
      'createProvisionalLocalBundleRunUnreserved'
    ](sourcePath, 'Next import');

    expect(created.state).toBe('draft');
    expect(created.id).not.toBe(blocked.id);
  });

  it('still refuses a new ZIP import while a paused run occupies the exclusive slot', async () => {
    const paused = await persistInterrupted('paused-still-exclusive', 'paused');
    const sourcePath = join(root, 'next-import.zip');
    const selectedAt = '2026-08-14T18:00:02.000Z';

    await expect(
      coordinatorForNewZip(sourcePath, selectedAt)['createProvisionalLocalBundleRunUnreserved'](
        sourcePath,
        'Next import'
      )
    ).rejects.toMatchObject({
      code: 'local_export_migration_already_active',
      message: `Migration ${paused.id} is already active.`,
    });
  });

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

  it('creates a whole-ZIP artifact scope without assuming one selected source folder', async () => {
    const sourcePath = join(root, 'sundew_export.zip');
    const selectedAt = '2026-08-14T18:00:00.000Z';
    const namedCoordinator = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      now: () => selectedAt,
      planLocalBundle: async () => ({
        schema: 'dnaforge.benchling.local-export-intake.v1',
        sourcePath,
        logicalFilename: 'sundew_export.zip',
        format: 'zip',
        selectedAt,
        sourceIdentity: {
          deviceId: '1',
          inode: '2',
          sizeBytes: 3,
          modifiedTimeNs: '4',
          changedTimeNs: '5',
        },
        plannedResources: [],
        plannedCopyBytes: 3,
      }),
    });
    const createProvisional =
      namedCoordinator['createProvisionalLocalBundleRunUnreserved'].bind(namedCoordinator);

    await expect(createProvisional(sourcePath, 'Sundew localization')).resolves.toMatchObject({
      displayName: 'Sundew localization',
      scope: {
        version: 1,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: expect.stringMatching(/^local-export-pending-/u),
          objectType: 'notebook',
        },
      },
      state: 'draft',
      localExportIntake: { sourcePath },
    });
  });

  it('persists a new-layout ZIP as an external source and resumes from the unchanged path', async () => {
    const sourcePath = join(root, 'external-source.zip');
    writeFileSync(
      sourcePath,
      buildSyntheticNativeExportZip([
        {
          path: 'Yeast/YEN1 (seq_YEN1000).gb',
          bytes: 'LOCUS       YEN1       8 bp    DNA     linear\nORIGIN\n        1 acgtacgt\n//\n',
        },
      ]).bytes
    );
    const subject = coordinator();
    vi.spyOn(
      subject as unknown as { autoRunVerifiedLocalExport: (run: MigrationRun) => void },
      'autoRunVerifiedLocalExport'
    ).mockImplementation(() => undefined);
    const internals = subject as unknown as {
      createProvisionalLocalBundleRunUnreserved: (
        sourcePath: string,
        workspaceName?: string
      ) => Promise<MigrationRun>;
      completeLocalBundleIntake: (
        provisional: MigrationRun,
        restarting: boolean
      ) => Promise<MigrationRun>;
    };
    const provisional = await internals.createProvisionalLocalBundleRunUnreserved(
      sourcePath,
      'External source'
    );

    const completed = await internals.completeLocalBundleIntake(provisional, false);

    expect(completed).toMatchObject({
      externalZipSource: {
        schema: 'dnaforge.benchling.external-zip-source.v1',
        originalPath: sourcePath,
      },
      externalZipEntries: [
        expect.objectContaining({
          sourceObjectId: 'seq_YEN1000',
          entryPath: 'Yeast/YEN1 (seq_YEN1000).gb',
        }),
      ],
    });
    expect(completed.localExportArtifact).toBeUndefined();
    expect(completed.localExportIntake).toBeUndefined();
    expect(() =>
      readdirSync(join(completed.workspacePath, '.dnaforge', 'migration', 'archive'))
    ).toThrow();

    stores.materializeDiscoveryMarker(completed.workspacePath);
    const restarted = new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore: stores.openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      availableBytes: Number.MAX_SAFE_INTEGER,
    });
    await expect(restarted.getRun(completed.id)).resolves.toMatchObject({
      externalZipSource: { originalPath: sourcePath },
    });
    await expect(restarted.preflight(completed.id)).resolves.toMatchObject({
      runId: completed.id,
      storageAllowed: true,
    });

    rmSync(sourcePath);
    await expect(restarted.preflight(completed.id)).rejects.toMatchObject({
      code: 'source_unavailable',
    });
  });

  it('leaves a completed legacy run available for its final local unlock', async () => {
    const original = await createRun(REMOTE_SCOPE, 'ready-legacy-run');
    const store = stores.openStore(original.workspacePath);
    let ready = original;
    while (ready.state !== 'ready_to_unlock') {
      ready = advanceMigrationRun(ready, '2026-08-14T18:00:00.000Z');
      store.saveRun(ready);
    }

    await expect(coordinator().getActiveRun()).resolves.toEqual(ready);
  });

  it('keeps an unlocked run active while a durable linked-item attempt is validating', async () => {
    const original = await createRun(LOCAL_SCOPE, 'unlocked-linked-item-restart');
    const unlocked: MigrationRun = {
      ...original,
      state: 'unlocked',
      unlockedAt: '2026-08-14T18:00:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'linked_item_recovery',
        attemptId: 'linked-recovery-validating',
        state: 'validating',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 1,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-14T18:00:01.000Z',
      },
    };

    expect(isCoordinatorActiveRunCandidate(unlocked)).toBe(true);
    expect(isCoordinatorActiveRunCandidate({ ...unlocked, linkedItemRecovery: undefined })).toBe(
      false
    );
  });

  it('queues a supplemental ZIP until the primary migration and unlock operation finish', async () => {
    const original = await createRun(LOCAL_SCOPE, 'queued-supplemental-import');
    const subject = coordinator();
    const internals = subject as unknown as {
      running: Map<string, Promise<MigrationRun>>;
      performLocalExportAttempt: (
        runId: string,
        sourcePaths: readonly string[],
        mode: 'linked_item_recovery' | 'workspace_append',
        onFirstDurableUpdate?: (run: MigrationRun) => void
      ) => Promise<MigrationRun>;
    };
    let finishPrimary!: () => void;
    const primary = new Promise<MigrationRun>((resolve) => {
      finishPrimary = () => resolve(original);
    });
    internals.running.set(original.id, primary);
    const perform = vi.spyOn(internals, 'performLocalExportAttempt').mockResolvedValue(original);

    const queued = subject.addLinkedItemExports(original.id, ['/tmp/supplemental.zip']);
    await Promise.resolve();
    expect(perform).not.toHaveBeenCalled();
    await expect(subject.unlock(original.id)).rejects.toThrow(
      'Migration validation has not passed'
    );

    finishPrimary();
    await queued;
    expect(perform).toHaveBeenCalledOnce();
  });

  it.each(['mount-first', 'recovery-first'])(
    'serializes restart recovery and mounting with durable rechecks: %s',
    async (order) => {
      const original = await createRun(LOCAL_SCOPE, 'restart-mount-race');
      const unlocked: MigrationRun = {
        ...original,
        state: 'unlocked',
        unlockedAt: original.updatedAt,
        linkedItemRecovery: {
          schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
          mode: 'workspace_append',
          attemptId: 'restart-attempt',
          state: 'validating',
          selectedFileCount: 1,
          processedFileCount: 1,
          recoveredUniqueObjectCount: 1,
          repairedRelationshipCount: 0,
          retainedExistingObjectCount: 0,
          retainedExistingObjects: [],
          corroboratedExistingObjectCount: 0,
          updatedAt: original.updatedAt,
        },
      };
      const store = stores.openStore(original.workspacePath);
      let ready = original;
      while (ready.state !== 'ready_to_unlock') {
        ready = advanceMigrationRun(ready, '2026-08-14T18:00:00.000Z');
        store.saveRun(ready);
      }
      store.saveRun(unlocked);
      const subject = coordinator();
      const internals = subject as unknown as {
        scheduleLinkedItemRecoveryRestart(run: MigrationRun): void;
        scanRuns(): Promise<MigrationRun[]>;
        runPaths: Map<string, string>;
        recoveringLinkedItems: Map<string, Promise<MigrationRun>>;
        performLocalExportAttempt(
          runId: string,
          paths: readonly string[],
          mode: string,
          onUpdate?: unknown,
          leaseAlreadyHeld?: boolean
        ): Promise<MigrationRun>;
      };
      const perform = vi.spyOn(internals, 'performLocalExportAttempt').mockResolvedValue(unlocked);
      internals.runPaths.set(original.id, original.workspacePath);
      if (order === 'recovery-first') {
        vi.spyOn(internals, 'scanRuns').mockResolvedValue([unlocked]);
        let finish!: () => void;
        const barrier = new Promise<void>((resolve) => {
          finish = resolve;
        });
        perform.mockImplementation(async () => {
          await barrier;
          return unlocked;
        });
        await subject.getActiveRun();
        let mounted = false;
        const mount = acquireWorkspaceMutationShared(original.workspacePath).then((release) => {
          mounted = true;
          release();
        });
        try {
          await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
          expect(mounted).toBe(false);
        } finally {
          finish();
        }
        await mount;
        expect(mounted).toBe(true);
        return;
      }
      const release = await acquireWorkspaceMutationShared(original.workspacePath);
      try {
        internals.scheduleLinkedItemRecoveryRestart(unlocked);
        internals.scheduleLinkedItemRecoveryRestart(unlocked);
        await Promise.resolve();
        expect(perform).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await internals.recoveringLinkedItems.get(original.id);
      expect(perform).toHaveBeenCalledExactlyOnceWith(
        original.id,
        [],
        'linked_item_recovery',
        undefined,
        true
      );
    }
  );

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
