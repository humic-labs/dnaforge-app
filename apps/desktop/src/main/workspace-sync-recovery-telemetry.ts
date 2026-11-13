import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Database from 'better-sqlite3';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import type { CommittedOptionalAnalyticsReceipt } from './analytics-outbox';
import type { WorkspaceSyncQueueJob } from './workspace-sync-queue';
import type { WorkspaceSyncRecoveryCandidateIntent } from './workspace-sync-recovery-candidate';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';

export const WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX =
  '_cloud_backup_recovery_telemetry_receipt_v1:';

export type WorkspaceSyncRecoveryStageProperties = {
  feature_area: 'workspace';
  recovery_stage: 'accepted' | 'retained';
  operation_id: string;
  parent_action_id?: string;
  origin_started_at_ms: number;
  occurred_at_ms: number;
};

export type WorkspaceSyncRecoveryTelemetryEvent =
  CommittedOptionalAnalyticsReceipt<WorkspaceSyncRecoveryStageProperties>;

type WorkspaceSyncRecoveryTelemetry = {
  captureOrigin(): OptionalTelemetryOrigin | null;
  currentAccountId(): string | null;
  openCommittedDatabase?(db: Database.Database): Database.Database;
  publish(readCommitted: () => WorkspaceSyncRecoveryTelemetryEvent | null): boolean;
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
    outcome: z.literal('retained'),
    occurredAtMs: clock,
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
    format: z.literal('workspace-sync-recovery'),
    schemaVersion: z.literal(1),
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
let telemetry: WorkspaceSyncRecoveryTelemetry | null = null;

export function configureWorkspaceSyncRecoveryTelemetry(
  next: WorkspaceSyncRecoveryTelemetry | null
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
    return parsed.success && key === WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + parsed.data.jobId
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

export function acceptWorkspaceSyncRecoveryTelemetry(
  db: Database.Database,
  input: {
    job: WorkspaceSyncQueueJob;
    intent: WorkspaceSyncRecoveryCandidateIntent;
    previousOperationId: string | null;
    nowMs: number;
  }
): void {
  try {
    if (!db.inTransaction || input.job.operation !== 'upload') return;
    const identity = z.object({ id: z.string().uuid(), startedAt: clock }).safeParse({
      id: input.intent.acceptedOperationId,
      startedAt: input.intent.createdAtMs,
    });
    if (
      !identity.success ||
      identity.data.startedAt !== input.nowMs ||
      identity.data.id === input.previousOperationId ||
      input.intent.parentAcceptedOperationId !== input.previousOperationId
    )
      return;
    db.transaction(() => {
      const key = WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + input.job.id;
      const stored = readLedger(db, key);
      if (
        stored &&
        (stored.value.jobCreatedAtMs !== input.job.createdAt ||
          stored.value.ownerAccountId !== input.intent.ownerAccountId ||
          stored.value.attempts.some((attempt) => attempt.operationId === identity.data.id))
      )
        return;
      if (telemetry?.currentAccountId() !== input.intent.ownerAccountId) return;
      const origin = originSchema.safeParse(telemetry?.captureOrigin());
      if (!origin.success) return;
      const value: Ledger = {
        format: 'workspace-sync-recovery',
        schemaVersion: 1,
        jobId: input.job.id,
        jobCreatedAtMs: input.job.createdAt,
        ownerAccountId: input.intent.ownerAccountId,
        attempts: [
          ...(stored?.value.attempts ?? []),
          {
            operationId: identity.data.id,
            parentOperationId: input.intent.parentAcceptedOperationId,
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

export function settleWorkspaceSyncRecoveryTelemetry(
  db: Database.Database,
  input: { job: WorkspaceSyncQueueJob; intent: WorkspaceSyncRecoveryCandidateIntent }
): void {
  try {
    if (!db.inTransaction || !input.intent.receipt) return;
    const identity = z
      .object({
        id: z.string().uuid(),
        startedAt: clock,
        retainedAt: clock,
      })
      .safeParse({
        id: input.intent.acceptedOperationId,
        startedAt: input.intent.createdAtMs,
        retainedAt: input.intent.retainedAtMs,
      });
    if (!identity.success) return;
    db.transaction(() => {
      const key = WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + input.job.id;
      const stored = readLedger(db, key);
      if (
        !stored ||
        stored.value.jobCreatedAtMs !== input.job.createdAt ||
        stored.value.ownerAccountId !== input.intent.ownerAccountId
      )
        return;
      const attempt = stored.value.attempts.at(-1);
      if (
        !attempt ||
        attempt.terminal ||
        attempt.operationId !== identity.data.id ||
        attempt.parentOperationId !== input.intent.parentAcceptedOperationId ||
        attempt.startedAtMs !== identity.data.startedAt
      )
        return;
      attempt.terminal = {
        eventId: randomUUID(),
        outcome: 'retained',
        occurredAtMs: identity.data.retainedAt,
      };
      writeLedger(db, key, stored.value, stored.encoded, identity.data.retainedAt);
    })();
  } catch {}
}

function committedStage(
  db: Database.Database,
  key: string,
  operationId: string,
  stage: 'accepted' | 'terminal',
  adapter: WorkspaceSyncRecoveryTelemetry
): WorkspaceSyncRecoveryTelemetryEvent | null {
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
  adapter: WorkspaceSyncRecoveryTelemetry
): WorkspaceSyncRecoveryTelemetryEvent | null {
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
      eventName: 'workspace_recovery_stage',
      payloadSchemaVersion: 1,
      referenceKind: 'workspace_sync_recovery',
      referenceId: attempt.operationId,
      createdAtMs: occurredAtMs,
      properties: {
        feature_area: 'workspace',
        recovery_stage: terminal?.outcome ?? 'accepted',
        operation_id: attempt.operationId,
        ...(attempt.parentOperationId ? { parent_action_id: attempt.parentOperationId } : {}),
        origin_started_at_ms: attempt.startedAtMs,
        occurred_at_ms: occurredAtMs,
      },
    },
  };
}

export function publishWorkspaceSyncRecoveryTelemetry(db: Database.Database, jobId?: string): void {
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
                WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length,
                WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX
              )
          : [{ key: WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + jobId }]
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

export function purgeWorkspaceSyncRecoveryTelemetry(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE substr(key,1,?) = ?').run(
    WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length,
    WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX
  );
}
