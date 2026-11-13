import type Database from 'better-sqlite3';
import {
  limsLinkFromRow,
  type LimsLink,
  type LimsLinkRow,
  type LimsReplaceOutgoingRelationshipsInput,
  type LimsReplaceOutgoingRelationshipsResult,
} from '../shared/lims';
import {
  getEntityRowById,
  linkLimsEntitiesOrExistingInsideTx,
  nextEventSeq,
  insertAuditEvent,
  upsertLimsLinkProjectionInsideTx,
  materializeRelationshipSchemaSnapshotInsideTx,
} from './lims-engine-core';
import { tombstoneLimsLinkInsideTx } from './lims-import';

function canonicalRelationshipPayload(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalRelationshipPayload(item)).join(',')}]`;
  }
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalRelationshipPayload(child)}`)
    .join(',')}}`;
}

export function replaceLimsOutgoingRelationshipsInsideTx(
  db: Database.Database,
  input: LimsReplaceOutgoingRelationshipsInput
): LimsReplaceOutgoingRelationshipsResult {
  if (!db.inTransaction)
    throw new Error('Relationship replacement requires an active transaction.');

  const owner = getEntityRowById(db, input.entityId);
  if (owner.tombstone) throw new Error('Cannot reconcile relationships for an archived entity');
  if (input.schemaSnapshots !== undefined) {
    if (!Array.isArray(input.schemaSnapshots))
      throw new Error('Relationship schema snapshots must be a list.');
    const types = new Set(input.relationships.map((relationship) => relationship.type));
    const names = new Set<string>();
    for (const snapshot of input.schemaSnapshots) {
      if (!types.has(snapshot.name) || names.has(snapshot.name))
        throw new Error('Relationship schema snapshot is duplicated or unrelated.');
      names.add(snapshot.name);
      materializeRelationshipSchemaSnapshotInsideTx(db, snapshot, {
        actor: input.actor,
        workspaceId: input.workspaceId ?? owner.workspace_id,
      });
    }
  }
  const desiredByKey = new Map<string, (typeof input.relationships)[number]>();
  for (const relationship of input.relationships) {
    const type = relationship.type.trim();
    const toEntityId = relationship.toEntityId.trim();
    if (!type || !toEntityId) throw new Error('Relationship target and type are required');
    if (toEntityId === input.entityId)
      throw new Error('LIMS links cannot point an entity at itself');
    const key = `${type}\u0000${toEntityId}`;
    if (desiredByKey.has(key)) {
      throw new Error(`Duplicate outgoing relationship ${type} to ${toEntityId}`);
    }
    desiredByKey.set(key, { ...relationship, type, toEntityId });
  }

  const existingRows = db
    .prepare(`SELECT * FROM lims_link WHERE from_entity_id = ? AND tombstone = 0`)
    .all(input.entityId) as LimsLinkRow[];
  const existingByKey = new Map(
    existingRows.map((row) => [`${row.type}\u0000${row.to_entity_id}`, row])
  );
  const active: LimsLink[] = [];

  for (const [key, relationship] of desiredByKey) {
    const existing = existingByKey.get(key);
    const payload = relationship.payload ?? {};
    if (!existing) {
      active.push(
        linkLimsEntitiesOrExistingInsideTx(db, {
          fromEntityId: input.entityId,
          toEntityId: relationship.toEntityId,
          type: relationship.type,
          payload,
          actor: input.actor ?? 'workspace-reconcile',
          workspaceId: input.workspaceId ?? owner.workspace_id,
        })
      );
      continue;
    }
    const before = limsLinkFromRow(existing);
    if (canonicalRelationshipPayload(before.payload) === canonicalRelationshipPayload(payload)) {
      active.push(before);
      continue;
    }
    const eventSeq = nextEventSeq(db);
    const after: LimsLink = {
      ...before,
      payload,
      actor: input.actor ?? 'workspace-reconcile',
      eventSeq,
      updatedAt: Date.now(),
    };
    insertAuditEvent(db, {
      eventSeq,
      eventType: 'link_updated',
      subjectTable: 'lims_link',
      subjectId: after.id,
      actor: after.actor,
      workspaceId: after.workspaceId,
      before,
      after,
    });
    upsertLimsLinkProjectionInsideTx(db, after);
    active.push(after);
  }

  let tombstoned = 0;
  const batchId = `relationship-reconcile:${input.entityId}:${Date.now()}`;
  for (const row of existingRows) {
    if (desiredByKey.has(`${row.type}\u0000${row.to_entity_id}`)) continue;
    tombstoneLimsLinkInsideTx(db, row, {
      actor: input.actor ?? 'workspace-reconcile',
      batchId,
      reason: 'file_authority_relationship_removed',
    });
    tombstoned++;
  }
  return { active, tombstoned };
}
