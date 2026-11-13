import type Database from 'better-sqlite3';

export const WORKSPACE_SYNC_ACCESS_REMOVED_CODE = 'ACCESS_REMOVED';

export interface WorkspaceSyncAccessBindingRow {
  workspace_id: number;
  workspace_uuid: string;
  owner_account_id: string;
  owner_org_id: string | null;
  remote_workspace_id: string | null;
  enabled: number;
  access_role: string | null;
  access_source: string | null;
  shared_with_others: number;
  detached_reason: string | null;
}

export function readWorkspaceSyncAccessBinding(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceSyncAccessBindingRow | null {
  const row = db
    .prepare(
      `SELECT workspace_id, workspace_uuid, owner_account_id, owner_org_id,
              remote_workspace_id, enabled, access_role, access_source,
              shared_with_others, detached_reason
       FROM workspace_sync_bindings
       WHERE workspace_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceSyncAccessBindingRow | undefined;
  return row ?? null;
}

export function isSharedAccessBinding(row: {
  owner_org_id: string | null;
  access_source: string | null;
  shared_with_others: number | null;
}): boolean {
  if (row.owner_org_id) return true;
  if (row.shared_with_others === 1) return true;
  const source = row.access_source ?? 'owner';
  return source !== 'owner';
}

export function isAccessRemovedError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'DesktopSyncClientError') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FORBIDDEN' || code === 'NOT_FOUND';
}

export interface MarkAccessRemovedInput {
  workspaceId: number;
  nowMs: number;
  reason?: string;
}

export function markWorkspaceSyncAccessRemoved(
  db: Database.Database,
  input: MarkAccessRemovedInput
): boolean {
  return db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE workspace_sync_bindings
         SET enabled = 0,
             detached_reason = 'access_removed',
             updated_at = @nowMs
         WHERE workspace_id = @workspaceId
           AND (detached_reason IS NULL OR detached_reason <> 'access_removed')`
      )
      .run({ workspaceId: input.workspaceId, nowMs: input.nowMs }).changes;
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'blocked',
           locked_at = NULL,
           locked_by_device_id = NULL,
           next_attempt_at = NULL,
           error_code = @code,
           error_message = @message,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND operation IN ('upload', 'refresh')
         AND status IN ('pending', 'retry_wait', 'blocked', 'failed')`
    ).run({
      workspaceId: input.workspaceId,
      code: WORKSPACE_SYNC_ACCESS_REMOVED_CODE,
      message:
        input.reason ??
        'You no longer have access to this shared project. Your unsent changes are kept on this computer.',
      nowMs: input.nowMs,
    });
    return updated === 1;
  })();
}

export function updateWorkspaceSyncAccessRecord(
  db: Database.Database,
  input: {
    workspaceId: number;
    role: string;
    source: string;
    sharedWithOthers?: boolean;
    nowMs: number;
  }
): boolean {
  const updated = db
    .prepare(
      `UPDATE workspace_sync_bindings
       SET access_role = @role,
           access_source = @source,
           shared_with_others = CASE
             WHEN @sharedWithOthers IS NULL THEN shared_with_others
             ELSE @sharedWithOthers
           END,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND (
           access_role IS NOT @role
           OR access_source IS NOT @source
           OR (@sharedWithOthers IS NOT NULL AND shared_with_others IS NOT @sharedWithOthers)
         )`
    )
    .run({
      workspaceId: input.workspaceId,
      role: input.role,
      source: input.source,
      sharedWithOthers:
        input.sharedWithOthers === undefined ? null : input.sharedWithOthers ? 1 : 0,
      nowMs: input.nowMs,
    }).changes;
  return updated === 1;
}
