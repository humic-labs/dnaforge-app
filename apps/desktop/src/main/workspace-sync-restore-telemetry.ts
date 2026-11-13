import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import type { CommittedOptionalAnalyticsReceipt } from './analytics-outbox';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { workspaceSyncErrorCode } from './workspace-sync-observation';

export const WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX = '_cloud_restore_telemetry_receipt_v1:';

type RestoreProperties = {
  feature_area: 'workspace';
  sync_operation: 'restore';
  sync_stage: 'accepted' | 'restored' | 'failed';
  operation_id: string;
  parent_action_id?: string;
  origin_started_at_ms: number;
  occurred_at_ms: number;
  error_code?: string;
};
export type WorkspaceSyncRestoreTelemetryEvent =
  CommittedOptionalAnalyticsReceipt<RestoreProperties>;
type RestoreTelemetry = {
  captureOrigin(): OptionalTelemetryOrigin | null;
  currentAccountId(): string | null;
  openCommittedDatabase?(db: Database.Database): Database.Database;
  publish(readCommitted: () => WorkspaceSyncRestoreTelemetryEvent | null): boolean;
};
const clock = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const originSchema = z
  .object({
    consentScope: z.string().uuid(),
    contextId: z.string().uuid(),
    processId: z.string().uuid(),
    classification: z.enum(['synthetic', 'private', 'unknown', 'eligible_release']),
  })
  .strict();
const nativeSchema = z
  .object({
    lock_id: z.string().uuid(),
    owner_account_id: z.string().min(1).max(128),
    source_remote_version_id: z.string().min(1).max(128),
    status: z.enum(['restoring', 'completed', 'failed', 'canceled']),
    started_at: clock,
    completed_at: clock.nullable(),
    error_message: z.string().nullable(),
  })
  .strict();
const attemptSchema = z
  .object({
    operationId: z.string().uuid(),
    parentOperationId: z.string().uuid().nullable(),
    sourceVersionId: z.string().min(1).max(128),
    acceptedEventId: z.string().uuid(),
    origin: originSchema,
    startedAtMs: clock,
    terminal: z
      .object({
        eventId: z.string().uuid(),
        outcome: z.enum(['restored', 'failed']),
        occurredAtMs: clock,
        errorCode: z
          .string()
          .max(64)
          .refine((value) => workspaceSyncErrorCode(value) === value)
          .optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const ledgerSchema = z
  .object({
    format: z.literal('workspace-sync-restore'),
    schemaVersion: z.literal(1),
    lockId: z.string().uuid(),
    ownerAccountId: z.string().min(1).max(128),
    attempts: z.array(attemptSchema).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, attempt] of value.attempts.entries()) {
      const previous = value.attempts[index - 1];
      const own = [
        attempt.operationId,
        attempt.acceptedEventId,
        ...(attempt.terminal ? [attempt.terminal.eventId] : []),
      ];
      if (
        attempt.parentOperationId !== (previous?.operationId ?? null) ||
        (index === 0 && attempt.operationId !== value.lockId) ||
        (previous &&
          (!previous.terminal || attempt.startedAtMs < previous.terminal.occurredAtMs)) ||
        (attempt.terminal && attempt.terminal.occurredAtMs < attempt.startedAtMs) ||
        own.some((id) => ids.has(id)) ||
        new Set(own).size !== own.length
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid native restore receipt lineage.',
        });
      for (const id of own) ids.add(id);
    }
  });
type Ledger = z.infer<typeof ledgerSchema>;
let telemetry: RestoreTelemetry | null = null;
export function configureWorkspaceSyncRestoreTelemetry(next: RestoreTelemetry | null): void {
  telemetry = next;
}

function nativeRestore(db: Database.Database, lockId: string) {
  const row = nativeSchema.safeParse(
    db
      .prepare(
        `SELECT lock_id,owner_account_id,source_remote_version_id,status,started_at,completed_at,error_message FROM workspace_sync_restore_locks WHERE lock_id=?`
      )
      .get(lockId)
  );
  return row.success ? row.data : null;
}
function ledger(db: Database.Database, key: string): Ledger | null {
  const row = z
    .object({ value: z.string() })
    .safeParse(db.prepare('SELECT value FROM settings WHERE key=?').get(key));
  if (!row.success) return null;
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(row.data.value));
    return parsed.success && key === WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX + parsed.data.lockId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
function save(db: Database.Database, value: Ledger, now: number): void {
  db.prepare(
    'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'
  ).run(
    WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX + value.lockId,
    JSON.stringify(ledgerSchema.parse(value)),
    now
  );
}
export function acceptWorkspaceSyncRestoreTelemetry(db: Database.Database, lockId: string): void {
  try {
    if (!db.inTransaction || !telemetry) return;
    db.transaction(() => {
      const native = nativeRestore(db, lockId);
      if (
        !native ||
        native.status !== 'restoring' ||
        telemetry?.currentAccountId() !== native.owner_account_id
      )
        return;
      const key = WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX + lockId;
      const stored = ledger(db, key);
      if (
        stored &&
        (stored.ownerAccountId !== native.owner_account_id ||
          stored.attempts.some((a) => a.startedAtMs === native.started_at))
      )
        return;
      if (!stored && db.prepare('SELECT 1 FROM settings WHERE key=?').get(key)) return;
      const origin = originSchema.safeParse(telemetry.captureOrigin());
      if (!origin.success) return;
      const previous = stored?.attempts.at(-1);
      save(
        db,
        {
          format: 'workspace-sync-restore',
          schemaVersion: 1,
          lockId,
          ownerAccountId: native.owner_account_id,
          attempts: [
            ...(stored?.attempts ?? []),
            {
              operationId: previous ? randomUUID() : lockId,
              parentOperationId: previous?.operationId ?? null,
              sourceVersionId: native.source_remote_version_id,
              acceptedEventId: randomUUID(),
              origin: origin.data,
              startedAtMs: native.started_at,
              terminal: null,
            },
          ],
        },
        native.started_at
      );
    })();
  } catch {}
}
export function settleWorkspaceSyncRestoreTelemetry(db: Database.Database, lockId: string): void {
  try {
    if (!db.inTransaction) return;
    db.transaction(() => {
      const native = nativeRestore(db, lockId);
      const stored = ledger(db, WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX + lockId);
      const attempt = stored?.attempts.at(-1);
      if (
        !native ||
        native.status === 'restoring' ||
        native.completed_at === null ||
        !stored ||
        !attempt ||
        attempt.terminal ||
        stored.ownerAccountId !== native.owner_account_id ||
        attempt.startedAtMs !== native.started_at ||
        attempt.sourceVersionId !== native.source_remote_version_id
      )
        return;
      attempt.terminal = {
        eventId: randomUUID(),
        outcome: native.status === 'completed' ? 'restored' : 'failed',
        occurredAtMs: native.completed_at,
        ...(native.status !== 'completed'
          ? { errorCode: workspaceSyncErrorCode(native.error_message) }
          : {}),
      };
      save(db, stored, native.completed_at);
    })();
  } catch {}
}
function committedStage(
  db: Database.Database,
  key: string,
  operationId: string,
  terminal: boolean,
  adapter: RestoreTelemetry
): WorkspaceSyncRestoreTelemetryEvent | null {
  const reader =
    db.name === ':memory:'
      ? db
      : (adapter.openCommittedDatabase?.(db) ??
        new Database(db.name, { readonly: true, fileMustExist: true }));
  try {
    assertCommittedDatabaseReadAllowed(reader);
    if (telemetry !== adapter) return null;
    const stored = ledger(reader, key);
    if (!stored || adapter.currentAccountId() !== stored.ownerAccountId) return null;
    const attempt = stored.attempts.find((a) => a.operationId === operationId);
    if (!attempt || (terminal && !attempt.terminal)) return null;
    const stage = terminal ? attempt.terminal : null;
    const occurredAtMs = stage?.occurredAtMs ?? attempt.startedAtMs;
    return {
      origin: attempt.origin,
      event: {
        eventId: stage?.eventId ?? attempt.acceptedEventId,
        eventName: 'workspace_sync_stage',
        payloadSchemaVersion: 1,
        referenceKind: 'workspace_sync_restore',
        referenceId: attempt.operationId,
        createdAtMs: occurredAtMs,
        properties: {
          feature_area: 'workspace',
          sync_operation: 'restore',
          sync_stage: stage?.outcome ?? 'accepted',
          operation_id: attempt.operationId,
          ...(attempt.parentOperationId ? { parent_action_id: attempt.parentOperationId } : {}),
          origin_started_at_ms: attempt.startedAtMs,
          occurred_at_ms: occurredAtMs,
          ...(stage?.errorCode ? { error_code: stage.errorCode } : {}),
        },
      },
    };
  } finally {
    if (reader !== db) reader.close();
  }
}
export function publishWorkspaceSyncRestoreTelemetry(db: Database.Database): void {
  try {
    assertCommittedDatabaseReadAllowed(db);
    const adapter = telemetry;
    if (!adapter) return;
    const rows = z
      .array(z.object({ key: z.string() }))
      .parse(
        db
          .prepare('SELECT key FROM settings WHERE substr(key,1,?)=? ORDER BY key')
          .all(WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX.length, WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX)
      );
    for (const { key } of rows) {
      const stored = ledger(db, key);
      if (!stored || adapter.currentAccountId() !== stored.ownerAccountId) continue;
      for (const attempt of stored.attempts) {
        try {
          adapter.publish(() => committedStage(db, key, attempt.operationId, false, adapter));
          if (attempt.terminal)
            adapter.publish(() => committedStage(db, key, attempt.operationId, true, adapter));
        } catch {}
      }
    }
  } catch {}
}
export function purgeWorkspaceSyncRestoreTelemetry(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE substr(key,1,?)=?').run(
    WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX.length,
    WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX
  );
}
