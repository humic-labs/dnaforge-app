import type Database from 'better-sqlite3';
import { readWorkspaceSyncRendererDeliveryStatus } from './workspace-sync-renderer-refresh-pending';
import { isWorkspaceSyncReplicaApplying } from './workspace-sync-mutation-lease';
import { readWorkspaceSyncRecoveryCandidateIntent } from './workspace-sync-upload-snapshots';
import { WORKSPACE_SYNC_RECOVERY_RETENTION_MS } from './workspace-sync-recovery-candidate';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';

import {
  deriveWorkspaceSyncStatus,
  type WorkspaceScopedDirtyState,
  type WorkspaceSyncAutomaticMerge,
  type WorkspaceSyncExcludedSummary,
  type WorkspaceSyncInFlightPhase,
  type WorkspaceSyncStatus,
  type WorkspaceSyncStatusInput,
} from '../shared/cloud-sync-status';
import type {
  WorkspaceSyncReconcileResult,
  WorkspaceSyncStatusChangeReason,
  WorkspaceSyncStatusEvent,
} from '../shared/workspace-sync-ipc';
import {
  parseWorkspaceSyncExcludedSummary,
  UNKNOWN_WORKSPACE_SYNC_EXCLUSIONS,
} from './workspace-sync-exclusions';

export interface WorkspaceSyncStatusWorkspaceContext {
  workspaceId: number;
  workspaceUuid: string;
  name: string;
  path: string;
}

export interface WorkspaceSyncStatusDeps {
  getActiveAccountId?: () => string | null;
  getDirtyByWorkspace?: () => Readonly<Record<string, WorkspaceScopedDirtyState>>;
  getCurrentLocalHeadSha?: (workspace: WorkspaceSyncStatusWorkspaceContext) => string | null;
  getExcludedSummary?: (
    workspace: WorkspaceSyncStatusWorkspaceContext
  ) => WorkspaceSyncExcludedSummary | null;
  isOffline?: () => boolean;
  nowMs?: () => number;
}

export interface ReadWorkspaceSyncStatusInput extends WorkspaceSyncStatusDeps {
  workspaceUuid: string | null;
}

export type WorkspaceSyncStatusListener = (event: WorkspaceSyncStatusEvent) => void;

export interface WorkspaceSyncStatusPublisher {
  getStatus(workspaceUuid: string | null): WorkspaceSyncStatus;
  subscribe(workspaceUuid: string | null, listener: WorkspaceSyncStatusListener): () => void;
  invalidate(
    workspaceUuid: string | null,
    reason: WorkspaceSyncStatusChangeReason
  ): WorkspaceSyncStatus;
}

interface WorkspaceRow {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

interface BindingRow {
  owner_account_id: string;
  owner_org_id: string | null;
  remote_workspace_id: string | null;
  enabled: number;
  last_acked_local_head_sha: string | null;
  excluded_summary_json: string | null;
  access_role: string | null;
  access_source: string | null;
  shared_with_others: number | null;
  detached_reason: string | null;
}

interface QueueProblemRow {
  status: 'retry_wait' | 'failed';
  error_code: string | null;
  error_message: string | null;
}

interface RunningQueueRow {
  operation: string;
}

interface QueueSummary {
  queueDepth: number;
  inFlightPhase: WorkspaceSyncInFlightPhase | null;
  retryableBackoff: boolean;
  servicePaused: boolean;
  conflict: boolean;
  terminalErrorCode: string | null;
  terminalError: string | null;
}

const RETRYABLE_BACKOFF_CODES = new Set(['NETWORK', 'RATE_LIMITED', 'SERVER']);
const CONFLICT_CODES = new Set(['CONFLICT', 'SYNC_CONFLICT', 'IDEMPOTENCY_CONFLICT']);
const AUTOMATIC_MERGE_FAILURE_KEY = 'workspace_sync_automatic_merge_failure:';
const AUTOMATIC_MERGE_MESSAGE_MAX_CHARS = 1_000;

export function recordWorkspaceSyncAutomaticMergeResult(
  db: Database.Database,
  workspaceUuid: string,
  result: WorkspaceSyncReconcileResult,
  nowMs: number
): void {
  const key = `${AUTOMATIC_MERGE_FAILURE_KEY}${workspaceUuid}`;
  if (result.ok) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    JSON.stringify({
      message: result.message.slice(0, AUTOMATIC_MERGE_MESSAGE_MAX_CHARS),
      failedAt: new Date(nowMs).toISOString(),
    }),
    nowMs
  );
}

function readAutomaticMerge(
  db: Database.Database,
  workspaceId: number,
  workspaceUuid: string
): WorkspaceSyncAutomaticMerge | null {
  const failure = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`${AUTOMATIC_MERGE_FAILURE_KEY}${workspaceUuid}`) as { value: string } | undefined;
  const parsed = failure ? parseAutomaticMergeFailure(failure.value) : null;
  if (parsed) return { outcome: 'failed', ...parsed };
  const conflict = db
    .prepare(
      `SELECT id FROM workspace_sync_merge_conflicts
       WHERE workspace_id = ? AND status = 'open'
       ORDER BY created_at DESC, id
       LIMIT 1`
    )
    .get(workspaceId) as { id: string } | undefined;
  return conflict ? { outcome: 'conflicts', conflictId: conflict.id } : null;
}

function parseAutomaticMergeFailure(value: string): { message: string; failedAt: string } | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.message === 'string' && typeof parsed.failedAt === 'string'
      ? { message: parsed.message, failedAt: parsed.failedAt }
      : null;
  } catch {
    return null;
  }
}

export function readWorkspaceSyncStatus(
  db: Database.Database,
  input: ReadWorkspaceSyncStatusInput
): WorkspaceSyncStatus {
  const nowMs = input.nowMs?.() ?? Date.now();
  const workspace = input.workspaceUuid ? selectWorkspaceByUuid(db, input.workspaceUuid) : null;
  const workspaceContext = workspace ? toWorkspaceContext(workspace) : null;
  const binding = workspace ? selectBindingByWorkspaceId(db, workspace.id) : null;
  const queue = workspace ? readQueueSummary(db, workspace.id, nowMs) : emptyQueueSummary();
  const delivery = workspace ? readWorkspaceSyncRendererDeliveryStatus(db, workspace.id) : null;
  const activeAccountId = input.getActiveAccountId?.() ?? null;

  const statusInput: WorkspaceSyncStatusInput = {
    workspaceUuid: input.workspaceUuid,
    isManagedWorkspace: Boolean(workspace?.repo_uuid),
    syncEnabled: binding ? binding.enabled === 1 : false,
    archived: workspace?.archived_at !== null && workspace?.archived_at !== undefined,
    trashed: workspace?.trashed_at !== null && workspace?.trashed_at !== undefined,
    remoteWorkspaceId: binding?.remote_workspace_id ?? null,
    queueDepth: queue.queueDepth,
    rendererRefreshPending: (delivery?.pendingCount ?? 0) > 0,
    inFlightPhase:
      workspaceContext && isWorkspaceSyncReplicaApplying(workspaceContext.path)
        ? 'restoring'
        : queue.inFlightPhase,
    offline: Boolean(input.isOffline?.() ?? false) || queue.retryableBackoff,
    servicePaused: queue.servicePaused,
    authState: authStateFor(activeAccountId, binding),
    conflict: queue.conflict,
    terminalErrorCode: delivery?.errorCode ?? queue.terminalErrorCode,
    terminalError: delivery?.errorMessage ?? queue.terminalError,
    currentLocalHeadSha: workspaceContext
      ? (input.getCurrentLocalHeadSha?.(workspaceContext) ?? null)
      : null,
    latestAckedLocalHeadSha: binding?.last_acked_local_head_sha ?? null,
    accessRole: accessRoleFor(binding),
    accessSource: accessSourceFor(binding),
    shared: bindingIsShared(binding),
    detachedReason: binding?.detached_reason === 'access_removed' ? 'access_removed' : null,
    dirtyByWorkspace: input.getDirtyByWorkspace?.() ?? {},
    excludedSummary: workspaceContext
      ? input.getExcludedSummary
        ? input.getExcludedSummary(workspaceContext)
        : persistedExcludedSummary(binding)
      : null,
  };

  const status = deriveWorkspaceSyncStatus(statusInput);
  const automaticMerge =
    workspace && input.workspaceUuid && queue.conflict
      ? readAutomaticMerge(db, workspace.id, input.workspaceUuid)
      : null;
  if (automaticMerge) status.automaticMerge = automaticMerge;
  if (
    workspace &&
    binding &&
    binding.owner_account_id === activeAccountId &&
    status.bufferAxis === 'clean' &&
    statusInput.currentLocalHeadSha &&
    statusInput.currentLocalHeadSha !== binding.last_acked_local_head_sha
  ) {
    const row = db
      .prepare(
        `SELECT id FROM workspace_sync_queue WHERE workspace_id = ? AND operation = 'upload'
      AND local_head_sha = ? AND status IN ('pending', 'running', 'retry_wait', 'failed') ORDER BY created_at DESC LIMIT 1`
      )
      .get(workspace.id, statusInput.currentLocalHeadSha) as { id: string } | undefined;
    const intent = row ? readWorkspaceSyncRecoveryCandidateIntent(db, row.id) : null;
    const receipt = intent?.receipt;
    if (
      intent &&
      receipt &&
      intent.ownerAccountId === activeAccountId &&
      intent.remoteWorkspaceId === binding.remote_workspace_id &&
      intent.localHeadSha === statusInput.currentLocalHeadSha &&
      receipt.accountId === activeAccountId &&
      isWorkspaceSyncRemoteUuid(receipt.id) &&
      receipt.requestSha256 === intent.requestSha256 &&
      /^[a-f0-9]{64}$/u.test(receipt.contentSha256) &&
      (receipt.coverage === 'captured-bytes' || receipt.coverage === 'incomplete') &&
      Date.parse(receipt.expiresAt) > nowMs &&
      Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt) ===
        WORKSPACE_SYNC_RECOVERY_RETENTION_MS
    ) {
      status.recoveryCandidate = {
        ...(receipt.representation ? { representation: receipt.representation } : {}),
        candidateId: receipt.id,
        localHeadSha: intent.localHeadSha,
        contentSha256: receipt.contentSha256,
        coverage: receipt.coverage,
        createdAt: receipt.createdAt,
        expiresAt: receipt.expiresAt,
      };
    }
  }
  return status;
}

export function createWorkspaceSyncStatusPublisher(
  db: Database.Database,
  deps: WorkspaceSyncStatusDeps = {}
): WorkspaceSyncStatusPublisher {
  return new DefaultWorkspaceSyncStatusPublisher(db, deps);
}

class DefaultWorkspaceSyncStatusPublisher implements WorkspaceSyncStatusPublisher {
  private readonly listeners = new Map<string, Set<WorkspaceSyncStatusListener>>();
  private readonly snapshots = new Map<string, { hash: string; status: WorkspaceSyncStatus }>();
  private sequence = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly deps: WorkspaceSyncStatusDeps
  ) {}

  getStatus(workspaceUuid: string | null): WorkspaceSyncStatus {
    return readWorkspaceSyncStatus(this.db, { ...this.deps, workspaceUuid });
  }

  subscribe(workspaceUuid: string | null, listener: WorkspaceSyncStatusListener): () => void {
    const key = keyFor(workspaceUuid);
    const listeners = this.listeners.get(key) ?? new Set<WorkspaceSyncStatusListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);

    const status = this.getStatus(workspaceUuid);
    if (listeners.size === 1) {
      this.snapshots.set(key, { hash: hashStatus(status), status });
    }
    listener(this.createEvent(workspaceUuid, status, 'subscribe'));

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  invalidate(
    workspaceUuid: string | null,
    reason: WorkspaceSyncStatusChangeReason
  ): WorkspaceSyncStatus {
    const key = keyFor(workspaceUuid);
    const status = readWorkspaceSyncStatus(this.db, { ...this.deps, workspaceUuid });
    const hash = hashStatus(status);
    const previous = this.snapshots.get(key);
    this.snapshots.set(key, { hash, status });

    const listeners = this.listeners.get(key);
    if (!listeners || previous?.hash === hash) {
      return status;
    }

    const event = this.createEvent(workspaceUuid, status, reason);
    for (const listener of listeners) {
      listener(event);
    }
    return status;
  }

  private createEvent(
    workspaceUuid: string | null,
    status: WorkspaceSyncStatus,
    reason: WorkspaceSyncStatusChangeReason
  ): WorkspaceSyncStatusEvent {
    this.sequence += 1;
    return {
      workspaceUuid,
      status,
      reason,
      sequence: this.sequence,
      emittedAt: this.deps.nowMs?.() ?? Date.now(),
    };
  }
}

function selectWorkspaceByUuid(db: Database.Database, workspaceUuid: string): WorkspaceRow | null {
  const row = db
    .prepare(
      `SELECT id, name, path, repo_uuid, archived_at, trashed_at
       FROM workspaces
       WHERE repo_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceRow | undefined;
  return row ?? null;
}

function selectBindingByWorkspaceId(db: Database.Database, workspaceId: number): BindingRow | null {
  const row = db
    .prepare(
      `SELECT b.owner_account_id,
              b.owner_org_id,
              b.remote_workspace_id,
              b.enabled,
              b.last_acked_local_head_sha,
              v.excluded_summary_json,
              b.access_role,
              b.access_source,
              b.shared_with_others,
              b.detached_reason
       FROM workspace_sync_bindings b
       LEFT JOIN workspace_sync_versions v
         ON v.workspace_id = b.workspace_id
        AND v.is_latest = 1
        AND v.status = 'ready'
       WHERE b.workspace_id = ?
       LIMIT 1`
    )
    .get(workspaceId) as BindingRow | undefined;
  return row ?? null;
}

function persistedExcludedSummary(binding: BindingRow | null): WorkspaceSyncExcludedSummary | null {
  if (!binding?.last_acked_local_head_sha) return null;
  return (
    parseWorkspaceSyncExcludedSummary(binding.excluded_summary_json) ??
    UNKNOWN_WORKSPACE_SYNC_EXCLUSIONS
  );
}

function readQueueSummary(db: Database.Database, workspaceId: number, nowMs: number): QueueSummary {
  const activeRestoreLock = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_sync_restore_locks
         WHERE workspace_id = ?
           AND status = 'restoring'
           AND expires_at > ?`
      )
      .get(workspaceId, nowMs) as { count: number }
  ).count;

  const running = db
    .prepare(
      `SELECT operation
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND status = 'running'
       ORDER BY updated_at DESC, created_at DESC, id
       LIMIT 1`
    )
    .get(workspaceId) as RunningQueueRow | undefined;

  const queueDepth = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_sync_queue
         WHERE workspace_id = ?
           AND status IN ('pending', 'retry_wait', 'blocked')`
      )
      .get(workspaceId) as { count: number }
  ).count;

  const problem = db
    .prepare(
      `SELECT status, error_code, error_message
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND status IN ('retry_wait', 'failed')
         AND error_code IS NOT NULL
       ORDER BY updated_at DESC, created_at DESC, id
       LIMIT 1`
    )
    .get(workspaceId) as QueueProblemRow | undefined;

  const retryableBackoff =
    problem?.status === 'retry_wait' && RETRYABLE_BACKOFF_CODES.has(problem.error_code ?? '');
  const servicePaused =
    problem?.status === 'retry_wait' && problem.error_code === 'FEATURE_DISABLED';
  const conflict = problem?.status === 'failed' && CONFLICT_CODES.has(problem.error_code ?? '');
  const terminalError =
    problem?.status === 'failed' && !conflict
      ? (problem.error_message ?? problem.error_code ?? 'Sync failed.')
      : null;
  const terminalErrorCode = terminalError ? (problem?.error_code ?? null) : null;

  return {
    queueDepth,
    inFlightPhase:
      activeRestoreLock > 0
        ? 'restoring'
        : running
          ? phaseForRunningOperation(running.operation)
          : null,
    retryableBackoff,
    servicePaused,
    conflict,
    terminalErrorCode,
    terminalError,
  };
}

function emptyQueueSummary(): QueueSummary {
  return {
    queueDepth: 0,
    inFlightPhase: null,
    retryableBackoff: false,
    servicePaused: false,
    conflict: false,
    terminalErrorCode: null,
    terminalError: null,
  };
}

function accessRoleFor(binding: BindingRow | null): WorkspaceSyncStatusInput['accessRole'] {
  const role = binding?.access_role;
  if (role === 'viewer' || role === 'editor' || role === 'manager' || role === 'owner') return role;
  return binding ? 'owner' : null;
}

function accessSourceFor(binding: BindingRow | null): WorkspaceSyncStatusInput['accessSource'] {
  const source = binding?.access_source;
  if (
    source === 'owner' ||
    source === 'org_admin' ||
    source === 'direct' ||
    source === 'org_audience'
  ) {
    return source;
  }
  return binding ? 'owner' : null;
}

function bindingIsShared(binding: BindingRow | null): boolean {
  if (!binding) return false;
  if (binding.owner_org_id) return true;
  if (binding.shared_with_others === 1) return true;
  const source = binding.access_source;
  return source === 'direct' || source === 'org_audience' || source === 'org_admin';
}

function authStateFor(
  activeAccountId: string | null,
  binding: BindingRow | null
): WorkspaceSyncStatusInput['authState'] {
  if (!activeAccountId) return 'signed_out';
  if (binding && binding.owner_account_id !== activeAccountId) return 'signed_out';
  return 'ok';
}

function phaseForRunningOperation(operation: string): WorkspaceSyncInFlightPhase {
  return operation === 'restore' ? 'restoring' : 'uploading';
}

function toWorkspaceContext(row: WorkspaceRow): WorkspaceSyncStatusWorkspaceContext {
  return {
    workspaceId: row.id,
    workspaceUuid: row.repo_uuid ?? '',
    name: row.name,
    path: row.path,
  };
}

function keyFor(workspaceUuid: string | null): string {
  return workspaceUuid ?? '<null-workspace>';
}

function hashStatus(status: WorkspaceSyncStatus): string {
  return JSON.stringify(status);
}
