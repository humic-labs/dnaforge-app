/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { registerLimsIpcHandlers } from './lims';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, openFileTestDb } from './__tests__/test-db';
import {
  allocatePrimerCatalogNumberInDb,
  replacePrimerLegacyProjectionInDb,
} from './primer-projection';

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema } from './schema';
import { limsEntityFromRow } from '../shared/lims';
import {
  buildPrimerArtifact,
  parsePrimerArtifact,
  serializePrimerArtifact,
  type PrimerArtifactV1,
} from '../shared/primers/primer-artifact';
import {
  primerArtifactRegistryProjection,
  primerArtifactLegacyProjection,
} from '../shared/primers/primer-artifact-projection';
import {
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  updateLimsEntityInsideTx,
  getEntityRowById,
  linkLimsEntitiesInsideTx,
} from './lims-engine-core';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { requireCatalogEntity } from './catalog-source-authority';
import { recordInitialFastaKindDeclarationInDb } from './fasta-kind-authority';
import { verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';
import * as nativePublication from './native-catalog-publication';
import * as limsExport from './lims-git-export';
import { readCheckedOrganizationRecordReview } from './org-registry-record-review';
import {
  publishPrimerArtifactRevision,
  publishReviewedPrimerArtifactResolution,
  resumeReviewedPrimerArtifactResolution,
  readReviewedPrimerArtifactResolutionIdentity,
  recoverPrimerArtifactPublications,
  readPendingPrimerArtifactPublication,
  resumePrimerArtifactPublication,
  assertEnrolledPrimerPhysicalMutationAllowed,
  type PrimerArtifactRevisionRequest,
} from './primer-artifact-mutations';
import {
  enrollOrgRegistryRecordInTx,
  readReadyOrgRegistryRecordMutations,
} from './org-registry-record-sync';
import {
  replaceOrgRegistrySnapshot,
  enqueueOrgRegistryMutation,
  acknowledgeOrgRegistryMutation,
} from './org-registry-sync-cache';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
const ipcHost = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  accountId: null as string | null,
}));
vi.mock('./ipc/database', () => ({ getDb: () => ipcHost.db }));
vi.mock('./auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () =>
    ipcHost.accountId ? { accountId: ipcHost.accountId } : null
  ),
}));

describe('main-process primer projection transaction', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, access_mode TEXT NOT NULL DEFAULT 'writable', archived_at INTEGER, trashed_at INTEGER);
      CREATE TABLE indexed_files (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT, indexed_at INTEGER NOT NULL);
      CREATE TABLE sequences (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL, length INTEGER NOT NULL, circular INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE primers (
        id TEXT PRIMARY KEY, catalog_number TEXT UNIQUE, name TEXT NOT NULL, sequence TEXT NOT NULL,
        length INTEGER NOT NULL, tm REAL, gc_percent REAL, origin TEXT, origin_details TEXT,
        status TEXT, vendor TEXT, modifications TEXT, application TEXT, notes TEXT,
        order_date INTEGER, scale TEXT, purification TEXT, stock_location TEXT, concentration REAL,
        workspace_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE primer_bindings (
        id TEXT PRIMARY KEY, primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
        sequence_id INTEGER NOT NULL, binding_start INTEGER NOT NULL, binding_end INTEGER NOT NULL,
        strand INTEGER NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(primer_id, sequence_id, binding_start)
      );
    `);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at) VALUES (1, 'A', '/a', 1)`
    ).run();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at) VALUES (2, 'B', '/b', 1)`
    ).run();
    db.prepare(
      `INSERT INTO indexed_files (id, workspace_id, path, name, extension, indexed_at)
       VALUES (1, 1, '/a/seq.gb', 'seq.gb', 'gb', 1)`
    ).run();
    db.prepare(
      `INSERT INTO sequences (id, file_id, name, length, circular)
       VALUES (1, 1, 'seq', 100, 0)`
    ).run();
    for (const id of ['primer-1', 'primer-origin', 'primer-modified'])
      db.prepare(
        'INSERT INTO primers(id,name,sequence,length,workspace_id,created_at,updated_at) VALUES(?,?,?,4,1,1,1)'
      ).run(id, id, 'ATCG');
  });

  afterEach(() => db.close());

  it('allocates globally unique catalog numbers across workspaces', () => {
    expect(allocatePrimerCatalogNumberInDb(db, 1, 1)).toBe('P001');
    db.prepare(
      `INSERT INTO primers (id, catalog_number, name, sequence, length, created_at, updated_at)
       VALUES ('one', 'P001', 'one', 'ATCGATCGATCG', 12, 1, 1)`
    ).run();
    expect(allocatePrimerCatalogNumberInDb(db, 2, 2)).toBe('P002');
  });

  it('reserves allocations across overlapping workspace prefixes before primer insert', () => {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)`).run(
      'primer_prefix_1',
      'P'
    );
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)`).run(
      'primer_prefix_2',
      'P1'
    );
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)`).run(
      'primer_counter_global_P',
      '1000'
    );

    expect(allocatePrimerCatalogNumberInDb(db, 1, 2)).toBe('P1001');
    expect(allocatePrimerCatalogNumberInDb(db, 2, 3)).toBe('P1002');
  });

  it('replaces the complete binding set atomically', () => {
    const base = {
      id: 'primer-1',
      catalogNumber: 'P001',
      name: 'Primer 1',
      sequence: 'ATCGATCGATCG',
      length: 12,
      tm: 40,
      gcPercent: 50,
      origin: 'manual',
      originDetails: { source: 'legacy-compatibility' },
      vendor: null,
      modifications: null,
      application: null,
      notes: null,
      workspaceId: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    replacePrimerLegacyProjectionInDb(db, {
      ...base,
      bindings: [
        {
          id: 'binding-1',
          sequenceId: 1,
          bindingStart: 10,
          bindingEnd: 22,
          strand: 1,
          source: 'manual',
        },
      ],
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primer_bindings`).get()).toEqual({ count: 1 });

    replacePrimerLegacyProjectionInDb(db, { ...base, updatedAt: 2, bindings: [] });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM primer_bindings`).get()).toEqual({ count: 0 });
  });

  it('writes the provided origin to the primers.origin column (not a hardcoded manual)', () => {
    const base = {
      id: 'primer-origin',
      catalogNumber: 'P010',
      name: 'Assembly primer',
      sequence: 'ATCGATCGATCG',
      length: 12,
      tm: 40,
      gcPercent: 50,
      originDetails: { source: 'legacy-compatibility' },
      vendor: null,
      modifications: null,
      application: null,
      notes: null,
      workspaceId: 1,
      createdAt: 1,
      updatedAt: 1,
      bindings: [],
    };
    replacePrimerLegacyProjectionInDb(db, { ...base, origin: 'assembly' });
    expect(db.prepare(`SELECT origin FROM primers WHERE id = ?`).get('primer-origin')).toEqual({
      origin: 'assembly',
    });

    replacePrimerLegacyProjectionInDb(db, { ...base, origin: 'manual', updatedAt: 2 });
    expect(db.prepare(`SELECT origin FROM primers WHERE id = ?`).get('primer-origin')).toEqual({
      origin: 'manual',
    });
  });

  it('replaces and clears the exact vendor notation projected from the authoritative artifact', () => {
    const base = {
      id: 'primer-modified',
      catalogNumber: 'P011',
      name: 'Modified primer',
      sequence: 'ATCGATCGATCG',
      length: 12,
      tm: 40,
      gcPercent: 50,
      origin: 'manual',
      originDetails: { source: 'legacy-compatibility' },
      application: null,
      notes: null,
      workspaceId: 1,
      createdAt: 1,
      updatedAt: 1,
      bindings: [],
    };

    replacePrimerLegacyProjectionInDb(db, {
      ...base,
      vendor: 'idt',
      modifications: '/5Phos/ATCGATCGATCG/3SpC3/',
    });
    expect(
      db.prepare(`SELECT vendor, modifications FROM primers WHERE id = ?`).get(base.id)
    ).toEqual({
      vendor: 'idt',
      modifications: '/5Phos/ATCGATCGATCG/3SpC3/',
    });

    replacePrimerLegacyProjectionInDb(db, {
      ...base,
      vendor: null,
      modifications: null,
      updatedAt: 2,
    });
    expect(
      db.prepare(`SELECT vendor, modifications FROM primers WHERE id = ?`).get(base.id)
    ).toEqual({
      vendor: null,
      modifications: null,
    });
  });
});

describe('main primer publication through real SQLite and saved files', () => {
  const ENTITY = '10000000-0000-4000-8000-000000000044';
  const TARGET = '20000000-0000-4000-8000-000000000044';
  const HOME = '30000000-0000-4000-8000-000000000044';
  const REMOTE = '40000000-0000-4000-8000-000000000044';
  const ORGANIZATION_SCHEMA = '50000000-0000-4000-8000-000000000044';
  const ORGANIZATION_REVISION = '60000000-0000-4000-8000-000000000044';
  const scope = {
    orgId: '70000000-0000-4000-8000-000000000044',
    accountId: '80000000-0000-4000-8000-000000000044',
    clientId: 'desktop:primer-publication',
  };
  const accessGeneration = `home-v1:${'4'.repeat(64)}`;
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  let db: Database.Database;
  let root: string;
  let databasePath: string;
  let path: string;
  let accountId: string | null;
  let artifact: PrimerArtifactV1;
  let sequenceId: number;
  const entity = () => limsEntityFromRow(getEntityRowById(db, ENTITY));
  const context = () => ({
    db,
    runDatabase: <T>(work: () => T) => work(),
    getActiveAccountId: async () => accountId,
  });
  const publications = () =>
    db
      .prepare(
        `SELECT mutation_id,operation_id,local_event_seq,publication_authority,
    publication_sha256,payload_json,status FROM org_registry_record_publications ORDER BY local_event_seq`
      )
      .all() as Array<{
      mutation_id: string;
      operation_id: string;
      local_event_seq: number;
      publication_authority: string;
      publication_sha256: string;
      payload_json: string;
      status: string;
    }>;
  const localState = () => ({
    audit: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
    entities: db.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
    primers: db.prepare('SELECT * FROM primers ORDER BY id').all(),
    bindings: db.prepare('SELECT * FROM primer_bindings ORDER BY id').all(),
    links: db.prepare('SELECT * FROM lims_link ORDER BY id').all(),
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'primer-publication-'));
    databasePath = join(root, 'test.sqlite');
    path = join(root, 'primers', 'saved.primer.json');
    await mkdir(join(root, 'primers'));
    db = openFileTestDb(databasePath);
    ensureSchema(db, databasePath);
    seedLimsBuiltinsInDb(db);
    accountId = scope.accountId;
    ipcHost.db = db;
    ipcHost.accountId = accountId;
    db.prepare('INSERT INTO workspaces (id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)').run(
      'Primer home',
      root,
      HOME
    );
    db.prepare(
      `INSERT INTO workspace_sync_bindings
      (workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role,created_at,updated_at)
      VALUES(7,?,?,?,?,0,'editor',1,1)`
    ).run(HOME, scope.accountId, scope.orgId, REMOTE);
    const targetPath = join(root, 'template.fasta');
    const targetBases = 'GTAAAACGACGGCCAGTACG';
    const targetBytes = `>Template\n${targetBases}\n`;
    await writeFile(targetPath, targetBytes);
    const fileId = Number(
      db
        .prepare(
          `INSERT INTO indexed_files
      (workspace_id,path,name,extension,indexed_at) VALUES(7,?,'Template','.fasta',1)`
        )
        .run(targetPath).lastInsertRowid
    );
    sequenceId = Number(
      db
        .prepare(
          `INSERT INTO sequences
      (file_id,document_id,name,length,circular) VALUES(?,?,'Template',?,0)`
        )
        .run(fileId, TARGET, targetBases.length).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
      VALUES(?,'sequence','Template',?,'file','active',7,1,1)`
    ).run(TARGET, `waypoint://sequence/${TARGET}`);
    bindCatalogEntityFileInDb(db, {
      entityId: TARGET,
      path: targetPath,
      workspaceRoot: root,
      fileKind: 'fasta',
    });
    recordInitialFastaKindDeclarationInDb(db, requireCatalogEntity(db, TARGET));
    const built = await buildPrimerArtifact({
      id: ENTITY,
      catalogNumber: 'P044',
      name: 'Saved primer',
      sequence: targetBases.slice(0, 17),
      workspaceRoot: root,
      artifactPath: path,
      source: 'manual',
      now: 1_700_000_000_000,
      inventory: {
        origin: 'manual',
        originDetails: { sourceBatch: 'kept' },
        vendor: 'idt',
        orderDate: 1,
        scale: '25nm',
        purification: 'desalt',
        modifications: null,
        stockLocation: 'Box 7',
        concentration: 10,
      },
      binding: {
        id: '90000000-0000-4000-8000-000000000044',
        targetDocumentId: TARGET,
        targetFilePath: targetPath,
        targetLength: targetBases.length,
        targetTopology: 'linear',
        targetFileContentHash: `sha256:${sha(targetBytes)}`,
        targetNormalizedSequenceHash: `sha256:${sha(targetBases)}`,
        start: 0,
        end: 17,
        strand: 1,
      },
    });
    artifact = parsePrimerArtifact(
      JSON.stringify({
        ...built,
        externalNotebook: { title: 'Retain this unknown source data' },
        computed: { ...built.computed, sourceExtension: 'retained' },
        entity: {
          ...built.entity,
          otherFields: { externalOwnerNote: 'kept' },
          state: {
            registrationStatus: 'registered',
            domainStatus: 'designed',
            archived: false,
            archivedAt: null,
            status: 'designed',
            source: 'manual',
          },
        },
        bindings: built.bindings.map((binding) => ({
          ...binding,
          history: { createdAt: 1, updatedAt: 2, source: 'manual' },
        })),
      })
    );
    const projection = () =>
      primerArtifactRegistryProjection(
        artifact,
        {
          mode: 'inline',
          bases: artifact.sequence.bases,
          topology: 'linear',
          length: artifact.sequence.length,
          contentHash: `sha256:${artifact.sequence.contentHash}`,
        },
        sha(serializePrimerArtifact(artifact))
      );
    const link = db.transaction(() => {
      registerLimsEntityInsideTx(db, {
        id: ENTITY,
        kind: artifact.registry.kind,
        name: artifact.name,
        workspaceId: 7,
        schemaRevisionId: artifact.entity!.schema.schemaRevisionId,
        ...projection(),
      });
      registerLimsEntityInsideTx(db, {
        id: TARGET,
        kind: 'dna_sequence',
        name: 'Template',
        workspaceId: 7,
        fields: {
          sequence: {
            mode: 'inline',
            bases: targetBases,
            length: targetBases.length,
            topology: 'linear',
            contentHash: `sha256:${sha(targetBases)}`,
          },
        },
      });
      return linkLimsEntitiesInsideTx(db, {
        id: 'a0000000-0000-4000-8000-000000000044',
        fromEntityId: ENTITY,
        toEntityId: TARGET,
        type: 'references',
        workspaceId: 7,
        payload: { evidence: 'current' },
      });
    })();
    artifact.registryRelationships = [
      {
        id: link.id,
        fromEntityId: link.fromEntityId,
        toEntityId: link.toEntityId,
        type: link.type,
        payload: link.payload,
        project: { status: 'assigned', repoUuid: HOME },
        actor: link.actor,
        sourceEventSeq: link.eventSeq,
        archived: link.tombstone,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
        archivedAt: link.archivedAt,
      },
    ];
    db.transaction(() =>
      updateLimsEntityInsideTx(db, {
        id: ENTITY,
        name: artifact.name,
        ...projection(),
        replaceFields: true,
      })
    )();
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
      VALUES(?,'primer',?,?,'file','active',7,?,1,1)`
    ).run(
      ENTITY,
      artifact.name,
      `waypoint://primer/${ENTITY}`,
      JSON.stringify({ externalCatalogNote: 'kept' })
    );

    await writeFile(path, `${JSON.stringify(artifact, null, 4)}\n`);
    bindCatalogEntityFileInDb(db, {
      entityId: ENTITY,
      path,
      workspaceRoot: root,
      fileKind: 'primer-artifact',
      contentHash: `sha256:${sha(serializePrimerArtifact(artifact))}`,
    });
    replacePrimerLegacyProjectionInDb(
      db,
      primerArtifactLegacyProjection(
        artifact,
        artifact.bindings.map((binding) => ({ binding, sequenceId })),
        7
      ).input
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    db?.close();
    await rm(root, { recursive: true, force: true });
  });

  async function enroll() {
    const current = entity();
    const mutationId = randomUUID();
    const payload = {
      id: current.id,
      kind: current.kind,
      name: current.name,
      fields: current.fields,
      registrationStatus: current.registrationStatus,
      domainStatus: current.domainStatus,
      schemaId: ORGANIZATION_SCHEMA,
      schemaRevisionId: ORGANIZATION_REVISION,
      homeWorkspaceId: REMOTE,
    };
    const canonical = { ...payload, orgId: scope.orgId, revision: 1, archivedAt: null };
    replaceOrgRegistrySnapshot(db, {
      ...scope,
      cursor: 1,
      accessGeneration,
      now: 1,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [canonical],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
    const sourceRevision = sha(await readFile(path));
    db.transaction(() => {
      enrollOrgRegistryRecordInTx(db, {
        ...scope,
        mutationId,
        now: 1,
        claim: {
          mutationId,
          sourceEntityId: ENTITY,
          sourceRegistryId: current.registryId,
          sourceRevision,
          homeWorkspaceId: REMOTE,
          homeProjectUuid: HOME,
          homeProjectName: 'Primer home',
          payload,
        },
      });
      enqueueOrgRegistryMutation(db, {
        ...scope,
        mutationId,
        operation: 'entity.create',
        payload,
        now: 1,
      });
    })();
    acknowledgeOrgRegistryMutation(db, {
      ...scope,
      mutationId,
      now: 2,
      receipt: {
        status: 'applied',
        eventSeq: 1,
        mutationId,
        accessGeneration,
        entityId: ENTITY,
        homeWorkspaceId: REMOTE,
        entity: canonical,
      },
    });
  }
  async function request(
    change: PrimerArtifactRevisionRequest['change'] = {
      type: 'content',
      content: {
        name: 'Edited primer',
        sequence: artifact.sequence.bases,
        notes: 'Checked revision',
      },
    }
  ): Promise<PrimerArtifactRevisionRequest> {
    return {
      entityId: ENTITY,
      operationId: randomUUID(),
      expectedEventSeq: entity().eventSeq!,
      expectedContentHash: sha(await readFile(path)),
      change,
    };
  }
  const publish = (request: PrimerArtifactRevisionRequest) =>
    publishPrimerArtifactRevision({ ...context(), request });

  const sender = Object.assign(new EventEmitter(), { id: 334644, isDestroyed: () => false });
  async function invokePrimerIpc(channel: string, input: unknown, mutationToken?: string) {
    ipcHost.db = db;
    ipcHost.accountId = accountId;
    vi.mocked(ipcMain.handle).mockClear();
    registerLimsIpcHandlers();
    const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channel);
    if (!handler) throw new Error(`Missing actual IPC handler ${channel}`);

    const result: unknown = Reflect.apply(handler, undefined, [{ sender }, input, mutationToken]);
    return result;
  }

  it('routes Registry Archive and exact retry through retained primer bytes, then restores the proven prior status', async () => {
    await enroll();
    await publish(
      await request({
        type: 'content',
        content: {
          name: artifact.name,
          sequence: artifact.sequence.bases,
          status: 'ordered',
        },
      })
    );
    const before = await readFile(path, 'utf8');
    const action = { id: ENTITY, expectedEventSeq: entity().eventSeq!, operationId: randomUUID() };
    vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted Registry archive')
    );
    await expect(invokePrimerIpc('lims:archiveEntity', action)).rejects.toThrow(
      'Interrupted Registry archive'
    );
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(publications().at(-1)).toMatchObject({
      operation_id: action.operationId,
      status: 'publication_pending',
      publication_authority: 'primer_artifact',
    });
    const interrupted = localState();
    const interruptedPublications = publications();
    await expect(invokePrimerIpc('lims:restoreEntity', action)).rejects.toThrow(
      /reused|different|original/i
    );
    await expect(
      invokePrimerIpc('lims:archiveEntity', {
        ...action,
        expectedEventSeq: action.expectedEventSeq + 1,
      })
    ).rejects.toThrow(/reused|different/i);
    expect(localState()).toEqual(interrupted);
    expect(publications()).toEqual(interruptedPublications);
    expect(await readFile(path, 'utf8')).toBe(before);
    db.close();
    db = openFileTestDb(databasePath);
    await expect(invokePrimerIpc('lims:archiveEntity', action)).resolves.toMatchObject({
      id: ENTITY,
      workspaceId: 7,
      tombstone: true,
    });
    const archived = await readFile(path, 'utf8');
    expect(parsePrimerArtifact(archived).entity?.state).toMatchObject({
      archived: true,
      status: 'archived',
    });
    expect(publications().at(-1)).toMatchObject({
      operation_id: action.operationId,
      status: 'ready',
      publication_sha256: sha(archived),
    });
    const settled = localState();
    await invokePrimerIpc('lims:archiveEntity', action);
    expect(localState()).toEqual(settled);
    const restoreAction = {
      id: ENTITY,
      expectedEventSeq: entity().eventSeq!,
      operationId: randomUUID(),
    };
    vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted Registry restore')
    );
    await expect(invokePrimerIpc('lims:restoreEntity', restoreAction)).rejects.toThrow(
      'Interrupted Registry restore'
    );
    expect(await readFile(path, 'utf8')).toBe(archived);
    const interruptedRestore = localState();
    await expect(invokePrimerIpc('lims:archiveEntity', restoreAction)).rejects.toThrow(
      /reused|different/i
    );
    expect(localState()).toEqual(interruptedRestore);
    await invokePrimerIpc('lims:restoreEntity', restoreAction);
    const restoredState = localState();
    await invokePrimerIpc('lims:restoreEntity', restoreAction);
    expect(localState()).toEqual(restoredState);
    const restored = parsePrimerArtifact(await readFile(path, 'utf8'));
    expect(restored.entity?.state).toMatchObject({
      archived: false,
      archivedAt: null,
      status: 'ordered',
      domainStatus: 'ordered',
    });
    expect(restored.id).toBe(ENTITY);
    expect(restored.file).toEqual(artifact.file);
    expect(restored.registryRelationships).toEqual(artifact.registryRelationships);
    expect(restored.bindings).toEqual(artifact.bindings);
    expect(db.prepare('SELECT workspace_id,status FROM primers WHERE id=?').get(ENTITY)).toEqual({
      workspace_id: 7,
      status: 'ordered',
    });
    expect(
      publications().every(
        (row) => row.publication_authority === 'primer_artifact' && row.status === 'ready'
      )
    ).toBe(true);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('never treats another primer publication as an Archive or guesses an unavailable historical Restore status', async () => {
    await enroll();
    const edit = await request();
    vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Content interrupted')
    );
    await expect(publish(edit)).rejects.toThrow('Content interrupted');
    const before = localState();
    const bytes = await readFile(path, 'utf8');
    await expect(
      invokePrimerIpc('lims:archiveEntity', {
        id: ENTITY,
        operationId: edit.operationId,
        expectedEventSeq: edit.expectedEventSeq,
      })
    ).rejects.toThrow(/reused|different/i);
    expect(localState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    await resumePrimerArtifactPublication({
      ...context(),
      entityId: ENTITY,
      operationId: edit.operationId,
    });
    await publish(await request({ type: 'archive' }));

    await publish(
      await request({
        type: 'content',
        content: { name: 'Still archived', sequence: artifact.sequence.bases, status: 'archived' },
      })
    );
    const historical = localState();
    const historicalBytes = await readFile(path, 'utf8');
    await expect(
      invokePrimerIpc('lims:restoreEntity', {
        id: ENTITY,
        operationId: randomUUID(),
        expectedEventSeq: entity().eventSeq!,
      })
    ).rejects.toThrow(/prior status|choose.*status/i);
    expect(localState()).toEqual(historical);
    expect(await readFile(path, 'utf8')).toBe(historicalBytes);
  });

  it('exposes pending primer Retry through actual registered commands without releasing a borrowed project lease', async () => {
    await enroll();
    const release = await acquireWorkspaceMutationShared(root);
    const releaseSpy = vi.fn(release);
    const token = workspaceMutationCapabilities.issue(
      sender.id,
      workspaceMutationRootIdentity(root),
      releaseSpy
    );
    try {
      await expect(
        invokePrimerIpc('lims:readPrimerArtifactRevisionState', {
          entityId: ENTITY,
          mutationToken: token,
        })
      ).resolves.toMatchObject({ state: 'ready', entity: { id: ENTITY } });
      const edit = await request();
      vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
        new Error('Typed Save interrupted')
      );
      await expect(
        invokePrimerIpc('lims:revisePrimerArtifact', { ...edit, mutationToken: token })
      ).rejects.toThrow('Typed Save interrupted');
      await expect(
        invokePrimerIpc('lims:readPrimerArtifactRevisionState', {
          entityId: ENTITY,
          mutationToken: token,
        })
      ).resolves.toMatchObject({ state: 'pending', operationId: edit.operationId });
      await expect(
        invokePrimerIpc('lims:resumePrimerArtifactPublication', {
          entityId: ENTITY,
          operationId: edit.operationId,
          mutationToken: token,
        })
      ).resolves.toMatchObject({ replayed: true, entity: { id: ENTITY } });
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(workspaceMutationCapabilities.resolveOwnedWorkspaceRoot(token, sender.id)).toBe(
        workspaceMutationRootIdentity(root)
      );
      const saved = localState();
      const savedBytes = await readFile(path, 'utf8');
      await expect(
        invokePrimerIpc('lims:updateEntity', { id: ENTITY, name: 'Database-only edit' }, token)
      ).rejects.toThrow(/saved primer|primer editor/i);
      expect(localState()).toEqual(saved);
      expect(await readFile(path, 'utf8')).toBe(savedBytes);
    } finally {
      workspaceMutationCapabilities.release(token, sender.id);
    }
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const beforeRevert = localState();
    await expect(
      invokePrimerIpc('lims:revertEntity', {
        id: ENTITY,
        expectedEventSeq: entity().eventSeq,
        operationId: randomUUID(),
      })
    ).rejects.toThrow(/saved primer|primer editor/i);
    expect(localState()).toEqual(beforeRevert);
  });

  it('keeps a failed file publication unsendable and resumes one immutable revision after reopening SQLite', async () => {
    await enroll();
    const before = await readFile(path, 'utf8');
    const originalLinks = localState().links;
    const edit = await request({
      type: 'content',
      content: {
        name: 'Edited primer',
        sequence: artifact.sequence.bases,
        notes: 'Checked revision',
        inventory: { ...artifact.inventory!, stockLocation: 'Box 8' },
      },
    });
    vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted primer write')
    );
    await expect(publish(edit)).rejects.toThrow('Interrupted primer write');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(publications()).toHaveLength(1);
    const pending = publications()[0];
    expect(pending).toMatchObject({
      operation_id: edit.operationId,
      publication_authority: 'primer_artifact',
      status: 'publication_pending',
    });
    expect(readReadyOrgRegistryRecordMutations(db, { ...scope, now: 3 })).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      1
    );
    db.close();
    db = openFileTestDb(databasePath);
    expect(
      await readPendingPrimerArtifactPublication({ ...context(), entityId: ENTITY })
    ).toMatchObject({ entityId: ENTITY, operationId: edit.operationId, workspaceId: 7 });
    const resumed = await resumePrimerArtifactPublication({
      ...context(),
      entityId: ENTITY,
      operationId: edit.operationId,
    });
    const bytes = await readFile(path, 'utf8');
    const saved = parsePrimerArtifact(bytes);
    expect(resumed.replayed).toBe(true);
    expect(saved).toMatchObject({
      id: ENTITY,
      name: 'Edited primer',
      artifactRevision: 2,
      externalNotebook: { title: 'Retain this unknown source data' },
      computed: { sourceExtension: 'retained' },
      inventory: { stockLocation: 'Box 8' },
      entity: { otherFields: { externalOwnerNote: 'kept' } },
    });
    expect(saved.bindings).toEqual(artifact.bindings);
    expect(saved.registryRelationships).toEqual(artifact.registryRelationships);
    expect(localState().links).toEqual(originalLinks);
    expect(
      db.prepare('SELECT name,workspace_id,stock_location FROM primers WHERE id=?').get(ENTITY)
    ).toEqual({ name: 'Edited primer', workspace_id: 7, stock_location: 'Box 8' });
    expect(
      db
        .prepare('SELECT sequence_id,created_at,updated_at FROM primer_bindings WHERE primer_id=?')
        .get(ENTITY)
    ).toEqual({ sequence_id: sequenceId, created_at: 1, updated_at: 2 });
    expect(publications()).toEqual([
      { ...pending, status: 'ready', publication_sha256: sha(bytes) },
    ]);
    expect(readReadyOrgRegistryRecordMutations(db, { ...scope, now: 4 })).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      0
    );
    const settled = localState();
    const settledPublications = publications();
    await expect(publish(edit)).resolves.toMatchObject({ replayed: true });
    expect(localState()).toEqual(settled);
    expect(publications()).toEqual(settledPublications);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    await expect(publish({ ...edit, change: { type: 'archive' } })).rejects.toThrow(/reused/);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('keeps exact bytes pending until required export settles, then retries without a second local revision', async () => {
    await enroll();
    const edit = await request();
    vi.spyOn(limsExport, 'materializeLimsGitReadableExportInDb').mockImplementationOnce(() => {
      throw new Error('Interrupted durable export');
    });
    await expect(publish(edit)).rejects.toThrow('Interrupted durable export');
    const bytes = await readFile(path, 'utf8');
    const audit = localState().audit;
    expect(parsePrimerArtifact(bytes).name).toBe('Edited primer');
    expect(publications()[0]).toMatchObject({
      publication_sha256: sha(bytes),
      status: 'publication_pending',
    });
    expect(readReadyOrgRegistryRecordMutations(db, { ...scope, now: 3 })).toEqual([]);
    await expect(publish(edit)).resolves.toMatchObject({ replayed: true });
    expect(localState().audit).toEqual(audit);
    expect(publications()[0].status).toBe('ready');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('refuses an account switch after the real source read before mutating audit or saved bytes', async () => {
    await enroll();
    const edit = await request();
    const before = localState();
    const bytes = await readFile(path, 'utf8');
    const read = nativePublication.readNativeCatalogPublicationBase;
    vi.spyOn(nativePublication, 'readNativeCatalogPublicationBase').mockImplementationOnce(
      async (input) => {
        const result = await read(input);
        accountId = 'different-account';
        return result;
      }
    );
    await expect(publish(edit)).rejects.toThrow(/account|sign in/i);
    expect(localState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(publications()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      0
    );
  });

  it('preserves an external file change and the original pending intent on exact Retry', async () => {
    await enroll();
    const edit = await request();
    vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted primer write')
    );
    await expect(publish(edit)).rejects.toThrow('Interrupted primer write');
    const external = serializePrimerArtifact({ ...artifact, name: 'External saved version' });
    await writeFile(path, external);
    const pending = publications();
    const state = localState();
    await expect(publish(edit)).rejects.toThrow(/changed|conflict|source|precondition/i);
    expect(await readFile(path, 'utf8')).toBe(external);
    expect(localState()).toEqual(state);
    expect(publications()).toEqual(pending);
    expect(readReadyOrgRegistryRecordMutations(db, { ...scope, now: 3 })).toEqual([]);
  });

  it('publishes Archive and explicit Restore as the same saved UUID/home with exact lifecycle intent', async () => {
    await enroll();
    await publish(await request({ type: 'archive' }));
    const archived = parsePrimerArtifact(await readFile(path, 'utf8'));
    expect(archived.entity?.state).toMatchObject({
      archived: true,
      archivedAt: entity().archivedAt,
      status: 'archived',
    });
    expect(JSON.parse(publications()[0].payload_json)).toMatchObject({
      id: ENTITY,
      archived: true,
    });
    await publish(await request({ type: 'restore', status: 'ordered' }));
    const restored = parsePrimerArtifact(await readFile(path, 'utf8'));
    expect(restored).toMatchObject({
      id: ENTITY,
      file: artifact.file,
      artifactRevision: 3,
      entity: {
        state: { archived: false, archivedAt: null, status: 'ordered', domainStatus: 'ordered' },
      },
    });
    expect(entity()).toMatchObject({ id: ENTITY, workspaceId: 7, tombstone: false });
    expect(publications()).toHaveLength(2);
    expect(publications().every((row) => row.status === 'ready')).toBe(true);
    expect(JSON.parse(publications()[1].payload_json)).toMatchObject({
      id: ENTITY,
      archived: false,
    });
    expect(
      db
        .prepare(
          'SELECT home_workspace_id,workspace_uuid FROM org_registry_local_records WHERE entity_id=?'
        )
        .get(ENTITY)
    ).toEqual({ home_workspace_id: REMOTE, workspace_uuid: HOME });
    expect(db.prepare('SELECT status FROM primers WHERE id=?').get(ENTITY)).toEqual({
      status: 'ordered',
    });
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('publishes content, inventory and explicit lifecycle in one immutable primer revision', async () => {
    await enroll();
    await publish(
      await request({
        type: 'content',
        content: {
          name: 'Ordered and stored',
          sequence: artifact.sequence.bases,
          status: 'archived',
          inventory: { ...artifact.inventory!, stockLocation: 'Box 12' },
        },
      })
    );
    const saved = parsePrimerArtifact(await readFile(path, 'utf8'));
    expect(saved).toMatchObject({
      id: ENTITY,
      name: 'Ordered and stored',
      artifactRevision: 2,
      inventory: { stockLocation: 'Box 12' },
      entity: { state: { archived: true, archivedAt: entity().archivedAt, status: 'archived' } },
    });
    expect(publications()).toHaveLength(1);
    expect(JSON.parse(publications()[0].payload_json)).toMatchObject({
      id: ENTITY,
      name: 'Ordered and stored',
      archived: true,
    });
    await publish(
      await request({
        type: 'content',
        content: {
          name: 'Restored with new inventory',
          sequence: artifact.sequence.bases,
          status: 'received',
          inventory: { ...saved.inventory!, stockLocation: 'Box 15' },
        },
      })
    );
    expect(parsePrimerArtifact(await readFile(path, 'utf8'))).toMatchObject({
      id: ENTITY,
      artifactRevision: 3,
      name: 'Restored with new inventory',
      inventory: { stockLocation: 'Box 15' },
      entity: { state: { archived: false, archivedAt: null, status: 'received' } },
    });
    expect(publications()).toHaveLength(2);
    expect(publications().every((row) => row.status === 'ready')).toBe(true);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it.each(['viewer', 'detached', 'remote_home', 'claim_event'] as const)(
    'refuses pending Retry before publishing any bytes when %s authority changes',
    async (changed) => {
      await enroll();
      const edit = await request();
      const write = vi
        .spyOn(nativePublication, 'publishNativeCatalogBytes')
        .mockRejectedValueOnce(new Error('Interrupted primer write'));
      await expect(publish(edit)).rejects.toThrow('Interrupted primer write');
      const bytes = await readFile(path, 'utf8');
      if (changed === 'viewer')
        db.prepare(
          "UPDATE workspace_sync_bindings SET access_role='viewer' WHERE workspace_id=7"
        ).run();
      if (changed === 'detached')
        db.prepare(
          "UPDATE workspace_sync_bindings SET detached_reason='access_removed' WHERE workspace_id=7"
        ).run();
      if (changed === 'remote_home')
        db.prepare(
          'UPDATE workspace_sync_bindings SET remote_workspace_id=? WHERE workspace_id=7'
        ).run(randomUUID());
      if (changed === 'claim_event')
        db.prepare(
          'UPDATE org_registry_local_records SET claim_local_event_seq=claim_local_event_seq+1 WHERE entity_id=?'
        ).run(ENTITY);
      const state = localState();
      const pending = publications();
      write.mockClear();
      await expect(
        resumePrimerArtifactPublication({
          ...context(),
          entityId: ENTITY,
          operationId: edit.operationId,
        })
      ).rejects.toThrow(/home|write access|connection/i);
      expect(write).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(localState()).toEqual(state);
      expect(publications()).toEqual(pending);
      expect(publications()[0].status).toBe('publication_pending');
    }
  );

  it('publishes owned pasted bindings without changing unrelated attachments and refuses another document', async () => {
    await enroll();
    const owned = artifact.bindings[0];
    const unrelated = {
      ...owned,
      id: randomUUID(),
      coordinates: { ...owned.coordinates, start: 2, end: 19 },
    };
    await publish(await request({ type: 'binding_add', binding: unrelated }));
    const replacement = { ...owned, coordinates: { ...owned.coordinates, start: 1, end: 18 } };
    const change = {
      type: 'bindings_replace_owned' as const,
      ownedBindingIds: [owned.id],
      targetDocumentId: owned.target.documentId,
      bindings: [replacement],
    };
    const saved = await publish(await request(change));
    expect(saved.changed).toBe(true);
    const reopened = parsePrimerArtifact(await readFile(path, 'utf8'));
    expect(reopened.bindings).toEqual([unrelated, replacement]);
    const before = localState();
    const bytes = await readFile(path, 'utf8');
    const pending = publications();
    expect(await publish(await request(change))).toMatchObject({
      changed: false,
      unchangedReason: 'unchanged_owned_bindings',
    });
    await expect(
      publish(await request({ ...change, targetDocumentId: randomUUID() }))
    ).rejects.toThrow('another document');
    expect(localState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(publications()).toEqual(pending);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('leaves duplicate attachments and absent removals as exact no-ops', async () => {
    await enroll();
    const before = localState();
    const bytes = await readFile(path, 'utf8');
    const duplicate = await publish(
      await request({ type: 'binding_add', binding: { ...artifact.bindings[0], id: randomUUID() } })
    );
    expect(duplicate).toMatchObject({
      changed: false,
      unchangedReason: 'duplicate_binding',
      bindingId: artifact.bindings[0].id,
    });
    const missing = await publish(
      await request({ type: 'binding_remove', bindingId: randomUUID() })
    );
    expect(missing).toMatchObject({ changed: false, unchangedReason: 'missing_binding' });
    expect(localState()).toEqual(before);
    expect(publications()).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      0
    );
  });

  it('retains saved relationship evidence and current links when projection conflicts', async () => {
    artifact.registryRelationships![0].payload = { evidence: 'saved historical version' };
    const bytes = serializePrimerArtifact(artifact);
    await writeFile(path, bytes);
    const projection = primerArtifactRegistryProjection(
      artifact,
      {
        mode: 'inline',
        bases: artifact.sequence.bases,
        topology: 'linear',
        length: artifact.sequence.length,
        contentHash: `sha256:${artifact.sequence.contentHash}`,
      },
      sha(bytes)
    );
    db.transaction(() =>
      updateLimsEntityInsideTx(db, { id: ENTITY, ...projection, replaceFields: true })
    )();
    bindCatalogEntityFileInDb(db, {
      entityId: ENTITY,
      path,
      workspaceRoot: root,
      fileKind: 'primer-artifact',
      contentHash: `sha256:${sha(bytes)}`,
    });
    await enroll();
    const before = localState();
    const catalogSource = () =>
      db
        .prepare(
          'SELECT f.content_hash,e.metadata FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id WHERE f.entity_id=?'
        )
        .get(ENTITY);
    const sourceBefore = catalogSource();
    const edit = await request();
    await expect(publish(edit)).rejects.toThrow(/relationship.*conflicts/i);
    expect(catalogSource()).toEqual(sourceBefore);
    expect(localState().links).toEqual(before.links);
    expect(localState().primers).toEqual(before.primers);
    expect(localState().bindings).toEqual(before.bindings);
    expect(parsePrimerArtifact(await readFile(path, 'utf8')).registryRelationships).toEqual(
      artifact.registryRelationships
    );
    const pending = publications();
    await expect(publish(edit)).rejects.toThrow(/relationship.*conflicts/i);
    expect(catalogSource()).toEqual(sourceBefore);
    expect(publications()).toEqual(pending);
    expect(pending[0].status).toBe('publication_pending');
    expect(readReadyOrgRegistryRecordMutations(db, { ...scope, now: 3 })).toEqual([]);
    expect(() => assertEnrolledPrimerPhysicalMutationAllowed(db, [ENTITY])).toThrow(
      /registered.*organization/
    );
  });
  async function reviewPrimerResolution() {
    const row = db
      .prepare(
        `SELECT payload_json FROM org_registry_cache
      WHERE org_id=? AND account_id=? AND record_type='entity' AND record_id=?`
      )
      .get(scope.orgId, scope.accountId, ENTITY) as { payload_json: string };
    const canonical = {
      ...JSON.parse(row.payload_json),
      name: 'Organization changed name',
      revision: 2,
    };
    replaceOrgRegistrySnapshot(db, {
      ...scope,
      cursor: 2,
      accessGeneration,
      now: 3,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [canonical],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
    const checked = await readCheckedOrganizationRecordReview(
      db,
      { ...scope, entityId: ENTITY },
      async () => {
        if (accountId !== scope.accountId) throw new Error('Active account changed');
      }
    );
    const resolutionId = randomUUID();
    return {
      ...scope,
      entityId: ENTITY,
      resolutionId,
      operationId: `org-record-resolution:${resolutionId}`,
      choice: 'keep_saved' as const,
      sourceRevision: checked.displayed.sourceRevision,
      review: checked.review,
    };
  }

  it('Keep saved publishes one real resolution event while preserving every primer byte and retained relationship', async () => {
    await enroll();
    const request = await reviewPrimerResolution();
    const before = await readFile(path);
    const original = entity();
    const links = localState().links;
    const result = await publishReviewedPrimerArtifactResolution({
      ...context(),
      request,
      verifiedAccessGeneration: accessGeneration,
    });
    expect(result.replayed).toBe(false);
    expect(result.entity.eventSeq).toBeGreaterThan(original.eventSeq!);
    expect(result.entity).toMatchObject({
      id: ENTITY,
      workspaceId: 7,
      name: original.name,
      fields: original.fields,
      schemaRevisionId: original.schemaRevisionId,
    });
    expect(await readFile(path)).toEqual(before);
    expect(parsePrimerArtifact(before.toString()).artifactRevision).toBe(artifact.artifactRevision);
    expect(localState().links).toEqual(links);
    expect(publications()).toHaveLength(1);
    expect(publications()[0]).toMatchObject({
      operation_id: request.operationId,
      status: 'ready',
      publication_authority: 'primer_artifact',
      publication_sha256: sha(before),
    });
    const outgoing = readReadyOrgRegistryRecordMutations(db, { ...scope, now: 4 });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].payload).toMatchObject({
      id: ENTITY,
      expectedRevision: 2,
      name: original.name,
    });
    const settled = localState();
    await expect(
      publishReviewedPrimerArtifactResolution({
        ...context(),
        request,
        verifiedAccessGeneration: accessGeneration,
      })
    ).resolves.toMatchObject({ replayed: true, entity: result.entity });
    expect(localState()).toEqual(settled);
    expect(await readFile(path)).toEqual(before);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('retains an interrupted Keep saved across restart and revocation, then replays its exact choice after current regrant', async () => {
    await enroll();
    const request = await reviewPrimerResolution();
    const before = await readFile(path);
    vi.spyOn(nativePublication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted reviewed primer publication')
    );
    await expect(
      publishReviewedPrimerArtifactResolution({
        ...context(),
        request,
        verifiedAccessGeneration: accessGeneration,
      })
    ).rejects.toThrow('Interrupted reviewed primer publication');
    const savedEvent = entity().eventSeq;
    expect(publications()).toEqual([]);
    expect(db.prepare('SELECT status FROM org_registry_record_resolutions').get()).toEqual({
      status: 'publication_pending',
    });
    await recoverPrimerArtifactPublications({ ...context(), workspaceId: 7 });
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      1
    );
    db.close();
    db = openFileTestDb(databasePath);
    const identity = { ...context(), ...request, verifiedAccessGeneration: accessGeneration };
    await expect(
      resumeReviewedPrimerArtifactResolution({ ...identity, choice: 'use_remote' })
    ).rejects.toThrow(/reused/);
    await expect(
      resumeReviewedPrimerArtifactResolution({ ...identity, sourceRevision: '0'.repeat(64) })
    ).rejects.toThrow(/reused/);
    db.prepare(
      "UPDATE org_registry_sync_state SET status='access_revoked' WHERE org_id=? AND account_id=?"
    ).run(scope.orgId, scope.accountId);
    await expect(resumeReviewedPrimerArtifactResolution(identity)).rejects.toThrow(/access/);
    expect(await readFile(path)).toEqual(before);
    expect(entity().eventSeq).toBe(savedEvent);
    const regrant = `home-v1:${'9'.repeat(64)}`;
    replaceOrgRegistrySnapshot(db, {
      ...scope,
      cursor: 3,
      accessGeneration: regrant,
      now: 6,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [{ ...request.review.canonical, name: 'Newer remote version', revision: 3 }],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
    db.prepare(
      "UPDATE workspace_sync_bindings SET access_role='viewer' WHERE workspace_id=7"
    ).run();
    expect(
      readReviewedPrimerArtifactResolutionIdentity(db, {
        ...identity,
        verifiedAccessGeneration: regrant,
      })
    ).toMatchObject({ sourceRevision: request.sourceRevision, choice: 'keep_saved' });
    await expect(
      resumeReviewedPrimerArtifactResolution({ ...identity, verifiedAccessGeneration: regrant })
    ).rejects.toThrow();
    db.prepare(
      "UPDATE workspace_sync_bindings SET access_role='manager' WHERE workspace_id=7"
    ).run();
    await expect(
      resumeReviewedPrimerArtifactResolution({ ...identity, verifiedAccessGeneration: regrant })
    ).resolves.toMatchObject({ replayed: true });
    expect(await readFile(path)).toEqual(before);
    expect(entity().eventSeq).toBe(savedEvent);
    expect(readReadyOrgRegistryRecordMutations(db, { ...scope, now: 7 })[0].payload).toMatchObject({
      expectedRevision: 2,
      name: request.review.local.name,
    });
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      0
    );
  });

  it('refuses stale raw bytes and unavailable organization saved bytes before any resolution or local event', async () => {
    await enroll();
    const request = await reviewPrimerResolution();
    const original = await readFile(path, 'utf8');
    const before = localState();
    await expect(
      publishReviewedPrimerArtifactResolution({
        ...context(),
        request: { ...request, choice: 'use_remote' },
        verifiedAccessGeneration: accessGeneration,
      })
    ).rejects.toMatchObject({ code: 'SAVED_VERSION_UNAVAILABLE' });
    await writeFile(path, original + '\n');
    await expect(
      publishReviewedPrimerArtifactResolution({
        ...context(),
        request,
        verifiedAccessGeneration: accessGeneration,
      })
    ).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(localState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(original + '\n');
    expect(db.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()).toBe(
      0
    );
    expect(db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()).toBe(
      0
    );
  });
});
