/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  accountId: null as string | null,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => host.db }));
vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () =>
    host.accountId ? { accountId: host.accountId } : null
  ),
}));

import { ipcMain } from 'electron';
import {
  applyLimsImportBatchInDb,
  listLimsEntitySchemasInDb,
  queryLimsEntitiesInDb,
  registerLimsIpcHandlers,
  registerLimsEntityInDb,
  updateLimsEntityInDb,
} from '../lims';
import { ensureSchema } from '../schema';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  entityArtifactSchemaSnapshot,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import { verifyLimsAuditHashChainInDb } from '../lims-projection-rebuild';
import { buildPrimerArtifact, serializePrimerArtifact } from '../../shared/primers/primer-artifact';
import * as publication from '../native-catalog-publication';
import { createTestDb } from './test-db';
import { getActiveStoredSession } from '../auth/session-store';
import {
  enrollOrgRegistryRecordInTx,
  readReadyOrgRegistryRecordMutations,
} from '../org-registry-record-sync';
import {
  acknowledgeOrgRegistryMutation,
  enqueueOrgRegistryMutation,
  readPendingOrgRegistryMutations,
  replaceOrgRegistrySnapshot,
} from '../org-registry-sync-cache';

let root: string;
let paths: string[];
const batchId = 'owned-two-project-import';
const ids = ['imported-one', 'imported-two'];
const sender = Object.assign(new EventEmitter(), { id: 4291, isDestroyed: () => false });
const rows = () =>
  ids.map((id) => queryLimsEntitiesInDb(host.db!, { id, includeArchived: true })[0]);
const snapshot = () =>
  JSON.stringify({
    entities: host.db!.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
    history: host.db!.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
    outbox: host.db!.prepare('SELECT * FROM native_catalog_publication_outbox').all(),
  });

beforeEach(async () => {
  host.accountId = null;
  vi.mocked(getActiveStoredSession).mockClear();
  root = await mkdtemp(join(tmpdir(), 'registry-import-undo-'));
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  const roots = [join(root, 'one'), join(root, 'two')];
  paths = roots.map((path) => join(path, 'owned.entity.json'));
  for (let index = 0; index < roots.length; index++) {
    await mkdir(roots[index]);
    host.db
      .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,1)')
      .run(7 + index, `Owned project ${index + 1}`, roots[index]);
  }
  const schemaSnapshot = entityArtifactSchemaSnapshot(
    listLimsEntitySchemasInDb(host.db).find((schema) => schema.entityKind === 'strain')!
  );
  applyLimsImportBatchInDb(host.db, {
    batchId,
    sourceName: 'owned-strains.csv',
    sourceKind: 'csv',
    records: ids.map((id, index) => ({
      id: `row-${index + 1}`,
      accepted: true,
      action: 'register_entity',
      entity: {
        id,
        kind: 'strain',
        name: `Imported strain ${index + 1}`,
        fields: {
          genotypeCanonical: 'recA1',
          artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'owned.entity.json' },
        },
        schemaSnapshot,
        schemaRevisionId: schemaSnapshot.schemaRevisionId,
        workspaceId: 7 + index,
      },
      source: { fileName: 'owned-strains.csv' },
    })),
  });
  for (const [index, entity] of rows().entries()) {
    const doc: EntityArtifactV2 = {
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      fields: entity.fields,
      schemaSnapshot,
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      archived: false,
      registrationStatus: entity.registrationStatus,
      domainStatus: entity.domainStatus,
      relationships: [],
      source: {
        type: 'file_import',
        recordId: `row-${index + 1}`,
        sourceName: 'owned-strains.csv',
        sourceKind: 'csv',
        values: {},
      },
    };
    await writeFile(paths[index], serializeEntityArtifact(doc));
  }
  vi.mocked(ipcMain.handle).mockClear();
  registerLimsIpcHandlers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});

async function undo(targetBatchId = batchId) {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get('lims:undoImportBatch');
  if (!handler) throw new Error('Missing actual import Undo IPC');
  const value: unknown = await handler({ sender } as unknown as Electron.IpcMainInvokeEvent, {
    batchId: targetBatchId,
    actor: 'local-user',
  });
  if (value && typeof value === 'object' && '__waypointUserMessageFailure' in value)
    throw new Error(`User message ${JSON.stringify(value.__waypointUserMessageFailure)}`);
  return value;
}

describe('owned import Undo through actual IPC, filesystem and SQLite', () => {
  it.each(['primer', 'link'] as const)(
    'refuses import Undo affecting an enrolled %s before any record, link, file or history changes',
    async (affected) => {
      const primerId = randomUUID();
      const primerPath = join(root, 'one', 'retained.primer.json');
      const primerFields = {
        sequence: {
          mode: 'inline' as const,
          bases: 'ACGTACGTACGT',
          length: 12,
          topology: 'linear' as const,
        },
        artifact: { schema: 'dnaforge.primer', relativePath: 'retained.primer.json' },
      };
      const ownBatch = `retained-primer-${affected}`;
      if (affected === 'link')
        registerLimsEntityInDb(host.db!, {
          id: primerId,
          workspaceId: 7,
          kind: 'oligo',
          name: 'Enrolled primer',
          fields: primerFields,
        });
      const importedId = affected === 'primer' ? primerId : randomUUID();
      applyLimsImportBatchInDb(host.db!, {
        batchId: ownBatch,
        sourceName: 'retained.csv',
        sourceKind: 'csv',
        records: [
          {
            id: 'retained-row',
            accepted: true,
            action: 'register_entity',
            entity:
              affected === 'primer'
                ? {
                    id: importedId,
                    workspaceId: 7,
                    kind: 'oligo',
                    name: 'Enrolled primer',
                    fields: primerFields,
                  }
                : {
                    id: importedId,
                    workspaceId: 7,
                    kind: 'strain',
                    name: 'Related imported strain',
                    fields: { genotypeCanonical: 'recA1' },
                  },
            links:
              affected === 'link'
                ? [
                    {
                      type: 'associated_with',
                      toEntityId: primerId,
                      payload: { retained: 'batch relationship' },
                    },
                  ]
                : [],
            source: { fileName: 'retained.csv' },
          },
        ],
      });
      const primer = queryLimsEntitiesInDb(host.db!, { id: primerId, includeArchived: true })[0];

      host
        .db!.prepare(
          `INSERT INTO org_registry_local_records
        (org_id,account_id,entity_id,client_id,workspace_id,workspace_uuid,home_workspace_id,
        kind,local_schema_revision_id,authority_kind,schema_id,schema_revision_id,
        claim_mutation_id,claim_source_revision,claim_local_event_seq,created_at,updated_at)
        VALUES(?,?,?,?,7,?,?,'oligo',?,'primer_artifact',?,?,?,?,?,1,1)`
        )
        .run(
          randomUUID(),
          randomUUID(),
          primerId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          primer.schemaRevisionId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          primer.eventSeq
        );
      const primerBytes = serializePrimerArtifact(
        await buildPrimerArtifact({
          id: primerId,
          catalogNumber: 'P001',
          name: 'Enrolled primer',
          sequence: 'ACGTACGTACGT',
          workspaceRoot: join(root, 'one'),
          artifactPath: primerPath,
          source: 'manual',
          now: 100,
        })
      );
      await writeFile(primerPath, primerBytes);
      const before = snapshot();
      const links = host.db!.prepare('SELECT * FROM lims_link ORDER BY id').all();
      const originalBytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
      await expect(undo(ownBatch)).rejects.toThrow(
        /registered with an organization|requires its owning native document operation/
      );
      expect(snapshot()).toBe(before);
      expect(host.db!.prepare('SELECT * FROM lims_link ORDER BY id').all()).toEqual(links);
      expect(await readFile(primerPath, 'utf8')).toBe(primerBytes);
      expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(originalBytes);
      expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
    }
  );

  it('publishes archived state to every imported generic file across project owners', async () => {
    expect(await undo()).toMatchObject({ tombstonedEntities: 2 });
    for (const path of paths)
      expect(parseEntityArtifact(await readFile(path, 'utf8'))).toMatchObject({
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        archived: true,
      });
    expect(rows().every((row) => row.tombstone)).toBe(true);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('refuses an edited record before changing any file, projection or history', async () => {
    updateLimsEntityInDb(host.db!, { id: ids[1], name: 'Changed after import' });
    const before = snapshot();
    const bytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    await expect(undo()).rejects.toThrow(/registry\.undoChanged/);
    expect(snapshot()).toBe(before);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(bytes);
  });

  it('refuses a competing edit in the second file without archiving the first record', async () => {
    const external = serializeEntityArtifact({
      ...parseEntityArtifact(await readFile(paths[1], 'utf8')),
      name: 'External edit',
    });
    await writeFile(paths[1], external);
    const before = snapshot();
    const bytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    await expect(undo()).rejects.toThrow(/disagree|changed|conflict/);
    expect(snapshot()).toBe(before);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(bytes);
  });

  it('refuses a non-writable second owner before modifying the batch', async () => {
    host.db!.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=8").run();
    const before = snapshot();
    const bytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    await expect(undo()).rejects.toThrow(/writable|project/);
    expect(snapshot()).toBe(before);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(bytes);
  });

  it('rolls back the entire batch if recording its second durable publication intent fails', async () => {
    host.db!
      .exec(`CREATE TRIGGER fail_second_undo_intent BEFORE INSERT ON native_catalog_publication_outbox
      WHEN NEW.workspace_id=8 BEGIN SELECT RAISE(ABORT,'second publication intent failed'); END`);
    const before = snapshot();
    const bytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    await expect(undo()).rejects.toThrow('second publication intent failed');
    expect(snapshot()).toBe(before);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(bytes);
  });

  it('resumes an interrupted second publication while preserving a later edit to the completed first file', async () => {
    const publish = publication.publishNativeCatalogBytes;
    vi.spyOn(publication, 'publishNativeCatalogBytes')
      .mockImplementationOnce(publish)
      .mockRejectedValueOnce(new Error('interrupted second publication'));
    await expect(undo()).rejects.toThrow('interrupted second publication');
    expect(rows().every((row) => row.tombstone)).toBe(true);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(1);
    const later = serializeEntityArtifact({
      ...parseEntityArtifact(await readFile(paths[0], 'utf8')),
      name: 'Later saved name',
    });
    await writeFile(paths[0], later);
    expect(await undo()).toMatchObject({ tombstonedEntities: 2 });
    expect(await readFile(paths[0], 'utf8')).toBe(later);
    expect(parseEntityArtifact(await readFile(paths[1], 'utf8'))).toMatchObject({
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      archived: true,
    });
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});

const organizationScope = {
  orgId: '10000000-0000-4000-8000-000000000072',
  accountId: '20000000-0000-4000-8000-000000000072',
  clientId: 'desktop:import-undo-publication',
};
const accessGeneration = `home-v1:${'8'.repeat(64)}`;
const registeredHomes = [
  '30000000-0000-4000-8000-000000000071',
  '30000000-0000-4000-8000-000000000072',
];
const remoteHomes = [
  '40000000-0000-4000-8000-000000000071',
  '40000000-0000-4000-8000-000000000072',
];
const bytesSha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const registeredPublications = () =>
  host
    .db!.prepare(
      'SELECT mutation_id,operation_id,entity_id,local_event_seq,publication_authority,publication_sha256,payload_json,status FROM org_registry_record_publications ORDER BY entity_id'
    )
    .all() as Array<{
    mutation_id: string;
    operation_id: string;
    entity_id: string;
    local_event_seq: number;
    publication_authority: string;
    publication_sha256: string;
    payload_json: string;
    status: string;
  }>;

async function enrollImportedRecords() {
  const db = host.db!;
  host.accountId = organizationScope.accountId;
  const records = rows();
  const canonical = records.map((entity, index) => ({
    id: entity.id,
    orgId: organizationScope.orgId,
    kind: entity.kind,
    homeWorkspaceId: remoteHomes[index],
    schemaId: '50000000-0000-4000-8000-000000000072',
    schemaRevisionId: '60000000-0000-4000-8000-000000000072',
    name: entity.name,
    fields: entity.fields,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    archivedAt: null,
    revision: 1,
  }));
  replaceOrgRegistrySnapshot(db, {
    ...organizationScope,
    cursor: 2,
    accessGeneration,
    now: 1,
    snapshot: {
      idSchemes: [],
      schemas: [],
      schemaRevisions: [],
      entities: canonical,
      entityRevisions: [],
      relationships: [],
      placements: [],
    },
  });
  for (const [index, entity] of records.entries()) {
    const workspaceId = 7 + index;
    db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?').run(
      registeredHomes[index],
      workspaceId
    );
    db.prepare(
      `INSERT INTO workspace_sync_bindings
      (workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role,created_at,updated_at)
      VALUES(?,?,?,?,?,0,'editor',1,1)`
    ).run(
      workspaceId,
      registeredHomes[index],
      organizationScope.accountId,
      organizationScope.orgId,
      remoteHomes[index]
    );
    const mutationId = crypto.randomUUID();
    const {
      orgId: _orgId,
      revision: _revision,
      archivedAt: _archivedAt,
      ...payload
    } = canonical[index];
    const sourceRevision = bytesSha256(await readFile(paths[index], 'utf8'));
    db.transaction(() => {
      enrollOrgRegistryRecordInTx(db, {
        ...organizationScope,
        mutationId,
        now: 1,
        claim: {
          mutationId,
          sourceEntityId: entity.id,
          sourceRegistryId: entity.registryId,
          sourceRevision,
          homeWorkspaceId: remoteHomes[index],
          homeProjectUuid: registeredHomes[index],
          homeProjectName: `Owned project ${index + 1}`,
          payload,
        },
      });
      enqueueOrgRegistryMutation(db, {
        ...organizationScope,
        mutationId,
        operation: 'entity.create',
        payload,
        now: 1,
      });
    })();
    acknowledgeOrgRegistryMutation(db, {
      ...organizationScope,
      mutationId,
      now: 2,
      receipt: {
        status: 'applied',
        eventSeq: index + 1,
        mutationId,
        accessGeneration,
        entityId: entity.id,
        homeWorkspaceId: remoteHomes[index],
        entity: canonical[index],
      },
    });
  }
  expect(readPendingOrgRegistryMutations(db, organizationScope)).toEqual([]);
}

describe('registered imported files keep per-owner publication readiness', () => {
  it('keeps interrupted import Undo unsendable per file and releases both exact archived intents on Retry', async () => {
    await enrollImportedRecords();
    const beforeBytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    const publish = publication.publishNativeCatalogBytes;
    vi.spyOn(publication, 'publishNativeCatalogBytes')
      .mockImplementationOnce(publish)
      .mockRejectedValueOnce(new Error('Interrupted registered import Undo'));
    await expect(undo()).rejects.toThrow('Interrupted registered import Undo');
    expect(rows().every((row) => row.tombstone)).toBe(true);
    expect(parseEntityArtifact(await readFile(paths[0], 'utf8'))).toMatchObject({
      id: ids[0],
      archived: true,
    });
    expect(await readFile(paths[1], 'utf8')).toBe(beforeBytes[1]);
    const interrupted = registeredPublications();
    expect(interrupted).toHaveLength(2);
    expect(interrupted.map((row) => ({ id: row.entity_id, status: row.status }))).toEqual([
      { id: ids[0], status: 'ready' },
      { id: ids[1], status: 'publication_pending' },
    ]);
    for (const [index, intent] of interrupted.entries()) {
      expect(JSON.parse(intent.payload_json)).toMatchObject({
        id: ids[index],
        name: `Imported strain ${index + 1}`,
        archived: true,
        fields: { genotypeCanonical: 'recA1' },
      });
      const planned = host
        .db!.prepare(
          "SELECT payload FROM lims_audit WHERE operation_id=? AND event_type='entity_artifact_publication_required'"
        )
        .get(intent.operation_id) as { payload: string };
      const afterBytes = (JSON.parse(planned.payload) as { afterBytes: string }).afterBytes;
      expect(intent.publication_sha256).toBe(bytesSha256(afterBytes));
      expect(intent.publication_authority).toBe('entity_artifact');
    }
    expect(readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: 5 })).toEqual(
      [
        {
          clientId: organizationScope.clientId,
          mutationId: interrupted[0].mutation_id,
          operation: 'entity.archive',
          payload: { id: ids[0], expectedRevision: 1 },
        },
      ]
    );
    expect(readPendingOrgRegistryMutations(host.db!, organizationScope)).toEqual([]);
    expect(await undo()).toMatchObject({ tombstonedEntities: 2 });
    const savedBytes = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    const completed = registeredPublications();
    expect(completed).toEqual(interrupted.map((row) => ({ ...row, status: 'ready' })));
    for (const [index, intent] of completed.entries()) {
      const saved = parseEntityArtifact(savedBytes[index]);
      expect(saved).toMatchObject({ id: ids[index], archived: true });
      expect(rows()[index]).toMatchObject({
        id: ids[index],
        workspaceId: 7 + index,
        tombstone: true,
      });
      expect(intent.publication_sha256).toBe(bytesSha256(savedBytes[index]));
      expect(JSON.parse(intent.payload_json)).toEqual({
        id: saved.id,
        name: saved.name,
        fields: saved.fields,
        registrationStatus: saved.registrationStatus,
        domainStatus: saved.domainStatus,
        archived: true,
      });
    }
    expect(readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: 6 })).toEqual(
      completed.map((intent) => ({
        clientId: organizationScope.clientId,
        mutationId: intent.mutation_id,
        operation: 'entity.archive',
        payload: { id: intent.entity_id, expectedRevision: 1 },
      }))
    );
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    const settled = snapshot();
    expect(await undo()).toMatchObject({ tombstonedEntities: 2 });
    expect(snapshot()).toBe(settled);
    expect(registeredPublications()).toEqual(completed);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(savedBytes);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});
