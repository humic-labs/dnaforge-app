import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { workspaceSyncUploadBlockedSql } from './workspace-sync-renderer-refresh-pending';

export type WorkspaceSyncQueueOperation =
  | 'claim'
  | 'upload'
  | 'refresh'
  | 'delete_remote'
  | 'share'
  | 'restore';

export type WorkspaceSyncQueueStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'canceled';

interface WorkspaceSyncQueueJobState {
  id: string;
  workspaceId: number;
  operation: WorkspaceSyncQueueOperation;
  status: WorkspaceSyncQueueStatus;
  idempotencyKey: string | null;
  baseRemoteVersionId: string | null;
  localHeadSha: string | null;
  bundleContentSha256: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  lockedAt: number | null;
  lockedByDeviceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceSyncQueueJob = WorkspaceSyncQueueJobState &
  (
    | { acceptedOperationId: string; acceptedOperationStartedAt: number }
    | { acceptedOperationId: null; acceptedOperationStartedAt: null }
  );

export interface EnqueueWorkspaceSyncJobInput {
  id: string;
  workspaceId: number;
  operation: WorkspaceSyncQueueOperation;
  idempotencyKey?: string | null;
  baseRemoteVersionId?: string | null;
  localHeadSha?: string | null;
  bundleContentSha256?: string | null;
  nowMs: number;
}

export interface WorkspaceSyncQueueClaimInput {
  activeAccountId: string | null;
  deviceId: string;
  nowMs: number;
  operation?: WorkspaceSyncQueueOperation;
  jobId?: string;
  excludedWorkspaceUuids?: readonly string[];
}

export interface WorkspaceSyncQueueRecoveryInput extends WorkspaceSyncQueueClaimInput {
  staleLockMs: number;
  reclaimCurrentDeviceLocksOnStartup?: boolean;
  excludedJobIds?: readonly string[];
}

export interface WorkspaceSyncQueueRecoveryResult {
  staleReclaimed: number;
  accountBlocked: number;
  accountUnblocked: number;
}

export interface MarkWorkspaceSyncJobFailedInput {
  id: string;
  expectedStatus?: WorkspaceSyncQueueStatus;
  expectedAcceptedOperationId?: string | null;
  expectedClaim?: {
    deviceId: string;
    lockedAt: number | null;
    attemptCount: number;
  };
  nowMs: number;
  retryable: boolean;
  retryDelayMs: number;
  maxAttempts: number;
  errorCode: string;
  errorMessage: string;
}

export const WORKSPACE_SYNC_TRANSIENT_RETRY_ERROR_CODES = new Set([
  'NETWORK',
  'SERVER',
  'RATE_LIMITED',
  'IN_PROGRESS',
  'FEATURE_DISABLED',
  'STALE_LOCK_RECLAIMED',
  'ACCOUNT_CHANGED',
]);

export interface RequeueWorkspaceSyncJobInput {
  id: string;
  nowMs: number;
  resetAttemptCount?: boolean;
}

export interface MarkWorkspaceSyncJobDoneInput {
  id: string;
  expectedStatus?: WorkspaceSyncQueueStatus;
  nowMs: number;
}

interface WorkspaceSyncQueueDbRow {
  id: string;
  workspace_id: number;
  operation: WorkspaceSyncQueueOperation;
  status: WorkspaceSyncQueueStatus;
  idempotency_key: string | null;
  base_remote_version_id: string | null;
  local_head_sha: string | null;
  bundle_content_sha256: string | null;
  attempt_count: number;
  next_attempt_at: number | null;
  locked_at: number | null;
  locked_by_device_id: string | null;
  error_code: string | null;
  error_message: string | null;
  accepted_operation_id: string | null;
  accepted_operation_started_at: number | null;
  created_at: number;
  updated_at: number;
}

export function enqueueWorkspaceSyncJob(
  db: Database.Database,
  input: EnqueueWorkspaceSyncJobInput
): WorkspaceSyncQueueJob {
  if (input.idempotencyKey) {
    const existing = selectJobByIdempotencyKey(db, input.idempotencyKey);
    if (existing) {
      if (
        input.operation === 'upload' &&
        existing.operation === 'upload' &&
        existing.status === 'canceled' &&
        existing.errorCode === 'SYNC_DISABLED'
      ) {
        db.prepare(
          `UPDATE workspace_sync_queue
           SET status = 'pending',
               next_attempt_at = @nowMs,
               locked_at = NULL,
               locked_by_device_id = NULL,
               error_code = NULL,
               error_message = NULL,
               updated_at = @nowMs
           WHERE id = @id
             AND status = 'canceled'
             AND error_code = 'SYNC_DISABLED'`
        ).run({ id: existing.id, nowMs: input.nowMs });
        return requireJob(db, existing.id);
      }
      return existing;
    }
  }

  db.prepare(
    `INSERT INTO workspace_sync_queue (
      id, workspace_id, operation, status, idempotency_key, base_remote_version_id,
      local_head_sha, bundle_content_sha256, attempt_count, accepted_operation_id,
      accepted_operation_started_at, created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @operation, 'pending', @idempotencyKey, @baseRemoteVersionId,
      @localHeadSha, @bundleContentSha256, 0, @acceptedOperationId,
      @acceptedOperationStartedAt, @nowMs, @nowMs
    )`
  ).run({
    id: input.id,
    workspaceId: input.workspaceId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey ?? null,
    baseRemoteVersionId: input.baseRemoteVersionId ?? null,
    localHeadSha: input.localHeadSha ?? null,
    bundleContentSha256: input.bundleContentSha256 ?? null,
    acceptedOperationId: input.operation === 'upload' ? randomUUID() : null,
    acceptedOperationStartedAt: input.operation === 'upload' ? input.nowMs : null,
    nowMs: input.nowMs,
  });

  return requireJob(db, input.id);
}

export function recoverWorkspaceSyncQueue(
  db: Database.Database,
  input: WorkspaceSyncQueueRecoveryInput
): WorkspaceSyncQueueRecoveryResult {
  const staleBefore = input.nowMs - input.staleLockMs;
  const excludedJobIds = input.excludedJobIds ?? [];
  const excludedJobParams = Object.fromEntries(
    excludedJobIds.map((jobId, index) => [`excludedJobId${index}`, jobId])
  );
  const excludedJobClause =
    excludedJobIds.length === 0
      ? ''
      : `AND id NOT IN (${excludedJobIds.map((_jobId, index) => `@excludedJobId${index}`).join(', ')})`;

  const staleReclaimed = db
    .prepare(
      `UPDATE workspace_sync_queue
       SET status = 'retry_wait',
           next_attempt_at = @nowMs,
           locked_at = NULL,
           locked_by_device_id = NULL,
           error_code = 'STALE_LOCK_RECLAIMED',
           error_message = 'Recovered stale running sync job during startup.',
           updated_at = @nowMs
       WHERE status = 'running'
         AND locked_at IS NOT NULL
         AND (locked_at <= @staleBefore OR (
           @reclaimCurrentDeviceLocksOnStartup = 1
           AND locked_by_device_id = @deviceId
           AND operation = 'upload'
         ))
         ${excludedJobClause}`
    )
    .run({
      nowMs: input.nowMs,
      staleBefore,
      deviceId: input.deviceId,
      reclaimCurrentDeviceLocksOnStartup: input.reclaimCurrentDeviceLocksOnStartup ? 1 : 0,
      ...excludedJobParams,
    }).changes;

  const accountBlocked = db
    .prepare(
      `UPDATE workspace_sync_queue
       SET status = 'blocked',
           locked_at = NULL,
           locked_by_device_id = NULL,
           error_code = 'ACCOUNT_PAUSED',
           error_message = 'Sync paused until the bound account is active.',
           updated_at = @nowMs
       WHERE id IN (
         SELECT q.id
         FROM workspace_sync_queue q
         JOIN workspace_sync_bindings b ON b.workspace_id = q.workspace_id
         WHERE q.status IN ('pending', 'retry_wait')
           AND (@activeAccountId IS NULL OR b.owner_account_id <> @activeAccountId)
       )`
    )
    .run({ activeAccountId: input.activeAccountId, nowMs: input.nowMs }).changes;

  const accountUnblocked =
    input.activeAccountId === null
      ? 0
      : db
          .prepare(
            `UPDATE workspace_sync_queue
             SET status = 'pending',
                 next_attempt_at = @nowMs,
                 error_code = NULL,
                 error_message = NULL,
                 updated_at = @nowMs
             WHERE id IN (
               SELECT q.id
               FROM workspace_sync_queue q
               JOIN workspace_sync_bindings b ON b.workspace_id = q.workspace_id
               WHERE q.status = 'blocked'
                 AND q.error_code = 'ACCOUNT_PAUSED'
                 AND b.owner_account_id = @activeAccountId
             )`
          )
          .run({ activeAccountId: input.activeAccountId, nowMs: input.nowMs }).changes;

  return { staleReclaimed, accountBlocked, accountUnblocked };
}

export function claimNextWorkspaceSyncJob(
  db: Database.Database,
  input: WorkspaceSyncQueueClaimInput
): WorkspaceSyncQueueJob | null {
  if (!input.activeAccountId) return null;

  const excludedWorkspaceUuids = input.excludedWorkspaceUuids ?? [];
  const excludedWorkspaceParams = Object.fromEntries(
    excludedWorkspaceUuids.map((workspaceUuid, index) => [
      `excludedWorkspaceUuid${index}`,
      workspaceUuid,
    ])
  );
  const excludedWorkspaceClause =
    excludedWorkspaceUuids.length === 0
      ? ''
      : `AND b.workspace_uuid NOT IN (${excludedWorkspaceUuids
          .map((_workspaceUuid, index) => `@excludedWorkspaceUuid${index}`)
          .join(', ')})`;

  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT q.*
         FROM workspace_sync_queue q
         JOIN workspace_sync_bindings b ON b.workspace_id = q.workspace_id
         LEFT JOIN workspace_sync_restore_locks rl
           ON rl.workspace_id = q.workspace_id
          AND rl.status = 'restoring'
          AND rl.expires_at > @nowMs
         WHERE q.status IN ('pending', 'retry_wait')
           AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= @nowMs)
           AND (@operation IS NULL OR q.operation = @operation)
           AND (@jobId IS NULL OR q.id = @jobId)
           AND b.enabled = 1
           AND b.owner_account_id = @activeAccountId
           ${excludedWorkspaceClause}
           AND rl.workspace_id IS NULL
           AND NOT ${workspaceSyncUploadBlockedSql('q.workspace_id')}
           AND (
             q.operation <> 'upload'
             OR NOT EXISTS (
               SELECT 1
               FROM workspace_sync_queue predecessor
               WHERE predecessor.workspace_id = q.workspace_id
                 AND predecessor.operation = 'upload'
                 AND predecessor.status IN ('pending', 'running', 'retry_wait', 'blocked')
                 AND (
                   predecessor.created_at < q.created_at
                   OR (predecessor.created_at = q.created_at AND predecessor.id < q.id)
                 )
             )
           )
         ORDER BY COALESCE(q.next_attempt_at, q.created_at), q.created_at, q.id
         LIMIT 1`
      )
      .get({
        activeAccountId: input.activeAccountId,
        deviceId: input.deviceId,
        nowMs: input.nowMs,
        operation: input.operation ?? null,
        jobId: input.jobId ?? null,
        ...excludedWorkspaceParams,
      }) as WorkspaceSyncQueueDbRow | undefined;

    if (!candidate) return null;

    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'running',
           attempt_count = attempt_count + 1,
           locked_at = @nowMs,
           locked_by_device_id = @deviceId,
           next_attempt_at = NULL,
           error_code = NULL,
           error_message = NULL,
           updated_at = @nowMs
       WHERE id = @id`
    ).run({ id: candidate.id, deviceId: input.deviceId, nowMs: input.nowMs });

    return requireJob(db, candidate.id);
  })();
}

export function getWorkspaceSyncQueueJob(db: Database.Database, id: string): WorkspaceSyncQueueJob {
  return requireJob(db, id);
}

export function markWorkspaceSyncJobSucceeded(
  db: Database.Database,
  input: MarkWorkspaceSyncJobDoneInput
): WorkspaceSyncQueueJob {
  const job = requireJob(db, input.id);
  const updated = db
    .prepare(
      `UPDATE workspace_sync_queue
     SET status = 'succeeded',
         next_attempt_at = NULL,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = NULL,
         error_message = NULL,
         updated_at = @nowMs
     WHERE id = @id
       AND status = @expectedStatus`
    )
    .run({ ...input, expectedStatus: input.expectedStatus ?? job.status });
  if (updated.changes !== 1) return requireJob(db, input.id);
  return requireJob(db, input.id);
}

export function markWorkspaceSyncJobFailed(
  db: Database.Database,
  input: MarkWorkspaceSyncJobFailedInput
): WorkspaceSyncQueueJob {
  const job = requireJob(db, input.id);
  const transient = WORKSPACE_SYNC_TRANSIENT_RETRY_ERROR_CODES.has(input.errorCode);
  const shouldRetry = input.retryable && (transient || job.attemptCount < input.maxAttempts);
  const updated = db
    .prepare(
      `UPDATE workspace_sync_queue
     SET status = @status,
         next_attempt_at = @nextAttemptAt,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = @errorCode,
         error_message = @errorMessage,
         updated_at = @nowMs
     WHERE id = @id
       AND status = @expectedStatus
       AND (@enforceAcceptedOperation = 0 OR accepted_operation_id IS @expectedAcceptedOperationId)
       AND (@enforceClaim = 0 OR (
         locked_by_device_id = @expectedDeviceId
         AND locked_at = @expectedLockedAt
         AND attempt_count = @expectedAttemptCount
       ))`
    )
    .run({
      id: input.id,
      expectedStatus: input.expectedStatus ?? job.status,
      enforceAcceptedOperation: 'expectedAcceptedOperationId' in input ? 1 : 0,
      expectedAcceptedOperationId: input.expectedAcceptedOperationId ?? null,
      enforceClaim: input.expectedClaim ? 1 : 0,
      expectedDeviceId: input.expectedClaim?.deviceId ?? null,
      expectedLockedAt: input.expectedClaim?.lockedAt ?? null,
      expectedAttemptCount: input.expectedClaim?.attemptCount ?? null,
      status: shouldRetry ? 'retry_wait' : 'failed',
      nextAttemptAt: shouldRetry ? input.nowMs + input.retryDelayMs : null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      nowMs: input.nowMs,
    });
  if (updated.changes !== 1) return requireJob(db, input.id);
  return requireJob(db, input.id);
}

export function requeueWorkspaceSyncJob(
  db: Database.Database,
  input: RequeueWorkspaceSyncJobInput
): WorkspaceSyncQueueJob {
  requireJob(db, input.id);
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'pending',
         next_attempt_at = @nowMs,
         locked_at = NULL,
         locked_by_device_id = NULL,
         attempt_count = CASE WHEN @resetAttemptCount = 1 THEN 0 ELSE attempt_count END,
         accepted_operation_id = CASE WHEN operation = 'upload' AND status = 'failed' THEN @acceptedOperationId ELSE accepted_operation_id END,
         accepted_operation_started_at = CASE WHEN operation = 'upload' AND status = 'failed' THEN @nowMs ELSE accepted_operation_started_at END,
         error_code = NULL,
         error_message = NULL,
         updated_at = @nowMs
     WHERE id = @id
       AND status IN ('retry_wait', 'failed')`
  ).run({
    id: input.id,
    nowMs: input.nowMs,
    resetAttemptCount: input.resetAttemptCount ? 1 : 0,
    acceptedOperationId: randomUUID(),
  });
  return requireJob(db, input.id);
}

export function resumeAccountPausedWorkspaceSyncJob(
  db: Database.Database,
  input: { id: string; activeAccountId: string; nowMs: number }
): WorkspaceSyncQueueJob {
  requireJob(db, input.id);
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'pending',
         next_attempt_at = @nowMs,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = NULL,
         error_message = NULL,
         updated_at = @nowMs
     WHERE id = @id
       AND status = 'blocked'
       AND error_code = 'ACCOUNT_PAUSED'
       AND workspace_id IN (
         SELECT workspace_id
         FROM workspace_sync_bindings
         WHERE owner_account_id = @activeAccountId
       )`
  ).run(input);
  return requireJob(db, input.id);
}

export function isForceRetryableWorkspaceSyncFailure(job: WorkspaceSyncQueueJob): boolean {
  if (job.status !== 'failed' && job.status !== 'retry_wait') return false;
  const code = job.errorCode ?? '';
  if (!code) return job.status === 'retry_wait';
  if (WORKSPACE_SYNC_TRANSIENT_RETRY_ERROR_CODES.has(code)) return true;
  if (code === 'DURABLE_UPLOAD_INVALID') return true;
  if (code === 'VALIDATION' || code === 'QUOTA_EXCEEDED') return true;
  return false;
}

function selectJobByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string
): WorkspaceSyncQueueJob | null {
  const row = db
    .prepare(`SELECT * FROM workspace_sync_queue WHERE idempotency_key = ? LIMIT 1`)
    .get(idempotencyKey) as WorkspaceSyncQueueDbRow | undefined;
  return row ? toWorkspaceSyncQueueJob(row) : null;
}

function requireJob(db: Database.Database, id: string): WorkspaceSyncQueueJob {
  const row = db.prepare(`SELECT * FROM workspace_sync_queue WHERE id = ? LIMIT 1`).get(id) as
    | WorkspaceSyncQueueDbRow
    | undefined;
  if (!row) throw new Error(`workspace sync queue job not found: ${id}`);
  return toWorkspaceSyncQueueJob(row);
}

function toWorkspaceSyncQueueJob(row: WorkspaceSyncQueueDbRow): WorkspaceSyncQueueJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    operation: row.operation,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    baseRemoteVersionId: row.base_remote_version_id,
    localHeadSha: row.local_head_sha,
    bundleContentSha256: row.bundle_content_sha256,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at,
    lockedByDeviceId: row.locked_by_device_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.accepted_operation_id === 'string' &&
    typeof row.accepted_operation_started_at === 'number'
      ? {
          acceptedOperationId: row.accepted_operation_id,
          acceptedOperationStartedAt: row.accepted_operation_started_at,
        }
      : { acceptedOperationId: null, acceptedOperationStartedAt: null }),
  };
}
