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
  if (code === 'DURABLE_UPLOAD_INVALID' || code === 'BLOB_UPLOAD_FAILED') return true;
  if (code === 'VALIDATION' || code === 'QUOTA_EXCEEDED') return true;
  return false;
}

export function cancelWorkspaceSyncUploadsBeforeStart(
  db: Database.Database,
  workspaceId: number,
  nowMs: number
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'canceled',
         locked_at = NULL,
         locked_by_device_id = NULL,
         next_attempt_at = NULL,
         error_code = 'SYNC_DISABLED',
         error_message = 'Auto sync was turned off before this upload ran.',
         updated_at = ?
     WHERE workspace_id = ?
       AND operation = 'upload'
       AND status IN ('pending', 'blocked')`
  ).run(nowMs, workspaceId);
}

export function settleWorkspaceSyncPullFailures(
  db: Database.Database,
  workspaceId: number,
  nowMs: number
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'succeeded',
         next_attempt_at = NULL,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = NULL,
         error_message = NULL,
         updated_at = ?
     WHERE workspace_id = ?
       AND operation = 'refresh'
       AND idempotency_key LIKE 'pull-error:%'
       AND status IN ('pending', 'running', 'retry_wait', 'blocked', 'failed')`
  ).run(nowMs, workspaceId);
}

export function settleWorkspaceSyncReplicaRecovery(
  db: Database.Database,
  activeQuarantineWorkspaceIds: ReadonlySet<number>,
  nowMs: number
): string[] {
  const candidates = db
    .prepare(
      `SELECT DISTINCT recovery.workspace_id, binding.workspace_uuid
       FROM workspace_sync_queue recovery
       JOIN workspace_sync_bindings binding ON binding.workspace_id = recovery.workspace_id
       WHERE recovery.error_code = 'REPLICA_RECOVERY_REQUIRED'
         AND recovery.status = 'failed'`
    )
    .all() as Array<{ workspace_id: number; workspace_uuid: string }>;
  const settle = db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'succeeded',
         next_attempt_at = NULL,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = NULL,
         error_message = NULL,
         updated_at = ?
     WHERE workspace_id = ?
       AND error_code = 'REPLICA_RECOVERY_REQUIRED'
       AND status = 'failed'`
  );
  return db.transaction(() => {
    const recoveredWorkspaceUuids: string[] = [];
    for (const candidate of candidates) {
      if (activeQuarantineWorkspaceIds.has(candidate.workspace_id)) continue;
      const result = settle.run(nowMs, candidate.workspace_id);
      if (result.changes > 0) recoveredWorkspaceUuids.push(candidate.workspace_uuid);
    }
    return recoveredWorkspaceUuids;
  })();
}

export function cancelReconciledWorkspaceSyncConflicts(
  db: Database.Database,
  workspaceId: number,
  at: number,
  code: 'CONFLICT_RESOLVED_MERGED' | 'CONFLICT_RESOLVED_NO_REMOTE_CHANGE'
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'canceled', error_code = ?, updated_at = ?
     WHERE workspace_id = ?
       AND status = 'failed'
       AND error_code IN ('CONFLICT', 'SYNC_CONFLICT')`
  ).run(code, at, workspaceId);
}

export interface WorkspaceSyncConflictSnapshot {
  id: string;
  error_code: 'CONFLICT' | 'SYNC_CONFLICT';
  error_message: string | null;
}

export function selectResolvableWorkspaceSyncConflicts(
  db: Database.Database,
  workspaceId: number
): WorkspaceSyncConflictSnapshot[] {
  return db
    .prepare(
      `SELECT id, error_code, error_message
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND status = 'failed'
         AND error_code IN ('CONFLICT', 'SYNC_CONFLICT')
       ORDER BY updated_at DESC, created_at DESC, id`
    )
    .all(workspaceId) as WorkspaceSyncConflictSnapshot[];
}

export function cancelResolvedWorkspaceSyncConflicts(
  db: Database.Database,
  jobs: readonly WorkspaceSyncConflictSnapshot[],
  code: 'CONFLICT_RESOLVED_KEEP_LOCAL' | 'CONFLICT_RESOLVED_USE_REMOTE',
  nowMs: number
): void {
  const update = db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'canceled',
         next_attempt_at = NULL,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = ?,
         error_message = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'failed'
       AND error_code IS ?
       AND error_message IS ?`
  );
  for (const job of jobs) {
    const changed = update.run(
      code,
      'Sync conflict was resolved by explicit user action.',
      nowMs,
      job.id,
      job.error_code,
      job.error_message
    ).changes;
    if (changed !== 1) {
      throw new Error('The pending sync conflict changed before resolution could commit.');
    }
  }
}

export function attachRunningWorkspaceSyncSnapshot(
  db: Database.Database,
  input: { id: string; localHeadSha: string | null; bundleContentSha256: string; nowMs: number }
): void {
  const updated = db
    .prepare(
      `UPDATE workspace_sync_queue
       SET local_head_sha = COALESCE(local_head_sha, @localHeadSha),
           bundle_content_sha256 = COALESCE(bundle_content_sha256, @bundleContentSha256),
           updated_at = @nowMs
       WHERE id = @id
         AND status = 'running'
         AND (local_head_sha IS NULL OR local_head_sha IS @localHeadSha)
         AND (bundle_content_sha256 IS NULL OR bundle_content_sha256 = @bundleContentSha256)`
    )
    .run(input);
  if (updated.changes !== 1) {
    throw Object.assign(
      new Error(`Workspace sync job ${input.id} no longer names the captured upload bytes.`),
      { code: 'DURABLE_UPLOAD_INVALID', retryable: false }
    );
  }
}

export const WORKSPACE_SYNC_ACCESS_REMOVED_CODE = 'ACCESS_REMOVED';

export function blockWorkspaceSyncJobsAfterAccessRemoval(
  db: Database.Database,
  input: { workspaceId: number; nowMs: number; reason?: string }
): void {
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
}

export function cancelWorkspaceSyncJobsForDeletedCloudCopy(
  db: Database.Database,
  input: { workspaceId: number; nowMs: number }
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
       SET status = 'canceled',
           next_attempt_at = NULL,
           locked_at = NULL,
           locked_by_device_id = NULL,
           error_code = 'CLOUD_COPY_DELETED',
           error_message = 'Cloud copy was deleted.',
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND status IN ('pending', 'running', 'retry_wait', 'blocked')`
  ).run(input);
}

export function cancelWorkspaceSyncJobsForReplacedReplica(
  db: Database.Database,
  input: { workspaceId: number; nowMs: number }
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'canceled',
         next_attempt_at = NULL,
         locked_at = NULL,
         locked_by_device_id = NULL,
         error_code = 'LOCAL_REPLICA_REPLACED',
         error_message = 'Missing local replica was replaced from its cloud copy.',
         updated_at = @nowMs
     WHERE workspace_id = @workspaceId
       AND status IN ('pending', 'running', 'retry_wait', 'blocked', 'failed')`
  ).run(input);
}

export function recordWorkspaceSyncUploadCaptureIdentity(
  db: Database.Database,
  input: { jobId: string; idempotencyKey: string; contentSha256: string; nowMs: number }
): void {
  const updated = db
    .prepare(
      `UPDATE workspace_sync_queue
             SET idempotency_key = @idempotencyKey,
                 bundle_content_sha256 = @contentSha256,
                 updated_at = @nowMs
             WHERE id = @jobId
               AND status = 'running'`
    )
    .run({
      jobId: input.jobId,
      idempotencyKey: input.idempotencyKey,
      contentSha256: input.contentSha256,
      nowMs: input.nowMs,
    });
  if (updated.changes !== 1) {
    throw new Error(`Workspace sync job ${input.jobId} changed before snapshot persistence.`);
  }
}

export function acknowledgeWorkspaceSyncUpload(
  db: Database.Database,
  input: {
    job: Pick<WorkspaceSyncQueueJob, 'id' | 'lockedAt' | 'attemptCount' | 'acceptedOperationId'>;
    deviceId: string;
    nowMs: number;
  }
): void {
  const terminalUpdate = db
    .prepare(
      `UPDATE workspace_sync_queue
         SET status = 'succeeded',
             next_attempt_at = NULL,
             locked_at = NULL,
             locked_by_device_id = NULL,
             error_code = NULL,
             error_message = NULL,
             updated_at = @nowMs
         WHERE id = @jobId
           AND status = 'running'
           AND locked_by_device_id = @deviceId
           AND locked_at = @lockedAt
           AND attempt_count = @attemptCount
           AND accepted_operation_id IS @acceptedOperationId`
    )
    .run({
      jobId: input.job.id,
      deviceId: input.deviceId,
      lockedAt: input.job.lockedAt,
      attemptCount: input.job.attemptCount,
      acceptedOperationId: input.job.acceptedOperationId,
      nowMs: input.nowMs,
    });
  if (terminalUpdate.changes !== 1) {
    throw Object.assign(new Error('Workspace sync upload lease changed before acknowledgement.'), {
      code: 'STALE_UPLOAD_RESULT',
      retryable: false,
    });
  }
}

export function supersedeWorkspaceSyncUploadFailures(
  db: Database.Database,
  input: { workspaceId: number; completedJobId: string; nowMs: number }
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
       SET status = 'canceled',
           next_attempt_at = NULL,
           locked_at = NULL,
           locked_by_device_id = NULL,
           error_code = 'SUPERSEDED_BY_UPLOAD_SUCCESS',
           error_message = 'A newer upload completed successfully.',
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND operation = 'upload'
         AND (
           status = 'failed'
           OR (status = 'canceled' AND error_code = 'SYNC_DISABLED')
         )
         AND id <> @jobId`
  ).run({ workspaceId: input.workspaceId, jobId: input.completedJobId, nowMs: input.nowMs });
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
