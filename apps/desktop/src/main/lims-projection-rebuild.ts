import type Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import {
  LIMS_ENTITY_STATE_EVENT_TYPES,
  limsSchemaFieldsJson,
  parseLimsSchemaFields,
  serializeLimsSchemaDefinition,
  type LimsAuditRow,
  type LimsBuiltinSchemaDefinition,
  type LimsContentPin,
  type LimsEntity,
  type LimsLink,
  type LimsSchemaRevisionRow,
  type LimsSchemaRow,
} from '../shared/lims';
import {
  computeLimsAuditHash,
  retireArtifactRegistryCatalogProjectionInsideTx,
  deterministicSchemaId,
  LIMS_LOCAL_CLIENT_ID,
  syncLimsEventSequenceToAuditInsideTx,
  replayHistoricalLimsEntityProjectionInsideTx,
  upsertLimsLinkProjectionInsideTx,
  upsertLimsSchemaProjectionInsideTx,
  upsertLimsSchemaRevisionProjectionInsideTx,
  verifyLimsContentPinResolves,
} from './lims-engine-core';

const ENTITY_STATE_EVENTS = new Set<string>(LIMS_ENTITY_STATE_EVENT_TYPES);
const LINK_STATE_EVENTS = new Set<string>([
  'link_created',
  'link_reactivated',
  'link_updated',
  'link_tombstoned',
]);

export class UnverifiedLimsHistoryError extends Error {}

export interface LimsProjectionRebuildResult {
  appliedEvents: number;
  skippedDuplicateEvents: number;
}

export interface LimsContentPinHealth {
  ok: boolean;
  checkedPins: number;
  danglingPins: Array<LimsContentPin & { auditId: string; eventSeq: number }>;
}

export interface LimsAuditHashChainHealth {
  ok: boolean;
  checkedEvents: number;
  failures: Array<{
    auditId: string;
    eventSeq: number;
    reason: 'missing_hash' | 'prev_hash_mismatch' | 'hash_mismatch';
  }>;
}

export interface LimsAuditRestoreResult {
  importedEvents: number;
  skippedDuplicateEvents: number;
  projection: LimsProjectionRebuildResult;
}

type ProjectionSnapshot = Record<
  'lims_schema' | 'lims_schema_revision' | 'lims_entity' | 'lims_link',
  unknown[]
>;

type AuditReplayRow = LimsAuditRow & {
  schema_version?: number | null;
  idempotency_key?: string | null;
};

export function rebuildLimsProjectionInDb(db: Database.Database): LimsProjectionRebuildResult {
  const rows = db
    .prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`)
    .all() as AuditReplayRow[];
  return rebuildLimsProjectionFromAuditRowsInDb(db, rows);
}

export function rebuildLimsProjectionFromAuditRowsInDb(
  db: Database.Database,
  rows: readonly AuditReplayRow[]
): LimsProjectionRebuildResult {
  assertVerifiedAuditRows(rows);
  return db.transaction(() => {
    clearProjectionTables(db);
    return replayAuditRowsIntoProjection(db, rows);
  })();
}

export function restoreLimsAuditAndProjectionFromRowsInDb(
  db: Database.Database,
  rows: readonly AuditReplayRow[]
): LimsAuditRestoreResult {
  return db.transaction(() => {
    const orderedRows = [...rows].sort((a, b) => a.event_seq - b.event_seq);
    assertRestorableAuditRows(orderedRows);
    const hashHealth = verifyLimsAuditHashChainRows(orderedRows);
    if (!hashHealth.ok) {
      const firstFailure = hashHealth.failures[0];
      throw new Error(
        `LIMS audit export hash-chain verification failed at event ${firstFailure.eventSeq}: ${firstFailure.reason}`
      );
    }

    let importedEvents = 0;
    let skippedDuplicateEvents = 0;
    for (const row of orderedRows) {
      const idempotencyKey = row.idempotency_key ?? `lims:v0:${row.id}`;
      const existing = db
        .prepare(`SELECT event_seq, id, hash FROM lims_audit WHERE idempotency_key = ? LIMIT 1`)
        .get(idempotencyKey) as { event_seq: number; id: string; hash: string | null } | undefined;
      if (existing) {
        if (
          existing.event_seq !== row.event_seq ||
          existing.id !== row.id ||
          existing.hash !== row.hash
        ) {
          throw new Error(`Conflicting LIMS audit event for idempotency key ${idempotencyKey}`);
        }
        skippedDuplicateEvents++;
        continue;
      }
      const eventSeqConflict = db
        .prepare(`SELECT id FROM lims_audit WHERE event_seq = ? LIMIT 1`)
        .get(row.event_seq) as { id: string } | undefined;
      if (eventSeqConflict) {
        throw new Error(`Conflicting LIMS audit event_seq ${row.event_seq}`);
      }
      insertAuditRow(db, row);
      importedEvents++;
    }

    syncLimsEventSequenceToAuditInsideTx(db);
    clearProjectionTables(db);
    const allRows = db
      .prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`)
      .all() as AuditReplayRow[];
    const projection = replayAuditRowsIntoProjection(db, allRows);
    return { importedEvents, skippedDuplicateEvents, projection };
  })();
}

export function assertLimsProjectionReplayParityInDb(
  db: Database.Database
): LimsProjectionRebuildResult {
  const rows = db
    .prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`)
    .all() as AuditReplayRow[];
  return assertLimsProjectionReplayParityFromAuditRowsInDb(db, rows);
}

export function assertLimsProjectionReplayParityFromAuditRowsInDb(
  db: Database.Database,
  rows: readonly AuditReplayRow[]
): LimsProjectionRebuildResult {
  assertVerifiedAuditRows(rows);
  const before = projectionSnapshot(db);
  return db.transaction(() => {
    clearProjectionTables(db);
    const result = replayAuditRowsIntoProjection(db, rows);
    const after = projectionSnapshot(db);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(
        'LIMS projection parity failed: audit replay did not reproduce projection rows'
      );
    }
    return result;
  })();
}

export function replayAuditRowsIntoProjection(
  db: Database.Database,
  rows: readonly AuditReplayRow[]
): LimsProjectionRebuildResult {
  const seen = new Set<string>();
  let appliedEvents = 0;
  let skippedDuplicateEvents = 0;
  for (const row of rows) {
    const idempotencyKey = row.idempotency_key ?? `lims:v0:${row.id}`;
    if (seen.has(idempotencyKey)) {
      skippedDuplicateEvents++;
      continue;
    }
    seen.add(idempotencyKey);
    if (applyAuditRowToProjection(db, row)) appliedEvents++;
  }
  return { appliedEvents, skippedDuplicateEvents };
}

export function verifyLimsContentPinsInDb(db: Database.Database): LimsContentPinHealth {
  const rows = db
    .prepare(
      `SELECT id, event_seq, payload
       FROM lims_audit
       WHERE payload IS NOT NULL
       ORDER BY event_seq ASC`
    )
    .all() as Array<{ id: string; event_seq: number; payload: string }>;
  const danglingPins: LimsContentPinHealth['danglingPins'] = [];
  let checkedPins = 0;
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload);
    const pins = payload && Array.isArray(payload.contentPins) ? payload.contentPins : [];
    for (const pin of pins) {
      if (!isLimsContentPin(pin) || !pin.contentHash.startsWith('git:')) continue;
      checkedPins++;
      if (!verifyLimsContentPinResolves(pin)) {
        danglingPins.push({ ...pin, auditId: row.id, eventSeq: row.event_seq });
      }
    }
  }
  return { ok: danglingPins.length === 0, checkedPins, danglingPins };
}

export function verifyLimsAuditHashChainInDb(db: Database.Database): LimsAuditHashChainHealth {
  const rows = db
    .prepare(`SELECT * FROM lims_audit ORDER BY event_seq ASC`)
    .all() as AuditReplayRow[];
  return verifyLimsAuditHashChainRows(rows);
}

export function verifyLimsAuditHashChainRows(
  rows: readonly AuditReplayRow[]
): LimsAuditHashChainHealth {
  const failures: LimsAuditHashChainHealth['failures'] = [];
  let checkedEvents = 0;
  let previousHash: string | null = null;
  for (const row of rows) {
    const schemaVersion = row.schema_version ?? 0;
    if (schemaVersion < 1) continue;
    checkedEvents++;
    if (!row.hash) {
      failures.push({ auditId: row.id, eventSeq: row.event_seq, reason: 'missing_hash' });
      previousHash = row.hash ?? previousHash;
      continue;
    }
    if ((row.prev_hash ?? null) !== previousHash) {
      failures.push({ auditId: row.id, eventSeq: row.event_seq, reason: 'prev_hash_mismatch' });
    }
    const expected = computeLimsAuditHash({
      id: row.id,
      event_seq: row.event_seq,
      schema_version: schemaVersion,
      idempotency_key: row.idempotency_key ?? `lims:v${schemaVersion}:${row.id}`,
      operation_id: row.operation_id ?? null,
      event_type: row.event_type,
      subject_table: row.subject_table,
      subject_id: row.subject_id,
      batch_id: row.batch_id,
      actor: row.actor,
      actor_client_id: row.actor_client_id ?? LIMS_LOCAL_CLIENT_ID,
      actor_user_id: row.actor_user_id ?? row.actor,
      workspace_id: row.workspace_id,
      before: parseJson<unknown>(row.before),
      after: parseJson<unknown>(row.after),
      payload: parseJson<unknown>(row.payload),
      prev_hash: row.prev_hash ?? null,
      tombstone: row.tombstone,
      created_at: row.created_at,
    });
    if (row.hash !== expected) {
      failures.push({ auditId: row.id, eventSeq: row.event_seq, reason: 'hash_mismatch' });
    }
    previousHash = row.hash;
  }
  return { ok: failures.length === 0, checkedEvents, failures };
}

function assertRestorableAuditRows(rows: readonly AuditReplayRow[]): void {
  const seenSeq = new Set<number>();
  const seenIds = new Set<string>();
  const seenIdempotencyKeys = new Set<string>();
  for (const row of rows) {
    if (!Number.isInteger(row.event_seq) || row.event_seq < 1) {
      throw new Error(`Invalid LIMS audit event_seq: ${row.event_seq}`);
    }
    if (seenSeq.has(row.event_seq))
      throw new Error(`Duplicate LIMS audit event_seq: ${row.event_seq}`);
    seenSeq.add(row.event_seq);
    if (seenIds.has(row.id)) throw new Error(`Duplicate LIMS audit id: ${row.id}`);
    seenIds.add(row.id);
    const key = row.idempotency_key ?? `lims:v0:${row.id}`;
    if (seenIdempotencyKeys.has(key)) {
      throw new Error(`Duplicate LIMS audit idempotency key: ${key}`);
    }
    seenIdempotencyKeys.add(key);
  }
}

function insertAuditRow(db: Database.Database, row: AuditReplayRow): void {
  db.prepare(
    `INSERT INTO lims_audit (
      id, event_seq, schema_version, idempotency_key, event_type,
      operation_id, subject_table, subject_id, batch_id, actor,
      actor_client_id, actor_user_id, workspace_id, before, after, payload,
      prev_hash, hash, tombstone, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.event_seq,
    row.schema_version ?? 0,
    row.idempotency_key ?? `lims:v0:${row.id}`,
    row.event_type,
    row.operation_id ?? null,
    row.subject_table,
    row.subject_id,
    row.batch_id,
    row.actor,
    row.actor_client_id ?? null,
    row.actor_user_id ?? null,
    row.workspace_id,
    row.before,
    row.after,
    row.payload,
    row.prev_hash ?? null,
    row.hash ?? null,
    row.tombstone,
    row.created_at
  );
}

function clearProjectionTables(db: Database.Database): void {
  retireArtifactRegistryCatalogProjectionInsideTx(db);
  db.prepare(`DELETE FROM lims_link`).run();
  db.prepare(`DELETE FROM lims_entity`).run();
  db.prepare(`DELETE FROM lims_schema_revision`).run();
  db.prepare(`DELETE FROM lims_schema`).run();
}

function projectionSnapshot(db: Database.Database): ProjectionSnapshot {
  return {
    lims_schema: tableSnapshot(db, 'lims_schema'),
    lims_schema_revision: tableSnapshot(db, 'lims_schema_revision'),
    lims_entity: tableSnapshot(db, 'lims_entity'),
    lims_link: tableSnapshot(db, 'lims_link'),
  };
}

function tableSnapshot(db: Database.Database, table: keyof ProjectionSnapshot): unknown[] {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all() as Array<
    Record<string, unknown>
  >;
  if (table !== 'lims_schema' && table !== 'lims_schema_revision') return rows;
  return rows.map((row) => {
    const schemaName =
      table === 'lims_schema'
        ? row.name
        : (
            db.prepare('SELECT name FROM lims_schema WHERE id=?').get(row.schema_id) as
              | { name: string }
              | undefined
          )?.name;
    const canonical = { ...row };
    if (typeof row.fields === 'string' && typeof schemaName === 'string') {
      const definition = parseLimsSchemaFields(row.fields);
      canonical.fields = serializeLimsSchemaDefinition({
        ...definition,
        baseKind: definition.baseKind ?? schemaName,
      });
    }

    const seed = db
      .prepare('SELECT after,created_at FROM lims_audit WHERE event_seq=?')
      .get(row.event_seq) as { after: string | null; created_at: number } | undefined;
    if (seed && isBuiltinSchemaDefinition(parseJson<unknown>(seed.after))) {
      canonical.created_at = seed.created_at;
      if (table === 'lims_schema') canonical.updated_at = seed.created_at;
    }
    return canonical;
  });
}

function applyAuditRowToProjection(db: Database.Database, row: AuditReplayRow): boolean {
  const after = parseJson<unknown>(row.after);
  if (row.subject_table === 'lims_schema' && row.event_type.startsWith('schema_')) {
    return applySchemaEvent(db, row, after);
  }
  if (row.subject_table === 'lims_entity' && ENTITY_STATE_EVENTS.has(row.event_type)) {
    if (!isLimsEntity(after)) return false;
    replayHistoricalLimsEntityProjectionInsideTx(db, resolveRecoveredEntityBindings(db, after));
    return true;
  }
  if (row.subject_table === 'lims_link' && LINK_STATE_EVENTS.has(row.event_type)) {
    if (!isLimsLink(after)) return false;
    upsertLimsLinkProjectionInsideTx(db, after);
    return true;
  }
  return false;
}

function assertVerifiedAuditRows(rows: readonly AuditReplayRow[]): void {
  const unique = new Map<string, AuditReplayRow>();
  for (const row of rows) {
    const key = row.idempotency_key ?? `lims:v0:${row.id}`;
    const previous = unique.get(key);
    if (previous) {
      const keys = [...new Set([...Object.keys(previous), ...Object.keys(row)])].sort();
      if (
        keys.some(
          (field) => previous[field as keyof AuditReplayRow] !== row[field as keyof AuditReplayRow]
        )
      ) {
        throw new UnverifiedLimsHistoryError(
          `Registry history integrity check failed: conflicting event ${key}`
        );
      }
      continue;
    }
    unique.set(key, row);
  }
  const health = verifyLimsAuditHashChainRows([...unique.values()]);
  if (!health.ok) {
    const first = health.failures[0];
    throw new UnverifiedLimsHistoryError(
      `Registry history integrity check failed at event ${first.eventSeq}: ${first.reason}`
    );
  }
}

export function resolveRecoveredEntityBindings(
  db: Database.Database,
  entity: LimsEntity
): LimsEntity {
  const binding = db
    .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
    .get(entity.id) as { path: string } | undefined;
  const fields = { ...entity.fields };
  if (typeof fields.packagePath === 'string') {
    fields.packagePath = binding?.path ?? resolveManagedWorkspacePath(db, fields.packagePath);
  }
  const managed = fields._managedSequenceDocument;
  if (
    isRecord(managed) &&
    managed.packageId === entity.id &&
    typeof managed.packageRoot === 'string'
  ) {
    fields._managedSequenceDocument = {
      ...managed,
      packageRoot: binding?.path ?? resolveManagedWorkspacePath(db, managed.packageRoot),
    };
  }
  const sequence = fields.sequence;
  if (isRecord(sequence) && sequence.mode === 'file' && typeof sequence.relPath === 'string') {
    fields.sequence = { ...sequence, relPath: resolveManagedWorkspacePath(db, sequence.relPath) };
  }
  return { ...entity, fields };
}

function resolveManagedWorkspacePath(db: Database.Database, path: string): string {
  if (!isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  const match = /^(.*\/managed-workspaces\/([^/]+)\/repo)(?=\/|$)/.exec(normalized);
  if (!match) return path;
  const candidates = db
    .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
    .all(match[2]) as Array<{ path: string }>;
  const roots = [...new Set(candidates.map((row) => row.path))];

  if (roots.length !== 1) return path;
  const root = roots[0].replace(/[\\/]+$/, '');
  const suffix = normalized.slice(match[1].length);
  return root + (root.includes('\\') ? suffix.replace(/\//g, '\\') : suffix);
}

type RecoveredSchema = { schema: LimsSchemaRow; revision: LimsSchemaRevisionRow };

function planLimsEntityRecoveryFromVerifiedAudit(db: Database.Database, entityId: string) {
  const rows = db
    .prepare('SELECT * FROM lims_audit ORDER BY event_seq ASC')
    .all() as AuditReplayRow[];
  assertVerifiedAuditRows(rows);
  const entities = new Map<string, unknown>();
  const links = new Map<string, LimsLink>();
  const schemas = new Map<string, RecoveredSchema[]>();
  const revisionOwners = new Map<string, string>();
  for (const row of rows) {
    const after = parseJson<unknown>(row.after);
    if (
      row.subject_table === 'lims_entity' &&
      ENTITY_STATE_EVENTS.has(row.event_type) &&
      row.subject_id
    ) {
      entities.set(row.subject_id, after);
    } else if (
      row.subject_table === 'lims_link' &&
      LINK_STATE_EVENTS.has(row.event_type) &&
      isLimsLink(after)
    ) {
      links.set(after.id, after);
    } else if (row.subject_table === 'lims_schema') {
      const schema = schemaRowsFromEvent(row, after);
      if (!schema) continue;
      const family = schemas.get(schema.schema.id) ?? [];
      family.push(schema);
      schemas.set(schema.schema.id, family);
      revisionOwners.set(schema.revision.id, schema.schema.id);
    }
  }
  const requested = entities.get(entityId);
  if (!isLimsEntity(requested) || requested.id !== entityId) return null;
  const adjacency = new Map<string, LimsLink[]>();
  for (const link of links.values()) {
    for (const endpoint of new Set([link.fromEntityId, link.toEntityId])) {
      const edges = adjacency.get(endpoint) ?? [];
      edges.push(link);
      adjacency.set(endpoint, edges);
    }
  }
  const existingEntity = db.prepare('SELECT 1 FROM lims_entity WHERE id=?');
  const existingSchema = db.prepare('SELECT 1 FROM lims_schema WHERE id=?');
  const existingRevision = db.prepare('SELECT 1 FROM lims_schema_revision WHERE id=?');
  const existingLink = db.prepare('SELECT 1 FROM lims_link WHERE id=?');
  const missingEntities = new Map<string, LimsEntity>();
  const missingSchemas = new Map<string, LimsSchemaRow>();
  const missingRevisions = new Map<string, RecoveredSchema>();
  const missingLinks = new Map<string, LimsLink>();
  const queue = [entityId];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (visited.has(id)) continue;
    visited.add(id);

    if (existingEntity.get(id)) continue;
    const state = entities.get(id);
    if (!isLimsEntity(state) || state.id !== id) {
      throw new UnverifiedLimsHistoryError(
        `Registry recovery has no verified authority for related record ${id}.`
      );
    }
    const schemaId = state.schemaId ?? revisionOwners.get(state.schemaRevisionId);
    const family = schemaId ? (schemas.get(schemaId) ?? []) : [];
    const latest = family.at(-1);
    if (latest && !existingSchema.get(latest.schema.id)) {
      missingSchemas.set(latest.schema.id, latest.schema);
    }
    for (const schema of family) {
      if (!missingRevisions.has(schema.revision.id) && !existingRevision.get(schema.revision.id)) {
        missingRevisions.set(schema.revision.id, schema);
      }
    }
    if (
      !missingRevisions.has(state.schemaRevisionId) &&
      !existingRevision.get(state.schemaRevisionId)
    ) {
      throw new UnverifiedLimsHistoryError(
        `Registry recovery has no verified schema revision for related record ${id}.`
      );
    }
    missingEntities.set(id, resolveRecoveredEntityBindings(db, state));
    for (const link of adjacency.get(id) ?? []) {
      if (!existingLink.get(link.id)) missingLinks.set(link.id, link);
      for (const endpoint of [link.fromEntityId, link.toEntityId]) {
        if (!visited.has(endpoint) && !existingEntity.get(endpoint)) queue.push(endpoint);
      }
    }
  }
  return { missingEntities, missingSchemas, missingRevisions, missingLinks };
}

export function inspectLimsEntityFromVerifiedAuditInDb(db: Database.Database, entityId: string) {
  const hasHistory = db
    .prepare("SELECT 1 FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=? LIMIT 1")
    .get(entityId);
  if (!hasHistory) return null;
  const plan = planLimsEntityRecoveryFromVerifiedAudit(db, entityId);
  const entity = plan?.missingEntities.get(entityId);
  if (!plan || !entity) return null;
  const schema = plan.missingRevisions.get(entity.schemaRevisionId);
  const currentSchema =
    schema &&
    (plan.missingSchemas.get(schema.schema.id) ??
      (db.prepare('SELECT * FROM lims_schema WHERE id=?').get(schema.schema.id) as
        | LimsSchemaRow
        | undefined));
  return {
    entity,
    restoredSchema:
      schema && currentSchema ? { schema: currentSchema, revision: schema.revision } : undefined,
  };
}

export function repairLimsEntityFromVerifiedAuditInDb(
  db: Database.Database,
  entityId: string
): boolean {
  return db.transaction(() => {
    const plan = planLimsEntityRecoveryFromVerifiedAudit(db, entityId);
    if (!plan) return false;
    for (const schema of plan.missingSchemas.values())
      upsertLimsSchemaProjectionInsideTx(db, schema);
    for (const { revision } of plan.missingRevisions.values())
      upsertLimsSchemaRevisionProjectionInsideTx(db, revision);
    for (const entity of plan.missingEntities.values())
      replayHistoricalLimsEntityProjectionInsideTx(db, entity);
    for (const link of plan.missingLinks.values()) upsertLimsLinkProjectionInsideTx(db, link);
    return true;
  })();
}

function applySchemaEvent(db: Database.Database, row: AuditReplayRow, after: unknown): boolean {
  const rows = schemaRowsFromEvent(row, after);
  if (!rows) return false;
  upsertLimsSchemaProjectionInsideTx(db, rows.schema);
  upsertLimsSchemaRevisionProjectionInsideTx(db, rows.revision);
  return true;
}

function schemaRowsFromEvent(
  row: AuditReplayRow,
  after: unknown
): { schema: LimsSchemaRow; revision: LimsSchemaRevisionRow } | null {
  if (isSchemaEnvelope(after)) return after;
  if (isLimsSchemaRow(after)) {
    return {
      schema: after,
      revision: revisionRowFromSchemaRow(after, row),
    };
  }
  if (isBuiltinSchemaDefinition(after)) {
    return schemaRowsFromBuiltinDefinition(after, row);
  }
  return null;
}

function revisionRowFromSchemaRow(
  schema: LimsSchemaRow,
  row: AuditReplayRow
): LimsSchemaRevisionRow {
  return {
    id: schema.current_revision_id ?? `${schema.id}-v${schema.version}`,
    schema_id: schema.id,
    version: schema.version,
    fields: schema.fields,
    actor: schema.actor,
    workspace_id: schema.workspace_id,
    event_seq: schema.event_seq ?? row.event_seq,
    tombstone: schema.tombstone,
    created_at: row.created_at,
    archived_at: schema.archived_at,
  };
}

function schemaRowsFromBuiltinDefinition(
  definition: LimsBuiltinSchemaDefinition,
  row: AuditReplayRow
): { schema: LimsSchemaRow; revision: LimsSchemaRevisionRow } {
  const schemaId = deterministicSchemaId(definition.kind, definition.name);
  const revisionId = `${schemaId}-v1`;
  const fields = limsSchemaFieldsJson(definition);
  return {
    schema: {
      id: schemaId,
      kind: definition.kind,
      name: definition.name,
      display_name: definition.displayName,
      description: definition.description,
      fields,
      current_revision_id: revisionId,
      version: 1,
      builtin: definition.builtin ? 1 : 0,
      workspace_id: row.workspace_id,
      actor: row.actor,
      event_seq: row.event_seq,
      tombstone: 0,
      created_at: row.created_at,
      updated_at: row.created_at,
      archived_at: null,
    },
    revision: {
      id: revisionId,
      schema_id: schemaId,
      version: 1,
      fields,
      actor: row.actor,
      workspace_id: row.workspace_id,
      event_seq: row.event_seq,
      tombstone: 0,
      created_at: row.created_at,
      archived_at: null,
    },
  };
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchemaEnvelope(
  value: unknown
): value is { schema: LimsSchemaRow; revision: LimsSchemaRevisionRow } {
  return (
    isRecord(value) &&
    isLimsSchemaRow(value.schema) &&
    isRecord(value.revision) &&
    typeof value.revision.id === 'string' &&
    typeof value.revision.schema_id === 'string'
  );
}

function isLimsSchemaRow(value: unknown): value is LimsSchemaRow {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'entity' || value.kind === 'relationship_type') &&
    typeof value.name === 'string' &&
    typeof value.display_name === 'string' &&
    typeof value.fields === 'string'
  );
}

function isBuiltinSchemaDefinition(value: unknown): value is LimsBuiltinSchemaDefinition {
  return (
    isRecord(value) &&
    (value.kind === 'entity' || value.kind === 'relationship_type') &&
    typeof value.name === 'string' &&
    typeof value.displayName === 'string' &&
    Array.isArray(value.fields)
  );
}

function isLimsEntity(value: unknown): value is LimsEntity {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.schemaRevisionId === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.fields)
  );
}

function isLimsLink(value: unknown): value is LimsLink {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fromEntityId === 'string' &&
    typeof value.toEntityId === 'string' &&
    typeof value.type === 'string' &&
    isRecord(value.payload)
  );
}

function isLimsContentPin(value: unknown): value is LimsContentPin {
  return (
    isRecord(value) &&
    typeof value.entityId === 'string' &&
    typeof value.field === 'string' &&
    typeof value.relPath === 'string' &&
    typeof value.contentHash === 'string' &&
    typeof value.commit === 'string' &&
    typeof value.ref === 'string'
  );
}
