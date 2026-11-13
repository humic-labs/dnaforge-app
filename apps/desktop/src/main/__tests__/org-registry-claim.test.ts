import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../org-registry-sync-client', () => ({
  createOrganizationRegistryClient: vi.fn(),
}));
vi.mock('../auth/session-store', () => ({ getActiveStoredSession: vi.fn() }));
vi.mock('../org-registry-sync-worker', () => ({
  syncOrganizationRegistry: vi.fn(),
}));

import { createTestDb, openFileTestDb } from './test-db';
import * as nativePublication from '../native-catalog-publication';
import { ensureSchema } from '../schema';
import {
  seedLimsBuiltinsInDb,
  registerLimsEntityInsideTx,
  updateLimsEntityInsideTx,
} from '../lims-engine-core';
import { registrySchemaSnapshotForEntity } from '../lims-registry-projection';
import { readCheckedPrimerArtifactSnapshot } from '../primer-artifact-reader';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import {
  buildPrimerArtifact,
  parsePrimerArtifact,
  revisePrimerArtifactContent,
  serializePrimerArtifact,
} from '../../shared/primers/primer-artifact';
import { primerArtifactRegistryProjection } from '../../shared/primers/primer-artifact-projection';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  serializeEntityArtifact,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import { prepareOrganizationRegistryClaimInDb } from '../org-registry-claim';
import { readCheckedOrganizationRecordReview } from '../org-registry-record-review';
import { resolveSavedOrganizationRecord } from '../org-registry-record-resolution';
import {
  enrollOrgRegistryRecordInTx,
  orgRegistryRecordPublicationAuthority,
  readReadyOrgRegistryRecordMutations,
} from '../org-registry-record-sync';
import { limsEntityFromRow, type LimsEntityRow } from '../../shared/lims';
import { projectManagedSequenceRegistry } from '../../shared/managed-sequence-registry-projection';
import { readSequenceProductSummary } from '../../db/entity-substrate/sequence-product-summary-runtime';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../../shared/managed-sequence-document';
import {
  buildSequencePackageDocument,
  fromPackageRelative,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { prepareSequencePackageRevision } from '../../db/sequence-package-versioning';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import { createOrganizationRegistryActionHandlers } from '../org-registry-actions';
import {
  acknowledgeOrgRegistryMutation,
  enqueueOrgRegistryMutation,
  failOrgRegistryMutation,
  invalidateOrgRegistryAccess,
  readPendingOrgRegistryMutations,
  replaceOrgRegistrySnapshot,
} from '../org-registry-sync-cache';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { getActiveStoredSession, type StoredSession } from '../auth/session-store';
import type { OrganizationRegistryClient } from '../org-registry-sync-client';

const ORG = '20000000-0000-4000-8000-000000000001';
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const HOME = '30000000-0000-4000-8000-000000000001';
const REMOTE = '40000000-0000-4000-8000-000000000001';
const ENTITY = '50000000-0000-4000-8000-000000000001';
const SCHEMA = '60000000-0000-4000-8000-000000000001';
const REVISION = '70000000-0000-4000-8000-000000000001';
const GENERATION = `home-v1:${'a'.repeat(64)}`;
const context = { orgId: ORG, accountId: ACCOUNT, clientId: 'desktop:test' };
const request = {
  entityId: ENTITY,
  schemaId: SCHEMA,
  schemaRevisionId: REVISION,
};
const schema = {
  id: SCHEMA,
  currentRevisionId: REVISION,
  name: 'oligo',
  baseKind: 'oligo',
};
const ready = {
  status: 'ready' as const,
  cursor: 2,
  pendingCount: 0,
  conflictCount: 0,
};
let db: Database.Database;
let directory: string;

function snapshot(entities: Record<string, unknown>[] = [], cursor = 1): void {
  replaceOrgRegistrySnapshot(db, {
    ...context,
    cursor,
    accessGeneration: GENERATION,
    now: 1,
    snapshot: {
      idSchemes: [],
      schemas: [schema],
      schemaRevisions: [],
      entities,
      entityRevisions: [],
      relationships: [],
      placements: [],
    },
  });
}

beforeEach(() => {
  vi.mocked(getActiveStoredSession).mockResolvedValue({ accountId: ACCOUNT } as StoredSession);
  directory = mkdtempSync(join(tmpdir(), 'fixture-home-'));
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,?,?,?,1)').run(
    'Renamed original home',
    directory,
    HOME
  );
  db.prepare(
    `INSERT INTO workspace_sync_bindings
    (workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role,created_at,updated_at)
    VALUES(1,?,?,?,?,0,'editor',1,1)`
  ).run(HOME, ACCOUNT, ORG, REMOTE);
  seedLimsBuiltinsInDb(db);
  db.transaction(() =>
    registerLimsEntityInsideTx(db, {
      id: ENTITY,
      kind: 'oligo',
      name: 'Saved primer',
      workspaceId: 1,
      fields: {
        sequence: {
          mode: 'inline',
          bases: 'GTAAAACGACGGCCAGT',
          length: 17,
          topology: 'linear',
        },
        use: 'primer',
      },
    })
  )();
  snapshot();
});

afterEach(() => {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

function saveMatchingEntityArtifact() {
  const relativePath = 'records/saved.entity.json';
  const path = join(directory, relativePath);
  mkdirSync(join(directory, 'records'));
  const entity = db.transaction(() =>
    updateLimsEntityInsideTx(db, {
      id: ENTITY,
      fields: {
        artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath },
      },
    })
  )();
  const doc: EntityArtifactV2 = {
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    schemaRevisionId: entity.schemaRevisionId,
    schemaSnapshot: registrySchemaSnapshotForEntity(db, entity),
    archived: entity.tombstone,
    fields: entity.fields,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    relationships: [],
    source: { type: 'manual', values: {} },
  };
  const bytes = serializeEntityArtifact(doc);
  writeFileSync(path, bytes);
  return { path, bytes, doc };
}

describe('trusted saved-record organization registration', () => {
  it('keeps entity and home identity without enabling an existing disabled binding', async () => {
    const before = db.prepare('SELECT * FROM workspace_sync_bindings').all();
    const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);
    expect(claim).toMatchObject({
      sourceEntityId: ENTITY,
      homeWorkspaceId: REMOTE,
      homeProjectUuid: HOME,
      homeProjectName: 'Renamed original home',
      payload: { id: ENTITY, homeWorkspaceId: REMOTE, schemaId: SCHEMA },
    });
    expect(db.prepare('SELECT * FROM workspace_sync_bindings').all()).toEqual(before);
  });

  it.each([
    ['DELETE FROM workspace_sync_bindings', /existing organization home/],
    ['UPDATE lims_entity SET workspace_id=NULL', /verified home project/],
    ['UPDATE workspaces SET archived_at=2', /active home project/],
    ["UPDATE workspace_sync_bindings SET access_role='viewer'", /write access/],
    ["UPDATE workspace_sync_bindings SET detached_reason='access_removed'", /write access/],
    [
      "UPDATE workspace_sync_bindings SET owner_account_id='someone-else'",
      /existing organization home/,
    ],
  ])('refuses unresolved or unauthorized home: %s', async (sql, expected) => {
    db.exec(sql);
    await expect(async () =>
      prepareOrganizationRegistryClaimInDb(db, context, request)
    ).rejects.toThrow(expected);
    expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);
  });

  it('prepares a matching saved entity artifact without changing its bytes or audited projection', async () => {
    const saved = saveMatchingEntityArtifact();
    const before = {
      entity: db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY),
      history: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      binding: db.prepare('SELECT * FROM workspace_sync_bindings').all(),
    };
    const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);
    expect(claim).toMatchObject({
      sourceEntityId: ENTITY,
      homeWorkspaceId: REMOTE,
      homeProjectUuid: HOME,
      payload: { id: ENTITY, name: saved.doc.name, fields: saved.doc.fields },
    });
    expect(readFileSync(saved.path, 'utf8')).toBe(saved.bytes);
    expect({
      entity: db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY),
      history: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      binding: db.prepare('SELECT * FROM workspace_sync_bindings').all(),
    }).toEqual(before);
    expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM org_registry_mutation_receipts').all()).toHaveLength(0);
  });

  it('refuses old confirmation after only saved bytes change, preserving the external file and empty queue', async () => {
    const saved = saveMatchingEntityArtifact();
    const before = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY);
    const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);

    const externalBytes = `${saved.bytes}\n`;
    writeFileSync(saved.path, externalBytes);
    const sync = vi.fn(async () => ready);
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as StoredSession,
      getDeviceId: () => 'test',
      client: {} as OrganizationRegistryClient,
      sync,
    });
    expect(
      await actions.claimOrganizationRegistryEntity(ORG, {
        ...request,
        mutationId: claim.mutationId,
        sourceRevision: claim.sourceRevision,
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('another review'),
    });
    expect(sync).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM org_registry_mutation_receipts').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY)).toEqual(before);
    expect(readFileSync(saved.path, 'utf8')).toBe(externalBytes);
  });

  it.each(['name', 'archived'] as const)(
    'refuses an initially divergent saved %s without rewriting either version',
    async (field) => {
      const saved = saveMatchingEntityArtifact();
      const before = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY);
      const externalBytes = serializeEntityArtifact({
        ...saved.doc,
        ...(field === 'name' ? { name: 'External saved name' } : { archived: true }),
      });
      writeFileSync(saved.path, externalBytes);
      await expect(async () =>
        prepareOrganizationRegistryClaimInDb(db, context, request)
      ).rejects.toThrow(/file and projection disagree/);
      expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM org_registry_mutation_receipts').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY)).toEqual(before);
      expect(readFileSync(saved.path, 'utf8')).toBe(externalBytes);
    }
  );

  it.each(['prepare', 'confirm'] as const)(
    'refuses %s when the active account changes across the saved-file read',
    async (action) => {
      const saved = saveMatchingEntityArtifact();
      const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);
      let sessionReads = 0;
      const sync = vi.fn(async () => ready);
      const actions = createOrganizationRegistryActionHandlers(db, {
        getActiveSession: async () =>
          ({
            accountId: ++sessionReads === 1 ? ACCOUNT : 'another-account',
          }) as StoredSession,
        getDeviceId: () => 'test',
        client: {} as OrganizationRegistryClient,
        sync,
      });
      const result =
        action === 'prepare'
          ? await actions.prepareOrganizationRegistryClaim(ORG, request)
          : await actions.claimOrganizationRegistryEntity(ORG, {
              ...request,
              mutationId: claim.mutationId,
              sourceRevision: claim.sourceRevision,
            });
      expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(sync).not.toHaveBeenCalled();
      expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM org_registry_mutation_receipts').all()).toHaveLength(0);
      expect(readFileSync(saved.path, 'utf8')).toBe(saved.bytes);
    }
  );

  it.each(['primer artifact', 'native catalog record'] as const)(
    'refuses Claim for an unsupported %s publication owner without enrollment or enqueue',
    async (source) => {
      if (source === 'primer artifact')
        db.transaction(() =>
          updateLimsEntityInsideTx(db, {
            id: ENTITY,
            fields: {
              artifact: {
                schema: 'waypoint.primer.v3',
                relativePath: 'primers/saved.primer.json',
              },
            },
          })
        )();
      else {
        db.prepare(
          `INSERT INTO catalog_entities
          (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
          VALUES(?,'record','Native record',?,'database','active',1,1,1)`
        ).run(ENTITY, `record:${ENTITY}`);
        db.prepare(
          `INSERT INTO catalog_workspace_placements
          (entity_id,workspace_id,parent_relative_path,display_name,normalized_sibling_name,presentation_kind,status,created_at,updated_at)
          VALUES(?,1,'','Native record','native record','record','active',1,1)`
        ).run(ENTITY);
      }
      const before = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY);
      await expect(prepareOrganizationRegistryClaimInDb(db, context, request)).rejects.toThrow(
        /This saved document type cannot yet stay synchronized/
      );
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY)).toEqual(before);
      expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toEqual([]);
    }
  );

  it('rejects changes after review before durable enqueue', async () => {
    const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);
    db.prepare("UPDATE lims_entity SET name='Changed since review' WHERE id=?").run(ENTITY);
    const sync = vi.fn(async () => ready);
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as StoredSession,
      getDeviceId: () => 'test',
      client: {} as OrganizationRegistryClient,
      sync,
    });
    expect(
      await actions.claimOrganizationRegistryEntity(ORG, {
        ...request,
        mutationId: claim.mutationId,
        sourceRevision: claim.sourceRevision,
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('another review'),
    });
    expect(sync).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);
  });

  it('does not report a rejected mutation as registered when general sync is ready', async () => {
    const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as StoredSession,
      getDeviceId: () => 'test',
      client: {} as OrganizationRegistryClient,
      sync: async () => {
        failOrgRegistryMutation(db, {
          mutationId: claim.mutationId,
          code: 'FORBIDDEN',
          message: 'Home write access removed.',
          now: 2,
        });
        return ready;
      },
    });
    expect(
      await actions.claimOrganizationRegistryEntity(ORG, {
        ...request,
        mutationId: claim.mutationId,
        sourceRevision: claim.sourceRevision,
      })
    ).toMatchObject({ ok: false, message: 'Home write access removed.' });
  });

  it('requires the exact durable receipt and canonical identity before reporting registered', async () => {
    const claim = await prepareOrganizationRegistryClaimInDb(db, context, request);
    let accept = false;
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId: ACCOUNT }) as StoredSession,
      getDeviceId: () => 'test',
      client: {} as OrganizationRegistryClient,
      sync: async () => {
        if (accept) {
          const pending = readPendingOrgRegistryMutations(db, {
            ...context,
            now: Date.now(),
          });
          if (pending.length)
            acknowledgeOrgRegistryMutation(db, {
              ...context,
              mutationId: claim.mutationId,
              now: 2,
              receipt: {
                status: 'applied',
                mutationId: claim.mutationId,
                eventSeq: 2,
                accessGeneration: GENERATION,
                entityId: ENTITY,
                homeWorkspaceId: REMOTE,
                entity: {
                  ...claim.payload,
                  orgId: ORG,
                  registryId: 'ORG000001',
                  revision: 1,
                  archivedAt: null,
                },
              },
            });
          snapshot(
            [
              {
                ...claim.payload,
                orgId: ORG,
                registryId: 'ORG000001',
                revision: 1,
                archivedAt: null,
              },
            ],
            2
          );
        }
        return ready;
      },
    });
    const submit = {
      ...request,
      mutationId: claim.mutationId,
      sourceRevision: claim.sourceRevision,
    };
    expect(await actions.claimOrganizationRegistryEntity(ORG, submit)).toMatchObject({
      ok: true,
      registration: 'queued',
    });
    accept = true;
    expect(await actions.claimOrganizationRegistryEntity(ORG, submit)).toMatchObject({
      ok: true,
      registration: 'registered',
    });
    expect(await actions.claimOrganizationRegistryEntity(ORG, submit)).toMatchObject({
      ok: true,
      registration: 'registered',
    });
    expect(db.prepare('SELECT * FROM org_registry_mutation_receipts').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toHaveLength(0);

    const hasBindingOwner = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_registry_local_records'"
      )
      .get();
    const bindings = hasBindingOwner
      ? db
          .prepare(
            `SELECT org_id,account_id,entity_id,home_workspace_id,
      schema_id,schema_revision_id,acknowledged_mutation_id FROM org_registry_local_records`
          )
          .all()
      : [];
    expect(bindings).toEqual([
      {
        org_id: ORG,
        account_id: ACCOUNT,
        entity_id: ENTITY,
        home_workspace_id: REMOTE,
        schema_id: SCHEMA,
        schema_revision_id: REVISION,
        acknowledged_mutation_id: claim.mutationId,
      },
    ]);
  });

  it('does not deliver the previous account’s Registry after an account switch during sync', async () => {
    let accountId = ACCOUNT;
    const actions = createOrganizationRegistryActionHandlers(db, {
      getActiveSession: async () => ({ accountId }) as StoredSession,
      getDeviceId: () => 'test',
      client: {} as OrganizationRegistryClient,
      sync: async () => {
        accountId = 'another-account';
        return ready;
      },
    });
    expect(await actions.syncOrganizationRegistry(ORG)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });
});

describe('organization Registry Details and verified local availability', () => {
  const recordId = '50000000-0000-4000-8000-000000000002';
  const detailsRequest = {
    entityId: recordId,
    expectedAccessGeneration: GENERATION,
  };

  function seedPreviewRecord(save = true) {
    const relativePath = 'records/strain.entity.json';
    const entity = db.transaction(() =>
      registerLimsEntityInsideTx(db, {
        id: recordId,
        kind: 'strain',
        name: 'Local saved strain',
        workspaceId: 1,
        fields: {
          species: 'Escherichia coli',
          genotypeCanonical: 'wt',
          ...(save
            ? {
                artifact: {
                  schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
                  relativePath,
                },
              }
            : {}),
        },
      })
    )();
    const doc: EntityArtifactV2 = {
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      schemaRevisionId: entity.schemaRevisionId,
      schemaSnapshot: registrySchemaSnapshotForEntity(db, entity),
      archived: entity.tombstone,
      fields: entity.fields,
      registrationStatus: entity.registrationStatus,
      domainStatus: entity.domainStatus,
      relationships: [],
      source: { type: 'manual', values: {} },
    };
    const bytes = serializeEntityArtifact(doc);
    const path = join(directory, relativePath);
    if (save) {
      mkdirSync(join(directory, 'records'), { recursive: true });
      writeFileSync(path, bytes);
    }
    const remoteEntity = {
      id: recordId,
      orgId: ORG,
      homeWorkspaceId: REMOTE,
      schemaId: SCHEMA,
      schemaRevisionId: REVISION,
      kind: 'strain',
      name: 'Canonical registered strain',
      fields: { species: 'Organization fields remain distinct' },
      registryId: 'ORG000002',
      revision: 2,
      archivedAt: null,
    };
    replaceOrgRegistrySnapshot(db, {
      ...context,
      cursor: 5,
      accessGeneration: GENERATION,
      now: 1,
      snapshot: {
        idSchemes: [],
        schemas: [
          {
            id: SCHEMA,
            orgId: ORG,
            name: 'strain',
            baseKind: 'strain',
            currentRevisionId: REVISION,
          },
        ],
        schemaRevisions: [
          {
            id: REVISION,
            orgId: ORG,
            schemaId: SCHEMA,
            version: 1,
            fields: [],
          },
        ],
        entities: [remoteEntity],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
    return { doc, bytes, path, remoteEntity };
  }

  function previewActions(
    getActiveSession = async () => ({ accountId: ACCOUNT }) as StoredSession
  ) {
    return createOrganizationRegistryActionHandlers(db, {
      getActiveSession,
      getDeviceId: () => {
        throw new Error('A read must not create a device binding.');
      },
      client: {} as OrganizationRegistryClient,
      sync: async () => {
        throw new Error('A Details read must not synchronize or publish.');
      },
    });
  }

  function localRows() {
    return {
      entities: db.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      homes: db.prepare('SELECT * FROM workspace_sync_bindings ORDER BY workspace_id').all(),
      files: db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all(),
      settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
      outbox: db.prepare('SELECT * FROM org_registry_outbox ORDER BY mutation_id').all(),
    };
  }

  it('keeps canonical organization fields separate while verifying the same saved UUID/home for a viewer with file sync disabled', async () => {
    const saved = seedPreviewRecord();
    db.prepare("UPDATE workspace_sync_bindings SET access_role='viewer',enabled=0").run();
    const before = localRows();
    const result = await previewActions().getOrganizationRegistryRecordDetails(ORG, detailsRequest);
    expect(result).toMatchObject({
      ok: true,
      details: {
        scope: {
          accountId: ACCOUNT,
          orgId: ORG,
          accessGeneration: GENERATION,
          cursor: 5,
        },
        entity: saved.remoteEntity,
        schemaRevision: { id: REVISION },
        local: {
          status: 'available',
          workspaceId: 1,
          workspaceUuid: HOME,
          homeWorkspaceId: REMOTE,
          summary: {
            id: recordId,
            name: saved.doc.name,
            representation: {
              canOpen: true,
              openTarget: { kind: 'record_file', entityId: recordId },
            },
          },
        },
      },
    });
    expect(localRows()).toEqual(before);
    expect(readFileSync(saved.path, 'utf8')).toBe(saved.bytes);
  });

  it.each([
    ['DELETE FROM workspace_sync_bindings', 'home_mismatch'],
    ["UPDATE workspace_sync_bindings SET owner_account_id='different-account'", 'home_mismatch'],
    ["UPDATE workspace_sync_bindings SET owner_org_id='different-org'", 'home_mismatch'],
    [
      "UPDATE workspace_sync_bindings SET remote_workspace_id='40000000-0000-4000-8000-000000000099'",
      'home_mismatch',
    ],
    ["UPDATE workspace_sync_bindings SET detached_reason='access_removed'", 'home_mismatch'],
    ['UPDATE workspaces SET trashed_at=2', 'project_unavailable'],
  ])(
    'does not offer another local authority as this organization record: %s',
    async (sql, reason) => {
      const saved = seedPreviewRecord();
      db.exec(sql);
      const before = localRows();
      expect(
        await previewActions().getOrganizationRegistryRecordDetails(ORG, detailsRequest)
      ).toMatchObject({
        ok: true,
        details: {
          entity: saved.remoteEntity,
          local: { status: 'unavailable', reason },
        },
      });
      expect(localRows()).toEqual(before);
      expect(readFileSync(saved.path, 'utf8')).toBe(saved.bytes);
    }
  );

  it('keeps a metadata-only local record in Details without offering Open', async () => {
    seedPreviewRecord(false);
    expect(
      await previewActions().getOrganizationRegistryRecordDetails(ORG, detailsRequest)
    ).toMatchObject({
      ok: true,
      details: {
        local: { status: 'unavailable', reason: 'no_saved_document' },
      },
    });
  });

  it('withholds Open after a saved file changes without reconciling or replacing either version', async () => {
    const saved = seedPreviewRecord();
    const external = serializeEntityArtifact({
      ...saved.doc,
      name: 'Externally changed',
    });
    writeFileSync(saved.path, external);
    const before = localRows();
    expect(
      await previewActions().getOrganizationRegistryRecordDetails(ORG, detailsRequest)
    ).toMatchObject({
      ok: true,
      details: {
        entity: saved.remoteEntity,
        local: { status: 'unavailable', reason: 'source_unavailable' },
      },
    });
    expect(localRows()).toEqual(before);
    expect(readFileSync(saved.path, 'utf8')).toBe(external);
  });

  it('does not return Details across an account change', async () => {
    seedPreviewRecord();
    let reads = 0;
    const actions = previewActions(
      async () =>
        ({
          accountId: ++reads < 3 ? ACCOUNT : 'changed-account',
        }) as StoredSession
    );
    expect(await actions.getOrganizationRegistryRecordDetails(ORG, detailsRequest)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('rechecks access after waiting for the owning project lease', async () => {
    seedPreviewRecord();
    const release = await acquireWorkspaceSyncMutationLease(directory);
    const result = previewActions().getOrganizationRegistryRecordDetails(ORG, detailsRequest);
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(directory)).toBe(1));
      invalidateOrgRegistryAccess(db, { ...context, now: 2 });
    } finally {
      release();
    }
    expect(await result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('read-only saved primer authority preparation', () => {
  async function saveMatchingPrimerArtifact() {
    const relativePath = 'primers/saved.primer.json';
    const path = join(directory, relativePath);
    const artifact = await buildPrimerArtifact({
      id: ENTITY,
      catalogNumber: 'PR-000001',
      name: 'Saved primer',
      sequence: 'GTAAAACGACGGCCAGT',
      workspaceRoot: directory,
      artifactPath: path,
      source: 'manual',
      now: 1_700_000_000_000,
    });
    const canonical = serializePrimerArtifact(artifact);
    const normalizedDigest = createHash('sha256').update(canonical).digest('hex');
    const projection = primerArtifactRegistryProjection(
      artifact,
      {
        mode: 'inline',
        bases: artifact.sequence.bases,
        topology: 'linear',
        length: artifact.sequence.length,
        contentHash: `sha256:${artifact.sequence.contentHash}`,
      },
      normalizedDigest
    );
    const entity = db.transaction(() =>
      updateLimsEntityInsideTx(db, {
        id: ENTITY,
        name: artifact.name,
        ...projection,
        replaceFields: true,
      })
    )();
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
      VALUES(?,'primer',?,?,'file','active',1,1,1)`
    ).run(ENTITY, artifact.name, `waypoint://primer/${ENTITY}`);
    mkdirSync(join(directory, 'primers'));

    const bytes = `${JSON.stringify(artifact, null, 4)}\n`;
    writeFileSync(path, bytes);
    bindCatalogEntityFileInDb(db, {
      entityId: ENTITY,
      path,
      workspaceRoot: directory,
      fileKind: 'primer-artifact',
      contentHash: `sha256:${normalizedDigest}`,
    });
    return { path, bytes, artifact, entity, normalizedDigest };
  }

  it('reads the canonical primer with separate exact bytes and normalized projection digests without writes', async () => {
    const saved = await saveMatchingPrimerArtifact();
    const before = {
      audit: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      catalog: db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all(),
      entity: db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY),
    };
    const checked = await readCheckedPrimerArtifactSnapshot({
      db,
      runDatabase: (work) => work(),
      entityId: ENTITY,
    });
    expect(checked.current.id).toBe(ENTITY);
    expect(checked.owner).toMatchObject({
      workspaceId: 1,
      workspacePath: directory,
      relativePath: 'primers/saved.primer.json',
    });
    expect(checked.before).toEqual(saved.artifact);
    expect(checked.beforeBytes.toString('utf8')).toBe(saved.bytes);
    expect(checked.sha256).toBe(createHash('sha256').update(saved.bytes).digest('hex'));
    expect(checked.artifactContentHash).toBe(saved.normalizedDigest);
    expect(checked.sha256).not.toBe(checked.artifactContentHash);
    expect({
      audit: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      catalog: db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all(),
      entity: db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY),
    }).toEqual(before);
  });

  it('preserves changed saved bytes and the current projection instead of reconciling them during review', async () => {
    const saved = await saveMatchingPrimerArtifact();
    const changed = serializePrimerArtifact({ ...saved.artifact, name: 'Changed on disk' });
    writeFileSync(saved.path, changed);
    const before = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY);
    const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    await expect(
      readCheckedPrimerArtifactSnapshot({ db, runDatabase: (work) => work(), entityId: ENTITY })
    ).rejects.toThrow('Primer file and projection disagree');
    expect(readFileSync(saved.path, 'utf8')).toBe(changed);
    expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(ENTITY)).toEqual(before);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
  });

  it('refuses an unfinished owning publication without running recovery', async () => {
    const saved = await saveMatchingPrimerArtifact();
    db.prepare(
      'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) VALUES(?,1)'
    ).run('interrupted-primer-review');
    const journal = db.prepare('SELECT * FROM native_catalog_publication_outbox').all();
    await expect(
      readCheckedPrimerArtifactSnapshot({ db, runDatabase: (work) => work(), entityId: ENTITY })
    ).rejects.toThrow('unfinished publication');
    expect(db.prepare('SELECT * FROM native_catalog_publication_outbox').all()).toEqual(journal);
    expect(readFileSync(saved.path, 'utf8')).toBe(saved.bytes);
  });
});

const specializedSha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

async function savedSpecializedRecord(type: 'primer' | 'sequence') {
  const entityId =
    type === 'primer'
      ? '50000000-0000-4000-8000-000000000002'
      : '50000000-0000-4000-8000-000000000003';
  let path: string;
  let bytes: string;
  let productPath: string | null = null;
  let productBytes: string | null = null;
  if (type === 'primer') {
    path = join(directory, 'primers', 'saved.primer.json');
    mkdirSync(dirname(path), { recursive: true });
    const artifact = await buildPrimerArtifact({
      id: entityId,
      catalogNumber: 'P002',
      name: 'Saved primer file',
      sequence: 'GTAAAACGACGGCCAGT',
      workspaceRoot: directory,
      artifactPath: path,
      source: 'manual',
      now: 1_700_000_000_000,
    });
    bytes = serializePrimerArtifact(artifact);
    writeFileSync(path, bytes);
    const projection = primerArtifactRegistryProjection(
      artifact,
      {
        mode: 'inline',
        bases: artifact.sequence.bases,
        topology: 'linear',
        length: artifact.sequence.length,
        contentHash: `sha256:${artifact.sequence.contentHash}`,
      },
      specializedSha(bytes)
    );
    db.transaction(() =>
      registerLimsEntityInsideTx(db, {
        id: entityId,
        kind: artifact.registry.kind,
        name: artifact.name,
        workspaceId: 1,
        schemaRevisionId: artifact.entity!.schema.schemaRevisionId,
        ...projection,
      })
    )();
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
      VALUES(?,'primer','Saved primer file',?,'file',1,1,1)`
    ).run(entityId, path);
    bindCatalogEntityFileInDb(db, {
      entityId,
      path,
      workspaceRoot: directory,
      fileKind: 'primer-artifact',
    });
  } else {
    const packageRoot = join(directory, 'registered.wpseq');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'record.gb' });
    path = paths.metaPath;
    productPath = paths.productPath;
    productBytes = serializeSequenceForInPlaceSave(
      {
        id: entityId,
        name: 'Registered',
        sequence: 'AACC',
        length: 4,
        circular: false,
        annotations: [],
      },
      productPath
    );
    const document = buildSequencePackageDocument({
      id: entityId,
      name: 'Registered',
      product: {
        file: 'record.gb',
        topology: 'linear',
        genBankChecksum: `sha256:${specializedSha(productBytes)}`,
        sequenceChecksum: `sha256:${specializedSha('AACC')}`,
      },
    });
    const initial = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: document,
      nextProductContent: productBytes,
      kind: 'sequence-save',
      operationId: 'initial-claim-fixture',
      revisionId: 'initial-claim-fixture',
    });
    mkdirSync(paths.metaDir, { recursive: true });
    mkdirSync(paths.contentsDir, { recursive: true });
    for (const snapshot of initial.snapshots) {
      const snapshotPath = fromPackageRelative(snapshot.path, packageRoot);
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, snapshot.content);
    }
    bytes = serializeSequencePackageDocument(initial.document);
    writeFileSync(path, bytes);
    writeFileSync(productPath, productBytes);
    const projection = await projectManagedSequenceRegistry(
      initial.document,
      await readSequenceProductSummary(productBytes)
    );
    db.transaction(() =>
      registerLimsEntityInsideTx(db, {
        ...projection,
        workspaceId: 1,
        fields: {
          ...projection.fields,
          [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
            kind: 'managed-sequence',
            packageId: entityId,
            packageRoot,
          },
        },
        actor: 'workspace-reconcile',
      })
    )();
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
      VALUES(?,'sequence','Registered',?,'file',1,1,1)`
    ).run(entityId, packageRoot);
    bindCatalogEntityFileInDb(db, {
      entityId,
      path: packageRoot,
      workspaceRoot: directory,
      fileKind: 'waypoint-sequence',
    });
  }
  const entity = limsEntityFromRow(
    db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entityId) as LimsEntityRow
  );
  const schema = {
    id: SCHEMA,
    currentRevisionId: REVISION,
    name: entity.kind,
    baseKind: entity.kind,
  };
  const installSnapshot = (entities: Record<string, unknown>[] = [], generation = GENERATION) =>
    replaceOrgRegistrySnapshot(db, {
      ...context,
      cursor: 1,
      accessGeneration: generation,
      now: 1,
      snapshot: {
        idSchemes: [],
        schemas: [schema],
        schemaRevisions: [],
        entities,
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
  installSnapshot();
  return {
    entityId,
    entity,
    path,
    bytes,
    productPath,
    productBytes,
    installSnapshot,
    request: { entityId, schemaId: SCHEMA, schemaRevisionId: REVISION },
    authority: type === 'primer' ? ('primer_artifact' as const) : ('sequence_package' as const),
  };
}

async function acknowledgeSpecializedClaim(f: Awaited<ReturnType<typeof savedSpecializedRecord>>) {
  const claim = await prepareOrganizationRegistryClaimInDb(db, context, f.request);
  const canonical = { ...claim.payload, orgId: ORG, revision: 1, archivedAt: null };
  f.installSnapshot([canonical]);
  db.transaction(() => {
    enqueueOrgRegistryMutation(db, {
      ...context,
      mutationId: claim.mutationId,
      operation: 'entity.create',
      payload: claim.payload,
      now: 1,
    });
    enrollOrgRegistryRecordInTx(db, { ...context, mutationId: claim.mutationId, claim, now: 1 });
  })();
  acknowledgeOrgRegistryMutation(db, {
    ...context,
    mutationId: claim.mutationId,
    now: 2,
    receipt: {
      status: 'applied',
      eventSeq: 1,
      mutationId: claim.mutationId,
      accessGeneration: GENERATION,
      entityId: f.entityId,
      homeWorkspaceId: REMOTE,
      entity: canonical,
    },
  });
  return claim;
}

const specializedDurableState = () => ({
  outbox: db.prepare('SELECT * FROM org_registry_outbox').all(),
  receipts: db.prepare('SELECT * FROM org_registry_mutation_receipts').all(),
  bindings: db.prepare('SELECT * FROM org_registry_local_records').all(),
  resolutions: db.prepare('SELECT * FROM org_registry_record_resolutions').all(),
  audit: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
});

async function savedPrimerOrganizationVersion(archived = false) {
  const f = await savedSpecializedRecord('primer');
  const claim = await acknowledgeSpecializedClaim(f);
  const before = parsePrimerArtifact(f.bytes);
  const archivedAt = archived ? 1_700_000_000_321 : null;
  const artifact = await revisePrimerArtifactContent(
    before,
    {
      name: 'Organization saved primer',
      sequence: before.sequence.bases,
      notes: 'Retained organization notes',
      inventory: {
        origin: 'manual',
        originDetails: { retained: 'full provenance' },
        vendor: 'Test vendor',
        orderDate: 1_700_000_000_123,
        scale: null,
        purification: null,
        modifications: null,
        stockLocation: 'Box A',
        concentration: 7,
      },
      entityState: {
        registrationStatus: 'registered',
        domainStatus: archived ? 'archived' : 'received',
        archived,
        archivedAt,
        status: archived ? 'archived' : 'received',
        source: 'manual',
      },
    },
    1_700_000_000_456
  );
  const normalized = serializePrimerArtifact(artifact);
  const content = ` \n${normalized}\n`;
  const projection = primerArtifactRegistryProjection(
    artifact,
    {
      mode: 'inline',
      bases: artifact.sequence.bases,
      topology: 'linear',
      length: artifact.sequence.length,
      contentHash: `sha256:${artifact.sequence.contentHash}`,
    },
    specializedSha(normalized)
  );
  const canonical = {
    ...claim.payload,
    ...projection,
    name: artifact.name,
    orgId: ORG,
    revision: 2,
    archivedAt: archivedAt === null ? null : new Date(archivedAt).toISOString(),
  };
  f.installSnapshot([canonical]);
  const checked = await readCheckedOrganizationRecordReview(
    db,
    { ...context, entityId: f.entityId },
    async () => {}
  );
  const snapshot = {
    schema: 'dnaforge.organization-saved-primer.v1' as const,
    accountId: ACCOUNT,
    orgId: ORG,
    entityId: f.entityId,
    homeWorkspaceId: REMOTE,
    schemaRevisionId: REVISION,
    organizationRevision: 2,
    projectVersionId: '80000000-0000-4000-8000-000000000001',
    projectVersionSha256: 'a'.repeat(64),
    relativePath: artifact.file.workspaceRelativePath,
    contentSha256: specializedSha(content),
    content,
  };
  const readSavedPrimerSnapshot = vi.fn(async () => snapshot);
  const args = {
    accountId: ACCOUNT,
    orgId: ORG,
    request: {
      entityId: f.entityId,
      resolutionId: randomUUID(),
      choice: 'use_remote' as const,
      sourceRevision: checked.displayed.sourceRevision,
    },
    getActiveAccountId: async () => ACCOUNT,
    refresh: async () => ready,
    readSavedPrimerSnapshot,
    readHomeAccess: async () => ({
      workspaceId: REMOTE,
      displayName: 'Existing home',
      viewer: {
        role: 'editor' as const,
        sources: [{ kind: 'direct' as const, role: 'editor' as const, orgId: null }],
      },
      canManage: false,
      owner: {
        kind: 'org' as const,
        orgId: ORG,
        slug: 'registry-test',
        displayName: 'Registry test',
      },
      admins: [],
      grants: [],
      invites: [],
    }),
  };
  return {
    f,
    artifact,
    content,
    canonical,
    projection,
    snapshot,
    args,
    apply: () => resolveSavedOrganizationRecord(db, args),
  };
}

describe('checked saved primer and UUID package registration', () => {
  it.each(['primer', 'sequence', 'construct'] as const)(
    'prepares and reviews real %s bytes without rewriting them or exposing a local sequence locator',
    async (type) => {
      const f = await savedSpecializedRecord(type === 'construct' ? 'sequence' : type);
      if (type === 'construct') {
        db.prepare('UPDATE catalog_entities SET type=?,locator=? WHERE id=?').run(
          'construct',
          `waypoint://construct/${f.entityId}`,
          f.entityId
        );
      }
      const before = specializedDurableState();
      const claim = await prepareOrganizationRegistryClaimInDb(db, context, f.request);
      expect(claim).toMatchObject({
        sourceEntityId: f.entityId,
        homeProjectUuid: HOME,
        homeWorkspaceId: REMOTE,
        payload: {
          id: f.entityId,
          kind: f.entity.kind,
          homeWorkspaceId: REMOTE,
          schemaId: SCHEMA,
          schemaRevisionId: REVISION,
        },
      });
      expect(orgRegistryRecordPublicationAuthority(db, f.entity)).toBe(f.authority);
      expect(claim.payload.fields).not.toHaveProperty(MANAGED_SEQUENCE_DOCUMENT_FIELD);
      expect(specializedDurableState()).toEqual(before);
      expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
      await acknowledgeSpecializedClaim(f);
      const afterClaim = specializedDurableState();
      const read = () =>
        readCheckedOrganizationRecordReview(
          db,
          { ...context, entityId: f.entityId },
          async () => {}
        );
      const first = await read();
      expect(first.displayed).toMatchObject({
        entityId: f.entityId,
        organizationRevision: 1,
        local: { id: f.entityId, name: f.entity.name },
      });
      expect(first.displayed.local.fields).toEqual(claim.payload.fields);
      writeFileSync(f.path, `${f.bytes}\n`);
      if (type === 'primer') {
        const second = await read();
        expect(second.displayed.sourceRevision).not.toBe(first.displayed.sourceRevision);
        expect(second.displayed.local).toEqual(first.displayed.local);
      } else {
        await expect(read()).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
      }
      expect(specializedDurableState()).toEqual(afterClaim);
      expect(readFileSync(f.path, 'utf8')).toBe(`${f.bytes}\n`);
      if (f.productPath) expect(readFileSync(f.productPath, 'utf8')).toBe(f.productBytes);
    }
  );

  it.each(['primer', 'sequence'] as const)(
    'refuses old %s confirmation after external bytes change with an unchanged projection',
    async (type) => {
      const f = await savedSpecializedRecord(type);
      const claim = await prepareOrganizationRegistryClaimInDb(db, context, f.request);
      const before = specializedDurableState();
      const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(f.entityId);
      const externalBytes = `${f.bytes}\n`;
      writeFileSync(f.path, externalBytes);
      const sync = vi.fn(async () => ready);
      const actions = createOrganizationRegistryActionHandlers(db, {
        getActiveSession: async () => ({ accountId: ACCOUNT }) as StoredSession,
        getDeviceId: () => 'test',
        client: {} as OrganizationRegistryClient,
        sync,
      });
      expect(
        await actions.claimOrganizationRegistryEntity(ORG, {
          ...f.request,
          mutationId: claim.mutationId,
          sourceRevision: claim.sourceRevision,
        })
      ).toMatchObject({ ok: false, message: expect.stringContaining('another review') });
      expect(sync).not.toHaveBeenCalled();
      expect(specializedDurableState()).toEqual(before);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(f.entityId)).toEqual(row);
      expect(readFileSync(f.path, 'utf8')).toBe(externalBytes);
    }
  );

  it.each(['primer', 'sequence'] as const)(
    'refuses initially divergent %s content without reconciliation or registration',
    async (type) => {
      const f = await savedSpecializedRecord(type);
      const altered = JSON.stringify({
        ...JSON.parse(f.bytes),
        name: 'Externally changed saved name',
      });
      writeFileSync(f.path, altered);
      const before = specializedDurableState();
      await expect(prepareOrganizationRegistryClaimInDb(db, context, f.request)).rejects.toThrow(
        /disagree|projection|changed/
      );
      expect(specializedDurableState()).toEqual(before);
      expect(readFileSync(f.path, 'utf8')).toBe(altered);
    }
  );

  it.each([null, 'A conflicting saved description'])(
    'refuses an explicit sequence schema description %s that disagrees with its Registry definition',
    async (description) => {
      const f = await savedSpecializedRecord('sequence');
      const document = JSON.parse(f.bytes);
      document.entity.schema.description = description;
      const bytes = JSON.stringify(document);
      writeFileSync(f.path, bytes);
      const before = specializedDurableState();
      const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(f.entityId);
      await expect(prepareOrganizationRegistryClaimInDb(db, context, f.request)).rejects.toThrow(
        'Sequence package bytes and Registry projection disagree'
      );
      expect(specializedDurableState()).toEqual(before);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(f.entityId)).toEqual(row);
      expect(readFileSync(f.path, 'utf8')).toBe(bytes);
    }
  );

  it.each(['primer', 'sequence'] as const)(
    'routes the public Keep saved request to the real %s publisher and replays only the original result',
    async (type) => {
      const f = await savedSpecializedRecord(type);
      const claim = await acknowledgeSpecializedClaim(f);
      f.installSnapshot([
        {
          ...claim.payload,
          orgId: ORG,
          revision: 2,
          archivedAt: null,
          name: 'Organization changed',
        },
      ]);
      const checked = await readCheckedOrganizationRecordReview(
        db,
        { ...context, entityId: f.entityId },
        async () => {}
      );
      const request = {
        entityId: f.entityId,
        resolutionId: randomUUID(),
        choice: 'keep_saved' as const,
        sourceRevision: checked.displayed.sourceRevision,
      };
      const apply = () =>
        resolveSavedOrganizationRecord(db, {
          accountId: ACCOUNT,
          orgId: ORG,
          request,
          getActiveAccountId: async () => ACCOUNT,
          refresh: async () => ready,
          readHomeAccess: async (workspaceId, accountId) => {
            expect({ workspaceId, accountId }).toEqual({ workspaceId: REMOTE, accountId: ACCOUNT });
            return {
              workspaceId: REMOTE,
              displayName: 'Existing home',
              viewer: {
                role: 'editor',
                sources: [{ kind: 'direct', role: 'editor', orgId: null }],
              },
              canManage: false,
              owner: {
                kind: 'org',
                orgId: ORG,
                slug: 'registry-test',
                displayName: 'Registry test',
              },
              admins: [],
              grants: [],
              invites: [],
            };
          },
        });
      const result = await apply();
      expect(result).toMatchObject({
        replayed: false,
        entity: { id: f.entityId, workspaceId: 1, name: f.entity.name, fields: f.entity.fields },
      });
      expect(result.entity.eventSeq).toBeGreaterThan(f.entity.eventSeq!);
      expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
      if (f.productPath) expect(readFileSync(f.productPath, 'utf8')).toBe(f.productBytes);
      expect(readReadyOrgRegistryRecordMutations(db, { ...context, now: Date.now() })).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            id: f.entityId,
            expectedRevision: 2,
            name: f.entity.name,
          }),
        }),
      ]);
      const settled = specializedDurableState();
      await expect(apply()).resolves.toMatchObject({ replayed: true, entity: result.entity });
      expect(specializedDurableState()).toEqual(settled);
      expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
      if (f.productPath) expect(readFileSync(f.productPath, 'utf8')).toBe(f.productBytes);
    }
  );

  it.each([false, true])(
    'uses exact organization primer bytes including inventory and lifecycle (archived=%s)',
    async (archived) => {
      const f = await savedPrimerOrganizationVersion(archived);
      const result = await f.apply();
      expect(result).toMatchObject({
        replayed: false,
        entity: {
          id: f.f.entityId,
          workspaceId: 1,
          name: f.artifact.name,
          fields: f.projection.fields,
          tombstone: archived,
          archivedAt: f.artifact.entity!.state!.archivedAt,
        },
      });
      expect(readFileSync(f.f.path, 'utf8')).toBe(f.content);
      expect(parsePrimerArtifact(readFileSync(f.f.path, 'utf8'))).toEqual(f.artifact);
      expect(readReadyOrgRegistryRecordMutations(db, { ...context, now: Date.now() })).toEqual([]);
      const settled = specializedDurableState();
      await expect(f.apply()).resolves.toMatchObject({ replayed: true, entity: result.entity });
      expect(specializedDurableState()).toEqual(settled);
      expect(f.args.readSavedPrimerSnapshot).toHaveBeenCalledTimes(1);
      expect(readFileSync(f.f.path, 'utf8')).toBe(f.content);
      const reviewed = await readCheckedOrganizationRecordReview(
        db,
        { ...context, entityId: f.f.entityId },
        async () => {}
      );
      expect(reviewed.displayed.local).toEqual(reviewed.displayed.organization);
    }
  );

  it('retries interrupted Use organization after reopening SQLite without downloading or editing again', async () => {
    const f = await savedPrimerOrganizationVersion();
    const writer = vi
      .spyOn(nativePublication, 'publishNativeCatalogBytes')
      .mockRejectedValueOnce(new Error('Interrupted exact organization primer installation'));
    try {
      await expect(f.apply()).rejects.toThrow('Interrupted exact organization primer installation');
      const committed = db
        .prepare('SELECT event_seq FROM lims_entity WHERE id=?')
        .get(f.f.entityId);
      expect(db.prepare('SELECT status FROM org_registry_record_resolutions').get()).toEqual({
        status: 'publication_pending',
      });
      expect(readReadyOrgRegistryRecordMutations(db, { ...context, now: Date.now() })).toEqual([]);
      expect(readFileSync(f.f.path, 'utf8')).toBe(f.f.bytes);
      const databasePath = join(directory, 'registry-restart.db');
      await db.backup(databasePath);
      db.close();
      db = openFileTestDb(databasePath);
      f.args.readSavedPrimerSnapshot.mockRejectedValueOnce(
        new Error('Retry must retain its approved bytes')
      );
      const result = await f.apply();
      expect(result).toMatchObject({
        replayed: true,
        entity: { id: f.f.entityId, name: f.artifact.name },
      });
      expect(db.prepare('SELECT event_seq FROM lims_entity WHERE id=?').get(f.f.entityId)).toEqual(
        committed
      );
      expect(readFileSync(f.f.path, 'utf8')).toBe(f.content);
      expect(f.args.readSavedPrimerSnapshot).toHaveBeenCalledTimes(1);
      expect(
        db.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
      ).toBe(0);
    } finally {
      writer.mockRestore();
    }
  });

  it('refuses a downloaded organization primer from another revision without changing the saved owner', async () => {
    const f = await savedPrimerOrganizationVersion();
    f.snapshot.organizationRevision = 3;
    const before = specializedDurableState();
    await expect(f.apply()).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(specializedDurableState()).toEqual(before);
    expect(readFileSync(f.f.path, 'utf8')).toBe(f.f.bytes);
  });

  it.each(['primer', 'sequence'] as const)(
    'refuses unavailable %s organization snapshot bytes before any local event or resolution',
    async (type) => {
      const f = await savedSpecializedRecord(type);
      await acknowledgeSpecializedClaim(f);
      const checked = await readCheckedOrganizationRecordReview(
        db,
        { ...context, entityId: f.entityId },
        async () => {}
      );
      const before = specializedDurableState();
      await expect(
        resolveSavedOrganizationRecord(db, {
          accountId: ACCOUNT,
          orgId: ORG,
          request: {
            entityId: f.entityId,
            resolutionId: randomUUID(),
            choice: 'use_remote',
            sourceRevision: checked.displayed.sourceRevision,
          },
          ...{
            readSavedPrimerSnapshot: async () => {
              throw Object.assign(new Error('Exact saved version unavailable'), {
                code: 'SAVED_VERSION_UNAVAILABLE',
              });
            },
            readSavedSequenceSnapshot: async () => {
              throw Object.assign(new Error('Exact saved version unavailable'), {
                code: 'SAVED_VERSION_UNAVAILABLE',
              });
            },
          },
          getActiveAccountId: async () => ACCOUNT,
          refresh: async () => ready,
          readHomeAccess: async () => ({
            workspaceId: REMOTE,
            displayName: 'Existing home',
            viewer: { role: 'editor', sources: [{ kind: 'direct', role: 'editor', orgId: null }] },
            canManage: false,
            owner: { kind: 'org', orgId: ORG, slug: 'registry-test', displayName: 'Registry test' },
            admins: [],
            grants: [],
            invites: [],
          }),
        })
      ).rejects.toMatchObject({ code: 'SAVED_VERSION_UNAVAILABLE' });
      expect(specializedDurableState()).toEqual(before);
      expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
      if (f.productPath) expect(readFileSync(f.productPath, 'utf8')).toBe(f.productBytes);
    }
  );

  it.each(['home', 'generation'] as const)(
    'rereads %s after the specialized saved-file read',
    async (changed) => {
      const f = await savedSpecializedRecord('primer');
      let reads = 0;
      await expect(
        prepareOrganizationRegistryClaimInDb(db, context, f.request, {
          assertCurrentAccount: async () => {
            if (++reads !== 2) return;
            if (changed === 'home')
              db.prepare(
                'UPDATE workspace_sync_bindings SET remote_workspace_id=? WHERE workspace_id=1'
              ).run('40000000-0000-4000-8000-000000000099');
            else f.installSnapshot([], `home-v1:${'b'.repeat(64)}`);
          },
        })
      ).rejects.toThrow(/another review/);
      expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM org_registry_local_records').all()).toEqual([]);
      expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
    }
  );

  it('keeps scoped imported identities refused instead of stripping their scope', async () => {
    const f = await savedSpecializedRecord('sequence');
    const scoped = `workspace:${HOME}:${f.entityId}`;
    await expect(
      prepareOrganizationRegistryClaimInDb(db, context, { ...f.request, entityId: scoped })
    ).rejects.toThrow();
    expect(() => orgRegistryRecordPublicationAuthority(db, { ...f.entity, id: scoped })).toThrow(
      /cannot yet stay synchronized/
    );
    expect(db.prepare('SELECT * FROM org_registry_outbox').all()).toEqual([]);
    expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
  });
});
