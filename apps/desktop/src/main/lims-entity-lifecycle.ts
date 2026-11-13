import type Database from 'better-sqlite3';
import { resolveSavedRegistryProject } from './registry-entity-project';
import {
  limsEntityFromRow,
  type LimsEntity,
  type LimsEntityActionInput,
  type LimsRevertEntityResult,
} from '../shared/lims';
import {
  assertEntityValid,
  getEntityRowById,
  insertAuditEvent,
  LOCAL_ACTOR,
  nextEventSeq,
  resolveSchemaRevisionForKind,
  upsertLimsEntityProjectionInsideTx,
} from './lims-engine-core';

export function archiveLimsEntityInsideTx(
  db: Database.Database,
  input: LimsEntityActionInput
): LimsEntity {
  return setArchivedInsideTx(db, input, true).entity;
}

export function restoreLimsEntityInsideTx(
  db: Database.Database,
  input: LimsEntityActionInput
): { entity: LimsEntity; restored: boolean } {
  const result = setArchivedInsideTx(db, input, false);
  return { entity: result.entity, restored: result.changed };
}

export function applySavedLimsEntityLifecycleInsideTx(
  db: Database.Database,
  input: LimsEntityActionInput,
  state: { archived: boolean; archivedAt: number | null }
): LimsEntity {
  if (
    typeof state.archived !== 'boolean' ||
    (state.archived
      ? !Number.isSafeInteger(state.archivedAt) || Number(state.archivedAt) < 0
      : state.archivedAt !== null)
  )
    throw new Error('Saved lifecycle state requires its exact archive timestamp.');
  return setArchivedInsideTx(db, input, state.archived, state.archivedAt).entity;
}

export function applyPublishedSequenceLifecycleInsideTx(
  db: Database.Database,
  input: LimsEntityActionInput,
  state: { archived: boolean; archivedAt: number | null }
): LimsEntity {
  if (
    !input.operationId ||
    !Number.isSafeInteger(input.expectedEventSeq) ||
    !db
      .prepare(
        "SELECT 1 FROM org_registry_local_records WHERE entity_id=? AND authority_kind='sequence_package'"
      )
      .get(input.id)
  )
    throw new Error('Saved sequence lifecycle requires its registered publication owner.');
  if (
    typeof state.archived !== 'boolean' ||
    (state.archived
      ? !Number.isSafeInteger(state.archivedAt) || Number(state.archivedAt) < 0
      : state.archivedAt !== null)
  )
    throw new Error('Saved sequence lifecycle requires its exact archive timestamp.');
  return setArchivedInsideTx(db, input, state.archived, state.archivedAt, true).entity;
}

function setArchivedInsideTx(
  db: Database.Database,
  input: LimsEntityActionInput,
  archived: boolean,
  savedArchivedAt?: number | null,
  installedSequencePublication = false
) {
  if (!db.inTransaction) throw new Error('Entity lifecycle requires an active transaction.');
  if (!installedSequencePublication) assertRegisteredSequenceLifecycleAllowed(db, input.id);
  const before = limsEntityFromRow(getEntityRowById(db, input.id));
  assertCurrentVersion(before, input);
  const workspaceId = resolveSavedRegistryProject(db, before);
  if (
    Boolean(before.tombstone) === archived &&
    before.workspaceId === workspaceId &&
    (savedArchivedAt === undefined || before.archivedAt === savedArchivedAt)
  )
    return { entity: before, changed: false };
  const now = Date.now();
  const after: LimsEntity = {
    ...before,
    workspaceId,
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: nextEventSeq(db),
    tombstone: archived,
    updatedAt: now,
    archivedAt: archived ? (savedArchivedAt ?? (before.tombstone ? before.archivedAt : now)) : null,
  };
  insertAuditEvent(db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: archived ? 'entity_archived' : 'entity_restored',
    subjectTable: 'lims_entity',
    subjectId: input.id,
    batchId: installedSequencePublication ? input.operationId : null,
    actor: after.actor,
    workspaceId: after.workspaceId,
    before,
    after,
  });
  upsertLimsEntityProjectionInsideTx(db, after);
  return { entity: after, changed: true };
}

export function revertLimsEntityInsideTx(
  db: Database.Database,
  input: LimsEntityActionInput,
  options: { preserveSequenceReference?: boolean; preserveArtifactBinding?: boolean } = {}
): LimsRevertEntityResult {
  if (!db.inTransaction) throw new Error('Entity revert requires an active transaction.');
  assertRegisteredSequenceLifecycleAllowed(db, input.id);
  const existing = limsEntityFromRow(getEntityRowById(db, input.id));
  assertCurrentVersion(existing, input);
  const prior = db
    .prepare(
      `SELECT before FROM lims_audit WHERE subject_id = ?
    AND subject_table = 'lims_entity'
    AND event_type IN ('entity_updated','entity_reverted','entity_archived','entity_restored','entity_tombstoned')
    AND before IS NOT NULL ORDER BY event_seq DESC LIMIT 1`
    )
    .get(input.id) as { before: string } | undefined;
  if (!prior) return { reverted: false, entity: existing, reason: 'no-prior-edit' };
  const before: LimsEntity = JSON.parse(prior.before);
  if (before.id !== existing.id) throw new Error('Entity history identity does not match.');
  const schema = resolveSchemaRevisionForKind(db, before.kind, before.schemaRevisionId);
  const fields = {
    ...before.fields,
    ...(options.preserveSequenceReference ? { sequence: existing.fields.sequence } : {}),
    ...(options.preserveArtifactBinding
      ? { artifact: existing.fields.artifact, sourceMetadata: existing.fields.sourceMetadata }
      : {}),
  };
  assertEntityValid(before.kind, fields, schema.fieldsJson);
  const after: LimsEntity = {
    ...before,
    fields,
    workspaceId: options.preserveArtifactBinding
      ? existing.workspaceId
      : resolveSavedRegistryProject(db, {
          id: existing.id,
          fields,
          workspaceId: before.workspaceId ?? existing.workspaceId,
        }),

    registryId: existing.registryId,
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: nextEventSeq(db),
    updatedAt: Date.now(),
  };
  insertAuditEvent(db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: 'entity_reverted',
    subjectTable: 'lims_entity',
    subjectId: input.id,
    batchId: null,
    actor: after.actor,
    workspaceId: after.workspaceId,
    before: existing,
    after,
  });
  upsertLimsEntityProjectionInsideTx(db, after);
  return { reverted: true, entity: after };
}

function assertCurrentVersion(entity: LimsEntity, input: LimsEntityActionInput): void {
  if (
    input.expectedEventSeq !== undefined &&
    (!Number.isSafeInteger(input.expectedEventSeq) ||
      input.expectedEventSeq < 1 ||
      entity.eventSeq !== input.expectedEventSeq)
  ) {
    throw new Error('Registry record changed; refresh it before saving.');
  }
}

function assertRegisteredSequenceLifecycleAllowed(db: Database.Database, entityId: string): void {
  if (
    db
      .prepare(
        "SELECT 1 FROM org_registry_local_records WHERE entity_id=? AND authority_kind='sequence_package'"
      )
      .get(entityId)
  )
    throw new Error(
      'This registered sequence cannot yet be archived, restored or reverted from Registry.'
    );
}
