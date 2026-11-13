import { withUserMessage } from '@waypoint/user-messages';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  OrgRegistryMutationRow,
  OrgRegistryRemoteMutationReceipt,
} from './org-registry-sync-types';
import {
  acknowledgeOrgRegistryRecordMutationInTx,
  assertOrgRegistryConflictIsNotLinked,
} from './org-registry-record-sync';
import type {
  OrganizationRegistryCachedRecordDetails,
  OrganizationRegistryRecordDetailsRequest,
  OrganizationRegistryConflictResolution,
  OrganizationRegistryConflictView,
  OrganizationRegistryOperation,
  OrganizationRegistryPendingMutationView,
} from '../shared/org-registry-sync';

export type OrgRegistryOperation = OrganizationRegistryOperation;
export type {
  OrgRegistryMutationRow,
  OrgRegistryRemoteMutationReceipt,
} from './org-registry-sync-types';

export interface OrgRegistrySnapshotPayload {
  idSchemes: unknown[];
  schemas: unknown[];
  schemaRevisions: unknown[];
  entities: unknown[];
  entityRevisions: unknown[];
  relationships: unknown[];
  placements: unknown[];
}

export interface OrgRegistryEventPayload {
  eventSeq: number;
  eventType: string;
  payload: unknown;
}

export interface OrgRegistryAccessReset {
  status: 'reset_required';
  reason: 'access_changed';
  accessGeneration: string;
}

export interface OrgRegistryMutationReceipt extends OrgRegistryRemoteMutationReceipt {
  orgId: string;
  accountId: string;
  clientId: string;
  operation: OrgRegistryOperation;
  requestFingerprint: string;
  acknowledgedAt: number;
}

export function requireOrgRegistryAccessGeneration(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value)
    throw new Error('Registry access generation is invalid.');
  return value;
}

export interface OrgRegistryCacheView {
  state: {
    accessGeneration: string | null;
    cursor: number;
    status: 'idle' | 'syncing' | 'ready' | 'error' | 'access_revoked';
    clientId: string;
    lastPullAt: number | null;
    lastPushAt: number | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  };
  idSchemes: Record<string, unknown>[];
  schemas: Record<string, unknown>[];
  schemaRevisions: Record<string, unknown>[];
  entities: Record<string, unknown>[];
  entityRevisions: Record<string, unknown>[];
  relationships: Record<string, unknown>[];
  placements: Record<string, unknown>[];
}

export type CacheRecordType =
  | 'id_scheme'
  | 'schema'
  | 'schema_revision'
  | 'entity'
  | 'entity_revision'
  | 'relationship'
  | 'placement';

const SNAPSHOT_RECORDS: ReadonlyArray<{
  key: keyof OrgRegistrySnapshotPayload;
  type: CacheRecordType;
}> = [
  { key: 'idSchemes', type: 'id_scheme' },
  { key: 'schemas', type: 'schema' },
  { key: 'schemaRevisions', type: 'schema_revision' },
  { key: 'entities', type: 'entity' },
  { key: 'entityRevisions', type: 'entity_revision' },
  { key: 'relationships', type: 'relationship' },
  { key: 'placements', type: 'placement' },
];

export function replaceOrgRegistrySnapshot(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId?: string;
    cursor: number;
    accessGeneration: string;
    snapshot: OrgRegistrySnapshotPayload;
    now: number;
  }
): void {
  requireCursor(input.cursor);
  requireOrgRegistryAccessGeneration(input.accessGeneration);
  db.transaction(() => {
    ensureState(db, input.orgId, input.accountId, input.clientId ?? 'desktop:local', input.now);
    db.prepare(`DELETE FROM org_registry_cache WHERE org_id = ? AND account_id = ?`).run(
      input.orgId,
      input.accountId
    );
    for (const descriptor of SNAPSHOT_RECORDS) {
      for (const raw of input.snapshot[descriptor.key]) {
        const payload = requireRecord(raw, `Invalid ${descriptor.type} snapshot record.`);
        upsertCacheRecord(db, {
          orgId: input.orgId,
          accountId: input.accountId,
          type: descriptor.type,
          id: recordId(descriptor.type, payload),
          payload,
          eventSeq: input.cursor,
          now: input.now,
        });
      }
    }
    finishOrgRegistrySnapshotCache(db, input);
  })();
}

export function applyOrgRegistryEventPage(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId?: string;
    nextCursor: number;
    accessGeneration: string;
    events: OrgRegistryEventPayload[];
    now: number;
  }
): void {
  requireCursor(input.nextCursor);
  requireOrgRegistryAccessGeneration(input.accessGeneration);
  db.transaction(() => {
    ensureState(db, input.orgId, input.accountId, input.clientId ?? 'desktop:local', input.now);
    const state = db
      .prepare(
        `SELECT cursor, access_generation FROM org_registry_sync_state WHERE org_id = ? AND account_id = ?`
      )
      .get(input.orgId, input.accountId) as {
      cursor: number;
      access_generation: string | null;
    };
    if (state.access_generation !== input.accessGeneration)
      throw new Error('Registry event access generation changed.');
    let cursor = state.cursor;
    for (const event of input.events) {
      requireCursor(event.eventSeq);
      if (event.eventSeq <= cursor) continue;
      if (event.eventSeq !== cursor + 1) {
        throw new Error(`Registry event gap: expected ${cursor + 1}, received ${event.eventSeq}.`);
      }
      applyEvent(db, input.orgId, input.accountId, event, input.now);
      cursor = event.eventSeq;
    }
    if (input.nextCursor !== cursor) {
      throw new Error(`Registry cursor mismatch: applied ${cursor}, received ${input.nextCursor}.`);
    }
    db.prepare(
      `UPDATE org_registry_sync_state
       SET cursor = ?, status = 'ready', last_pull_at = ?,
           last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE org_id = ? AND account_id = ?`
    ).run(cursor, input.now, input.now, input.orgId, input.accountId);
  })();
}

export function enqueueOrgRegistryMutation(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId: string;
    mutationId: string;
    operation: OrgRegistryOperation;
    payload: Record<string, unknown>;
    now: number;
  }
): OrgRegistryMutationRow | OrgRegistryMutationReceipt {
  const payloadJson = stableJson(input.payload);
  const fingerprint = orgRegistryMutationFingerprint(input.operation, input.payload);
  const receipt = db
    .prepare('SELECT * FROM org_registry_mutation_receipts WHERE mutation_id=?')
    .get(input.mutationId) as MutationReceiptDbRow | undefined;
  if (receipt) {
    if (
      receipt.request_fingerprint !== fingerprint ||
      receipt.org_id !== input.orgId ||
      receipt.account_id !== input.accountId ||
      receipt.client_id !== input.clientId
    )
      throw new Error('Registry mutation id was already used for a different request.');
    return parseMutationReceipt(receipt);
  }
  ensureState(db, input.orgId, input.accountId, input.clientId, input.now);
  const existing = db
    .prepare(
      `SELECT request_fingerprint, org_id, account_id, client_id
       FROM org_registry_outbox WHERE mutation_id = ?`
    )
    .get(input.mutationId) as
    | {
        request_fingerprint: string;
        org_id: string;
        account_id: string;
        client_id: string;
      }
    | undefined;
  if (
    existing &&
    (existing.request_fingerprint !== fingerprint ||
      existing.org_id !== input.orgId ||
      existing.account_id !== input.accountId ||
      existing.client_id !== input.clientId)
  ) {
    throw new Error('Registry mutation id was already used for a different request.');
  }
  if (!existing) {
    db.prepare(
      `INSERT INTO org_registry_outbox (
        mutation_id, org_id, account_id, client_id, operation, payload_json,
        request_fingerprint, status, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
    ).run(
      input.mutationId,
      input.orgId,
      input.accountId,
      input.clientId,
      input.operation,
      payloadJson,
      fingerprint,
      input.now,
      input.now
    );
  }
  return readMutation(db, input.mutationId);
}

export function readPendingOrgRegistryMutations(
  db: Database.Database,
  input: { orgId: string; accountId: string; now?: number; limit?: number }
): OrgRegistryMutationRow[] {
  const now = input.now ?? Date.now();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const rows = db
    .prepare(
      `SELECT * FROM org_registry_outbox
       WHERE org_id = ? AND account_id = ?
         AND status IN ('pending', 'retry_wait')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, mutation_id
       LIMIT ?`
    )
    .all(input.orgId, input.accountId, now, limit) as MutationDbRow[];
  return rows.map(parseMutationRow);
}

export function readOrgRegistrySyncDetails(
  db: Database.Database,
  input: { orgId: string; accountId: string }
): {
  mutations: OrganizationRegistryPendingMutationView[];
  conflicts: OrganizationRegistryConflictView[];
} {
  const state = readOrgRegistrySyncState(db, input);
  if (state.status === 'access_revoked' || (state.status !== 'idle' && !state.accessGeneration))
    return { mutations: [], conflicts: [] };
  const mutationRows = db
    .prepare(
      `SELECT * FROM org_registry_outbox
       WHERE org_id = ? AND account_id = ?
       ORDER BY created_at, mutation_id`
    )
    .all(input.orgId, input.accountId) as MutationDbRow[];
  const conflictRows = db
    .prepare(
      `SELECT * FROM org_registry_conflicts
       WHERE org_id = ? AND account_id = ? AND status = 'open'
       ORDER BY created_at, id`
    )
    .all(input.orgId, input.accountId) as ConflictDbRow[];
  return {
    mutations: mutationRows.map((row) => {
      const mutation = parseMutationRow(row);
      return {
        mutationId: mutation.mutationId,
        operation: mutation.operation,
        payload: mutation.payload,
        status: mutation.status,
        attemptCount: mutation.attemptCount,
        nextAttemptAt: mutation.nextAttemptAt,
        errorCode: mutation.errorCode,
        errorMessage: mutation.errorMessage,
        createdAt: mutation.createdAt,
        updatedAt: mutation.updatedAt,
      };
    }),
    conflicts: conflictRows.map(parseConflictRow),
  };
}

export function resolveOrgRegistryConflict(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    conflictId: string;
    resolution: OrganizationRegistryConflictResolution;
    replacementMutationId?: string;
    replacementPayload?: Record<string, unknown>;
    now: number;
  }
): { mutationId?: string } {
  return db.transaction(() => {
    const conflict = db
      .prepare(
        `SELECT c.*, o.client_id
         FROM org_registry_conflicts c
         JOIN org_registry_outbox o ON o.mutation_id = c.mutation_id
         WHERE c.id = ? AND c.org_id = ? AND c.account_id = ? AND c.status = 'open'`
      )
      .get(input.conflictId, input.orgId, input.accountId) as
      | (ConflictDbRow & { client_id: string })
      | undefined;
    if (!conflict) throw new Error('Open Registry conflict not found.');
    assertOrgRegistryConflictIsNotLinked(db, conflict.mutation_id);

    if (input.resolution === 'use_remote') {
      db.prepare(
        `UPDATE org_registry_conflicts
         SET status = 'discarded', updated_at = ?, resolved_at = ? WHERE id = ?`
      ).run(input.now, input.now, conflict.id);
      db.prepare(
        `UPDATE org_registry_outbox
         SET status = 'failed', next_attempt_at = NULL,
             last_error_code = 'RESOLVED_USE_REMOTE',
             last_error_message = 'The local change was discarded in favor of the organization version.',
             updated_at = ?
         WHERE mutation_id = ?`
      ).run(input.now, conflict.mutation_id);
      return {};
    }

    if (!input.replacementMutationId || !input.replacementPayload) {
      throw new Error('Retrying a Registry conflict requires a replacement mutation and payload.');
    }
    db.prepare(
      `UPDATE org_registry_conflicts
       SET status = 'resolved', updated_at = ?, resolved_at = ? WHERE id = ?`
    ).run(input.now, input.now, conflict.id);
    db.prepare(
      `UPDATE org_registry_outbox
       SET status = 'failed', next_attempt_at = NULL,
           last_error_code = 'RESOLVED_RETRIED',
           last_error_message = 'Superseded by an explicit conflict retry.', updated_at = ?
       WHERE mutation_id = ?`
    ).run(input.now, conflict.mutation_id);
    enqueueOrgRegistryMutation(db, {
      orgId: input.orgId,
      accountId: input.accountId,
      clientId: conflict.client_id,
      mutationId: input.replacementMutationId,
      operation: conflict.operation,
      payload: input.replacementPayload,
      now: input.now,
    });
    return { mutationId: input.replacementMutationId };
  })();
}

export function recoverOrgRegistrySendingMutations(
  db: Database.Database,
  input: { orgId: string; accountId: string; now: number }
): void {
  db.prepare(
    `UPDATE org_registry_outbox
     SET status = 'pending', updated_at = ?
     WHERE org_id = ? AND account_id = ? AND status = 'sending'`
  ).run(input.now, input.orgId, input.accountId);
}

export function markOrgRegistryMutationSending(
  db: Database.Database,
  input: { mutationId: string; now: number }
): void {
  const result = db
    .prepare(
      `UPDATE org_registry_outbox
       SET status = 'sending', attempt_count = attempt_count + 1,
           last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE mutation_id = ? AND status IN ('pending', 'retry_wait')`
    )
    .run(input.now, input.mutationId);
  if (result.changes !== 1) throw new Error('Registry mutation is not ready to send.');
}

export function orgRegistryMutationFingerprint(
  operation: OrgRegistryOperation,
  payload: Record<string, unknown>
): string {
  return createHash('sha256').update(stableJson({ operation, payload })).digest('hex');
}

interface MutationReceiptDbRow {
  mutation_id: string;
  org_id: string;
  account_id: string;
  client_id: string;
  operation: OrgRegistryOperation;
  request_fingerprint: string;
  event_seq: number;
  status: 'applied' | 'replayed';
  response_json: string;
  acknowledged_at: number;
}

function parseMutationReceipt(row: MutationReceiptDbRow): OrgRegistryMutationReceipt {
  return {
    ...(JSON.parse(row.response_json) as OrgRegistryRemoteMutationReceipt),
    mutationId: row.mutation_id,
    orgId: row.org_id,
    accountId: row.account_id,
    clientId: row.client_id,
    operation: row.operation,
    requestFingerprint: row.request_fingerprint,
    eventSeq: row.event_seq,
    status: row.status,
    acknowledgedAt: row.acknowledged_at,
  };
}

export function readOrgRegistryMutationReceipt(
  db: Database.Database,
  input: {
    mutationId: string;
    orgId: string;
    accountId: string;
    clientId?: string;
  }
): OrgRegistryMutationReceipt | null {
  const state = readOrgRegistrySyncState(db, input);
  if (!state.accessGeneration || state.status === 'access_revoked') return null;
  const row = db
    .prepare(
      'SELECT * FROM org_registry_mutation_receipts WHERE mutation_id=? AND org_id=? AND account_id=?'
    )
    .get(input.mutationId, input.orgId, input.accountId) as MutationReceiptDbRow | undefined;
  return row && (input.clientId === undefined || row.client_id === input.clientId)
    ? parseMutationReceipt(row)
    : null;
}

export function acknowledgeOrgRegistryMutation(
  db: Database.Database,
  input: {
    mutationId: string;
    orgId: string;
    accountId: string;
    clientId: string;
    receipt: OrgRegistryRemoteMutationReceipt;
    now: number;
  }
): void {
  const receipt = input.receipt;
  requireCursor(receipt.eventSeq);
  requireOrgRegistryAccessGeneration(receipt.accessGeneration);
  db.transaction(() => {
    const row = db
      .prepare(
        'SELECT * FROM org_registry_outbox WHERE mutation_id=? AND org_id=? AND account_id=? AND client_id=?'
      )
      .get(input.mutationId, input.orgId, input.accountId, input.clientId) as
      | (MutationDbRow & { request_fingerprint: string })
      | undefined;
    if (
      !row ||
      receipt.mutationId !== input.mutationId ||
      receipt.eventSeq < 1 ||
      (receipt.status !== 'applied' && receipt.status !== 'replayed')
    )
      throw new Error('Registry mutation receipt does not match its pending request.');
    if (readOrgRegistrySyncState(db, input).accessGeneration !== receipt.accessGeneration)
      throw new Error('Registry mutation receipt access generation changed.');
    const payload = requireRecord(JSON.parse(row.payload_json));
    if (row.operation.startsWith('entity.') || row.operation === 'relationships.replace') {
      const entityId = row.operation === 'relationships.replace' ? payload.entityId : payload.id;
      if (
        receipt.entityId !== entityId ||
        !receipt.homeWorkspaceId ||
        receipt.entity?.id !== entityId ||
        receipt.entity?.homeWorkspaceId !== receipt.homeWorkspaceId ||
        (row.operation === 'entity.create' && receipt.homeWorkspaceId !== payload.homeWorkspaceId)
      )
        throw new Error('Registry mutation receipt entity identity or home does not match.');
    }
    if (row.operation.startsWith('placement.')) {
      if (
        !receipt.entityId ||
        !receipt.homeWorkspaceId ||
        receipt.placement?.id !== payload.id ||
        receipt.placement?.entityId !== receipt.entityId ||
        (row.operation === 'placement.add' && receipt.entityId !== payload.entityId)
      )
        throw new Error('Registry placement receipt does not match its pending request.');
    }
    db.prepare(
      `INSERT INTO org_registry_mutation_receipts
      (mutation_id,org_id,account_id,client_id,operation,request_fingerprint,event_seq,status,response_json,acknowledged_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.mutation_id,
      row.org_id,
      row.account_id,
      row.client_id,
      row.operation,
      row.request_fingerprint,
      receipt.eventSeq,
      receipt.status,
      JSON.stringify(receipt),
      input.now
    );
    acknowledgeOrgRegistryRecordMutationInTx(db, {
      ...input,
      operation: row.operation,
      payload,
    });
    db.prepare(
      'DELETE FROM org_registry_outbox WHERE mutation_id=? AND org_id=? AND account_id=?'
    ).run(input.mutationId, input.orgId, input.accountId);
    db.prepare(
      `UPDATE org_registry_sync_state SET last_push_at=?,updated_at=?,last_error_code=NULL,last_error_message=NULL WHERE org_id=? AND account_id=?`
    ).run(input.now, input.now, input.orgId, input.accountId);
  })();
}

export function invalidateOrgRegistryAccess(
  db: Database.Database,
  input: { orgId: string; accountId: string; clientId: string; now: number }
): void {
  db.transaction(() => {
    ensureState(db, input.orgId, input.accountId, input.clientId, input.now);
    db.prepare('DELETE FROM org_registry_cache WHERE org_id=? AND account_id=?').run(
      input.orgId,
      input.accountId
    );
    db.prepare('DELETE FROM org_registry_snapshot_transfer WHERE org_id=? AND account_id=?').run(
      input.orgId,
      input.accountId
    );
    db.prepare(
      `UPDATE org_registry_sync_state SET cursor=0,access_generation=NULL,status='syncing',last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE org_id=? AND account_id=?`
    ).run(input.now, input.orgId, input.accountId);
  })();
}

export function retryOrgRegistryMutation(
  db: Database.Database,
  input: {
    mutationId: string;
    code: string;
    message: string;
    nextAttemptAt: number;
    now: number;
  }
): void {
  db.prepare(
    `UPDATE org_registry_outbox
     SET status = 'retry_wait', next_attempt_at = ?, last_error_code = ?,
         last_error_message = ?, updated_at = ?
     WHERE mutation_id = ?`
  ).run(input.nextAttemptAt, input.code, input.message, input.now, input.mutationId);
}

export function failOrgRegistryMutation(
  db: Database.Database,
  input: { mutationId: string; code: string; message: string; now: number }
): void {
  db.prepare(
    `UPDATE org_registry_outbox
     SET status = 'failed', last_error_code = ?, last_error_message = ?, updated_at = ?
     WHERE mutation_id = ?`
  ).run(input.code, input.message, input.now, input.mutationId);
}

export function setOrgRegistrySyncStatus(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId: string;
    status: OrgRegistryCacheView['state']['status'];
    errorCode?: string | null;
    errorMessage?: string | null;
    now: number;
  }
): void {
  ensureState(db, input.orgId, input.accountId, input.clientId, input.now);
  db.prepare(
    `UPDATE org_registry_sync_state
     SET status = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
     WHERE org_id = ? AND account_id = ?`
  ).run(
    input.status,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.now,
    input.orgId,
    input.accountId
  );
}

export function markOrgRegistryMutationConflict(
  db: Database.Database,
  input: {
    mutationId: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    now: number;
  }
): void {
  db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM org_registry_outbox WHERE mutation_id = ?`)
      .get(input.mutationId) as MutationDbRow | undefined;
    if (!row) throw new Error('Registry mutation not found.');
    db.prepare(
      `UPDATE org_registry_outbox
       SET status = 'conflict',
           last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE mutation_id = ?`
    ).run(input.code, input.message, input.now, input.mutationId);
    db.prepare(
      `INSERT INTO org_registry_conflicts (
        id, mutation_id, org_id, account_id, operation, local_payload_json,
        error_code, error_message, details_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(mutation_id) DO UPDATE SET
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        details_json = excluded.details_json,
        status = 'open',
        updated_at = excluded.updated_at,
        resolved_at = NULL`
    ).run(
      randomUUID(),
      row.mutation_id,
      row.org_id,
      row.account_id,
      row.operation,
      row.payload_json,
      input.code,
      input.message,
      input.details ? stableJson(input.details) : null,
      input.now,
      input.now
    );
  })();
}

export function revokeOrgRegistryCache(
  db: Database.Database,
  input: { orgId: string; accountId: string; clientId?: string; now: number }
): void {
  db.transaction(() => {
    const existing = db
      .prepare('SELECT client_id FROM org_registry_sync_state WHERE org_id=? AND account_id=?')
      .get(input.orgId, input.accountId) as { client_id: string } | undefined;
    ensureState(
      db,
      input.orgId,
      input.accountId,
      input.clientId ?? existing?.client_id ?? 'desktop:local',
      input.now
    );

    db.prepare('DELETE FROM org_registry_cache WHERE org_id=? AND account_id=?').run(
      input.orgId,
      input.accountId
    );
    db.prepare('DELETE FROM org_registry_snapshot_transfer WHERE org_id=? AND account_id=?').run(
      input.orgId,
      input.accountId
    );
    db.prepare(
      `UPDATE org_registry_sync_state
      SET status='access_revoked',cursor=0,access_generation=NULL,last_error_code='ACCESS_REVOKED',
          last_error_message='Organization Registry access was revoked.',updated_at=?
      WHERE org_id=? AND account_id=?`
    ).run(input.now, input.orgId, input.accountId);
  })();
}

export function listOrgRegistryCachedOrganizationIds(
  db: Database.Database,
  input: { accountId: string }
): string[] {
  return (
    db
      .prepare(
        `SELECT org_id
         FROM org_registry_sync_state
         WHERE account_id = ? AND status <> 'access_revoked'
         ORDER BY org_id`
      )
      .all(input.accountId) as Array<{ org_id: string }>
  ).map((row) => row.org_id);
}

export function readOrgRegistrySyncState(
  db: Database.Database,
  input: { orgId: string; accountId: string }
): OrgRegistryCacheView['state'] {
  const state = db
    .prepare(
      `SELECT cursor, access_generation, status, client_id, last_pull_at, last_push_at,
              last_error_code, last_error_message
       FROM org_registry_sync_state WHERE org_id = ? AND account_id = ?`
    )
    .get(input.orgId, input.accountId) as StateDbRow | undefined;
  return state
    ? {
        accessGeneration: state.access_generation,
        cursor: state.cursor,
        status: state.status,
        clientId: state.client_id,
        lastPullAt: state.last_pull_at,
        lastPushAt: state.last_push_at,
        lastErrorCode: state.last_error_code,
        lastErrorMessage: state.last_error_message,
      }
    : {
        accessGeneration: null,
        cursor: 0,
        status: 'idle',
        clientId: '',
        lastPullAt: null,
        lastPushAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      };
}

export function readOrgRegistryCache(
  db: Database.Database,
  input: { orgId: string; accountId: string }
): OrgRegistryCacheView {
  const resolvedState = readOrgRegistrySyncState(db, input);
  const grouped: Record<CacheRecordType, Record<string, unknown>[]> = {
    id_scheme: [],
    schema: [],
    schema_revision: [],
    entity: [],
    entity_revision: [],
    relationship: [],
    placement: [],
  };
  const rows = db
    .prepare(
      `SELECT record_type, payload_json FROM org_registry_cache
       WHERE org_id = ? AND account_id = ? AND ? IS NOT NULL ORDER BY record_type, record_id`
    )
    .all(input.orgId, input.accountId, resolvedState.accessGeneration) as Array<{
    record_type: CacheRecordType;
    payload_json: string;
  }>;
  for (const row of rows)
    grouped[row.record_type].push(requireRecord(JSON.parse(row.payload_json)));
  return {
    state: resolvedState,
    idSchemes: grouped.id_scheme,
    schemas: grouped.schema,
    schemaRevisions: grouped.schema_revision,
    entities: grouped.entity,
    entityRevisions: grouped.entity_revision,
    relationships: grouped.relationship,
    placements: grouped.placement,
  };
}

export function readOrgRegistryRecordDetails(
  db: Database.Database,
  input: OrganizationRegistryRecordDetailsRequest & {
    orgId: string;
    accountId: string;
  }
): OrganizationRegistryCachedRecordDetails {
  return db.transaction(() => {
    const state = readOrgRegistrySyncState(db, input);
    if (
      state.status === 'access_revoked' ||
      !state.accessGeneration ||
      state.accessGeneration !== input.expectedAccessGeneration
    ) {
      throw Object.assign(
        withUserMessage(
          new Error('Registry access changed. Refresh this organization before opening Details.'),
          'failure.registry-access-changed-refresh-this-organization-before-opening-detai'
        ),
        { code: 'FORBIDDEN' }
      );
    }
    const readRecord = (type: CacheRecordType, id: string): Record<string, unknown> | null => {
      const row = db
        .prepare(
          `SELECT payload_json FROM org_registry_cache
        WHERE org_id=? AND account_id=? AND record_type=? AND record_id=?`
        )
        .get(input.orgId, input.accountId, type, id) as { payload_json: string } | undefined;
      return row
        ? requireRecord(JSON.parse(row.payload_json), 'Registry cached record is invalid.')
        : null;
    };
    const raw = readRecord('entity', input.entityId);
    if (!raw || raw.id !== input.entityId || raw.orgId !== input.orgId) {
      throw Object.assign(
        new Error('This record is not available in the current organization access scope.'),
        { code: 'NOT_FOUND' }
      );
    }
    const entity: OrganizationRegistryCachedRecordDetails['entity'] = {
      ...raw,
      id: input.entityId,
      orgId: input.orgId,
      homeWorkspaceId: requiredText(raw.homeWorkspaceId, 'Registry record home is missing.'),
      schemaId: requiredText(raw.schemaId, 'Registry record schema is missing.'),
      schemaRevisionId: requiredText(
        raw.schemaRevisionId,
        'Registry pinned schema revision is missing.'
      ),
    };
    const schema = readRecord('schema', entity.schemaId);
    const schemaRevision = readRecord('schema_revision', entity.schemaRevisionId);
    if (
      !schema ||
      schema.id !== entity.schemaId ||
      schema.orgId !== input.orgId ||
      !schemaRevision ||
      schemaRevision.id !== entity.schemaRevisionId ||
      schemaRevision.orgId !== input.orgId ||
      schemaRevision.schemaId !== entity.schemaId
    ) {
      throw new Error(
        'The record’s pinned schema revision is unavailable. Synchronize this organization before opening Details.'
      );
    }
    const rows = db
      .prepare(
        `SELECT c.record_type,c.payload_json FROM org_registry_cache c
      WHERE c.org_id=@orgId AND c.account_id=@accountId
        AND c.record_type IN ('relationship','placement')
        AND json_extract(c.payload_json,'$.orgId')=@orgId
        AND ((c.record_type='relationship'
          AND (json_extract(c.payload_json,'$.fromEntityId')=@entityId OR json_extract(c.payload_json,'$.toEntityId')=@entityId)
          AND EXISTS (SELECT 1 FROM org_registry_cache endpoint
            WHERE endpoint.org_id=c.org_id AND endpoint.account_id=c.account_id
              AND endpoint.record_type='entity' AND endpoint.record_id=json_extract(c.payload_json,'$.fromEntityId')
              AND json_extract(endpoint.payload_json,'$.orgId')=@orgId)
          AND EXISTS (SELECT 1 FROM org_registry_cache endpoint
            WHERE endpoint.org_id=c.org_id AND endpoint.account_id=c.account_id
              AND endpoint.record_type='entity' AND endpoint.record_id=json_extract(c.payload_json,'$.toEntityId')
              AND json_extract(endpoint.payload_json,'$.orgId')=@orgId))
        OR (c.record_type='placement' AND json_extract(c.payload_json,'$.entityId')=@entityId))
      ORDER BY c.record_type,c.record_id`
      )
      .all({
        orgId: input.orgId,
        accountId: input.accountId,
        entityId: input.entityId,
      }) as Array<{
      record_type: 'relationship' | 'placement';
      payload_json: string;
    }>;
    const relationships: Record<string, unknown>[] = [];
    const placements: Record<string, unknown>[] = [];
    for (const row of rows) {
      const value = requireRecord(
        JSON.parse(row.payload_json),
        'Registry related record is invalid.'
      );
      (row.record_type === 'relationship' ? relationships : placements).push(value);
    }
    return {
      scope: {
        accountId: input.accountId,
        orgId: input.orgId,
        accessGeneration: state.accessGeneration,
        cursor: state.cursor,
      },
      entity,
      schema,
      schemaRevision,
      relationships,
      placements,
    };
  })();
}

function applyEvent(
  db: Database.Database,
  orgId: string,
  accountId: string,
  event: OrgRegistryEventPayload,
  now: number
): void {
  const payload = requireRecord(event.payload, 'Invalid Registry event payload.');
  if (event.eventType === 'scope.filtered') {
    if (
      Object.keys(payload).length !== 0 ||
      Object.keys(event).some((key) => !['eventSeq', 'eventType', 'payload'].includes(key))
    )
      throw new Error('Registry filtered checkpoint must contain no record identity.');
    return;
  }
  if (event.eventType.startsWith('schema.')) {
    const schema = requireRecord(payload.schema, 'Registry schema event is missing its schema.');
    upsertCacheRecord(db, {
      orgId,
      accountId,
      type: 'schema',
      id: recordId('schema', schema),
      payload: schema,
      eventSeq: event.eventSeq,
      now,
    });
    if (payload.schemaRevision !== undefined) {
      const schemaRevision = requireRecord(
        payload.schemaRevision,
        'Registry schema event has an invalid revision.'
      );
      upsertCacheRecord(db, {
        orgId,
        accountId,
        type: 'schema_revision',
        id: recordId('schema_revision', schemaRevision),
        payload: schemaRevision,
        eventSeq: event.eventSeq,
        now,
      });
    }
    return;
  }
  if (event.eventType.startsWith('entity.')) {
    const entity = requireRecord(payload.entity, 'Registry entity event is missing its entity.');
    upsertCacheRecord(db, {
      orgId,
      accountId,
      type: 'entity',
      id: recordId('entity', entity),
      payload: entity,
      eventSeq: event.eventSeq,
      now,
    });
    if (payload.entityRevision !== undefined) {
      const entityRevision = requireRecord(
        payload.entityRevision,
        'Registry entity event has an invalid revision.'
      );
      upsertCacheRecord(db, {
        orgId,
        accountId,
        type: 'entity_revision',
        id: recordId('entity_revision', entityRevision),
        payload: entityRevision,
        eventSeq: event.eventSeq,
        now,
      });
    }
    return;
  }
  if (event.eventType === 'relationships.replaced') {
    const entity = requireRecord(
      payload.entity,
      'Registry relationship event is missing its entity.'
    );
    const entityId = requiredText(entity.id, 'Registry relationship entity id is missing.');
    db.prepare(
      `DELETE FROM org_registry_cache
       WHERE org_id = ? AND account_id = ? AND record_type = 'relationship'
         AND json_extract(payload_json, '$.fromEntityId') = ?`
    ).run(orgId, accountId, entityId);
    const relationships = Array.isArray(payload.relationships) ? payload.relationships : [];
    for (const raw of relationships) {
      const relationship = requireRecord(raw, 'Invalid Registry relationship.');
      upsertCacheRecord(db, {
        orgId,
        accountId,
        type: 'relationship',
        id: recordId('relationship', relationship),
        payload: relationship,
        eventSeq: event.eventSeq,
        now,
      });
    }
    upsertCacheRecord(db, {
      orgId,
      accountId,
      type: 'entity',
      id: entityId,
      payload: entity,
      eventSeq: event.eventSeq,
      now,
    });
    if (payload.entityRevision !== undefined) {
      const entityRevision = requireRecord(
        payload.entityRevision,
        'Registry relationship event has an invalid entity revision.'
      );
      upsertCacheRecord(db, {
        orgId,
        accountId,
        type: 'entity_revision',
        id: recordId('entity_revision', entityRevision),
        payload: entityRevision,
        eventSeq: event.eventSeq,
        now,
      });
    }
    return;
  }
  if (event.eventType === 'placement.added' || event.eventType === 'placement.removed') {
    const placement = requireRecord(
      payload.placement,
      'Registry placement event is missing its placement.'
    );
    const id = recordId('placement', placement);
    if (event.eventType === 'placement.removed') {
      db.prepare(
        `DELETE FROM org_registry_cache
         WHERE org_id = ? AND account_id = ? AND record_type = 'placement' AND record_id = ?`
      ).run(orgId, accountId, id);
    } else {
      upsertCacheRecord(db, {
        orgId,
        accountId,
        type: 'placement',
        id,
        payload: placement,
        eventSeq: event.eventSeq,
        now,
      });
    }
    return;
  }
  throw new Error(`Unsupported Registry event type: ${event.eventType}.`);
}

function ensureState(
  db: Database.Database,
  orgId: string,
  accountId: string,
  clientId: string,
  now: number
): void {
  db.prepare(
    `INSERT INTO org_registry_sync_state (
      org_id, account_id, client_id, cursor, status, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 'idle', ?, ?)
    ON CONFLICT(org_id, account_id) DO UPDATE SET
      client_id = excluded.client_id,
      updated_at = excluded.updated_at`
  ).run(orgId, accountId, clientId, now, now);
}

function upsertCacheRecord(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    type: CacheRecordType;
    id: string;
    payload: Record<string, unknown>;
    eventSeq: number;
    now: number;
  }
): void {
  db.prepare(
    `INSERT INTO org_registry_cache (
      org_id, account_id, record_type, record_id, payload_json, event_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, account_id, record_type, record_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      event_seq = excluded.event_seq,
      updated_at = excluded.updated_at`
  ).run(
    input.orgId,
    input.accountId,
    input.type,
    input.id,
    stableJson(input.payload),
    input.eventSeq,
    input.now
  );
}

function recordId(type: CacheRecordType, payload: Record<string, unknown>): string {
  if (type === 'id_scheme')
    return requiredText(payload.entityKind, 'Registry ID scheme kind is missing.');
  if (type === 'entity_revision') {
    return `${requiredText(payload.entityId, 'Registry entity revision id is missing.')}:${requiredInteger(payload.revision, 'Registry entity revision number is missing.')}`;
  }
  return requiredText(payload.id, `Registry ${type} id is missing.`);
}

function readMutation(db: Database.Database, mutationId: string): OrgRegistryMutationRow {
  const row = db
    .prepare(`SELECT * FROM org_registry_outbox WHERE mutation_id = ?`)
    .get(mutationId) as MutationDbRow | undefined;
  if (!row) throw new Error('Registry mutation not found.');
  return parseMutationRow(row);
}

function parseMutationRow(row: MutationDbRow): OrgRegistryMutationRow {
  return {
    mutationId: row.mutation_id,
    orgId: row.org_id,
    accountId: row.account_id,
    clientId: row.client_id,
    operation: row.operation,
    payload: requireRecord(JSON.parse(row.payload_json), 'Invalid Registry mutation payload.'),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.last_error_code,
    errorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MutationDbRow {
  mutation_id: string;
  org_id: string;
  account_id: string;
  client_id: string;
  operation: OrgRegistryOperation;
  payload_json: string;
  status: OrgRegistryMutationRow['status'];
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
}

interface ConflictDbRow {
  id: string;
  mutation_id: string;
  org_id: string;
  account_id: string;
  operation: OrgRegistryOperation;
  local_payload_json: string;
  error_code: string;
  error_message: string;
  details_json: string | null;
  status: OrganizationRegistryConflictView['status'];
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

function parseConflictRow(row: ConflictDbRow): OrganizationRegistryConflictView {
  return {
    id: row.id,
    mutationId: row.mutation_id,
    operation: row.operation,
    localPayload: requireRecord(
      JSON.parse(row.local_payload_json),
      'Invalid Registry conflict payload.'
    ),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    details: row.details_json
      ? requireRecord(JSON.parse(row.details_json), 'Invalid Registry conflict details.')
      : null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

interface StateDbRow {
  access_generation: string | null;
  cursor: number;
  status: OrgRegistryCacheView['state']['status'];
  client_id: string;
  last_pull_at: number | null;
  last_push_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

function requireRecord(
  value: unknown,
  message = 'Expected a JSON object.'
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) throw new Error(message);
  return value;
}

function requiredInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(message);
  return value as number;
}

function requireCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Registry cursor is invalid.');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Registry JSON contains an unsupported value.');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
}

export function finishOrgRegistrySnapshotCache(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId?: string;
    cursor: number;
    accessGeneration: string;
    now: number;
  }
): void {
  db.prepare(
    `UPDATE org_registry_sync_state SET cursor=?,access_generation=?,status='ready',last_pull_at=?,
    last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE org_id=? AND account_id=?`
  ).run(input.cursor, input.accessGeneration, input.now, input.now, input.orgId, input.accountId);
  db.prepare(`DELETE FROM org_registry_snapshot_record WHERE org_id=? AND account_id=?`).run(
    input.orgId,
    input.accountId
  );
  db.prepare(
    `INSERT INTO org_registry_snapshot_transfer(org_id,account_id,client_id,bootstrap_complete)
    VALUES(?,?,?,1) ON CONFLICT(org_id,account_id) DO UPDATE SET
    client_id=excluded.client_id,snapshot_id=NULL,cursor=NULL,access_generation=NULL,total_records=NULL,next_after=0,
    expires_at=NULL,download_complete=0,bootstrap_complete=1`
  ).run(input.orgId, input.accountId, input.clientId ?? 'desktop:local');
}
export {
  ensureState as ensureOrgRegistryState,
  recordId as orgRegistryRecordId,
  SNAPSHOT_RECORDS as ORG_REGISTRY_SNAPSHOT_RECORDS,
};
