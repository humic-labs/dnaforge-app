import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeCatalogRecordReconcileRequest } from '../shared/workspace-browser-types';
import { isDeepStrictEqual } from 'node:util';
import {
  parseNativeWorkspaceManifest,
  NATIVE_WORKSPACE_MANIFEST_PATH,
  nativeWorkspaceUsesAtomicSequenceProjection,
  type NativeWorkspaceManifest,
  type NativeWorkspaceManifestEntityV2,
} from '../shared/native-workspace-manifest';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { mapPortableRecordRelationships } from '../shared/portable-record-relationships';
import {
  limsEntityFromRow,
  limsLinkFromRow,
  parseLimsSchemaFields,
  recordRegistrationStatus,
  type LimsEntity,
  type LimsEntityRow,
  type LimsLink,
  type LimsLinkRow,
  type LimsAuditRow,
} from '../shared/lims';
import {
  allocateRegistryIdInsideTx,
  assertEntityValid,
  assertRelationshipTypeExists,
  getSchemaRevisionForEntity,
  insertAuditEvent,
  LINEAGE_RELATIONSHIP_TYPES,
  materializeEntitySchemaSnapshotInsideTx,
  nextEventSeq,
  resolveSchemaRevisionForKind,
  seedLimsBuiltinsInDb,
  upsertLimsEntityProjectionInsideTx,
  upsertLimsLinkProjectionInsideTx,
  wouldCreateRelationshipCycle,
} from './lims-engine-core';
import { replayAuditRowsIntoProjection } from './lims-projection-rebuild';
import { upsertProviderBinding } from './catalog-provider-bindings';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';
import { nativeLimsEndpointPresent } from './native-workspace-reconcile-graph';
import { ownsNativeRecordFieldGraphRow } from './native-record-field-graph';
import { acceptedScientificResourceIds } from './scientific-strain-authority';
import {
  reconcileNativeFileSequencesInsideTx,
  reconcileNativeSequenceLinksInsideTx,
} from './native-file-sequence-reconcile';

type Workspace = { id: number; repo_uuid: string | null; path: string };
type PreviousRecordPlacement = { status: string; updated_at: number };
type NativeCatalogRecordPlacement = Extract<
  NativeWorkspaceManifestEntityV2['placement'],
  { kind: 'catalog-record' }
>;

export function reconcileNativeCatalogRecordsFromFile(
  db: Database.Database,
  input: NativeCatalogRecordReconcileRequest
): number {
  const path = join(input.workspaceRoot, NATIVE_WORKSPACE_MANIFEST_PATH);
  const readCurrent = () => {
    assertWorkspaceProjectionPathSafe(input.workspaceRoot, path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error('Native catalog must be a regular file below 32 MiB.');
      const buffer = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = readSync(fd, buffer, count, buffer.length - count, null);
        if (read === 0) break;
        count += read;
      }
      if (count !== stat.size) throw new Error('Native catalog changed during reconstruction.');
      const bytes = buffer.subarray(0, count);
      if (
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        input.expectedManifestSha256
      )
        throw new Error(
          'Native catalog changed since project reconciliation started. Retry opening it.'
        );
      return bytes;
    } finally {
      closeSync(fd);
    }
  };
  const manifest = parseNativeWorkspaceManifest(readCurrent().toString('utf8'));
  return db.transaction(() => {
    const count = reconcileNativeCatalogRecordsInsideTx(db, input.workspaceRoot, manifest);
    readCurrent();
    return count;
  })();
}

export function reconcileNativeCatalogRecordsInsideTx(
  db: Database.Database,
  workspacePath: string,
  manifest: NativeWorkspaceManifest
): number {
  if (!db.inTransaction) throw new Error('Native record reconstruction requires a transaction.');
  assertLimsSafetyNotQuarantined(db);
  const workspace = db
    .prepare(
      'SELECT id, repo_uuid, path FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL'
    )
    .get(workspacePath) as Workspace | undefined;
  if (!workspace) throw new Error('Native record project is not registered.');
  if (manifest.schema !== 'dnaforge.native-workspace-manifest.v2') return 0;
  const accepted = acceptedScientificResourceIds(db, workspace.id);
  const scope = workspaceScopeKey(workspace.repo_uuid, workspace.id);
  const records = manifest.entities.filter(
    (entity) =>
      entity.type === 'record' &&
      !accepted.has(entity.id) &&
      !accepted.has(scopedProjectionId(scope, entity.id))
  );
  if (!records.length && !manifest.entities.some(nativeWorkspaceUsesAtomicSequenceProjection))
    return 0;
  seedLimsBuiltinsInDb(db);
  const sequences = reconcileNativeFileSequencesInsideTx(db, workspacePath, workspace, manifest);
  reconcileNativeSequenceLinksInsideTx(db, workspace, manifest);
  if (!records.length) return sequences;
  const ids = new Map(
    manifest.entities.map((entity) => [
      entity.id,
      accepted.has(entity.id) ? entity.id : scopedProjectionId(scope, entity.id),
    ])
  );
  const entityId = (raw: string) => {
    const id = ids.get(raw);
    if (!id) throw new Error(`Native record relationship target is unknown: ${raw}`);
    return id;
  };
  const recordIds = new Set(records.map((record) => entityId(record.id)));

  const placements = new Map<string, PreviousRecordPlacement>();
  for (const record of records) {
    const id = entityId(record.id);
    const prior = db
      .prepare('SELECT status, updated_at FROM catalog_workspace_placements WHERE entity_id = ?')
      .get(id) as { status: string; updated_at: number } | undefined;
    if (prior) placements.set(id, prior);
    db.prepare("UPDATE catalog_workspace_placements SET status = 'hidden' WHERE entity_id = ?").run(
      id
    );
  }
  for (const record of records) {
    const id = entityId(record.id);
    projectCatalogRecord(db, workspace, record, id, placements.get(id));
    projectLimsRecord(db, workspace, record, id, entityId);
    for (const identity of record.sourceIdentities ?? []) {
      upsertProviderBinding(db, {
        reference: {
          provider: identity.provider,
          stableObjectId: identity.stableObjectId,
          objectClass: identity.objectClass,
          providerAccountHint: identity.providerAccountHint ?? null,
          canonicalUrl: identity.canonicalUrl ?? null,
        },
        entityId: id,
        bindingKind: identity.bindingKind,
        evidence: { source: '.forge/catalog.json' },
      });
    }
  }
  projectRecordGraph(db, workspace, manifest, recordIds, entityId, scope);
  return records.length + sequences;
}

function projectCatalogRecord(
  db: Database.Database,
  workspace: Workspace,
  record: NativeWorkspaceManifestEntityV2,
  id: string,
  previousPlacement?: PreviousRecordPlacement
): void {
  if (
    record.placement.kind !== 'catalog-record' ||
    !record.lims ||
    record.lims.schemaSnapshot?.baseKind !== 'record'
  )
    throw new Error('Native record requires a pinned schema and catalog placement.');
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM catalog_entities WHERE id = ?').get(id) as
    | {
        type: string;
        workspace_id: number;
        locator: string;
        name: string;
        status: string;
        metadata: string | null;
        updated_at: number;
      }
    | undefined;
  const locator = `entity://lims/${id}`;
  if (
    existing &&
    (existing.type !== 'record' ||
      existing.workspace_id !== workspace.id ||
      existing.locator !== locator)
  )
    throw new Error(`Native record identity is owned by another type or workspace: ${id}`);
  const status = record.lifecycle?.state === 'archived' ? 'archived' : 'active';
  const metadata = {
    ...record.metadata,
    ...(record.migrationSource ? { migrationSource: record.migrationSource } : {}),
    portableId: record.id,
    placement: record.placement,
  };
  const unchanged =
    existing &&
    existing.name === record.name &&
    existing.status === status &&
    isDeepStrictEqual(JSON.parse(existing.metadata ?? '{}'), metadata);
  db.prepare(
    `INSERT INTO catalog_entities (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
    VALUES (?,'record',?,?,'database',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,metadata=excluded.metadata,updated_at=excluded.updated_at`
  ).run(
    id,
    record.name,
    locator,
    status,
    workspace.id,
    JSON.stringify(metadata),
    now,
    unchanged ? existing.updated_at : now
  );
  projectNativeCatalogRecordPlacement(
    db,
    workspace.id,
    id,
    record.placement,
    status,
    now,
    previousPlacement
  );
}

function projectNativeCatalogRecordPlacement(
  db: Database.Database,
  workspaceId: number,
  entityId: string,
  placement: NativeCatalogRecordPlacement,
  recordStatus: 'active' | 'archived',
  now: number,
  previous?: PreviousRecordPlacement
): void {
  const placementStatus = recordStatus === 'archived' ? 'hidden' : 'active';
  const current = db
    .prepare('SELECT * FROM catalog_workspace_placements WHERE entity_id = ?')
    .get(entityId) as
    | {
        workspace_id: number;
        parent_relative_path: string;
        display_name: string;
        presentation_kind: string;
      }
    | undefined;
  const samePlacement =
    current &&
    current.workspace_id === workspaceId &&
    current.parent_relative_path === placement.parentRelativePath &&
    current.display_name === placement.displayName &&
    current.presentation_kind === placement.presentationKind &&
    previous?.status === placementStatus;
  db.prepare(
    `INSERT INTO catalog_workspace_placements (entity_id,workspace_id,parent_relative_path,display_name,normalized_sibling_name,presentation_kind,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET workspace_id=excluded.workspace_id,parent_relative_path=excluded.parent_relative_path,display_name=excluded.display_name,normalized_sibling_name=excluded.normalized_sibling_name,presentation_kind=excluded.presentation_kind,status=excluded.status,updated_at=excluded.updated_at`
  ).run(
    entityId,
    workspaceId,
    placement.parentRelativePath,
    placement.displayName,
    placement.displayName.normalize('NFC').toLowerCase(),
    placement.presentationKind,
    placementStatus,
    now,
    samePlacement ? previous.updated_at : now
  );
}

function projectLimsRecord(
  db: Database.Database,
  workspace: Workspace,
  record: NativeWorkspaceManifestEntityV2,
  id: string,
  entityId: (raw: string) => string
): void {
  const lims = record.lims;
  if (!lims || lims.schemaSnapshot?.baseKind !== 'record')
    throw new Error('Native record schema is missing.');
  materializeEntitySchemaSnapshotInsideTx(db, {
    ...lims,
    id,
    workspaceId: workspace.id,
    actor: 'workspace-reconcile',
  });
  let row = db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(id) as
    | LimsEntityRow
    | undefined;
  if (!row) {
    const history = db
      .prepare(
        "SELECT * FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=? ORDER BY event_seq"
      )
      .all(id) as LimsAuditRow[];
    replayAuditRowsIntoProjection(db, history);
    row = db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(id) as LimsEntityRow | undefined;
  }
  if (
    row &&
    (row.workspace_id !== workspace.id ||
      parseLimsSchemaFields(getSchemaRevisionForEntity(db, row).fieldsJson).baseKind !== 'record')
  )
    throw new Error('Native record identity has incompatible scientific ownership.');
  const existing = row ? limsEntityFromRow(row) : null;
  const schema = resolveSchemaRevisionForKind(db, lims.kind, lims.schemaRevisionId);
  const fields = mapPortableRecordRelationships(lims.fields, lims.schemaSnapshot, entityId);
  const { incomplete } = assertEntityValid(lims.kind, fields, schema.fieldsJson);
  const now = Date.now();
  const state = {
    kind: lims.kind,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.revisionId,
    name: lims.name,
    fields,
    registrationStatus: recordRegistrationStatus(
      lims.registrationStatus ?? 'registered',
      incomplete.length > 0
    ),
    domainStatus: lims.domainStatus ?? null,
    workspaceId: workspace.id,
    tombstone: record.lifecycle?.state === 'archived',
    archivedAt: record.lifecycle?.state === 'archived' ? record.lifecycle.archivedAt : null,
  };
  if (
    existing &&
    Object.entries(state).every(([key, value]) =>
      isDeepStrictEqual(existing[key as keyof LimsEntity], value)
    )
  )
    return;
  const after: LimsEntity = {
    ...state,
    id,
    registryId: existing ? existing.registryId : allocateRegistryIdInsideTx(db, lims.kind, now),
    createdAt: existing?.createdAt ?? lims.createdAt ?? now,
    updatedAt: now,
    eventSeq: nextEventSeq(db),
    actor: 'workspace-reconcile',
  };
  insertAuditEvent(db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: existing ? 'entity_updated' : 'entity_registered',
    subjectTable: 'lims_entity',
    subjectId: id,
    workspaceId: workspace.id,
    actor: after.actor,
    before: existing,
    after,
  });
  upsertLimsEntityProjectionInsideTx(db, after);
}

function projectRecordGraph(
  db: Database.Database,
  workspace: Workspace,
  manifest: NativeWorkspaceManifest,
  recordIds: Set<string>,
  entityId: (raw: string) => string,
  scope: string | null
): void {
  const portableById = new Map(manifest.entities.map((entity) => [entity.id, entity]));
  const desiredCatalog = new Set(
    manifest.links.map((link) =>
      recordGraphTuple(entityId(link.sourceId), link.relation, entityId(link.targetId))
    )
  );
  const desiredLims = new Set(
    (manifest.limsLinks ?? []).map((link) =>
      recordGraphTuple(entityId(link.fromEntityId), link.type, entityId(link.toEntityId))
    )
  );
  removeStaleCatalogRelationships(db, workspace, recordIds, desiredCatalog);
  removeStaleRegistryRelationships(db, workspace, recordIds, desiredLims);
  for (const link of manifest.links) {
    projectCatalogRelationship(db, workspace, recordIds, entityId, desiredCatalog, link);
  }
  const registryContext: ProjectRegistryGraphContext = {
    db,
    workspace,
    manifest,
    recordIds,
    entityId,
    scope,
    portableById,
    desiredLims,
  };
  for (const link of manifest.limsLinks ?? []) {
    projectRegistryRelationship(registryContext, link);
  }
}

type CatalogGraphRow = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  evidence: string | null;
  confidence: string;
};

function recordGraphOwns(recordIds: ReadonlySet<string>, from: string, to: string): boolean {
  return recordIds.has(from) || recordIds.has(to);
}

function recordGraphTuple(from: string, type: string, to: string): string {
  return JSON.stringify([from, type, to]);
}

function requireRecordGraphEndpoint(
  db: Database.Database,
  workspace: Workspace,
  id: string,
  table: 'catalog_entities' | 'lims_entity'
): void {
  const row = db.prepare(`SELECT workspace_id FROM ${table} WHERE id=?`).get(id) as
    | { workspace_id: number }
    | undefined;
  if (!row || row.workspace_id !== workspace.id)
    throw new Error('Native record relationship endpoint is not in this workspace.');
}

function removeStaleCatalogRelationships(
  db: Database.Database,
  workspace: Workspace,
  recordIds: ReadonlySet<string>,
  desiredCatalog: ReadonlySet<string>
): void {
  const catalogRows = db
    .prepare(
      `SELECT l.* FROM catalog_entity_links l JOIN catalog_entities f ON f.id=l.source_entity_id JOIN catalog_entities t ON t.id=l.target_entity_id WHERE f.workspace_id=? AND t.workspace_id=?`
    )
    .all(workspace.id, workspace.id) as CatalogGraphRow[];
  for (const row of catalogRows) {
    if (
      !recordGraphOwns(recordIds, row.source_entity_id, row.target_entity_id) ||
      desiredCatalog.has(recordGraphTuple(row.source_entity_id, row.relation, row.target_entity_id))
    )
      continue;
    if (!canRemoveProjectedRelationship(db, 'catalog_entity_links', row.id, catalogGraphState(row)))
      continue;
    insertAuditEvent(db, {
      eventType: 'catalog_relationship_removed',
      subjectTable: 'catalog_entity_links',
      subjectId: row.id,
      workspaceId: workspace.id,
      actor: 'workspace-reconcile',
      before: row,
    });
    db.prepare('DELETE FROM catalog_entity_links WHERE id=?').run(row.id);
  }
}

function removeStaleRegistryRelationships(
  db: Database.Database,
  workspace: Workspace,
  recordIds: ReadonlySet<string>,
  desiredLims: ReadonlySet<string>
): void {
  const limsRows = db
    .prepare(
      `SELECT l.* FROM lims_link l JOIN lims_entity f ON f.id=l.from_entity_id JOIN lims_entity t ON t.id=l.to_entity_id WHERE f.workspace_id=? AND t.workspace_id=? AND l.tombstone=0`
    )
    .all(workspace.id, workspace.id) as LimsLinkRow[];
  for (const row of limsRows) {
    if (
      !recordGraphOwns(recordIds, row.from_entity_id, row.to_entity_id) ||
      desiredLims.has(recordGraphTuple(row.from_entity_id, row.type, row.to_entity_id))
    )
      continue;
    const before = limsLinkFromRow(row);
    if (!canRemoveProjectedRelationship(db, 'lims_link', row.id, before)) continue;
    const now = Date.now();
    const after: LimsLink = {
      ...before,
      tombstone: true,
      archivedAt: now,
      updatedAt: now,
      eventSeq: nextEventSeq(db),
      actor: 'workspace-reconcile',
    };
    insertAuditEvent(db, {
      eventSeq: after.eventSeq ?? undefined,
      eventType: 'link_tombstoned',
      subjectTable: 'lims_link',
      subjectId: after.id,
      workspaceId: workspace.id,
      actor: after.actor,
      before,
      after,
    });
    upsertLimsLinkProjectionInsideTx(db, after);
  }
}

function projectCatalogRelationship(
  db: Database.Database,
  workspace: Workspace,
  recordIds: ReadonlySet<string>,
  entityId: (raw: string) => string,
  desiredCatalog: Set<string>,
  link: NativeWorkspaceManifest['links'][number]
): void {
  const from = entityId(link.sourceId);
  const to = entityId(link.targetId);
  if (!recordGraphOwns(recordIds, from, to)) return;
  requireRecordGraphEndpoint(db, workspace, from, 'catalog_entities');
  requireRecordGraphEndpoint(db, workspace, to, 'catalog_entities');
  desiredCatalog.add(recordGraphTuple(from, link.relation, to));
  const before = db
    .prepare(
      'SELECT * FROM catalog_entity_links WHERE source_entity_id=? AND relation=? AND target_entity_id=?'
    )
    .get(from, link.relation, to) as CatalogGraphRow | undefined;
  if (
    before &&
    before.confidence === (link.confidence ?? 'confirmed') &&
    isDeepStrictEqual(JSON.parse(before.evidence ?? 'null'), link.evidence ?? null)
  )
    return;
  if (
    before &&
    !ownsNativeRecordFieldGraphRow(db, 'catalog_entity_links', before.id, catalogGraphState(before))
  )
    throw new Error('Preserve the locally changed catalog relationship before reconstructing it.');
  const now = Date.now();
  const id = before?.id ?? randomUUID();
  const after = {
    id,
    source_entity_id: from,
    relation: link.relation,
    target_entity_id: to,
    confidence: link.confidence ?? 'confirmed',
    evidence: link.evidence ?? null,
  };
  insertAuditEvent(db, {
    eventType: 'catalog_relationship_projected',
    subjectTable: 'catalog_entity_links',
    subjectId: id,
    workspaceId: workspace.id,
    actor: 'workspace-reconcile',
    before,
    after,
  });
  db.prepare(
    `INSERT INTO catalog_entity_links (id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence,evidence=excluded.evidence,updated_at=excluded.updated_at`
  ).run(
    id,
    from,
    link.relation,
    to,
    after.confidence,
    after.evidence === null ? null : JSON.stringify(after.evidence),
    now,
    now
  );
}

type ProjectRegistryGraphContext = {
  db: Database.Database;
  workspace: Workspace;
  manifest: NativeWorkspaceManifest;
  recordIds: ReadonlySet<string>;
  entityId: (raw: string) => string;
  scope: string | null;
  portableById: ReadonlyMap<string, NativeWorkspaceManifest['entities'][number]>;
  desiredLims: Set<string>;
};

type RegistryGraphEndpoints = { from: string; to: string };

function resolveRegistryGraphEndpoints(
  context: ProjectRegistryGraphContext,
  link: NonNullable<NativeWorkspaceManifest['limsLinks']>[number]
): RegistryGraphEndpoints | null {
  const from = context.entityId(link.fromEntityId);
  const to = context.entityId(link.toEntityId);
  if (!recordGraphOwns(context.recordIds, from, to)) return null;
  const fromPresent = nativeLimsEndpointPresent(
    context.db,
    context.workspace,
    context.portableById.get(link.fromEntityId),
    from
  );
  const toPresent = nativeLimsEndpointPresent(
    context.db,
    context.workspace,
    context.portableById.get(link.toEntityId),
    to
  );
  if (!fromPresent || !toPresent) return null;
  if (from === to) throw new Error('Native record links cannot point to themselves.');
  assertRelationshipTypeExists(context.db, link.type);
  return { from, to };
}

function loadRegistryGraphRelationship(
  context: ProjectRegistryGraphContext,
  link: NonNullable<NativeWorkspaceManifest['limsLinks']>[number],
  endpoints: RegistryGraphEndpoints
): { before: LimsLink | null; requestedId: string } {
  const row = context.db
    .prepare('SELECT * FROM lims_link WHERE from_entity_id=? AND to_entity_id=? AND type=?')
    .get(endpoints.from, endpoints.to, link.type) as LimsLinkRow | undefined;
  const before = row ? limsLinkFromRow(row) : null;
  const requestedId = scopedProjectionId(context.scope, link.id);
  const claimed = context.db
    .prepare('SELECT from_entity_id,to_entity_id,type FROM lims_link WHERE id=?')
    .get(requestedId) as { from_entity_id: string; to_entity_id: string; type: string } | undefined;
  if (
    (claimed &&
      (claimed.from_entity_id !== endpoints.from ||
        claimed.to_entity_id !== endpoints.to ||
        claimed.type !== link.type)) ||
    (before && before.id !== requestedId)
  )
    throw new Error('Native record link identity collision.');
  return { before, requestedId };
}

function registryGraphRelationshipNeedsProjection(
  db: Database.Database,
  link: NonNullable<NativeWorkspaceManifest['limsLinks']>[number],
  endpoints: RegistryGraphEndpoints,
  before: LimsLink | null
): boolean {
  if (before && !before.tombstone && isDeepStrictEqual(before.payload, link.payload ?? {}))
    return false;
  if (before && !ownsNativeRecordFieldGraphRow(db, 'lims_link', before.id, before))
    throw new Error('Preserve the locally changed Registry relationship before reconstructing it.');
  if (
    (!before || before.tombstone) &&
    LINEAGE_RELATIONSHIP_TYPES.has(link.type) &&
    wouldCreateRelationshipCycle(db, endpoints.from, endpoints.to, link.type)
  )
    throw new Error('Native record relationship creates a cycle.');
  return true;
}

function assertRegistryGraphIdentityAvailable(
  db: Database.Database,
  link: NonNullable<NativeWorkspaceManifest['limsLinks']>[number],
  endpoints: RegistryGraphEndpoints,
  id: string
): void {
  const collision = db
    .prepare('SELECT from_entity_id,to_entity_id,type FROM lims_link WHERE id=?')
    .get(id) as { from_entity_id: string; to_entity_id: string; type: string } | undefined;
  if (
    collision &&
    (collision.from_entity_id !== endpoints.from ||
      collision.to_entity_id !== endpoints.to ||
      collision.type !== link.type)
  )
    throw new Error('Native record link identity collision.');
}

function projectRegistryRelationship(
  context: ProjectRegistryGraphContext,
  link: NonNullable<NativeWorkspaceManifest['limsLinks']>[number]
): void {
  const endpoints = resolveRegistryGraphEndpoints(context, link);
  if (!endpoints) return;
  context.desiredLims.add(recordGraphTuple(endpoints.from, link.type, endpoints.to));
  const { before, requestedId } = loadRegistryGraphRelationship(context, link, endpoints);
  if (!registryGraphRelationshipNeedsProjection(context.db, link, endpoints, before)) return;
  const now = Date.now();
  const after: LimsLink = {
    id: before?.id ?? requestedId,
    fromEntityId: endpoints.from,
    toEntityId: endpoints.to,
    type: link.type,
    payload: link.payload ?? {},
    workspaceId: context.workspace.id,
    actor: 'workspace-reconcile',
    eventSeq: nextEventSeq(context.db),
    tombstone: false,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
    archivedAt: null,
  };
  assertRegistryGraphIdentityAvailable(context.db, link, endpoints, after.id);
  insertAuditEvent(context.db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: before ? 'link_updated' : 'link_created',
    subjectTable: 'lims_link',
    subjectId: after.id,
    workspaceId: context.workspace.id,
    actor: after.actor,
    before,
    after,
  });
  upsertLimsLinkProjectionInsideTx(context.db, after);
}

function catalogGraphState(row: CatalogGraphRow) {
  return {
    id: row.id,
    source_entity_id: row.source_entity_id,
    target_entity_id: row.target_entity_id,
    relation: row.relation,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence ?? 'null'),
  };
}

function canRemoveProjectedRelationship(
  db: Database.Database,
  table: string,
  id: string,
  current: unknown
): boolean {
  if (ownsNativeRecordFieldGraphRow(db, table, id, current)) return true;
  const priorProjection = db
    .prepare(
      "SELECT 1 FROM lims_audit WHERE subject_table=? AND subject_id=? AND actor IN ('migration','workspace-reconcile','native-record-field-edit') AND after IS NOT NULL LIMIT 1"
    )
    .get(table, id);
  if (priorProjection)
    throw new Error(
      'Native record relationship changed locally; resolve the conflict before replacing it.'
    );
  return false;
}
