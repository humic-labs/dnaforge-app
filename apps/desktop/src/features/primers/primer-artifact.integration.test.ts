import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformBridge: null as ReturnType<typeof createPlatformBridge> | null,
  gitRepo: false,
  gitCommitFails: false,
  nebFetch: vi.fn(),
  namespace: vi.fn(),
  publish: vi.fn(),
  acceptedRead: null as {
    content: string;
    acceptedRevision: import('@waypoint/domain-services').ScientificAcceptedDocumentRevision;
  } | null,
}));

vi.mock('../../services/read-scientific-namespace', () => ({
  readScientificNamespace: mocks.namespace,
}));
vi.mock('../../services/publish-native-artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/publish-native-artifact')>()),
  publishNativeArtifact: mocks.publish,
}));
vi.mock('../scientific-document/services/read-scientific-text', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../scientific-document/services/read-scientific-text')>();
  return {
    ...original,
    readScientificText: (...args: Parameters<typeof original.readScientificText>) =>
      mocks.acceptedRead
        ? Promise.resolve(mocks.acceptedRead)
        : original.readScientificText(...args),
  };
});

vi.mock('../design/algorithms/neb-tm-client', () => ({ makeNebFetch: () => mocks.nebFetch }));

vi.mock('../workspace/public/git', () => ({
  isGitRepo: async () => mocks.gitRepo,
  gitStatus: async () => new Map([['primers/registry-history-pending.primer.json', '??']]),
  gitCommitPaths: async () => {
    if (mocks.gitCommitFails) throw new Error('History unavailable');
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

vi.mock('./public/primer-services', () => ({ primerServices: { persistence: undefined } }));

vi.mock('../../platform', () => ({
  platform: () => {
    if (!mocks.platformBridge) throw new Error('Test platform bridge not initialized');
    return mocks.platformBridge;
  },
}));

import type Database from 'better-sqlite3';
import { openFileTestDb } from '../../main/__tests__/test-db';
import { createLimsBridgeForDb } from '../../main/__tests__/lims-bridge-for-db';
import { saveSequenceDocumentWithLineage } from '../../main/sequence-document-save';
import type { SequenceDocumentSaveInput } from '../../shared/sequence-edit-lineage';
import { parseSequenceFileAsDocument } from '../../shared/parse-sequence-file';
import { useSequenceStore } from '../sequence/public/store';
import { persistSequenceDocument } from '../sequence/public/persist-sequence-document';
import {
  persistRichPastePrimerBindings,
  type RichPastePrimerPersistence,
} from '../sequence-clipboard/public/persist-primer-bindings';
import {
  createBinding,
  deleteBinding,
  getPrimerById,
  listBoundPrimers,
  persistOwnedPrimerBinding,
} from './primer-service';
import type { Primer } from './types';
import { computeChecksum } from '@waypoint/sequence-utils';
import type { PlatformBridge } from '../../platform/types';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { bindCatalogEntityFileInDb } from '../../main/catalog-file-binding';
import { ensureSequenceIndexInDb } from '../../main/sequence-index-command';
import {
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
} from '../../main/catalog-entity-registration';
import {
  ensureWorkspaceOwnerInDb,
  clearCatalogProjectionInDb,
  setCatalogFileStateInDb,
  releaseMissingCatalogFilePathInDb,
  refreshCatalogFileFingerprintsInDb,
} from '../../main/catalog-projection-commands';
import { recordCatalogEventInDb } from '../../main/catalog-association-commands';
import { readPrimerRelationshipAuthority } from '../../main/primer-registry-relationships';
import {
  allocatePrimerCatalogNumberInDb,
  assertPrimerRegistryProjection,
  replacePrimerLegacyProjectionInDb,
} from '../../main/primer-projection';
import {
  validateWorkspacePathInMain,
  writeWorkspaceTextFileAtomicInMain,
} from '../../main/primer-artifact-files';
import { buildFileDnaSequenceRef, buildInlineDnaSequenceRef } from '../lims/dna-sequence';
import {
  buildPrimerArtifact,
  parsePrimerArtifact,
  serializePrimerArtifact,
  sha256Hex,
  revisePrimerArtifactContent,
} from './primer-artifact';
import {
  attachPrimerArtifact,
  persistOwnedPrimerArtifactBindings,
  readSavedPrimerBindingTarget,
  detachPrimerArtifact,
  deletePrimerArtifact,
  PrimerArtifactRevisionError,
  PrimerProjectionError,
  readPrimerArtifactAtPath,
  resumePrimerArtifactSave,
  updatePrimerArtifactContent,
  reconcilePrimerArtifact,
  reconcilePrimerArtifactsInWorkspace,
  savePrimerArtifact,
  updatePrimerArtifactBinding,
} from './primer-artifact-service';
import { useSettingsStore } from '../junction-workbench/settings';
import { createPrimer, deletePrimer, importBatch, updatePrimer } from './primer-service';
import { refreshPrimerRecoveryInventory } from './primer-recovery-report';
import { NativeArtifactPublicationPendingError } from '../../services/publish-native-artifact';
import {
  getCatalogEntity,
  getCatalogEventsForEntity,
  getCatalogFileForPath,
  markCatalogFileMissing,
} from '../../db/workspace-catalog';
import { resolveFileByObjectUuid } from '../../db/resolve-by-object-uuid';
import {
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_CONDITIONS,
  DEFAULT_TM_MODEL,
  OWCZARZY_TM_MODEL,
} from '../design/algorithms/tm-model';

let db: Database.Database;
let workspaceRoot: string;
let artifactPath: string;
let targetDocumentId: string;
let targetSequenceId: number;

function dbBridge(database: Database.Database) {
  return {
    ensureSequenceIndex: async (input: Parameters<typeof ensureSequenceIndexInDb>[1]) =>
      ensureSequenceIndexInDb(database, input),
    ensureWorkspaceOwner: async (
      root: string,
      access?: Parameters<typeof ensureWorkspaceOwnerInDb>[2]
    ) => ensureWorkspaceOwnerInDb(database, root, access),
    registerCatalogEntity: async (input: Parameters<typeof registerCatalogEntityInDb>[1]) =>
      registerCatalogEntityInDb(database, input),
    registerWorkspaceFile: async (input: Parameters<typeof registerWorkspaceFileInDb>[1]) =>
      registerWorkspaceFileInDb(database, input),
    clearCatalogProjection: async (root: string) => clearCatalogProjectionInDb(database, root),
    recordCatalogEvent: async (input: Parameters<typeof recordCatalogEventInDb>[1]) =>
      recordCatalogEventInDb(database, input),
    setCatalogFileState: async (
      path: string,
      status: Parameters<typeof setCatalogFileStateInDb>[2],
      reason: string
    ) => setCatalogFileStateInDb(database, path, status, reason),
    releaseMissingCatalogFilePath: async (
      file: Parameters<typeof releaseMissingCatalogFilePathInDb>[1],
      replacement: string
    ) => releaseMissingCatalogFilePathInDb(database, file, replacement),
    refreshCatalogFileFingerprints: async (
      files: Parameters<typeof refreshCatalogFileFingerprintsInDb>[1]
    ) => refreshCatalogFileFingerprintsInDb(database, files),
    bindCatalogEntityFile: vi.fn(async (input: Parameters<typeof bindCatalogEntityFileInDb>[1]) =>
      bindCatalogEntityFileInDb(database, input)
    ),
    execute: async (sql: string, params: unknown[] = []) => {
      const result = database.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    },
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> =>
      database.prepare(sql).all(...params) as T,
    allocatePrimerCatalogNumber: vi.fn(async (workspaceId?: number) =>
      allocatePrimerCatalogNumberInDb(database, workspaceId ?? 0)
    ),
    replacePrimerProjection: vi.fn(
      async (input: Parameters<typeof replacePrimerLegacyProjectionInDb>[1], root: string) =>
        replacePrimerLegacyProjectionInDb(
          database,
          input,
          await readPrimerRelationshipAuthority(input, root)
        )
    ),
  };
}

function createPlatformBridge(
  database: Database.Database,
  lims: ReturnType<typeof createLimsTestBridge>['lims']
) {
  return {
    db: dbBridge(database),
    lims: {
      ...lims,
      readPrimerArtifactRevisionState: vi
        .fn<PlatformBridge['lims']['readPrimerArtifactRevisionState']>()
        .mockResolvedValue({ state: 'not_enrolled' }),
      revisePrimerArtifact: vi.fn<PlatformBridge['lims']['revisePrimerArtifact']>(),
      resumePrimerArtifactPublication:
        vi.fn<PlatformBridge['lims']['resumePrimerArtifactPublication']>(),
    },
    fs: {
      beginWorkspaceMutation: vi.fn(async () => 'primer-mutation-token'),
      endWorkspaceMutation: vi.fn(async () => undefined),
      readTextFile: vi.fn(async (path: string) => readFileSync(path, 'utf8')),
      readFile: async (path: string) => new Uint8Array(readFileSync(path)),
      writeTextFile: async (path: string, content: string) => writeFileSync(path, content),
      mkdir: async (path: string) => mkdirSync(path, { recursive: true }),
      stat: async (path: string) => {
        const stat = statSync(path);
        return {
          canonicalPath: realpathSync(path),
          size: stat.size,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          mtime: stat.mtimeMs,
        };
      },
      exists: async (path: string) => existsSync(path),
      rename: async (from: string, to: string) => renameSync(from, to),
      writeWorkspaceTextFileAtomic: vi.fn(writeWorkspaceTextFileAtomicInMain),
      validateWorkspacePath: validateWorkspacePathInMain,
      readDir: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
    },
    shell: { trashItem: async (path: string) => rmSync(path) },
    workspace: {
      discoverArtifacts: async () => ({ entityArtifactPaths: [] }),
    },
  };
}

function platformBridge() {
  if (!mocks.platformBridge) throw new Error('Test platform bridge not initialized');
  return mocks.platformBridge;
}

beforeEach(async () => {
  mocks.gitRepo = false;
  mocks.gitCommitFails = false;
  mocks.nebFetch.mockReset();
  mocks.namespace.mockReset().mockResolvedValue(null);
  mocks.publish.mockReset();
  mocks.acceptedRead = null;
  useSettingsStore.setState({
    tmModel: DEFAULT_TM_MODEL,
    tmModelExplicit: false,
    primerConcNm: DEFAULT_PRIMER_CONC_NM,
    primerConcExplicit: false,
    tmConditions: DEFAULT_TM_CONDITIONS,
  });
  workspaceRoot = mkdtempSync(join(tmpdir(), 'primer-primer-artifact-'));
  artifactPath = join(workspaceRoot, 'primers', 'pUC19_R1.primer.json');
  const targetPath = join(workspaceRoot, 'pUC19.gb');
  copyFileSync(
    join(process.cwd(), '..', '..', 'test-fixtures', 'sequences', 'circular', 'pUC19.gb'),
    targetPath
  );
  const bridge = createLimsTestBridge({ withOriginalProject: false });
  db = bridge.db;
  db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES (1, ?, ?, ?)`).run(
    'Primer test',
    workspaceRoot,
    Date.now()
  );
  db.prepare(
    `INSERT INTO indexed_files
      (id, workspace_id, path, name, extension, size_bytes, modified_at, indexed_at)
     VALUES (1, 1, ?, 'pUC19.gb', 'gb', 2686, ?, ?)`
  ).run(targetPath, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO sequences (id, file_id, document_id, name, length, sequence_type, circular)
     VALUES (42, 1, 'legacy-sequence:42', 'pUC19', 2686, 'dna', 1)`
  ).run();
  mocks.platformBridge = createPlatformBridge(db, bridge.lims);

  const target = await buildFileDnaSequenceRef(targetPath, { workspaceRoot });
  targetDocumentId = target.documentId;
  targetSequenceId = target.sequenceId!;
  expect(targetSequenceId).toBe(42);
  expect(db.prepare('SELECT document_id FROM sequences WHERE id=42').get()).toEqual({
    document_id: targetDocumentId,
  });
  const artifact = await buildPrimerArtifact({
    id: 'primer-entity-1',
    catalogNumber: 'PR-000001',
    name: 'pUC19_R1',
    sequence: 'GCGGGCCTCTTCGCTATTACGCCAGCTGGCGA',
    workspaceRoot,
    artifactPath,
    binding: {
      id: 'primer-binding-1',
      targetDocumentId,
      targetFilePath: targetPath,
      targetLength: target.length,
      targetTopology: target.topology,
      targetFileContentHash: target.fileContentHash ?? target.contentHash,
      targetNormalizedSequenceHash: target.normalizedSequenceHash ?? target.contentHash,
      start: 1711,
      end: 1743,
      strand: -1,
    },
    application: 'sequencing',
    notes: 'Reverse sequencing primer',
    actor: 'integration-test',
    source: 'drag-selection',
    now: 1_750_000_000_000,
  });
  mkdirSync(join(workspaceRoot, 'primers'), { recursive: true });
  writeFileSync(artifactPath, serializePrimerArtifact(artifact));
});

afterEach(() => {
  db.close();
  mocks.platformBridge = null;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function recoverRelationshipFixture(foreignOwner = false) {
  db.prepare('UPDATE workspaces SET repo_uuid = ? WHERE id = 1').run('primer-owner-uuid');
  db.prepare(
    'INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (2, ?, ?, ?, ?)'
  ).run('Foreign owner', join(workspaceRoot, 'foreign'), 'foreign-owner-uuid', Date.now());
  const primer = await mocks.platformBridge.lims.registerEntity({
    id: 'relationship-control-primer',
    kind: 'oligo',
    name: 'Relationship control',
    workspaceId: 1,
    fields: { use: 'primer', sequence: await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA') },
  });
  const target = await mocks.platformBridge.lims.registerEntity({
    id: 'relationship-control-target',
    kind: 'strain',
    name: 'Related control',
    workspaceId: 2,
    fields: { genotypeCanonical: 'test' },
  });
  const link = await mocks.platformBridge.lims.linkEntities({
    id: 'relationship-control-link',
    fromEntityId: foreignOwner ? target.id : primer.id,
    toEntityId: foreignOwner ? primer.id : target.id,
    type: 'associated_with',
    workspaceId: foreignOwner ? 2 : 1,
    payload: { note: 'original' },
    actor: 'original-actor',
  });
  expect((await reconcilePrimerArtifactsInWorkspace(workspaceRoot)).errors).toEqual([]);
  const [recovered] = await mocks.platformBridge.lims.queryEntities({ id: primer.id });
  const path = join(workspaceRoot, recovered.fields.artifact.relativePath);
  const bytes = readFileSync(path, 'utf8');
  return { primer, target, link, path, bytes };
}

describe('primer artifact reconciliation against the real LIMS engine', () => {
  it.each(['payload', 'identity'] as const)(
    'keeps a conflicting current relationship %s intact and reports retained evidence',
    async (conflict) => {
      const fixture = await recoverRelationshipFixture();
      if (conflict === 'payload') {
        await mocks.platformBridge.lims.replaceOutgoingRelationships({
          entityId: fixture.primer.id,
          workspaceId: 1,
          actor: 'newer-editor',
          relationships: [
            {
              toEntityId: fixture.target.id,
              type: 'associated_with',
              payload: { note: 'newer value' },
            },
          ],
        });
      } else {
        db.prepare('DELETE FROM lims_link WHERE id = ?').run(fixture.link.id);
        await mocks.platformBridge.lims.linkEntities({
          id: 'newer-link-identity',
          fromEntityId: fixture.primer.id,
          toEntityId: fixture.target.id,
          type: 'associated_with',
          workspaceId: 1,
          payload: { note: 'original' },
        });
      }
      const before = db.prepare('SELECT * FROM lims_link ORDER BY id').all();
      const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: fixture.path,
          message: expect.stringMatching(/relationship.*conflicts/i),
        })
      );
      expect(db.prepare('SELECT * FROM lims_link ORDER BY id').all()).toEqual(before);
      expect(readFileSync(fixture.path, 'utf8')).toBe(fixture.bytes);
      expect((await refreshPrimerRecoveryInventory()).entries).toContainEqual(
        expect.objectContaining({
          id: fixture.primer.id,
          status: 'needs-review',
          message: expect.stringMatching(/relationship.*conflicts/i),
        })
      );
    }
  );

  it('retains a missing foreign-owned incoming relationship without using the primer as foreign write authority', async () => {
    const fixture = await recoverRelationshipFixture(true);
    const saved = JSON.parse(fixture.bytes);
    expect(saved.registryRelationships[0]).toMatchObject({
      id: fixture.link.id,
      project: { status: 'assigned', repoUuid: 'foreign-owner-uuid' },
    });
    db.prepare('DELETE FROM lims_link WHERE id = ?').run(fixture.link.id);
    const targetBefore = db
      .prepare('SELECT * FROM lims_entity WHERE id = ?')
      .get(fixture.target.id);
    const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: fixture.path,
        message: expect.stringMatching(/another project.*own authority/i),
      })
    );
    expect(db.prepare('SELECT * FROM lims_link WHERE id = ?').get(fixture.link.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(fixture.target.id)).toEqual(
      targetBefore
    );
    expect(readFileSync(fixture.path, 'utf8')).toBe(fixture.bytes);
    expect((await refreshPrimerRecoveryInventory()).entries).toContainEqual(
      expect.objectContaining({ id: fixture.primer.id, status: 'needs-review' })
    );
  });

  it('rejects a non-finite saved relationship payload at the native authority reader', async () => {
    const fixture = await recoverRelationshipFixture();
    const content = fixture.bytes.replace('"note": "original"', '"note": 1e999');
    writeFileSync(fixture.path, content);
    const projection = mocks.platformBridge.db.replacePrimerProjection.mock.calls.find(
      ([input]: [{ id: string }]) => input.id === fixture.primer.id
    )[0];
    await expect(
      readPrimerRelationshipAuthority(
        {
          ...projection,
          registryRelationships: {
            relativePath: JSON.parse(content).file.workspaceRelativePath,
            contentHash: await sha256Hex(content),
          },
        },
        workspaceRoot
      )
    ).rejects.toThrow(/relationship.*JSON|JSON.*relationship/i);
  });

  it('keeps retained Registry relationships during later valid primer metadata and binding edits', async () => {
    const fixture = await recoverRelationshipFixture();
    const relationships = JSON.parse(fixture.bytes).registryRelationships;
    const edited = await updatePrimer({ id: fixture.primer.id, notes: 'Later primer edit' });
    const attached = await attachPrimerArtifact({
      primer: edited!,
      workspaceRoot,
      targetFilePath: join(workspaceRoot, 'pUC19.gb'),
      targetDocumentId,
      bindingSequenceId: targetSequenceId,
      bindingStart: 0,
      bindingEnd: 20,
      bindingStrand: 1,
    });
    expect(attached.artifact.bindings).toHaveLength(1);
    expect(JSON.parse(readFileSync(fixture.path, 'utf8')).registryRelationships).toEqual(
      relationships
    );
    expect((await reconcilePrimerArtifactsInWorkspace(workspaceRoot)).errors).toEqual([]);
    expect((await refreshPrimerRecoveryInventory()).entries).toContainEqual(
      expect.objectContaining({ id: fixture.primer.id, status: 'document-backed' })
    );
  });

  it('recovers Registry relationships into the file and rebuilds their exact state across local project IDs', async () => {
    const ownerUuid = 'aaaaaaaa-1111-4111-8111-111111111111';
    const targetUuid = 'bbbbbbbb-2222-4222-8222-222222222222';
    db.prepare('UPDATE workspaces SET repo_uuid = ? WHERE id = 1').run(ownerUuid);
    db.prepare(
      'INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (2, ?, ?, ?, ?)'
    ).run('Other project', join(workspaceRoot, 'other-project'), targetUuid, Date.now());
    const original = await mocks.platformBridge.lims.registerEntity({
      id: 'primer-relationship-recovery',
      kind: 'oligo',
      name: 'Relationship recovery',
      fields: { sequence: await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA'), use: 'primer' },
      workspaceId: 1,
    });
    for (const [id, workspaceId] of [
      ['local-related-record', 1],
      ['foreign-related-record', 2],
    ] as const) {
      await mocks.platformBridge.lims.registerEntity({
        id,
        kind: 'strain',
        name: id,
        fields: { genotypeCanonical: 'test' },
        workspaceId,
      });
    }
    for (const input of [
      {
        id: 'outgoing-cross-project',
        fromEntityId: original.id,
        toEntityId: 'foreign-related-record',
        type: 'associated_with',
        payload: { source: 'original-import', nested: { values: [1, 'retained'] } },
      },
      {
        id: 'incoming-owned-link',
        fromEntityId: 'local-related-record',
        toEntityId: original.id,
        type: 'associated_with',
        payload: { note: 'incoming' },
      },
      {
        id: 'archived-owned-link',
        fromEntityId: original.id,
        toEntityId: 'local-related-record',
        type: 'targets',
        payload: { note: 'archived evidence' },
      },
    ]) {
      await mocks.platformBridge.lims.linkEntities({
        ...input,
        actor: 'original-importer',
        workspaceId: 1,
      });
    }
    await mocks.platformBridge.lims.replaceOutgoingRelationships({
      entityId: original.id,
      relationships: [
        {
          toEntityId: 'foreign-related-record',
          type: 'associated_with',
          payload: { source: 'original-import', nested: { values: [1, 'retained'] } },
        },
      ],
      workspaceId: 1,
      actor: 'original-editor',
    });
    const originals = db.prepare('SELECT * FROM lims_link ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    expect((await reconcilePrimerArtifactsInWorkspace(workspaceRoot)).errors).toEqual([]);
    const [recovered] = await mocks.platformBridge.lims.queryEntities({ id: original.id });
    const path = join(workspaceRoot, recovered.fields.artifact.relativePath);
    const bytes = readFileSync(path, 'utf8');
    const saved = JSON.parse(bytes);
    expect(saved.registryRelationships.map((link: { id: string }) => link.id)).toEqual(
      originals.map((link) => link.id)
    );

    const fresh = createLimsTestBridge({ withOriginalProject: false });
    const previousBridge = mocks.platformBridge;
    try {
      for (const [id, uuid, path] of [
        [41, ownerUuid, workspaceRoot],
        [52, targetUuid, join(workspaceRoot, 'other-project')],
      ] as const) {
        fresh.db
          .prepare(
            'INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run(id, `Project ${id}`, path, uuid, Date.now());
      }
      mocks.platformBridge = { ...previousBridge, db: dbBridge(fresh.db), lims: fresh.lims };
      await fresh.lims.registerEntity({
        id: 'local-related-record',
        kind: 'strain',
        name: 'Local',
        fields: { genotypeCanonical: 'test' },
        workspaceId: 41,
      });
      await expect(reconcilePrimerArtifact(path, workspaceRoot)).rejects.toThrow(
        /relationship.*target.*unavailable/i
      );
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      await fresh.lims.registerEntity({
        id: 'foreign-related-record',
        kind: 'strain',
        name: 'Foreign',
        fields: { genotypeCanonical: 'test' },
        workspaceId: 52,
      });
      await reconcilePrimerArtifact(path, workspaceRoot);
      const restored = fresh.db.prepare('SELECT * FROM lims_link ORDER BY id').all() as Array<
        Record<string, unknown>
      >;
      expect(
        restored.map(({ event_seq: _eventSeq, workspace_id: _workspaceId, ...row }) => row)
      ).toEqual(
        originals.map(({ event_seq: _eventSeq, workspace_id: _workspaceId, ...row }) => row)
      );
      expect(restored.every((link) => link.workspace_id === 41)).toBe(true);
      expect(
        fresh.db
          .prepare('SELECT workspace_id FROM lims_entity WHERE id = ?')
          .get('foreign-related-record')
      ).toEqual({ workspace_id: 52 });
      const auditCount = fresh.db.prepare('SELECT COUNT(*) FROM lims_audit').pluck().get();
      await reconcilePrimerArtifact(path, workspaceRoot);
      expect(fresh.db.prepare('SELECT COUNT(*) FROM lims_audit').pluck().get()).toBe(auditCount);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    } finally {
      mocks.platformBridge = previousBridge;
      fresh.db.close();
    }
  });

  it('preserves authoritative inventory and explicit empty lifecycle values when the database projection is stale', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const artifact = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    artifact.inventory = {
      origin: 'manual',
      originDetails: null,
      vendor: 'File supplier',
      orderDate: null,
      scale: null,
      purification: null,
      modifications: null,
      stockLocation: 'File freezer',
      concentration: 40,
    };
    artifact.entity!.state = {
      registrationStatus: 'registered',
      domainStatus: null,
      archived: false,
      archivedAt: null,
      status: null,
      source: null,
    };
    writeFileSync(artifactPath, serializePrimerArtifact(artifact));
    db.prepare('UPDATE primers SET stock_location = ? WHERE id = ?').run(
      'Stale database freezer',
      artifact.id
    );
    await updatePrimer({ id: artifact.id, notes: 'Metadata only' });
    const saved = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    expect(saved.inventory).toEqual(artifact.inventory);
    expect(saved.entity!.state).toEqual(artifact.entity!.state);
    expect(
      (await mocks.platformBridge.lims.queryEntities({ id: artifact.id }))[0].fields
    ).toMatchObject({ status: null, source: null, notes: 'Metadata only' });
    expect(
      db
        .prepare('SELECT vendor, stock_location, concentration, order_date FROM primers WHERE id=?')
        .get(artifact.id)
    ).toEqual({
      vendor: 'File supplier',
      stock_location: 'File freezer',
      concentration: 40,
      order_date: null,
    });
    expect(
      (await mocks.platformBridge.lims.queryEntities({ id: artifact.id }))[0].fields
    ).not.toHaveProperty('inventory');
  });

  it('keeps lifecycle edits in the document through archive, reconciliation and restore', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const archived = await updatePrimer({ id: 'primer-entity-1', status: 'archived' });
    expect(archived?.status).toBe('archived');
    expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).entity?.state?.archived).toBe(
      true
    );
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(await mocks.platformBridge.lims.queryEntities({ id: 'primer-entity-1' })).toEqual([]);
    expect((await updatePrimer({ id: 'primer-entity-1', status: 'received' }))?.status).toBe(
      'received'
    );
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(
      (await mocks.platformBridge.lims.queryEntities({ id: 'primer-entity-1' }))[0].fields.status
    ).toBe('received');
  });

  it('leaves the saved document and both projections unchanged when an older edit cannot verify its selected provider', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const before = readFileSync(artifactPath, 'utf8');
    useSettingsStore.setState({
      tmModel: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      tmModelExplicit: true,
    });
    mocks.nebFetch.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(
      updatePrimer({ id: 'primer-entity-1', sequence: 'ACGTTGCAAGTCCTGATCGA' })
    ).rejects.toThrow(/could not verify/i);
    expect(readFileSync(artifactPath, 'utf8')).toBe(before);
    expect(db.prepare('SELECT sequence FROM primers WHERE id = ?').get('primer-entity-1')).toEqual({
      sequence: JSON.parse(before).sequence.bases,
    });
    expect(
      (await mocks.platformBridge.lims.queryEntities({ id: 'primer-entity-1' }))[0].fields.sequence
        .bases
    ).toBe(JSON.parse(before).sequence.bases);
  });

  it('keeps older attach and detach commands in the saved document with their original binding source', async () => {
    const primer = await createPrimer({
      name: 'Compatibility binding',
      sequence: 'ACGTTGCAAGTCCTGATCGA',
      workspaceId: 1,
    });
    const path = join(workspaceRoot, primer.originDetails!.artifactPath as string);
    const binding = await createBinding({
      primerId: primer.id,
      sequenceId: targetSequenceId,
      bindingStart: 5,
      bindingEnd: 25,
      strand: 1,
      source: 'accepted',
    });
    expect(parsePrimerArtifact(readFileSync(path, 'utf8')).bindings).toMatchObject([
      {
        id: binding.id,
        history: { source: 'accepted' },
        coordinates: { start: 5, end: 25, strand: 1 },
      },
    ]);
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(db.prepare('SELECT source FROM primer_bindings WHERE id = ?').get(binding.id)).toEqual({
      source: 'accepted',
    });
    await deleteBinding(binding.id);
    expect(parsePrimerArtifact(readFileSync(path, 'utf8')).bindings).toEqual([]);
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(
      db.prepare('SELECT id FROM primer_bindings WHERE id = ?').get(binding.id)
    ).toBeUndefined();
  });

  it.each(['library command', 'Explorer'] as const)(
    'retires a primer moved to Trash through %s without recovering it, and restores the same identity with its file',
    async (entryPoint) => {
      await reconcilePrimerArtifact(artifactPath, workspaceRoot);
      const trashRoot = mkdtempSync(join(tmpdir(), 'fixture-primer-trash-'));
      const trashedPath = join(trashRoot, 'primer.primer.json');
      mocks.platformBridge.shell = {
        trashItem: vi.fn(async (path: string) => renameSync(path, trashedPath)),
      };
      try {
        if (entryPoint === 'library command') {
          expect(await deletePrimer('primer-entity-1')).toEqual({ deleted: true });
          expect(await deletePrimer('primer-entity-1')).toEqual({
            deleted: false,
            reason: 'not_found',
          });
        } else {
          renameSync(artifactPath, trashedPath);
          await markCatalogFileMissing(artifactPath, 'moved-to-trash');
        }
        expect((await reconcilePrimerArtifactsInWorkspace(workspaceRoot)).errors).toEqual([]);
        expect(existsSync(artifactPath)).toBe(false);
        expect(
          db.prepare('SELECT id FROM primers WHERE id = ?').get('primer-entity-1')
        ).toBeUndefined();
        expect(
          (
            await mocks.platformBridge.lims.queryEntities({
              id: 'primer-entity-1',
              includeArchived: true,
            })
          )[0].tombstone
        ).toBe(true);
        expect(
          (await refreshPrimerRecoveryInventory()).entries.find(
            (row) => row.id === 'primer-entity-1'
          )?.status
        ).toBe('trashed');
        renameSync(trashedPath, artifactPath);
        expect((await reconcilePrimerArtifactsInWorkspace(workspaceRoot)).errors).toEqual([]);
        expect(
          (await mocks.platformBridge.lims.queryEntities({ id: 'primer-entity-1' }))[0].id
        ).toBe('primer-entity-1');
        expect(db.prepare('SELECT id FROM primers WHERE id = ?').get('primer-entity-1')).toEqual({
          id: 'primer-entity-1',
        });
      } finally {
        rmSync(trashRoot, { recursive: true, force: true });
      }
    }
  );

  it('saves legacy-command metadata edits into the same RNA document without changing its chemistry', async () => {
    const sequence = 'ACGUACGUACGUACGUACGU';
    const primer = await createPrimer({
      name: 'RNA metadata edit',
      sequence,
      workspaceId: 1,
      oligo: { vendor: 'unspecified', orderType: 'rna', notation: sequence, modifications: [] },
    });
    const [before] = await mocks.platformBridge.lims.queryEntities({ id: primer.id });
    const path = join(workspaceRoot, before.fields.artifact.relativePath);
    const original = parsePrimerArtifact(readFileSync(path, 'utf8'));
    const updated = await updatePrimer({
      id: primer.id,
      notes: 'New tube notes',
      status: 'received',
      stockLocation: 'Freezer B',
      concentration: 25,
      orderDate: 1_710_000_000_000,
    });
    expect(updated).toMatchObject({ id: primer.id, notes: 'New tube notes', status: 'received' });
    const saved = parsePrimerArtifact(readFileSync(path, 'utf8'));
    expect(saved.id).toBe(primer.id);
    expect(saved.metadata.notes).toBe('New tube notes');
    expect(saved.oligo).toEqual(original.oligo);
    expect(saved.sequence).toEqual(original.sequence);
    expect(saved.inventory).toMatchObject({
      stockLocation: 'Freezer B',
      concentration: 25,
      orderDate: 1_710_000_000_000,
    });
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    const [after] = await mocks.platformBridge.lims.queryEntities({ id: primer.id });
    expect(after.registryId).toBe(before.registryId);
    expect(after.fields).toMatchObject({ notes: 'New tube notes', status: 'received' });
    expect(
      db.prepare('SELECT stock_location, concentration FROM primers WHERE id = ?').get(primer.id)
    ).toEqual({ stock_location: 'Freezer B', concentration: 25 });
  });

  it('keeps provider failures as row errors without saving an unverified import', async () => {
    useSettingsStore.setState({
      tmModel: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      tmModelExplicit: true,
    });
    mocks.nebFetch.mockRejectedValueOnce(new Error('Provider unavailable')).mockResolvedValueOnce({
      tm: 64.5,
      nebApiVersion: 'test',
      fetchedAt: '2026-08-11T00:00:00.000Z',
    });
    const result = await importBatch([
      { name: 'Unverified import', sequence: 'ATCGATCGATCGATCGATCG', workspaceId: 1 },
      { name: 'Verified import', sequence: 'GCTAGCTAGCTAGCTAGCTA', workspaceId: 1 },
    ]);
    expect(result).toMatchObject({
      imported: 1,
      errors: [{ index: 0, reason: expect.stringMatching(/could not verify/i) }],
    });
    expect(db.prepare('SELECT name FROM primers').all()).toEqual([{ name: 'Verified import' }]);
    expect(
      await mocks.platformBridge.lims.queryEntities({ nameLike: 'Unverified import' })
    ).toEqual([]);
  });

  it('does not merge DNA and RNA orders merely because their natural bases match', async () => {
    const sequence = 'ACGACGACGACGACGACG';
    const result = await importBatch([
      { name: 'DNA order', sequence, workspaceId: 1 },
      {
        name: 'RNA order',
        sequence,
        workspaceId: 1,
        oligo: { vendor: 'unspecified', orderType: 'rna', notation: sequence, modifications: [] },
      },
    ]);
    expect(result).toMatchObject({ imported: 2, duplicates: 0, errors: [] });
    const entities = await mocks.platformBridge.lims.queryEntities({});
    expect(entities.map((entity: { kind: string }) => entity.kind).sort()).toEqual([
      'oligo',
      'rna_oligo',
    ]);
    expect(new Set(entities.map((entity: { id: string }) => entity.id)).size).toBe(2);
  });

  it('keeps one selected calculation model and bounds provider work while importing saved documents', async () => {
    useSettingsStore.setState({
      tmModel: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      tmModelExplicit: true,
    });
    const releases: Array<() => void> = [];
    const response = { tm: 64.5, nebApiVersion: 'test', fetchedAt: '2026-08-11T00:00:00.000Z' };
    mocks.nebFetch.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(response)))
    );
    const sequences = [
      'ATCGATCGATCGATCGATCG',
      'GCTAGCTAGCTAGCTAGCTA',
      'AACCGGTTAACCGGTTAACC',
      'TTGGCCAATTGGCCAATTGG',
      'AGCTAGCTAGCTAGCTAGCT',
      'CGATCGATCGATCGATCGAT',
    ];
    const pending = importBatch(
      sequences.map((sequence, index) => ({
        name: `Provider batch ${index}`,
        sequence,
        workspaceId: 1,
      }))
    );
    try {
      await vi.waitFor(() => expect(mocks.nebFetch).toHaveBeenCalledTimes(4));
      expect(releases).toHaveLength(4);
      useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL, tmModelExplicit: true });
      releases.splice(0).forEach((release) => release());
      await vi.waitFor(() => expect(mocks.nebFetch).toHaveBeenCalledTimes(6));
      releases.splice(0).forEach((release) => release());
      expect(await pending).toMatchObject({ imported: 6, errors: [] });
      const paths = db
        .prepare(
          "SELECT path FROM catalog_entity_files WHERE status = ? AND file_kind = 'primer-artifact'"
        )
        .all('current') as Array<{ path: string }>;
      expect(paths).toHaveLength(6);
      for (const { path } of paths)
        expect(
          parsePrimerArtifact(readFileSync(path, 'utf8')).computed.tmCalculation
        ).toMatchObject({
          model: { kind: 'neb', prodcode: 'q5-0' },
          status: 'verified',
          valueC: 64.5,
        });
    } finally {
      mocks.nebFetch.mockResolvedValue(response);
      releases.splice(0).forEach((release) => release());
      await pending;
    }
  });

  it('recognizes an existing schema-defined primer document without replacing it or reporting data loss', async () => {
    const id = 'schema-record-primer';
    const relativePath = 'records/schema-record-primer.entity.json';
    const path = join(workspaceRoot, relativePath);
    const sequence = await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA');
    const document = {
      schema: 'waypoint.entity.v1',
      id,
      kind: 'oligo',
      name: 'Schema record primer',
      fields: { sequence, use: 'primer' },
      registrationStatus: 'registered',
      domainStatus: null,
      source: { type: 'manual', values: {} },
      relationships: [],
    };
    mkdirSync(join(workspaceRoot, 'records'));
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    writeFileSync(path, bytes);
    await mocks.platformBridge.lims.registerEntity({
      id,
      kind: 'oligo',
      name: document.name,
      workspaceId: 1,
      fields: { ...document.fields, artifact: { schema: document.schema, relativePath } },
    });
    const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(result.errors).toEqual([]);
    const report = await refreshPrimerRecoveryInventory();
    expect(report.entries).toContainEqual(
      expect.objectContaining({ id, status: 'document-backed' })
    );
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(existsSync(join(workspaceRoot, 'primers', `${id}.primer.json`))).toBe(false);
  });

  it('reports unassigned primers without guessing the original project or changing their records', async () => {
    mocks.platformBridge.workspace.getOriginalDefaultProject = async () => ({
      status: 'unresolved',
      reason: 'identity-not-recorded',
      message: 'The original My Project has not been identified.',
    });

    await mocks.platformBridge.lims.ensureSeeded();
    db.prepare(
      `INSERT INTO lims_entity (id, kind, schema_id, schema_revision_id, name, registry_id,
      fields, registration_status, domain_status, workspace_id, actor, event_seq, tombstone,
      created_at, updated_at, archived_at) VALUES (?, 'oligo', 'schema-entity-oligo',
      'schema-entity-oligo-v1', ?, 'OLD-REVIEW', ?, 'registered', NULL, NULL, 'legacy-import', NULL, 0, 1, 1, NULL)`
    ).run(
      'unassigned-review-primer',
      'Unassigned review primer',
      JSON.stringify({
        use: 'primer',
        sequence: await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA'),
      })
    );
    const [original] = await mocks.platformBridge.lims.queryEntities({
      id: 'unassigned-review-primer',
    });
    const report = await refreshPrimerRecoveryInventory();
    expect(report.entries).toContainEqual(
      expect.objectContaining({
        id: original.id,
        workspaceId: null,
        status: 'needs-review',
        message: 'The original My Project has not been identified.',
      })
    );
    expect((await mocks.platformBridge.lims.queryEntities({ id: original.id }))[0]).toEqual(
      original
    );
  });

  it('reports recovery in an archived project without restoring it or changing the primer', async () => {
    const original = await mocks.platformBridge.lims.registerEntity({
      id: 'archived-project-review-primer',
      name: 'Archived project review primer',
      kind: 'oligo',
      workspaceId: 1,
      fields: { use: 'primer', sequence: await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA') },
    });
    db.prepare('UPDATE workspaces SET archived_at = 123 WHERE id = 1').run();
    const bytes = readFileSync(artifactPath, 'utf8');
    const report = await refreshPrimerRecoveryInventory();
    expect(report.entries).toContainEqual(
      expect.objectContaining({
        id: original.id,
        workspaceId: 1,
        status: 'needs-review',
        message: expect.stringMatching(/archived project/i),
      })
    );
    expect((await mocks.platformBridge.lims.queryEntities({ id: original.id }))[0]).toEqual(
      original
    );
    expect(db.prepare('SELECT archived_at FROM workspaces WHERE id = 1').get()).toEqual({
      archived_at: 123,
    });
    expect(readFileSync(artifactPath, 'utf8')).toBe(bytes);
  });

  it('refuses the older creation and import commands when no project can be resolved', async () => {
    mocks.platformBridge.workspace.getOriginalDefaultProject = async () => ({
      status: 'unresolved',
      reason: 'identity-not-recorded',
      message: 'The original My Project has not been identified.',
    });
    const input = { name: 'Project required', sequence: 'ACGTTGCAAGTCCTGATCGA' };
    await expect(createPrimer(input)).rejects.toThrow(
      'original My Project has not been identified'
    );
    expect(await importBatch([input])).toMatchObject({
      imported: 0,
      errors: [expect.objectContaining({ index: 0 })],
    });
    expect(db.prepare('SELECT count(*) AS count FROM primers').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM lims_entity').get()).toEqual({ count: 0 });
  });

  it('preserves library inventory when an older saved document does not contain those fields', async () => {
    const legacyFile = JSON.parse(readFileSync(artifactPath, 'utf8'));
    legacyFile.schemaVersion = 2;
    delete legacyFile.inventory;
    writeFileSync(artifactPath, `${JSON.stringify(legacyFile, null, 2)}\n`);
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    db.prepare(
      `UPDATE primers SET order_date = ?, scale = ?, purification = ?, stock_location = ?, concentration = ? WHERE id = ?`
    ).run(1_610_000_000_000, '25nm', 'HPLC', 'Original freezer', 17.5, legacyFile.id);
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    expect(
      db
        .prepare(
          'SELECT order_date, scale, purification, stock_location, concentration FROM primers WHERE id = ?'
        )
        .get(legacyFile.id)
    ).toEqual({
      order_date: 1_610_000_000_000,
      scale: '25nm',
      purification: 'HPLC',
      stock_location: 'Original freezer',
      concentration: 17.5,
    });
  });

  it('routes the older creation and batch-import commands through saved project documents and Registry', async () => {
    const primer = await createPrimer({
      name: 'Older creation command',
      sequence: 'ACGTTGCAAGTCCTGATCGA',
      workspaceId: 1,
      origin: 'import',
      originDetails: { sourceFile: 'original-order.csv' },
    });
    const imported = await importBatch([
      { name: 'Older import command', sequence: 'TCGATCAGGACTTGCAACGT', workspaceId: 1 },
    ]);
    expect(imported).toMatchObject({ imported: 1, errors: [] });
    for (const id of [
      primer.id,
      (
        db.prepare('SELECT id FROM primers WHERE name = ?').get('Older import command') as {
          id: string;
        }
      ).id,
    ]) {
      const [entity] = await mocks.platformBridge.lims.queryEntities({ id });
      expect(entity).toMatchObject({
        id,
        workspaceId: 1,
        fields: { artifact: { schema: 'dnaforge.primer' } },
      });
      const saved = parsePrimerArtifact(
        readFileSync(join(workspaceRoot, entity.fields.artifact.relativePath), 'utf8')
      );
      expect(saved.id).toBe(id);
      if (id === primer.id)
        expect(saved.inventory).toMatchObject({
          origin: 'import',
          originDetails: { sourceFile: 'original-order.csv' },
        });
    }
  });

  it('keeps recovery pending when history fails and resumes the same file without adopting it early', async () => {
    const original = await mocks.platformBridge.lims.registerEntity({
      id: 'registry-history-pending',
      kind: 'oligo',
      name: 'Pending history',
      workspaceId: 1,
      fields: { sequence: await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA'), use: 'primer' },
    });
    mocks.gitRepo = true;
    mocks.gitCommitFails = true;
    const failed = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(failed.errors).toEqual([expect.objectContaining({ path: `registry:${original.id}` })]);
    const [pending] = await mocks.platformBridge.lims.queryEntities({ id: original.id });
    expect(pending.fields.artifact).toBeUndefined();
    const path = join(workspaceRoot, 'primers/registry-history-pending.primer.json');
    const bytes = readFileSync(path, 'utf8');
    mocks.gitCommitFails = false;
    const retry = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(retry.errors).toEqual([]);
    const [recovered] = await mocks.platformBridge.lims.queryEntities({ id: original.id });
    expect(recovered.registryId).toBe(original.registryId);
    expect(recovered.fields.artifact).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('recovers a legacy library primer with its inventory and binding identity into the same project', async () => {
    const createdAt = 1_600_000_000_000;
    const updatedAt = createdAt + 10_000;
    db.prepare(
      `INSERT INTO primers (
      id, catalog_number, name, sequence, length, tm, gc_percent, origin, origin_details,
      status, vendor, order_date, application, scale, purification, modifications,
      stock_location, concentration, notes, workspace_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-library-primer',
      'OLD-091',
      'Legacy inventory primer',
      'ACGTTGCAAGTCCTGATCGA',
      20,
      8.25,
      33.25,
      'import',
      JSON.stringify({ sourceFile: 'original-order.csv' }),
      'received',
      'Original supplier',
      1_610_000_000_000,
      'pcr',
      '25nm',
      'HPLC',
      null,
      'Freezer A / box 12',
      17.5,
      'Original tube notes',
      1,
      createdAt,
      updatedAt
    );
    db.prepare(
      `INSERT INTO primer_bindings (
      id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'original-legacy-binding',
      'legacy-library-primer',
      targetSequenceId,
      10,
      30,
      1,
      'manual',
      createdAt,
      updatedAt
    );

    const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(result.errors).toEqual([]);
    const [entity] = await mocks.platformBridge.lims.queryEntities({ id: 'legacy-library-primer' });
    expect(entity).toMatchObject({
      id: 'legacy-library-primer',
      workspaceId: 1,
      fields: {
        catalogNumber: 'OLD-091',
        status: 'received',
        artifact: { schemaVersion: 3 },
      },
    });
    const path = join(workspaceRoot, entity.fields.artifact.relativePath);
    const saved = parsePrimerArtifact(readFileSync(path, 'utf8'));
    expect(saved.inventory).toMatchObject({
      origin: 'import',
      originDetails: { sourceFile: 'original-order.csv' },
      vendor: 'Original supplier',
      orderDate: 1_610_000_000_000,
      scale: '25nm',
      purification: 'HPLC',
      stockLocation: 'Freezer A / box 12',
      concentration: 17.5,
    });
    expect(saved.bindings).toEqual([
      expect.objectContaining({
        id: 'original-legacy-binding',
        target: expect.objectContaining({ documentId: targetDocumentId }),
      }),
    ]);
    expect(db.prepare('SELECT * FROM primers WHERE id = ?').get(entity.id)).toMatchObject({
      catalog_number: 'OLD-091',
      origin: 'import',
      status: 'received',
      vendor: 'Original supplier',
      order_date: 1_610_000_000_000,
      scale: '25nm',
      purification: 'HPLC',
      stock_location: 'Freezer A / box 12',
      concentration: 17.5,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    expect(db.prepare('SELECT * FROM primer_bindings WHERE primer_id = ?').all(entity.id)).toEqual([
      expect.objectContaining({
        id: 'original-legacy-binding',
        created_at: createdAt,
        updated_at: updatedAt,
      }),
    ]);
    const bytes = readFileSync(path, 'utf8');
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(
      db.prepare('SELECT count(*) AS count FROM lims_entity WHERE id = ?').get(entity.id)
    ).toEqual({ count: 1 });
  });

  it('rejects a primer save without a registered project before writing any file', async () => {
    const unknownProject = join(workspaceRoot, 'unregistered-project');
    mkdirSync(unknownProject);
    const path = join(unknownProject, 'must-not-be-written.primer.json');
    await expect(
      savePrimerArtifact({
        name: 'Project required',
        sequence: 'ACGTTGCAAGTCCTGATCGA',
        workspaceRoot: unknownProject,
        artifactPath: path,
        requireRegistry: true,
      })
    ).rejects.toThrow(/registered project|project save location/i);
    expect(existsSync(path)).toBe(false);
  });

  it('recovers an existing Registry-only primer in its project without changing its identity or data', async () => {
    const sequence = 'ACGTTGCAAGTCCTGATCGA';
    const existing = await mocks.platformBridge.lims.registerEntity({
      id: 'registry-only-primer',
      kind: 'oligo',
      name: 'Existing primer',
      fields: {
        sequence: await buildInlineDnaSequenceRef(sequence),
        use: 'primer',
        notes: 'Preserve these notes',
        status: 'verified',
      },
      domainStatus: 'verified',
      workspaceId: 1,
      createdAt: 1_700_000_000_000,
    });
    const originalBytes = readFileSync(artifactPath, 'utf8');

    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    const [recovered] = await mocks.platformBridge.lims.queryEntities({
      id: existing.id,
      limit: 1,
    });

    expect(recovered.id).toBe(existing.id);
    expect(recovered.registryId).toBe(existing.registryId);
    expect(recovered.workspaceId).toBe(1);
    expect(recovered.createdAt).toBe(existing.createdAt);
    expect(recovered.domainStatus).toBe('verified');
    expect(recovered.fields).toMatchObject({
      notes: 'Preserve these notes',
      status: 'verified',
      artifact: { schema: 'dnaforge.primer' },
    });
    const saved = parsePrimerArtifact(
      readFileSync(join(workspaceRoot, recovered.fields.artifact.relativePath), 'utf8')
    );
    expect(saved.registry.entityId).toBe(existing.id);
    expect(saved.sequence.bases).toBe(sequence);
    expect(saved.metadata.createdAt).toBe(new Date(existing.createdAt).toISOString());
    const report = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('primer_recovery_project_v1:workspace:1') as { value: string } | undefined;
    expect(report).toBeDefined();
    expect(JSON.parse(report!.value).records).toContainEqual(
      expect.objectContaining({
        id: existing.id,
        status: 'recovered',
        source: 'registry',
      })
    );
    expect(readFileSync(artifactPath, 'utf8')).toBe(originalBytes);

    const beforeRetry = readFileSync(join(workspaceRoot, saved.file.workspaceRelativePath), 'utf8');
    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(readFileSync(join(workspaceRoot, saved.file.workspaceRelativePath), 'utf8')).toBe(
      beforeRetry
    );
    expect(
      await mocks.platformBridge.lims.queryEntities({
        id: existing.id,
        includeArchived: true,
        limit: 10,
      })
    ).toHaveLength(1);
  });

  it('preserves a recovered Registry primer archive rather than restoring it during reconciliation', async () => {
    const existing = await mocks.platformBridge.lims.registerEntity({
      id: 'archived-registry-only-primer',
      kind: 'oligo',
      name: 'Archived existing primer',
      fields: { sequence: await buildInlineDnaSequenceRef('ACGTTGCAAGTCCTGATCGA'), use: 'primer' },
      workspaceId: 1,
    });
    const archived = await mocks.platformBridge.lims.archiveEntity({ id: existing.id });

    await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    const [recovered] = await mocks.platformBridge.lims.queryEntities({
      id: existing.id,
      includeArchived: true,
      limit: 1,
    });
    expect(recovered.tombstone).toBe(true);
    expect(recovered.archivedAt).toBe(archived.archivedAt);
    expect(recovered.fields.artifact).toMatchObject({ schema: 'dnaforge.primer' });

    const fresh = createLimsTestBridge();
    const originalBridge = mocks.platformBridge;
    try {
      fresh.db
        .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (1, ?, ?, ?)')
        .run('Fresh restore', workspaceRoot, Date.now());
      mocks.platformBridge = { ...originalBridge, db: dbBridge(fresh.db), lims: fresh.lims };
      const restored = await reconcilePrimerArtifact(
        join(workspaceRoot, recovered.fields.artifact.relativePath),
        workspaceRoot
      );
      expect(restored.limsEntity.tombstone).toBe(true);
      expect(restored.limsEntity.archivedAt).toBe(archived.archivedAt);
    } finally {
      mocks.platformBridge = originalBridge;
      fresh.db.close();
    }
  });

  it('completes a committed metadata edit after projection failure without rewriting the artifact', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const before = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    const update = mocks.platformBridge.lims.updateEntity;
    mocks.platformBridge.lims.updateEntity = vi
      .fn()
      .mockRejectedValue(new Error('Registry unavailable'));
    let failure: unknown;
    try {
      await updatePrimerArtifactContent({
        artifactPath,
        workspaceRoot,
        expectedArtifactRevision: before.artifactRevision,
        name: 'Saved metadata name',
        sequence: before.sequence.bases,
        oligo: before.oligo ?? null,
        notes: before.metadata.notes,
        entitySchema: before.entity?.schema,
        entityFields: before.entity?.fields,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PrimerProjectionError);
    expect(failure).toHaveProperty('retry', expect.any(Function));
    const savedBytes = readFileSync(artifactPath, 'utf8');
    const writes = mocks.platformBridge.fs.writeWorkspaceTextFileAtomic.mock.calls.length;
    mocks.platformBridge.lims.updateEntity = update;
    await (failure as PrimerProjectionError & { retry: () => Promise<unknown> }).retry();
    expect(readFileSync(artifactPath, 'utf8')).toBe(savedBytes);
    expect(JSON.parse(savedBytes).artifactRevision).toBe(before.artifactRevision + 1);
    expect(mocks.platformBridge.fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(writes);
    expect(db.prepare('SELECT name FROM lims_entity WHERE id = ?').get(before.id)).toEqual({
      name: 'Saved metadata name',
    });
  });

  it('refreshes an archived Registry projection from the checked file before restoring it', async () => {
    const saved = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    rmSync(artifactPath);
    await platformBridge().lims.archiveEntity({
      id: saved.limsEntity.id,
      actor: 'integration-test',
    });
    const revised = parsePrimerArtifact(
      serializePrimerArtifact({
        ...saved.artifact,
        name: 'Revised archived primer',
        artifactRevision: saved.artifact.artifactRevision + 1,
        metadata: { ...saved.artifact.metadata, updatedAt: new Date().toISOString() },
      })
    );
    writeFileSync(artifactPath, serializePrimerArtifact(revised));
    const update = platformBridge().lims.updateEntity;
    const restore = platformBridge().lims.restoreEntity;
    const calls: string[] = [];
    vi.spyOn(platformBridge().lims, 'updateEntity').mockImplementation(async (input) => {
      assertPrimerRegistryProjection(db, input, 'update');
      calls.push('update');
      return update(input);
    });
    vi.spyOn(platformBridge().lims, 'restoreEntity').mockImplementation(async (input) => {
      assertPrimerRegistryProjection(db, input, 'restore');
      calls.push('restore');
      return restore(input);
    });
    const restored = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    expect(calls).toEqual(['update', 'restore']);
    expect(restored.limsEntity).toMatchObject({ name: revised.name, tombstone: false });
    expect(restored.primer.name).toBe(revised.name);
  });

  it('retires a canonical primer through checked file removal, Registry archive and native compatibility publication', async () => {
    const saved = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    await expect(
      deletePrimerArtifact({
        primer: saved.primer,
        workspaceRoot,
        expectedArtifactRevision: saved.artifact.artifactRevision + 1,
        operationId: 'stale-delete',
      })
    ).rejects.toThrow(/revision/);
    expect(existsSync(artifactPath)).toBe(true);
    expect(db.prepare('SELECT id FROM primers WHERE id=?').get(saved.primer.id)).toBeDefined();
    expect(
      await deletePrimerArtifact({
        primer: saved.primer,
        workspaceRoot,
        expectedArtifactRevision: saved.artifact.artifactRevision,
        operationId: 'checked-delete',
      })
    ).toMatchObject({ deleted: true });
    expect(existsSync(artifactPath)).toBe(false);
    expect(db.prepare('SELECT id FROM primers WHERE id=?').get(saved.primer.id)).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM primer_bindings WHERE primer_id=?').all(saved.primer.id)
    ).toEqual([]);
    expect(
      db
        .prepare('SELECT archived_at FROM lims_entity WHERE id=?')
        .get(saved.artifact.registry.entityId)
    ).toMatchObject({ archived_at: expect.any(Number) });
    expect(
      db
        .prepare(
          "SELECT status FROM catalog_entity_files WHERE entity_id=? AND file_kind='primer-artifact'"
        )
        .get(saved.primer.id)
    ).toEqual({ status: 'historical' });
  });

  it.each([true, false])(
    'saves a new primer at a deleted path without adopting its identity (reconciled: %s)',
    async (reconciled) => {
      const original = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
      const originalFile = (await getCatalogFileForPath(artifactPath))!;
      const originalEntity = await getCatalogEntity(original.artifact.id);
      expect(originalFile.object_uuid).toBeTruthy();
      rmSync(artifactPath);
      if (reconciled) await markCatalogFileMissing(artifactPath, 'moved-to-trash');

      const replacement = await savePrimerArtifact({
        name: original.artifact.name,
        sequence: 'acgtacgtacgtacgtacgt',
        artifactPath,
        workspaceRoot,
        workspaceId: 1,
        requireRegistry: true,
      });

      expect(replacement.artifact.id).not.toBe(original.artifact.id);
      expect(replacement.artifact.catalogNumber).not.toBe(original.artifact.catalogNumber);
      expect(replacement.primer.id).toBe(replacement.artifact.id);
      expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8'))).toEqual(replacement.artifact);
      const replacementFile = (await getCatalogFileForPath(artifactPath))!;
      expect(replacementFile).toMatchObject({
        entity_id: replacement.artifact.id,
        status: 'current',
      });
      expect(replacementFile.id).not.toBe(originalFile.id);
      expect(replacementFile.object_uuid).not.toBe(originalFile.object_uuid);
      await expect(
        resolveFileByObjectUuid(originalFile.object_uuid!, workspaceRoot)
      ).resolves.toBeNull();
      await expect(getCatalogEntity(original.artifact.id)).resolves.toEqual(originalEntity);
      const events = await getCatalogEventsForEntity(original.artifact.id);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: 'file_path_reuse',
            payload: expect.stringContaining(originalFile.object_uuid!),
          }),
        ])
      );
    }
  );

  it('refuses to reconcile a different primer over a current owner before registering it', async () => {
    const original = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const originalFile = await getCatalogFileForPath(artifactPath);
    const replacement = await buildPrimerArtifact({
      id: 'unrelated-primer',
      catalogNumber: 'PR-000099',
      name: original.artifact.name,
      sequence: 'acgtacgtacgtacgtacgt',
      workspaceRoot,
      artifactPath,
      actor: 'integration-test',
    });
    writeFileSync(artifactPath, serializePrimerArtifact(replacement));

    await expect(reconcilePrimerArtifact(artifactPath, workspaceRoot)).rejects.toThrow(
      'Primer artifact path is already owned by another catalog entity'
    );
    await expect(getCatalogFileForPath(artifactPath)).resolves.toEqual(originalFile);
    expect(
      db.prepare('SELECT id FROM lims_entity WHERE id = ?').get(replacement.id)
    ).toBeUndefined();
  });

  it('rebuilds a missing custom schema revision before projecting its authoritative primer', async () => {
    const customArtifact = await buildPrimerArtifact({
      id: 'primer-custom-schema-1',
      catalogNumber: 'PR-000099',
      name: 'qPCR_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot,
      artifactPath,
      actor: 'integration-test',
      source: 'manual',
      entitySchema: {
        schemaId: 'schema-qpcr-primer',
        schemaRevisionId: 'schema-qpcr-primer-v1',
        name: 'qpcr_primer',
        displayName: 'qPCR primer',
        baseKind: 'primer',
        version: 1,
        fields: [
          { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
          { key: 'use', label: 'Use', type: 'enum', enumOptions: ['primer'] },
          { key: 'assayId', label: 'Assay ID', type: 'text', required: true },
        ],
      },
      entityFields: { assayId: 'ASSAY-42' },
    });
    writeFileSync(artifactPath, serializePrimerArtifact(customArtifact));

    const result = await reconcilePrimerArtifact(artifactPath, workspaceRoot);

    expect(result.limsEntity).toMatchObject({
      id: 'primer-custom-schema-1',
      kind: 'qpcr_primer',
      schemaId: 'schema-qpcr-primer',
      schemaRevisionId: 'schema-qpcr-primer-v1',
      fields: { assayId: 'ASSAY-42', use: 'primer' },
    });
    await expect(platformBridge().lims.listSchemas()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaId: 'schema-qpcr-primer',
          currentRevisionId: 'schema-qpcr-primer-v1',
          baseKind: 'primer',
        }),
      ])
    );
    expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).entity).toMatchObject({
      schema: { schemaRevisionId: 'schema-qpcr-primer-v1', baseKind: 'primer' },
      fields: { assayId: 'ASSAY-42' },
    });
    expect(db.prepare(`SELECT id FROM primers WHERE id = ?`).get('primer-custom-schema-1')).toEqual(
      {
        id: 'primer-custom-schema-1',
      }
    );
  });

  it('recovers an exact legacy primer creation after an unrelated accepted namespace appears', async () => {
    const input = {
      name: 'Legacy retry',
      sequence: 'ATGCGTACGTAGCTAGCTAG',
      artifactPath: join(workspaceRoot, 'primers', 'legacy-retry.primer.json'),
      workspaceRoot,
      requireRegistry: true as const,
      artifactId: 'legacy-retry',
    };
    const first = await savePrimerArtifact(input);
    const original = readFileSync(input.artifactPath, 'utf8');
    db.prepare('DELETE FROM primers WHERE id=?').run(first.artifact.id);
    db.prepare('DELETE FROM lims_entity WHERE id=?').run(first.artifact.id);
    mocks.namespace.mockResolvedValue({ head: `wv_${'a'.repeat(64)}`, entries: [] });
    vi.mocked(platformBridge().fs.writeWorkspaceTextFileAtomic).mockClear();

    const recovered = await savePrimerArtifact(input);

    expect(recovered).toMatchObject({
      created: false,
      artifact: { id: first.artifact.id, catalogNumber: first.artifact.catalogNumber },
      limsEntity: { id: first.limsEntity.id },
    });
    expect(readFileSync(input.artifactPath, 'utf8')).toBe(original);
    expect(platformBridge().fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(db.prepare('SELECT id FROM primers WHERE id=?').get(first.artifact.id)).toEqual({
      id: first.artifact.id,
    });
    await expect(savePrimerArtifact(input)).resolves.toMatchObject({ created: false });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM lims_audit WHERE event_type='entity_registered' AND subject_id=?"
        )
        .get(first.artifact.id)
    ).toEqual({ count: 1 });
  });

  it.each([
    'moved',
    'removed',
    'claimed-path',
    'collision-path',
    'removed-path',
    'changed',
    'misplaced',
    'late-claim',
  ])('guards legacy primer creation after namespace change: %s', async (kind) => {
    const input = {
      name: 'Guarded legacy',
      sequence: 'ATGCGTACGTAGCTAGCTAG',
      artifactPath: join(workspaceRoot, 'primers', 'guarded.primer.json'),
      workspaceRoot,
      requireRegistry: true as const,
      artifactId: 'guarded-legacy',
    };
    const first = await savePrimerArtifact(input);
    if (kind === 'misplaced') {
      const changed = structuredClone(first.artifact);
      changed.file.workspaceRelativePath = 'primers/elsewhere.primer.json';
      writeFileSync(input.artifactPath, serializePrimerArtifact(changed));
    }
    const original = readFileSync(input.artifactPath, 'utf8');
    const entry = {
      resourceId:
        kind === 'moved' || kind === 'removed' || kind === 'late-claim'
          ? input.artifactId
          : 'another-owner',
      revisionId: `rr_${'b'.repeat(64)}`,
      path:
        kind === 'moved'
          ? 'primers/moved.primer.json'
          : kind === 'collision-path'
            ? 'PRIMERS/GUARDED.PRIMER.JSON'
            : 'primers/guarded.primer.json',
      lastPath: 'primers/guarded.primer.json',
      tombstone: kind === 'removed' || kind === 'removed-path',
    };
    const unclaimed = { head: `wv_${'a'.repeat(64)}`, entries: [] };
    const claimed = { ...unclaimed, entries: [entry] };
    mocks.namespace.mockResolvedValue(
      kind === 'changed' || kind === 'misplaced' ? unclaimed : claimed
    );
    if (kind === 'late-claim') mocks.namespace.mockResolvedValueOnce(unclaimed);
    vi.mocked(platformBridge().fs.writeWorkspaceTextFileAtomic).mockClear();
    const projection = vi.spyOn(platformBridge().db, 'replacePrimerProjection');

    await expect(
      savePrimerArtifact(kind === 'changed' ? { ...input, sequence: 'T'.repeat(20) } : input)
    ).rejects.toThrow();

    expect(readFileSync(input.artifactPath, 'utf8')).toBe(original);
    expect(platformBridge().fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(projection).not.toHaveBeenCalled();
  });

  it('preserves the accepted owner for an exact primer retry when its delivered file is absent', async () => {
    const input = {
      name: 'Accepted retry',
      sequence: 'ATGCGTACGTAGCTAGCTAG',
      artifactPath: join(workspaceRoot, 'primers', 'accepted-retry.primer.json'),
      workspaceRoot,
      requireRegistry: true as const,
      artifactId: 'accepted-retry',
    };
    const first = await savePrimerArtifact(input);
    const content = readFileSync(input.artifactPath, 'utf8');
    rmSync(input.artifactPath);
    const acceptedRevision = {
      kind: 'accepted-object' as const,
      resourceId: first.artifact.id,
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'c'.repeat(64)}`,
      contentSha256: 'd'.repeat(64),
      sequenceEditParentEventId: null,
    };
    mocks.namespace.mockResolvedValue({
      head: acceptedRevision.workspaceVersionId,
      entries: [
        {
          resourceId: first.artifact.id,
          revisionId: acceptedRevision.resourceRevisionId,
          path: first.artifact.file.workspaceRelativePath,
          lastPath: first.artifact.file.workspaceRelativePath,
          tombstone: false,
        },
      ],
    });
    mocks.acceptedRead = { content, acceptedRevision };
    mocks.publish.mockResolvedValue(acceptedRevision);
    vi.mocked(platformBridge().fs.writeWorkspaceTextFileAtomic).mockClear();
    const projection = vi.spyOn(platformBridge().db, 'replacePrimerProjection');

    await expect(savePrimerArtifact(input)).resolves.toMatchObject({
      created: false,
      acceptedRevision,
    });

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        prior: acceptedRevision,
        representation: { format: 'primer-v2', text: content },
      })
    );
    expect(projection).not.toHaveBeenCalled();
    expect(platformBridge().fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('keeps new missing-file primer creation on the accepted owner at a reusable path', async () => {
    const acceptedRevision = {
      kind: 'accepted-object' as const,
      resourceId: 'new-at-reused-path',
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'c'.repeat(64)}`,
      contentSha256: 'd'.repeat(64),
      sequenceEditParentEventId: null,
    };
    const head = `wv_${'a'.repeat(64)}`;
    mocks.namespace.mockResolvedValue({
      head,
      entries: [
        {
          resourceId: 'removed-owner',
          revisionId: `rr_${'e'.repeat(64)}`,
          path: null,
          lastPath: 'primers/reusable.primer.json',
          tombstone: true,
        },
      ],
    });
    mocks.publish.mockRejectedValue(
      new NativeArtifactPublicationPendingError(acceptedRevision, 'delivery pending')
    );
    vi.mocked(platformBridge().fs.writeWorkspaceTextFileAtomic).mockClear();

    await expect(
      savePrimerArtifact({
        name: 'New accepted',
        sequence: 'ATGCGTACGTAGCTAGCTAG',
        artifactPath: join(workspaceRoot, 'primers', 'reusable.primer.json'),
        workspaceRoot,
        requireRegistry: true,
        artifactId: acceptedRevision.resourceId,
      })
    ).rejects.toMatchObject({ acceptedRevision });

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        prior: null,
        expectedHead: head,
        resourceId: acceptedRevision.resourceId,
      })
    );
    expect(platformBridge().fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('preserves supplied spreadsheet row identities across retry and equal-content rows', async () => {
    const input = {
      name: 'Same primer',
      sequence: 'ATGCGTACGTAGCTAGCTAG',
      artifactPath: join(workspaceRoot, 'primers', 'sheet-row-a.primer.json'),
      workspaceRoot,
      requireRegistry: true as const,
      artifactId: 'sheet-row-a',
    };
    const first = await savePrimerArtifact(input);
    const retry = await savePrimerArtifact(input);
    const second = await savePrimerArtifact({
      ...input,
      artifactPath: join(workspaceRoot, 'primers', 'sheet-row-b.primer.json'),
      artifactId: 'sheet-row-b',
    });
    expect(first.artifact.id).toBe('sheet-row-a');
    expect(retry.artifact.id).toBe('sheet-row-a');
    expect(retry.created).toBe(false);
    expect(second.artifact.id).toBe('sheet-row-b');
    expect(first.limsEntity.id).not.toBe(second.limsEntity.id);
    for (const saved of [first, retry, second]) {
      expect(saved.limsEntity.eventSeq).toBeTypeOf('number');
      expect(saved.limsEntity.eventSeq).toBeGreaterThan(0);
    }
    const before = readFileSync(input.artifactPath, 'utf8');
    await expect(savePrimerArtifact({ ...input, artifactId: 'foreign-row' })).rejects.toThrow(
      'different primer artifact'
    );
    expect(readFileSync(input.artifactPath, 'utf8')).toBe(before);
  });

  it('saves the persisted Tm preference and projects that same value into SQLite', async () => {
    rmSync(artifactPath);
    useSettingsStore.getState().setTmModel(OWCZARZY_TM_MODEL);
    useSettingsStore.getState().setTmConditions({
      monovalentMm: 75,
      divalentMm: 2.5,
      dntpMm: 0.8,
    });

    const saved = await savePrimerArtifact({
      name: 'Owczarzy primer',
      sequence: 'ATGCGTACGTAGCTAGCTAG',
      artifactPath,
      workspaceRoot,
      requireRegistry: true,
      workspaceId: 1,
    });

    expect(saved.artifact.computed.tmCalculation).toMatchObject({
      model: OWCZARZY_TM_MODEL,
      source: 'user-setting',
      valueC: saved.artifact.computed.tmC,
      status: 'local',
      provider: { source: 'local', tm: saved.artifact.computed.tmC },
    });
    expect(db.prepare(`SELECT tm FROM primers WHERE id = ?`).get(saved.artifact.id)).toEqual({
      tm: saved.artifact.computed.tmC,
    });
    expect(saved.limsEntity.fields.tmCalculation).toEqual(saved.artifact.computed.tmCalculation);
    expect(platformBridge().fs.beginWorkspaceMutation).toHaveBeenCalledWith(
      workspaceRoot,
      undefined
    );
    expect(platformBridge().fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot,
        path: artifactPath,
        mutationToken: 'primer-mutation-token',
      })
    );
    expect(platformBridge().db.allocatePrimerCatalogNumber).toHaveBeenCalledWith(
      1,
      workspaceRoot,
      'primer-mutation-token'
    );
    expect(platformBridge().db.replacePrimerProjection).toHaveBeenCalledWith(
      expect.objectContaining({ id: saved.artifact.id }),
      workspaceRoot,
      'primer-mutation-token'
    );
    expect(platformBridge().fs.endWorkspaceMutation).toHaveBeenCalledWith('primer-mutation-token');
  });

  it('creates the LIMS audit/entity and legacy primer/binding projections', async () => {
    const result = await reconcilePrimerArtifact(artifactPath, workspaceRoot);

    expect(result.limsEntity).toMatchObject({
      id: 'primer-entity-1',
      kind: 'oligo',
      name: 'pUC19_R1',
      registrationStatus: 'registered',
      domainStatus: 'designed',
      workspaceId: 1,
    });
    expect(result.limsEntity.fields).toMatchObject({
      use: 'primer',
      catalogNumber: 'PR-000001',
      artifact: {
        schema: 'dnaforge.primer',
        schemaVersion: 3,
        revision: 1,
        relativePath: 'primers/pUC19_R1.primer.json',
      },
      bindings: [
        expect.objectContaining({
          relation: 'binds_to_sequence',
          coordinates: expect.objectContaining({ start: 1711, end: 1743, strand: -1 }),
        }),
      ],
    });

    expect(
      db
        .prepare(
          `SELECT event_type, subject_id FROM lims_audit
           WHERE event_type = 'entity_registered' AND subject_id = ?`
        )
        .all('primer-entity-1')
    ).toHaveLength(1);
    expect(
      db.prepare(`SELECT id, catalog_number FROM primers WHERE id = ?`).get('primer-entity-1')
    ).toEqual({ id: 'primer-entity-1', catalog_number: 'PR-000001' });
    expect(
      db
        .prepare(
          `SELECT id, primer_id, sequence_id, binding_start, binding_end, strand
           FROM primer_bindings WHERE primer_id = ?`
        )
        .get('primer-entity-1')
    ).toEqual({
      id: 'primer-binding-1',
      primer_id: 'primer-entity-1',
      sequence_id: targetSequenceId,
      binding_start: 1711,
      binding_end: 1743,
      strand: -1,
    });
    expect(
      db
        .prepare(`SELECT id, type, locator, storage_type FROM catalog_entities WHERE id = ?`)
        .get('primer-entity-1')
    ).toEqual({
      id: 'primer-entity-1',
      type: 'primer',
      locator: 'waypoint://primer/primer-entity-1',
      storage_type: 'file',
    });
    expect(
      db
        .prepare(
          `SELECT entity_id, relative_path, file_kind, status, content_hash
           FROM catalog_entity_files WHERE entity_id = ?`
        )
        .get('primer-entity-1')
    ).toEqual({
      entity_id: 'primer-entity-1',
      relative_path: 'primers/pUC19_R1.primer.json',
      file_kind: 'primer-artifact',
      status: 'current',
      content_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it('restores deleted projections from the artifact and is idempotent on retry', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    db.prepare(`DELETE FROM primers WHERE id = ?`).run('primer-entity-1');
    db.prepare(`DELETE FROM lims_entity WHERE id = ?`).run('primer-entity-1');

    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const registeredEventsAfterRepair = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM lims_audit
           WHERE event_type = 'entity_registered' AND subject_id = ?`
        )
        .get('primer-entity-1') as { count: number }
    ).count;
    expect(db.prepare(`SELECT id FROM lims_entity WHERE id = ?`).get('primer-entity-1')).toEqual({
      id: 'primer-entity-1',
    });
    expect(db.prepare(`SELECT id FROM primers WHERE id = ?`).get('primer-entity-1')).toEqual({
      id: 'primer-entity-1',
    });
    expect(
      db.prepare(`SELECT id FROM primer_bindings WHERE primer_id = ?`).get('primer-entity-1')
    ).toEqual({ id: 'primer-binding-1' });

    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const registeredEventsAfterRetry = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM lims_audit
           WHERE event_type = 'entity_registered' AND subject_id = ?`
        )
        .get('primer-entity-1') as { count: number }
    ).count;
    expect(registeredEventsAfterRepair).toBe(1);
    expect(registeredEventsAfterRetry).toBe(1);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM primers WHERE id = ?`).get('primer-entity-1') as {
          count: number;
        }
      ).count
    ).toBe(1);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM primer_bindings WHERE primer_id = ?`)
          .get('primer-entity-1') as { count: number }
      ).count
    ).toBe(1);
  });

  it('discovers primer files through the production workspace rebuild path', async () => {
    const first = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);
    expect(first).toMatchObject({ discovered: 1, reconciled: 1, errors: [] });

    db.prepare(`DELETE FROM primer_bindings WHERE primer_id = ?`).run('primer-entity-1');
    db.prepare(`DELETE FROM primers WHERE id = ?`).run('primer-entity-1');
    db.prepare(`DELETE FROM lims_entity WHERE id = ?`).run('primer-entity-1');

    const rebuilt = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);

    expect(rebuilt).toMatchObject({ discovered: 1, reconciled: 1, errors: [] });
    expect(db.prepare(`SELECT id FROM primers WHERE id = ?`).get('primer-entity-1')).toEqual({
      id: 'primer-entity-1',
    });
    expect(
      db.prepare(`SELECT id FROM primer_bindings WHERE primer_id = ?`).get('primer-entity-1')
    ).toEqual({ id: 'primer-binding-1' });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM lims_audit
           WHERE event_type = 'entity_registered' AND subject_id = ?`
        )
        .get('primer-entity-1')
    ).toEqual({ count: 1 });
  });

  it('uses the managed-Git candidate list as discovery authority without a second tree walk', async () => {
    const unlistedPath = join(workspaceRoot, 'unlisted.primer.json');
    const unlisted = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    writeFileSync(
      unlistedPath,
      serializePrimerArtifact({
        ...unlisted,
        file: { workspaceRelativePath: 'unlisted.primer.json' },
      })
    );

    const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot, {
      candidatePaths: [artifactPath],
    });

    expect(result).toMatchObject({ discovered: 1, reconciled: 1, errors: [] });
  });

  it('cancels a workspace rebuild before scanning or projecting primer artifacts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      reconcilePrimerArtifactsInWorkspace(workspaceRoot, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(db.prepare(`SELECT COUNT(*) AS count FROM primers`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_entity`).get()).toEqual({ count: 0 });
  });

  it('does not project a file that changes after duplicate preflight', async () => {
    const readTextFile = platformBridge().fs.readTextFile;
    let artifactReads = 0;
    platformBridge().fs.readTextFile = async (path: string) => {
      const content = await readTextFile(path);
      if (path === artifactPath && ++artifactReads === 2) {
        return content.replace('"name": "pUC19_R1"', '"name": "changed_during_scan"');
      }
      return content;
    };

    const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);

    expect(result).toMatchObject({ discovered: 1, reconciled: 0 });
    expect(result.errors[0]?.message).toMatch(/changed during project reconciliation/i);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primers`).get()).toEqual({ count: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM lims_entity WHERE id = ?`).get('primer-entity-1')
    ).toEqual({ count: 0 });
  });

  it('fails closed when two files claim the same stable primer identity', async () => {
    const duplicatePath = join(workspaceRoot, 'duplicate.primer.json');
    const duplicate = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    writeFileSync(
      duplicatePath,
      serializePrimerArtifact({
        ...duplicate,
        file: { workspaceRelativePath: 'duplicate.primer.json' },
      })
    );

    const result = await reconcilePrimerArtifactsInWorkspace(workspaceRoot);

    expect(result.discovered).toBe(2);
    expect(result.reconciled).toBe(0);
    expect(
      result.errors.filter((error) => error.message.includes('Duplicate primer stable primer ID'))
    ).toHaveLength(2);
    expect(
      result.errors.filter((error) => error.message.includes('Duplicate primer catalog number'))
    ).toHaveLength(2);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primers`).get()).toEqual({ count: 0 });
  });

  it('removes legacy relationships that are absent from the authoritative artifact', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM primer_bindings WHERE primer_id = ?`)
        .get('primer-entity-1')
    ).toEqual({ count: 1 });

    const artifact = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    writeFileSync(
      artifactPath,
      serializePrimerArtifact({
        ...artifact,
        artifactRevision: artifact.artifactRevision + 1,
        metadata: { ...artifact.metadata, updatedAt: new Date().toISOString() },
        bindings: [],
      })
    );

    await reconcilePrimerArtifact(artifactPath, workspaceRoot);

    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM primer_bindings WHERE primer_id = ?`)
        .get('primer-entity-1')
    ).toEqual({ count: 0 });
    const entity = db
      .prepare(`SELECT fields FROM lims_entity WHERE id = ?`)
      .get('primer-entity-1') as { fields: string };
    expect(JSON.parse(entity.fields)).toMatchObject({ bindings: [] });
  });

  it('replaces LIMS fields exactly instead of preserving stale projection keys', async () => {
    await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const row = db
      .prepare(`SELECT fields FROM lims_entity WHERE id = ?`)
      .get('primer-entity-1') as { fields: string };
    db.prepare(`UPDATE lims_entity SET fields = ? WHERE id = ?`).run(
      JSON.stringify({ ...JSON.parse(row.fields), staleProjectionKey: 'must disappear' }),
      'primer-entity-1'
    );

    await reconcilePrimerArtifact(artifactPath, workspaceRoot);

    const repaired = db
      .prepare(`SELECT fields FROM lims_entity WHERE id = ?`)
      .get('primer-entity-1') as { fields: string };
    expect(JSON.parse(repaired.fields)).not.toHaveProperty('staleProjectionKey');
  });

  it('refuses to overwrite an unrelated LIMS oligo that claims the artifact ID', async () => {
    await platformBridge().lims.registerEntity({
      id: 'primer-entity-1',
      kind: 'oligo',
      name: 'Unrelated oligo',
      fields: {
        sequence: await buildInlineDnaSequenceRef('ATCGATCGATCGATCGATCG'),
        use: 'primer',
        status: 'designed',
      },
      workspaceId: 1,
      actor: 'integration-test',
    });

    await expect(reconcilePrimerArtifact(artifactPath, workspaceRoot)).rejects.toThrow(
      'already owned by another oligo record'
    );

    const entity = db
      .prepare(`SELECT name, fields FROM lims_entity WHERE id = ?`)
      .get('primer-entity-1') as { name: string; fields: string };
    expect(entity.name).toBe('Unrelated oligo');
    expect(JSON.parse(entity.fields)).not.toHaveProperty('artifact');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primers`).get()).toEqual({ count: 0 });
  });

  it('keeps the authoritative file on registry failure and reconciles it on retry', async () => {
    rmSync(artifactPath);
    const registerEntity = platformBridge().lims.registerEntity;
    platformBridge().lims.registerEntity = vi
      .fn<typeof registerEntity>()
      .mockRejectedValue(new Error('forced registry failure'));
    const input = {
      name: 'pUC19_R1',
      sequence: 'GCGGGCCTCTTCGCTATTACGCCAGCTGGCGA',
      artifactPath,
      workspaceRoot,
      targetDocumentId,
      targetFilePath: join(workspaceRoot, 'pUC19.gb'),
      targetLength: 2686,
      targetTopology: 'circular' as const,
      requireRegistry: true as const,
      bindingSequenceId: targetSequenceId,
      bindingStart: 1711,
      bindingEnd: 1743,
      bindingStrand: -1 as const,
      workspaceId: 1,
      application: 'sequencing' as const,
      notes: 'Reverse sequencing primer',
    };

    let failure: unknown;
    try {
      await savePrimerArtifact(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PrimerProjectionError);
    expect(failure).toMatchObject({
      code: 'PRIMER_REGISTRY_RECONCILIATION_REQUIRED',
      artifactPath,
    });
    expect((failure as Error).message).toContain('The file is safe and can be reconciled');
    expect(existsSync(artifactPath)).toBe(true);
    expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toMatchObject({
      schema: 'dnaforge.primer',
      name: 'pUC19_R1',
      registry: { required: true, entityId: expect.any(String) },
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primers`).get()).toEqual({ count: 0 });

    platformBridge().lims.registerEntity = registerEntity;
    const retry = await savePrimerArtifact(input);
    expect(retry.artifactPath).toBe(artifactPath);
    expect(db.prepare(`SELECT id FROM lims_entity WHERE id = ?`).get(retry.artifact.id)).toEqual({
      id: retry.artifact.id,
    });
    expect(db.prepare(`SELECT id FROM primers WHERE id = ?`).get(retry.artifact.id)).toEqual({
      id: retry.artifact.id,
    });
    expect(
      db
        .prepare(`SELECT sequence_id FROM primer_bindings WHERE primer_id = ?`)
        .get(retry.artifact.id)
    ).toEqual({ sequence_id: targetSequenceId });
  });

  it('retries an already-written attach without duplicating the relationship or revision', async () => {
    const initial = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const replaceProjection = platformBridge().db.replacePrimerProjection;
    platformBridge().db.replacePrimerProjection = vi
      .fn<typeof replaceProjection>()
      .mockRejectedValueOnce(new Error('forced compatibility projection failure'));
    const input = {
      primer: initial.primer,
      workspaceRoot,
      targetDocumentId,
      targetFilePath: join(workspaceRoot, 'pUC19.gb'),
      bindingSequenceId: targetSequenceId,
      bindingStart: 100,
      bindingEnd: 132,
      bindingStrand: 1 as const,
    };

    await expect(attachPrimerArtifact(input)).rejects.toBeInstanceOf(PrimerProjectionError);
    const afterFailure = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    expect(afterFailure).toMatchObject({ artifactRevision: 2 });
    expect(afterFailure.bindings).toHaveLength(2);

    platformBridge().db.replacePrimerProjection = replaceProjection;
    const retry = await attachPrimerArtifact(input);

    expect(retry.artifact.artifactRevision).toBe(2);
    expect(retry.artifact.bindings).toHaveLength(2);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM primer_bindings WHERE primer_id = ?`)
        .get(initial.primer.id)
    ).toEqual({ count: 2 });
  });

  it('reports duplicate add and updates a binding in place under an artifact revision guard', async () => {
    const initial = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const duplicate = await attachPrimerArtifact({
      primer: initial.primer,
      workspaceRoot,
      targetDocumentId,
      targetFilePath: join(workspaceRoot, 'pUC19.gb'),
      bindingSequenceId: targetSequenceId,
      bindingStart: 1711,
      bindingEnd: 1743,
      bindingStrand: -1,
      expectedArtifactRevision: 1,
    });
    expect(duplicate).toMatchObject({
      bindingMutation: 'duplicate',
      bindingId: 'primer-binding-1',
      artifact: { artifactRevision: 1 },
    });

    const updated = await updatePrimerArtifactBinding({
      primer: initial.primer,
      workspaceRoot,
      bindingId: 'primer-binding-1',
      targetDocumentId,
      targetFilePath: join(workspaceRoot, 'pUC19.gb'),
      bindingSequenceId: targetSequenceId,
      bindingStart: 100,
      bindingEnd: 132,
      bindingStrand: 1,
      expectedArtifactRevision: 1,
      alignment: {
        identity: 0.97,
        editDistance: 1,
        mismatchPositions: [5],
        threePrimeMatchLength: 19,
        effectiveTmC: 61.2,
      },
    });
    expect(updated).toMatchObject({
      bindingMutation: 'updated',
      bindingId: 'primer-binding-1',
      artifact: {
        id: 'primer-entity-1',
        artifactRevision: 2,
        bindings: [
          {
            id: 'primer-binding-1',
            coordinates: { start: 100, end: 132, strand: 1 },
            source: 'manual',
            alignment: { editDistance: 1, mismatchPositions: [5] },
          },
        ],
      },
    });
    expect(
      db
        .prepare(
          `SELECT id, binding_start, binding_end, strand FROM primer_bindings WHERE primer_id = ?`
        )
        .get('primer-entity-1')
    ).toEqual({ id: 'primer-binding-1', binding_start: 100, binding_end: 132, strand: 1 });

    await expect(
      updatePrimerArtifactBinding({
        primer: updated.primer,
        workspaceRoot,
        bindingId: 'primer-binding-1',
        targetDocumentId,
        targetFilePath: join(workspaceRoot, 'pUC19.gb'),
        bindingSequenceId: targetSequenceId,
        bindingStart: 200,
        bindingEnd: 232,
        bindingStrand: 1,
        expectedArtifactRevision: 1,
      })
    ).rejects.toBeInstanceOf(PrimerArtifactRevisionError);
    expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).artifactRevision).toBe(2);
  });

  it('retries an already-written detach by reconciling instead of failing on the missing binding', async () => {
    const initial = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const replaceProjection = platformBridge().db.replacePrimerProjection;
    platformBridge().db.replacePrimerProjection = vi
      .fn<typeof replaceProjection>()
      .mockRejectedValueOnce(new Error('forced compatibility projection failure'));
    const input = {
      primer: initial.primer,
      workspaceRoot,
      bindingId: 'primer-binding-1',
    };

    await expect(detachPrimerArtifact(input)).rejects.toBeInstanceOf(PrimerProjectionError);
    const afterFailure = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    expect(afterFailure).toMatchObject({ artifactRevision: 2, bindings: [] });

    platformBridge().db.replacePrimerProjection = replaceProjection;
    const retry = await detachPrimerArtifact(input);

    expect(retry.artifact).toMatchObject({ artifactRevision: 2, bindings: [] });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM primer_bindings WHERE primer_id = ?`)
        .get(initial.primer.id)
    ).toEqual({ count: 0 });
  });

  it('creates no registry or compatibility rows when the atomic file write fails', async () => {
    rmSync(artifactPath);
    platformBridge().fs.writeWorkspaceTextFileAtomic = vi
      .fn<typeof writeWorkspaceTextFileAtomicInMain>()
      .mockRejectedValue(new Error('forced filesystem failure'));

    await expect(
      savePrimerArtifact({
        name: 'pUC19_R1',
        sequence: 'GCGGGCCTCTTCGCTATTACGCCAGCTGGCGA',
        artifactPath,
        workspaceRoot,
        targetDocumentId,
        targetFilePath: join(workspaceRoot, 'pUC19.gb'),
        targetLength: 2686,
        targetTopology: 'circular',
        requireRegistry: true,
        bindingSequenceId: targetSequenceId,
        bindingStart: 1711,
        bindingEnd: 1743,
        bindingStrand: -1,
        workspaceId: 1,
      })
    ).rejects.toThrow('forced filesystem failure');

    expect(existsSync(artifactPath)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_entity`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primers`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primer_bindings`).get()).toEqual({ count: 0 });
  });
});

function nativePastePersistence(): RichPastePrimerPersistence {
  return {
    getPrimer: getPrimerById,
    readSavedTarget: readSavedPrimerBindingTarget,
    listLegacyBoundPrimers: listBoundPrimers,
    persistOwnedLegacyBinding: persistOwnedPrimerBinding,
    persistOwnedArtifactBindings: persistOwnedPrimerArtifactBindings,
    deleteLegacyBinding: deleteBinding,
    notifyBindingsChanged: () => undefined,
  };
}

async function legacyPastePrimer(): Promise<Primer> {
  const id = globalThis.crypto.randomUUID();
  db.prepare(
    `INSERT INTO primers
    (id, catalog_number, name, sequence, length, tm, gc_percent, origin, status, workspace_id, created_at, updated_at)
    VALUES (?, ?, 'Synthetic copied primer', 'ACGTACGTACGTACGTACGT', 20, 50, 50, 'manual', 'designed', 1, 1, 1)`
  ).run(id, `PR-${id}`);
  const primer = await getPrimerById(id);
  if (!primer) throw new Error('Synthetic primer fixture was not created.');
  return primer;
}

async function filePastePrimer(): Promise<Primer> {
  const artifact = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
  writeFileSync(artifactPath, serializePrimerArtifact({ ...artifact, bindings: [] }));
  return (await reconcilePrimerArtifact(artifactPath, workspaceRoot)).primer;
}

function loadNativePasteDocument(): { path: string; baseline: string; length: number } {
  const path = join(workspaceRoot, 'pUC19.gb');
  const sequence = parseSequenceFileAsDocument(readFileSync(path, 'utf8'), path).sequence;
  useSequenceStore.getState().setSequence(targetDocumentId, { ...sequence, id: targetDocumentId });
  mocks.platformBridge.fs.saveSequenceDocument = (input: SequenceDocumentSaveInput) =>
    saveSequenceDocumentWithLineage(input, {
      db,
      resolve: async () => ({ documentId: targetDocumentId, workspaceRoot, sourcePath: path }),
      runDatabase: (operation) => operation(),
    });
  return { path, baseline: sequence.sequence, length: sequence.length };
}

function pasteNativePrimer(primer: Primer, position: number): void {
  const store = useSequenceStore.getState();
  store.dispatchEdit(targetDocumentId, { type: 'SET_CURSOR', position });
  store.dispatchEdit(targetDocumentId, {
    type: 'INSERT_FRAGMENT',
    fragment: {
      sequence: primer.sequence,
      annotations: [],
      primerBindings: [
        {
          primerId: primer.id,
          start: 0,
          end: primer.length,
          strand: 1,
          sourceWorkspaceRoot: workspaceRoot,
        },
      ],
    },
  });
}

async function reopenPasteDatabase(): Promise<void> {
  const path = join(workspaceRoot, 'reopened-native.sqlite');
  await db.backup(path);
  db.close();
  db = openFileTestDb(path);
  mocks.platformBridge.db = dbBridge(db);
  mocks.platformBridge.lims = createLimsBridgeForDb(db);
}

describe('rich paste Save with native files and SQLite', () => {
  it.each(['legacy', 'artifact'] as const)(
    'moves the same owned %s attachment through a racing Save and database reopen',
    async (kind) => {
      const first = kind === 'legacy' ? await legacyPastePrimer() : await filePastePrimer();
      const second = kind === 'legacy' ? await legacyPastePrimer() : first;
      const document = loadNativePasteDocument();
      pasteNativePrimer(first, document.length);
      const persistence = nativePastePersistence();
      let calls = 0;
      let firstId: string | undefined;
      const result = await persistSequenceDocument({
        document: { documentId: targetDocumentId, sourcePath: document.path },
        persistPendingPrimerBindings: async (bindings, context) => {
          const receipts = await persistRichPastePrimerBindings(
            {
              bindings,
              ...context,
              targetDocumentId,
              targetFilePath: document.path,
              targetSequenceId,
              targetWorkspaceRoot: workspaceRoot,
            },
            persistence
          );
          if (++calls === 1) {
            firstId = receipts[0]?.bindingId;
            pasteNativePrimer(second, 0);
          }
        },
      });
      expect(result).toMatchObject({ ok: true, attempts: 2 });
      expect(firstId).toEqual(expect.any(String));
      expect(useSequenceStore.getState().isDirty(targetDocumentId)).toBe(false);
      const saved = parseSequenceFileAsDocument(
        readFileSync(document.path, 'utf8'),
        document.path
      ).sequence;
      expect(saved.sequence).toBe(`${second.sequence}${document.baseline}${first.sequence}`);
      const expected = [
        {
          id: expect.any(String),
          primer_id: second.id,
          binding_start: 0,
          binding_end: second.length,
        },
        {
          id: firstId,
          primer_id: first.id,
          binding_start: document.length + second.length,
          binding_end: document.length + second.length + first.length,
        },
      ];
      const readRows = () =>
        db
          .prepare(
            'SELECT id, primer_id, binding_start, binding_end FROM primer_bindings WHERE sequence_id = ? ORDER BY binding_start'
          )
          .all(targetSequenceId);
      expect(readRows()).toEqual(expected);
      await reopenPasteDatabase();
      expect(readRows()).toEqual(expected);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type = 'rich_paste_primer_binding_intent_v1'"
          )
          .get()
      ).toEqual({ count: 2 });
      if (kind === 'artifact') {
        const rebuilt = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
        expect(rebuilt.artifact.bindings).toHaveLength(2);
        expect(readRows()).toEqual(expected);
        expect(
          rebuilt.artifact.bindings.find((binding) => binding.id === firstId)?.coordinates.start
        ).toBe(document.length + second.length);
      }
    }
  );

  it.each(['legacy', 'artifact'] as const)(
    'recovers a lost %s creation acknowledgement from durable ownership after database reopen',
    async (kind) => {
      const primer = kind === 'legacy' ? await legacyPastePrimer() : await filePastePrimer();
      const input = {
        bindings: [
          {
            pendingId: globalThis.crypto.randomUUID(),
            primerId: primer.id,
            start: 100,
            end: 120,
            strand: 1 as const,
          },
        ],
        draftLineageId: globalThis.crypto.randomUUID(),
        expectedFileSha256: await computeChecksum(
          readFileSync(join(workspaceRoot, 'pUC19.gb'), 'utf8')
        ),
        targetDocumentId,
        targetFilePath: join(workspaceRoot, 'pUC19.gb'),
        targetSequenceId,
        targetWorkspaceRoot: workspaceRoot,
      };
      const persistence = nativePastePersistence();
      const failed = { ...persistence };
      if (kind === 'legacy') {
        failed.persistOwnedLegacyBinding = async (request) => {
          await persistence.persistOwnedLegacyBinding(request);
          throw new Error('Synthetic lost creation acknowledgement');
        };
      } else {
        failed.persistOwnedArtifactBindings = async (request) => {
          await persistence.persistOwnedArtifactBindings(request);
          throw new Error('Synthetic lost creation acknowledgement');
        };
      }
      await expect(persistRichPastePrimerBindings(input, failed)).rejects.toThrow(
        'lost creation acknowledgement'
      );
      const before = db.prepare('SELECT * FROM primer_bindings WHERE primer_id = ?').all(primer.id);
      expect(before).toHaveLength(1);
      const artifactBefore = kind === 'artifact' ? readFileSync(artifactPath, 'utf8') : undefined;
      await reopenPasteDatabase();
      const receipts = await persistRichPastePrimerBindings(input, nativePastePersistence());
      expect(receipts).toEqual([{ bindingId: expect.any(String), bindingMutation: 'updated' }]);
      expect(
        db.prepare('SELECT id FROM primer_bindings WHERE primer_id = ?').all(primer.id)
      ).toEqual(
        before.map((row) => {
          if (typeof row !== 'object' || row === null || !('id' in row))
            throw new Error('Invalid native binding row');
          return { id: row.id };
        })
      );
      if (kind === 'artifact') expect(readFileSync(artifactPath, 'utf8')).toBe(artifactBefore);
    }
  );

  it.each(['legacy', 'artifact'] as const)(
    'retires only the owned %s attachment when normal undo races Save',
    async (kind) => {
      const primer = kind === 'legacy' ? await legacyPastePrimer() : await filePastePrimer();
      const document = loadNativePasteDocument();
      const unrelated = await legacyPastePrimer();
      const existing = await createBinding({
        primerId: unrelated.id,
        sequenceId: targetSequenceId,
        bindingStart: 100,
        bindingEnd: 120,
        strand: 1,
      });
      pasteNativePrimer(primer, document.length);
      let calls = 0;
      const result = await persistSequenceDocument({
        document: { documentId: targetDocumentId, sourcePath: document.path },
        persistPendingPrimerBindings: async (bindings, context) => {
          await persistRichPastePrimerBindings(
            {
              bindings,
              ...context,
              targetDocumentId,
              targetFilePath: document.path,
              targetSequenceId,
              targetWorkspaceRoot: workspaceRoot,
            },
            nativePastePersistence()
          );
          if (++calls === 1)
            useSequenceStore.getState().dispatchEdit(targetDocumentId, { type: 'UNDO' });
        },
      });
      expect(result).toMatchObject({ ok: true, attempts: 2 });
      expect(
        parseSequenceFileAsDocument(readFileSync(document.path, 'utf8'), document.path).sequence
          .sequence
      ).toBe(document.baseline);
      expect(
        db.prepare('SELECT id FROM primer_bindings WHERE sequence_id = ?').all(targetSequenceId)
      ).toEqual([{ id: existing.id }]);
      if (kind === 'artifact')
        expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).bindings).toEqual([]);
    }
  );
});

describe('owned binding preservation and dirty retry', () => {
  it.each(['legacy', 'artifact'])(
    'preserves an existing matching %s binding when the owned batch is retired',
    async (kind) => {
      const primer =
        kind === 'legacy'
          ? await legacyPastePrimer()
          : (await reconcilePrimerArtifact(artifactPath, workspaceRoot)).primer;
      const start = kind === 'legacy' ? 100 : 1711;
      const end = kind === 'legacy' ? 120 : 1743;
      if (kind === 'legacy')
        await createBinding({
          primerId: primer.id,
          sequenceId: targetSequenceId,
          bindingStart: start,
          bindingEnd: end,
          strand: -1,
        });
      const before = await listBoundPrimers(targetSequenceId);
      expect(before).toHaveLength(1);
      const original = before[0];
      if (!original) throw new Error('Expected pre-existing native attachment');
      const originalArtifact =
        kind === 'artifact'
          ? parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).bindings
          : undefined;
      const input = {
        bindings: [
          {
            pendingId: globalThis.crypto.randomUUID(),
            primerId: primer.id,
            start,
            end,
            strand: -1 as const,
          },
          {
            pendingId: globalThis.crypto.randomUUID(),
            primerId: primer.id,
            start: 200,
            end: 220,
            strand: 1 as const,
          },
        ],
        draftLineageId: globalThis.crypto.randomUUID(),
        expectedFileSha256: await computeChecksum(
          readFileSync(join(workspaceRoot, 'pUC19.gb'), 'utf8')
        ),
        targetDocumentId,
        targetFilePath: join(workspaceRoot, 'pUC19.gb'),
        targetSequenceId,
        targetWorkspaceRoot: workspaceRoot,
      };
      const receipts = await persistRichPastePrimerBindings(input, nativePastePersistence());
      expect(receipts[0]).toEqual({ bindingId: original.binding.id, bindingMutation: 'duplicate' });
      expect(await listBoundPrimers(targetSequenceId)).toHaveLength(2);
      await persistRichPastePrimerBindings({ ...input, bindings: [] }, nativePastePersistence());
      const after = await listBoundPrimers(targetSequenceId);
      expect(after).toHaveLength(1);
      expect(after[0]?.binding).toMatchObject({
        id: original.binding.id,
        primerId: primer.id,
        bindingStart: start,
        bindingEnd: end,
        strand: -1,
      });
      if (kind === 'legacy') expect(after[0]?.binding).toEqual(original.binding);
      else
        expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).bindings).toEqual(
          originalArtifact
        );
    }
  );

  it.each(['legacy', 'artifact'])(
    'keeps a partially persisted %s Save dirty and retries its original owned IDs',
    async (kind) => {
      const primer = kind === 'legacy' ? await legacyPastePrimer() : await filePastePrimer();
      const document = loadNativePasteDocument();
      pasteNativePrimer(primer, document.length);
      pasteNativePrimer(primer, 0);
      const persistence = nativePastePersistence();
      let fail = true;
      if (kind === 'legacy') {
        persistence.persistOwnedLegacyBinding = async (request) => {
          const result = await persistOwnedPrimerBinding(request);
          if (fail) throw new Error('Synthetic partial legacy batch failure');
          return result;
        };
      }
      const project = mocks.platformBridge.db.replacePrimerProjection;
      if (kind === 'artifact') {
        mocks.platformBridge.db.replacePrimerProjection = async (
          ...args: Parameters<typeof replacePrimerLegacyProjectionInDb> extends [
            unknown,
            ...infer Rest,
          ]
            ? Rest
            : never
        ) => {
          if (fail) throw new Error('Synthetic partial artifact projection failure');
          return project(...args);
        };
      }
      const save = () =>
        persistSequenceDocument({
          document: { documentId: targetDocumentId, sourcePath: document.path },
          persistPendingPrimerBindings: async (bindings, context) => {
            await persistRichPastePrimerBindings(
              {
                bindings,
                ...context,
                targetDocumentId,
                targetFilePath: document.path,
                targetSequenceId,
                targetWorkspaceRoot: workspaceRoot,
              },
              persistence
            );
          },
        });
      expect(await save()).toMatchObject({
        ok: false,
        wrote: true,
        error: { code: 'primer_bindings_failed' },
      });
      expect(useSequenceStore.getState().isDirty(targetDocumentId)).toBe(true);
      expect(
        useSequenceStore.getState().captureForSave(targetDocumentId)?.pendingPrimerBindings
      ).toHaveLength(2);
      const oldRows = db
        .prepare('SELECT id FROM primer_bindings WHERE primer_id = ?')
        .all(primer.id);
      expect(oldRows).toHaveLength(kind === 'legacy' ? 1 : 0);
      const oldArtifact =
        kind === 'artifact' ? parsePrimerArtifact(readFileSync(artifactPath, 'utf8')) : undefined;
      if (oldArtifact) expect(oldArtifact.bindings).toHaveLength(2);
      fail = false;
      expect(await save()).toMatchObject({ ok: true, wrote: true });
      expect(useSequenceStore.getState().isDirty(targetDocumentId)).toBe(false);
      const rows = db.prepare('SELECT id FROM primer_bindings WHERE primer_id = ?').all(primer.id);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining(oldRows));
      expect(
        parseSequenceFileAsDocument(readFileSync(document.path, 'utf8'), document.path).sequence
          .sequence
      ).toBe(`${primer.sequence}${document.baseline}${primer.sequence}`);
      if (oldArtifact)
        expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8'))).toEqual(oldArtifact);
    }
  );
});

describe('rich-paste captured file revision', () => {
  it.each(['legacy', 'artifact'])(
    'refuses to acknowledge a %s attachment against an external file replacement after native Save',
    async (kind) => {
      const primer = kind === 'legacy' ? await legacyPastePrimer() : await filePastePrimer();
      const document = loadNativePasteDocument();
      const original = readFileSync(document.path, 'utf8');
      pasteNativePrimer(primer, 0);
      const nativeSave = mocks.platformBridge.fs.saveSequenceDocument;
      mocks.platformBridge.fs.saveSequenceDocument = async (input: SequenceDocumentSaveInput) => {
        const result = await nativeSave(input);
        writeFileSync(document.path, original);
        return result;
      };
      const result = await persistSequenceDocument({
        document: { documentId: targetDocumentId, sourcePath: document.path },
        persistPendingPrimerBindings: async (bindings, context) => {
          await persistRichPastePrimerBindings(
            {
              bindings,
              ...context,
              targetDocumentId,
              targetFilePath: document.path,
              targetSequenceId,
              targetWorkspaceRoot: workspaceRoot,
            },
            nativePastePersistence()
          );
        },
      });
      expect(result).toMatchObject({
        ok: false,
        wrote: true,
        error: { code: 'primer_bindings_failed' },
      });
      expect(useSequenceStore.getState().isDirty(targetDocumentId)).toBe(true);
      expect(readFileSync(document.path, 'utf8')).toBe(original);
      expect(
        db.prepare('SELECT id FROM primer_bindings WHERE primer_id = ?').all(primer.id)
      ).toEqual([]);
      if (kind === 'artifact')
        expect(parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).bindings).toEqual([]);
    }
  );
});

describe('rich-paste changed target during attachment publication', () => {
  it.each(['legacy', 'artifact'])(
    'keeps a %s Save dirty when the file changes after its attachment write',
    async (kind) => {
      const primer = kind === 'legacy' ? await legacyPastePrimer() : await filePastePrimer();
      const document = loadNativePasteDocument();
      const original = readFileSync(document.path, 'utf8');
      pasteNativePrimer(primer, 0);
      const capture = useSequenceStore.getState().captureForSave(targetDocumentId);
      if (!capture) throw new Error('Pasted native draft missing');
      const persistence = nativePastePersistence();
      if (kind === 'legacy') {
        persistence.persistOwnedLegacyBinding = async (input) => {
          const result = await persistOwnedPrimerBinding(input);
          writeFileSync(document.path, original);
          return result;
        };
      } else {
        persistence.persistOwnedArtifactBindings = async (input) => {
          const result = await persistOwnedPrimerArtifactBindings(input);
          writeFileSync(document.path, original);
          return result;
        };
      }
      const result = await persistSequenceDocument({
        document: { documentId: targetDocumentId, sourcePath: document.path },
        persistPendingPrimerBindings: async (bindings, context) => {
          await persistRichPastePrimerBindings(
            {
              bindings,
              ...context,
              targetDocumentId,
              targetFilePath: document.path,
              targetSequenceId,
              targetWorkspaceRoot: workspaceRoot,
            },
            persistence
          );
        },
      });
      expect(result).toMatchObject({
        ok: false,
        wrote: true,
        error: { code: 'primer_bindings_failed' },
      });
      expect(useSequenceStore.getState().isDirty(targetDocumentId)).toBe(true);
      expect(
        useSequenceStore.getState().captureForSave(targetDocumentId)?.pendingPrimerBindings
      ).toHaveLength(1);
      expect(readFileSync(document.path, 'utf8')).toBe(original);
      const owned = db
        .prepare<
          [string, string, string],
          { payload: string }
        >(`SELECT payload FROM catalog_entity_events WHERE entity_id = ? AND event_type = ? AND json_extract(payload, '$.draftLineageId') = ?`)
        .all(targetDocumentId, 'rich_paste_primer_binding_intent_v1', capture.draftLineageId);
      expect(owned).toHaveLength(1);
      const record = owned[0];
      if (!record) throw new Error('Native attachment ownership was not retained');
      const intent: unknown = JSON.parse(record.payload);
      expect(intent).toMatchObject({
        documentId: targetDocumentId,
        draftLineageId: capture.draftLineageId,
        primerId: primer.id,
      });
      if (
        typeof intent !== 'object' ||
        intent === null ||
        !('bindingId' in intent) ||
        typeof intent.bindingId !== 'string'
      )
        throw new Error('Native attachment intent has no binding identity');
      expect(
        db.prepare('SELECT id FROM primer_bindings WHERE primer_id = ?').all(primer.id)
      ).toEqual([{ id: intent.bindingId }]);
      if (kind === 'artifact')
        expect(
          parsePrimerArtifact(readFileSync(artifactPath, 'utf8')).bindings.map(
            (binding) => binding.id
          )
        ).toEqual([intent.bindingId]);
    }
  );
});

describe('cross-project primer binding ownership', () => {
  it('keeps the oligo in its owner while persisting and reopening a binding in a separate source project', async () => {
    const original = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const sourceRoot = mkdtempSync(join(tmpdir(), 'fixture-primer-source-'));
    try {
      const sourcePath = join(sourceRoot, 'pUC19.gb');
      copyFileSync(join(workspaceRoot, 'pUC19.gb'), sourcePath);
      const sourceBefore = readFileSync(sourcePath);
      db.prepare(
        'INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (2, ?, ?, ?, ?)'
      ).run('Separate source', sourceRoot, '3bf0edfd-5da9-42c5-bf01-e33dc3661002', Date.now());
      db.prepare(
        'INSERT INTO indexed_files (id, workspace_id, path, name, extension, size_bytes, modified_at, indexed_at) VALUES (2, 2, ?, ?, ?, ?, ?, ?)'
      ).run(sourcePath, 'pUC19.gb', 'gb', sourceBefore.length, Date.now(), Date.now());
      const target = await buildFileDnaSequenceRef(sourcePath, { workspaceRoot: sourceRoot });
      const sourceSequenceId = target.sequenceId!;
      const input = {
        primer: original.primer,
        workspaceRoot,
        targetWorkspaceRoot: sourceRoot,
        targetDocumentId: target.documentId,
        targetFilePath: sourcePath,
        bindingSequenceId: sourceSequenceId,
        bindingStart: 1711,
        bindingEnd: 1743,
        bindingStrand: -1 as const,
        expectedArtifactRevision: original.artifact.artifactRevision,
      };
      const attached = await attachPrimerArtifact(input);
      expect(attached.primer.workspaceId).toBe(1);
      expect(attached.artifact.bindings.at(-1)?.target).toMatchObject({
        documentId: target.documentId,
        projectId: '3bf0edfd-5da9-42c5-bf01-e33dc3661002',
      });
      const reopened = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
      expect(reopened.artifact.bindings.at(-1)?.target).toMatchObject({
        documentId: target.documentId,
        projectId: '3bf0edfd-5da9-42c5-bf01-e33dc3661002',
      });
      expect(
        db.prepare('SELECT sequence_id FROM primer_bindings WHERE id = ?').get(attached.bindingId)
      ).toEqual({ sequence_id: sourceSequenceId });
      expect(readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(existsSync(join(sourceRoot, 'primers', 'pUC19_R1.primer.json'))).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe('registered primer routing through the main publication owner', () => {
  async function readyFixture() {
    const source = parsePrimerArtifact(readFileSync(artifactPath, 'utf8'));
    const id = '10000000-0000-4000-8000-000000000045';
    source.id = id;
    source.registry.entityId = id;
    writeFileSync(artifactPath, serializePrimerArtifact(source));
    const projected = await reconcilePrimerArtifact(artifactPath, workspaceRoot);
    const state = {
      state: 'ready',
      artifact: projected.artifact,
      entity: projected.limsEntity,
      expectedEventSeq: projected.limsEntity.eventSeq,
      expectedContentHash: await sha256Hex(readFileSync(artifactPath, 'utf8')),
      workspaceId: 1,
      relativePath: projected.artifact.file.workspaceRelativePath,
    };
    mocks.platformBridge.lims.readPrimerArtifactRevisionState.mockResolvedValue(state);
    mocks.platformBridge.fs.writeWorkspaceTextFileAtomic.mockClear();
    mocks.platformBridge.db.replacePrimerProjection.mockClear();
    mocks.platformBridge.fs.readTextFile.mockClear();
    return { projected, state };
  }

  it('routes one content, inventory and status edit with exact revision fences and no renderer write', async () => {
    const { projected, state } = await readyFixture();
    const next = await revisePrimerArtifactContent(projected.artifact, {
      name: 'Received primer',
      sequence: projected.artifact.sequence.bases,
      inventory: {
        origin: 'manual',
        originDetails: null,
        vendor: null,
        orderDate: null,
        scale: null,
        purification: null,
        modifications: null,
        stockLocation: 'Box 9',
        concentration: null,
      },
    });
    mocks.platformBridge.lims.revisePrimerArtifact.mockResolvedValue({
      entity: { ...projected.limsEntity, name: next.name },
      artifact: next,
      changed: true,
      replayed: false,
    });
    const before = readFileSync(artifactPath, 'utf8');
    await updatePrimer({
      id: next.id,
      name: next.name,
      status: 'received',
      stockLocation: 'Box 9',
    });
    expect(mocks.platformBridge.lims.revisePrimerArtifact).toHaveBeenCalledOnce();
    const [request] = mocks.platformBridge.lims.revisePrimerArtifact.mock.calls[0];
    expect(request).toMatchObject({
      entityId: next.id,
      expectedEventSeq: state.expectedEventSeq,
      expectedContentHash: state.expectedContentHash,
      mutationToken: 'primer-mutation-token',
      change: {
        type: 'content',
        content: { name: next.name, status: 'received', inventory: { stockLocation: 'Box 9' } },
      },
    });
    expect(request.operationId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(request.change.content).not.toHaveProperty('entityState');
    expect(request.change.content).not.toHaveProperty('entitySchema');
    expect(request).not.toHaveProperty('accountId');
    expect(mocks.platformBridge.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.platformBridge.db.replacePrimerProjection).not.toHaveBeenCalled();
    expect(readFileSync(artifactPath, 'utf8')).toBe(before);
    expect(mocks.platformBridge.lims.readPrimerArtifactRevisionState).toHaveBeenCalledWith({
      entityId: next.id,
      mutationToken: 'primer-mutation-token',
    });
  });

  it('discovers pending before old-file reads and resumes the same operation before reopening bytes', async () => {
    const { projected, state } = await readyFixture();
    const pending = {
      state: 'pending',
      entityId: projected.artifact.id,
      operationId: '20000000-0000-4000-8000-000000000045',
      workspaceId: 1,
      relativePath: state.relativePath,
      name: 'Saved pending primer',
      artifactRevision: 2,
    };
    mocks.platformBridge.lims.readPrimerArtifactRevisionState.mockResolvedValue(pending);
    await expect(readPrimerArtifactAtPath(artifactPath, workspaceRoot)).rejects.toMatchObject({
      pending,
    });
    expect(mocks.platformBridge.fs.readTextFile).not.toHaveBeenCalled();
    const next = await revisePrimerArtifactContent(projected.artifact, {
      name: pending.name,
      sequence: projected.artifact.sequence.bases,
    });
    mocks.platformBridge.lims.resumePrimerArtifactPublication.mockImplementation(async () => {
      writeFileSync(artifactPath, serializePrimerArtifact(next));
      mocks.platformBridge.lims.readPrimerArtifactRevisionState.mockResolvedValue({
        ...state,
        artifact: next,
      });
      return { entity: projected.limsEntity, artifact: next, changed: true, replayed: true };
    });
    const saved = await resumePrimerArtifactSave({
      entityId: pending.entityId,
      operationId: pending.operationId,
      workspaceRoot,
    });
    expect(saved.artifact.name).toBe(pending.name);
    expect(mocks.platformBridge.lims.resumePrimerArtifactPublication).toHaveBeenCalledWith({
      entityId: pending.entityId,
      operationId: pending.operationId,
      mutationToken: 'primer-mutation-token',
    });
    expect(mocks.platformBridge.lims.revisePrimerArtifact).not.toHaveBeenCalled();
    expect(mocks.platformBridge.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.platformBridge.db.replacePrimerProjection).not.toHaveBeenCalled();
  });

  it('does not treat a state failure as permission to fall back to raw content writes', async () => {
    const { projected } = await readyFixture();
    mocks.platformBridge.lims.readPrimerArtifactRevisionState.mockRejectedValue(
      new Error('The registered home is unavailable')
    );
    const before = readFileSync(artifactPath, 'utf8');
    await expect(
      updatePrimerArtifactContent({
        artifactPath,
        workspaceRoot,
        expectedArtifactRevision: projected.artifact.artifactRevision,
        name: 'Unsafe fallback',
        sequence: projected.artifact.sequence.bases,
      })
    ).rejects.toThrow('The registered home is unavailable');
    expect(mocks.platformBridge.fs.readTextFile).not.toHaveBeenCalled();
    expect(mocks.platformBridge.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.platformBridge.lims.revisePrimerArtifact).not.toHaveBeenCalled();
    expect(readFileSync(artifactPath, 'utf8')).toBe(before);
  });

  it('preserves duplicate-binding and absent-removal no-ops without indexing or raw projection writes', async () => {
    const { projected } = await readyFixture();
    const source = projected.artifact.bindings[0];
    const rows = db.prepare('SELECT * FROM sequences').all();
    const before = readFileSync(artifactPath, 'utf8');
    mocks.platformBridge.lims.revisePrimerArtifact
      .mockResolvedValueOnce({
        entity: projected.limsEntity,
        artifact: projected.artifact,
        changed: false,
        replayed: false,
        unchangedReason: 'duplicate_binding',
        bindingId: source.id,
      })
      .mockResolvedValueOnce({
        entity: projected.limsEntity,
        artifact: projected.artifact,
        changed: false,
        replayed: false,
        unchangedReason: 'missing_binding',
      });
    const attached = await attachPrimerArtifact({
      primer: projected.primer,
      workspaceRoot,
      targetFilePath: join(workspaceRoot, 'pUC19.gb'),
      targetDocumentId,
      bindingSequenceId: targetSequenceId,
      bindingStart: source.coordinates.start,
      bindingEnd: source.coordinates.end,
      bindingStrand: source.coordinates.strand,
    });
    expect(attached).toMatchObject({ bindingMutation: 'duplicate', bindingId: source.id });
    await detachPrimerArtifact({
      primer: projected.primer,
      workspaceRoot,
      bindingId: 'missing-binding',
    });
    expect(mocks.platformBridge.lims.revisePrimerArtifact).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT * FROM sequences').all()).toEqual(rows);
    expect(readFileSync(artifactPath, 'utf8')).toBe(before);
    expect(mocks.platformBridge.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.platformBridge.db.replacePrimerProjection).not.toHaveBeenCalled();
  });
});
