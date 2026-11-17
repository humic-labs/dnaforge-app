import {
  assertWorkspaceSyncSelectionActive,
  ensureWorkspaceSyncAcceptedPaths,
} from './workspace-sync-membership';
import {
  workspaceSyncUploadBlockedSql,
  throwIfWorkspaceSyncUploadBlocked,
} from './workspace-sync-renderer-refresh-pending';
import { createHash, randomUUID } from 'node:crypto';
import { withActiveFilesystemWork } from './active-filesystem-work';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { forEachSyncFileBounded } from './workspace-sync-transfer-pool';
import { recordWorkspaceSyncReplicaFiles } from './workspace-sync-replica-files';
import {
  DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES,
  DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES,
  WORKSPACE_SYNC_MANIFEST_READ_LIMITS,
  parseWorkspaceSyncManifest,
  resolveWorkspaceSyncBundleLimits,
  resolveWorkspaceSyncEncodedBundleMaxBytes,
  validateWorkspaceSyncUploadAdmission,
  workspaceSyncManifestHashInput,
  workspaceSyncUploadWireBytes,
  type WorkspaceSyncBundle,
  workspaceSyncStoragePolicyLimits,
  type WorkspaceSyncStoragePolicy,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';

import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import type { WorkspaceSyncExcludedSummary as StatusExcludedSummary } from '../shared/cloud-sync-status';
import {
  readWorkspaceSyncStoragePolicy,
  readWorkspaceSyncCapturePolicy,
} from './workspace-sync-storage-policy';
import {
  parseWorkspaceSyncDirectUpload,
  uploadWorkspaceSyncFileDirect,
} from './workspace-sync-direct-upload';
import {
  recordWorkspaceSyncUploadCaptureIdentity,
  acknowledgeWorkspaceSyncUpload,
  supersedeWorkspaceSyncUploadFailures,
  attachRunningWorkspaceSyncSnapshot,
  claimNextWorkspaceSyncJob,
  enqueueWorkspaceSyncJob,
  getWorkspaceSyncQueueJob,
  isForceRetryableWorkspaceSyncFailure,
  markWorkspaceSyncJobFailed,
  requeueWorkspaceSyncJob,
  resumeAccountPausedWorkspaceSyncJob,
  type WorkspaceSyncQueueJob,
} from './workspace-sync-queue';
import {
  assertWorkspaceSyncSnapshotMatchesCommit,
  assertWorkspaceSyncUploadCaptureMatchesCommit,
  buildWorkspaceSyncSnapshot,
  buildWorkspaceSyncUploadCapture,
  buildWorkspaceSyncRecoveryCapture,
  previewWorkspaceSyncUploadWithHeldMutationLease,
  WorkspaceSyncSnapshotError,
  type WorkspaceSyncSnapshot,
  type WorkspaceSyncUploadCapture,
  type WorkspaceSyncUploadSnapshot,
} from './workspace-sync-snapshotter';
import { serializeWorkspaceSyncExcludedSummary } from './workspace-sync-exclusions';
import { prepareWorkspaceSyncProjection } from './workspace-sync-projection';
import {
  assertScientificCloudTransferSupported,
  hasScientificCloudHistoryBinding,
} from './scientific-cloud-admission';
import {
  parseScientificCloudHistory,
  type ScientificCloudHistoryV1,
} from '@waypoint/scientific-objects';
import {
  parseWorkspaceSyncScientificHistoryMetadata,
  parseScientificCloudResourceIdentities,
  workspaceSyncScientificContentSha256,
  type WorkspaceSyncScientificHistoryMetadata,
} from './workspace-sync-scientific-history';
import { recoverNativeCatalogRecordPublications } from './native-catalog-record-mutations';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { isAccessRemovedError, markWorkspaceSyncAccessRemoved } from './workspace-sync-access';
import { hasWorkspaceSyncWorkingChanges } from './workspace-sync-git-state';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  acceptWorkspaceSyncUploadTelemetry,
  readWorkspaceSyncUploadTelemetryOperation,
  settleWorkspaceSyncUploadTelemetry,
  publishWorkspaceSyncUploadTelemetry,
} from './workspace-sync-upload-telemetry';
import {
  acceptWorkspaceSyncRecoveryTelemetry,
  publishWorkspaceSyncRecoveryTelemetry,
  settleWorkspaceSyncRecoveryTelemetry,
} from './workspace-sync-recovery-telemetry';
import { createManifestWorkspaceSyncVersion } from './workspace-sync-manifest-upload';
import {
  retainWorkspaceSyncRecoveryCandidate,
  validateWorkspaceSyncRecoveryCandidateReceipt,
  workspaceSyncRecoveryCandidateRequest,
  type WorkspaceSyncRecoveryCandidateIntent,
  type WorkspaceSyncRecoveryCandidateReceipt,
} from './workspace-sync-recovery-candidate';
import {
  deleteWorkspaceSyncUploadSnapshot,
  deleteWorkspaceSyncUploadSnapshotsForWorkspace,
  readWorkspaceSyncUploadSnapshot,
  readWorkspaceSyncUploadCapture,
  recordWorkspaceSyncUploadSnapshot,
  recordWorkspaceSyncUploadCapture,
  ensureWorkspaceSyncRecoveryCandidateIntent,
  recordWorkspaceSyncRecoveryCandidateReceipt,
  readWorkspaceSyncRecoveryCandidateIntent,
  removeAbandonedWorkspaceSyncUploadCaptures,
  workspaceSyncUploadSnapshotDirectory,
  type WorkspaceSyncUploadSnapshotStorageOptions,
} from './workspace-sync-upload-snapshots';

export interface WorkspaceSyncUploadVersionResponse {
  status: 'ready' | 'unchanged' | 'in_progress';
  workspaceId: string;
  version?: {
    id: string;
    versionNumber: number;
    contentSha256: string;
    sizeBytes: number;
    fileCount: number;
    representation?: 'bundle_v1' | 'manifest_v1' | 'scientific_manifest_v1';
    fileManifestSha256?: string;
    createdAt?: string;
    finalizedAt?: string;
  };
  scientificHistory?: ScientificCloudHistoryV1;
  scientificBlobRefs?: WorkspaceSyncUploadCapture['scientificBlobRefs'];
  manifest?: WorkspaceSyncManifestV1;
  resourceIdentities?: { path: string; resourceId: string }[];
  versionId?: string;
  leaseExpiresAt?: string | null;
}

export interface WorkspaceSyncUploadRequest extends WorkspaceSyncScientificHistoryMetadata {
  remoteWorkspaceId: string;

  ownerAccountId: string;
  idempotencyKey: string;
  baseVersionId: string | null;
  fileSelectionVersion?: 0 | 1;
  bundle?: WorkspaceSyncBundle;

  manifest?: WorkspaceSyncManifestV1;

  excludedSummary?: StatusExcludedSummary;

  fileSources?: ReadonlyMap<string, string>;
  scientificBlobSources?: ReadonlyMap<string, string>;

  resumeStatePath?: string;

  recoveryCandidateIntent?: WorkspaceSyncRecoveryCandidateIntent;
  onRecoveryCandidateRetained?: (receipt: WorkspaceSyncRecoveryCandidateReceipt) => Promise<void>;
  recoveryOnly?: WorkspaceSyncUploadCapture['recoveryOnly'];
}

export interface WorkspaceSyncUploadClient {
  readVersionPaths?: (
    remoteWorkspaceId: string,
    versionId: string,
    ownerAccountId: string,
    signal?: AbortSignal
  ) => Promise<string[]>;
  readStoragePolicy?: (
    remoteWorkspaceId: string,
    ownerAccountId: string,
    signal?: AbortSignal
  ) => Promise<WorkspaceSyncStoragePolicy>;

  readonly supportsManifest?: boolean;
  readonly supportsScientificHistory?: boolean;
  createVersion(
    request: WorkspaceSyncUploadRequest,
    signal?: AbortSignal
  ): Promise<WorkspaceSyncUploadVersionResponse>;
}

export interface WorkspaceSyncUploadWorkspaceContext {
  workspaceId: number;
  workspaceUuid: string;
  repoPath: string;
  remoteWorkspaceId: string;
  remoteLatestVersionId: string | null;
}

export interface WorkspaceSyncUploadWorkerDeps {
  deviceId: string;
  appVersion: string;
  getActiveAccountId: () => string | null | Promise<string | null>;
  getCurrentLocalHeadSha: (
    workspace: WorkspaceSyncUploadWorkspaceContext
  ) => string | null | Promise<string | null>;

  commitWorkingTreeIfDirty?: (
    repoPath: string,
    options?: { forceInclude?: readonly string[] }
  ) => Promise<string | null>;
  snapshotWorkspace?: (workspaceUuid: string) => Promise<WorkspaceSyncSnapshot>;
  snapshotUploadWorkspace?: (workspaceUuid: string) => Promise<WorkspaceSyncUploadCapture>;
  verifySnapshotMatchesCommit?: (
    snapshot: WorkspaceSyncSnapshot,
    commitOid: string
  ) => Promise<void>;
  verifyUploadCaptureMatchesCommit?: (
    snapshot: WorkspaceSyncUploadCapture,
    commitOid: string
  ) => Promise<void>;
  hasWorkingTreeChanges?: (repoPath: string) => boolean | Promise<boolean>;
  client?: WorkspaceSyncUploadClient;
  uploadSnapshotRoot?: WorkspaceSyncUploadSnapshotStorageOptions['root'];
  nowMs?: () => number;
  debounceMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxAttempts?: number;
  createJobId?: () => string;
  setDebounceTimer?: (callback: () => void | Promise<void>, ms: number) => unknown;

  deferAutomaticUpload?: (workspaceUuid: string) => boolean;
  clearDebounceTimer?: (handle: unknown) => void;
  onRunCompleted?: (result: Exclude<WorkspaceSyncUploadRunResult, { status: 'idle' }>) => void;
}

export type WorkspaceSyncUploadRunResult =
  | { status: 'idle' }
  | { status: 'uploaded'; job: WorkspaceSyncQueueJob; response: WorkspaceSyncUploadVersionResponse }
  | { status: 'retry_wait' | 'failed'; job: WorkspaceSyncQueueJob; errorCode: string };

interface WorkspaceBindingRow {
  workspace_id: number;
  workspace_uuid: string;
  workspace_path: string;
  remote_workspace_id: string | null;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  remote_latest_content_sha256: string | null;
  last_acked_local_head_sha: string | null;
  owner_account_id: string;

  access_role: string | null;
  access_source: string | null;
}

const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export class WorkspaceSyncUploadWorker {
  private readonly timers = new Map<string, unknown>();
  private readonly activeFlushCounts = new Map<string, number>();
  private readonly activeFlushes = new Map<Promise<WorkspaceSyncUploadRunResult>, string>();
  private readonly remotePullLeases = new Set<string>();
  private readonly deferredChangesDuringPull = new Set<string>();
  private readonly deferredChangesDuringUpload = new Set<string>();
  private readonly activeUploadWorkspaces = new Set<string>();
  private readonly activeUploadJobIds = new Set<string>();
  private readonly activeUploadRunsByJobId = new Map<
    string,
    Promise<WorkspaceSyncUploadRunResult>
  >();
  private readonly activeRequestControllers = new Set<AbortController>();
  private readonly pausedWorkspaces = new Set<string>();
  private stopping = false;

  constructor(
    private readonly db: Database.Database,
    private readonly deps: WorkspaceSyncUploadWorkerDeps
  ) {
    removeAbandonedWorkspaceSyncUploadCaptures(deps.uploadSnapshotRoot);
  }

  beginStopping(): void {
    this.stopping = true;
    for (const timer of this.timers.values()) {
      this.clearDebounceTimer(timer);
    }
    this.timers.clear();
    this.deferredChangesDuringPull.clear();
    this.deferredChangesDuringUpload.clear();
    this.pausedWorkspaces.clear();
    for (const controller of this.activeRequestControllers) controller.abort();
  }

  async stopAndWaitForIdle(): Promise<void> {
    this.beginStopping();
    await this.waitForIdle();
    this.activeFlushCounts.clear();
    this.remotePullLeases.clear();
  }

  async waitForIdle(workspaceUuid?: string): Promise<void> {
    let active = this.activeFlushPromises(workspaceUuid);
    while (active.length > 0) {
      await Promise.allSettled(active);
      active = this.activeFlushPromises(workspaceUuid);
    }
  }

  private activeFlushPromises(workspaceUuid?: string): Promise<WorkspaceSyncUploadRunResult>[] {
    return [...this.activeFlushes.entries()]
      .filter(([, activeWorkspaceUuid]) =>
        workspaceUuid ? activeWorkspaceUuid === workspaceUuid : true
      )
      .map(([promise]) => promise);
  }

  pauseWorkspace(workspaceUuid: string): void {
    this.pausedWorkspaces.add(workspaceUuid);
    const timer = this.timers.get(workspaceUuid);
    if (timer) {
      this.clearDebounceTimer(timer);
      this.timers.delete(workspaceUuid);
    }
    this.deferredChangesDuringPull.delete(workspaceUuid);
    this.deferredChangesDuringUpload.delete(workspaceUuid);
  }

  resumeWorkspace(workspaceUuid: string): void {
    this.pausedWorkspaces.delete(workspaceUuid);
  }

  getActiveUploadJobIds(): readonly string[] {
    return [...this.activeUploadJobIds];
  }

  beginRemotePull(workspaceUuid: string): boolean {
    if (
      this.stopping ||
      this.pausedWorkspaces.has(workspaceUuid) ||
      this.remotePullLeases.has(workspaceUuid) ||
      this.activeUploadWorkspaces.has(workspaceUuid) ||
      (this.activeFlushCounts.get(workspaceUuid) ?? 0) > 0 ||
      this.timers.has(workspaceUuid)
    ) {
      return false;
    }
    this.remotePullLeases.add(workspaceUuid);
    return true;
  }

  endRemotePull(workspaceUuid: string): void {
    if (!this.remotePullLeases.delete(workspaceUuid)) return;
    if (
      this.deferredChangesDuringPull.delete(workspaceUuid) &&
      isWorkspaceSyncBindingEnabled(this.db, workspaceUuid)
    ) {
      this.scheduleWorkspaceChanged(workspaceUuid);
    }
  }

  scheduleWorkspaceChanged(workspaceUuid: string): void {
    if (this.stopping) return;
    if (this.pausedWorkspaces.has(workspaceUuid)) return;
    if (!isWorkspaceSyncBindingEnabled(this.db, workspaceUuid)) return;
    if (this.remotePullLeases.has(workspaceUuid)) {
      this.deferredChangesDuringPull.add(workspaceUuid);
      return;
    }
    if (
      this.activeUploadWorkspaces.has(workspaceUuid) ||
      (this.activeFlushCounts.get(workspaceUuid) ?? 0) > 0
    ) {
      this.deferredChangesDuringUpload.add(workspaceUuid);
      return;
    }
    const existing = this.timers.get(workspaceUuid);
    if (existing) this.clearDebounceTimer(existing);

    const timer = this.setDebounceTimer(async () => {
      this.timers.delete(workspaceUuid);
      if (this.deps.deferAutomaticUpload?.(workspaceUuid)) return;
      await this.flushWorkspace(workspaceUuid).catch((error: unknown) => {
        console.warn(
          `[WorkspaceSyncUploadWorker] Debounced upload failed for ${workspaceUuid}:`,
          error instanceof Error ? error.message : String(error)
        );
      });
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timers.set(workspaceUuid, timer);
  }

  flushWorkspace(
    workspaceUuid: string,
    options: { force?: boolean } = {}
  ): Promise<WorkspaceSyncUploadRunResult> {
    if (this.stopping) return Promise.resolve({ status: 'idle' });
    if (this.pausedWorkspaces.has(workspaceUuid)) return Promise.resolve({ status: 'idle' });
    if (this.remotePullLeases.has(workspaceUuid)) {
      this.deferredChangesDuringPull.add(workspaceUuid);
      return Promise.resolve({ status: 'idle' });
    }

    const existing = [...this.activeFlushes.entries()].find(
      ([, activeWorkspaceUuid]) => activeWorkspaceUuid === workspaceUuid
    )?.[0];
    if (existing) return existing;

    const flush = withActiveFilesystemWork(() => this.runFlushWorkspace(workspaceUuid, options));
    this.activeFlushes.set(flush, workspaceUuid);
    void flush.then(
      () => this.activeFlushes.delete(flush),
      () => this.activeFlushes.delete(flush)
    );
    return flush;
  }

  private async runFlushWorkspace(
    workspaceUuid: string,
    options: { force?: boolean }
  ): Promise<WorkspaceSyncUploadRunResult> {
    this.activeFlushCounts.set(workspaceUuid, (this.activeFlushCounts.get(workspaceUuid) ?? 0) + 1);
    try {
      const existing = this.timers.get(workspaceUuid);
      if (existing) {
        this.clearDebounceTimer(existing);
        this.timers.delete(workspaceUuid);
      }

      let queued: WorkspaceSyncQueueJob | null;
      try {
        queued = await this.enqueueUpload(workspaceUuid, options);
      } catch (error) {
        if (errorCode(error) === 'LOCAL_CAPTURE_OBSOLETE')
          this.deferredChangesDuringUpload.add(workspaceUuid);
        throw error;
      }
      if (!queued) return { status: 'idle' };

      if (queued.status === 'blocked') {
        const activeAccountId = await this.deps.getActiveAccountId();
        const binding = requireBindingByWorkspaceUuid(this.db, workspaceUuid);
        if (
          queued.errorCode === 'ACCOUNT_PAUSED' &&
          activeAccountId !== null &&
          activeAccountId === binding.owner_account_id
        ) {
          queued = resumeAccountPausedWorkspaceSyncJob(this.db, {
            id: queued.id,
            activeAccountId,
            nowMs: this.nowMs(),
          });
        }
        if (queued.status === 'blocked') {
          return {
            status: 'failed',
            job: queued,
            errorCode: queued.errorCode ?? 'ACCOUNT_PAUSED',
          };
        }
      }

      if (queued.status === 'failed') {
        if (options.force && isForceRetryableWorkspaceSyncFailure(queued)) {
          const retryJob = queued;
          await this.withDatabaseFence(() =>
            this.db.transaction(() => {
              const before = getWorkspaceSyncQueueJob(this.db, retryJob.id);
              const nowMs = this.nowMs();
              const requeued = requeueWorkspaceSyncJob(this.db, {
                id: retryJob.id,
                nowMs,
                resetAttemptCount: true,
              });
              if (before?.status === 'failed' && requeued.status === 'pending') {
                acceptWorkspaceSyncUploadTelemetry(this.db, {
                  job: requeued,
                  ownerAccountId: requireBindingByWorkspaceUuid(this.db, workspaceUuid)
                    .owner_account_id,
                  nowMs,
                  retry: true,
                  parentOperationId: before.acceptedOperationId,
                });
              }
            })()
          );
          publishWorkspaceSyncUploadTelemetry(this.db, retryJob.id);
        } else {
          return {
            status: 'failed',
            job: queued,
            errorCode: queued.errorCode ?? 'UNKNOWN',
          };
        }
      } else if (queued.status === 'retry_wait' && options.force) {
        requeueWorkspaceSyncJob(this.db, {
          id: queued.id,
          nowMs: this.nowMs(),
          resetAttemptCount: false,
        });
      }

      const result = await this.runNext(queued.id);
      if (result.status !== 'idle') return result;

      const unclaimed = getWorkspaceSyncQueueJob(this.db, queued.id);
      if (unclaimed?.status === 'succeeded') return result;
      return {
        status: 'failed',
        job: unclaimed ?? queued,
        errorCode: unclaimed?.errorCode ?? 'UPLOAD_NOT_PERFORMED',
      };
    } finally {
      const remaining = (this.activeFlushCounts.get(workspaceUuid) ?? 1) - 1;
      if (remaining === 0) {
        this.activeFlushCounts.delete(workspaceUuid);
        if (
          this.deferredChangesDuringUpload.delete(workspaceUuid) &&
          isWorkspaceSyncBindingEnabled(this.db, workspaceUuid)
        ) {
          this.scheduleWorkspaceChanged(workspaceUuid);
        }
      } else {
        this.activeFlushCounts.set(workspaceUuid, remaining);
      }
    }
  }

  async runNext(jobId?: string): Promise<WorkspaceSyncUploadRunResult> {
    const existingRun = jobId ? this.activeUploadRunsByJobId.get(jobId) : undefined;
    if (existingRun) return existingRun;
    if (this.stopping) return { status: 'idle' };
    const nowMs = this.nowMs();
    const activeAccountId = await this.deps.getActiveAccountId();
    const runClaimedWhileResolvingAccount = jobId
      ? this.activeUploadRunsByJobId.get(jobId)
      : undefined;
    if (runClaimedWhileResolvingAccount) return runClaimedWhileResolvingAccount;
    if (this.stopping) return { status: 'idle' };
    let job: WorkspaceSyncQueueJob | null = null;
    let telemetryOperationId: string | null = null;
    let binding: WorkspaceBindingRow;
    const releaseClaimFence = await acquireWorkspaceSyncDatabaseFence(this.db);
    try {
      job = claimNextWorkspaceSyncJob(this.db, {
        activeAccountId,
        deviceId: this.deps.deviceId,
        nowMs,
        operation: 'upload',
        jobId,
        excludedWorkspaceUuids: [...this.pausedWorkspaces],
      });
      if (!job) return { status: 'idle' };
      telemetryOperationId = readWorkspaceSyncUploadTelemetryOperation(this.db, job);
      binding = requireBindingByWorkspaceId(this.db, job.workspaceId);
      assertScientificCloudTransferSupported(
        this.db,
        job.workspaceId,
        this.scientificHistoryFormat(job.workspaceId)
      );
    } catch (error) {
      if (!job) throw error;
      const failed = this.recordUploadFailure(job, error, telemetryOperationId);
      if (failed.status === 'canceled') return { status: 'idle' };
      return this.completed({
        status: failed.status === 'retry_wait' ? 'retry_wait' : 'failed',
        job: failed,
        errorCode: failed.errorCode ?? 'UNKNOWN',
      });
    } finally {
      releaseClaimFence();
      if (job) publishWorkspaceSyncUploadTelemetry(this.db, job.id);
    }

    const activeRun = (async (): Promise<WorkspaceSyncUploadRunResult> => {
      this.activeUploadWorkspaces.add(binding.workspace_uuid);
      this.activeUploadJobIds.add(job.id);
      const requestController = new AbortController();
      this.activeRequestControllers.add(requestController);
      let uploadSucceeded = false;
      try {
        if (!binding.remote_workspace_id) {
          throw Object.assign(new Error('Workspace is not bound to a remote sync workspace.'), {
            code: 'MISSING_REMOTE_BINDING',
            retryable: false,
          });
        }

        const releaseMutation = await acquireWorkspaceSyncMutationLease(binding.workspace_path);
        const uploadClient = this.client();
        let prepared: Awaited<
          ReturnType<WorkspaceSyncUploadWorker['loadOrCaptureDurableSnapshot']>
        >;
        try {
          const releasePreparationFence = await acquireWorkspaceSyncDatabaseFence(this.db);
          try {
            await assertWorkspaceMigrationActionsSettled(binding.workspace_path);
            await recoverNativeCatalogRecordPublications({
              db: this.db,
              workspacePath: binding.workspace_path,
              runDatabase: (operation) => operation(),
            });
          } finally {
            releasePreparationFence();
          }
          prepared = await this.loadOrCaptureDurableSnapshot(binding, job, releaseMutation);
          await this.withDatabaseFence(() => {
            this.assertCaptureBindingCurrent(binding);
            this.assertScientificSnapshot(prepared.snapshot, binding.workspace_id);
            assertWorkspaceSyncUploadSnapshotFitsWire(prepared.snapshot, job.baseRemoteVersionId, {
              allowManifest: uploadClient.supportsManifest === true,
            });
            attachRunningWorkspaceSyncSnapshot(this.db, {
              id: job.id,
              localHeadSha: job.localHeadSha,
              bundleContentSha256: prepared.snapshot.contentSha256,
              nowMs: this.nowMs(),
            });
          });
        } finally {
          releaseMutation();
        }
        const snapshot = prepared.snapshot;

        const recoveryManifest = isManifestUploadSnapshot(snapshot)
          ? snapshot.manifest
          : snapshot.bundle.schemaVersion === 3
            ? workspaceSyncManifestFromBundle(snapshot.bundle)
            : null;
        const recoveryRequest = recoveryManifest
          ? {
              remoteWorkspaceId: binding.remote_workspace_id,
              ownerAccountId: binding.owner_account_id,
              baseVersionId: job.baseRemoteVersionId,
              manifest: recoveryManifest,
              ...(isManifestUploadSnapshot(snapshot) && snapshot.scientificHistory
                ? {
                    scientificHistory: snapshot.scientificHistory,
                    scientificBlobRefs: snapshot.scientificBlobRefs,
                    fileManifestSha256: snapshot.fileManifestSha256,
                  }
                : {}),
              reason:
                isManifestUploadSnapshot(snapshot) && snapshot.recoveryOnly
                  ? ('invalid-package' as const)
                  : ('dirty' as const),
              excludedSummary: snapshot.statusExcludedSummary,
              missingPaths: isManifestUploadSnapshot(snapshot)
                ? snapshot.recoveryOnly?.missingPaths
                : undefined,
            }
          : null;
        const recoveryIntent =
          uploadClient.supportsManifest && recoveryRequest
            ? await this.withDatabaseFence(() =>
                this.db.transaction(() => {
                  const before = readWorkspaceSyncRecoveryCandidateIntent(this.db, job.id);
                  const nowMs = this.nowMs();
                  const intent = ensureWorkspaceSyncRecoveryCandidateIntent(this.db, {
                    jobId: job.id,
                    ownerAccountId: binding.owner_account_id,
                    remoteWorkspaceId: binding.remote_workspace_id!,
                    localHeadSha: job.localHeadSha!,
                    snapshotContentSha256: snapshot.contentSha256,
                    requestSha256:
                      workspaceSyncRecoveryCandidateRequest(recoveryRequest).requestSha256,
                    uploadIdempotencyKey: prepared.idempotencyKey,
                    nowMs,
                  });
                  acceptWorkspaceSyncRecoveryTelemetry(this.db, {
                    job,
                    intent,
                    previousOperationId: before?.acceptedOperationId ?? null,
                    nowMs,
                  });
                  return intent;
                })()
              )
            : undefined;
        if (recoveryIntent) publishWorkspaceSyncRecoveryTelemetry(this.db, job.id);

        const request: WorkspaceSyncUploadRequest = {
          fileSelectionVersion: snapshot.selection?.version ?? 0,
          remoteWorkspaceId: binding.remote_workspace_id,
          ownerAccountId: binding.owner_account_id,
          idempotencyKey: prepared.idempotencyKey,
          baseVersionId: job.baseRemoteVersionId,
          ...(isManifestUploadSnapshot(snapshot)
            ? { manifest: snapshot.manifest, excludedSummary: snapshot.statusExcludedSummary }
            : { bundle: snapshot.bundle }),
          fileSources: snapshot.fileSources,
          ...(isManifestUploadSnapshot(snapshot) && snapshot.scientificHistory
            ? {
                scientificHistory: snapshot.scientificHistory,
                scientificBlobRefs: snapshot.scientificBlobRefs,
                scientificBlobSources: snapshot.scientificBlobSources,
                fileManifestSha256: snapshot.fileManifestSha256,
              }
            : {}),
          excludedSummary: snapshot.statusExcludedSummary,
          ...(isManifestUploadSnapshot(snapshot) && snapshot.recoveryOnly
            ? { recoveryOnly: snapshot.recoveryOnly }
            : {}),
          ...(recoveryIntent && recoveryRequest
            ? {
                recoveryCandidateIntent: recoveryIntent,
                onRecoveryCandidateRetained: async (
                  receipt: WorkspaceSyncRecoveryCandidateReceipt
                ) => {
                  validateWorkspaceSyncRecoveryCandidateReceipt(receipt, recoveryRequest);
                  await this.withDatabaseFence(async () => {
                    this.assertCaptureBindingCurrent(binding);
                    if ((await this.deps.getActiveAccountId()) !== binding.owner_account_id) {
                      throw Object.assign(
                        new Error('Account changed before the recovery receipt was recorded.'),
                        { code: 'ACCOUNT_CHANGED', retryable: true }
                      );
                    }
                    this.db.transaction(() => {
                      const owned = getWorkspaceSyncQueueJob(this.db, job.id);
                      if (
                        owned?.status !== 'running' ||
                        owned.localHeadSha !== recoveryIntent.localHeadSha
                      ) {
                        throw Object.assign(
                          new Error('Recovery upload ownership changed before acknowledgement.'),
                          { code: 'ACCOUNT_CHANGED', retryable: true }
                        );
                      }
                      recordWorkspaceSyncRecoveryCandidateReceipt(this.db, {
                        jobId: job.id,
                        intent: recoveryIntent,
                        receipt,
                        nowMs: this.nowMs(),
                      });
                      const retained = readWorkspaceSyncRecoveryCandidateIntent(this.db, job.id);
                      if (retained)
                        settleWorkspaceSyncRecoveryTelemetry(this.db, { job, intent: retained });
                    })();
                  });
                  publishWorkspaceSyncRecoveryTelemetry(this.db, job.id);
                },
              }
            : {}),
          ...(isManifestUploadSnapshot(snapshot) && this.deps.uploadSnapshotRoot
            ? {
                resumeStatePath: join(
                  workspaceSyncUploadSnapshotDirectory(this.deps.uploadSnapshotRoot, job.id),
                  'tus-uploads.json'
                ),
              }
            : {}),
        };

        assertScientificCloudTransferSupported(
          this.db,
          binding.workspace_id,
          this.scientificHistoryFormat(binding.workspace_id)
        );
        const response = await uploadClient.createVersion(request, requestController.signal);
        assertUploadResponseMatchesRequest(response, request, snapshot, binding);

        if (response.status === 'in_progress') {
          throw Object.assign(new Error('Upload reservation is still in progress.'), {
            code: 'IN_PROGRESS',
            retryable: true,
          });
        }

        if (!response.version) {
          throw Object.assign(new Error('Upload response did not include a ready version.'), {
            code: 'BAD_RESPONSE',
            retryable: true,
          });
        }

        const releaseSuccessFence = await acquireWorkspaceSyncDatabaseFence(this.db);
        let updatedJob: WorkspaceSyncQueueJob;
        try {
          updatedJob = recordUploadSuccess(this.db, {
            job,
            telemetryOperationId,
            deviceId: this.deps.deviceId,
            response,
            snapshot,
            binding,
            uploadSnapshotRoot: this.deps.uploadSnapshotRoot,
            nowMs: this.nowMs(),
          });
        } finally {
          releaseSuccessFence();
        }
        await this.reconcileChangesAfterSuccessfulUpload(binding.workspace_uuid);
        uploadSucceeded = true;
        return this.completed({ status: 'uploaded', job: updatedJob, response });
      } catch (error) {
        const releaseFailureFence = await acquireWorkspaceSyncDatabaseFence(this.db);
        let failed: WorkspaceSyncQueueJob;
        try {
          failed = this.recordUploadFailure(job, error, telemetryOperationId);

          if (isAccessRemovedError(error) && (binding.access_source ?? 'owner') !== 'owner') {
            markWorkspaceSyncAccessRemoved(this.db, {
              workspaceId: binding.workspace_id,
              nowMs: this.nowMs(),
            });
            failed = getWorkspaceSyncQueueJob(this.db, job.id) ?? failed;
          }
        } finally {
          releaseFailureFence();
        }
        if (failed.status === 'canceled') return { status: 'idle' };
        if (errorCode(error) === 'LOCAL_CAPTURE_OBSOLETE') {
          try {
            await this.enqueueUpload(binding.workspace_uuid);
          } catch (followUpError) {
            console.warn(
              '[WorkspaceSyncUploadWorker] Could not enqueue the replacement snapshot:',
              errorMessage(followUpError)
            );
          }
        }
        return this.completed({
          status: failed.status === 'retry_wait' ? 'retry_wait' : 'failed',
          job: failed,
          errorCode: failed.errorCode ?? 'UNKNOWN',
        });
      } finally {
        this.activeRequestControllers.delete(requestController);
        this.activeUploadWorkspaces.delete(binding.workspace_uuid);
        this.activeUploadJobIds.delete(job.id);
        if (
          uploadSucceeded &&
          (this.activeFlushCounts.get(binding.workspace_uuid) ?? 0) === 0 &&
          this.deferredChangesDuringUpload.delete(binding.workspace_uuid) &&
          isWorkspaceSyncBindingEnabled(this.db, binding.workspace_uuid)
        ) {
          this.scheduleWorkspaceChanged(binding.workspace_uuid);
        }
      }
    })();
    this.activeUploadRunsByJobId.set(job.id, activeRun);
    const clearActiveRun = (): void => {
      if (this.activeUploadRunsByJobId.get(job.id) === activeRun) {
        this.activeUploadRunsByJobId.delete(job.id);
      }
    };
    void activeRun.then(clearActiveRun, clearActiveRun);
    return activeRun;
  }

  private recordUploadFailure(
    job: WorkspaceSyncQueueJob,
    error: unknown,
    telemetryOperationId: string | null
  ): WorkspaceSyncQueueJob {
    const nowMs = this.nowMs();
    const { failed, transitionWon } = this.db.transaction(() => {
      const before = getWorkspaceSyncQueueJob(this.db, job.id);
      const result = markWorkspaceSyncJobFailed(this.db, {
        id: job.id,
        expectedStatus: 'running',
        expectedAcceptedOperationId: job.acceptedOperationId,
        expectedClaim: {
          deviceId: this.deps.deviceId,
          lockedAt: job.lockedAt,
          attemptCount: job.attemptCount,
        },
        nowMs,
        retryable: isRetryableError(error),
        retryDelayMs: retryDelayForAttempt(
          job.attemptCount,
          this.deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
          this.deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
        ),
        maxAttempts: this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        errorCode: errorCode(error),
        errorMessage: errorMessage(error),
      });
      const transitionWon =
        before?.status === 'running' &&
        before.acceptedOperationId === job.acceptedOperationId &&
        before.lockedByDeviceId === this.deps.deviceId &&
        before.lockedAt === job.lockedAt &&
        before.attemptCount === job.attemptCount &&
        (result.status === 'failed' || result.status === 'retry_wait') &&
        result.updatedAt === nowMs;
      if (transitionWon && result.status === 'failed') {
        settleWorkspaceSyncUploadTelemetry(this.db, {
          job,
          operationId: telemetryOperationId,
          outcome: 'failed',
          nowMs,
          errorCode: result.errorCode ?? 'UNKNOWN',
        });
      }
      return { failed: result, transitionWon };
    })();

    if (
      transitionWon &&
      failed.status === 'failed' &&
      failed.errorCode !== 'VALIDATION' &&
      failed.errorCode !== 'UPGRADE_REQUIRED' &&
      failed.errorCode !== 'QUOTA_EXCEEDED' &&
      failed.errorCode !== 'RECOVERY_CAPTURE_ONLY' &&
      failed.errorCode !== 'RECOVERY_CANDIDATE_EXPIRED' &&
      failed.errorCode !== 'SCIENTIFIC_CLOUD_TRANSFER_UNSUPPORTED' &&
      !readWorkspaceSyncRecoveryCandidateIntent(this.db, failed.id)
    ) {
      deleteWorkspaceSyncUploadSnapshot(this.db, failed.id, {
        root: this.deps.uploadSnapshotRoot,
      });
    }
    return failed;
  }

  private completed<T extends Exclude<WorkspaceSyncUploadRunResult, { status: 'idle' }>>(
    result: T
  ): T {
    publishWorkspaceSyncUploadTelemetry(this.db, result.job.id);
    publishWorkspaceSyncRecoveryTelemetry(this.db, result.job.id);
    try {
      this.deps.onRunCompleted?.(result);
    } catch (error) {
      console.warn(
        '[WorkspaceSyncUploadWorker] Completion observer failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
    return result;
  }

  private async enqueueUpload(
    workspaceUuid: string,
    options: { force?: boolean } = {}
  ): Promise<WorkspaceSyncQueueJob | null> {
    const preliminaryBinding = requireBindingByWorkspaceUuid(this.db, workspaceUuid);
    let releaseMutation: (() => void) | null = await acquireWorkspaceSyncMutationLease(
      preliminaryBinding.workspace_path
    );
    let capturedSnapshot: WorkspaceSyncUploadSnapshot | undefined;
    try {
      const releaseDatabaseFence = await acquireWorkspaceSyncDatabaseFence(this.db);
      let binding: WorkspaceBindingRow;
      try {
        binding = requireBindingByWorkspaceUuid(this.db, workspaceUuid);
        if (binding.workspace_path !== preliminaryBinding.workspace_path) {
          throw localCaptureObsoleteError();
        }
        if (!binding.remote_workspace_id) {
          throw new Error(`Workspace ${workspaceUuid} is not bound to a remote sync workspace.`);
        }

        if (binding.access_role === 'viewer') return null;
        const active = selectActiveWorkspaceSyncUpload(this.db, binding.workspace_id);
        if (active) return active;

        await assertWorkspaceMigrationActionsSettled(binding.workspace_path);
        await recoverNativeCatalogRecordPublications({
          db: this.db,
          workspacePath: binding.workspace_path,
          runDatabase: (operation) => operation(),
        });

        prepareWorkspaceSyncProjection(this.db, {
          workspaceId: binding.workspace_id,
          workspaceRoot: binding.workspace_path,
          scientificHistoryFormat: this.scientificHistoryFormat(binding.workspace_id),
        });
      } finally {
        releaseDatabaseFence();
      }

      let storagePolicy: WorkspaceSyncStoragePolicy | undefined;
      const captureOptions = {
        projectionPrepared: true,
        mutationLease: releaseMutation ?? undefined,
        onSourcesFrozen: () => {
          releaseMutation?.();
          releaseMutation = null;
        },
      };
      const recoverCapture = async (error: unknown, releaseSources = true) => {
        if (
          !(error instanceof WorkspaceSyncSnapshotError) ||
          !['UNSUPPORTED_AUTHORITATIVE_STATE', 'INVALID_BUNDLE', 'INVALID_TEXT_ENCODING'].includes(
            error.code
          ) ||
          this.client().supportsManifest !== true ||
          !this.deps.uploadSnapshotRoot ||
          this.deps.snapshotWorkspace ||
          this.deps.snapshotUploadWorkspace
        )
          throw error;
        if (!releaseMutation)
          releaseMutation = await acquireWorkspaceSyncMutationLease(binding.workspace_path);
        storagePolicy ??= await this.readCapturePolicy(binding);
        return buildWorkspaceSyncRecoveryCapture(this.db, {
          workspaceUuid,
          appVersion: this.deps.appVersion,
          storagePolicy,
          prepareProjection: false,
          scientificHistoryFormat: this.scientificHistoryFormat(binding.workspace_id),
          mutationLease: releaseMutation,
          captureSourceRoot: this.deps.uploadSnapshotRoot,
          onSourcesFrozen: releaseSources ? captureOptions.onSourcesFrozen : undefined,
        });
      };

      if (this.deps.commitWorkingTreeIfDirty) {
        const client = this.client();
        if (client.readVersionPaths)
          await ensureWorkspaceSyncAcceptedPaths(
            this.db,
            workspaceUuid,
            client.readVersionPaths.bind(client)
          );
        storagePolicy = await this.readCapturePolicy(binding);
        let selectedPaths: string[];
        try {
          const preview = await previewWorkspaceSyncUploadWithHeldMutationLease(this.db, {
            workspaceUuid,
            storagePolicy,
            scientificHistoryFormat: this.scientificHistoryFormat(binding.workspace_id),
          });
          assertWorkspaceSyncSelectionActive(preview.selection);
          selectedPaths = preview.includedFiles.map((file) => file.relativePath);
        } catch (error) {
          const recovery = await recoverCapture(error, false);
          capturedSnapshot = recovery;
          selectedPaths = recovery.manifest.files.map((file) => file.path);
        }
        await this.deps.commitWorkingTreeIfDirty(binding.workspace_path, {
          forceInclude: selectedPaths,
        });
      }

      const context = workspaceContext(binding);
      const localHeadSha = await this.deps.getCurrentLocalHeadSha(context);
      if (
        !options.force &&
        !this.scientificHistoryFormat(binding.workspace_id) &&
        localHeadSha !== null &&
        localHeadSha === binding.last_acked_local_head_sha
      ) {
        return null;
      }
      if (!localHeadSha) throw localCaptureObsoleteError();
      let snapshot: WorkspaceSyncUploadSnapshot;
      try {
        if (capturedSnapshot) {
          snapshot = capturedSnapshot;
          captureOptions.onSourcesFrozen();
        } else {
          snapshot = await this.snapshotForUpload(workspaceUuid, {
            ...captureOptions,
            storagePolicy,
          });
        }
      } catch (error) {
        snapshot = await recoverCapture(error);
      }
      capturedSnapshot = snapshot;
      if (
        isManifestUploadSnapshot(snapshot) &&
        snapshot.scientificHistory &&
        !options.force &&
        snapshot.contentSha256 === binding.remote_latest_content_sha256 &&
        localHeadSha === binding.last_acked_local_head_sha
      )
        return null;
      if (isManifestUploadSnapshot(snapshot) && this.deps.verifyUploadCaptureMatchesCommit) {
        await this.deps.verifyUploadCaptureMatchesCommit(snapshot, localHeadSha);
      } else if (!isManifestUploadSnapshot(snapshot) && this.deps.verifySnapshotMatchesCommit) {
        await this.deps.verifySnapshotMatchesCommit(snapshot, localHeadSha);
      } else if (isManifestUploadSnapshot(snapshot)) {
        await assertWorkspaceSyncUploadCaptureMatchesCommit(snapshot, localHeadSha);
      } else if (!this.deps.snapshotWorkspace) {
        await assertWorkspaceSyncSnapshotMatchesCommit(snapshot, localHeadSha);
      }
      if (!releaseMutation) {
        releaseMutation = await acquireWorkspaceSyncMutationLease(binding.workspace_path);
      }
      const confirmedHeadSha = await this.deps.getCurrentLocalHeadSha(context);
      if (confirmedHeadSha !== localHeadSha) throw localCaptureObsoleteError();
      const workingTreeChanged = this.deps.hasWorkingTreeChanges
        ? await this.deps.hasWorkingTreeChanges(binding.workspace_path)
        : !this.deps.snapshotWorkspace &&
          (await hasWorkspaceSyncWorkingChanges(binding.workspace_path));
      if (workingTreeChanged) {
        throw localCaptureObsoleteError();
      }
      this.assertScientificSnapshot(snapshot, binding.workspace_id);
      assertWorkspaceSyncUploadSnapshotFitsWire(snapshot, binding.remote_latest_version_id, {
        allowManifest: this.client().supportsManifest === true,
      });
      const idempotencyKey = uploadIdempotencyKey({
        workspaceUuid,
        baseRemoteVersionId: binding.remote_latest_version_id,
        localHeadSha,
        contentSha256: snapshot.contentSha256,
      });
      const acceptedJob = await this.withDatabaseFence(async () => {
        const activeAccountId = await this.deps.getActiveAccountId();
        this.assertCaptureBindingCurrent(binding);
        if (activeAccountId !== binding.owner_account_id) throw localCaptureObsoleteError();
        if (this.stopping || this.pausedWorkspaces.has(workspaceUuid)) return null;
        const active = selectActiveWorkspaceSyncUpload(this.db, binding.workspace_id);
        if (active) return active;
        const nowMs = this.nowMs();
        return this.db.transaction(() => {
          const candidateJobId = this.deps.createJobId?.() ?? randomUUID();
          const existingCandidate = this.db
            .prepare('SELECT 1 FROM workspace_sync_queue WHERE id = ?')
            .get(candidateJobId);
          const job = enqueueWorkspaceSyncJob(this.db, {
            id: candidateJobId,
            workspaceId: binding.workspace_id,
            operation: 'upload',
            idempotencyKey,
            baseRemoteVersionId: binding.remote_latest_version_id,
            localHeadSha,
            bundleContentSha256: snapshot.contentSha256,
            nowMs,
          });
          const durable = this.readDurableUploadSnapshot(binding, job.id);
          if (durable && durable.contentSha256 !== snapshot.contentSha256) {
            throw new Error(`Workspace sync job ${job.id} already names different upload content.`);
          }
          if (!durable) {
            this.recordDurableUploadSnapshot(job.id, snapshot, nowMs);
          }
          if (!existingCandidate && job.id === candidateJobId) {
            acceptWorkspaceSyncUploadTelemetry(this.db, {
              job,
              ownerAccountId: binding.owner_account_id,
              nowMs: job.createdAt,
              retry: false,
            });
          }
          return job;
        })();
      });
      if (acceptedJob) publishWorkspaceSyncUploadTelemetry(this.db, acceptedJob.id);
      return acceptedJob;
    } finally {
      try {
        if (capturedSnapshot && isManifestUploadSnapshot(capturedSnapshot)) {
          await capturedSnapshot.dispose?.();
        }
      } finally {
        releaseMutation?.();
      }
    }
  }

  private async withDatabaseFence<T>(operation: () => T): Promise<T> {
    const release = await acquireWorkspaceSyncDatabaseFence(this.db);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertCaptureBindingCurrent(binding: WorkspaceBindingRow): void {
    assertScientificCloudTransferSupported(
      this.db,
      binding.workspace_id,
      this.scientificHistoryFormat(binding.workspace_id)
    );
    const current = requireBindingByWorkspaceUuid(this.db, binding.workspace_uuid);
    const accessUnchanged =
      current.access_role === binding.access_role &&
      current.access_source === binding.access_source;

    const publicationStillAllowed =
      ['owner', 'manager', 'editor'].includes(binding.access_role ?? 'owner') &&
      ['owner', 'manager', 'editor'].includes(current.access_role ?? '');
    if (
      current.workspace_id !== binding.workspace_id ||
      current.workspace_path !== binding.workspace_path ||
      current.owner_account_id !== binding.owner_account_id ||
      current.remote_workspace_id !== binding.remote_workspace_id ||
      current.remote_latest_version_id !== binding.remote_latest_version_id ||
      (!accessUnchanged && !publicationStillAllowed)
    ) {
      throw localCaptureObsoleteError();
    }
  }

  private async loadOrCaptureDurableSnapshot(
    binding: WorkspaceBindingRow,
    job: WorkspaceSyncQueueJob,
    mutationLease: () => void
  ): Promise<{ snapshot: WorkspaceSyncUploadSnapshot; idempotencyKey: string }> {
    let durable: WorkspaceSyncUploadSnapshot | null;
    try {
      durable = await this.withDatabaseFence(() => this.readDurableUploadSnapshot(binding, job.id));
    } catch (error) {
      throw durableUploadInvalidError(errorMessage(error));
    }
    if (durable) {
      if (!job.localHeadSha) throw localCaptureObsoleteError();
      const idempotencyKey = requireIdempotencyKey(job);
      const expected = uploadIdempotencyKey({
        workspaceUuid: binding.workspace_uuid,
        baseRemoteVersionId: job.baseRemoteVersionId,
        localHeadSha: job.localHeadSha,
        contentSha256: durable.contentSha256,
      });
      if (idempotencyKey !== expected) {
        throw durableUploadInvalidError(
          `Workspace sync job ${job.id} idempotency key does not name its bytes.`
        );
      }
      return { snapshot: durable, idempotencyKey };
    }
    if (!job.localHeadSha) throw localCaptureObsoleteError();

    const currentHead = await this.deps.getCurrentLocalHeadSha(workspaceContext(binding));
    if (currentHead !== job.localHeadSha) throw localCaptureObsoleteError();
    const snapshot = await this.snapshotForUpload(binding.workspace_uuid, {
      projectionPrepared: true,
      mutationLease,
    });
    if (isManifestUploadSnapshot(snapshot) && this.deps.verifyUploadCaptureMatchesCommit) {
      await this.deps.verifyUploadCaptureMatchesCommit(snapshot, job.localHeadSha);
    } else if (!isManifestUploadSnapshot(snapshot) && this.deps.verifySnapshotMatchesCommit) {
      await this.deps.verifySnapshotMatchesCommit(snapshot, job.localHeadSha);
    } else if (isManifestUploadSnapshot(snapshot)) {
      await assertWorkspaceSyncUploadCaptureMatchesCommit(snapshot, job.localHeadSha);
    } else if (!this.deps.snapshotWorkspace) {
      await assertWorkspaceSyncSnapshotMatchesCommit(snapshot, job.localHeadSha);
    }
    const workingTreeChanged = this.deps.hasWorkingTreeChanges
      ? await this.deps.hasWorkingTreeChanges(binding.workspace_path)
      : !this.deps.snapshotWorkspace &&
        (await hasWorkspaceSyncWorkingChanges(binding.workspace_path));
    if (workingTreeChanged) throw localCaptureObsoleteError();
    assertWorkspaceSyncUploadSnapshotFitsWire(snapshot, job.baseRemoteVersionId, {
      allowManifest: this.client().supportsManifest === true,
    });
    const idempotencyKey = uploadIdempotencyKey({
      workspaceUuid: binding.workspace_uuid,
      baseRemoteVersionId: job.baseRemoteVersionId,
      localHeadSha: job.localHeadSha,
      contentSha256: snapshot.contentSha256,
    });
    let persistedSnapshot: WorkspaceSyncUploadSnapshot | null = null;
    await this.withDatabaseFence(() =>
      this.db.transaction(() => {
        this.assertCaptureBindingCurrent(binding);
        recordWorkspaceSyncUploadCaptureIdentity(this.db, {
          jobId: job.id,
          idempotencyKey,
          contentSha256: snapshot.contentSha256,
          nowMs: this.nowMs(),
        });
        persistedSnapshot = this.recordDurableUploadSnapshot(job.id, snapshot, this.nowMs());
      })()
    );
    return { snapshot: persistedSnapshot ?? snapshot, idempotencyKey };
  }

  private async snapshotWorkspace(
    workspaceUuid: string,
    options: {
      projectionPrepared?: boolean;
      onSourcesFrozen?: () => void;
      mutationLease?: () => void;
      storagePolicy?: WorkspaceSyncStoragePolicy;
    } = {}
  ): Promise<WorkspaceSyncUploadSnapshot> {
    if (this.deps.snapshotWorkspace) return this.deps.snapshotWorkspace(workspaceUuid);
    const binding = requireBindingByWorkspaceUuid(this.db, workspaceUuid);
    const client = this.client();
    const storagePolicy = options.storagePolicy ?? (await this.readCapturePolicy(binding));
    const capture = () =>
      (client.supportsManifest === true
        ? buildWorkspaceSyncUploadCapture
        : buildWorkspaceSyncSnapshot)(this.db, {
        workspaceUuid,
        appVersion: this.deps.appVersion,
        capturedAt: new Date(this.nowMs()),
        prepareProjection: options.projectionPrepared ? false : undefined,
        directStorage: true,
        storagePolicy,
        scientificHistoryFormat: client.supportsManifest
          ? this.scientificHistoryFormat(binding.workspace_id)
          : undefined,
        mutationLease: options.mutationLease,
        ...(client.supportsManifest === true &&
        options.onSourcesFrozen &&
        this.deps.uploadSnapshotRoot
          ? {
              captureSourceRoot: this.deps.uploadSnapshotRoot,
              onSourcesFrozen: options.onSourcesFrozen,
            }
          : {}),
      });
    try {
      return await capture();
    } catch (error) {
      if (
        !(error instanceof WorkspaceSyncSnapshotError) ||
        error.code !== 'SHARED_FILE_OWNERSHIP_REQUIRED' ||
        !binding.remote_workspace_id ||
        !binding.remote_latest_version_id ||
        !client.readVersionPaths
      )
        throw error;
      const paths = await client.readVersionPaths(
        binding.remote_workspace_id,
        binding.remote_latest_version_id,
        binding.owner_account_id
      );
      await this.withDatabaseFence(async () => {
        const current = requireBindingByWorkspaceUuid(this.db, workspaceUuid);
        if (
          current.remote_workspace_id !== binding.remote_workspace_id ||
          current.remote_latest_version_id !== binding.remote_latest_version_id ||
          current.owner_account_id !== binding.owner_account_id ||
          (await this.deps.getActiveAccountId()) !== binding.owner_account_id
        ) {
          throw Object.assign(
            new Error('The sync binding changed while reading the accepted file list.'),
            {
              code: 'SYNC_CONFLICT',
              retryable: false,
            }
          );
        }
        recordWorkspaceSyncReplicaFiles(this.db, {
          workspaceUuid,
          remoteWorkspaceId: binding.remote_workspace_id!,
          remoteVersionId: binding.remote_latest_version_id!,
          paths,
          nowMs: this.nowMs(),
        });
      });
      return capture();
    }
  }

  private snapshotForUpload(
    workspaceUuid: string,
    options: {
      projectionPrepared?: boolean;
      onSourcesFrozen?: () => void;
      mutationLease?: () => void;
      storagePolicy?: WorkspaceSyncStoragePolicy;
    } = {}
  ): Promise<WorkspaceSyncUploadSnapshot> {
    if (this.client().supportsManifest === true && this.deps.snapshotUploadWorkspace) {
      return this.deps.snapshotUploadWorkspace(workspaceUuid);
    }
    return this.snapshotWorkspace(workspaceUuid, options);
  }

  private readCapturePolicy(binding: WorkspaceBindingRow): Promise<WorkspaceSyncStoragePolicy> {
    const client = this.client();
    const remoteWorkspaceId = binding.remote_workspace_id;
    const readPolicy = client.readStoragePolicy;
    if (!remoteWorkspaceId || !readPolicy) {
      throw Object.assign(new Error('Storage policy is unavailable.'), {
        code: 'SERVER',
        retryable: true,
      });
    }
    return readWorkspaceSyncCapturePolicy(this.db, {
      remoteWorkspaceId,
      expectedAccountId: binding.owner_account_id,
      readPolicy: () => readPolicy(remoteWorkspaceId, binding.owner_account_id),
      runDatabase: (operation) => this.withDatabaseFence(operation),
    });
  }

  private readDurableUploadSnapshot(
    binding: WorkspaceBindingRow,
    jobId: string
  ): WorkspaceSyncUploadSnapshot | null {
    const capture = readWorkspaceSyncUploadCapture(this.db, {
      jobId,
      workspaceId: binding.workspace_id,
      workspaceUuid: binding.workspace_uuid,
      repoPath: binding.workspace_path,
      root: this.deps.uploadSnapshotRoot,
    });
    if (capture) return capture;
    return readWorkspaceSyncUploadSnapshot(this.db, {
      jobId,
      workspaceId: binding.workspace_id,
      workspaceUuid: binding.workspace_uuid,
      repoPath: binding.workspace_path,
      root: this.deps.uploadSnapshotRoot,
    });
  }

  private recordDurableUploadSnapshot(
    jobId: string,
    snapshot: WorkspaceSyncUploadSnapshot,
    nowMs: number
  ): WorkspaceSyncUploadSnapshot {
    if (isManifestUploadSnapshot(snapshot)) {
      return recordWorkspaceSyncUploadCapture(this.db, {
        jobId,
        snapshot,
        nowMs,
        root: this.deps.uploadSnapshotRoot,
      });
    }
    return recordWorkspaceSyncUploadSnapshot(this.db, {
      jobId,
      snapshot,
      nowMs,
      root: this.deps.uploadSnapshotRoot,
    });
  }

  private scientificHistoryFormat(workspaceId: number): 1 | undefined {
    return this.client().supportsManifest === true &&
      this.client().supportsScientificHistory === true &&
      hasScientificCloudHistoryBinding(this.db, workspaceId)
      ? 1
      : undefined;
  }

  private assertScientificSnapshot(
    snapshot: WorkspaceSyncUploadSnapshot,
    workspaceId: number
  ): void {
    if (
      this.scientificHistoryFormat(workspaceId) === 1 &&
      (!isManifestUploadSnapshot(snapshot) || !snapshot.scientificHistory)
    )
      throw Object.assign(
        new Error('Scientific workspace cannot reuse a file-only upload capture.'),
        { code: 'SCIENTIFIC_CLOUD_TRANSFER_UNSUPPORTED', retryable: false }
      );
  }

  private client(): WorkspaceSyncUploadClient {
    return this.deps.client ?? createWorkspaceSyncUploadClient();
  }

  private async reconcileChangesAfterSuccessfulUpload(workspaceUuid: string): Promise<void> {
    this.deferredChangesDuringUpload.delete(workspaceUuid);
    try {
      await this.enqueueUpload(workspaceUuid);
    } catch (error) {
      this.deferredChangesDuringUpload.add(workspaceUuid);
      console.warn(
        '[WorkspaceSyncUploadWorker] Could not enqueue post-upload workspace changes:',
        errorMessage(error)
      );
    }
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private setDebounceTimer(callback: () => void | Promise<void>, ms: number): unknown {
    const setDebounceTimer = this.deps.setDebounceTimer ?? setTimeout;
    return setDebounceTimer(callback, ms);
  }

  private clearDebounceTimer(handle: unknown): void {
    const clearDebounceTimer = this.deps.clearDebounceTimer ?? clearTimeout;
    clearDebounceTimer(handle as never);
  }
}

export function assertWorkspaceSyncUploadFitsWire(
  bundle: WorkspaceSyncBundle | undefined,
  baseVersionId: string | null,
  options: { allowManifest?: boolean; manifest?: WorkspaceSyncManifestV1 } = {}
): void {
  if (options.manifest) {
    if (options.allowManifest !== true) {
      throw Object.assign(
        new Error('Workspace sync manifest upload is not supported by this client.'),
        {
          code: 'BUNDLE_WIRE_TOO_LARGE',
          retryable: false,
        }
      );
    }
    const parsed = parseWorkspaceSyncManifest(options.manifest);
    if (!parsed.ok) {
      throw Object.assign(
        new Error(`Workspace sync manifest is invalid: ${parsed.errors.join('; ')}`),
        { code: 'BUNDLE_TOO_LARGE', retryable: false }
      );
    }
    const limits = WORKSPACE_SYNC_MANIFEST_READ_LIMITS;
    const rawBytes = parsed.manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
    if (
      parsed.manifest.files.length > limits.maxFiles ||
      parsed.manifest.files.some((file) => file.sizeBytes > limits.maxFileBytes) ||
      rawBytes > limits.maxBundleBytes ||
      Buffer.byteLength(JSON.stringify(parsed.manifest), 'utf8') >
        DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES
    ) {
      throw Object.assign(new Error('Workspace sync manifest exceeds upload admission.'), {
        code: 'BUNDLE_TOO_LARGE',
        retryable: false,
      });
    }
    return;
  }
  if (!bundle) throw new Error('Workspace sync upload has neither a bundle nor a manifest.');
  const admission = validateWorkspaceSyncUploadAdmission(bundle, {
    limits: bundle.schemaVersion === 3 ? bundle.limits : resolveWorkspaceSyncBundleLimits(),
    maxEncodedBundleBytes: resolveWorkspaceSyncEncodedBundleMaxBytes(),
  });
  if (!admission.ok) {
    throw Object.assign(
      new Error(`Workspace sync bundle exceeds upload admission: ${admission.errors.join('; ')}`),
      { code: 'BUNDLE_TOO_LARGE', retryable: false }
    );
  }
  const wireBytes =
    bundle.schemaVersion === 3
      ? Buffer.byteLength(
          JSON.stringify({ baseVersionId, manifest: workspaceSyncManifestFromBundle(bundle) }),
          'utf8'
        )
      : workspaceSyncUploadWireBytes(baseVersionId, bundle);
  if (wireBytes > DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES && options.allowManifest !== true) {
    throw Object.assign(
      new Error(
        `Workspace sync request is ${wireBytes} bytes; the wire limit is ${DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES} bytes.`
      ),
      { code: 'BUNDLE_WIRE_TOO_LARGE', retryable: false }
    );
  }
}

function assertWorkspaceSyncUploadSnapshotFitsWire(
  snapshot: WorkspaceSyncUploadSnapshot,
  baseVersionId: string | null,
  options: { allowManifest?: boolean } = {}
): void {
  if (isManifestUploadSnapshot(snapshot) && snapshot.scientificHistory) {
    parseWorkspaceSyncScientificHistoryMetadata(
      snapshot,
      createHash('sha256')
        .update(workspaceSyncManifestHashInput(snapshot.manifest), 'utf8')
        .digest('hex')
    );
    if (
      Buffer.byteLength(
        JSON.stringify({
          baseVersionId,
          manifest: snapshot.manifest,
          scientificHistory: snapshot.scientificHistory,
          scientificBlobRefs: snapshot.scientificBlobRefs,
        }),
        'utf8'
      ) > DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES
    )
      throw Object.assign(
        new Error('Scientific upload metadata exceeds the control request limit.'),
        { code: 'BUNDLE_WIRE_TOO_LARGE', retryable: false }
      );
  }
  assertWorkspaceSyncUploadFitsWire(
    isManifestUploadSnapshot(snapshot) ? undefined : snapshot.bundle,
    baseVersionId,
    isManifestUploadSnapshot(snapshot) ? { ...options, manifest: snapshot.manifest } : options
  );
}

function isManifestUploadSnapshot(
  snapshot: WorkspaceSyncUploadSnapshot
): snapshot is WorkspaceSyncUploadCapture {
  return 'manifest' in snapshot;
}

function workspaceContext(binding: WorkspaceBindingRow): WorkspaceSyncUploadWorkspaceContext {
  if (!binding.remote_workspace_id) {
    throw new Error(`Workspace ${binding.workspace_uuid} has no remote sync workspace.`);
  }
  return {
    workspaceId: binding.workspace_id,
    workspaceUuid: binding.workspace_uuid,
    repoPath: binding.workspace_path,
    remoteWorkspaceId: binding.remote_workspace_id,
    remoteLatestVersionId: binding.remote_latest_version_id,
  };
}

function localCaptureObsoleteError(): Error & { code: string; retryable: boolean } {
  return Object.assign(
    new Error('The workspace changed while its upload snapshot was being captured.'),
    { code: 'LOCAL_CAPTURE_OBSOLETE', retryable: false }
  );
}

export function createWorkspaceSyncUploadClient(
  client: DesktopSyncClient = createDesktopSyncClient()
): WorkspaceSyncUploadClient {
  return {
    supportsManifest: true,
    supportsScientificHistory: true,
    readVersionPaths: async (remoteWorkspaceId, versionId, ownerAccountId, signal) => {
      await client.assertAccount?.(ownerAccountId);
      const { createWorkspaceSyncProjectsClient } = await import('./workspace-sync-projects');
      const paths = await createWorkspaceSyncProjectsClient(client).readVersionPaths!(
        remoteWorkspaceId,
        versionId,
        signal
      );
      await client.assertAccount?.(ownerAccountId);
      return paths;
    },
    readStoragePolicy: (remoteWorkspaceId, ownerAccountId, signal) =>
      readWorkspaceSyncStoragePolicy(client, remoteWorkspaceId, ownerAccountId, signal),
    createVersion: async (request, signal) => {
      const retain = async (manifest: WorkspaceSyncManifestV1) => {
        const recovery = {
          remoteWorkspaceId: request.remoteWorkspaceId,
          ownerAccountId: request.ownerAccountId,
          baseVersionId: request.baseVersionId,
          manifest,
          ...(request.scientificHistory
            ? {
                scientificHistory: request.scientificHistory,
                scientificBlobRefs: request.scientificBlobRefs,
                fileManifestSha256: request.fileManifestSha256,
              }
            : {}),
          reason: request.recoveryOnly ? ('invalid-package' as const) : ('dirty' as const),
          excludedSummary: request.excludedSummary,
          missingPaths: request.recoveryOnly?.missingPaths,
        };
        const cached = request.recoveryCandidateIntent?.receipt;
        const receipt =
          cached && Date.parse(cached.expiresAt) > Date.now()
            ? validateWorkspaceSyncRecoveryCandidateReceipt(cached, recovery)
            : await retainWorkspaceSyncRecoveryCandidate(
                client,
                {
                  ...recovery,
                  idempotencyKey:
                    request.recoveryCandidateIntent?.idempotencyKey ??
                    `candidate:${createHash('sha256').update(request.idempotencyKey).digest('hex')}`,
                },
                signal
              );
        await request.onRecoveryCandidateRetained?.(receipt);
        if (request.recoveryOnly)
          throw Object.assign(
            new Error(
              'Captured recovery bytes are retained temporarily, but the incomplete or invalid package is not accepted history.'
            ),
            { code: 'RECOVERY_CAPTURE_ONLY', retryable: false }
          );
      };

      const policy = await readWorkspaceSyncStoragePolicy(
        client,
        request.remoteWorkspaceId,
        request.ownerAccountId,
        signal
      );
      if (request.manifest) {
        const files = request.manifest.files;
        const limits = workspaceSyncStoragePolicyLimits(policy);
        if (
          files.length > limits.maxFiles ||
          files.some((file) => file.sizeBytes > limits.maxFileBytes) ||
          files.reduce((total, file) => total + file.sizeBytes, 0) > limits.maxBundleBytes
        ) {
          throw Object.assign(new Error('Storage allowance exceeded.'), {
            code: 'QUOTA_EXCEEDED',
            retryable: false,
          });
        }
        const response = await createManifestWorkspaceSyncVersion(client, request, signal, {
          onBlobsReady: retain,
        });
        return parseWorkspaceSyncUploadResponse(response);
      }
      if (!request.bundle) {
        throw Object.assign(new Error('Workspace sync upload has no bundle.'), {
          code: 'BAD_BUNDLE',
          retryable: false,
        });
      }
      const admission = validateWorkspaceSyncUploadAdmission(request.bundle, {
        limits: workspaceSyncStoragePolicyLimits(policy),
      });
      if (!admission.ok) {
        throw Object.assign(
          new Error(`Storage allowance exceeded: ${admission.errors.join('; ')}`),
          { code: 'QUOTA_EXCEEDED', retryable: false }
        );
      }

      const idempotencyKey =
        request.bundle.schemaVersion === 3
          ? request.idempotencyKey
          : `legacy-policy:${createHash('sha256')
              .update(JSON.stringify([request.idempotencyKey, policy.policyKey, policy.revision]))
              .digest('hex')}`;
      if (
        request.bundle.schemaVersion !== 3 &&
        workspaceSyncUploadWireBytes(request.baseVersionId, request.bundle) >
          DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES
      ) {
        const response = await createManifestWorkspaceSyncVersion(
          client,
          { ...request, idempotencyKey },
          signal,
          { onBlobsReady: retain }
        );
        return parseWorkspaceSyncUploadResponse(response);
      }
      if (request.bundle.schemaVersion === 3) {
        const unique = [
          ...new Map(request.bundle.files.map((file) => [file.sha256, file])).values(),
        ];
        const pending: typeof unique = [];
        const reserve = (file: (typeof unique)[number], requestSignal: AbortSignal) => {
          const blobKey = `blob:${createHash('sha256').update(`${request.idempotencyKey}:${file.sha256}`).digest('hex')}`;
          return client.requestJson<Record<string, unknown>>(
            `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/blobs/reserve`,
            {
              method: 'POST',
              expectedAccountId: request.ownerAccountId,
              idempotencyKey: blobKey,
              signal: requestSignal,
              body: {
                contentSha256: file.sha256,
                sizeBytes: file.sizeBytes,
                contentType: file.contentType,
              },
            }
          );
        };

        await forEachSyncFileBounded(unique, signal, async (file, requestSignal) => {
          let reserved = await reserve(file, requestSignal);
          if (reserved.status === 'ready') {
            assertReadyBlob(reserved, file);
            return;
          }
          if (reserved.status === 'upload_required') {
            if (
              reserved.contentSha256 !== file.sha256 ||
              reserved.sizeBytes !== file.sizeBytes ||
              typeof reserved.reservationId !== 'string'
            ) {
              throw new Error('Storage reservation does not match the queued file.');
            }
            await uploadWorkspaceSyncFileDirect(
              file,
              parseWorkspaceSyncDirectUpload(reserved.upload),
              `${request.ownerAccountId}:${request.remoteWorkspaceId}:${reserved.reservationId}:${file.sha256}`,
              {
                signal: requestSignal,
                assertAccount: () =>
                  client.assertAccount?.(request.ownerAccountId) ?? Promise.resolve(),
              }
            );
            reserved = await client.requestJson<Record<string, unknown>>(
              `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/blobs/complete`,
              {
                method: 'POST',
                expectedAccountId: request.ownerAccountId,
                signal: requestSignal,
                body: { reservationId: reserved.reservationId },
              }
            );
            if (reserved.status === 'ready') reserved = await reserve(file, requestSignal);
          }
          if (reserved.status !== 'verifying' && reserved.status !== 'ready')
            throw new Error('Uploaded file did not enter integrity verification.');
          if (reserved.status === 'ready') assertReadyBlob(reserved, file);
          else pending.push(file);
        });

        const deadline = Date.now() + 30 * 60_000;
        let pollMs = 1000;
        let waiting = pending;
        while (waiting.length > 0) {
          if (Date.now() >= deadline)
            throw Object.assign(new Error('File integrity verification is still pending.'), {
              code: 'NETWORK',
              retryable: true,
            });
          await delay(pollMs, undefined, { signal });
          const next: typeof unique = [];
          await forEachSyncFileBounded(waiting, signal, async (file, requestSignal) => {
            const reserved = await reserve(file, requestSignal);
            if (reserved.status !== 'ready' && reserved.status !== 'verifying')
              throw new Error('Uploaded file failed integrity verification.');
            if (reserved.status === 'ready') assertReadyBlob(reserved, file);
            else next.push(file);
          });
          waiting = next;
          pollMs = Math.min(30_000, pollMs * 2);
        }
      }
      if (request.bundle.schemaVersion === 3)
        await retain(workspaceSyncManifestFromBundle(request.bundle));
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/versions`,
        {
          method: 'POST',
          expectedAccountId: request.ownerAccountId,
          idempotencyKey,
          body:
            request.bundle.schemaVersion === 3
              ? {
                  baseVersionId: request.baseVersionId,
                  fileSelectionVersion: request.fileSelectionVersion ?? 0,
                  manifest: workspaceSyncManifestFromBundle(request.bundle),
                }
              : {
                  baseVersionId: request.baseVersionId,
                  fileSelectionVersion: request.fileSelectionVersion ?? 0,
                  bundle: request.bundle,
                },
          signal,
        }
      );
      return parseWorkspaceSyncUploadResponse(response);
    },
  };
}

export function workspaceSyncManifestFromBundle(
  bundle: WorkspaceSyncBundle
): WorkspaceSyncManifestV1 {
  return {
    schemaVersion: 1,
    files: bundle.files.map((file) => ({
      path: file.relativePath,
      contentSha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    })),
  };
}

function assertReadyBlob(
  value: Record<string, unknown>,
  file: { sha256: string; sizeBytes: number }
): void {
  if (
    value.contentSha256 !== file.sha256 ||
    value.sizeBytes !== file.sizeBytes ||
    !isWorkspaceSyncRemoteUuid(value.blobId)
  ) {
    throw new Error('Verified storage blob does not match the queued file.');
  }
}

function isWorkspaceSyncBindingEnabled(db: Database.Database, workspaceUuid: string): boolean {
  const row = db
    .prepare(
      `SELECT enabled
       FROM workspace_sync_bindings
       WHERE workspace_uuid = ?
         AND NOT ${workspaceSyncUploadBlockedSql('workspace_sync_bindings.workspace_id')}
       LIMIT 1`
    )
    .get(workspaceUuid) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function requireBindingByWorkspaceUuid(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceBindingRow {
  const row = db
    .prepare(
      `SELECT b.workspace_id, b.workspace_uuid, w.path AS workspace_path,
              b.remote_workspace_id, b.remote_latest_version_id,
              b.remote_latest_version_number, b.remote_latest_content_sha256,
              b.last_acked_local_head_sha, b.owner_account_id,
              b.access_role, b.access_source
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.workspace_uuid = ? AND b.enabled = 1
         AND NOT ${workspaceSyncUploadBlockedSql('b.workspace_id')}
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceBindingRow | undefined;
  if (!row) {
    throwIfWorkspaceSyncUploadBlocked(db, { workspaceUuid });
    throw new Error(`Workspace sync binding not found for ${workspaceUuid}`);
  }
  return row;
}

function requireBindingByWorkspaceId(
  db: Database.Database,
  workspaceId: number
): WorkspaceBindingRow {
  const row = db
    .prepare(
      `SELECT b.workspace_id, b.workspace_uuid, w.path AS workspace_path,
              b.remote_workspace_id, b.remote_latest_version_id,
              b.remote_latest_version_number, b.remote_latest_content_sha256,
              b.last_acked_local_head_sha, b.owner_account_id,
              b.access_role, b.access_source
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.workspace_id = ? AND b.enabled = 1
         AND NOT ${workspaceSyncUploadBlockedSql('b.workspace_id')}
       LIMIT 1`
    )
    .get(workspaceId) as WorkspaceBindingRow | undefined;
  if (!row) {
    throwIfWorkspaceSyncUploadBlocked(db, { workspaceId });
    throw new Error(`Workspace sync binding not found for workspace id ${workspaceId}`);
  }
  return row;
}

function recordUploadSuccess(
  db: Database.Database,
  input: {
    job: WorkspaceSyncQueueJob;
    telemetryOperationId: string | null;
    deviceId: string;
    response: WorkspaceSyncUploadVersionResponse;
    snapshot: WorkspaceSyncUploadSnapshot;
    binding: WorkspaceBindingRow;
    uploadSnapshotRoot?: string;
    nowMs: number;
  }
): WorkspaceSyncQueueJob {
  return db.transaction(() => {
    const version = input.response.version;
    if (!version) throw new Error('Cannot record upload success without a version payload.');
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: input.binding.workspace_uuid,
      remoteWorkspaceId: input.binding.remote_workspace_id!,
      remoteVersionId: version.id,
      paths: isManifestUploadSnapshot(input.snapshot)
        ? input.snapshot.manifest.files.map((file) => file.path)
        : input.snapshot.bundle.files.map((file) => file.relativePath),
      nowMs: input.nowMs,
    });

    acknowledgeWorkspaceSyncUpload(db, {
      job: input.job,
      deviceId: input.deviceId,
      nowMs: input.nowMs,
    });

    const collision = db
      .prepare(
        `SELECT id, remote_version_id, workspace_id
         FROM workspace_sync_versions
         WHERE id = ? OR remote_version_id = ?
         LIMIT 1`
      )
      .get(version.id, version.id) as
      | { id: string; remote_version_id: string; workspace_id: number }
      | undefined;
    if (
      collision &&
      (collision.workspace_id !== input.job.workspaceId ||
        collision.id !== version.id ||
        collision.remote_version_id !== version.id)
    ) {
      throw badUploadResponse('Upload version is already linked to another local workspace.');
    }

    db.prepare(`UPDATE workspace_sync_versions SET is_latest = 0 WHERE workspace_id = ?`).run(
      input.job.workspaceId
    );
    db.prepare(
      `INSERT INTO workspace_sync_versions (
        id, workspace_id, remote_version_id, version_number, content_sha256,
        local_head_sha, file_count, size_bytes, excluded_summary_json,
        status, is_latest, created_at, updated_at
      ) VALUES (
        @id, @workspaceId, @remoteVersionId, @versionNumber, @contentSha256,
        @localHeadSha, @fileCount, @sizeBytes, @excludedSummaryJson,
        'ready', 1, @nowMs, @nowMs
      )
      ON CONFLICT(remote_version_id) DO UPDATE SET
        version_number = excluded.version_number,
        content_sha256 = excluded.content_sha256,
        local_head_sha = excluded.local_head_sha,
        file_count = excluded.file_count,
        size_bytes = excluded.size_bytes,
        excluded_summary_json = excluded.excluded_summary_json,
        status = 'ready',
        is_latest = 1,
        updated_at = excluded.updated_at,
        deleted_at = NULL`
    ).run({
      id: version.id,
      workspaceId: input.job.workspaceId,
      remoteVersionId: version.id,
      versionNumber: version.versionNumber,
      contentSha256: version.contentSha256,
      localHeadSha: input.job.localHeadSha,
      fileCount: version.fileCount,
      sizeBytes: version.sizeBytes,
      excludedSummaryJson: serializeWorkspaceSyncExcludedSummary(
        input.snapshot.statusExcludedSummary
      ),
      nowMs: input.nowMs,
    });
    const bindingUpdate = db
      .prepare(
        `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = @remoteVersionId,
           remote_latest_version_number = @versionNumber,
           remote_latest_content_sha256 = @contentSha256,
           last_acked_local_head_sha = @localHeadSha,
           last_uploaded_at = @nowMs,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND enabled = 1
         AND remote_workspace_id = @remoteWorkspaceId
         AND owner_account_id = @ownerAccountId
         AND remote_latest_version_id IS @baseRemoteVersionId`
      )
      .run({
        workspaceId: input.job.workspaceId,
        remoteWorkspaceId: input.response.workspaceId,
        ownerAccountId: input.binding.owner_account_id,
        baseRemoteVersionId: input.job.baseRemoteVersionId,
        remoteVersionId: version.id,
        versionNumber: version.versionNumber,
        contentSha256: version.contentSha256,
        localHeadSha: input.job.localHeadSha,
        nowMs: input.nowMs,
      });
    if (bindingUpdate.changes !== 1) {
      throw Object.assign(new Error('Workspace sync binding changed while upload was in flight.'), {
        code: 'SYNC_CONFLICT',
        retryable: false,
      });
    }
    deleteWorkspaceSyncUploadSnapshotsForWorkspace(db, {
      workspaceId: input.job.workspaceId,
      excludeJobId: input.job.id,
      root: input.uploadSnapshotRoot,
    });
    supersedeWorkspaceSyncUploadFailures(db, {
      workspaceId: input.job.workspaceId,
      completedJobId: input.job.id,
      nowMs: input.nowMs,
    });
    deleteWorkspaceSyncUploadSnapshot(db, input.job.id, { root: input.uploadSnapshotRoot });
    settleWorkspaceSyncUploadTelemetry(db, {
      job: input.job,
      operationId: input.telemetryOperationId,
      outcome: input.response.status === 'unchanged' ? 'unchanged' : 'uploaded',
      nowMs: input.nowMs,
    });
    return getWorkspaceSyncQueueJob(db, input.job.id);
  })();
}

function parseWorkspaceSyncUploadResponse(value: unknown): WorkspaceSyncUploadVersionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badUploadResponse('Upload response must be an object.');
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const workspaceId = isWorkspaceSyncRemoteUuid(record.workspaceId) ? record.workspaceId : null;
  if ((status !== 'ready' && status !== 'unchanged' && status !== 'in_progress') || !workspaceId) {
    throw badUploadResponse('Upload response has invalid status or workspace identity.');
  }
  if (status === 'in_progress') {
    const versionId = isWorkspaceSyncRemoteUuid(record.versionId) ? record.versionId : null;
    const leaseExpiresAt = record.leaseExpiresAt;
    if (!versionId || (leaseExpiresAt !== null && typeof leaseExpiresAt !== 'string')) {
      throw badUploadResponse('In-progress upload response is incomplete.');
    }
    return { status, workspaceId, versionId, leaseExpiresAt };
  }
  const version = parseUploadVersion(record.version);
  if (version.representation === 'scientific_manifest_v1') {
    try {
      const parsed = parseWorkspaceSyncManifest(record.manifest);
      if (!parsed.ok) throw new Error('Scientific receipt has no accepted manifest.');
      const fileSha = createHash('sha256')
        .update(workspaceSyncManifestHashInput(parsed.manifest), 'utf8')
        .digest('hex');
      const scientific = parseWorkspaceSyncScientificHistoryMetadata(
        {
          scientificHistory: record.scientificHistory,
          scientificBlobRefs: record.scientificBlobRefs,
          fileManifestSha256: version.fileManifestSha256,
        },
        fileSha
      );
      if (!scientific) throw new Error('Scientific receipt has no history metadata.');
      if (
        version.contentSha256 !==
          workspaceSyncScientificContentSha256(fileSha, scientific.scientificHistory) ||
        version.fileCount !== parsed.manifest.files.length ||
        version.sizeBytes !==
          parsed.manifest.files.reduce((total, file) => total + file.sizeBytes, 0)
      )
        throw new Error('Scientific receipt authority and placement metadata disagree.');
      return {
        status,
        workspaceId,
        version,
        ...scientific,
        manifest: parsed.manifest,
        resourceIdentities: parseScientificCloudResourceIdentities(
          record.resourceIdentities,
          parsed.manifest
        ),
      };
    } catch {
      throw badUploadResponse('Scientific upload response has no complete history descriptor.');
    }
  }
  if (record.scientificHistory !== undefined)
    throw badUploadResponse(
      'File-only upload response unexpectedly contains scientific authority.'
    );
  return { status, workspaceId, version };
}

function parseUploadVersion(
  value: unknown
): NonNullable<WorkspaceSyncUploadVersionResponse['version']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badUploadResponse('Ready upload response did not include version metadata.');
  }
  const record = value as Record<string, unknown>;
  const id = isWorkspaceSyncRemoteUuid(record.id) ? record.id : null;
  const contentSha256 = nonEmptyString(record.contentSha256);
  const scientific = record.representation === 'scientific_manifest_v1';
  if (
    !id ||
    !contentSha256 ||
    !/^[0-9a-f]{64}$/i.test(contentSha256) ||
    !Number.isSafeInteger(record.versionNumber) ||
    Number(record.versionNumber) <= 0 ||
    !Number.isSafeInteger(record.sizeBytes) ||
    Number(record.sizeBytes) < 0 ||
    !Number.isSafeInteger(record.fileCount) ||
    Number(record.fileCount) < 0 ||
    (scientific &&
      (typeof record.fileManifestSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(record.fileManifestSha256) ||
        typeof record.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        typeof record.finalizedAt !== 'string' ||
        !Number.isFinite(Date.parse(record.finalizedAt))))
  ) {
    throw badUploadResponse('Ready upload version metadata is invalid.');
  }
  return {
    id,
    versionNumber: Number(record.versionNumber),
    contentSha256: contentSha256.toLowerCase(),
    sizeBytes: Number(record.sizeBytes),
    fileCount: Number(record.fileCount),
    ...(scientific
      ? {
          fileManifestSha256: record.fileManifestSha256 as string,
          createdAt: record.createdAt as string,
          finalizedAt: record.finalizedAt as string,
        }
      : {}),
    representation:
      record.representation === undefined
        ? 'bundle_v1'
        : record.representation === 'bundle_v1' ||
            record.representation === 'manifest_v1' ||
            record.representation === 'scientific_manifest_v1'
          ? record.representation
          : (() => {
              throw badUploadResponse('Ready upload version representation is invalid.');
            })(),
  };
}

function assertUploadResponseMatchesRequest(
  response: WorkspaceSyncUploadVersionResponse,
  request: WorkspaceSyncUploadRequest,
  snapshot: WorkspaceSyncUploadSnapshot,
  binding: WorkspaceBindingRow
): void {
  if (response.workspaceId !== request.remoteWorkspaceId) {
    throw badUploadResponse('Upload response belongs to a different remote workspace.');
  }
  if (response.status === 'in_progress') return;
  const version = response.version;
  if (!version) throw badUploadResponse('Upload response omitted the completed version.');
  const scientific = isManifestUploadSnapshot(snapshot) ? snapshot.scientificHistory : undefined;
  if (
    isManifestUploadSnapshot(snapshot) &&
    version.representation !== (scientific ? 'scientific_manifest_v1' : 'manifest_v1')
  ) {
    throw badUploadResponse('Upload response returned a different authority representation.');
  }
  const manifest =
    version.representation === 'manifest_v1' || version.representation === 'scientific_manifest_v1'
      ? (request.manifest ??
        (request.bundle ? workspaceSyncManifestFromBundle(request.bundle) : null))
      : null;
  if ((version.representation === 'manifest_v1' || scientific) && !manifest) {
    throw badUploadResponse('Manifest upload response has no local manifest.');
  }
  const manifestSha256 = manifest
    ? createHash('sha256').update(workspaceSyncManifestHashInput(manifest), 'utf8').digest('hex')
    : snapshot.contentSha256;
  if (
    scientific &&
    (version.fileManifestSha256 !== manifestSha256 ||
      JSON.stringify(parseScientificCloudHistory(response.scientificHistory)) !==
        JSON.stringify(parseScientificCloudHistory(scientific)) ||
      JSON.stringify(response.manifest) !== JSON.stringify(manifest) ||
      JSON.stringify(response.scientificBlobRefs) !== JSON.stringify(request.scientificBlobRefs))
  )
    throw badUploadResponse(
      'Scientific upload response does not cover the exact captured history and files.'
    );
  if (scientific) parseScientificCloudResourceIdentities(response.resourceIdentities, manifest!);
  const expectedContentSha256 = scientific ? snapshot.contentSha256 : manifestSha256;
  const expectedSizeBytes = manifest
    ? manifest.files.reduce((total, file) => total + file.sizeBytes, 0)
    : snapshot.bundleSizeBytes;
  if (
    version.contentSha256.toLowerCase() !== expectedContentSha256.toLowerCase() ||
    version.sizeBytes !== expectedSizeBytes ||
    version.fileCount !== snapshot.includedFileCount
  ) {
    throw badUploadResponse('Upload response metadata does not match the uploaded content.');
  }
  if (
    binding.remote_latest_version_number !== null &&
    version.versionNumber < binding.remote_latest_version_number
  ) {
    throw badUploadResponse('Upload response regressed the remote version number.');
  }
  if (response.status === 'unchanged') {
    if (
      request.baseVersionId === null ||
      version.id !== request.baseVersionId ||
      version.versionNumber !== binding.remote_latest_version_number
    ) {
      throw badUploadResponse('Unchanged upload response did not echo the current base version.');
    }
    return;
  }
  if (
    version.id === request.baseVersionId ||
    (binding.remote_latest_version_number !== null &&
      version.versionNumber <= binding.remote_latest_version_number)
  ) {
    throw badUploadResponse('Ready upload response did not advance the remote version.');
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function badUploadResponse(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_RESPONSE', retryable: true });
}

function requireIdempotencyKey(job: WorkspaceSyncQueueJob): string {
  if (!job.idempotencyKey) throw new Error(`Workspace sync job ${job.id} lacks idempotency key.`);
  return job.idempotencyKey;
}

function uploadIdempotencyKey(input: {
  workspaceUuid: string;
  baseRemoteVersionId: string | null;
  localHeadSha: string;
  contentSha256: string;
}): string {
  return `upload:${input.workspaceUuid}:${input.baseRemoteVersionId ?? 'no-base'}:${input.localHeadSha}:${input.contentSha256}`;
}

function durableUploadInvalidError(message: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), {
    code: 'DURABLE_UPLOAD_INVALID',
    retryable: false,
  });
}

function selectActiveWorkspaceSyncUpload(
  db: Database.Database,
  workspaceId: number
): WorkspaceSyncQueueJob | null {
  const row = db
    .prepare(
      `SELECT id
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND operation = 'upload'
         AND status IN ('pending', 'running', 'retry_wait', 'blocked')
       ORDER BY created_at, id
       LIMIT 1`
    )
    .get(workspaceId) as { id: string } | undefined;
  if (!row) return null;
  return getWorkspaceSyncQueueJob(db, row.id);
}

function retryDelayForAttempt(attemptCount: number, baseMs: number, maxMs: number): number {
  const multiplier = 2 ** Math.max(0, attemptCount - 1);
  return Math.min(maxMs, baseMs * multiplier);
}

function isRetryableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }
  return false;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return 'UNKNOWN';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workspace sync upload failed.';
}
