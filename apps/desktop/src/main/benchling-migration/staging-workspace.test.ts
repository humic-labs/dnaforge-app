import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import { createFileTestDb, createTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { commitAllIfDirty } from '../workspace-git';
import {
  BENCHLING_MIGRATION_PROJECTION_VERSION,
  isValidationReportV2,
  type MigrationRun,
  type MigrationScope,
  type ValidationReport,
} from '../../shared/benchling-migration';
import {
  buildNestedFolderTreeNativeExportFixture,
  buildSyntheticNativeExportZip,
} from './__fixtures__/native-export-zip-fixture';
import { transitionMigrationRun } from './state-machine';
import { buildBenchlingRegistryProjection } from './registry-projection';
import { persistBenchlingRegistryProjectionDocument } from './registry-projection-store';
import { buildProjectionPlan } from './projection';
import { writeProjectionPlan } from './projection-writer';
import { ContentArchive } from './content-archive';
import { executeLocalBundleMigration } from './local-bundle-executor';
import {
  createLocalBenchlingExportIntakeDescriptor,
  intakeLocalBenchlingExportBundle,
} from './local-export-bundle';
import { MigrationStore } from './store';
import {
  createMigrationStagingWorkspace,
  persistMigrationWorkspaceReport,
  readCommittedMigrationReport,
  unlockMigrationWorkspace,
} from './staging-workspace';

function createGlobalDb() {
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  return db;
}

function passingReport(run: MigrationRun): ValidationReport {
  const empty = { expected: 0, actual: 0, passed: true, issues: [] };
  return {
    version: 1,
    runId: run.id,
    scope: run.scope,
    snapshotId: 'snapshot-1',
    accountHash: run.binding!.accountHash,
    generatedAt: '2026-07-17T00:10:00.000Z',
    passed: true,
    sourceObjects: empty,
    attachments: empty,
    memberships: empty,
    relationships: {
      ...empty,
      countsByClass: {
        exact: 0,
        heuristic: 0,
        ambiguous: 0,
        unresolved: 0,
        external: 0,
        source_broken: 0,
      },
    },
    projections: {
      ...empty,
      native: 0,
      nativeRepresentations: { dnaSequence: 0, strain: 0, needsSequence: 0 },
      artifact: 0,
      exceptions: 0,
    },
    hashes: empty,
    rendering: empty,
    issues: [],
  };
}

async function seedUnlockSourceEvidence(run: MigrationRun, store: MigrationStore): Promise<void> {
  if (!run.binding) throw new Error('Unlock source evidence requires a confirmed binding.');
  const archive = new ContentArchive(join(run.workspacePath, '.dnaforge', 'migration', 'archive'));
  const manifestBlob = await archive.putBuffer(
    Buffer.from(`immutable normalized source evidence for ${run.id}`)
  );
  const partBlob = await archive.putBuffer(
    Buffer.from(`immutable raw snapshot part for ${run.id}`)
  );
  const partId = `unlock-part-${run.workspaceId}`;
  const sourceObjectId = run.scope.kind === 'file' ? run.scope.source.id : 'source-evidence';
  const manifestId = `unlock-source-${run.workspaceId}`;
  await archive.writeManifest(manifestId, {
    version: 1,
    entries: [
      {
        logicalFilename: 'source-evidence.json',
        sourceArchivePath: 'source-evidence.json',
        sha256: manifestBlob.sha256,
        size: manifestBlob.size,
      },
      {
        logicalFilename: 'raw-source.json',
        sourceArchivePath: 'raw-source.json',
        sha256: partBlob.sha256,
        size: partBlob.size,
        archivePartId: partId,
        sourceObjectId,
      },
    ],
  });
  store.saveSourceSnapshot({
    version: 1,
    id: 'snapshot-1',
    runId: run.id,
    accountHash: run.binding.accountHash,
    createdAt: '2026-07-17T00:09:00.000Z',
    archiveManifestId: manifestId,
    initialSourceObjectIds: [],
    expectedSourceObjectCount: 0,
    expectedAttachmentCount: 0,
    expectedMembershipCount: 0,
    parts: [
      {
        id: partId,
        kind: 'targeted_read',
        sha256: partBlob.sha256,
        sizeBytes: partBlob.size,
        capturedAt: '2026-07-17T00:09:00.000Z',
        sourceJobId: null,
        sourceObjectId,
        supersedesPartId: null,
      },
    ],
  });
}

async function createReadyRegistryUnlockFixture(input: {
  root: string;
  globalDb: ReturnType<typeof createTestDb>;
  workspaceId: string;
  fileBacked?: boolean;
}): Promise<{
  run: MigrationRun;
  store: MigrationStore;
  migrationDb: ReturnType<typeof createTestDb>;
}> {
  const initialMigrationDb = createTestDb();
  const initialStore = new MigrationStore(initialMigrationDb);
  let run = await createMigrationStagingWorkspace({
    scope: {
      version: 1,
      kind: 'file',
      source: {
        id: 'registry-record-atomic',
        url: 'https://example.benchling.com/registry/REG-ATOMIC',
      },
    },
    displayName: 'Atomic registry migration',
    deps: {
      managedRootDir: input.root,
      globalDb: input.globalDb,
      createWorkspaceId: () => input.workspaceId,
      now: () => '2026-07-17T00:00:00.000Z',
      openStore: () => initialStore,
    },
  });
  initialMigrationDb.close();
  run = {
    ...run,
    binding: {
      version: 1,
      benchlingOrigin: 'https://example.benchling.com',
      benchlingAccountId: 'usr_peter',
      benchlingAccountEmail: 'scientist@example.edu',
      benchlingOrganizationId: 'wrk_example',
      benchlingOrganizationName: 'Example Lab',
      chromePairingId: 'pairing-atomic',
      accountHash: 'sha256:atomic-account',
      confirmedAt: '2026-07-17T00:00:01.000Z',
    },
    state: 'ready_to_unlock',
    updatedAt: '2026-07-17T00:10:00.000Z',
  };
  const migrationDb = input.fileBacked
    ? openFileTestDb(join(run.workspacePath, '.dnaforge/migration/migration.sqlite'))
    : createTestDb();
  const store = new MigrationStore(migrationDb);
  store.saveRun(run);
  store.saveValidationReport(passingReport(run));
  await seedUnlockSourceEvidence(run, store);
  const persisted = await persistBenchlingRegistryProjectionDocument({
    workspacePath: run.workspacePath,
    document: buildBenchlingRegistryProjection({
      destinationWorkspaceId: input.workspaceId,
      organizationId: 'wrk_example',
      converterVersion: 'atomic-test-v1',
      capturedAt: '2026-07-17T00:09:00.000Z',
      schemas: [
        {
          sourceSchemaId: 'schema-atomic',
          sourceRevisionId: 'schema-atomic:r1',
          sourceRevisionNumber: 1,
          name: 'Atomic sample',
          displayName: 'Atomic sample',
          fields: [
            {
              sourceFieldId: 'field-atomic-description',
              definition: { key: 'description', label: 'Description', type: 'text' },
            },
          ],
        },
      ],
      records: [
        {
          sourceSchemaRevisionId: 'schema-atomic:r1',
          fieldValues: { description: 'Atomic unlock fixture' },
          sourceObject: {
            id: 'registry-record-atomic',
            stableId: 'registry-record-atomic',
            sourceType: 'registry_record',
            schemaId: 'schema-atomic',
            name: 'Atomic record',
            registryId: 'REG-ATOMIC',
            aliases: [],
            sourceUrl: 'https://example.benchling.com/registry/REG-ATOMIC',
            attachmentHashes: [],
            memberships: [],
            createdAt: '2025-01-02T03:04:05.000Z',
            modifiedAt: '2026-07-17T09:08:07.000Z',
            metadata: {},
            content: {},
            relationships: [],
          },
        },
      ],
    }),
  });
  store.appendProjectionReceipt({
    id: 'receipt-registry-record-atomic',
    runId: run.id,
    sourceObjectId: 'registry-record-atomic',
    destinationObjectId: 'registry-record-atomic-destination',
    destinationPath: persisted.relativePath,
    projection: 'native',
    converterId: 'benchling-registry-v1',
    converterVersion: 'atomic-test-v1',
    sourceHash: 'a'.repeat(64),
    destinationHash: persisted.sha256,
    warnings: [],
    exception: null,
    formulaEvidence: [],
    createdAt: '2026-07-17T00:09:00.000Z',
  });
  return { run, store, migrationDb };
}

function globalUnlockCounts(db: ReturnType<typeof createTestDb>): {
  workspaces: number;
  schemas: number;
  entities: number;
  audit: number;
} {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    workspaces: count('workspaces'),
    schemas: count('lims_schema'),
    entities: count('lims_entity'),
    audit: count('lims_audit'),
  };
}

function openFileBackedUnlockTransactionDb(dbPath: string): {
  db: ReturnType<typeof openFileTestDb>;
  close: () => void;
} {
  const db = openFileTestDb(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return { db, close: () => db.close() };
}

type TestBoundaryFolder = {
  ref: { id: string };
  name: string;
  parentFolderId: string | null;
};

function hierarchyPathById(folders: readonly TestBoundaryFolder[]): Map<string, string> {
  const folderById = new Map(folders.map((folder) => [folder.ref.id, folder]));
  const pathById = new Map<string, string>();
  const resolving = new Set<string>();

  const resolvePath = (folder: TestBoundaryFolder): string => {
    const existing = pathById.get(folder.ref.id);
    if (existing) return existing;
    if (resolving.has(folder.ref.id)) {
      throw new Error(`Test fixture folder cycle at ${folder.ref.id}.`);
    }
    resolving.add(folder.ref.id);
    const parent = folder.parentFolderId ? folderById.get(folder.parentFolderId) : null;
    if (folder.parentFolderId && !parent) {
      throw new Error(`Test fixture folder ${folder.ref.id} has an unknown parent.`);
    }
    const path = parent ? `${resolvePath(parent)}/${folder.name}` : folder.name;
    resolving.delete(folder.ref.id);
    pathById.set(folder.ref.id, path);
    return path;
  };

  for (const folder of folders) resolvePath(folder);
  return pathById;
}

function requiredTestPath(pathById: ReadonlyMap<string, string>, folderId: string): string {
  const path = pathById.get(folderId);
  if (!path) throw new Error(`Test fixture is missing folder ${folderId}.`);
  return path;
}

describe('migration staging workspace', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'benchling-staging-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a git-backed, persisted workspace without exposing it in the global library', async () => {
    const globalDb = createGlobalDb();
    const store = new MigrationStore(createTestDb());
    const run = await createMigrationStagingWorkspace({
      scope: {
        version: 1,
        kind: 'file',
        source: { id: 'seq_1', url: 'https://example.benchling.com/example/seq_1' },
      },
      displayName: '../ Peter migration ',
      deps: {
        managedRootDir: root,
        globalDb,
        appVersion: '0.6.4-test',
        createWorkspaceId: () => 'workspace-1',
        now: () => '2026-07-17T00:00:00.000Z',
        openStore: () => store,
      },
    });

    expect(run.displayName).toBe('.. Peter migration');
    expect(run.converterVersions).toEqual({
      app: '0.6.4-test',
      bundle: 'benchling-migration-bundle-v1',
      projection: BENCHLING_MIGRATION_PROJECTION_VERSION,
    });
    expect(store.getRun()).toEqual(run);
    expect(existsSync(join(run.workspacePath, '.git'))).toBe(true);
    expect(existsSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'))).toBe(true);
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 0,
    });
    expect(readFileSync(join(run.workspacePath, '.gitignore'), 'utf8')).toContain(
      'migration.sqlite*'
    );
    globalDb.close();
  });

  it('hard-blocks unlock until validation passes', async () => {
    const globalDb = createGlobalDb();
    const store = new MigrationStore(createTestDb());
    const run = await createMigrationStagingWorkspace({
      scope: {
        version: 1,
        kind: 'file',
        source: { id: 'seq_1', url: 'https://example.benchling.com/example/seq_1' },
      },
      displayName: 'Peter migration',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => 'workspace-2',
        now: () => '2026-07-17T00:00:00.000Z',
        openStore: () => store,
      },
    });
    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        openStore: () => store,
      })
    ).rejects.toThrow(/validation has not passed/i);
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 0,
    });
    globalDb.close();
  });

  it('keeps a validated local workspace locked when its latest linked-item attempt failed', async () => {
    const globalDb = createGlobalDb();
    const sourceSha256: `sha256:${string}` = `sha256:${'8'.repeat(64)}`;
    const run: MigrationRun = {
      version: 1,
      id: 'migration-linked-recovery-failed',
      workspaceId: 'workspace-linked-recovery-failed',
      workspacePath: join(root, 'workspace-linked-recovery-failed', 'repo'),
      displayName: 'Failed linked-item recovery',
      scope: {
        version: 1,
        kind: 'folder',
        acquisition: 'local_bundle',
        folder: {
          id: 'lib_LINKED_RECOVERY',
          url: 'https://benchling.com/example/f_/lib_LINKED_RECOVERY/',
          objectType: 'folder',
        },
        includeChildren: false,
        includeArchived: false,
      },
      binding: null,
      state: 'ready_to_unlock',
      resumeState: null,
      attempt: 1,
      converterVersions: {},
      createdAt: '2026-08-13T17:00:00.000Z',
      updatedAt: '2026-08-13T17:00:02.000Z',
      startedAt: '2026-08-13T17:00:00.500Z',
      unlockedAt: null,
      lastError: null,
      localExportArtifact: {
        schema: 'dnaforge.benchling.local-export-artifact.v1',
        format: 'zip',
        logicalFilename: 'original.zip',
        sha256: sourceSha256,
        sizeBytes: 1,
        immutableLocalPath: join(root, 'private', 'original.zip'),
        capturedAt: '2026-08-13T17:00:00.750Z',
        archive: {
          entryCount: 1,
          totalCompressedEntryBytes: 1,
          totalUncompressedEntryBytes: 1,
        },
        resources: [],
      },
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        attemptId: 'linked-recovery-failed',
        state: 'failed',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 1,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-13T17:00:02.000Z',
        errorMessage: 'Recovered content did not validate.',
      },
    };
    const empty = { expected: 0, actual: 0, passed: true, issues: [] };
    const report: ValidationReport = {
      version: 1,
      runId: run.id,
      scope: run.scope,
      snapshotId: 'snapshot-linked-recovery-failed',
      accountHash: sourceSha256,
      generatedAt: '2026-08-13T17:00:01.000Z',
      passed: true,
      sourceObjects: empty,
      attachments: empty,
      memberships: empty,
      relationships: {
        ...empty,
        countsByClass: {
          exact: 0,
          heuristic: 0,
          ambiguous: 0,
          unresolved: 0,
          external: 0,
          source_broken: 0,
        },
      },
      projections: {
        ...empty,
        native: 0,
        nativeRepresentations: { dnaSequence: 0, strain: 0, needsSequence: 0 },
        artifact: 0,
        exceptions: 0,
      },
      hashes: empty,
      rendering: empty,
      issues: [],
    };
    const close = vi.fn();
    const store = {
      getRun: vi.fn(() => run),
      getValidationReport: vi.fn(() => report),
      listLinkedItemRecoveryAttempts: vi.fn(() => [{ state: 'failed' }]),
      close,
    } as unknown as MigrationStore;

    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        openStore: () => store,
      })
    ).rejects.toThrow(/linked-item recovery must finish/iu);
    expect(close).toHaveBeenCalledOnce();
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 0,
    });
    globalDb.close();
  });

  it.each(['folder', 'folder_tree'] as const)(
    'unlocks an exact provider-free local %s report without provider pagination evidence',
    async (kind) => {
      const globalDb = createGlobalDb();
      const store = new MigrationStore(createTestDb());
      const selectedRoot = {
        id: 'lib_LOCAL_UNLOCK',
        url: 'https://benchling.com/example/f_/lib_LOCAL_UNLOCK-selected-root/',
        objectType: 'folder',
      } as const;
      const scope: MigrationScope =
        kind === 'folder'
          ? {
              version: 1,
              kind,
              acquisition: 'local_bundle',
              folder: selectedRoot,
              includeChildren: false,
              includeArchived: false,
            }
          : {
              version: 1,
              kind,
              acquisition: 'local_bundle',
              roots: [selectedRoot],
              includeChildren: true,
              includeArchived: false,
            };
      let run = await createMigrationStagingWorkspace({
        scope,
        displayName: `Local ${kind} unlock`,
        deps: {
          managedRootDir: root,
          globalDb,
          createWorkspaceId: () => `workspace-local-${kind}-unlock`,
          now: () => '2026-08-04T04:00:00.000Z',
          openStore: () => store,
        },
      });
      run = transitionMigrationRun(run, 'identity_confirmation', '2026-08-04T04:00:00.500Z');
      store.saveRun(run);
      run = transitionMigrationRun(run, 'scope_planning', '2026-08-04T04:00:00.750Z');
      store.saveRun(run);
      const sourcePath = join(root, `local-${kind}-unlock.zip`);
      const fixture = buildSyntheticNativeExportZip([
        {
          path: 'Selected Root/Direct Entry (etr_LOCALDIRECT).html',
          bytes: '<!doctype html><html><body><h1>Direct entry</h1></body></html>',
        },
        {
          path: 'Selected Root/Child Folder/Child Entry (etr_LOCALCHILD).html',
          bytes: '<!doctype html><html><body><h1>Child entry</h1></body></html>',
        },
        {
          path: 'Selected Root/Direct DNA (seq_LOCALDNA).gb',
          bytes:
            'LOCUS       seq_LOCALDNA       8 bp    DNA     linear\nDEFINITION  Direct DNA.\nORIGIN\n        1 acgtacgt\n//\n',
        },
        {
          path: 'Selected Root/Direct RNA (seq_LOCALRNA).gb',
          bytes:
            'LOCUS       seq_LOCALRNA       8 bp    RNA     linear\nDEFINITION  Direct RNA.\nORIGIN\n        1 acguacgu\n//\n',
        },
        {
          path: 'Selected Root/Direct Protein (prtn_LOCALPROTEIN).fasta',
          bytes: '>prtn_LOCALPROTEIN Direct Protein\nMKWVTF\n',
        },
      ]);
      writeFileSync(sourcePath, fixture.bytes);
      const intakeDescriptor = await createLocalBenchlingExportIntakeDescriptor({
        sourcePath,
        selectedAt: '2026-08-04T04:00:01.000Z',
      });
      run = {
        ...run,
        localExportIntake: intakeDescriptor,
        updatedAt: '2026-08-04T04:00:01.000Z',
      };
      store.saveRun(run);
      const artifact = await intakeLocalBenchlingExportBundle({
        workspacePath: run.workspacePath,
        sourcePath,
        expectedDescriptor: intakeDescriptor,
      });
      if (artifact.format !== 'zip') throw new Error('Expected a ZIP local export fixture.');
      const { localExportIntake: _completedIntake, ...withoutIntake } = run;
      run = {
        ...withoutIntake,
        startedAt: '2026-08-04T04:00:01.000Z',
        updatedAt: '2026-08-04T04:00:01.000Z',
        localExportArtifact: {
          schema: artifact.schema,
          format: artifact.format,
          logicalFilename: artifact.logicalFilename,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          immutableLocalPath: artifact.immutableLocalPath,
          capturedAt: '2026-08-04T04:00:01.000Z',
          archive: artifact.archive,
          resources: artifact.resources,
        },
      };
      store.saveRun(run);
      const result = await executeLocalBundleMigration(run, {
        store,
        archive: new ContentArchive(join(run.workspacePath, '.dnaforge', 'migration', 'archive')),
        now: () => '2026-08-04T04:00:02.000Z',
        renderValidator: async ({ selectedSourceObjectIds }) =>
          selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: true })),
      });

      expect(result.report).toMatchObject({
        passed: true,
        projections: {
          native: kind === 'folder' ? 4 : 5,
          portableFile: 0,
          fallback: 0,
        },
        scopedBoundary: { passed: true, evidence: null },
        localExport: { passed: true, evidence: { format: 'zip', networkRequests: 0 } },
      });
      expect(result.report.projections.adapterStaging).toBeGreaterThan(0);
      expect(
        existsSync(join(run.workspacePath, '.dnaforge/migration/collection-projection.json'))
      ).toBe(true);
      expect(
        existsSync(join(run.workspacePath, '.dnaforge/migration/destination-link-index.v1.json'))
      ).toBe(true);
      expect(existsSync(join(run.workspacePath, 'Benchling Imports/Collections'))).toBe(true);
      const unlocked = await unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        now: () => '2026-08-04T04:00:03.000Z',
        openStore: () => store,
      });

      expect(unlocked.workspaceId).toBe(run.workspaceId);
      expect(store.getRun()?.state).toBe('unlocked');
      expect(existsSync(join(run.workspacePath, '.forge/catalog.json'))).toBe(true);
      const nativeCatalog = JSON.parse(
        readFileSync(join(run.workspacePath, '.forge/catalog.json'), 'utf8')
      ) as { entities: Array<{ name: string; type: string }> };
      expect(
        nativeCatalog.entities
          .filter((entity) => entity.type === 'sequence' || entity.type === 'protein')
          .map((entity) => entity.name)
          .sort()
      ).toEqual(['Direct DNA', 'Direct Protein', 'Direct RNA']);
      expect(
        existsSync(join(run.workspacePath, '.dnaforge/migration/collection-projection.json'))
      ).toBe(false);
      expect(
        existsSync(join(run.workspacePath, '.dnaforge/migration/destination-link-index.v1.json'))
      ).toBe(false);
      expect(existsSync(join(run.workspacePath, 'Benchling Imports/Collections'))).toBe(false);
      expect(
        allFilesUnder(run.workspacePath).some((path) => path.endsWith('.dnaforge-collection.json'))
      ).toBe(false);
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 1,
      });
      expect(
        globalDb.prepare('SELECT type, COUNT(*) AS count FROM catalog_entities GROUP BY type').all()
      ).toEqual(
        expect.arrayContaining([
          { type: 'folder', count: kind === 'folder' ? 1 : 2 },
          { type: 'notebook', count: kind === 'folder' ? 1 : 2 },
          { type: 'sequence', count: 2 },
          { type: 'protein', count: 1 },
        ])
      );
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM pages').get()).toEqual({
        count: kind === 'folder' ? 1 : 2,
      });
      expect(
        globalDb.prepare('SELECT kind, COUNT(*) AS count FROM lims_entity GROUP BY kind').all()
      ).toEqual([
        { kind: 'dna_sequence', count: 1 },
        { kind: 'protein', count: 1 },
        { kind: 'rna_sequence', count: 1 },
      ]);
      const nativeManifestText = readFileSync(
        join(run.workspacePath, '.forge/catalog.json'),
        'utf8'
      );
      expect(nativeManifestText).not.toContain(run.workspacePath);
      const nativeManifest = JSON.parse(nativeManifestText) as {
        entities: Array<{
          lims?: { kind: string; fields: { sequence?: Record<string, unknown> } };
        }>;
      };
      expect(
        nativeManifest.entities
          .filter((entity) => entity.lims)
          .map((entity) => ({
            kind: entity.lims?.kind,
            pathBase: entity.lims?.fields.sequence?.pathBase,
          }))
      ).toEqual([
        { kind: 'dna_sequence', pathBase: 'workspace' },
        { kind: 'protein', pathBase: 'workspace' },
        { kind: 'rna_sequence', pathBase: 'workspace' },
      ]);
      globalDb.close();
    }
  );

  it('persists and projects the complete hierarchy from a local Folder ZIP', async () => {
    const globalDb = createGlobalDb();
    const store = new MigrationStore(createTestDb());
    const fixture = buildNestedFolderTreeNativeExportFixture();
    const selectedRoot = {
      id: 'lib_WHOLETREE',
      url: 'https://benchling.com/example/f_/lib_WHOLETREE-selected-root/',
      objectType: 'folder',
    } as const;
    const scope: MigrationScope = {
      version: 1,
      kind: 'folder_tree',
      acquisition: 'local_bundle',
      roots: [selectedRoot],
      includeChildren: true,
      includeArchived: false,
    };
    let run = await createMigrationStagingWorkspace({
      scope,
      displayName: 'Whole folder tree',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => 'workspace-whole-folder-tree',
        now: () => '2026-08-24T18:00:00.000Z',
        openStore: () => store,
      },
    });
    run = transitionMigrationRun(run, 'identity_confirmation', '2026-08-24T18:00:00.500Z');
    store.saveRun(run);
    run = transitionMigrationRun(run, 'scope_planning', '2026-08-24T18:00:00.750Z');
    store.saveRun(run);

    const sourcePath = join(root, 'whole-folder-tree.zip');
    writeFileSync(sourcePath, fixture.archive.bytes);
    const intakeDescriptor = await createLocalBenchlingExportIntakeDescriptor({
      sourcePath,
      selectedAt: '2026-08-24T18:00:01.000Z',
    });
    run = {
      ...run,
      localExportIntake: intakeDescriptor,
      updatedAt: '2026-08-24T18:00:01.000Z',
    };
    store.saveRun(run);
    const artifact = await intakeLocalBenchlingExportBundle({
      workspacePath: run.workspacePath,
      sourcePath,
      expectedDescriptor: intakeDescriptor,
    });
    if (artifact.format !== 'zip') throw new Error('Expected a ZIP local export fixture.');
    const { localExportIntake: _completedIntake, ...withoutIntake } = run;
    run = {
      ...withoutIntake,
      startedAt: '2026-08-24T18:00:01.000Z',
      updatedAt: '2026-08-24T18:00:01.000Z',
      localExportArtifact: {
        schema: artifact.schema,
        format: artifact.format,
        logicalFilename: artifact.logicalFilename,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        immutableLocalPath: artifact.immutableLocalPath,
        capturedAt: '2026-08-24T18:00:01.000Z',
        archive: artifact.archive,
        resources: artifact.resources,
      },
    };
    store.saveRun(run);

    const result = await executeLocalBundleMigration(run, {
      store,
      archive: new ContentArchive(join(run.workspacePath, '.dnaforge', 'migration', 'archive')),
      now: () => '2026-08-24T18:00:02.000Z',
      renderValidator: async ({ selectedSourceObjectIds }) =>
        selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: true })),
    });

    expect(result.report.passed).toBe(true);
    expect(result.report.issues.filter((issue) => issue.code === 'local_export_warning')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocking: false,
          message: expect.stringContaining('Empty DNA (seq_TREEEMPTY).gb was preserved'),
        }),
        expect.objectContaining({
          blocking: false,
          message: expect.stringContaining('Metadata only (bfi_UNKNOWNX).txt was preserved'),
        }),
      ])
    );
    if (!isValidationReportV2(result.report) || !result.report.localExport) {
      throw new Error('Expected an exact v2 local Folder Tree report.');
    }
    expect(result.report.localExport.evidence.nativeFolderZipInventory).toMatchObject({
      canonicalObjects: {
        archiveTotal: fixture.expectedUniqueStableIds.length,
        selectedTotal: fixture.expectedUniqueStableIds.length,
        importedTotal: fixture.expectedUniqueStableIds.length,
        skipped: [],
      },
    });
    expect(store.listProjectionReceipts(run.id)).toHaveLength(
      fixture.expectedUniqueStableIds.length
    );

    const boundary = JSON.parse(
      readFileSync(
        join(run.workspacePath, '.dnaforge/migration/scoped-folder-boundary.json'),
        'utf8'
      )
    ) as {
      scope: MigrationScope;
      folders: Array<{
        ref: { id: string };
        name: string;
        parentFolderId: string | null;
      }>;
    };
    expect(boundary.scope).toEqual(scope);
    const folderPathById = hierarchyPathById(boundary.folders);
    expect([...folderPathById.values()].sort()).toEqual([...fixture.expectedFolderPaths].sort());
    const grandchildId = [...folderPathById].find(
      ([, path]) => path === fixture.expectedGrandchildPath
    )?.[0];
    const grandchild = boundary.folders.find((folder) => folder.ref.id === grandchildId);
    expect(folderPathById.get(grandchild?.parentFolderId ?? '')).toBe(
      fixture.expectedGrandchildParentPath
    );

    const persistedMembershipPairs = store
      .listSourceObjects(run.id)
      .flatMap((sourceObject) =>
        sourceObject.memberships.map(
          (folderId) => `${sourceObject.stableId}\0${requiredTestPath(folderPathById, folderId)}`
        )
      )
      .sort();
    expect(persistedMembershipPairs).toEqual(fixture.expectedMembershipPairs);

    const collectionProjection = JSON.parse(
      readFileSync(
        join(run.workspacePath, '.dnaforge/migration/collection-projection.json'),
        'utf8'
      )
    ) as {
      collections: unknown[];
      objectMemberships: Array<{ sourceObjectId: string; sourceMembershipIds: string[] }>;
    };
    expect(collectionProjection.collections).toHaveLength(fixture.expectedFolderPaths.length);
    expect(collectionProjection.objectMemberships).toHaveLength(
      fixture.expectedUniqueStableIds.length
    );
    expect(
      existsSync(
        join(run.workspacePath, 'Benchling Imports/Folders/Selected Root/Alpha/Grandchild/.gitkeep')
      )
    ).toBe(true);

    globalDb.close();
  });

  function allFilesUnder(rootPath: string): string[] {
    const files: string[] = [];
    const visit = (directoryPath: string): void => {
      for (const name of readdirSync(directoryPath)) {
        const path = join(directoryPath, name);
        if (statSync(path).isDirectory()) visit(path);
        else files.push(path);
      }
    };
    visit(rootPath);
    return files;
  }

  it('keeps a local Folder locked when its passing report claims provider activity', async () => {
    const globalDb = createGlobalDb();
    const store = new MigrationStore(createTestDb());
    const scope: MigrationScope = {
      version: 1,
      kind: 'folder',
      acquisition: 'local_bundle',
      folder: {
        id: 'lib_LOCAL_REJECT',
        url: 'https://benchling.com/example/f_/lib_LOCAL_REJECT-selected-root/',
        objectType: 'folder',
      },
      includeChildren: false,
      includeArchived: false,
    };
    let run = await createMigrationStagingWorkspace({
      scope,
      displayName: 'Reject inexact local Folder report',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => 'workspace-local-folder-reject',
        now: () => '2026-08-04T04:10:00.000Z',
        openStore: () => store,
      },
    });
    run = transitionMigrationRun(run, 'identity_confirmation', '2026-08-04T04:10:00.500Z');
    store.saveRun(run);
    run = transitionMigrationRun(run, 'scope_planning', '2026-08-04T04:10:00.750Z');
    store.saveRun(run);
    const sourcePath = join(root, 'local-folder-reject.zip');
    const fixture = buildSyntheticNativeExportZip([
      {
        path: 'Selected Root/Direct Entry (etr_LOCALREJECT).html',
        bytes: '<!doctype html><html><body><h1>Direct entry</h1></body></html>',
      },
    ]);
    writeFileSync(sourcePath, fixture.bytes);
    const intakeDescriptor = await createLocalBenchlingExportIntakeDescriptor({
      sourcePath,
      selectedAt: '2026-08-04T04:10:01.000Z',
    });
    run = {
      ...run,
      localExportIntake: intakeDescriptor,
      updatedAt: '2026-08-04T04:10:01.000Z',
    };
    store.saveRun(run);
    const artifact = await intakeLocalBenchlingExportBundle({
      workspacePath: run.workspacePath,
      sourcePath,
      expectedDescriptor: intakeDescriptor,
    });
    if (artifact.format !== 'zip') throw new Error('Expected a ZIP local export fixture.');
    const { localExportIntake: _completedIntake, ...withoutIntake } = run;
    run = {
      ...withoutIntake,
      startedAt: '2026-08-04T04:10:01.000Z',
      updatedAt: '2026-08-04T04:10:01.000Z',
      localExportArtifact: {
        schema: artifact.schema,
        format: artifact.format,
        logicalFilename: artifact.logicalFilename,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        immutableLocalPath: artifact.immutableLocalPath,
        capturedAt: '2026-08-04T04:10:01.000Z',
        archive: artifact.archive,
        resources: artifact.resources,
      },
    };
    store.saveRun(run);
    const result = await executeLocalBundleMigration(run, {
      store,
      archive: new ContentArchive(join(run.workspacePath, '.dnaforge', 'migration', 'archive')),
      now: () => '2026-08-04T04:10:02.000Z',
      renderValidator: async ({ selectedSourceObjectIds }) =>
        selectedSourceObjectIds.map((sourceObjectId) => ({ sourceObjectId, passed: true })),
    });
    if (!isValidationReportV2(result.report) || !result.report.localExport) {
      throw new Error('Expected an exact v2 local export report.');
    }
    store.saveValidationReport({
      ...result.report,
      localExport: {
        ...result.report.localExport,
        evidence: { ...result.report.localExport.evidence, networkRequests: 1 as 0 },
      },
    });

    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        openStore: () => store,
      })
    ).rejects.toThrow(/exact provider-free local Folder authority/i);
    expect(store.getRun()?.state).toBe('ready_to_unlock');
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 0,
    });
    globalDb.close();
  });

  it.each(['head', 'marker', 'commit'] as const)(
    'rolls back global workspace and LIMS state when %s finalization fails',
    async (failurePoint) => {
      const globalDb = createTestDb();
      ensureSchema(globalDb, ':memory:');
      const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
        root,
        globalDb,
        workspaceId: `workspace-atomic-${failurePoint}`,
      });
      const before = globalUnlockCounts(globalDb);
      const failure = new Error(`injected ${failurePoint} failure`);
      const finalizationDeps =
        failurePoint === 'head'
          ? { resolveHeadCommit: async () => null }
          : failurePoint === 'marker'
            ? {
                writeStagingMarker: async () => {
                  throw failure;
                },
              }
            : {
                commitAllIfDirty: async () => {
                  throw failure;
                },
              };

      await expect(
        unlockMigrationWorkspace({
          workspacePath: run.workspacePath,
          globalDb,
          now: () => '2026-07-17T00:11:00.000Z',
          openStore: () => store,
          finalizationDeps,
        })
      ).rejects.toThrow(failurePoint === 'head' ? /registration is incomplete/i : failure.message);

      expect(globalUnlockCounts(globalDb)).toEqual(before);
      expect(store.getRun()?.state).toBe('ready_to_unlock');
      expect(
        JSON.parse(
          readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
        )
      ).toMatchObject({ status: 'locked' });
      expect(existsSync(join(run.workspacePath, '.waypoint', 'lims'))).toBe(false);

      const unlocked = await unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        now: () => '2026-07-17T00:12:00.000Z',
        openStore: () => store,
      });
      expect(unlocked.workspaceId).toBe(run.workspaceId);
      expect(store.getRun()?.state).toBe('unlocked');
      expect(globalUnlockCounts(globalDb)).toMatchObject({ workspaces: 1, entities: 1 });

      migrationDb.close();
      globalDb.close();
    }
  );

  it('makes competing shared writes fail fast while isolated unlock finalization awaits', async () => {
    const fileDb = createFileTestDb('benchling-unlock-contention');
    const globalDb = fileDb.db;
    ensureSchema(globalDb, fileDb.dbPath);
    globalDb.exec('CREATE TABLE unlock_contention_probe (value TEXT NOT NULL)');
    globalDb.pragma('busy_timeout = 4200');
    const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
      root,
      globalDb,
      workspaceId: 'workspace-unlock-contention',
    });
    let contentionErrorCode: string | undefined;
    let yieldedWhileWriterOpen = false;
    let isolatedTransactionDb: ReturnType<typeof openFileTestDb> | null = null;

    const unlocked = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:11:00.000Z',
      openStore: () => store,
      finalizationDeps: {
        openTransactionDb: () => {
          const handle = openFileBackedUnlockTransactionDb(fileDb.dbPath);
          isolatedTransactionDb = handle.db;
          return handle;
        },
        commitAllIfDirty: async (workspacePath, message, options) => {
          expect(isolatedTransactionDb?.inTransaction).toBe(true);
          expect(globalDb.pragma('busy_timeout', { simple: true })).toBe(0);
          expect(options?.forceInclude).toEqual(expect.arrayContaining(['.forge/catalog.json']));
          try {
            globalDb.prepare('INSERT INTO unlock_contention_probe (value) VALUES (?)').run('poll');
          } catch (error) {
            contentionErrorCode = (error as { code?: string }).code;
          }
          await new Promise<void>((resolve) => {
            setImmediate(() => {
              yieldedWhileWriterOpen = true;
              resolve();
            });
          });
          return commitAllIfDirty(workspacePath, message, options);
        },
      },
    });

    expect(contentionErrorCode).toBe('SQLITE_BUSY');
    expect(yieldedWhileWriterOpen).toBe(true);
    expect(globalDb.pragma('busy_timeout', { simple: true })).toBe(4200);
    expect(unlocked.workspaceId).toBe(run.workspaceId);
    expect(globalUnlockCounts(globalDb)).toMatchObject({ workspaces: 1, entities: 1 });
    expect(await commitAllIfDirty(run.workspacePath, 'Verify clean unlock repository')).toBeNull();

    migrationDb.close();
    fileDb.cleanup();
  });

  it('restores shared write waiting and locked workspace state after async finalization fails', async () => {
    const fileDb = createFileTestDb('benchling-unlock-contention-failure');
    const globalDb = fileDb.db;
    ensureSchema(globalDb, fileDb.dbPath);
    globalDb.exec('CREATE TABLE unlock_contention_probe (value TEXT NOT NULL)');
    globalDb.pragma('busy_timeout = 4200');
    const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
      root,
      globalDb,
      workspaceId: 'workspace-unlock-contention-failure',
    });
    const before = globalUnlockCounts(globalDb);
    let contentionErrorCode: string | undefined;
    const failure = new Error('injected awaited finalization failure');

    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        now: () => '2026-07-17T00:11:00.000Z',
        openStore: () => store,
        finalizationDeps: {
          openTransactionDb: () => openFileBackedUnlockTransactionDb(fileDb.dbPath),
          commitAllIfDirty: async () => {
            expect(globalDb.pragma('busy_timeout', { simple: true })).toBe(0);
            try {
              globalDb
                .prepare('INSERT INTO unlock_contention_probe (value) VALUES (?)')
                .run('poll');
            } catch (error) {
              contentionErrorCode = (error as { code?: string }).code;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
            throw failure;
          },
        },
      })
    ).rejects.toThrow(failure.message);

    expect(contentionErrorCode).toBe('SQLITE_BUSY');
    expect(globalDb.pragma('busy_timeout', { simple: true })).toBe(4200);
    expect(globalUnlockCounts(globalDb)).toEqual(before);
    expect(store.getRun()?.state).toBe('ready_to_unlock');
    expect(
      JSON.parse(
        readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
      )
    ).toMatchObject({ status: 'locked' });
    expect(existsSync(join(run.workspacePath, '.waypoint', 'lims'))).toBe(false);

    const unlocked = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:12:00.000Z',
      openStore: () => store,
      finalizationDeps: {
        openTransactionDb: () => openFileBackedUnlockTransactionDb(fileDb.dbPath),
      },
    });
    expect(unlocked.workspaceId).toBe(run.workspaceId);
    expect(globalDb.pragma('busy_timeout', { simple: true })).toBe(4200);
    expect(globalUnlockCounts(globalDb)).toMatchObject({ workspaces: 1, entities: 1 });

    migrationDb.close();
    fileDb.cleanup();
  });

  it('rolls back a post-Git COMMIT failure and retries with a clean complete repository', async () => {
    const fileDb = createFileTestDb('benchling-unlock-commit-failure');
    const globalDb = fileDb.db;
    ensureSchema(globalDb, fileDb.dbPath);
    globalDb.pragma('busy_timeout = 4200');
    const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
      root,
      globalDb,
      workspaceId: 'workspace-unlock-commit-failure',
      fileBacked: true,
    });
    const before = globalUnlockCounts(globalDb);
    let rejectNextCommit = true;

    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        now: () => '2026-07-17T00:11:00.000Z',
        openStore: () => store,
        finalizationDeps: {
          openTransactionDb: () => {
            const handle = openFileBackedUnlockTransactionDb(fileDb.dbPath);
            const target = handle.db;
            const db = new Proxy(target, {
              get(database, property) {
                if (property === 'exec') {
                  return (sql: string) => {
                    if (rejectNextCommit && /^\s*COMMIT\s*;?\s*$/i.test(sql)) {
                      rejectNextCommit = false;
                      throw new Error('injected SQLite COMMIT failure');
                    }
                    return database.exec(sql);
                  };
                }
                const value = Reflect.get(database, property, database) as unknown;
                return typeof value === 'function' ? value.bind(database) : value;
              },
            }) as typeof target;
            return { db, close: handle.close };
          },
        },
      })
    ).rejects.toThrow(/injected SQLite COMMIT failure/i);

    expect(globalDb.pragma('busy_timeout', { simple: true })).toBe(4200);
    expect(globalUnlockCounts(globalDb)).toEqual(before);
    expect(store.getRun()?.state).toBe('ready_to_unlock');
    expect(
      JSON.parse(
        readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
      )
    ).toMatchObject({ status: 'locked' });
    expect(existsSync(join(run.workspacePath, '.waypoint', 'lims'))).toBe(false);

    const unlocked = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:12:00.000Z',
      openStore: () => store,
      finalizationDeps: {
        openTransactionDb: () => openFileBackedUnlockTransactionDb(fileDb.dbPath),
      },
    });
    expect(unlocked.workspaceId).toBe(run.workspaceId);
    expect(globalUnlockCounts(globalDb)).toMatchObject({ workspaces: 1, entities: 1 });
    expect(await commitAllIfDirty(run.workspacePath, 'Verify clean retry repository')).toBeNull();

    migrationDb.close();
    fileDb.cleanup();
  });

  it('keeps unlock locked and retryable when global database registration fails', async () => {
    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
      root,
      globalDb,
      workspaceId: 'workspace-atomic-global-database',
    });
    const before = globalUnlockCounts(globalDb);
    globalDb.exec(`
      CREATE TEMP TRIGGER fail_migration_workspace_registration
      BEFORE INSERT ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'injected global database registration failure');
      END
    `);

    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        now: () => '2026-07-17T00:11:00.000Z',
        openStore: () => store,
      })
    ).rejects.toThrow(/injected global database registration failure/i);

    expect(globalUnlockCounts(globalDb)).toEqual(before);
    expect(store.getRun()?.state).toBe('ready_to_unlock');
    expect(
      JSON.parse(
        readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
      )
    ).toMatchObject({ status: 'locked' });
    expect(existsSync(join(run.workspacePath, '.waypoint', 'lims'))).toBe(false);

    globalDb.exec('DROP TRIGGER fail_migration_workspace_registration');
    const unlocked = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:12:00.000Z',
      openStore: () => store,
    });
    expect(unlocked.workspaceId).toBe(run.workspaceId);
    expect(store.getRun()?.state).toBe('unlocked');
    expect(globalUnlockCounts(globalDb)).toMatchObject({ workspaces: 1, entities: 1 });

    migrationDb.close();
    globalDb.close();
  });

  it.each(['manifest entry', 'snapshot part'] as const)(
    'rehashes the immutable source %s before the first unlock mutation',
    async (corruptionTarget) => {
      const globalDb = createTestDb();
      ensureSchema(globalDb, ':memory:');
      const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
        root,
        globalDb,
        workspaceId: `workspace-corrupt-${corruptionTarget.replace(' ', '-')}`,
      });
      const snapshot = store.getSourceSnapshot(run.id);
      if (!snapshot) throw new Error('Expected source snapshot fixture.');
      const archive = new ContentArchive(
        join(run.workspacePath, '.dnaforge', 'migration', 'archive')
      );
      const manifest = await archive.readManifest(snapshot.archiveManifestId);
      const expectedBlob =
        corruptionTarget === 'manifest entry'
          ? { sha256: manifest.entries[0].sha256, size: manifest.entries[0].size }
          : { sha256: snapshot.parts[0].sha256, size: snapshot.parts[0].sizeBytes };
      const sourceBlob = await archive.verifyBlob(expectedBlob.sha256, expectedBlob.size);
      writeFileSync(sourceBlob.path, Buffer.alloc(sourceBlob.size, 0));

      await expect(
        unlockMigrationWorkspace({
          workspacePath: run.workspacePath,
          globalDb,
          now: () => '2026-07-17T00:11:00.000Z',
          openStore: () => store,
        })
      ).rejects.toThrow(/source evidence failed integrity verification/i);

      expect(globalUnlockCounts(globalDb)).toEqual({
        workspaces: 0,
        schemas: 0,
        entities: 0,
        audit: 0,
      });
      expect(store.getRun()?.state).toBe('ready_to_unlock');
      expect(
        JSON.parse(
          readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
        )
      ).toMatchObject({ status: 'locked' });
      expect(existsSync(join(run.workspacePath, 'Benchling Migration Report.md'))).toBe(false);
      expect(existsSync(join(run.workspacePath, '.waypoint', 'lims'))).toBe(false);

      migrationDb.close();
      globalDb.close();
    }
  );

  it.each(['tampered', 'added', 'symlink', 'missing'] as const)(
    'keeps the workspace locked and unregistered when a %s destination fails the unlock rehash',
    async (mutation) => {
      const globalDb = createGlobalDb();
      const initialStore = new MigrationStore(createTestDb());
      let run = await createMigrationStagingWorkspace({
        scope: {
          version: 1,
          kind: 'file',
          source: {
            id: 'seq-integrity',
            url: 'https://example.benchling.com/example/seq-integrity',
          },
        },
        displayName: 'Projection integrity migration',
        deps: {
          managedRootDir: root,
          globalDb,
          createWorkspaceId: () => `workspace-projection-${mutation}`,
          now: () => '2026-07-17T00:00:00.000Z',
          openStore: () => initialStore,
        },
      });
      run = {
        ...run,
        binding: {
          version: 1,
          benchlingOrigin: 'https://example.benchling.com',
          benchlingAccountId: 'usr_peter',
          benchlingAccountEmail: 'scientist@example.edu',
          benchlingOrganizationId: 'wrk_example',
          benchlingOrganizationName: 'Example Lab',
          chromePairingId: 'pairing-integrity',
          accountHash: 'sha256:projection-integrity',
          confirmedAt: '2026-07-17T00:00:01.000Z',
        },
        state: 'ready_to_unlock',
        updatedAt: '2026-07-17T00:10:00.000Z',
      };
      const migrationDb = createTestDb();
      const store = new MigrationStore(migrationDb);
      store.saveRun(run);
      store.saveValidationReport(passingReport(run));
      await seedUnlockSourceEvidence(run, store);
      const sourceObject = {
        id: 'seq-integrity',
        stableId: 'seq-integrity',
        sourceType: 'dna_sequence',
        name: 'Integrity sequence',
        aliases: [],
        sourceUrl: 'https://example.benchling.com/example/seq-integrity',
        attachmentHashes: [],
        memberships: [],
        metadata: {},
        content: { moleculeType: 'DNA', bases: 'ATGC', topology: 'linear', annotations: [] },
        relationships: [],
      };
      const plan = buildProjectionPlan(sourceObject, {
        runId: run.id,
        capturedAt: '2026-07-17T00:09:00.000Z',
        converterVersion: '1',
      });
      const receipt = await writeProjectionPlan({
        workspacePath: run.workspacePath,
        runId: run.id,
        sourceObjectId: sourceObject.id,
        plan,
        createdAt: '2026-07-17T00:09:00.000Z',
      });
      store.appendProjectionReceipt(receipt);
      const destination = join(run.workspacePath, receipt.destinationPath);
      if (mutation === 'tampered') writeFileSync(destination, 'tampered');
      if (mutation === 'added') writeFileSync(join(dirname(destination), 'added.txt'), 'added');
      if (mutation === 'missing') rmSync(destination);
      if (mutation === 'symlink') {
        const outside = join(run.workspacePath, 'outside.txt');
        writeFileSync(outside, 'outside');
        rmSync(destination);
        symlinkSync(outside, destination);
      }

      await expect(
        unlockMigrationWorkspace({
          workspacePath: run.workspacePath,
          globalDb,
          now: () => '2026-07-17T00:11:00.000Z',
          openStore: () => store,
        })
      ).rejects.toMatchObject({ code: 'hash_mismatch' });

      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 0,
      });
      expect(store.getRun()?.state).toBe('ready_to_unlock');
      expect(
        JSON.parse(
          readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
        )
      ).toMatchObject({ status: 'locked' });
      expect(existsSync(join(run.workspacePath, 'Benchling Migration Report.md'))).toBe(false);

      migrationDb.close();
      globalDb.close();
    }
  );

  it('rehashes a shared registry document before unlock and leaves no global state on mismatch', async () => {
    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    const { run, store, migrationDb } = await createReadyRegistryUnlockFixture({
      root,
      globalDb,
      workspaceId: 'workspace-corrupt-registry-projection',
    });
    const firstReceipt = store.listProjectionReceipts(run.id)[0];
    if (!firstReceipt) throw new Error('Expected registry projection receipt fixture.');
    store.appendProjectionReceipt({
      ...firstReceipt,
      id: 'receipt-registry-record-shared',
      sourceObjectId: 'registry-record-shared',
      destinationObjectId: 'registry-record-shared-destination',
    });
    const receipts = store.listProjectionReceipts(run.id);
    expect(new Set(receipts.map((receipt) => receipt.destinationPath)).size).toBe(1);
    writeFileSync(join(run.workspacePath, receipts[0].destinationPath), '{}\n');

    await expect(
      unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb,
        now: () => '2026-07-17T00:11:00.000Z',
        openStore: () => store,
      })
    ).rejects.toMatchObject({ code: 'hash_mismatch' });

    expect(globalUnlockCounts(globalDb)).toEqual({
      workspaces: 0,
      schemas: 0,
      entities: 0,
      audit: 0,
    });
    expect(store.getRun()?.state).toBe('ready_to_unlock');
    expect(
      JSON.parse(
        readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
      )
    ).toMatchObject({ status: 'locked' });

    migrationDb.close();
    globalDb.close();
  });

  it('writes native and machine-readable reports, commits, and registers only on explicit unlock', async () => {
    const globalDb = createGlobalDb();
    const store = new MigrationStore(createTestDb());
    let run = await createMigrationStagingWorkspace({
      scope: {
        version: 1,
        kind: 'file',
        source: { id: 'seq_1', url: 'https://example.benchling.com/example/seq_1' },
      },
      displayName: 'Peter migration',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => 'workspace-3',
        now: () => '2026-07-17T00:00:00.000Z',
        openStore: () => store,
      },
    });
    run = {
      ...run,
      binding: {
        version: 1,
        benchlingOrigin: 'https://example.benchling.com',
        benchlingAccountId: 'usr_peter',
        benchlingAccountEmail: 'scientist@example.edu',
        benchlingOrganizationId: 'wrk_example',
        benchlingOrganizationName: 'Example Lab',
        chromePairingId: 'pairing-1',
        accountHash: 'sha256:account',
        confirmedAt: '2026-07-17T00:00:01.000Z',
      },
      state: 'ready_to_unlock',
      updatedAt: '2026-07-17T00:10:00.000Z',
    };
    const readyDb = createTestDb();
    const readyStore = new MigrationStore(readyDb);
    readyStore.saveRun(run);
    const report = passingReport(run);
    readyStore.saveValidationReport(report);
    await seedUnlockSourceEvidence(run, readyStore);

    await persistMigrationWorkspaceReport(run, report);
    expect(await readCommittedMigrationReport(run.workspacePath)).toEqual(report);
    expect(
      readFileSync(join(run.workspacePath, 'Benchling Migration Report.md'), 'utf8')
    ).toContain('**Status:** Passed');
    expect(
      JSON.parse(
        readFileSync(join(run.workspacePath, '.dnaforge/migration/workspace.json'), 'utf8')
      )
    ).toMatchObject({ status: 'locked' });
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 0,
    });

    const unlocked = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:11:00.000Z',
      openStore: () => readyStore,
    });

    expect(unlocked).toMatchObject({
      workspaceId: 'workspace-3',
      repoPath: run.workspacePath,
      displayName: 'Peter migration',
    });
    expect(readyStore.getRun()?.state).toBe('unlocked');
    expect(await readCommittedMigrationReport(run.workspacePath)).toEqual(report);
    expect(readFileSync(unlocked.reportPath, 'utf8')).toContain('**Status:** Passed');
    expect(globalDb.prepare('SELECT name, path, repo_uuid FROM workspaces').get()).toEqual({
      name: 'Peter migration',
      path: run.workspacePath,
      repo_uuid: 'workspace-3',
    });

    const duplicate = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:12:00.000Z',
      openStore: () => readyStore,
      finalizationDeps: {
        resolveHeadCommit: async () => unlocked.headCommit,
        openTransactionDb: () => {
          throw new Error('Duplicate unlock attempted to rematerialize the workspace.');
        },
      },
    });
    expect(duplicate).toEqual(unlocked);
    expect(globalDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
      count: 1,
    });
    readyDb.close();
    globalDb.close();
  });

  it('materializes persisted registry projections as native editable LIMS data during unlock', async () => {
    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    const initialStore = new MigrationStore(createTestDb());
    let run = await createMigrationStagingWorkspace({
      scope: {
        version: 1,
        kind: 'file',
        source: { id: 'registry-record-1', url: 'https://example.benchling.com/registry/REG-42' },
      },
      displayName: 'Native registry migration',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => 'workspace-registry-native',
        now: () => '2026-07-17T00:00:00.000Z',
        openStore: () => initialStore,
      },
    });
    run = {
      ...run,
      binding: {
        version: 1,
        benchlingOrigin: 'https://example.benchling.com',
        benchlingAccountId: 'usr_peter',
        benchlingAccountEmail: 'scientist@example.edu',
        benchlingOrganizationId: 'wrk_example',
        benchlingOrganizationName: 'Example Lab',
        chromePairingId: 'pairing-1',
        accountHash: 'sha256:account',
        confirmedAt: '2026-07-17T00:00:01.000Z',
      },
      state: 'ready_to_unlock',
      updatedAt: '2026-07-17T00:10:00.000Z',
    };
    const document = buildBenchlingRegistryProjection({
      destinationWorkspaceId: 'workspace-registry-native',
      organizationId: 'wrk_example',
      converterVersion: 'test-v1',
      capturedAt: '2026-07-17T00:09:00.000Z',
      schemas: [
        {
          sourceSchemaId: 'schema-sample',
          sourceRevisionId: 'schema-sample:r1',
          sourceRevisionNumber: 1,
          name: 'Sample',
          displayName: 'Sample',
          fields: [
            {
              sourceFieldId: 'field-description',
              definition: { key: 'description', label: 'Description', type: 'text' },
            },
          ],
        },
      ],
      records: [
        {
          sourceSchemaRevisionId: 'schema-sample:r1',
          fieldValues: { description: 'Captured from Benchling' },
          sourceObject: {
            id: 'registry-record-1',
            stableId: 'registry-record-1',
            sourceType: 'registry_record',
            schemaId: 'schema-sample',
            name: 'Native record',
            registryId: 'REG-42',
            aliases: [],
            sourceUrl: 'https://example.benchling.com/registry/REG-42',
            attachmentHashes: [],
            memberships: [],
            createdAt: '2025-01-02T03:04:05.000Z',
            modifiedAt: '2026-07-17T09:08:07.000Z',
            metadata: {},
            content: {},
            relationships: [],
          },
        },
      ],
    });
    expect(document.schemas[0].destinationSchemaId).toMatch(/^schema-[a-f0-9]{24}$/u);
    expect(document.schemas[0].destinationSchemaName).toMatch(/^imported_/u);
    expect(document.records[0].destinationEntityId).toMatch(/^entity-[a-f0-9]{24}$/u);
    expect(
      JSON.stringify({
        schemaId: document.schemas[0].destinationSchemaId,
        schemaName: document.schemas[0].destinationSchemaName,
        entityId: document.records[0].destinationEntityId,
      })
    ).not.toContain('benchling');
    const persisted = await persistBenchlingRegistryProjectionDocument({
      workspacePath: run.workspacePath,
      document,
    });

    const readyDb = createTestDb();
    const readyStore = new MigrationStore(readyDb);
    readyStore.saveRun(run);
    readyStore.saveValidationReport(passingReport(run));
    readyStore.appendProjectionReceipt({
      id: 'receipt-registry-record-1',
      runId: run.id,
      sourceObjectId: 'registry-record-1',
      destinationObjectId: document.records[0].destinationEntityId,
      destinationPath: persisted.relativePath,
      projection: 'native',
      converterId: 'benchling-registry-v1',
      converterVersion: 'test-v1',
      sourceHash: 'a'.repeat(64),
      destinationHash: persisted.sha256,
      warnings: [],
      exception: null,
      formulaEvidence: [],
      createdAt: '2026-07-17T00:09:00.000Z',
    });
    await seedUnlockSourceEvidence(run, readyStore);
    const unlocked = await unlockMigrationWorkspace({
      workspacePath: run.workspacePath,
      globalDb,
      now: () => '2026-07-17T00:11:00.000Z',
      openStore: () => readyStore,
    });

    const entity = globalDb
      .prepare(
        `SELECT registry_id, fields, workspace_id FROM lims_entity
         WHERE id = ?`
      )
      .get(document.records[0].destinationEntityId) as {
      registry_id: string;
      fields: string;
      workspace_id: number;
    };
    expect(entity.registry_id).toBe('REG-42');
    expect(entity.workspace_id).toBe(unlocked.workspaceDbId);
    expect(JSON.parse(entity.fields)).toMatchObject({
      description: 'Captured from Benchling',
      benchling_source_registry_id: 'REG-42',
    });
    expect(existsSync(join(run.workspacePath, '.waypoint/lims/manifest.json'))).toBe(true);

    readyDb.close();
    globalDb.close();
  });
});
