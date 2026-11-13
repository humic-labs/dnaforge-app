import { platform } from '../platform';
import type { MeaningfulActivityAuthority } from '../shared/analytics-types';

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PendingMeaningfulActivityInput {
  actionId: string;
  workflow: string;
  action: string;
  status: string;
  initiatedAtMs: number;
  qualifiedAtMs: number;
  valueDelivered?: boolean;
  usableResult?: boolean;
  selectedCount?: number;
  appSessionId: string;
}

interface PendingMeaningfulActivityRow {
  action_id: string;
  workflow: string;
  workflow_action: string;
  workflow_status: string;
  initiated_at_ms: number;
  qualified_at_ms: number;
  value_delivered: number | null;
  usable_result: number | null;
  selected_count: number | null;
  app_session_id: string;
}

interface PendingReceiptDatabase {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

interface PendingReceiptDependencies {
  db?: PendingReceiptDatabase;
  now?: () => number;
}

function database(dependencies: PendingReceiptDependencies): PendingReceiptDatabase {
  return dependencies.db ?? platform().db;
}

export async function storePendingMeaningfulActivityReceipt(
  input: PendingMeaningfulActivityInput,
  dependencies: PendingReceiptDependencies = {}
): Promise<void> {
  const db = database(dependencies);
  const now = dependencies.now?.() ?? Date.now();
  await expirePendingMeaningfulActivityReceipts({ db, now: () => now });
  await db.execute(
    `INSERT OR IGNORE INTO meaningful_activity_pending (
       action_id, workflow, workflow_action, workflow_status,
       initiated_at_ms, qualified_at_ms, value_delivered, usable_result,
       selected_count, app_session_id, upload_state, historical,
       created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [
      input.actionId,
      input.workflow,
      input.action,
      input.status,
      input.initiatedAtMs,
      input.qualifiedAtMs,
      input.valueDelivered === undefined ? null : Number(input.valueDelivered),
      input.usableResult === undefined ? null : Number(input.usableResult),
      input.selectedCount ?? null,
      input.appSessionId,
      now,
      now + RECEIPT_RETENTION_MS,
    ]
  );
}

export async function expirePendingMeaningfulActivityReceipts(
  dependencies: PendingReceiptDependencies = {}
): Promise<void> {
  const now = dependencies.now?.() ?? Date.now();
  await database(dependencies).execute(
    `UPDATE meaningful_activity_pending
     SET upload_state = 'expired'
     WHERE upload_state = 'pending' AND expires_at_ms < ?`,
    [now]
  );
}

export async function deliverPendingMeaningfulActivityReceipts(input: {
  accountId: string;
  appSessionId: string;
  authority: MeaningfulActivityAuthority;
  binding: 'same_session' | 'explicit';
  explicitConfirmation?: boolean;
  emit(properties: Record<string, unknown>): boolean;
  dependencies?: PendingReceiptDependencies;
}): Promise<number> {
  if (
    !UUID_RE.test(input.accountId) ||
    (input.authority.actorKind !== 'external' && input.authority.actorKind !== 'internal') ||
    input.authority.executionMode !== 'interactive' ||
    input.authority.impersonated ||
    (input.binding === 'explicit' && input.explicitConfirmation !== true)
  ) {
    return 0;
  }
  const dependencies = input.dependencies ?? {};
  const db = database(dependencies);
  const now = dependencies.now?.() ?? Date.now();
  await expirePendingMeaningfulActivityReceipts({ db, now: () => now });
  const rows = await db.select<PendingMeaningfulActivityRow[]>(
    `SELECT action_id, workflow, workflow_action, workflow_status,
            initiated_at_ms, qualified_at_ms, value_delivered, usable_result,
            selected_count, app_session_id
     FROM meaningful_activity_pending
     WHERE upload_state = 'pending' AND expires_at_ms >= ?
       ${input.binding === 'same_session' ? 'AND app_session_id = ?' : ''}
     ORDER BY initiated_at_ms, action_id`,
    input.binding === 'same_session' ? [now, input.appSessionId] : [now]
  );

  let delivered = 0;
  for (const row of rows) {
    const historical = input.binding === 'explicit' || row.app_session_id !== input.appSessionId;
    const identityResolution = historical ? 'linked_later' : 'direct_session';
    const accepted = input.emit({
      feature_area: 'scientific_workflow',
      workflow: row.workflow,
      workflow_action: row.workflow_action,
      workflow_status: row.workflow_status,
      identity_kind: 'identified',
      actor_kind: input.authority.actorKind,
      execution_mode: 'interactive',
      workspace_kind: 'unknown',
      historical,
      identity_resolution: identityResolution,
      impersonated: false,
      action_id: row.action_id,
      initiated_at_ms: row.initiated_at_ms,
      qualified_at_ms: row.qualified_at_ms,
      $insert_id: row.action_id,
      ...(row.value_delivered === null ? {} : { value_delivered: row.value_delivered === 1 }),
      ...(row.usable_result === null ? {} : { usable_result: row.usable_result === 1 }),
    });
    if (!accepted) continue;
    await db.execute(
      `UPDATE meaningful_activity_pending
       SET upload_state = 'sent', bound_account_id = ?, identity_resolution = ?,
           historical = ?, sent_at_ms = ?
       WHERE action_id = ? AND upload_state = 'pending'`,
      [input.accountId, identityResolution, Number(historical), now, row.action_id]
    );
    delivered += 1;
  }
  return delivered;
}

export const meaningfulActivityPendingRetentionMs = RECEIPT_RETENTION_MS;
