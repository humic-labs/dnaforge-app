import { recoverPrimerFileMoves } from './primer-file-move-intent';
import { createHash } from 'node:crypto';
import { assertRegistryEntityWriteAllowed } from './registry-write-admission';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  classifyLimsEntityFieldIssues,
  recordRegistrationStatus,
  parseLimsSchemaFields,
  LIMS_ENTITY_STATE_EVENT_TYPES,
  type LimsEntity,
  type LimsUpdateEntityInput,
  type LimsEntityActionInput,
  type LimsRevertEntityResult,
} from '../shared/lims';
import {
  archiveLimsEntityInsideTx,
  restoreLimsEntityInsideTx,
  revertLimsEntityInsideTx,
} from './lims-entity-lifecycle';
import {
  parseNativeWorkspaceManifest,
  parseNativeWorkspaceManifestFragment,
  serializeNativeWorkspaceManifest,
  type NativeWorkspaceManifestEntityV2,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { mapPortableRecordRelationships } from '../shared/portable-record-relationships';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  getEntityRowById,
  getSchemaRevisionForEntity,
  insertAuditEvent,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import {
  nativeCatalogRecordStateSha256,
  readNativeCatalogRecordState,
  nativeCatalogSequenceStateSha256,
} from './native-catalog-record-state';
import {
  publishNativeCatalogBytes,
  pruneCompletedNativeCatalogPublication,
  readNativeCatalogPublicationBase,
} from './native-catalog-publication';
import { materializeLimsGitReadableExportInDb } from './lims-git-export';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { parseLimsEntitySnapshot } from '../shared/lims-entity-snapshot';
import {
  assertEntityArtifactPublicationsSettled,
  recoverEntityArtifactPublications,
} from './entity-artifact-mutations';
import {
  nativeMutationRequestBytes,
  NATIVE_MUTATION_REQUEST_VERSION,
} from './native-mutation-request';
import {
  prepareRecordRelationshipUpdate,
  planRecordFieldGraphChange,
  applyRecordFieldGraphChangeInsideTx,
  applyRecordFieldGraphDeltaToManifest,
  parseRecordFieldGraphDelta,
} from './native-record-field-graph';

type DatabaseFence = <T>(operation: () => T) => T;
type Context = { db: Database.Database; runDatabase: DatabaseFence };
type RecordState = NonNullable<ReturnType<typeof readNativeCatalogRecordState>>;
type Authority = { id: number; path: string; scope: string };
const REQUIRED = 'native_catalog_publication_required';
const COMPLETE = 'native_catalog_publication_complete';

export function enqueueNativeSequenceCatalogPublicationInsideTx(input: {
  db: Database.Database;
  operationId: string;
  workspaceId: number;
  entityId: string;
  requestHash: string;
  beforeEntity: NativeWorkspaceManifestEntityV2;
  afterEntity: NativeWorkspaceManifestEntityV2;
}) {
  if (!input.db.inTransaction)
    throw new Error('Classification publication requires a transaction.');
  insertAuditEvent(input.db, {
    eventType: REQUIRED,
    operationId: input.operationId,
    idempotencyKey: intentKey(input.operationId),
    subjectTable: 'catalog_entities',
    subjectId: input.entityId,
    workspaceId: input.workspaceId,
    actor: 'local-user',
    payload: {
      schema: 'dnaforge.native-sequence-classification.v1',
      requestHash: input.requestHash,
      stateSha256: nativeCatalogSequenceStateSha256(input.db, input.entityId),
      beforeEntity: input.beforeEntity,
      afterEntity: input.afterEntity,
      changed: true,
    },
  });
  input.db
    .prepare(
      'INSERT INTO native_catalog_publication_outbox (operation_id,workspace_id) VALUES (?,?)'
    )
    .run(input.operationId, input.workspaceId);
}

export function assertNativeCatalogRecordPublicationsSettled(
  db: Database.Database,
  workspacePath: string
): void {
  assertEntityArtifactPublicationsSettled(db, workspacePath);

  if (pendingOperations(db, workspacePath, true).length)
    throw new Error(
      'Native catalog has a pending record save. Recover it before copying or syncing this workspace.'
    );
}

export async function recoverNativeCatalogRecordsWithDatabaseFence(
  db: Database.Database,
  workspacePath: string
): Promise<void> {
  const release = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    await recoverNativeCatalogRecordPublications({
      db,
      workspacePath,
      runDatabase: (operation) => operation(),
    });
  } finally {
    release();
  }
}

export async function updateNativeCatalogRecord(
  input: Context & {
    input: LimsUpdateEntityInput;
    operationId: string;
    expectedEventSeq: number;
  }
): Promise<LimsEntity> {
  return (await mutateNativeCatalogRecord({ ...input, action: 'update' })).entity;
}

export async function actOnNativeCatalogRecord(
  input: Context & {
    input: LimsEntityActionInput;
    action: 'archive' | 'restore' | 'revert';
    operationId: string;
    expectedEventSeq: number;
  }
): Promise<LimsRevertEntityResult> {
  const result = await mutateNativeCatalogRecord(input);
  return {
    entity: result.entity,
    reverted: result.changed,
    ...(input.action === 'revert' && !result.changed ? { reason: 'no-prior-edit' as const } : {}),
  };
}

type NativeRecordMutation = Context & { operationId: string; expectedEventSeq: number } & (
    | { action: 'update'; input: LimsUpdateEntityInput }
    | { action: 'archive' | 'restore' | 'revert'; input: LimsEntityActionInput }
  );

async function mutateNativeCatalogRecord(
  input: NativeRecordMutation
): Promise<{ entity: LimsEntity; changed: boolean }> {
  if (
    !input.operationId ||
    input.operationId.length > 200 ||
    !Number.isSafeInteger(input.expectedEventSeq)
  )
    throw new Error('Native record edits require an operation ID and current edit version.');
  input.runDatabase(() => assertRegistryEntityWriteAllowed(input.db, input.input));
  const authority = input.runDatabase(() => {
    if (input.db.inTransaction)
      throw new Error('Native record edit cannot join an open database transaction.');
    return recordAuthority(input.db, input.input.id);
  });
  const request = {
    action: input.action,
    input: input.input,
    expectedEventSeq: input.expectedEventSeq,
  };
  const prior = input.runDatabase(() => readIntent(input.db, input.operationId));
  const requestHash = digest(
    nativeMutationRequestBytes(
      request,
      prior ? prior.requestHashVersion : NATIVE_MUTATION_REQUEST_VERSION
    )
  );
  if (
    prior &&
    (prior.requestHash !== requestHash ||
      prior.entityId !== input.input.id ||
      prior.workspaceId !== authority.id)
  )
    throw new Error('Native record edit operation was reused with a different request.');
  const original = prior
    ? input.runDatabase(() => ({
        entity: originalRecordResult(input.db, prior, input.expectedEventSeq),
        changed: prior.changed,
      }))
    : null;
  await recoverNativeCatalogRecordPublications({ ...input, workspacePath: authority.path });
  if (original) return original;
  if (
    input.action === 'update' &&
    input.input.workspaceId !== undefined &&
    input.input.workspaceId !== authority.id
  )
    throw new Error(
      'A native catalog record cannot leave its owning project through a field edit.'
    );
  const beforeBytes = await readNativeCatalogPublicationBase({
    workspacePath: authority.path,
    operationId: input.operationId,
  });
  const manifest = requireManifest(beforeBytes);
  const before = manifest.entities.find(
    (entity) => scopedProjectionId(authority.scope, entity.id) === input.input.id
  );
  if (
    !before ||
    before.type !== 'record' ||
    before.placement.kind !== 'catalog-record' ||
    !before.lims?.schemaSnapshot
  )
    throw new Error('Native record has no portable catalog authority.');
  const result = input.runDatabase(() =>
    input.db.transaction(() => {
      const current = requireState(input.db, input.input.id);
      if (current.eventSeq !== input.expectedEventSeq)
        throw new Error('Native record changed since this editor opened. Refresh before saving.');
      const toPortableId = portableIdentityMapper(manifest, authority);
      const projected = portableRecord(before, current, toPortableId);
      const issues = classifyLimsEntityFieldIssues(
        before.lims!.kind,
        before.lims!.fields,
        parseLimsSchemaFields(JSON.stringify({ fields: before.lims!.schemaSnapshot!.fields }))
          .fields
      );
      const effectiveStatus = recordRegistrationStatus(
        before.lims!.registrationStatus ?? 'registered',
        issues.incomplete.length > 0
      );
      const effectiveBefore =
        effectiveStatus !== (before.lims!.registrationStatus ?? 'registered')
          ? { ...before, lims: { ...before.lims, registrationStatus: effectiveStatus } }
          : before;
      if (issues.malformed.length || !isDeepStrictEqual(projected, effectiveBefore))
        throw new Error(
          'Native record and portable catalog disagree; preserve the changed version before editing.'
        );
      if (input.action === 'update' && current.archivedAt !== null)
        throw new Error('Restore an archived native record before editing its fields.');
      const updated =
        input.action === 'update'
          ? updateLimsEntityInsideTx(
              input.db,
              prepareRecordRelationshipUpdate(input.db, authority, manifest, before, input.input)
            )
          : input.action === 'archive'
            ? archiveLimsEntityInsideTx(input.db, input.input)
            : input.action === 'restore'
              ? restoreLimsEntityInsideTx(input.db, input.input).entity
              : revertLimsEntityInsideTx(input.db, input.input).entity;
      if (updated.workspaceId !== authority.id)
        throw new Error(
          'Native record history cannot move the record outside its owning workspace.'
        );
      const updatedDefinitions = parseLimsSchemaFields(
        getSchemaRevisionForEntity(input.db, getEntityRowById(input.db, updated.id)).fieldsJson
      ).fields;
      const relationshipKeys = new Set(
        [...current.schemaSnapshot.fields, ...updatedDefinitions]
          .filter((field) => field.type === 'record_relationship')
          .map((field) => field.key)
      );
      for (const key of relationshipKeys) {
        if (
          input.action === 'update' &&
          (current.schemaSnapshot.fields.find((field) => field.key === key)?.type !==
            updatedDefinitions.find((field) => field.key === key)?.type ||
            !isDeepStrictEqual(current.fields[key], updated.fields[key])) &&
          !Object.hasOwn(input.input.relationshipTargets ?? {}, key)
        )
          throw new Error(
            'Native record relationship edits require the relationship review operation.'
          );
      }
      input.db
        .prepare('UPDATE catalog_entities SET name = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(
          updated.name,
          updated.tombstone ? 'archived' : 'active',
          updated.updatedAt,
          updated.id
        );
      input.db
        .prepare(
          'UPDATE catalog_workspace_placements SET display_name = ?, normalized_sibling_name = ?, status = ?, updated_at = ? WHERE entity_id = ? AND workspace_id = ?'
        )
        .run(
          updated.name,
          updated.name.normalize('NFC').toLowerCase(),
          updated.tombstone ? 'hidden' : 'active',
          updated.updatedAt,
          updated.id,
          authority.id
        );
      const afterState = requireState(input.db, input.input.id);
      const after = portableRecord(before, afterState, toPortableId);
      const graphDelta = planRecordFieldGraphChange(manifest, before, after);
      applyRecordFieldGraphChangeInsideTx(input.db, {
        authority,
        recordId: updated.id,
        operationId: input.operationId,
        delta: graphDelta,
        manifest,
      });

      serializeNativeWorkspaceManifest(
        applyRecordFieldGraphDeltaToManifest(
          {
            ...manifest,
            entities: manifest.entities.map((entity) => (entity.id === before.id ? after : entity)),
          },
          graphDelta
        )
      );
      insertAuditEvent(input.db, {
        eventType: REQUIRED,
        operationId: input.operationId,
        idempotencyKey: intentKey(input.operationId),
        subjectTable: 'catalog_entities',
        subjectId: updated.id,
        workspaceId: authority.id,
        actor: updated.actor,
        payload: {
          schema: 'dnaforge.native-record-edit.v2',
          requestHash,
          requestHashVersion: NATIVE_MUTATION_REQUEST_VERSION,
          result: updated,
          stateSha256: nativeCatalogRecordStateSha256(requireState(input.db, input.input.id)),
          beforeEntity: before,
          afterEntity: after,
          graphDelta,
          changed: updated.eventSeq !== current.eventSeq,
        },
      });
      input.db
        .prepare(
          'INSERT INTO native_catalog_publication_outbox (operation_id,workspace_id) VALUES (?,?)'
        )
        .run(input.operationId, authority.id);
      return { entity: updated, changed: updated.eventSeq !== current.eventSeq };
    })()
  );
  await recoverNativeCatalogRecordPublications({ ...input, workspacePath: authority.path });
  return result;
}

export async function recoverNativeCatalogRecordPublications(
  input: Context & { workspacePath: string }
): Promise<void> {
  await recoverPrimerFileMoves(input);
  await recoverEntityArtifactPublications(input);
  const pending = input.runDatabase(() => pendingOperations(input.db, input.workspacePath));
  for (const { operation_id: operationId } of pending) {
    input.runDatabase(() => {
      if (input.db.inTransaction)
        throw new Error('Native record recovery cannot join an open database transaction.');
    });
    const intent = input.runDatabase(() => readIntent(input.db, operationId));
    if (!intent) throw new Error('Pending native catalog edit has no publication intent.');
    const authority = input.runDatabase(() =>
      catalogAuthority(input.db, intent.entityId, intent.kind)
    );
    if (
      workspaceMutationRootIdentity(authority.path) !==
        workspaceMutationRootIdentity(input.workspacePath) ||
      authority.id !== intent.workspaceId
    )
      throw new Error('Pending native catalog edit changed workspace.');
    const completed = input.runDatabase(() =>
      input.db
        .prepare('SELECT 1 FROM lims_audit WHERE idempotency_key = ? AND event_type = ?')
        .get(completeKey(operationId), COMPLETE)
    );
    if (!completed) {
      const beforeBytes = await readNativeCatalogPublicationBase({
        workspacePath: authority.path,
        operationId,
      });
      const manifest = requireManifest(beforeBytes);
      const before = parseIntentEntity(intent.beforeEntity, manifest, intent.kind);
      const after = parseIntentEntity(intent.afterEntity, manifest, intent.kind);
      if (
        before.id !== after.id ||
        scopedProjectionId(authority.scope, after.id) !== intent.entityId
      )
        throw new Error('Native catalog edit identity changed.');
      input.runDatabase(() => {
        if (
          (intent.kind === 'record'
            ? nativeCatalogRecordStateSha256(requireState(input.db, intent.entityId))
            : nativeCatalogSequenceStateSha256(input.db, intent.entityId)) !== intent.stateSha256
        )
          throw new Error(
            'Native record changed after its edit committed; later data was preserved.'
          );
      });
      const current = manifest.entities.find((entity) => entity.id === before.id);
      if (!isDeepStrictEqual(current, before) && !isDeepStrictEqual(current, after))
        throw new Error(
          'Portable record changed after its edit committed; later data was preserved.'
        );
      const candidateEntity = {
        ...manifest,
        entities: manifest.entities.map((entity) => (entity.id === after.id ? after : entity)),
      };
      const candidate =
        intent.graphDelta === undefined
          ? candidateEntity
          : applyRecordFieldGraphDeltaToManifest(
              candidateEntity,
              parseRecordFieldGraphDelta(intent.graphDelta, manifest)
            );
      await publishNativeCatalogBytes({
        workspacePath: authority.path,
        operationId,
        beforeBytes,
        afterBytes: Buffer.from(serializeNativeWorkspaceManifest(candidate)),
      });
      input.runDatabase(() => {
        if (input.db.inTransaction)
          throw new Error('Record export requires committed database state.');
        input.db.transaction(() =>
          insertAuditEvent(input.db, {
            eventType: COMPLETE,
            operationId,
            idempotencyKey: completeKey(operationId),
            workspaceId: authority.id,
            subjectTable: 'catalog_entities',
            subjectId: intent.entityId,
            actor: 'catalog-publication',
            payload: { stateSha256: intent.stateSha256 },
          })
        )();
      });
    }
    input.runDatabase(() => {
      if (input.db.inTransaction)
        throw new Error('Record export requires committed database state.');
      materializeLimsGitReadableExportInDb(input.db, { workspaceId: authority.id, durable: true });
    });
    await pruneCompletedNativeCatalogPublication({ workspacePath: authority.path, operationId });
    input.runDatabase(() =>
      input.db
        .prepare('DELETE FROM native_catalog_publication_outbox WHERE operation_id = ?')
        .run(operationId)
    );
  }
}

function pendingOperations(
  db: Database.Database,
  workspacePath: string,
  includePrimerPublications = false
): { operation_id: string }[] {
  const root = workspaceMutationRootIdentity(workspacePath);
  const rows = db
    .prepare(
      `SELECT o.operation_id,w.path FROM native_catalog_publication_outbox o
    JOIN workspaces w ON w.id = o.workspace_id
    LEFT JOIN lims_audit a ON a.operation_id = o.operation_id AND a.event_type = ?
    WHERE NOT EXISTS (SELECT 1 FROM lims_audit g WHERE g.operation_id=o.operation_id
      AND (g.event_type='entity_artifact_publication_required' OR
        (?=0 AND g.event_type='primer_artifact_publication_required')))
    ORDER BY a.event_seq`
    )
    .all(REQUIRED, includePrimerPublications ? 1 : 0) as { operation_id: string; path: string }[];
  return rows
    .filter((row) => workspaceMutationRootIdentity(row.path) === root)
    .map(({ operation_id }) => ({ operation_id }));
}

function recordAuthority(db: Database.Database, entityId: string): Authority {
  return catalogAuthority(db, entityId, 'record');
}
function catalogAuthority(
  db: Database.Database,
  entityId: string,
  kind: 'record' | 'sequence'
): Authority {
  const row = db
    .prepare(
      `SELECT w.id,w.path,w.repo_uuid FROM catalog_entities c
    JOIN workspaces w ON w.id = c.workspace_id JOIN lims_entity l ON l.id = c.id AND l.workspace_id = w.id
    WHERE c.id = ? AND c.type = ? AND (?='sequence' OR EXISTS (
      SELECT 1 FROM catalog_workspace_placements p WHERE p.entity_id=c.id AND p.workspace_id=w.id AND p.presentation_kind='record'))`
    )
    .get(entityId, kind, kind) as
    | { id: number; path: string; repo_uuid: string | null }
    | undefined;
  if (!row) throw new Error('Native record has no owning project catalog.');
  const scope = workspaceScopeKey(row.repo_uuid, row.id);
  if (!scope) throw new Error('Native record project scope is missing.');
  return { ...row, scope };
}

function requireState(db: Database.Database, entityId: string): RecordState {
  const state = readNativeCatalogRecordState(db, entityId, { includeArchived: true });
  if (!state) throw new Error('Native record is missing or archived.');
  return state;
}
function requireManifest(bytes: Buffer | null): NativeWorkspaceManifestV2 {
  if (!bytes) throw new Error('Native record portable catalog is missing.');
  const manifest = parseNativeWorkspaceManifest(bytes.toString('utf8'));
  if (manifest.schema !== 'dnaforge.native-workspace-manifest.v2')
    throw new Error('Native record requires a v2 catalog.');
  return manifest;
}
function portableIdentityMapper(manifest: NativeWorkspaceManifestV2, authority: Authority) {
  const rawIds = new Map(
    manifest.entities.map((entity) => [scopedProjectionId(authority.scope, entity.id), entity.id])
  );
  return (scopedId: string): string => {
    const raw = rawIds.get(scopedId);
    if (!raw) throw new Error('Native record relationship target is not in its project catalog.');
    return raw;
  };
}
function portableRecord(
  before: NativeWorkspaceManifestEntityV2,
  state: RecordState,
  toPortableId: (id: string) => string
): NativeWorkspaceManifestEntityV2 {
  if (!before.lims || before.placement.kind !== 'catalog-record')
    throw new Error('Native record has no scientific state.');
  return {
    ...before,
    name: state.catalogName,
    ...(state.archivedAt !== null
      ? { lifecycle: { state: 'archived' as const, archivedAt: state.archivedAt } }
      : before.lifecycle
        ? { lifecycle: { state: 'active' as const } }
        : {}),
    placement: { ...before.placement, displayName: state.name },
    lims: {
      ...before.lims,
      kind: state.schemaSnapshot.name,
      name: state.name,
      fields: mapPortableRecordRelationships(state.fields, state.schemaSnapshot, toPortableId),
      schemaRevisionId: state.schemaSnapshot.schemaRevisionId,
      schemaSnapshot: state.schemaSnapshot,
      ...(before.lims.registrationStatus !== undefined || state.registrationStatus !== 'registered'
        ? { registrationStatus: state.registrationStatus }
        : {}),
      ...(before.lims.domainStatus !== undefined || state.domainStatus !== null
        ? { domainStatus: state.domainStatus }
        : {}),
    },
  };
}
function parseIntentEntity(
  value: unknown,
  manifest: NativeWorkspaceManifestV2,
  kind: 'record' | 'sequence'
): NativeWorkspaceManifestEntityV2 {
  const parsed = parseNativeWorkspaceManifestFragment(
    JSON.stringify({ schema: manifest.schema, entities: [value], links: [] }),
    manifest.entities.map((entity) => entity.id)
  );
  if (parsed.schema !== manifest.schema || parsed.entities.length !== 1)
    throw new Error('Native record publication contains an invalid entity.');
  const entity = parsed.entities[0];
  if (
    kind === 'record' &&
    (entity.type !== 'record' ||
      entity.placement.kind !== 'catalog-record' ||
      !entity.lims?.schemaSnapshot)
  )
    throw new Error('Native record publication contains no record.');
  if (
    kind === 'sequence' &&
    (entity.type !== 'sequence' ||
      entity.placement.kind !== 'file' ||
      !entity.lims ||
      !['dna_sequence', 'rna_sequence', 'oligo', 'rna_oligo'].includes(entity.lims.kind))
  )
    throw new Error('Native classification publication contains no supported sequence.');
  return entity;
}
function readIntent(db: Database.Database, operationId: string) {
  const row = db
    .prepare(
      'SELECT subject_id,workspace_id,event_seq,payload FROM lims_audit WHERE idempotency_key = ? AND event_type = ?'
    )
    .get(intentKey(operationId), REQUIRED) as
    | { subject_id: string; workspace_id: number; event_seq: number; payload: string }
    | undefined;
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  if (
    !value ||
    typeof value !== 'object' ||
    !('schema' in value) ||
    (value.schema !== 'dnaforge.native-record-edit.v1' &&
      value.schema !== 'dnaforge.native-record-edit.v2' &&
      value.schema !== 'dnaforge.native-sequence-classification.v1') ||
    !('requestHash' in value) ||
    typeof value.requestHash !== 'string' ||
    !('stateSha256' in value) ||
    typeof value.stateSha256 !== 'string' ||
    !('beforeEntity' in value) ||
    !('afterEntity' in value)
  )
    throw new Error('Native record edit intent is invalid.');
  if (value.schema === 'dnaforge.native-record-edit.v2' && !('graphDelta' in value))
    throw new Error('Native record edit is missing its graph receipt.');
  return {
    kind:
      value.schema !== 'dnaforge.native-sequence-classification.v1'
        ? ('record' as const)
        : ('sequence' as const),
    entityId: row.subject_id,
    workspaceId: row.workspace_id,
    requestHash: value.requestHash,
    requestHashVersion: 'requestHashVersion' in value ? value.requestHashVersion : undefined,
    result: 'result' in value ? value.result : undefined,
    eventSeq: row.event_seq,
    stateSha256: value.stateSha256,
    beforeEntity: value.beforeEntity,
    afterEntity: value.afterEntity,
    graphDelta: 'graphDelta' in value ? value.graphDelta : undefined,
    changed: 'changed' in value ? value.changed === true : true,
  };
}
function originalRecordResult(
  db: Database.Database,
  intent: NonNullable<ReturnType<typeof readIntent>>,
  expectedEventSeq: number
): LimsEntity {
  if (intent.kind !== 'record') throw new Error('Native record receipt has a different kind.');
  let value = intent.result;
  if (value === undefined) {
    if (intent.requestHashVersion !== undefined)
      throw new Error('Native record receipt is missing its original result.');
    const row = db
      .prepare(
        `SELECT event_seq,after FROM lims_audit WHERE subject_table='lims_entity'
       AND subject_id=? AND workspace_id=? AND event_seq<?
       AND event_type IN (${LIMS_ENTITY_STATE_EVENT_TYPES.map(() => '?').join(',')})
       ORDER BY event_seq DESC LIMIT 1`
      )
      .get(intent.entityId, intent.workspaceId, intent.eventSeq, ...LIMS_ENTITY_STATE_EVENT_TYPES);
    if (
      !row ||
      typeof row !== 'object' ||
      !('after' in row) ||
      typeof row.after !== 'string' ||
      !('event_seq' in row) ||
      typeof row.event_seq !== 'number'
    )
      throw new Error('Legacy native record receipt has no original state snapshot.');
    const snapshot = parseLimsEntitySnapshot(JSON.parse(row.after));
    if (snapshot.eventSeq !== row.event_seq)
      throw new Error('Legacy native record receipt state version is inconsistent.');
    value = snapshot;
  }
  const entity = parseLimsEntitySnapshot(value);
  if (
    entity.id !== intent.entityId ||
    entity.workspaceId !== intent.workspaceId ||
    entity.eventSeq === null ||
    entity.eventSeq >= intent.eventSeq ||
    (intent.changed ? entity.eventSeq <= expectedEventSeq : entity.eventSeq !== expectedEventSeq)
  )
    throw new Error('Native record receipt identity or edit version is inconsistent.');
  return entity;
}
function intentKey(operationId: string): string {
  return `native-record-edit:${operationId}`;
}
function completeKey(operationId: string): string {
  return `native-record-edit-complete:${operationId}`;
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
