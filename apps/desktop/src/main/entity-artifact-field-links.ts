import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { EntityArtifactRelationshipV1, EntityArtifactV2 } from '../shared/entity-artifact';
import {
  entityRelationshipKey,
  isSchemaFieldRelationship,
  schemaFieldRelationships,
} from '../shared/entity-field-relationships';
import {
  limsLinkFromRow,
  type LimsEntity,
  type LimsLink,
  type LimsLinkRow,
  type LimsUpdateEntityInput,
} from '../shared/lims';
import {
  assertRelationshipTypeExists,
  insertAuditEvent,
  nextEventSeq,
  upsertLimsLinkProjectionInsideTx,
} from './lims-engine-core';
import { assertOrgRegistryRecordMutationAccount } from './org-registry-record-sync';

export function requestedEntityFieldTargetIds(input: LimsUpdateEntityInput): string[] {
  if (input.relationshipTargets === undefined) return [];
  if (
    !input.relationshipTargets ||
    typeof input.relationshipTargets !== 'object' ||
    Array.isArray(input.relationshipTargets)
  )
    throw new Error('Entity link targets must be an object.');
  return Object.values(input.relationshipTargets).flatMap((target) => {
    if (target === null) return [];
    if (typeof target !== 'string' || !target.trim() || target.length > 1024 || target === input.id)
      throw new Error('Entity link target is invalid or points to itself.');
    return [target];
  });
}

export function prepareEntityArtifactFieldUpdate(
  db: Database.Database,
  before: EntityArtifactV2,
  input: LimsUpdateEntityInput
): LimsUpdateEntityInput {
  requestedEntityFieldTargetIds(input);
  const definitions = before.schemaSnapshot.fields;
  const targets = input.relationshipTargets ?? {};
  const fields = { ...input.fields };
  for (const field of definitions) {
    if (field.type !== 'record_relationship') continue;
    const value =
      input.fields && Object.hasOwn(input.fields, field.key)
        ? input.fields[field.key]
        : input.replaceFields
          ? undefined
          : before.fields[field.key];
    if (!isDeepStrictEqual(value, before.fields[field.key]))
      throw new Error(`Change ${field.label} by choosing an entity link target.`);
  }
  for (const [key, target] of Object.entries(targets)) {
    const field = definitions.find(
      (entry) => entry.key === key && entry.type === 'record_relationship'
    );
    if (!field || field.readOnly || field.intrinsic)
      throw new Error(`Unknown or read-only entity link field: ${key}`);
    if (input.fields && Object.hasOwn(input.fields, key))
      throw new Error(`Entity link ${key} was supplied both as a value and a target.`);
    if (target === null) {
      fields[key] = null;
      continue;
    }
    const row = db
      .prepare(
        `SELECT l.name FROM lims_entity l LEFT JOIN workspaces w ON w.id=l.workspace_id
      WHERE l.id=? AND l.tombstone=0 AND l.archived_at IS NULL
      AND (l.workspace_id IS NULL OR (w.id IS NOT NULL AND w.archived_at IS NULL AND w.trashed_at IS NULL))`
      )
      .get(target) as { name: string } | undefined;
    if (!row)
      throw new Error(
        'The entity link target is unavailable or archived. Choose an active record.'
      );
    fields[key] = {
      origin: 'native',
      destinationEntityId: target,
      relationType: 'references',
      label: row.name,
      resolution: 'exact',
    };
  }
  const { relationshipTargets: _targets, ...ordinary } = input;
  return { ...ordinary, ...(input.fields || Object.keys(targets).length ? { fields } : {}) };
}

export function applyEntityArtifactFieldLinksInsideTx(
  db: Database.Database,
  before: EntityArtifactV2,
  after: LimsEntity,
  operationId: string,
  accountId: string | null
): EntityArtifactRelationshipV1[] {
  if (!db.inTransaction) throw new Error('Entity field links require a transaction.');
  const previous = schemaFieldRelationships(before.id, before.schemaSnapshot.fields, before.fields);
  const next = schemaFieldRelationships(after.id, before.schemaSnapshot.fields, after.fields);
  if (isDeepStrictEqual(previous, next)) return before.relationships;
  const preserved = before.relationships.filter(
    (link) => !isSchemaFieldRelationship(link, before.id)
  );
  const desired = new Map(next.map((link) => [entityRelationshipKey(link), link]));
  const old = new Map(previous.map((link) => [entityRelationshipKey(link), link]));
  for (const link of preserved) desired.delete(entityRelationshipKey(link));
  for (const key of new Set([...old.keys(), ...desired.keys()])) {
    const reference = desired.get(key) ?? old.get(key)!;
    if (preserved.some((link) => entityRelationshipKey(link) === key)) continue;
    const row = db
      .prepare('SELECT * FROM lims_link WHERE from_entity_id=? AND type=? AND to_entity_id=?')
      .get(reference.fromEntityId, reference.type, reference.toEntityId) as LimsLinkRow | undefined;
    const existing = row ? limsLinkFromRow(row) : null;
    const wanted = desired.get(key);
    if (existing && !isSchemaFieldRelationship(existing, before.id)) {
      if (existing.tombstone) {
        if (wanted)
          throw new Error(
            'A different archived relationship owns this entity link. Restore or review it before linking.'
          );
      } else {
        preserved.push({
          type: existing.type,
          fromEntityId: existing.fromEntityId,
          toEntityId: existing.toEntityId,
          payload: existing.payload,
        });
      }
      desired.delete(key);
      continue;
    }
    const prior = old.get(key);
    if (
      existing &&
      !existing.tombstone &&
      (!prior || !isDeepStrictEqual(existing.payload, prior.payload))
    )
      throw new Error(
        'This entity relationship changed elsewhere. Reload before editing its field.'
      );
    if (!wanted && (!existing || existing.tombstone)) continue;
    if (
      wanted &&
      existing &&
      !existing.tombstone &&
      isDeepStrictEqual(existing.payload, wanted.payload)
    )
      continue;
    if (wanted) {
      const target = db
        .prepare(
          `SELECT l.id FROM lims_entity l LEFT JOIN workspaces w ON w.id=l.workspace_id
        WHERE l.id=? AND l.id<>? AND l.tombstone=0 AND l.archived_at IS NULL
        AND (l.workspace_id IS NULL OR (w.id IS NOT NULL AND w.archived_at IS NULL AND w.trashed_at IS NULL))`
        )
        .get(wanted.toEntityId, before.id);
      if (!target)
        throw new Error(
          'The entity link target is unavailable or archived. Choose an active record.'
        );
      assertOrgRegistryRecordMutationAccount(db, { entityId: wanted.toEntityId, accountId });
    }
    assertRelationshipTypeExists(db, reference.type);
    const now = Date.now();
    const changed: LimsLink = {
      id: existing?.id ?? randomUUID(),
      fromEntityId: reference.fromEntityId,
      toEntityId: reference.toEntityId,
      type: reference.type,
      payload: wanted?.payload ?? existing!.payload,
      workspaceId: existing?.workspaceId ?? after.workspaceId,
      actor: after.actor,
      eventSeq: nextEventSeq(db),
      tombstone: !wanted,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      archivedAt: wanted ? null : now,
    };
    insertAuditEvent(db, {
      eventType: !wanted ? 'link_tombstoned' : existing ? 'link_updated' : 'link_created',
      eventSeq: changed.eventSeq!,
      operationId,
      subjectTable: 'lims_link',
      subjectId: changed.id,
      workspaceId: after.workspaceId,
      actor: after.actor,
      before: existing,
      after: changed,
    });
    upsertLimsLinkProjectionInsideTx(db, changed);
  }
  return [...preserved, ...desired.values()];
}
