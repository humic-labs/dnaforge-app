/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

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
vi.mock('../org-registry-sync-client', () => ({ createOrganizationRegistryClient: vi.fn() }));
vi.mock('../org-registry-sync-worker', () => ({ syncOrganizationRegistry: vi.fn() }));
vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () =>
    host.accountId ? { accountId: host.accountId } : null
  ),
}));

import { ipcMain } from 'electron';
import { createTestDb, openFileTestDb } from './test-db';
import { ensureSchema } from '../schema';
import type { WorkspaceSyncAccessListing } from '../../shared/workspace-sync-ipc';
import {
  registerLimsEntityInDb,
  registerLimsIpcHandlers,
  queryLimsEntitiesInDb,
  listLimsEntitySchemasInDb,
  linkLimsEntitiesInDb,
  defineLimsSchemaInDb,
} from '../lims';
import {
  entityArtifactSchemaSnapshot,
  parseEntityArtifact,
  serializeEntityArtifact,
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import { verifyLimsAuditHashChainInDb } from '../lims-projection-rebuild';
import * as publication from '../native-catalog-publication';
import {
  recoverEntityArtifactPublications,
  publishReviewedEntityArtifactResolution,
  readReviewedEntityArtifactResolutionIdentity,
  resumeReviewedEntityArtifactResolution,
} from '../entity-artifact-mutations';
import { readCheckedOrganizationRecordReview } from '../org-registry-record-review';
import type { RegisteredRecordResolutionRequest } from '../org-registry-local-mutations';
import {
  withWorkspaceMutation,
  tryAcquireWorkspaceMutationShared,
} from '../workspace-sync-mutation-lease';
import { getActiveStoredSession } from '../auth/session-store';
import { updateWorkspaceSyncAccessRecord } from '../workspace-sync-access-record';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';
import { WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE } from '../../shared/workspace-sync-errors';
import {
  createOrganizationRegistryActionHandlers,
  type OrganizationRegistryActionDeps,
} from '../org-registry-actions';
import {
  enrollOrgRegistryRecordInTx,
  readReadyOrgRegistryRecordMutations,
  markOrgRegistryRecordMutationQueuedInTx,
  readOrgRegistryRecordSyncStatus,
} from '../org-registry-record-sync';
import {
  acknowledgeOrgRegistryMutation,
  enqueueOrgRegistryMutation,
  markOrgRegistryMutationConflict,
  readPendingOrgRegistryMutations,
  replaceOrgRegistrySnapshot,
  revokeOrgRegistryCache,
} from '../org-registry-sync-cache';

let root: string;
let path: string;
let doc: EntityArtifactV2;
const sender = Object.assign(new EventEmitter(), { id: 426, isDestroyed: () => false });
const entity = () => queryLimsEntitiesInDb(host.db!, { id: doc.id, includeArchived: true })[0];
const snapshot = () =>
  JSON.stringify({
    entities: host.db!.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
    history: host.db!.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
  });

beforeEach(async () => {
  host.accountId = null;
  vi.mocked(getActiveStoredSession).mockClear();
  root = await mkdtemp(join(tmpdir(), 'registry-artifact-lifecycle-'));
  path = join(root, 'records', 'owned.entity.json');
  await mkdir(join(root, 'records'));
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare('INSERT INTO workspaces (id,name,path,created_at) VALUES (7,?,?,1)')
    .run('Owned project', root);
  const schemaSnapshot = entityArtifactSchemaSnapshot(
    listLimsEntitySchemasInDb(host.db).find((schema) => schema.entityKind === 'strain')!
  );
  doc = {
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    id: 'owned-record',
    kind: 'strain',
    name: 'Original name',
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    schemaSnapshot,
    archived: false,
    fields: {
      genotypeCanonical: 'recA1',
      artifact: {
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        relativePath: 'records/owned.entity.json',
      },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    relationships: [],
    source: { type: 'manual', values: {} },
  };
  await writeFile(path, serializeEntityArtifact(doc));
  registerLimsEntityInDb(host.db, {
    id: doc.id,
    kind: doc.kind,
    name: doc.name,
    fields: doc.fields,
    schemaRevisionId: doc.schemaRevisionId,
    schemaSnapshot: doc.schemaSnapshot,
    workspaceId: 7,
  });
  vi.mocked(ipcMain.handle).mockClear();
  registerLimsIpcHandlers();
});
afterEach(async () => {
  vi.restoreAllMocks();
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});

async function invoke(channel: string, extra: Record<string, unknown> = {}) {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channel);
  if (!handler) throw new Error(`Missing actual IPC handler ${channel}`);
  return handler({ sender } as unknown as Electron.IpcMainInvokeEvent, {
    id: doc.id,
    expectedEventSeq: entity().eventSeq,
    operationId: crypto.randomUUID(),
    ...extra,
  });
}

async function createLinkedRecord() {
  defineLimsSchemaInDb(host.db!, {
    kind: 'entity',
    name: 'linked_record',
    baseKind: 'strain',
    displayName: 'Linked record',
    fields: [
      { key: 'parentEntity', label: 'Parent entity', type: 'record_relationship' },
      { key: 'backupEntity', label: 'Backup entity', type: 'record_relationship' },
    ],
  });
  const schemaSnapshot = entityArtifactSchemaSnapshot(
    listLimsEntitySchemasInDb(host.db!).find((schema) => schema.entityKind === 'linked_record')!
  );
  doc = {
    ...doc,
    id: 'linked-source',
    kind: 'linked_record',
    name: 'Linked source',
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    schemaSnapshot,
    fields: {
      artifact: {
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        relativePath: 'records/linked.entity.json',
      },
    },
  };
  path = join(root, 'records', 'linked.entity.json');
  await writeFile(path, serializeEntityArtifact(doc));
  registerLimsEntityInDb(host.db!, {
    id: doc.id,
    kind: doc.kind,
    name: doc.name,
    fields: doc.fields,
    schemaRevisionId: doc.schemaRevisionId,
    schemaSnapshot,
    workspaceId: 7,
  });
}

describe('saved schema-defined entity links', () => {
  it('saves checked targets, shares the graph edge across fields and restores it with Undo', async () => {
    await createLinkedRecord();
    await invoke('lims:updateEntity', {
      relationshipTargets: { parentEntity: 'owned-record', backupEntity: 'owned-record' },
    });
    const saved = () => readFile(path, 'utf8').then(parseEntityArtifact);
    const edges = () =>
      host
        .db!.prepare(
          "SELECT * FROM lims_link WHERE from_entity_id=? AND type='references' AND tombstone=0"
        )
        .all(doc.id);
    expect((await saved()).fields.parentEntity).toEqual({
      origin: 'native',
      destinationEntityId: 'owned-record',
      relationType: 'references',
      label: 'Original name',
      resolution: 'exact',
    });
    expect((await saved()).relationships).toEqual([
      expect.objectContaining({
        fromEntityId: doc.id,
        toEntityId: 'owned-record',
        type: 'references',
        payload: expect.objectContaining({ fieldKeys: ['backupEntity', 'parentEntity'] }),
      }),
    ]);
    expect(edges()).toHaveLength(1);
    await invoke('lims:updateEntity', { relationshipTargets: { parentEntity: null } });
    expect(edges()).toHaveLength(1);
    expect((await saved()).relationships[0].payload.fieldKeys).toEqual(['backupEntity']);
    await invoke('lims:updateEntity', { relationshipTargets: { backupEntity: null } });
    expect(edges()).toHaveLength(0);
    expect((await saved()).relationships).toEqual([]);
    await invoke('lims:revertEntity');
    expect(edges()).toHaveLength(1);
    expect((await saved()).fields.backupEntity).toMatchObject({
      destinationEntityId: 'owned-record',
    });
    expect(entity()).toMatchObject({ id: 'linked-source', workspaceId: 7 });
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('rejects a renderer-authored link value without changing saved bytes or history', async () => {
    await createLinkedRecord();
    const before = snapshot();
    const bytes = await readFile(path, 'utf8');
    await expect(
      invoke('lims:updateEntity', {
        fields: {
          parentEntity: {
            origin: 'native',
            destinationEntityId: 'owned-record',
            relationType: 'references',
            label: 'Forged label',
            resolution: 'exact',
          },
        },
      })
    ).rejects.toThrow(/target|relationship|link/i);
    expect(snapshot()).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it.each(['missing-record', 'linked-source', 'archived-record'])(
    'refuses an unavailable or self target %s before publication',
    async (target) => {
      await createLinkedRecord();
      if (target === 'archived-record') {
        registerLimsEntityInDb(host.db!, {
          id: target,
          kind: 'strain',
          name: 'Archived target',
          fields: {},
          workspaceId: 7,
        });
        host.db!.prepare('UPDATE lims_entity SET tombstone=1,archived_at=1 WHERE id=?').run(target);
      }
      const before = snapshot();
      const bytes = await readFile(path, 'utf8');
      await expect(
        invoke('lims:updateEntity', { relationshipTargets: { parentEntity: target } })
      ).rejects.toThrow(/target|relationship|link/i);
      expect(snapshot()).toBe(before);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
  );
});

describe('generic record lifecycle through real Registry IPC, filesystem and SQLite', () => {
  function bindSharedRole(role: 'viewer' | 'editor' | 'manager' | 'owner', enabled = 1) {
    host.db!.prepare("UPDATE workspaces SET repo_uuid='registry-current-project' WHERE id=7").run();
    host
      .db!.prepare(
        `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, access_role, access_source, shared_with_others, created_at, updated_at
    ) VALUES (7,'registry-current-project','account','remote',?,?,'direct',1,1,1)`
      )
      .run(enabled, role);
  }

  it.each(['update', 'archive', 'restore', 'revert'] as const)(
    'refuses shared viewer %s before file, history, or projection changes',
    async (action) => {
      if (action === 'restore') await invoke('lims:archiveEntity');
      if (action === 'revert') await invoke('lims:updateEntity', { name: 'Editor change' });
      bindSharedRole('viewer', 0);
      const before = snapshot();
      const bytes = await readFile(path, 'utf8');
      await expect(
        invoke(`lims:${action}Entity`, action === 'update' ? { name: 'Viewer change' } : {})
      ).rejects.toThrow(/shared project is view only/i);
      expect(snapshot()).toBe(before);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(
        host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
      ).toBe(0);
    }
  );

  it('refuses a shared viewer relationship replacement before publication', async () => {
    bindSharedRole('viewer');
    const before = snapshot();
    const bytes = await readFile(path, 'utf8');
    await expect(
      invoke('lims:replaceOutgoingRelationships', { entityId: doc.id, relationships: [] })
    ).rejects.toThrow(/shared project is view only/i);
    expect(snapshot()).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
  });

  it('uses a promoted role on the next command while offline', async () => {
    bindSharedRole('viewer', 0);
    await expect(invoke('lims:updateEntity', { name: 'Viewer change' })).rejects.toThrow(
      /view only/i
    );
    host
      .db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor' WHERE workspace_id=7")
      .run();
    await invoke('lims:updateEntity', { name: 'Promoted editor change' });
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe('Promoted editor change');
    expect(entity().name).toBe('Promoted editor change');
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it.each(['editor', 'manager', 'owner'] as const)(
    'allows offline shared %s record edits',
    async (role) => {
      bindSharedRole(role, 0);
      await invoke('lims:updateEntity', { name: `${role} change` });
      expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe(`${role} change`);
      expect(entity().name).toBe(`${role} change`);
    }
  );

  it('does not apply an obsolete viewer binding to a replacement project', async () => {
    bindSharedRole('viewer');
    host.db!.prepare("UPDATE workspaces SET repo_uuid='replacement-project' WHERE id=7").run();
    await invoke('lims:updateEntity', { name: 'Replacement project change' });
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe(
      'Replacement project change'
    );
  });

  it.each(['update', 'archive', 'restore', 'revert'] as const)(
    'refuses a stale %s request after the owning project is trashed',
    async (action) => {
      if (action === 'restore') await invoke('lims:archiveEntity');
      if (action === 'revert') await invoke('lims:updateEntity', { name: 'Edited name' });
      host.db!.prepare('UPDATE workspaces SET trashed_at=1 WHERE id=7').run();
      const before = snapshot();
      const bytes = await readFile(path, 'utf8');
      await expect(
        invoke(`lims:${action}Entity`, action === 'update' ? { name: 'Stale edit' } : {})
      ).rejects.toThrow(/trash|writable|project/i);
      expect(snapshot()).toBe(before);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(
        host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
      ).toBe(0);
    }
  );

  it('retains an interrupted save while its project is trashed and recovers only after restoration', async () => {
    const bytes = await readFile(path, 'utf8');
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted publication')
    );
    await expect(invoke('lims:archiveEntity')).rejects.toThrow('Interrupted publication');
    host.db!.prepare('UPDATE workspaces SET trashed_at=1 WHERE id=7').run();
    const before = snapshot();
    const recover = () =>
      recoverEntityArtifactPublications({
        db: host.db!,
        workspacePath: root,
        runDatabase: (work) => work(),
      });
    await expect(recover()).rejects.toThrow(/trash|writable|project/i);
    expect(snapshot()).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(1);
    host.db!.prepare('UPDATE workspaces SET trashed_at=NULL WHERE id=7').run();
    await recover();
    expect(parseEntityArtifact(await readFile(path, 'utf8'))).toMatchObject({ archived: true });
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('publishes archive and restore in the authority file', async () => {
    await invoke('lims:archiveEntity');
    expect(parseEntityArtifact(await readFile(path, 'utf8'))).toMatchObject({
      archived: true,
      id: doc.id,
      schemaSnapshot: doc.schemaSnapshot,
    });
    expect(entity().tombstone).toBe(true);
    await invoke('lims:restoreEntity');
    expect(parseEntityArtifact(await readFile(path, 'utf8'))).toMatchObject({ archived: false });
    expect(entity().tombstone).toBe(false);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('publishes edits and Undo so a later file reconstruction sees the reverted state', async () => {
    await invoke('lims:updateEntity', { name: 'Edited name' });
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe('Edited name');
    await invoke('lims:revertEntity');
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe('Original name');
    expect(entity().name).toBe('Original name');
  });

  it('rejects an external file edit before changing history or the projection', async () => {
    const external = serializeEntityArtifact({ ...doc, name: 'External file edit' });
    await writeFile(path, external);
    const before = snapshot();
    await expect(invoke('lims:archiveEntity')).rejects.toThrow(/disagree|changed|conflict/i);
    expect(snapshot()).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(external);
  });

  it('rejects stale lifecycle requests before publication', async () => {
    const before = snapshot();
    const bytes = await readFile(path, 'utf8');
    await expect(invoke('lims:archiveEntity', { expectedEventSeq: 1 })).rejects.toThrow(
      /changed|refresh/i
    );
    expect(snapshot()).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it.each([
    [
      'moving its locator',
      { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'records/moved.entity.json' },
    ],
    [
      'changing its authority schema',
      { schema: 'unrecognized-authority', relativePath: 'records/owned.entity.json' },
    ],
    ['removing its authority metadata', null],
  ] as const)(
    'rejects a field edit %s before committing any projection or history',
    async (_description, artifact) => {
      const before = snapshot();
      const bytes = await readFile(path, 'utf8');
      await expect(invoke('lims:updateEntity', { fields: { artifact } })).rejects.toThrow();
      expect(snapshot() === before).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(
        host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
      ).toBe(0);
    }
  );

  it('recovers a committed publication failure before another edit', async () => {
    const bytes = await readFile(path, 'utf8');
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted publication')
    );
    await expect(invoke('lims:archiveEntity')).rejects.toThrow('Interrupted publication');
    expect(entity().tombstone).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    await invoke('lims:restoreEntity');
    expect(parseEntityArtifact(await readFile(path, 'utf8'))).toMatchObject({ archived: false });
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});

type RegisteredPublicationRow = {
  mutation_id: string;
  operation_id: string;
  entity_id: string;
  local_event_seq: number;
  publication_authority: string;
  publication_sha256: string;
  payload_json: string;
  status: string;
};
const organizationScope = {
  orgId: '10000000-0000-4000-8000-000000000071',
  accountId: '20000000-0000-4000-8000-000000000071',
  clientId: 'desktop:artifact-publication',
};
const registeredHome = '30000000-0000-4000-8000-000000000071';
const registeredRemoteHome = '40000000-0000-4000-8000-000000000071';
const organizationSchema = '50000000-0000-4000-8000-000000000071';
const organizationRevision = '60000000-0000-4000-8000-000000000071';
const accessGeneration = `home-v1:${'7'.repeat(64)}`;
const bytesSha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const registeredPublications = () =>
  host
    .db!.prepare(
      'SELECT mutation_id,operation_id,entity_id,local_event_seq,publication_authority,publication_sha256,payload_json,status FROM org_registry_record_publications ORDER BY local_event_seq'
    )
    .all() as RegisteredPublicationRow[];

async function enrollSavedRecord(): Promise<Record<string, unknown> & { revision: number }> {
  const db = host.db!;
  host.accountId = organizationScope.accountId;
  db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=7').run(registeredHome);
  db.prepare(
    `INSERT INTO workspace_sync_bindings
    (workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role,created_at,updated_at)
    VALUES(7,?,?,?,?,0,'editor',1,1)`
  ).run(registeredHome, organizationScope.accountId, organizationScope.orgId, registeredRemoteHome);
  const current = entity();
  const mutationId = crypto.randomUUID();
  const payload = {
    id: current.id,
    kind: current.kind,
    name: current.name,
    fields: current.fields,
    registrationStatus: current.registrationStatus,
    domainStatus: current.domainStatus,
    schemaId: organizationSchema,
    schemaRevisionId: organizationRevision,
    homeWorkspaceId: registeredRemoteHome,
  };
  const canonical = { ...payload, orgId: organizationScope.orgId, revision: 1, archivedAt: null };
  replaceOrgRegistrySnapshot(db, {
    ...organizationScope,
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
  const sourceRevision = bytesSha256(await readFile(path, 'utf8'));
  db.transaction(() => {
    enrollOrgRegistryRecordInTx(db, {
      ...organizationScope,
      mutationId,
      now: 1,
      claim: {
        mutationId,
        sourceEntityId: current.id,
        sourceRegistryId: current.registryId,
        sourceRevision,
        homeWorkspaceId: registeredRemoteHome,
        homeProjectUuid: registeredHome,
        homeProjectName: 'Owned project',
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
      eventSeq: 1,
      mutationId,
      accessGeneration,
      entityId: current.id,
      homeWorkspaceId: registeredRemoteHome,
      entity: canonical,
    },
  });
  expect(readPendingOrgRegistryMutations(db, organizationScope)).toEqual([]);
  return canonical;
}

function acknowledgeSavedPublication(canonical: Record<string, unknown> & { revision: number }) {
  const db = host.db!;
  const [mutation] = readReadyOrgRegistryRecordMutations(db, { ...organizationScope, now: 3 });
  if (!mutation) throw new Error('The completed file publication is not ready.');
  const publication = registeredPublications().find(
    (row) => row.mutation_id === mutation.mutationId
  )!;
  const { archived, ...desired } = JSON.parse(publication.payload_json) as Record<string, unknown>;
  const next = {
    ...canonical,
    ...desired,
    revision: canonical.revision + 1,
    archivedAt: archived ? 3 : null,
  };
  db.transaction(() => {
    enqueueOrgRegistryMutation(db, { ...organizationScope, ...mutation, now: 3 });
    markOrgRegistryRecordMutationQueuedInTx(db, { mutationId: mutation.mutationId, now: 3 });
  })();
  acknowledgeOrgRegistryMutation(db, {
    ...organizationScope,
    mutationId: mutation.mutationId,
    now: 4,
    receipt: {
      status: 'applied',
      eventSeq: next.revision,
      mutationId: mutation.mutationId,
      accessGeneration,
      entityId: doc.id,
      homeWorkspaceId: registeredRemoteHome,
      entity: next,
    },
  });
  return next;
}

describe('registered generic file publication through actual IPC', () => {
  it('keeps failed publication unsendable and releases one exact saved intent on identical Retry', async () => {
    await enrollSavedRecord();
    const beforeBytes = await readFile(path, 'utf8');
    const request = {
      operationId: crypto.randomUUID(),
      expectedEventSeq: entity().eventSeq,
      name: 'Saved organization edit',
      fields: { genotypeCanonical: 'recA1 endA1' },
    };
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted registered publication')
    );
    await expect(invoke('lims:updateEntity', request)).rejects.toThrow(
      'Interrupted registered publication'
    );
    expect(entity()).toMatchObject({ name: request.name, fields: request.fields });
    expect(await readFile(path, 'utf8')).toBe(beforeBytes);
    const pending = registeredPublications();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      operation_id: request.operationId,
      entity_id: doc.id,
      local_event_seq: entity().eventSeq,
      publication_authority: 'entity_artifact',
      status: 'publication_pending',
    });
    const planned = host
      .db!.prepare(
        "SELECT payload FROM lims_audit WHERE operation_id=? AND event_type='entity_artifact_publication_required'"
      )
      .get(request.operationId) as { payload: string };
    const afterBytes = (JSON.parse(planned.payload) as { afterBytes: string }).afterBytes;
    expect(pending[0].publication_sha256).toBe(bytesSha256(afterBytes));
    expect(pending[0].publication_sha256).not.toBe(bytesSha256(beforeBytes));
    expect(JSON.parse(pending[0].payload_json)).toMatchObject({
      id: doc.id,
      name: request.name,
      fields: request.fields,
      archived: false,
    });
    expect(readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: 5 })).toEqual(
      []
    );
    expect(readPendingOrgRegistryMutations(host.db!, organizationScope)).toEqual([]);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(1);

    await invoke('lims:updateEntity', request);
    const savedBytes = await readFile(path, 'utf8');
    expect(savedBytes).toBe(afterBytes);
    expect(parseEntityArtifact(savedBytes)).toMatchObject({
      id: doc.id,
      name: request.name,
      fields: request.fields,
      archived: false,
    });
    expect(registeredPublications()).toEqual([{ ...pending[0], status: 'ready' }]);
    expect(registeredPublications()[0].publication_sha256).toBe(bytesSha256(savedBytes));
    expect(readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: 6 })).toEqual(
      [
        {
          clientId: organizationScope.clientId,
          mutationId: pending[0].mutation_id,
          operation: 'entity.update',
          payload: expect.objectContaining({
            id: doc.id,
            expectedRevision: 1,
            name: request.name,
            fields: expect.objectContaining(request.fields),
          }),
        },
      ]
    );
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    const settled = snapshot();
    await invoke('lims:updateEntity', request);
    expect(snapshot()).toBe(settled);
    expect(registeredPublications()).toEqual([{ ...pending[0], status: 'ready' }]);
    expect(await readFile(path, 'utf8')).toBe(savedBytes);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('refuses an account switch during real byte preparation before changing local history or files', async () => {
    await enrollSavedRecord();
    const before = snapshot();
    const beforeBytes = await readFile(path, 'utf8');
    const bindings = host.db!.prepare('SELECT * FROM org_registry_local_records').all();
    const readBase = publication.readNativeCatalogPublicationBase;
    vi.spyOn(publication, 'readNativeCatalogPublicationBase').mockImplementationOnce(
      async (input) => {
        const bytes = await readBase(input);
        host.accountId = '20000000-0000-4000-8000-000000000099';
        return bytes;
      }
    );
    await expect(invoke('lims:updateEntity', { name: 'Wrong account edit' })).rejects.toThrow(
      /account|registered/i
    );
    expect(host.accountId).toBe('20000000-0000-4000-8000-000000000099');
    expect(vi.mocked(getActiveStoredSession)).toHaveBeenCalled();
    expect(snapshot()).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(beforeBytes);
    expect(registeredPublications()).toEqual([]);
    expect(host.db!.prepare('SELECT * FROM org_registry_local_records').all()).toEqual(bindings);
    expect(readPendingOrgRegistryMutations(host.db!, organizationScope)).toEqual([]);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
  });

  it('captures archive, restore and revert from each published lifecycle and acknowledged predecessor', async () => {
    let canonical = await enrollSavedRecord();
    const steps = [
      { action: 'archive', name: doc.name, archived: true, operation: 'entity.archive' },
      { action: 'restore', name: doc.name, archived: false, operation: 'entity.restore' },
      {
        action: 'update',
        name: 'Edited registered record',
        archived: false,
        operation: 'entity.update',
      },
      { action: 'revert', name: doc.name, archived: false, operation: 'entity.update' },
    ] as const;
    for (const step of steps) {
      const operationId = crypto.randomUUID();
      await invoke(`lims:${step.action}Entity`, {
        operationId,
        ...(step.action === 'update' ? { name: step.name } : {}),
      });
      const bytes = await readFile(path, 'utf8');
      const saved = parseEntityArtifact(bytes);
      expect(saved).toMatchObject({
        id: doc.id,
        name: step.name,
        archived: step.archived,
        schemaRevisionId: doc.schemaRevisionId,
        schemaSnapshot: doc.schemaSnapshot,
        fields: doc.fields,
        source: doc.source,
      });
      expect(entity()).toMatchObject({
        id: doc.id,
        workspaceId: 7,
        name: step.name,
        tombstone: step.archived,
      });
      const intent = registeredPublications().find((row) => row.operation_id === operationId)!;
      expect(intent).toMatchObject({
        entity_id: doc.id,
        local_event_seq: entity().eventSeq,
        publication_authority: 'entity_artifact',
        publication_sha256: bytesSha256(bytes),
        status: 'ready',
      });
      expect(JSON.parse(intent.payload_json)).toEqual({
        id: doc.id,
        name: step.name,
        fields: saved.fields,
        registrationStatus: saved.registrationStatus,
        domainStatus: saved.domainStatus,
        archived: step.archived,
      });
      const ready = readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: 5 });
      expect(ready).toHaveLength(1);
      expect(ready[0]).toMatchObject({
        mutationId: intent.mutation_id,
        operation: step.operation,
        payload: { id: doc.id, expectedRevision: canonical.revision },
      });
      canonical = acknowledgeSavedPublication(canonical);
    }
    expect(registeredPublications()).toHaveLength(steps.length);
    expect(registeredPublications().every((row) => row.status === 'acknowledged')).toBe(true);
    expect(readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: 6 })).toEqual(
      []
    );
    expect(
      host
        .db!.prepare('SELECT enabled FROM workspace_sync_bindings WHERE workspace_id=7')
        .pluck()
        .get()
    ).toBe(0);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});

async function enrollSavedReviewRecord() {
  path = join(root, 'records', 'review.entity.json');
  doc = {
    ...doc,
    id: '70000000-0000-4000-8000-000000000071',
    name: 'Reviewable saved record',
    fields: {
      ...doc.fields,
      artifact: {
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        relativePath: 'records/review.entity.json',
      },
    },
  };
  await writeFile(path, serializeEntityArtifact(doc));
  registerLimsEntityInDb(host.db!, {
    id: doc.id,
    kind: doc.kind,
    name: doc.name,
    fields: doc.fields,
    schemaRevisionId: doc.schemaRevisionId,
    schemaSnapshot: doc.schemaSnapshot,
    workspaceId: 7,
  });
  return enrollSavedRecord();
}

function savedReviewActions(
  sync?: OrganizationRegistryActionDeps['sync'],
  readHomeAccess?: OrganizationRegistryActionDeps['readHomeAccess']
) {
  const remote = vi.fn(async () => {
    throw new Error('Reading saved versions must not contact the organization service.');
  });
  return {
    remote,
    actions: createOrganizationRegistryActionHandlers(host.db!, {
      client: {
        getSnapshotPage: remote,
        acknowledgeSnapshot: remote,
        getEvents: remote,
        applyMutation: remote,
        configure: remote,
        getSyncHealth: remote,
        getDeletionImpact: remote,
      },
      sync: sync ?? remote,
      readHomeAccess,
    }),
  };
}

const savedReviewState = () => ({
  local: snapshot(),
  registration: host
    .db!.prepare('SELECT * FROM org_registry_local_records ORDER BY entity_id')
    .all(),
  publications: host
    .db!.prepare(
      'SELECT * FROM org_registry_record_publications ORDER BY local_event_seq,mutation_id'
    )
    .all(),
  outbox: host.db!.prepare('SELECT * FROM org_registry_outbox ORDER BY mutation_id').all(),
  conflicts: host.db!.prepare('SELECT * FROM org_registry_conflicts ORDER BY id').all(),
  cache: host
    .db!.prepare(
      'SELECT * FROM org_registry_cache ORDER BY org_id,account_id,record_type,record_id'
    )
    .all(),
  scope: host.db!.prepare('SELECT * FROM org_registry_sync_state ORDER BY org_id,account_id').all(),
  localPublications: host
    .db!.prepare('SELECT * FROM native_catalog_publication_outbox ORDER BY operation_id')
    .all(),
});

describe('checked registered-file review through the actual main action', () => {
  it('returns both saved versions without changing local bytes, history or conflict lineage', async () => {
    const canonical = await enrollSavedReviewRecord();
    await invoke('lims:updateEntity', {
      name: 'Local saved version',
      fields: { genotypeCanonical: 'recA1 local' },
    });
    const [mutation] = readReadyOrgRegistryRecordMutations(host.db!, {
      ...organizationScope,
      now: 5,
    });
    expect(mutation).toBeDefined();
    host.db!.transaction(() => {
      enqueueOrgRegistryMutation(host.db!, { ...organizationScope, ...mutation, now: 5 });
      markOrgRegistryRecordMutationQueuedInTx(host.db!, {
        mutationId: mutation.mutationId,
        now: 5,
      });
    })();
    const remoteVersion = {
      ...canonical,
      name: 'Organization saved version',
      fields: { ...doc.fields, genotypeCanonical: 'recA1 remote' },
      revision: 2,
    };
    replaceOrgRegistrySnapshot(host.db!, {
      ...organizationScope,
      cursor: 2,
      accessGeneration,
      now: 6,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [remoteVersion],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
    });
    markOrgRegistryMutationConflict(host.db!, {
      mutationId: mutation.mutationId,
      code: 'CONFLICT',
      message: 'The organization record changed after the acknowledged revision.',
      details: { expectedRevision: 1, actualRevision: 2 },
      now: 7,
    });
    const bytes = await readFile(path, 'utf8');
    const before = savedReviewState();
    const { actions, remote } = savedReviewActions();
    const result = await actions.getOrganizationRegistrySavedRecordReview(
      organizationScope.orgId,
      doc.id
    );
    expect(result).toMatchObject({
      ok: true,
      review: {
        accountId: organizationScope.accountId,
        orgId: organizationScope.orgId,
        entityId: doc.id,
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        localEventSeq: entity().eventSeq,
        organizationRevision: 2,
        local: {
          id: doc.id,
          name: 'Local saved version',
          fields: { ...doc.fields, genotypeCanonical: 'recA1 local' },
          registrationStatus: 'registered',
          domainStatus: null,
          archived: false,
        },
        organization: {
          id: doc.id,
          name: remoteVersion.name,
          fields: remoteVersion.fields,
          registrationStatus: 'registered',
          domainStatus: null,
          archived: false,
        },
      },
    });
    expect(
      await actions.getOrganizationRegistrySavedRecordReview(organizationScope.orgId, doc.id)
    ).toEqual(result);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(parseEntityArtifact(bytes)).toMatchObject({
      id: doc.id,
      name: 'Local saved version',
      fields: { genotypeCanonical: 'recA1 local' },
    });
    expect(savedReviewState()).toEqual(before);
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('refuses changed saved bytes without reconciling them or mutating either version', async () => {
    await enrollSavedReviewRecord();
    const external = serializeEntityArtifact({
      ...doc,
      name: 'External saved version',
      fields: { ...doc.fields, genotypeCanonical: 'recA1 external' },
    });
    await writeFile(path, external);
    const before = savedReviewState();
    const { actions, remote } = savedReviewActions();
    const result = await actions.getOrganizationRegistrySavedRecordReview(
      organizationScope.orgId,
      doc.id
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/file and projection disagree|changed/i),
    });
    expect(result).not.toHaveProperty('review');
    expect(await readFile(path, 'utf8')).toBe(external);
    expect(entity().name).toBe(doc.name);
    expect(savedReviewState()).toEqual(before);
    expect(remote).not.toHaveBeenCalled();
  });

  it('refuses an account switch after reading the real saved bytes without exposing either version', async () => {
    await enrollSavedReviewRecord();
    const bytes = await readFile(path, 'utf8');
    const before = savedReviewState();
    const readBase = publication.readNativeCatalogPublicationBase;
    const realRead = vi
      .spyOn(publication, 'readNativeCatalogPublicationBase')
      .mockImplementationOnce(async (input) => {
        const read = await readBase(input);
        expect(read?.toString('utf8')).toBe(bytes);
        host.accountId = '20000000-0000-4000-8000-000000000099';
        return read;
      });
    vi.mocked(getActiveStoredSession).mockClear();
    const { actions, remote } = savedReviewActions();
    const result = await actions.getOrganizationRegistrySavedRecordReview(
      organizationScope.orgId,
      doc.id
    );
    expect(realRead).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getActiveStoredSession)).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringMatching(/active account changed/i),
    });
    expect(result).not.toHaveProperty('review');
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(savedReviewState()).toEqual(before);
    expect(remote).not.toHaveBeenCalled();
  });
});

const resolutionPublicationContext = () => ({
  db: host.db!,
  runDatabase: <T>(work: () => T): T => work(),
  getActiveAccountId: async () => host.accountId,
});
const resolutionPublicationState = () => ({
  ...savedReviewState(),
  resolutions: host
    .db!.prepare('SELECT * FROM org_registry_record_resolutions ORDER BY resolution_id')
    .all(),
  supersessions: host
    .db!.prepare('SELECT * FROM org_registry_record_publication_supersessions ORDER BY mutation_id')
    .all(),
  links: host.db!.prepare('SELECT * FROM lims_link ORDER BY id').all(),
});

function installResolutionCanonical(
  canonical: Record<string, unknown> & { revision: number },
  generation = accessGeneration
) {
  replaceOrgRegistrySnapshot(host.db!, {
    ...organizationScope,
    cursor: canonical.revision,
    accessGeneration: generation,
    now: canonical.revision + 10,
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
}

async function reviewResolution(
  choice: 'use_remote' | 'keep_saved'
): Promise<RegisteredRecordResolutionRequest> {
  const checked = await readCheckedOrganizationRecordReview(
    host.db!,
    { ...organizationScope, entityId: doc.id },
    async () => {
      if (host.accountId !== organizationScope.accountId)
        throw new Error('The active account changed.');
    }
  );
  const resolutionId = crypto.randomUUID();
  return {
    accountId: organizationScope.accountId,
    orgId: organizationScope.orgId,
    entityId: doc.id,
    resolutionId,
    operationId: `org-record-resolution:${resolutionId}`,
    choice,
    sourceRevision: checked.displayed.sourceRevision,
    review: checked.review,
  };
}

const publishResolution = (
  request: RegisteredRecordResolutionRequest,
  generation = accessGeneration
) =>
  withWorkspaceMutation(root, () =>
    publishReviewedEntityArtifactResolution({
      ...resolutionPublicationContext(),
      request,
      verifiedAccessGeneration: generation,
    })
  );
const resumeResolution = (
  request: RegisteredRecordResolutionRequest,
  generation = accessGeneration
) =>
  withWorkspaceMutation(root, () =>
    resumeReviewedEntityArtifactResolution({
      ...resolutionPublicationContext(),
      resolution: { ...request, verifiedAccessGeneration: generation },
    })
  );
const recordSyncStatus = () =>
  readOrgRegistryRecordSyncStatus(host.db!, {
    accountId: organizationScope.accountId,
    entityId: doc.id,
  });

async function addResolutionRelationships() {
  const peers = ['80000000-0000-4000-8000-000000000071', '90000000-0000-4000-8000-000000000071'];
  for (const id of peers)
    registerLimsEntityInDb(host.db!, {
      id,
      kind: 'strain',
      name: `Related strain ${id}`,
      fields: { genotypeCanonical: 'recA1' },
      workspaceId: 7,
    });
  doc = {
    ...doc,
    relationships: [
      {
        type: 'associated_with',
        fromEntityId: doc.id,
        toEntityId: peers[0],
        payload: { direction: 'outgoing' },
      },
      {
        type: 'associated_with',
        fromEntityId: peers[1],
        toEntityId: doc.id,
        payload: { direction: 'incoming' },
      },
    ],
  };
  for (const relationship of doc.relationships)
    linkLimsEntitiesInDb(host.db!, { ...relationship, workspaceId: 7 });
  await writeFile(path, serializeEntityArtifact(doc));
}

describe('checked organization resolution through real record publication and SQLite', () => {
  it('returns REVIEW_CHANGED when a real saved edit replaces the reviewed file before confirmation', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({ ...canonical, revision: 2, name: 'Organization version' });
    const request = await reviewResolution('use_remote');
    await invoke('lims:updateEntity', { name: 'A newer saved version' });
    const before = resolutionPublicationState();
    const bytes = await readFile(path, 'utf8');
    await expect(publishResolution(request)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(resolutionPublicationState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()
    ).toBe(0);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
  });

  it.each([true, false])(
    'publishes Use organization with archived=%s while preserving identity, locator, pinned schema and both link directions',
    async (archived) => {
      const canonical = await enrollSavedReviewRecord();
      await addResolutionRelationships();
      if (!archived) await invoke('lims:archiveEntity');
      const before = entity();
      const links = host.db!.prepare('SELECT * FROM lims_link ORDER BY id').all();
      const remote = {
        ...canonical,
        revision: 2,
        name: 'Approved organization name',
        fields: { genotypeCanonical: 'recA1 endA1', artifact: doc.fields.artifact },
        registrationStatus: 'tracked',
        domainStatus: 'Reviewed organization state',
        archivedAt: archived ? 100 : null,
      };
      installResolutionCanonical(remote);
      const request = await reviewResolution('use_remote');
      const result = await publishResolution(request);
      expect(result).toMatchObject({
        replayed: false,
        entity: {
          id: doc.id,
          workspaceId: 7,
          registryId: before.registryId,
          kind: before.kind,
          schemaRevisionId: doc.schemaRevisionId,
          name: remote.name,
          fields: remote.fields,
          registrationStatus: remote.registrationStatus,
          domainStatus: remote.domainStatus,
          tombstone: archived,
        },
      });
      const actual = parseEntityArtifact(await readFile(path, 'utf8'));
      expect(actual).toEqual({
        ...doc,
        name: remote.name,
        fields: remote.fields,
        registrationStatus: 'tracked',
        domainStatus: remote.domainStatus,
        archived,
      });
      expect(host.db!.prepare('SELECT * FROM lims_link ORDER BY id').all()).toEqual(links);
      expect(
        host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
      ).toBe(0);
      expect(
        host
          .db!.prepare('SELECT status FROM org_registry_record_resolutions WHERE resolution_id=?')
          .pluck()
          .get(request.resolutionId)
      ).toBe('settled');
      expect(
        readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: Date.now() })
      ).toEqual([]);
      expect(recordSyncStatus()).toMatchObject({
        status: 'synced',
        acknowledgedRevision: 1,
        baseRevision: 2,
        baseProvenance: 'reviewed_remote',
      });
      expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
    }
  );

  it('keeps the saved version with one genuine audited edit and one ready intent based on the explicitly reviewed remote revision', async () => {
    const canonical = await enrollSavedReviewRecord();
    await invoke('lims:updateEntity', {
      name: 'My saved version',
      fields: { genotypeCanonical: 'recA1 endA1' },
    });
    const [oldMutation] = readReadyOrgRegistryRecordMutations(host.db!, {
      ...organizationScope,
      now: 10,
    });
    expect(oldMutation).toBeDefined();
    host.db!.transaction(() => {
      enqueueOrgRegistryMutation(host.db!, { ...organizationScope, ...oldMutation, now: 10 });
      markOrgRegistryRecordMutationQueuedInTx(host.db!, {
        mutationId: oldMutation.mutationId,
        now: 10,
      });
    })();
    installResolutionCanonical({ ...canonical, revision: 2, name: 'Other profile version' });
    markOrgRegistryMutationConflict(host.db!, {
      ...organizationScope,
      mutationId: oldMutation.mutationId,
      code: 'CONFLICT',
      message: 'Revision changed.',
      now: 11,
    });
    const before = entity();
    const beforeBytes = await readFile(path, 'utf8');
    const request = await reviewResolution('keep_saved');
    const result = await publishResolution(request);
    expect(result.entity.eventSeq).toBeGreaterThan(before.eventSeq!);
    expect(result.entity).toMatchObject({
      name: before.name,
      fields: before.fields,
      tombstone: before.tombstone,
    });
    expect(
      host
        .db!.prepare(
          "SELECT event_type FROM lims_audit WHERE subject_id=? AND event_seq>? AND event_type='entity_updated'"
        )
        .all(doc.id, before.eventSeq)
    ).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(beforeBytes);
    const fresh = registeredPublications().filter(
      (row) => row.operation_id === request.operationId
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      status: 'ready',
      publication_authority: 'entity_artifact',
      publication_sha256: bytesSha256(beforeBytes),
      local_event_seq: result.entity.eventSeq,
    });
    const ready = readReadyOrgRegistryRecordMutations(host.db!, {
      ...organizationScope,
      now: Date.now(),
    });
    expect(ready).toEqual([
      {
        clientId: organizationScope.clientId,
        mutationId: fresh[0].mutation_id,
        operation: 'entity.update',
        payload: expect.objectContaining({
          id: doc.id,
          expectedRevision: 2,
          name: before.name,
          fields: before.fields,
        }),
      },
    ]);
    expect(fresh[0].mutation_id).not.toBe(oldMutation.mutationId);
    expect(
      host
        .db!.prepare(
          'SELECT resolution_id FROM org_registry_record_publication_supersessions WHERE mutation_id=?'
        )
        .pluck()
        .get(oldMutation.mutationId)
    ).toBe(request.resolutionId);
    expect(
      host
        .db!.prepare('SELECT status FROM org_registry_conflicts WHERE mutation_id=?')
        .pluck()
        .get(oldMutation.mutationId)
    ).toBe('resolved');
    expect(recordSyncStatus()).toMatchObject({
      status: 'queued',
      acknowledgedRevision: 1,
      baseRevision: 2,
    });
    const settled = resolutionPublicationState();
    expect(await publishResolution(request)).toMatchObject({
      replayed: true,
      entity: result.entity,
    });
    expect(resolutionPublicationState()).toEqual(settled);
    expect(await readFile(path, 'utf8')).toBe(beforeBytes);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('reopens an interrupted post-write publication and resumes the exact durable choice without repeating its edit', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({ ...canonical, revision: 2, name: 'Approved before process exit' });
    const request = await reviewResolution('use_remote');
    vi.spyOn(publication, 'pruneCompletedNativeCatalogPublication').mockRejectedValueOnce(
      new Error('Stopped after bytes were installed')
    );
    await expect(publishResolution(request)).rejects.toThrow('Stopped after bytes were installed');
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe(
      'Approved before process exit'
    );
    const published = entity();
    const pending = resolutionPublicationState();
    expect(recordSyncStatus()).toMatchObject({
      status: 'publication_pending',
      mutationId: request.resolutionId,
    });
    const databasePath = join(root, '.reopened-state.sqlite');
    await host.db!.backup(databasePath);
    host.db!.close();
    host.db = openFileTestDb(databasePath);
    expect(resolutionPublicationState()).toEqual(pending);
    const identity = readReviewedEntityArtifactResolutionIdentity(host.db!, {
      ...request,
      verifiedAccessGeneration: accessGeneration,
    });
    expect(identity).toEqual({
      accountId: request.accountId,
      orgId: request.orgId,
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      operationId: request.operationId,
      choice: request.choice,
      sourceRevision: request.sourceRevision,
    });
    for (const changed of [
      { ...request, choice: 'keep_saved' as const },
      { ...request, sourceRevision: '0'.repeat(64) },
    ]) {
      await expect(resumeResolution(changed)).rejects.toThrow(/different|reused|choice/i);
      expect(resolutionPublicationState()).toEqual(pending);
    }

    await expect(
      withWorkspaceMutation(root, () =>
        recoverEntityArtifactPublications({
          ...resolutionPublicationContext(),
          workspacePath: root,
        })
      )
    ).rejects.toThrow(/verified organization access/i);
    expect(resolutionPublicationState()).toEqual(pending);
    expect(await resumeResolution(request)).toEqual({ replayed: true, entity: published });
    expect(entity()).toEqual(published);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()
    ).toBe(1);
    expect(recordSyncStatus()).toMatchObject({
      status: 'synced',
      acknowledgedRevision: 1,
      baseRevision: 2,
    });
    const settled = resolutionPublicationState();
    expect(await resumeResolution(request)).toEqual({ replayed: true, entity: published });
    expect(resolutionPublicationState()).toEqual(settled);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('retains a blocked publication through revocation and finishes its original approved bytes after a freshly verified regrant', async () => {
    const canonical = await enrollSavedReviewRecord();
    const approved = { ...canonical, revision: 2, name: 'The version explicitly approved' };
    installResolutionCanonical(approved);
    const request = await reviewResolution('use_remote');
    const oldBytes = await readFile(path, 'utf8');
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Stopped before publication')
    );
    await expect(publishResolution(request)).rejects.toThrow('Stopped before publication');
    expect(await readFile(path, 'utf8')).toBe(oldBytes);
    const published = entity();
    revokeOrgRegistryCache(host.db!, { ...organizationScope, now: 30 });
    const revoked = resolutionPublicationState();
    await expect(resumeResolution(request)).rejects.toThrow(/access|scope/i);
    expect(() =>
      readReviewedEntityArtifactResolutionIdentity(host.db!, {
        ...request,
        verifiedAccessGeneration: accessGeneration,
      })
    ).toThrow(/access|scope/i);
    expect(() => recordSyncStatus()).toThrow(/access/i);
    expect(resolutionPublicationState()).toEqual(revoked);
    expect(await readFile(path, 'utf8')).toBe(oldBytes);
    const regrantedGeneration = `home-v1:${'8'.repeat(64)}`;
    installResolutionCanonical(
      { ...approved, revision: 3, name: 'Newer unapproved organization change' },
      regrantedGeneration
    );
    const regranted = resolutionPublicationState();
    await expect(resumeResolution(request)).rejects.toThrow(/access/i);
    expect(resolutionPublicationState()).toEqual(regranted);
    expect(await resumeResolution(request, regrantedGeneration)).toEqual({
      replayed: true,
      entity: published,
    });
    expect(parseEntityArtifact(await readFile(path, 'utf8'))).toEqual({
      ...doc,
      name: approved.name,
    });
    expect(entity()).toEqual(published);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()
    ).toBe(1);
    expect(
      host
        .db!.prepare(
          'SELECT review_json FROM org_registry_record_resolutions WHERE resolution_id=?'
        )
        .pluck()
        .get(request.resolutionId)
    ).toBe(JSON.stringify(request.review));
    expect(recordSyncStatus()).toMatchObject({
      status: 'remote_changes',
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    expect(
      readReadyOrgRegistryRecordMutations(host.db!, { ...organizationScope, now: Date.now() })
    ).toEqual([]);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('refuses incompatible organization artifact metadata before committing a resolution, audit event or byte', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({
      ...canonical,
      revision: 2,
      name: 'Wrong locator',
      fields: {
        ...doc.fields,
        artifact: {
          schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
          relativePath: 'records/another.entity.json',
        },
      },
    });
    const request = await reviewResolution('use_remote');
    const before = resolutionPublicationState();
    const bytes = await readFile(path, 'utf8');
    await expect(publishResolution(request)).rejects.toThrow(/saved-file|location|artifact/i);
    expect(resolutionPublicationState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});

function savedRecordHomeListing(
  role: 'editor' | 'viewer' | 'manager' = 'editor'
): WorkspaceSyncAccessListing {
  return {
    workspaceId: registeredRemoteHome,
    displayName: 'Owned project',
    viewer: { role, sources: [{ kind: 'direct', role, orgId: null }] },
    canManage: role === 'manager',
    owner: {
      kind: 'org',
      orgId: organizationScope.orgId,
      slug: 'registry-test',
      displayName: 'Registry test organization',
    },
    admins: [],
    grants: [],
    invites: [],
  };
}

describe('public checked resolution account and project-lease boundary', () => {
  it('waits for replica finalization and applies the same approved saved version once', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({ ...canonical, revision: 2, name: 'Approved across finalization' });
    const request = await reviewResolution('use_remote');
    const before = resolutionPublicationState();
    const bytes = await readFile(path, 'utf8');
    let releaseFence: (() => void) | undefined;
    let firstRefresh = true;
    const refresh = vi.fn(async () => {
      if (firstRefresh) {
        firstRefresh = false;
        releaseFence = await acquireWorkspaceSyncDatabaseFence(host.db!);
      }
      return { status: 'ready' as const, cursor: 2, pendingCount: 0, conflictCount: 0 };
    });
    const readHomeAccess = vi.fn(async () => savedRecordHomeListing());
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    const pending = actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      sourceRevision: request.sourceRevision,
      choice: request.choice,
    });
    try {
      await vi.waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(1));
      expect(resolutionPublicationState()).toEqual(before);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    } finally {
      releaseFence?.();
      await pending;
    }
    expect(await pending).toMatchObject({
      ok: true,
      replayed: false,
      entity: { id: doc.id, name: 'Approved across finalization', workspaceId: 7 },
    });
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe(
      'Approved across finalization'
    );
    expect(
      host.db!.prepare('SELECT resolution_id,status FROM org_registry_record_resolutions').all()
    ).toEqual([{ resolution_id: request.resolutionId, status: 'settled' }]);
    expect(readHomeAccess).toHaveBeenCalledWith(registeredRemoteHome, organizationScope.accountId);
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('resumes a fence-interrupted approval after installing bytes without repeating its edit', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({
      ...canonical,
      revision: 2,
      name: 'Installed before finalization',
    });
    const request = await reviewResolution('use_remote');
    let releaseFence: (() => void) | undefined;
    vi.spyOn(publication, 'pruneCompletedNativeCatalogPublication').mockImplementationOnce(
      async () => {
        releaseFence = await acquireWorkspaceSyncDatabaseFence(host.db!);
        throw new Error(WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE);
      }
    );
    let resumed!: () => void;
    const resumedRefresh = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    let refreshCount = 0;
    const refresh = vi.fn(async () => {
      if (++refreshCount > 1) resumed();
      return { status: 'ready' as const, cursor: 2, pendingCount: 0, conflictCount: 0 };
    });
    const { actions, remote } = savedReviewActions(refresh, async () => savedRecordHomeListing());
    const pending = actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      sourceRevision: request.sourceRevision,
      choice: request.choice,
    });
    let installedSnapshot: string | undefined;
    try {
      await Promise.race([
        resumedRefresh,
        pending.then(() => {
          throw new Error('Resolution finished before its fenced retry checkpoint.');
        }),
      ]);
      expect(refresh.mock.calls.length).toBeGreaterThan(1);
      expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe(
        'Installed before finalization'
      );
      installedSnapshot = snapshot();
    } finally {
      releaseFence?.();
      await pending;
    }
    expect(await pending).toMatchObject({
      ok: true,
      replayed: true,
      entity: { id: doc.id, name: 'Installed before finalization', workspaceId: 7 },
    });
    expect(snapshot()).toBe(installedSnapshot);
    expect(
      host.db!.prepare('SELECT resolution_id,status FROM org_registry_record_resolutions').all()
    ).toEqual([{ resolution_id: request.resolutionId, status: 'settled' }]);
    expect(recordSyncStatus()).toMatchObject({
      status: 'synced',
      baseRevision: 2,
      acknowledgedRevision: 1,
    });
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('refuses an account change while an approved operation waits for replica finalization', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({
      ...canonical,
      revision: 2,
      name: 'Never applied after account switch',
    });
    const request = await reviewResolution('use_remote');
    const before = resolutionPublicationState();
    const bytes = await readFile(path, 'utf8');
    let releaseFence: (() => void) | undefined;
    let firstRefresh = true;
    const refresh = vi.fn(async () => {
      if (firstRefresh) {
        firstRefresh = false;
        releaseFence = await acquireWorkspaceSyncDatabaseFence(host.db!);
      }
      return { status: 'ready' as const, cursor: 2, pendingCount: 0, conflictCount: 0 };
    });
    const readHomeAccess = vi.fn(async () => savedRecordHomeListing());
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    const pending = actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      sourceRevision: request.sourceRevision,
      choice: request.choice,
    });
    try {
      await vi.waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(1));
      host.accountId = '20000000-0000-4000-8000-000000000099';
    } finally {
      releaseFence?.();
      await pending;
    }
    expect(await pending).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringMatching(/account changed/i),
    });
    expect(resolutionPublicationState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(readHomeAccess).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it('refreshes verified access before taking the owning project lease, then publishes actual bytes', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({ ...canonical, revision: 2, name: 'Approved public action' });
    const request = await reviewResolution('use_remote');
    const refresh = vi.fn(async () => {
      const release = tryAcquireWorkspaceMutationShared(root);
      try {
        expect(release).not.toBeNull();
      } finally {
        release?.();
      }
      return { status: 'ready' as const, cursor: 2, pendingCount: 0, conflictCount: 0 };
    });
    const readHomeAccess = vi.fn(async () => savedRecordHomeListing());
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    const result = await actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      sourceRevision: request.sourceRevision,
      choice: request.choice,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readHomeAccess).toHaveBeenCalledWith(registeredRemoteHome, organizationScope.accountId);
    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      entity: {
        id: doc.id,
        name: 'Approved public action',
        workspaceId: 7,
      },
    });
    expect(parseEntityArtifact(await readFile(path, 'utf8')).name).toBe('Approved public action');
    expect(recordSyncStatus()).toMatchObject({
      status: 'synced',
      baseRevision: 2,
      acknowledgedRevision: 1,
    });
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('refuses an account switch during the actual action refresh before changing bytes, local history or durable resolution intent', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({
      ...canonical,
      revision: 2,
      name: 'Never applied to another account',
    });
    const request = await reviewResolution('use_remote');
    const before = resolutionPublicationState();
    const bytes = await readFile(path, 'utf8');
    const refresh = vi.fn(async () => {
      await Promise.resolve();
      host.accountId = '20000000-0000-4000-8000-000000000099';
      return { status: 'ready' as const, cursor: 2, pendingCount: 0, conflictCount: 0 };
    });
    const readHomeAccess = vi.fn(async () => savedRecordHomeListing());
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    expect(
      await actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
        entityId: request.entityId,
        resolutionId: request.resolutionId,
        sourceRevision: request.sourceRevision,
        choice: request.choice,
      })
    ).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringMatching(/account changed/i),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(resolutionPublicationState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()
    ).toBe(0);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(remote).not.toHaveBeenCalled();
  });
});

describe('authoritative home access before explicit resolution replay', () => {
  it('records editor-to-viewer demotion without publishing bytes, adding an edit, or discarding the pending approval', async () => {
    const canonical = await enrollSavedReviewRecord();
    const approved = { ...canonical, revision: 2, name: 'Approved before the role changed' };
    installResolutionCanonical(approved);
    const request = await reviewResolution('use_remote');
    const originalBytes = await readFile(path, 'utf8');
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Stopped before the approved file was installed')
    );
    await expect(publishResolution(request)).rejects.toThrow(
      'Stopped before the approved file was installed'
    );
    expect(await readFile(path, 'utf8')).toBe(originalBytes);
    expect(
      host
        .db!.prepare('SELECT access_role FROM workspace_sync_bindings WHERE workspace_id=7')
        .pluck()
        .get()
    ).toBe('editor');

    const viewerGeneration = `home-v1:${'9'.repeat(64)}`;
    installResolutionCanonical(approved, viewerGeneration);
    const before = resolutionPublicationState();
    const refresh = vi.fn(async () => ({
      status: 'ready' as const,
      cursor: 2,
      pendingCount: 0,
      conflictCount: 0,
    }));
    const readHomeAccess = vi.fn(async () => savedRecordHomeListing('viewer'));
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    const result = await actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      sourceRevision: request.sourceRevision,
      choice: request.choice,
    });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/read.?only|write|viewer|access/i),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readHomeAccess).toHaveBeenCalledWith(registeredRemoteHome, organizationScope.accountId);
    expect(
      host
        .db!.prepare('SELECT access_role FROM workspace_sync_bindings WHERE workspace_id=7')
        .pluck()
        .get()
    ).toBe('viewer');
    expect(resolutionPublicationState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(originalBytes);
    expect(
      host
        .db!.prepare(
          'SELECT status,review_json,publication_operation_id FROM org_registry_record_resolutions WHERE resolution_id=?'
        )
        .get(request.resolutionId)
    ).toEqual({
      status: 'publication_pending',
      review_json: JSON.stringify(request.review),
      publication_operation_id: request.operationId,
    });
    expect(
      host.db!.prepare('SELECT operation_id FROM native_catalog_publication_outbox').all()
    ).toEqual([{ operation_id: request.operationId }]);
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});

describe('pending resolution identity and concurrent home observations', () => {
  it('returns the original pending request to a cached viewer after restart and exact-resumes it with a freshly verified manager regrant', async () => {
    const canonical = await enrollSavedReviewRecord();
    const approved = { ...canonical, revision: 2, name: 'Approved before the viewer interval' };
    installResolutionCanonical(approved);
    const request = await reviewResolution('use_remote');
    const originalBytes = await readFile(path, 'utf8');
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Stopped before the approved file was installed')
    );
    await expect(publishResolution(request)).rejects.toThrow(
      'Stopped before the approved file was installed'
    );
    const committedEntity = entity();
    expect(await readFile(path, 'utf8')).toBe(originalBytes);
    updateWorkspaceSyncAccessRecord(host.db!, {
      workspaceId: 7,
      role: 'viewer',
      source: 'direct',
      nowMs: 30,
    });
    const viewerGeneration = `home-v1:${'8'.repeat(64)}`;
    installResolutionCanonical(approved, viewerGeneration);
    const databasePath = join(root, '.viewer-restart.sqlite');
    await host.db!.backup(databasePath);
    host.db!.close();
    host.db = openFileTestDb(databasePath);
    const beforeRead = resolutionPublicationState();
    const managerGeneration = `home-v1:${'9'.repeat(64)}`;
    const refresh = vi.fn(async () => {
      installResolutionCanonical(approved, managerGeneration);
      return { status: 'ready' as const, cursor: 2, pendingCount: 0, conflictCount: 0 };
    });
    const readHomeAccess = vi.fn(async () => savedRecordHomeListing('manager'));
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    const status = await actions.getOrganizationRegistryRecordSyncStatus(doc.id);
    expect(status).toMatchObject({
      ok: true,
      accountId: organizationScope.accountId,
      status: {
        status: 'publication_pending',
        pendingResolution: {
          entityId: request.entityId,
          resolutionId: request.resolutionId,
          sourceRevision: request.sourceRevision,
          choice: request.choice,
        },
      },
    });
    expect(resolutionPublicationState()).toEqual(beforeRead);
    expect(await readFile(path, 'utf8')).toBe(originalBytes);
    expect(refresh).not.toHaveBeenCalled();
    expect(readHomeAccess).not.toHaveBeenCalled();
    if (!status.ok || !status.status?.pendingResolution)
      throw new Error('The readable pending approval was not returned.');

    const result = await actions.resolveOrganizationRegistrySavedRecord(
      organizationScope.orgId,
      status.status.pendingResolution
    );
    expect(result).toEqual({ ok: true, replayed: true, entity: committedEntity });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readHomeAccess).toHaveBeenCalledWith(registeredRemoteHome, organizationScope.accountId);
    expect(
      host
        .db!.prepare('SELECT access_role FROM workspace_sync_bindings WHERE workspace_id=7')
        .pluck()
        .get()
    ).toBe('manager');
    expect(parseEntityArtifact(await readFile(path, 'utf8'))).toEqual({
      ...doc,
      name: approved.name,
    });
    expect(entity()).toEqual(committedEntity);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()
    ).toBe(1);
    expect(
      host
        .db!.prepare(
          'SELECT status,review_json,publication_operation_id FROM org_registry_record_resolutions WHERE resolution_id=?'
        )
        .get(request.resolutionId)
    ).toEqual({
      status: 'settled',
      review_json: JSON.stringify(request.review),
      publication_operation_id: request.operationId,
    });
    expect(recordSyncStatus()).toMatchObject({
      status: 'synced',
      acknowledgedRevision: 1,
      baseRevision: 2,
      baseProvenance: 'reviewed_remote',
    });
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });

  it('retains a newer viewer observation when a delayed older editor listing returns and refuses before publication', async () => {
    const canonical = await enrollSavedReviewRecord();
    installResolutionCanonical({
      ...canonical,
      revision: 2,
      name: 'Not authorized by stale access',
    });
    const request = await reviewResolution('use_remote');
    const before = resolutionPublicationState();
    const bytes = await readFile(path, 'utf8');
    const refresh = vi.fn(async () => ({
      status: 'ready' as const,
      cursor: 2,
      pendingCount: 0,
      conflictCount: 0,
    }));
    const readHomeAccess = vi.fn(async () => {
      updateWorkspaceSyncAccessRecord(host.db!, {
        workspaceId: 7,
        role: 'viewer',
        source: 'direct',
        nowMs: 30,
      });
      return savedRecordHomeListing('editor');
    });
    const { actions, remote } = savedReviewActions(refresh, readHomeAccess);
    const result = await actions.resolveOrganizationRegistrySavedRecord(organizationScope.orgId, {
      entityId: request.entityId,
      resolutionId: request.resolutionId,
      sourceRevision: request.sourceRevision,
      choice: request.choice,
    });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/changed|access|home/i),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readHomeAccess).toHaveBeenCalledWith(registeredRemoteHome, organizationScope.accountId);
    expect(
      host
        .db!.prepare(
          'SELECT access_role,access_source,updated_at FROM workspace_sync_bindings WHERE workspace_id=7'
        )
        .get()
    ).toEqual({ access_role: 'viewer', access_source: 'direct', updated_at: 30 });
    expect(resolutionPublicationState()).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM org_registry_record_resolutions').pluck().get()
    ).toBe(0);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
    expect(remote).not.toHaveBeenCalled();
    expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
  });
});
