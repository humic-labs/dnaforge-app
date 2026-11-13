import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import type { CommittedOptionalAnalyticsReceipt } from './analytics-outbox';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { readWorkspaceSyncEnablement } from './workspace-sync-enablement';

export const WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX =
  '_cloud_backup_enable_telemetry_receipt_v1:';

export type WorkspaceSyncEnablementProperties = {
  feature_area: 'workspace';
  operation_id: string;
  parent_action_id?: string;
  origin_started_at_ms: number;
  occurred_at_ms: number;
};

export type WorkspaceSyncEnablementTelemetryEvent =
  CommittedOptionalAnalyticsReceipt<WorkspaceSyncEnablementProperties>;

type WorkspaceSyncEnablementTelemetry = {
  captureOrigin(): OptionalTelemetryOrigin | null;
  currentAccountId(): string | null;
  openCommittedDatabase?(db: Database.Database): Database.Database;
  publish(readCommitted: () => WorkspaceSyncEnablementTelemetryEvent | null): boolean;
};

const receiptSchema = z
  .object({
    format: z.literal('workspace-sync-enable-telemetry'),
    schemaVersion: z.literal(1),
    workspaceUuid: z.string().min(1).max(128),
    ownerAccountId: z.string().min(1).max(128),
    operationId: z.string().uuid(),
    eventId: z.string().uuid(),
    origin: z
      .object({
        consentScope: z.string().uuid(),
        contextId: z.string().uuid(),
        processId: z.string().uuid(),
        classification: z.enum(['synthetic', 'private', 'unknown', 'eligible_release']),
      })
      .strict(),
  })
  .strict();
let telemetry: WorkspaceSyncEnablementTelemetry | null = null;

export function configureWorkspaceSyncEnablementTelemetry(
  next: WorkspaceSyncEnablementTelemetry | null
): void {
  telemetry = next;
}

export function acceptWorkspaceSyncEnablementTelemetry(
  db: Database.Database,
  input: { workspaceUuid: string; operationId: string }
): void {
  try {
    const adapter = telemetry;
    if (!db.inTransaction || !adapter) return;
    const key = WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX + input.operationId;
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined) return;
    const native = readWorkspaceSyncEnablement(db, input.workspaceUuid);
    if (!native) return;
    const episode = native.episodes.find((value) => value.operationId === input.operationId);
    if (!episode || adapter.currentAccountId() !== episode.ownerAccountId) return;
    const value = receiptSchema.parse({
      format: 'workspace-sync-enable-telemetry',
      schemaVersion: 1,
      workspaceUuid: native.workspaceUuid,
      ownerAccountId: episode.ownerAccountId,
      operationId: episode.operationId,
      eventId: randomUUID(),
      origin: adapter.captureOrigin(),
    });
    db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
      key,
      JSON.stringify(value),
      episode.startedAtMs
    );
  } catch {}
}

function committedEvent(
  db: Database.Database,
  key: string,
  adapter: WorkspaceSyncEnablementTelemetry
): WorkspaceSyncEnablementTelemetryEvent | null {
  const reader =
    db.name === ':memory:'
      ? db
      : (adapter.openCommittedDatabase?.(db) ??
        new Database(db.name, { readonly: true, fileMustExist: true }));
  try {
    assertCommittedDatabaseReadAllowed(reader);
    if (telemetry !== adapter) return null;
    const row = z
      .object({ value: z.string() })
      .safeParse(reader.prepare('SELECT value FROM settings WHERE key = ?').get(key));
    if (!row.success) return null;
    const receipt = receiptSchema.parse(JSON.parse(row.data.value));
    if (
      key !== WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX + receipt.operationId ||
      adapter.currentAccountId() !== receipt.ownerAccountId
    )
      return null;
    const native = readWorkspaceSyncEnablement(reader, receipt.workspaceUuid);
    if (!native) return null;
    const episode = native.episodes.find((value) => value.operationId === receipt.operationId);
    if (!episode || episode.ownerAccountId !== receipt.ownerAccountId) return null;
    return {
      origin: receipt.origin,
      event: {
        eventId: receipt.eventId,
        eventName: 'workspace_backup_enabled',
        payloadSchemaVersion: 1,
        referenceKind: 'workspace_sync_enablement',
        referenceId: episode.operationId,
        createdAtMs: episode.startedAtMs,
        properties: {
          feature_area: 'workspace',
          operation_id: episode.operationId,
          ...(episode.parentOperationId ? { parent_action_id: episode.parentOperationId } : {}),
          origin_started_at_ms: episode.startedAtMs,
          occurred_at_ms: episode.startedAtMs,
        },
      },
    };
  } finally {
    if (reader !== db) reader.close();
  }
}

export function publishWorkspaceSyncEnablementTelemetry(db: Database.Database): void {
  try {
    assertCommittedDatabaseReadAllowed(db);
    const adapter = telemetry;
    if (!adapter) return;
    const rows = z
      .array(z.object({ key: z.string() }))
      .parse(
        db
          .prepare('SELECT key FROM settings WHERE substr(key,1,?) = ? ORDER BY key')
          .all(
            WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX.length,
            WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX
          )
      );
    for (const { key } of rows) {
      try {
        adapter.publish(() => committedEvent(db, key, adapter));
      } catch {}
    }
  } catch {}
}

export function purgeWorkspaceSyncEnablementTelemetry(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE substr(key,1,?) = ?').run(
    WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX.length,
    WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX
  );
}
