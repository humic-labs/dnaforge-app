import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import type Database from 'better-sqlite3';
import type { WorkspaceSyncReplicaAppliedNotice } from './workspace-sync-replica-publisher';

const LEGACY_PENDING_CODE = 'RENDERER_REFRESH_PENDING';
const PENDING_REFRESH_PAYLOAD_VERSION = 1;
const MAX_PENDING_REFRESH_PAYLOAD_BYTES = 2 * 1024 * 1024;

interface PendingRefreshPayload {
  version: typeof PENDING_REFRESH_PAYLOAD_VERSION;
  notice: WorkspaceSyncReplicaAppliedNotice;
}

type DeliveryState = 'pending' | 'needs_attention' | 'succeeded';
interface DeliveryRow {
  id: string;
  workspace_id: number;
  workspace_uuid: string | null;
  workspace_root: string | null;
  owner_account_id: string | null;
  remote_workspace_id: string | null;
  remote_version_id: string | null;
  local_head_sha: string | null;
  payload_version: number;
  payload_json: string | null;
  state: DeliveryState;
  last_error_code: string | null;
  last_error_message: string | null;
}

export interface PendingWorkspaceSyncRendererRefresh {
  deliveryId: string;
  workspaceId: number;
  ownerAccountId: string;
  remoteWorkspaceId: string;
  localHeadSha: string;
  payloadJson: string;
  notice: WorkspaceSyncReplicaAppliedNotice;
}

interface BindingIdentity {
  workspace_uuid: string;
  workspace_root: string;
  owner_account_id: string;
  remote_workspace_id: string | null;
  remote_latest_version_id: string | null;
  last_acked_local_head_sha: string | null;
}

function bindingIdentity(db: Database.Database, workspaceId: number): BindingIdentity | undefined {
  return db
    .prepare(
      `SELECT b.workspace_uuid, w.path AS workspace_root, b.owner_account_id,
      b.remote_workspace_id, b.remote_latest_version_id, b.last_acked_local_head_sha
    FROM workspace_sync_bindings b JOIN workspaces w ON w.id = b.workspace_id
    WHERE b.workspace_id = ? AND w.repo_uuid = b.workspace_uuid`
    )
    .get(workspaceId) as BindingIdentity | undefined;
}

export function recordPendingWorkspaceSyncRendererRefresh(
  db: Database.Database,
  input: {
    workspaceId: number;
    localHeadSha: string;
    notice: WorkspaceSyncReplicaAppliedNotice;
    nowMs: number;
  }
): string {
  assertReplicaAppliedNotice(input.notice);
  const binding = bindingIdentity(db, input.workspaceId);
  if (
    !binding?.remote_workspace_id ||
    binding.workspace_uuid !== input.notice.workspaceUuid ||
    binding.workspace_root !== input.notice.workspaceRoot ||
    binding.remote_latest_version_id !== input.notice.remoteVersionId ||
    binding.last_acked_local_head_sha !== input.localHeadSha
  ) {
    throw new Error('Renderer delivery does not match the committed workspace binding.');
  }
  const payload = JSON.stringify({
    version: PENDING_REFRESH_PAYLOAD_VERSION,
    notice: input.notice,
  } satisfies PendingRefreshPayload);
  if (Buffer.byteLength(payload, 'utf8') > MAX_PENDING_REFRESH_PAYLOAD_BYTES) {
    throw new Error('Pending renderer refresh payload exceeds its durable size limit.');
  }
  const existing = db
    .prepare(
      `SELECT * FROM workspace_sync_renderer_deliveries
    WHERE workspace_id = ? AND owner_account_id = ? AND remote_workspace_id = ? AND remote_version_id = ?`
    )
    .get(
      input.workspaceId,
      binding.owner_account_id,
      binding.remote_workspace_id,
      input.notice.remoteVersionId
    ) as DeliveryRow | undefined;
  if (existing) {
    if (
      existing.payload_json !== payload ||
      existing.local_head_sha !== input.localHeadSha ||
      existing.workspace_uuid !== binding.workspace_uuid ||
      existing.workspace_root !== binding.workspace_root
    ) {
      throw new Error('Renderer delivery identity already has different replay instructions.');
    }
    return existing.id;
  }
  const deliveryId = `renderer-refresh-${randomUUID()}`;
  db.prepare(
    `INSERT INTO workspace_sync_renderer_deliveries (
    id, workspace_id, workspace_uuid, workspace_root, owner_account_id, remote_workspace_id,
    remote_version_id, local_head_sha, payload_version, payload_json, state, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    deliveryId,
    input.workspaceId,
    binding.workspace_uuid,
    binding.workspace_root,
    binding.owner_account_id,
    binding.remote_workspace_id,
    input.notice.remoteVersionId,
    input.localHeadSha,
    PENDING_REFRESH_PAYLOAD_VERSION,
    payload,
    input.nowMs,
    input.nowMs
  );
  return deliveryId;
}

export function readPendingWorkspaceSyncRendererRefresh(
  db: Database.Database,
  workspaceId: number
): PendingWorkspaceSyncRendererRefresh | null {
  const row = db
    .prepare(
      `SELECT * FROM workspace_sync_renderer_deliveries
    WHERE workspace_id = ? AND state <> 'succeeded' ORDER BY created_at, id LIMIT 1`
    )
    .get(workspaceId) as DeliveryRow | undefined;
  if (!row) return null;
  try {
    return validateDelivery(db, row);
  } catch (error) {
    db.prepare(
      `UPDATE workspace_sync_renderer_deliveries SET state = 'needs_attention',
      last_error_code = 'RENDERER_DELIVERY_INVALID', last_error_message = ? WHERE id = ?`
    ).run(error instanceof Error ? error.message : 'Renderer delivery is invalid.', row.id);
    throw error;
  }
}

function validateDelivery(
  db: Database.Database,
  row: DeliveryRow
): PendingWorkspaceSyncRendererRefresh {
  if (row.payload_version !== PENDING_REFRESH_PAYLOAD_VERSION)
    throw new Error('Pending renderer refresh payload has an unsupported version.');
  const { notice } = parsePendingRefreshPayload(row.payload_json);
  const binding = bindingIdentity(db, row.workspace_id);
  if (
    !binding ||
    !row.owner_account_id ||
    !row.remote_workspace_id ||
    !row.local_head_sha ||
    row.workspace_uuid !== notice.workspaceUuid ||
    row.workspace_root !== notice.workspaceRoot ||
    row.remote_version_id !== notice.remoteVersionId ||
    binding.workspace_uuid !== row.workspace_uuid ||
    binding.workspace_root !== row.workspace_root ||
    binding.owner_account_id !== row.owner_account_id ||
    binding.remote_workspace_id !== row.remote_workspace_id ||
    binding.remote_latest_version_id !== row.remote_version_id ||
    binding.last_acked_local_head_sha !== row.local_head_sha
  ) {
    throw new Error('Pending renderer refresh does not match the current workspace binding.');
  }
  return {
    deliveryId: row.id,
    workspaceId: row.workspace_id,
    ownerAccountId: row.owner_account_id,
    remoteWorkspaceId: row.remote_workspace_id,
    localHeadSha: row.local_head_sha,
    payloadJson: row.payload_json!,
    notice,
  };
}

export function markWorkspaceSyncRendererRefreshSucceeded(
  db: Database.Database,
  input: { delivery: PendingWorkspaceSyncRendererRefresh; nowMs: number }
): void {
  db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM workspace_sync_renderer_deliveries WHERE id = ?`)
      .get(input.delivery.deliveryId) as DeliveryRow | undefined;
    if (!row) throw new Error('Pending renderer delivery was not found.');
    const current = validateDelivery(db, row);
    if (
      current.workspaceId !== input.delivery.workspaceId ||
      current.ownerAccountId !== input.delivery.ownerAccountId ||
      current.remoteWorkspaceId !== input.delivery.remoteWorkspaceId ||
      current.localHeadSha !== input.delivery.localHeadSha ||
      current.payloadJson !== input.delivery.payloadJson ||
      JSON.stringify(current.notice) !== JSON.stringify(input.delivery.notice)
    ) {
      throw new Error('Renderer acknowledgement does not match the pending delivery.');
    }
    db.prepare(
      `UPDATE workspace_sync_renderer_deliveries SET state = 'succeeded',
      last_error_code = NULL, last_error_message = NULL, updated_at = ?, settled_at = COALESCE(settled_at, ?)
      WHERE id = ?`
    ).run(input.nowMs, input.nowMs, row.id);
  })();
}

export function recordWorkspaceSyncRendererRefreshFailure(
  db: Database.Database,
  input: { workspaceId: number; deliveryId?: string; error: unknown; nowMs: number }
): void {
  db.prepare(
    `UPDATE workspace_sync_renderer_deliveries SET
    last_error_code = 'RENDERER_DELIVERY_FAILED', last_error_message = ?, updated_at = ?
    WHERE workspace_id = ? AND state = 'pending' AND (? IS NULL OR id = ?)`
  ).run(
    input.error instanceof Error ? input.error.message : 'Desktop refresh failed.',
    input.nowMs,
    input.workspaceId,
    input.deliveryId ?? null,
    input.deliveryId ?? null
  );
}

export function migrateLegacyWorkspaceSyncRendererRefresh(db: Database.Database): void {
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, workspace_id, base_remote_version_id, local_head_sha,
      error_message, created_at, updated_at FROM workspace_sync_queue
      WHERE operation = 'refresh' AND error_code = ?`
      )
      .all(LEGACY_PENDING_CODE) as Array<{
      id: string;
      workspace_id: number;
      base_remote_version_id: string | null;
      local_head_sha: string | null;
      error_message: string | null;
      created_at: number;
      updated_at: number;
    }>;
    for (const row of rows) {
      const binding = bindingIdentity(db, row.workspace_id);
      let notice: WorkspaceSyncReplicaAppliedNotice | undefined;
      try {
        notice = parsePendingRefreshPayload(row.error_message).notice;
      } catch {}
      db.prepare(
        `INSERT INTO workspace_sync_renderer_deliveries (
        id, workspace_id, workspace_uuid, workspace_root, owner_account_id, remote_workspace_id,
        remote_version_id, local_head_sha, payload_version, payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?)`
      ).run(
        row.id,
        row.workspace_id,
        notice?.workspaceUuid ?? binding?.workspace_uuid ?? null,
        notice?.workspaceRoot ?? binding?.workspace_root ?? null,
        binding?.owner_account_id ?? null,
        binding?.remote_workspace_id ?? null,
        row.base_remote_version_id,
        row.local_head_sha,
        row.error_message,
        row.created_at,
        row.updated_at
      );
      const saved = db
        .prepare(`SELECT * FROM workspace_sync_renderer_deliveries WHERE id = ?`)
        .get(row.id) as DeliveryRow;
      try {
        validateDelivery(db, saved);
      } catch (error) {
        db.prepare(
          `UPDATE workspace_sync_renderer_deliveries SET state = 'needs_attention',
          last_error_code = 'RENDERER_DELIVERY_INVALID', last_error_message = ? WHERE id = ?`
        ).run(error instanceof Error ? error.message : 'Renderer delivery is invalid.', row.id);
      }
      db.prepare(`DELETE FROM workspace_sync_queue WHERE id = ?`).run(row.id);
    }
  })();
}

export function workspaceSyncUploadBlockedSql(
  workspaceId: 'q.workspace_id' | 'b.workspace_id' | 'workspace_sync_bindings.workspace_id'
): string {
  return `(EXISTS (SELECT 1 FROM workspace_sync_renderer_deliveries delivery
    WHERE delivery.workspace_id = ${workspaceId} AND delivery.state <> 'succeeded')
    OR EXISTS (SELECT 1 FROM workspace_sync_queue recovery
      WHERE recovery.workspace_id = ${workspaceId} AND recovery.status = 'failed'
        AND recovery.error_code IN ('REPLICA_RECOVERY_REQUIRED', '${LEGACY_PENDING_CODE}', 'PACKAGE_RECOVERY_REQUIRED')))`;
}

export function readWorkspaceSyncRendererDeliveryStatus(
  db: Database.Database,
  workspaceId: number
): {
  pendingCount: number;
  errorCode: string | null;
  errorMessage: string | null;
} {
  const rows = db
    .prepare(
      `SELECT state, last_error_code, last_error_message
    FROM workspace_sync_renderer_deliveries WHERE workspace_id = ? AND state <> 'succeeded'
    ORDER BY (state = 'needs_attention') DESC, updated_at DESC, id`
    )
    .all(workspaceId) as DeliveryRow[];
  const problem = rows.find((row) => row.last_error_code !== null);
  return {
    pendingCount: rows.length,
    errorCode: problem?.last_error_code ?? null,
    errorMessage: problem?.last_error_message ?? null,
  };
}

export function throwIfWorkspaceSyncUploadBlocked(
  db: Database.Database,
  identity: { workspaceUuid: string } | { workspaceId: number }
): void {
  const binding = db
    .prepare(
      `SELECT workspace_id FROM workspace_sync_bindings
    WHERE workspace_uuid = @workspaceUuid OR workspace_id = @workspaceId`
    )
    .get({
      workspaceUuid: 'workspaceUuid' in identity ? identity.workspaceUuid : null,
      workspaceId: 'workspaceId' in identity ? identity.workspaceId : null,
    }) as { workspace_id: number } | undefined;
  if (!binding) return;
  if (readWorkspaceSyncRendererDeliveryStatus(db, binding.workspace_id).pendingCount > 0) {
    throw new Error(
      'RENDERER_REFRESH_PENDING: desktop state must finish refreshing before upload.'
    );
  }
  const row = db
    .prepare(
      `SELECT error_code, error_message FROM workspace_sync_queue
    WHERE workspace_id = ? AND status = 'failed'
      AND error_code IN ('REPLICA_RECOVERY_REQUIRED', ?, 'PACKAGE_RECOVERY_REQUIRED') LIMIT 1`
    )
    .get(binding.workspace_id, LEGACY_PENDING_CODE) as
    | { error_code: string; error_message: string | null }
    | undefined;
  if (row)
    throw new Error(
      `${row.error_code}: ${
        row.error_code === LEGACY_PENDING_CODE
          ? 'Desktop state must finish refreshing before upload.'
          : (row.error_message ?? 'Interrupted workspace recovery requires attention.')
      }`
    );
}

function parsePendingRefreshPayload(value: string | null): PendingRefreshPayload {
  if (!value) throw new Error('Pending renderer refresh payload is missing.');
  if (Buffer.byteLength(value, 'utf8') > MAX_PENDING_REFRESH_PAYLOAD_BYTES) {
    throw new Error('Pending renderer refresh payload exceeds its durable size limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Pending renderer refresh payload is unreadable.');
  }
  if (!isRecord(parsed) || parsed.version !== PENDING_REFRESH_PAYLOAD_VERSION) {
    throw new Error('Pending renderer refresh payload has an unsupported version.');
  }
  assertReplicaAppliedNotice(parsed.notice);
  return {
    version: PENDING_REFRESH_PAYLOAD_VERSION,
    notice: parsed.notice,
  };
}

function assertReplicaAppliedNotice(
  value: unknown
): asserts value is WorkspaceSyncReplicaAppliedNotice {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.workspaceUuid) ||
    !isNonEmptyString(value.workspaceRoot) ||
    !isNonEmptyString(value.remoteVersionId) ||
    !isStringArray(value.changedPaths) ||
    !isStringArray(value.deletedPaths) ||
    !isStringArray(value.affectedNotebookIds) ||
    !isStringArray(value.affectedDesignIds) ||
    !isStringArray(value.deletedDesignIds) ||
    (value.warnings !== undefined && !isStringArray(value.warnings))
  ) {
    throw new Error('Pending renderer refresh notice is invalid.');
  }
  const workspaceRoot = value.workspaceRoot;
  if (
    !isAbsolute(workspaceRoot) ||
    ![...value.changedPaths, ...value.deletedPaths].every((path) =>
      isAtOrUnder(path, workspaceRoot)
    )
  ) {
    throw new Error('Pending renderer refresh notice has an unsafe path.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAtOrUnder(candidate: string, root: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}
