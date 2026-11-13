import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Database from 'better-sqlite3';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import type { CommittedOptionalAnalyticsReceipt } from './analytics-outbox';
import type { WorkspaceSyncQueueJob } from './workspace-sync-queue';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { workspaceSyncErrorCode } from './workspace-sync-observation';

export const WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX = '_cloud_backup_telemetry_receipt_v2:';

export type WorkspaceSyncUploadStageProperties = {
  feature_area: 'workspace';
  sync_operation: 'upload';
  sync_stage: 'accepted' | 'uploaded' | 'unchanged' | 'failed';
  operation_id: string;
  parent_action_id?: string;
  origin_started_at_ms: number;
  occurred_at_ms: number;
  error_code?: string;
};

export type WorkspaceSyncUploadTelemetryEvent =
  CommittedOptionalAnalyticsReceipt<WorkspaceSyncUploadStageProperties>;

type WorkspaceSyncUploadTelemetry = {
  captureOrigin(): OptionalTelemetryOrigin | null;
  currentAccountId(): string | null;
  openCommittedDatabase?(db: Database.Database): Database.Database;
  publish(readCommitted: () => WorkspaceSyncUploadTelemetryEvent | null): boolean;
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
const terminalSchema = z
  .object({
    eventId: z.string().uuid(),
    outcome: z.enum(['uploaded', 'unchanged', 'failed']),
    occurredAtMs: clock,
    errorCode: z
      .string()
      .max(64)
      .refine((value) => workspaceSyncErrorCode(value) === value)
      .optional(),
  })
  .strict();
const attemptSchema = z
  .object({
    operationId: z.string().uuid(),
    parentOperationId: z.string().uuid().nullable(),
    acceptedEventId: z.string().uuid(),
    origin: originSchema,
    startedAtMs: clock,
    terminal: terminalSchema.nullable(),
  })
  .strict();
const ledgerSchema = z
  .object({
    format: z.literal('workspace-sync-upload'),
    schemaVersion: z.literal(2),
    jobId: z.string().min(1).max(128),
    jobCreatedAtMs: clock,
    ownerAccountId: z.string().min(1).max(128),
    attempts: z.array(attemptSchema).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, attempt] of value.attempts.entries()) {
      const previous = value.attempts[index - 1];
      const invalid =
        attempt.startedAtMs < value.jobCreatedAtMs ||
        (attempt.terminal !== null && attempt.terminal.occurredAtMs < attempt.startedAtMs) ||
        attempt.parentOperationId === attempt.operationId ||
        (previous !== undefined &&
          attempt.startedAtMs < (previous.terminal?.occurredAtMs ?? previous.startedAtMs));
      const ownIds = [
        attempt.operationId,
        attempt.acceptedEventId,
        ...(attempt.terminal ? [attempt.terminal.eventId] : []),
      ];
      if (invalid || ownIds.some((id) => ids.has(id)) || new Set(ownIds).size !== ownIds.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid native upload receipt lineage.',
        });
      for (const id of ownIds) ids.add(id);
    }
  });
type Ledger = z.infer<typeof ledgerSchema>;
let telemetry: WorkspaceSyncUploadTelemetry | null = null;

export function configureWorkspaceSyncUploadTelemetry(
  next: WorkspaceSyncUploadTelemetry | null
): void {
  telemetry = next;
}

function readLedger(db: Database.Database, key: string): { value: Ledger; encoded: string } | null {
  const row = z
    .object({ value: z.string() })
    .safeParse(db.prepare('SELECT value FROM settings WHERE key = ?').get(key));
  if (!row.success) return null;
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(row.data.value));
    return parsed.success && key === WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX + parsed.data.jobId
      ? { value: parsed.data, encoded: row.data.value }
      : null;
  } catch {
    return null;
  }
}

function writeLedger(
  db: Database.Database,
  key: string,
  value: Ledger,
  previous: string | null,
  nowMs: number
): void {
  const encoded = JSON.stringify(ledgerSchema.parse(value));
  if (previous === null) {
    db.prepare(
      'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING'
    ).run(key, encoded, nowMs);
  } else {
    db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?').run(
      encoded,
      nowMs,
      key,
      previous
    );
  }
}

export function acceptWorkspaceSyncUploadTelemetry(
  db: Database.Database,
  input: {
    job: WorkspaceSyncQueueJob;
    ownerAccountId: string;
    nowMs: number;
    retry: boolean;
    parentOperationId?: string | null;
  }
): void {
  try {
    if (!db.inTransaction || input.job.operation !== 'upload') return;
    const identity = z.object({ id: z.string().uuid(), startedAt: clock }).safeParse({
      id: input.job.acceptedOperationId,
      startedAt: input.job.acceptedOperationStartedAt,
    });
    if (!identity.success || identity.data.startedAt !== input.nowMs) return;
    db.transaction(() => {
      const key = WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX + input.job.id;
      const stored = readLedger(db, key);
      if (
        stored &&
        (stored.value.jobCreatedAtMs !== input.job.createdAt ||
          stored.value.ownerAccountId !== input.ownerAccountId)
      )
        return;
      if (
        stored &&
        (!input.retry ||
          stored.value.attempts.some((attempt) => attempt.operationId === identity.data.id))
      )
        return;
      if (telemetry?.currentAccountId() !== input.ownerAccountId) return;
      const origin = originSchema.safeParse(telemetry?.captureOrigin());
      if (!origin.success) return;
      const value: Ledger = {
        format: 'workspace-sync-upload',
        schemaVersion: 2,
        jobId: input.job.id,
        jobCreatedAtMs: input.job.createdAt,
        ownerAccountId: input.ownerAccountId,
        attempts: [
          ...(stored?.value.attempts ?? []),
          {
            operationId: identity.data.id,
            parentOperationId: input.parentOperationId ?? null,
            acceptedEventId: randomUUID(),
            origin: origin.data,
            startedAtMs: identity.data.startedAt,
            terminal: null,
          },
        ],
      };
      writeLedger(db, key, value, stored?.encoded ?? null, input.nowMs);
    })();
  } catch {}
}

export function readWorkspaceSyncUploadTelemetryOperation(
  db: Database.Database,
  job: WorkspaceSyncQueueJob
): string | null {
  try {
    const stored = readLedger(db, WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX + job.id);
    if (!stored || stored.value.jobCreatedAtMs !== job.createdAt) return null;
    const attempt = stored.value.attempts.at(-1);
    return attempt &&
      !attempt.terminal &&
      attempt.operationId === job.acceptedOperationId &&
      attempt.startedAtMs === job.acceptedOperationStartedAt
      ? attempt.operationId
      : null;
  } catch {
    return null;
  }
}

export function settleWorkspaceSyncUploadTelemetry(
  db: Database.Database,
  input: {
    job: WorkspaceSyncQueueJob;
    operationId: string | null;
    outcome: 'uploaded' | 'unchanged' | 'failed';
    nowMs: number;
    errorCode?: string;
  }
): void {
  try {
    if (!db.inTransaction) return;
    db.transaction(() => {
      const key = WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX + input.job.id;
      const stored = readLedger(db, key);
      if (!stored || stored.value.jobCreatedAtMs !== input.job.createdAt) return;
      const attempt = stored.value.attempts.at(-1);
      if (
        !attempt ||
        attempt.terminal ||
        attempt.operationId !== input.operationId ||
        attempt.operationId !== input.job.acceptedOperationId ||
        attempt.startedAtMs !== input.job.acceptedOperationStartedAt
      )
        return;
      attempt.terminal = {
        eventId: randomUUID(),
        outcome: input.outcome,
        occurredAtMs: input.nowMs,
        ...(input.outcome === 'failed'
          ? { errorCode: workspaceSyncErrorCode(input.errorCode) }
          : {}),
      };
      writeLedger(db, key, stored.value, stored.encoded, input.nowMs);
    })();
  } catch {}
}

function committedStage(
  db: Database.Database,
  key: string,
  operationId: string,
  stage: 'accepted' | 'terminal',
  adapter: WorkspaceSyncUploadTelemetry
): WorkspaceSyncUploadTelemetryEvent | null {
  if (db.name !== ':memory:') {
    const reader =
      adapter.openCommittedDatabase?.(db) ??
      new Database(db.name, { readonly: true, fileMustExist: true });
    try {
      return committedStageFromDatabase(reader, key, operationId, stage, adapter);
    } finally {
      reader.close();
    }
  }
  return committedStageFromDatabase(db, key, operationId, stage, adapter);
}

function committedStageFromDatabase(
  db: Database.Database,
  key: string,
  operationId: string,
  stage: 'accepted' | 'terminal',
  adapter: WorkspaceSyncUploadTelemetry
): WorkspaceSyncUploadTelemetryEvent | null {
  assertCommittedDatabaseReadAllowed(db);
  if (telemetry !== adapter) return null;
  const stored = readLedger(db, key);
  if (!stored || adapter.currentAccountId() !== stored.value.ownerAccountId) return null;
  const attempt = stored.value.attempts.find((value) => value.operationId === operationId);
  if (!attempt || (stage === 'terminal' && !attempt.terminal)) return null;
  const terminal = stage === 'terminal' ? attempt.terminal : null;
  const eventId = terminal?.eventId ?? attempt.acceptedEventId;
  const occurredAtMs = terminal?.occurredAtMs ?? attempt.startedAtMs;
  return {
    origin: attempt.origin,
    event: {
      eventId,
      eventName: 'workspace_sync_stage',
      payloadSchemaVersion: 1,
      referenceKind: 'workspace_sync_upload',
      referenceId: attempt.operationId,
      createdAtMs: occurredAtMs,
      properties: {
        feature_area: 'workspace',
        sync_operation: 'upload',
        sync_stage: terminal?.outcome ?? 'accepted',
        operation_id: attempt.operationId,
        ...(attempt.parentOperationId ? { parent_action_id: attempt.parentOperationId } : {}),
        origin_started_at_ms: attempt.startedAtMs,
        occurred_at_ms: occurredAtMs,
        ...(terminal?.errorCode ? { error_code: terminal.errorCode } : {}),
      },
    },
  };
}

export function publishWorkspaceSyncUploadTelemetry(db: Database.Database, jobId?: string): void {
  try {
    assertCommittedDatabaseReadAllowed(db);
    const adapter = telemetry;
    if (!adapter) return;
    const rows = z
      .array(z.object({ key: z.string() }))
      .parse(
        jobId === undefined
          ? db
              .prepare('SELECT key FROM settings WHERE substr(key,1,?) = ? ORDER BY key')
              .all(
                WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX.length,
                WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX
              )
          : [{ key: WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX + jobId }]
      );
    for (const { key } of rows) {
      try {
        const stored = readLedger(db, key);
        if (!stored || adapter.currentAccountId() !== stored.value.ownerAccountId) continue;
        for (const attempt of stored.value.attempts) {
          adapter.publish(() => committedStage(db, key, attempt.operationId, 'accepted', adapter));
          if (attempt.terminal)
            adapter.publish(() =>
              committedStage(db, key, attempt.operationId, 'terminal', adapter)
            );
        }
      } catch {}
    }
  } catch {}
}

export function purgeWorkspaceSyncUploadTelemetry(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE substr(key,1,?) = ?').run(
    WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX.length,
    WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX
  );
}
