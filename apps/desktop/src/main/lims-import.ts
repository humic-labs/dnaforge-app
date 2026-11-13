import { withUserMessage } from '@waypoint/user-messages';
import { assertEnrolledPrimerPhysicalMutationAllowed } from './primer-artifact-mutation-guard';

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import {
  limsEntityFromRow,
  limsLinkFromRow,
  type DnaSequenceRef,
  type LimsApplyImportBatchInput,
  type LimsApplyImportBatchResult,
  type LimsAuditRow,
  type LimsEntity,
  type LimsEntityRow,
  type LimsImportLinkPreview,
  type LimsLink,
  type LimsLinkRow,
  type LimsRegisterEntityInput,
  type LimsSourceMetadata,
  type LimsUndoImportBatchInput,
  type LimsUndoImportBatchResult,
} from '../shared/lims';
import {
  LOCAL_ACTOR,
  errorMessage,
  getEntityRowById,
  getLinkRowById,
  insertAuditEvent,
  linkLimsEntitiesOrExistingInsideTx,
  nextEventSeq,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  upsertLimsEntityProjectionInsideTx,
  upsertLimsLinkProjectionInsideTx,
} from './lims-engine-core';

export function applyLimsImportBatchInDb(
  db: Database.Database,
  input: LimsApplyImportBatchInput
): LimsApplyImportBatchResult {
  seedLimsBuiltinsInDb(db);
  const batchId = input.batchId ?? randomUUID();
  const preflightErrors = preflightLimsImportBatchApply(db, input);
  if (preflightErrors.length > 0) {
    throw new Error(
      `LIMS import batch rejected: ${preflightErrors.map((error) => `${error.recordId}: ${error.reason}`).join('; ')}`
    );
  }
  return db.transaction(() => {
    let insertedEntities = 0;
    let insertedLinks = 0;
    let skipped = 0;
    const errors: Array<{ recordId: string; reason: string }> = [];
    const insertedEntityIds: Array<{ recordId: string; entityId: string }> = [];
    const insertedLinkIds: Array<{ recordId: string; linkId: string }> = [];
    const skippedRecordIds: string[] = [];
    const unresolvedLinks = input.records.flatMap((record) =>
      (record.unresolvedLinks ?? []).map((link) => ({ recordId: record.id, link }))
    );
    const insertedByRecord = new Map<string, string>();

    for (const record of input.records) {
      if (!record.accepted || record.duplicateOf || (record.errors && record.errors.length > 0)) {
        skipped++;
        skippedRecordIds.push(record.id);
        continue;
      }
      try {
        assertImportRecordFileSequencesResolvable(record);
        const entityInput = withImportSourceMetadata(record, input);
        const entity = registerLimsEntityInsideTx(db, {
          ...entityInput,
          actor: input.actor ?? entityInput.actor ?? LOCAL_ACTOR,
          batchId,
        });
        insertedByRecord.set(record.id, entity.id);
        insertedEntityIds.push({ recordId: record.id, entityId: entity.id });
        insertedEntities++;
      } catch (err) {
        errors.push({ recordId: record.id, reason: errorMessage(err) });
      }
    }

    if (errors.length === 0) {
      for (const record of input.records) {
        if (!record.accepted || record.duplicateOf || (record.errors && record.errors.length > 0)) {
          continue;
        }
        const fromEntityId = insertedByRecord.get(record.id);
        if (!fromEntityId) continue;
        for (const link of record.links ?? []) {
          try {
            const endpoints = resolveImportLinkEndpoints(db, link, fromEntityId);
            const createdLink = linkLimsEntitiesOrExistingInsideTx(db, {
              fromEntityId: endpoints.fromEntityId,
              toEntityId: endpoints.toEntityId,
              type: link.type,
              payload: link.payload,
              actor: input.actor ?? LOCAL_ACTOR,
              workspaceId: record.entity.workspaceId ?? null,
              batchId,
            });
            insertedLinkIds.push({ recordId: record.id, linkId: createdLink.id });
            insertedLinks++;
          } catch (err) {
            errors.push({ recordId: record.id, reason: errorMessage(err) });
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `LIMS import batch rejected: ${errors.map((error) => `${error.recordId}: ${error.reason}`).join('; ')}`
      );
    }

    insertAuditEvent(db, {
      eventType: 'import_batch_applied',
      subjectTable: 'lims_audit',
      batchId,
      actor: input.actor ?? LOCAL_ACTOR,
      payload: {
        sourceName: input.sourceName,
        sourceKind: input.sourceKind,
        insertedEntities,
        insertedLinks,
        skipped,
        insertedEntityIds,
        insertedLinkIds,
        skippedRecordIds,
        unresolvedLinks,
        oracle: input.oracle ?? null,
      },
    });

    if (input.oracle) {
      insertAuditEvent(db, {
        eventType: 'import_accuracy_evaluated',
        subjectTable: 'lims_audit',
        batchId,
        actor: input.actor ?? LOCAL_ACTOR,
        payload: input.oracle,
      });
    }

    return {
      batchId,
      insertedEntities,
      insertedLinks,
      skipped,
      insertedEntityIds,
      insertedLinkIds,
      skippedRecordIds,
      unresolvedLinks,
      errors,
    };
  })();
}

export function withImportSourceMetadata(
  record: LimsApplyImportBatchInput['records'][number],
  input: LimsApplyImportBatchInput
): LimsRegisterEntityInput {
  const existing = record.entity.fields.sourceMetadata;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return record.entity;
  }
  return {
    ...record.entity,
    fields: {
      ...record.entity.fields,
      sourceMetadata: buildImportSourceMetadata(record, input),
    },
  };
}

export function buildImportSourceMetadata(
  record: LimsApplyImportBatchInput['records'][number],
  input: LimsApplyImportBatchInput
): LimsSourceMetadata {
  const metadata: LimsSourceMetadata = {
    schemaVersion: 1,
    origin: {
      type: 'file_import',
      sourceName: input.sourceName,
      sourceKind: input.sourceKind,
    },
    importRecordId: record.id,
    values: { ...record.source },
  };
  if (typeof record.sourceRow === 'number') {
    metadata.row = { index: record.sourceRow };
  }
  return metadata;
}

export function importRecordInBatchDuplicateReason(
  record: LimsApplyImportBatchInput['records'][number],
  seen: Set<string>
): string | null {
  const keys = importRecordInBatchKeys(record);
  for (const key of keys) {
    if (seen.has(key)) return inBatchDuplicateReasonForKey(key);
  }
  for (const key of keys) seen.add(key);
  return null;
}

export function importRecordInBatchKeys(
  record: LimsApplyImportBatchInput['records'][number]
): string[] {
  const kind = record.entity.kind;
  const keys: string[] = [];

  const seq = record.entity.fields.sequence as
    | {
        mode?: string;
        bases?: string;
        contentHash?: string;
        fileContentHash?: string;
        normalizedSequenceHash?: string;
      }
    | undefined;
  if (seq?.mode === 'inline' && seq.bases) keys.push(`inline:${kind}:${seq.bases}`);
  if (seq?.mode === 'file') {
    const fileHash = seq.fileContentHash ?? seq.contentHash;
    if (fileHash) keys.push(`file:${fileHash}`);
    if (seq.normalizedSequenceHash) keys.push(`norm:${seq.normalizedSequenceHash}`);
  }
  return keys;
}

export function inBatchDuplicateReasonForKey(key: string): string {
  if (key.startsWith('name:')) return 'another row in this import has the same name';
  if (key.startsWith('inline:')) return 'another row in this import has the same inline sequence';
  if (key.startsWith('file:')) return 'another row in this import has the same file-byte hash';
  return 'another row in this import has the same normalized sequence hash';
}

export function preflightLimsImportBatchApply(
  db: Database.Database,
  input: LimsApplyImportBatchInput
): Array<{ recordId: string; reason: string }> {
  const errors: Array<{ recordId: string; reason: string }> = [];

  const seenInBatch = new Set<string>();

  const duplicateIndexes = buildApplyDuplicateIndexes(
    db,
    new Set(input.records.map((record) => record.entity.kind))
  );

  const batchNames = new Set(
    input.records
      .filter((record) => shouldApplyImportRecord(record))
      .map((record) => record.entity.name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  );
  for (const record of input.records) {
    if (!shouldApplyImportRecord(record)) continue;
    if (record.action !== 'register_entity') {
      errors.push({ recordId: record.id, reason: `Unsupported import action: ${record.action}` });
      continue;
    }
    for (const unresolved of record.unresolvedLinks ?? []) {
      if (unresolved.severity === 'blocking') {
        errors.push({
          recordId: record.id,
          reason: `Blocking unresolved ${unresolved.type ?? 'link'} reference ${unresolved.label}: ${unresolved.reason}`,
        });
      }
    }
    try {
      assertImportRecordFileSequencesResolvable(record);
    } catch (err) {
      errors.push({ recordId: record.id, reason: errorMessage(err) });
    }
    const existingDuplicate = findImportDuplicateInIndex(
      record,
      duplicateIndexes.get(record.entity.kind)
    );
    const duplicateReason = existingDuplicate
      ? importDuplicateReason(record, existingDuplicate)
      : null;
    if (duplicateReason) {
      errors.push({ recordId: record.id, reason: duplicateReason });
    }
    const inBatchReason = importRecordInBatchDuplicateReason(record, seenInBatch);
    if (inBatchReason) {
      errors.push({
        recordId: record.id,
        reason: `Duplicate within import batch: ${inBatchReason}.`,
      });
    }
    for (const link of record.links ?? []) {
      for (const side of ['from', 'to'] as const) {
        try {
          assertImportLinkEndpointResolvable(db, link, side, batchNames);
        } catch (err) {
          errors.push({ recordId: record.id, reason: errorMessage(err) });
        }
      }
    }
  }
  return errors;
}

export function shouldApplyImportRecord(
  record: LimsApplyImportBatchInput['records'][number]
): boolean {
  return record.accepted && !record.duplicateOf && (!record.errors || record.errors.length === 0);
}

export function prepareLimsImportBatchUndoInDb(
  db: Database.Database,
  input: LimsUndoImportBatchInput
) {
  const batchId = input.batchId.trim();
  if (!batchId) throw new Error('LIMS import undo requires a batch id');

  const importAudit = db
    .prepare(
      `SELECT * FROM lims_audit
       WHERE batch_id = ? AND event_type = 'import_batch_applied' AND tombstone = 0
       ORDER BY event_seq DESC
       LIMIT 1`
    )
    .get(batchId) as LimsAuditRow | undefined;
  if (!importAudit) throw new Error(`No applied LIMS import batch found: ${batchId}`);

  const undoneAudit = db
    .prepare(
      `SELECT id FROM lims_audit
       WHERE batch_id = ? AND event_type = 'import_batch_undone' AND tombstone = 0
       LIMIT 1`
    )
    .get(batchId) as { id: string } | undefined;
  if (undoneAudit) throw new Error(`LIMS import batch has already been undone: ${batchId}`);

  const entityAudits = db
    .prepare(
      `SELECT * FROM lims_audit
       WHERE batch_id = ? AND event_type = 'entity_registered' AND subject_table = 'lims_entity'
       ORDER BY event_seq DESC`
    )
    .all(batchId) as LimsAuditRow[];
  const linkAudits = db
    .prepare(
      `SELECT * FROM lims_audit
       WHERE batch_id = ? AND event_type = 'link_created' AND subject_table = 'lims_link'
       ORDER BY event_seq DESC`
    )
    .all(batchId) as LimsAuditRow[];
  const entityIds = uniqueAuditSubjectIds(entityAudits);
  const linkIds = uniqueAuditSubjectIds(linkAudits);
  if (entityIds.length === 0 && linkIds.length === 0) {
    throw new Error(`LIMS import batch has no created records to undo: ${batchId}`);
  }

  const entityRows = getRowsByIds<LimsEntityRow>(db, 'lims_entity', entityIds);
  const linkRows = getRowsByIds<LimsLinkRow>(db, 'lims_link', linkIds);

  const staleEntity = entityRows.find((row) => {
    if (row.tombstone) return false;
    const createdAudit = entityAudits.find((audit) => audit.subject_id === row.id);
    return Boolean(createdAudit && row.event_seq !== createdAudit.event_seq);
  });
  if (staleEntity) {
    throw withUserMessage(
      new Error(`Cannot undo import batch; entity modified since import: ${staleEntity.id}`),
      'registry.undoChanged'
    );
  }

  assertNoActiveNonBatchLinksForImportedEntities(db, entityIds, new Set(linkIds), batchId);

  assertEnrolledPrimerPhysicalMutationAllowed(db, [
    ...entityRows.filter((row) => !row.tombstone).map((row) => row.id),
    ...linkRows
      .filter((row) => !row.tombstone)
      .flatMap((row) => [row.from_entity_id, row.to_entity_id]),
  ]);
  return { batchId, importAudit, entityRows, linkRows };
}

export function undoLimsImportBatchInDb(
  db: Database.Database,
  input: LimsUndoImportBatchInput
): LimsUndoImportBatchResult {
  seedLimsBuiltinsInDb(db);
  return db.transaction(() => {
    const { batchId, importAudit, entityRows, linkRows } = prepareLimsImportBatchUndoInDb(
      db,
      input
    );

    const actor = input.actor ?? LOCAL_ACTOR;
    let tombstonedLinks = 0;
    let skippedLinks = 0;
    for (const row of linkRows) {
      if (row.tombstone) {
        skippedLinks++;
        continue;
      }
      tombstoneLimsLinkInsideTx(db, row, {
        actor,
        batchId,
        reason: 'import_batch_undo',
      });
      tombstonedLinks++;
    }

    let tombstonedEntities = 0;
    let skippedEntities = 0;
    for (const row of entityRows) {
      if (row.tombstone) {
        skippedEntities++;
        continue;
      }
      tombstoneLimsEntityInsideTx(db, row, {
        actor,
        batchId,
        reason: 'import_batch_undo',
      });
      tombstonedEntities++;
    }

    insertAuditEvent(db, {
      eventType: 'import_batch_undone',
      subjectTable: 'lims_audit',
      subjectId: importAudit.id,
      batchId,
      actor,
      payload: {
        tombstonedEntities,
        tombstonedLinks,
        skippedEntities,
        skippedLinks,
      },
    });

    return {
      batchId,
      tombstonedEntities,
      tombstonedLinks,
      skippedEntities,
      skippedLinks,
    };
  })();
}

export function assertImportRecordFileSequencesResolvable(
  record: LimsApplyImportBatchInput['records'][number]
): void {
  const sequence = record.entity.fields.sequence as DnaSequenceRef | undefined;
  if (sequence?.mode !== 'file') return;
  if (!existsSync(sequence.relPath)) {
    throw new Error(
      `Imported file-backed sequence requires a resolvable durable source path: ${sequence.relPath}`
    );
  }
}

export function assertImportLinkEndpointResolvable(
  db: Database.Database,
  link: LimsImportLinkPreview,
  side: 'from' | 'to',
  batchNames?: ReadonlySet<string>
): void {
  const directId = side === 'from' ? link.fromEntityId : link.toEntityId;
  const lookup = side === 'from' ? link.fromEntityLookup : link.toEntityLookup;
  if (!directId && !lookup) return;

  if (lookup && batchNames && batchNames.has(lookup.name.trim().toLowerCase())) return;
  resolveImportLinkEndpoint(db, link, side, '__new-import-record__');
}

export interface ApplyDuplicateIndex {
  byName: Map<string, LimsEntity>;
  bySeq: Map<string, LimsEntity>;
}

export type ApplySequenceRefShape = {
  mode?: string;
  bases?: string;
  contentHash?: string;
  fileContentHash?: string;
  normalizedSequenceHash?: string;
};

export function buildApplyDuplicateIndexes(
  db: Database.Database,
  kinds: Set<string>
): Map<string, ApplyDuplicateIndex> {
  const indexes = new Map<string, ApplyDuplicateIndex>();
  const statement = db.prepare(`SELECT * FROM lims_entity WHERE kind = ? AND tombstone = 0`);
  for (const kind of kinds) {
    const rows = statement.all(kind) as LimsEntityRow[];
    const byName = new Map<string, LimsEntity>();
    const bySeq = new Map<string, LimsEntity>();
    for (const row of rows) {
      const entity = limsEntityFromRow(row);
      const name = entity.name.trim().toLowerCase();
      if (name && !byName.has(name)) byName.set(name, entity);
      const seq = entity.fields.sequence as ApplySequenceRefShape | undefined;
      if (seq?.mode === 'inline' && seq.bases) setIfAbsent(bySeq, `inline:${seq.bases}`, entity);
      if (seq?.mode === 'file') {
        const fileHash = seq.fileContentHash ?? seq.contentHash;
        if (fileHash) setIfAbsent(bySeq, `file:${fileHash}`, entity);
        if (seq.normalizedSequenceHash) {
          setIfAbsent(bySeq, `norm:${seq.normalizedSequenceHash}`, entity);
        }
      }
    }
    indexes.set(kind, { byName, bySeq });
  }
  return indexes;
}

export function setIfAbsent(map: Map<string, LimsEntity>, key: string, entity: LimsEntity): void {
  if (!map.has(key)) map.set(key, entity);
}

export function findImportDuplicateInIndex(
  record: LimsApplyImportBatchInput['records'][number],
  index: ApplyDuplicateIndex | undefined
): LimsEntity | null {
  if (!index) return null;

  const seq = record.entity.fields.sequence as ApplySequenceRefShape | undefined;
  if (seq?.mode === 'file') {
    const fileHash = seq.fileContentHash ?? seq.contentHash;
    if (fileHash) {
      const hit = index.bySeq.get(`file:${fileHash}`);
      if (hit) return hit;
    }
  }
  return null;
}

export function importDuplicateReason(
  record: LimsApplyImportBatchInput['records'][number],
  existing: LimsEntity
): string | null {
  const nextSeq = record.entity.fields.sequence as
    | { mode?: string; contentHash?: string; fileContentHash?: string }
    | undefined;
  const existingSeq = existing.fields.sequence as
    | { mode?: string; contentHash?: string; fileContentHash?: string }
    | undefined;
  if (nextSeq?.mode === 'file' && existingSeq?.mode === 'file') {
    const nextFileHash = nextSeq.fileContentHash ?? nextSeq.contentHash;
    const existingFileHash = existingSeq.fileContentHash ?? existingSeq.contentHash;
    if (nextFileHash && existingFileHash && nextFileHash === existingFileHash) {
      return `Existing registry record ${existing.id} has the same file-byte hash.`;
    }
  }
  return null;
}

export function uniqueAuditSubjectIds(rows: readonly LimsAuditRow[]): string[] {
  return [...new Set(rows.map((row) => row.subject_id).filter((id): id is string => Boolean(id)))];
}

export function getRowsByIds<T>(
  db: Database.Database,
  table: 'lims_entity' | 'lims_link',
  ids: readonly string[]
): T[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...ids) as T[];
}

export function assertNoActiveNonBatchLinksForImportedEntities(
  db: Database.Database,
  entityIds: readonly string[],
  batchLinkIds: ReadonlySet<string>,
  batchId: string
): void {
  if (entityIds.length === 0) return;
  const placeholders = entityIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM lims_link
       WHERE tombstone = 0
         AND (from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders}))`
    )
    .all(...entityIds, ...entityIds) as LimsLinkRow[];
  const external = rows.filter((row) => !batchLinkIds.has(row.id));
  if (external.length > 0) {
    throw new Error(
      `Cannot undo import batch ${batchId}; imported entities have active links outside the batch: ${external
        .map((row) => row.id)
        .join(', ')}`
    );
  }
}

export function tombstoneRowInsideTx<
  TRow extends { id: string },
  T extends { workspaceId: number | null },
>(
  db: Database.Database,
  row: TRow,
  config: {
    fromRow: (row: TRow) => T;
    reloadRow: (db: Database.Database, id: string) => TRow;
    upsertProjection: (db: Database.Database, value: T) => void;
  } & (
    | { table: 'lims_entity'; eventType: 'entity_tombstoned' }
    | { table: 'lims_link'; eventType: 'link_tombstoned' }
  ),
  input: { actor: string; batchId: string; reason: string }
): T {
  const before = config.fromRow(row);
  const eventSeq = nextEventSeq(db);
  const now = Date.now();
  const current = config.fromRow(config.reloadRow(db, row.id));
  const after = {
    ...current,
    actor: input.actor,
    eventSeq,
    tombstone: true,
    updatedAt: now,
    archivedAt: now,
  } as T;
  insertAuditEvent(db, {
    eventSeq,
    eventType: config.eventType,
    subjectTable: config.table,
    subjectId: row.id,
    batchId: input.batchId,
    actor: input.actor,
    workspaceId: after.workspaceId,
    before,
    after,
    payload: { reason: input.reason },
  });
  config.upsertProjection(db, after);
  return after;
}

export function tombstoneLimsLinkInsideTx(
  db: Database.Database,
  row: LimsLinkRow,
  input: { actor: string; batchId: string; reason: string }
): LimsLink {
  return tombstoneRowInsideTx(
    db,
    row,
    {
      table: 'lims_link',
      eventType: 'link_tombstoned',
      fromRow: limsLinkFromRow,
      reloadRow: getLinkRowById,
      upsertProjection: upsertLimsLinkProjectionInsideTx,
    },
    input
  );
}

export function tombstoneLimsEntityInsideTx(
  db: Database.Database,
  row: LimsEntityRow,
  input: { actor: string; batchId: string; reason: string }
): LimsEntity {
  return tombstoneRowInsideTx(
    db,
    row,
    {
      table: 'lims_entity',
      eventType: 'entity_tombstoned',
      fromRow: limsEntityFromRow,
      reloadRow: getEntityRowById,
      upsertProjection: upsertLimsEntityProjectionInsideTx,
    },
    input
  );
}

export function resolveImportLinkEndpoints(
  db: Database.Database,
  link: LimsImportLinkPreview,
  importedEntityId: string
): { fromEntityId: string; toEntityId: string } {
  const fromEntityId = resolveImportLinkEndpoint(db, link, 'from', importedEntityId);
  const toEntityId = resolveImportLinkEndpoint(db, link, 'to', importedEntityId);
  return { fromEntityId, toEntityId };
}

export function resolveImportLinkEndpoint(
  db: Database.Database,
  link: LimsImportLinkPreview,
  side: 'from' | 'to',
  importedEntityId: string
): string {
  const directId = side === 'from' ? link.fromEntityId : link.toEntityId;
  if (directId) {
    getEntityRowById(db, directId);
    return directId;
  }
  const lookup = side === 'from' ? link.fromEntityLookup : link.toEntityLookup;
  if (!lookup) return importedEntityId;
  const where = ['tombstone = 0', 'name = ?'];
  const params: unknown[] = [lookup.name];
  if (lookup.kind) {
    where.push('kind = ?');
    params.push(lookup.kind);
  }

  const rows = db
    .prepare(`SELECT * FROM lims_entity WHERE ${where.join(' AND ')}`)
    .all(...params) as LimsEntityRow[];
  if (rows.length === 0) {
    throw new Error(
      `Import link ${link.type} ${side} endpoint not found: ${lookup.kind ?? 'any'} ${lookup.name}`
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `Import link ${link.type} ${side} endpoint is ambiguous: ${rows.length} live records named "${lookup.name}". Refusing to guess.`
    );
  }
  return rows[0].id;
}
