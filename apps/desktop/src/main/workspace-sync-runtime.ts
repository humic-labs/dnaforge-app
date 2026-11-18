import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getActiveStoredSession } from './auth/session-store';
import { DesktopSyncClientError } from './desktop-sync-client';
import {
  settleWorkspaceSyncReplicaRecovery,
  settleWorkspaceSyncPullFailures,
  recoverWorkspaceSyncQueue,
  type WorkspaceSyncQueueRecoveryResult,
} from './workspace-sync-queue';
import {
  WorkspaceSyncUploadWorker,
  type WorkspaceSyncUploadClient,
  type WorkspaceSyncUploadRunResult,
  type WorkspaceSyncUploadWorkerDeps,
} from './workspace-sync-upload-worker';
import {
  observeWorkspaceSync,
  workspaceSyncAccessRole,
  workspaceSyncErrorCode,
  workspaceSyncVersionFacts,
} from './workspace-sync-observation';
import { enqueueWorkspaceSyncJob, markWorkspaceSyncJobFailed } from './workspace-sync-queue';
import {
  applyLatestToExistingManagedRepo,
  reconcileInterruptedWorkspaceRestores,
  remoteAccess,
  type DesktopSyncMaterializableVersion,
  type DesktopSyncWorkspaceSummaryResponse,
  WorkspaceSyncPullConflictError,
  type WorkspaceSyncProjectsClient,
} from './workspace-sync-projects';
import {
  isAccessRemovedError,
  isSharedAccessBinding,
  markWorkspaceSyncAccessRemoved,
  readWorkspaceSyncAccessBinding,
  updateWorkspaceSyncAccessRecord,
} from './workspace-sync-access';
import {
  ManagedWorkspaceSyncWatcher,
  type ManagedWorkspaceSyncWatchState,
} from './workspace-sync-watcher';
import type { WorkspaceSyncStatusPublisher } from './workspace-sync-status';
import type { WorkspaceSyncStatusChangeReason } from '../shared/workspace-sync-ipc';
import { commitAllIfDirty, resolveHeadCommit } from './workspace-git';
import { hasWorkspaceSyncWorkingChanges } from './workspace-sync-git-state';
import {
  getWorkspaceScopedDirtyState,
  hasUnsavedWorkspaceBuffers,
} from './workspace-sync-dirty-state';
import {
  reconcileInterruptedReplicaPulls,
  type ReplicaPullRecoveryResult,
} from './workspace-sync-replica-journal';
import type { WorkspaceSyncReplicaAppliedNotice } from './workspace-sync-replica-publisher';
import type { WorkspaceSyncReplicaPreparingNotice } from './workspace-sync-replica-publisher';
import {
  markWorkspaceSyncRendererRefreshSucceeded,
  readPendingWorkspaceSyncRendererRefresh,
  recordWorkspaceSyncRendererRefreshFailure,
  readWorkspaceSyncRendererDeliveryStatus,
  type PendingWorkspaceSyncRendererRefresh,
} from './workspace-sync-renderer-refresh-pending';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { readOrCreateWorkspaceSyncDeviceId } from './workspace-sync-device';
import { assertWorkspaceSyncUploadCaptureMatchesCommit } from './workspace-sync-snapshotter';

export { readOrCreateWorkspaceSyncDeviceId } from './workspace-sync-device';

export interface WorkspaceSyncRuntimeWatcher {
  ensureWatching(workspaceUuid: string): Promise<ManagedWorkspaceSyncWatchState | undefined>;
  stopWatching?(workspaceUuid: string): void | Promise<void>;
  stopAll(): void | Promise<void>;
  drainFingerprints?(workspaceUuid?: string): Promise<void>;
}

export interface WorkspaceSyncRuntimeDeps {
  deviceId?: string;
  appVersion: string;
  getActiveAccountId?: () => string | null | Promise<string | null>;
  getCurrentLocalHeadSha?: WorkspaceSyncUploadWorkerDeps['getCurrentLocalHeadSha'];
  hasLocalWorkingChanges?: (
    workspace: Parameters<WorkspaceSyncUploadWorkerDeps['getCurrentLocalHeadSha']>[0]
  ) => boolean | Promise<boolean>;
  commitWorkingTreeIfDirty?: WorkspaceSyncUploadWorkerDeps['commitWorkingTreeIfDirty'];
  snapshotWorkspace?: WorkspaceSyncUploadWorkerDeps['snapshotWorkspace'];
  snapshotUploadWorkspace?: WorkspaceSyncUploadWorkerDeps['snapshotUploadWorkspace'];
  verifyUploadCaptureMatchesCommit?: WorkspaceSyncUploadWorkerDeps['verifyUploadCaptureMatchesCommit'];
  client?: WorkspaceSyncUploadClient;
  uploadSnapshotRoot?: WorkspaceSyncUploadWorkerDeps['uploadSnapshotRoot'];
  replicaClient?: WorkspaceSyncProjectsClient;

  isRendererReady?: () => boolean;
  applyRemoteLatest?: (input: ApplyRemoteLatestInput) => Promise<void>;
  prepareReplicaApply?: (event: WorkspaceSyncReplicaPreparingNotice) => Promise<string | null>;
  publishReplicaApplied?: (
    preparationId: string | null,
    event: WorkspaceSyncReplicaAppliedNotice
  ) => Promise<void>;
  abortReplicaApply?: (
    preparationId: string | null,
    event: WorkspaceSyncReplicaPreparingNotice & { committed?: boolean }
  ) => void | Promise<void>;
  reconcileReplicaPulls?: () => Promise<{
    recovered: number;
    completed: number;
    quarantined?: ReplicaPullRecoveryResult['quarantined'];
  }>;
  statusPublisher?: Pick<WorkspaceSyncStatusPublisher, 'invalidate'>;
  watcher?: WorkspaceSyncRuntimeWatcher;

  onConflictDetected?: (workspaceUuid: string) => void;
  nowMs?: () => number;
  staleLockMs?: number;
  pollIntervalMs?: number;
  replicaPullIntervalMs?: number;
  maxDrainJobs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxAttempts?: number;
  createJobId?: () => string;
  createDeviceId?: () => string;
  setPollInterval?: (callback: () => void | Promise<void>, intervalMs: number) => unknown;
  clearPollInterval?: (handle: unknown) => void;
  setDebounceTimer?: WorkspaceSyncUploadWorkerDeps['setDebounceTimer'];
  clearDebounceTimer?: WorkspaceSyncUploadWorkerDeps['clearDebounceTimer'];
}

export interface WorkspaceSyncRuntimeStartResult {
  recovery: WorkspaceSyncQueueRecoveryResult;
  drain: WorkspaceSyncRuntimeDrainResult;
  watched: number;
}

export interface WorkspaceSyncRuntimeDrainResult {
  processed: number;
  uploaded: number;
  retryWait: number;
  failed: number;
}

export interface ApplyRemoteLatestInput {
  workspaceId: number;
  workspaceUuid: string;
  repoPath: string;
  remote: DesktopSyncWorkspaceSummaryResponse;
  latest: DesktopSyncMaterializableVersion;

  downloadManifestFile?: WorkspaceSyncProjectsClient['downloadManifestFile'];
  expectedLocalHeadSha: string;
  expectedRemoteVersionId: string;
  nowMs: number;
  onReplicaPreparing?: (event: WorkspaceSyncReplicaPreparingNotice) => Promise<string | null>;
  onReplicaApplied?: (
    preparationId: string | null,
    event: WorkspaceSyncReplicaAppliedNotice
  ) => void | Promise<void>;
  onReplicaAborted?: (
    preparationId: string | null,
    event: WorkspaceSyncReplicaPreparingNotice & { committed?: boolean }
  ) => void | Promise<void>;
}

export interface WorkspaceSyncRuntimePullResult {
  checked: number;
  pulled: number;
  conflicts: number;
  failed: number;
  skipped: number;
}

interface BoundWorkspaceRow {
  workspace_id: number;
  workspace_uuid: string;
  workspace_path: string;
  owner_account_id: string;
  owner_org_id: string | null;
  remote_workspace_id: string;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  remote_latest_content_sha256: string | null;
  last_acked_local_head_sha: string | null;

  remote_owner_account_id: string | null;
  access_role: string | null;
  access_source: string | null;
  shared_with_others: number | null;
}

const DEFAULT_STALE_LOCK_MS = 2 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REPLICA_PULL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_DRAIN_JOBS = 25;

export class WorkspaceSyncRuntime {
  private readonly deviceId: string;
  private readonly uploadWorker: WorkspaceSyncUploadWorker;
  private readonly watcher: WorkspaceSyncRuntimeWatcher;
  private readonly replicaClient: WorkspaceSyncProjectsClient | null;
  private pollHandle: unknown = null;
  private runningStart: Promise<WorkspaceSyncRuntimeStartResult> | null = null;
  private readonly runningWatcherStarts = new Set<{
    workspaceUuid: string;
    ready: Promise<ManagedWorkspaceSyncWatchState | undefined>;
  }>();

  private readonly runningWatcherDrains = new Set<{
    workspaceUuid: string | undefined;
    ready: Promise<void>;
  }>();
  private runningDueUploads: Promise<WorkspaceSyncRuntimeDrainResult> | null = null;
  private runningDrain: Promise<WorkspaceSyncRuntimeDrainResult> | null = null;
  private runningPull: Promise<WorkspaceSyncRuntimePullResult> | null = null;
  private runningPullAbortController: AbortController | null = null;
  private runningReplicaRecovery: Promise<ReplicaPullRecoveryResult> | null = null;
  private replicaRecoveryResult: ReplicaPullRecoveryResult | null = null;
  private lastScheduledReplicaPullAtMs: number | null = null;
  private stopping = false;
  private readonly preReadyChangedWorkspaces = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly deps: WorkspaceSyncRuntimeDeps
  ) {
    this.deviceId =
      deps.deviceId ??
      readOrCreateWorkspaceSyncDeviceId(db, {
        nowMs: () => this.nowMs(),
        createDeviceId: deps.createDeviceId,
      });
    this.uploadWorker = new WorkspaceSyncUploadWorker(db, {
      deviceId: this.deviceId,
      appVersion: deps.appVersion,
      getActiveAccountId: () => this.activeAccountId(),
      getCurrentLocalHeadSha:
        deps.getCurrentLocalHeadSha ?? ((workspace) => resolveHeadCommit(workspace.repoPath)),
      commitWorkingTreeIfDirty:
        deps.commitWorkingTreeIfDirty ??
        (async (repoPath, options) => {
          if (!(await hasWorkspaceSyncWorkingChanges(repoPath, options?.forceInclude))) return null;
          return commitAllIfDirty(repoPath, 'Auto sync: commit local changes before upload', {
            author: await this.gitAuthor(),
            forceInclude: options?.forceInclude,
          });
        }),
      snapshotWorkspace: deps.snapshotWorkspace,
      snapshotUploadWorkspace: deps.snapshotUploadWorkspace,
      verifyUploadCaptureMatchesCommit:
        deps.verifyUploadCaptureMatchesCommit ?? assertWorkspaceSyncUploadCaptureMatchesCommit,
      client: deps.client,
      uploadSnapshotRoot: deps.uploadSnapshotRoot,
      nowMs: () => this.nowMs(),
      retryBaseDelayMs: deps.retryBaseDelayMs,
      retryMaxDelayMs: deps.retryMaxDelayMs,
      maxAttempts: deps.maxAttempts,
      createJobId: deps.createJobId,
      setDebounceTimer: deps.setDebounceTimer,
      clearDebounceTimer: deps.clearDebounceTimer,
      deferAutomaticUpload: (workspaceUuid) => {
        if (!this.deps.isRendererReady || this.deps.isRendererReady()) return false;
        if (!this.stopping) this.preReadyChangedWorkspaces.add(workspaceUuid);
        return true;
      },
      onRunCompleted: (result) => {
        this.invalidateWorkspace(result.job.workspaceId, 'queue_changed');
        this.observeUpload(result);
        if (result.status === 'failed' && result.errorCode === 'CONFLICT') {
          const uuid = this.workspaceUuidFor(result.job.workspaceId);
          const binding = uuid ? readWorkspaceSyncAccessBinding(this.db, uuid) : null;
          if (uuid && binding && isSharedAccessBinding(binding)) {
            this.deps.onConflictDetected?.(uuid);
          }
        }
      },
    });
    this.watcher =
      deps.watcher ??
      new ManagedWorkspaceSyncWatcher(db, {
        onWorkspaceChanged: (event) => {
          this.scheduleWorkspaceChangedWhenReady(event.workspaceUuid);
        },
        statusPublisher: deps.statusPublisher,
        nowMs: () => this.nowMs(),
      });
    this.replicaClient = deps.replicaClient ?? null;
  }

  start(): Promise<WorkspaceSyncRuntimeStartResult> {
    if (this.runningStart) return this.runningStart;
    if (this.stopping) return Promise.resolve(emptyStartResult());
    const start = this.startRuntime();
    this.runningStart = start;
    const clear = (): void => {
      if (this.runningStart === start) this.runningStart = null;
    };
    void start.then(clear, clear);
    return start;
  }

  recoverReplicaPullsBeforeRenderer(): Promise<ReplicaPullRecoveryResult> {
    if (this.replicaRecoveryResult) return Promise.resolve(this.replicaRecoveryResult);
    if (this.runningReplicaRecovery) return this.runningReplicaRecovery;
    reconcileInterruptedWorkspaceRestores(this.db, this.nowMs());
    const recovery = (
      this.deps.reconcileReplicaPulls ?? (() => reconcileInterruptedReplicaPulls(this.db))
    )().then((result) => {
      const normalized: ReplicaPullRecoveryResult = {
        recovered: result.recovered,
        completed: result.completed,
        quarantined: result.quarantined ?? [],
      };
      const recoveredWorkspaceUuids = settleWorkspaceSyncReplicaRecovery(
        this.db,
        new Set(normalized.quarantined.map((entry) => entry.workspaceId)),
        this.nowMs()
      );
      for (const quarantine of normalized.quarantined) {
        this.recordReplicaRecoveryQuarantine(quarantine);
      }
      for (const workspaceUuid of recoveredWorkspaceUuids) {
        this.scheduleWorkspaceChangedWhenReady(workspaceUuid);
      }
      return normalized;
    });
    this.runningReplicaRecovery = recovery;
    void recovery.then(
      (result) => {
        if (this.runningReplicaRecovery !== recovery) return;
        this.replicaRecoveryResult = result;
        this.runningReplicaRecovery = null;
      },
      () => {
        if (this.runningReplicaRecovery === recovery) this.runningReplicaRecovery = null;
      }
    );
    return recovery;
  }

  private async startRuntime(): Promise<WorkspaceSyncRuntimeStartResult> {
    const replicaRecovery = await this.recoverReplicaPullsBeforeRenderer();
    if (
      replicaRecovery.recovered > 0 ||
      replicaRecovery.completed > 0 ||
      replicaRecovery.quarantined.length > 0
    ) {
      console.log('[WorkspaceSyncRuntime] reconciled interrupted replica pulls', replicaRecovery);
    }
    if (this.stopping) {
      return emptyStartResult();
    }
    this.startPoller();

    const recovery = await this.recoverQueue(true);
    if (this.stopping) return { recovery, drain: emptyDrainResult(), watched: 0 };
    const watched = await this.watchBoundWorkspaces();
    if (this.stopping) return { recovery, drain: emptyDrainResult(), watched };
    const drain = await this.drainDueUploads();
    if (this.stopping) return { recovery, drain, watched };
    await this.runScheduledReplicaPull();
    return { recovery, drain, watched };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.preReadyChangedWorkspaces.clear();
    this.stopPoller();
    let watcherFailure: { error: unknown } | undefined;
    let watcherStop: void | Promise<void> = undefined;
    try {
      watcherStop = this.watcher.stopAll();
      this.retainWatcherDrain(undefined, watcherStop);
    } catch (error) {
      this.retainWatcherDrain(undefined, this.watcher.drainFingerprints?.());
      watcherFailure = { error };
    }
    this.uploadWorker.beginStopping();
    this.runningPullAbortController?.abort();
    await this.waitForIdle();
    try {
      await watcherStop;
    } catch (error) {
      watcherFailure = { error };
    }
    await this.uploadWorker.stopAndWaitForIdle();
    this.stopPoller();
    try {
      await this.watcher.stopAll();
    } catch (error) {
      await this.watcher.drainFingerprints?.();
      if (watcherFailure)
        throw new AggregateError([watcherFailure.error, error], 'Workspace watcher cleanup failed');
      throw error;
    }
    if (watcherFailure) throw watcherFailure.error;
  }

  flushWorkspace(
    workspaceUuid: string,
    options?: { force?: boolean }
  ): Promise<WorkspaceSyncUploadRunResult> {
    if (this.stopping) return Promise.resolve({ status: 'idle' });
    return this.uploadWorker.flushWorkspace(workspaceUuid, options);
  }

  ensureWatchingWorkspace(
    workspaceUuid: string
  ): Promise<ManagedWorkspaceSyncWatchState | undefined> {
    if (this.stopping) return Promise.resolve(undefined);
    const start = { workspaceUuid, ready: this.watcher.ensureWatching(workspaceUuid) };
    this.runningWatcherStarts.add(start);
    const settled = () => this.runningWatcherStarts.delete(start);
    void start.ready.then(settled, settled);
    return start.ready;
  }

  stopWatchingWorkspace(workspaceUuid: string): void {
    try {
      this.retainWatcherDrain(workspaceUuid, this.watcher.stopWatching?.(workspaceUuid));
    } catch (error) {
      this.retainWatcherDrain(workspaceUuid, this.watcher.drainFingerprints?.(workspaceUuid));
      throw error;
    }
  }

  private retainWatcherDrain(workspaceUuid: string | undefined, ready: void | Promise<void>): void {
    if (!ready) return;
    const drain = { workspaceUuid, ready };
    this.runningWatcherDrains.add(drain);
    const settled = () => this.runningWatcherDrains.delete(drain);
    void ready.then(settled, settled);
  }

  pauseWorkspace(workspaceUuid: string): void {
    this.uploadWorker.pauseWorkspace(workspaceUuid);
  }

  resumeWorkspace(workspaceUuid: string): void {
    this.uploadWorker.resumeWorkspace(workspaceUuid);
  }

  async waitForIdle(workspaceUuid?: string): Promise<void> {
    do {
      let active = this.activeRuntimePromises(workspaceUuid);
      while (active.length > 0) {
        await Promise.allSettled(active);
        active = this.activeRuntimePromises(workspaceUuid);
      }
      await this.uploadWorker.waitForIdle(workspaceUuid);
    } while (this.activeRuntimePromises(workspaceUuid).length > 0);
  }

  private activeRuntimePromises(workspaceUuid?: string): Promise<unknown>[] {
    const active: Promise<unknown>[] = [];

    if (this.runningStart) active.push(this.runningStart);
    if (this.runningReplicaRecovery) active.push(this.runningReplicaRecovery);
    if (this.runningPull) active.push(this.runningPull);
    if (this.runningDueUploads) active.push(this.runningDueUploads);
    if (this.runningDrain) active.push(this.runningDrain);
    for (const start of this.runningWatcherStarts)
      if (workspaceUuid === undefined || start.workspaceUuid === workspaceUuid)
        active.push(start.ready);
    for (const drain of this.runningWatcherDrains)
      if (
        workspaceUuid === undefined ||
        drain.workspaceUuid === undefined ||
        drain.workspaceUuid === workspaceUuid
      )
        active.push(drain.ready);
    return active;
  }

  invalidateBoundWorkspaces(reason: WorkspaceSyncStatusChangeReason): void {
    for (const row of selectBoundWorkspaceUuids(this.db)) {
      this.deps.statusPublisher?.invalidate(row.workspace_uuid, reason);
    }
  }

  async runDueUploads(): Promise<WorkspaceSyncRuntimeDrainResult> {
    if (this.stopping) return { processed: 0, uploaded: 0, retryWait: 0, failed: 0 };
    if (this.runningDueUploads) return this.runningDueUploads;
    const running = this.recoverAndDrainDueUploads().finally(() => {
      if (this.runningDueUploads === running) this.runningDueUploads = null;
    });
    this.runningDueUploads = running;
    return running;
  }

  private async recoverAndDrainDueUploads(): Promise<WorkspaceSyncRuntimeDrainResult> {
    await this.recoverQueue();
    if (this.stopping) return emptyDrainResult();
    return this.drainDueUploads();
  }

  async pullNewerRemotes(): Promise<WorkspaceSyncRuntimePullResult> {
    if (this.stopping) {
      return { checked: 0, pulled: 0, conflicts: 0, failed: 0, skipped: 0 };
    }
    if (this.runningPull) return this.runningPull;
    const abortController = new AbortController();
    this.runningPullAbortController = abortController;
    const pulling = this.pullRemotes(abortController.signal).finally(() => {
      if (this.runningPull === pulling) this.runningPull = null;
      if (this.runningPullAbortController === abortController) {
        this.runningPullAbortController = null;
      }
    });
    this.runningPull = pulling;
    return pulling;
  }

  private async drainDueUploads(): Promise<WorkspaceSyncRuntimeDrainResult> {
    if (this.runningDrain) return this.runningDrain;
    this.runningDrain = this.drainUploads().finally(() => {
      this.runningDrain = null;
    });
    return this.runningDrain;
  }

  private async recoverQueue(
    reclaimCurrentDeviceLocksOnStartup = false
  ): Promise<WorkspaceSyncQueueRecoveryResult> {
    const activeAccountId = await this.activeAccountId();
    if (this.stopping) return { staleReclaimed: 0, accountBlocked: 0, accountUnblocked: 0 };
    return recoverWorkspaceSyncQueue(this.db, {
      activeAccountId,
      deviceId: this.deviceId,
      nowMs: this.nowMs(),
      staleLockMs: this.deps.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      reclaimCurrentDeviceLocksOnStartup,
      operation: 'upload',
      excludedJobIds: this.uploadWorker.getActiveUploadJobIds(),
    });
  }

  private async replayPendingRendererRefreshBindings(
    bindings: ReturnType<typeof selectBoundWorkspaceUuids>,
    result: WorkspaceSyncRuntimePullResult
  ): Promise<Set<number>> {
    const rendererRefreshBlocked = new Set<number>();
    for (const binding of bindings) {
      if (this.stopping || (await this.activeAccountId()) !== binding.owner_account_id) break;
      let pending: PendingWorkspaceSyncRendererRefresh | null = null;
      try {
        pending = readPendingWorkspaceSyncRendererRefresh(this.db, binding.workspace_id);
        if (!pending) continue;
        await this.replayCommittedRendererRefresh(binding, pending);
        if ((await this.activeAccountId()) !== pending.ownerAccountId) {
          throw new Error('The active account changed during renderer delivery.');
        }
        this.settleRendererRefreshDelivery(binding.workspace_id, pending);
        if (
          readWorkspaceSyncRendererDeliveryStatus(this.db, binding.workspace_id).pendingCount > 0
        ) {
          rendererRefreshBlocked.add(binding.workspace_id);
        } else {
          this.scheduleWorkspaceChangedWhenReady(binding.workspace_uuid);
        }
      } catch (error) {
        rendererRefreshBlocked.add(binding.workspace_id);
        result.checked += 1;
        result.failed += 1;
        this.recordRendererRefreshReplayFailure(binding.workspace_id, pending?.deliveryId, error);
        console.warn(
          `[WorkspaceSyncRuntime] Renderer refresh replay failed for ${binding.workspace_uuid}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return rendererRefreshBlocked;
  }

  async #listWorkspacesForBoundPull(
    client: WorkspaceSyncProjectsClient,
    bindings: BoundWorkspaceRow[],
    rendererRefreshBlocked: Set<number>,
    activeAccountId: string,
    signal: AbortSignal,
    result: WorkspaceSyncRuntimePullResult
  ): Promise<Awaited<ReturnType<WorkspaceSyncProjectsClient['listWorkspaces']>> | null> {
    try {
      return await client.listWorkspaces(signal);
    } catch (error) {
      if (this.stopping || signal.aborted) return null;
      if ((await this.activeAccountId()) !== activeAccountId) return null;
      for (const binding of bindings) {
        if (rendererRefreshBlocked.has(binding.workspace_id)) continue;
        result.checked += 1;
        this.recordReplicaPullFailure(binding, binding.remote_latest_version_id, error);
        result.failed += 1;
        this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
      }
      return null;
    }
  }

  #recordBoundRemoteAdmissionOutcome(
    binding: BoundWorkspaceRow,
    admission: Exclude<ReturnType<typeof admitBoundRemotePull>, { kind: 'pull' }>,
    result: WorkspaceSyncRuntimePullResult
  ): void {
    if (admission.kind === 'fail') {
      this.recordReplicaPullFailure(binding, admission.versionId, admission.error);
      result.failed += 1;
    } else {
      if (admission.clearFailures) {
        settleWorkspaceSyncPullFailures(this.db, binding.workspace_id, this.nowMs());
      }
      result.skipped += 1;
    }
    this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
  }

  private async pullRemotes(signal: AbortSignal): Promise<WorkspaceSyncRuntimePullResult> {
    const result: WorkspaceSyncRuntimePullResult = {
      checked: 0,
      pulled: 0,
      conflicts: 0,
      failed: 0,
      skipped: 0,
    };

    if (this.deps.isRendererReady && !this.deps.isRendererReady()) return result;
    const client = this.replicaClient;
    const activeAccountId = await this.activeAccountId();
    if (!activeAccountId) return result;
    const bindings = selectBoundWorkspaceUuids(this.db, activeAccountId);
    if (bindings.length === 0) return result;
    const rendererRefreshBlocked = await this.replayPendingRendererRefreshBindings(
      bindings,
      result
    );
    if (!client || !activeAccountId) return result;

    if (this.stopping || signal.aborted) return result;
    const remotes = await this.#listWorkspacesForBoundPull(
      client,
      bindings,
      rendererRefreshBlocked,
      activeAccountId,
      signal,
      result
    );
    if (remotes === null) return result;
    if ((await this.activeAccountId()) !== activeAccountId) return result;
    const remoteById = new Map(remotes.map((workspace) => [workspace.workspaceId, workspace]));

    for (const binding of bindings) {
      if (this.stopping) break;
      if ((await this.activeAccountId()) !== activeAccountId) break;
      if (rendererRefreshBlocked.has(binding.workspace_id)) continue;
      result.checked += 1;
      const listedRemote = remoteById.get(binding.remote_workspace_id);
      if (!listedRemote && bindingIsSharedProject(binding)) {
        this.detachForAccessRemoved(binding);
        result.skipped += 1;
        continue;
      }
      if (listedRemote) this.refreshBindingAccess(binding, listedRemote);
      const admission = admitBoundRemotePull(binding, listedRemote);
      if (admission.kind !== 'pull') {
        this.#recordBoundRemoteAdmissionOutcome(binding, admission, result);
        continue;
      }
      const remote = admission.remote;
      if (!this.uploadWorker.beginRemotePull(binding.workspace_uuid)) {
        result.skipped += 1;
        continue;
      }
      let applyStarted = false;
      try {
        if (hasPendingUpload(this.db, binding.workspace_id)) {
          result.skipped += 1;
          continue;
        }
        const localHeadSha = await this.currentLocalHeadSha(binding);
        if (!(await this.localReplicaMatchesAck(binding, localHeadSha))) {
          this.recordIncomingConflict(binding, remote, localHeadSha);
          result.conflicts += 1;
          this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
          continue;
        }

        if (this.stopping || signal.aborted) {
          result.skipped += 1;
          continue;
        }
        let latest: DesktopSyncMaterializableVersion;
        try {
          latest = client.downloadLatestForRestore
            ? await client.downloadLatestForRestore(binding.remote_workspace_id, signal)
            : await client.downloadLatest(binding.remote_workspace_id, signal);
        } catch (error) {
          if (
            !(error instanceof DesktopSyncClientError) ||
            error.code !== 'MANIFEST_RESTORE_REQUIRED' ||
            !remote.latest.versionId ||
            !client.downloadManifestVersion ||
            !client.downloadManifestFile
          ) {
            throw error;
          }

          latest = await client.downloadManifestVersion(
            binding.remote_workspace_id,
            remote.latest.versionId,
            signal
          );
        }
        if (this.stopping || signal.aborted) {
          result.skipped += 1;
          continue;
        }
        if ((await this.activeAccountId()) !== activeAccountId) {
          result.skipped += 1;
          continue;
        }
        assertDownloadedRemoteVersionIsMonotonic(binding, remote, latest);
        const headAfterDownload = await this.currentLocalHeadSha(binding);
        if (
          headAfterDownload !== localHeadSha ||
          !(await this.localReplicaMatchesAck(binding, headAfterDownload))
        ) {
          this.recordIncomingConflict(binding, remote, headAfterDownload);
          result.conflicts += 1;
          this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
          continue;
        }
        if (!localHeadSha || !binding.remote_latest_version_id) {
          throw new Error('Bound local replica lost its acknowledged identity before apply.');
        }
        if (this.stopping || signal.aborted) {
          result.skipped += 1;
          continue;
        }

        const apply = this.deps.applyRemoteLatest ?? defaultApplyRemoteLatest(this.db, client);
        try {
          applyStarted = true;
          await apply({
            workspaceId: binding.workspace_id,
            workspaceUuid: binding.workspace_uuid,
            repoPath: binding.workspace_path,
            remote,
            latest,
            downloadManifestFile: client.downloadManifestFile,
            expectedLocalHeadSha: localHeadSha,
            expectedRemoteVersionId: binding.remote_latest_version_id,
            nowMs: this.nowMs(),
            ...(this.deps.prepareReplicaApply
              ? { onReplicaPreparing: this.deps.prepareReplicaApply }
              : {}),
            ...(this.deps.publishReplicaApplied
              ? { onReplicaApplied: this.deps.publishReplicaApplied }
              : {}),
            ...(this.deps.abortReplicaApply
              ? { onReplicaAborted: this.deps.abortReplicaApply }
              : {}),
          });
        } catch (error) {
          if (!(error instanceof WorkspaceSyncPullConflictError)) throw error;
          this.recordIncomingConflict(binding, remote, await this.currentLocalHeadSha(binding));
          result.conflicts += 1;
          this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
          continue;
        }
        result.pulled += 1;
        observeWorkspaceSync({
          sync_operation: 'pull',
          sync_outcome: 'pulled',
          ...bindingObservationFacts(binding),
          ...workspaceSyncVersionFacts(latest.version),
        });
        settleWorkspaceSyncPullFailures(this.db, binding.workspace_id, this.nowMs());
        this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
      } catch (error) {
        if (!applyStarted && (this.stopping || signal.aborted)) {
          result.skipped += 1;
          break;
        }
        if (!applyStarted && isAccessRemovedError(error) && bindingIsSharedProject(binding)) {
          this.detachForAccessRemoved(binding);
          result.skipped += 1;
          continue;
        }
        if (
          readWorkspaceSyncRendererDeliveryStatus(this.db, binding.workspace_id).pendingCount > 0
        ) {
          recordWorkspaceSyncRendererRefreshFailure(this.db, {
            workspaceId: binding.workspace_id,
            error,
            nowMs: this.nowMs(),
          });
        } else {
          this.recordReplicaPullFailure(binding, remote.latest.versionId, error);
        }
        result.failed += 1;
        this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
        console.warn(
          `[WorkspaceSyncRuntime] Replica pull failed for ${binding.workspace_uuid}:`,
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.uploadWorker.endRemotePull(binding.workspace_uuid);
      }
    }

    return result;
  }

  private settleRendererRefreshDelivery(
    workspaceId: number,
    pending: PendingWorkspaceSyncRendererRefresh
  ): void {
    markWorkspaceSyncRendererRefreshSucceeded(this.db, { delivery: pending, nowMs: this.nowMs() });
    settleWorkspaceSyncPullFailures(this.db, workspaceId, this.nowMs());
    this.invalidateWorkspace(workspaceId, 'queue_changed');
  }

  private recordRendererRefreshReplayFailure(
    workspaceId: number,
    deliveryId: string | undefined,
    error: unknown
  ): void {
    recordWorkspaceSyncRendererRefreshFailure(this.db, {
      workspaceId,
      deliveryId,
      error,
      nowMs: this.nowMs(),
    });
    this.invalidateWorkspace(workspaceId, 'queue_changed');
  }

  async resumeCommittedRendererRefresh(workspaceUuid: string): Promise<void> {
    const binding = selectBoundWorkspaceUuids(this.db).find(
      (row) => row.workspace_uuid === workspaceUuid
    );
    if (!binding || (await this.activeAccountId()) !== binding.owner_account_id)
      throw new Error('Committed replica belongs to another active account.');
    const pending = readPendingWorkspaceSyncRendererRefresh(this.db, binding.workspace_id);
    if (pending) {
      try {
        await this.replayCommittedRendererRefresh(binding, pending);
        this.settleRendererRefreshDelivery(binding.workspace_id, pending);
      } catch (error) {
        this.recordRendererRefreshReplayFailure(binding.workspace_id, pending.deliveryId, error);
        throw error;
      }
    }
  }

  async replayPendingRendererRefreshForTest(
    workspaceId: number
  ): Promise<
    | { state: 'succeeded'; deliveryId: string }
    | { state: 'pending'; deliveryId: string | null; error: string }
    | { state: 'none' }
  > {
    const binding = selectBoundWorkspaceUuids(this.db).find(
      (row) => row.workspace_id === workspaceId
    );
    if (!binding) return { state: 'none' };
    let pending: PendingWorkspaceSyncRendererRefresh | null = null;
    try {
      pending = readPendingWorkspaceSyncRendererRefresh(this.db, workspaceId);
      if (!pending) return { state: 'none' };
      await this.replayCommittedRendererRefresh(binding, pending);
      this.settleRendererRefreshDelivery(workspaceId, pending);
      return { state: 'succeeded', deliveryId: pending.deliveryId };
    } catch (error) {
      this.recordRendererRefreshReplayFailure(workspaceId, pending?.deliveryId, error);
      return {
        state: 'pending',
        deliveryId: pending?.deliveryId ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async replayCommittedRendererRefresh(
    binding: BoundWorkspaceRow,
    pending: PendingWorkspaceSyncRendererRefresh
  ): Promise<void> {
    const notice = pending.notice;
    if (
      notice.workspaceUuid !== binding.workspace_uuid ||
      notice.workspaceRoot !== binding.workspace_path ||
      notice.remoteVersionId !== binding.remote_latest_version_id
    ) {
      throw new Error('Pending renderer refresh does not match the current workspace binding.');
    }
    if (!this.deps.prepareReplicaApply || !this.deps.publishReplicaApplied) {
      throw new Error('Renderer refresh replay is not wired.');
    }
    const releaseMutationLease = await acquireWorkspaceSyncMutationLease(notice.workspaceRoot);
    try {
      const preparationId = await this.deps.prepareReplicaApply({
        workspaceUuid: notice.workspaceUuid,
        workspaceRoot: notice.workspaceRoot,
        remoteVersionId: notice.remoteVersionId,
        affectedNotebookIds: notice.affectedNotebookIds,
        affectedDesignIds: notice.affectedDesignIds,
      });
      if (!preparationId) {
        throw new Error('Renderer is not available for committed replica refresh replay.');
      }
      await this.deps.publishReplicaApplied(preparationId, notice);
    } finally {
      releaseMutationLease();
    }
  }

  private detachForAccessRemoved(binding: BoundWorkspaceRow): void {
    const changed = markWorkspaceSyncAccessRemoved(this.db, {
      workspaceId: binding.workspace_id,
      nowMs: this.nowMs(),
    });
    this.stopWatchingWorkspace(binding.workspace_uuid);
    if (changed) {
      observeWorkspaceSync({
        sync_operation: 'pull',
        sync_outcome: 'access_removed',
        ...bindingObservationFacts(binding),
      });
      console.warn(
        `[WorkspaceSyncRuntime] Access to shared project ${binding.workspace_uuid} ended; local copy kept.`
      );
    }
    this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
  }

  private refreshBindingAccess(
    binding: BoundWorkspaceRow,
    remote: DesktopSyncWorkspaceSummaryResponse
  ): void {
    const access = remoteAccess(remote);
    if (
      updateWorkspaceSyncAccessRecord(this.db, {
        workspaceId: binding.workspace_id,
        role: access.role,
        source: access.source,
        nowMs: this.nowMs(),
      })
    ) {
      binding.access_role = access.role;
      binding.access_source = access.source;
      this.invalidateWorkspace(binding.workspace_id, 'queue_changed');
    }
  }

  private recordIncomingConflict(
    binding: BoundWorkspaceRow,
    remote: DesktopSyncWorkspaceSummaryResponse,
    localHeadSha: string | null
  ): void {
    const nowMs = this.nowMs();
    const job = enqueueWorkspaceSyncJob(this.db, {
      id: this.deps.createJobId?.() ?? randomUUID(),
      workspaceId: binding.workspace_id,
      operation: 'refresh',
      idempotencyKey: `pull-conflict:${binding.workspace_uuid}:${remote.latest.versionId}`,
      baseRemoteVersionId: remote.latest.versionId,
      localHeadSha,
      nowMs,
    });
    markWorkspaceSyncJobFailed(this.db, {
      id: job.id,
      nowMs,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'SYNC_CONFLICT',
      errorMessage: 'Remote has a newer version while this copy has unacknowledged local changes.',
    });
    observeWorkspaceSync(
      {
        sync_operation: 'pull',
        sync_outcome: 'conflict',
        error_code: 'sync_conflict',
        ...bindingObservationFacts(binding),
      },
      `pull-conflict:${binding.workspace_id}:${remote.latest.versionId}`
    );
    if (bindingIsSharedProject(binding)) this.deps.onConflictDetected?.(binding.workspace_uuid);
  }

  private observeUpload(result: Exclude<WorkspaceSyncUploadRunResult, { status: 'idle' }>): void {
    const uuid = this.workspaceUuidFor(result.job.workspaceId);
    const binding = uuid ? readWorkspaceSyncAccessBinding(this.db, uuid) : null;
    const facts = {
      sync_operation: 'upload' as const,
      sync_attempt_count: result.job.attemptCount,
      duration_ms: Math.max(0, this.nowMs() - result.job.createdAt),
      is_first_upload: result.job.baseRemoteVersionId === null,
      ...(binding ? bindingObservationFacts(binding) : {}),
    };
    if (result.status === 'uploaded') {
      observeWorkspaceSync({
        ...facts,
        sync_outcome: result.response.status === 'ready' ? 'uploaded' : result.response.status,
        ...workspaceSyncVersionFacts(result.response.version),
      });
      return;
    }
    const errorCode = workspaceSyncErrorCode(result.errorCode);
    observeWorkspaceSync(
      { ...facts, sync_outcome: result.status, error_code: errorCode },
      result.status === 'retry_wait' ? `upload-retry:${result.job.id}:${errorCode}` : undefined
    );
  }

  private workspaceUuidFor(workspaceId: number): string | null {
    const row = this.db
      .prepare(`SELECT workspace_uuid FROM workspace_sync_bindings WHERE workspace_id = ? LIMIT 1`)
      .get(workspaceId) as { workspace_uuid: string } | undefined;
    return row?.workspace_uuid ?? null;
  }

  private recordReplicaPullFailure(
    binding: BoundWorkspaceRow,
    remoteVersionId: string | null,
    error: unknown
  ): void {
    const nowMs = this.nowMs();
    const retryable = isRetryablePullError(error);
    const pullCode = workspaceSyncErrorCode(
      retryable ? pullErrorCode(error) : 'REMOTE_PULL_INVALID'
    );
    observeWorkspaceSync(
      {
        sync_operation: 'pull',
        sync_outcome: 'failed',
        error_code: pullCode,
        ...bindingObservationFacts(binding),
      },
      `pull-failed:${binding.workspace_id}:${remoteVersionId ?? 'missing'}:${pullCode}`
    );
    const job = enqueueWorkspaceSyncJob(this.db, {
      id: this.deps.createJobId?.() ?? randomUUID(),
      workspaceId: binding.workspace_id,
      operation: 'refresh',
      idempotencyKey: `pull-error:${binding.workspace_uuid}:${remoteVersionId ?? 'missing'}`,
      baseRemoteVersionId: remoteVersionId,
      localHeadSha: binding.last_acked_local_head_sha,
      nowMs,
    });
    markWorkspaceSyncJobFailed(this.db, {
      id: job.id,
      nowMs,
      retryable,
      retryDelayMs: this.deps.replicaPullIntervalMs ?? DEFAULT_REPLICA_PULL_INTERVAL_MS,
      maxAttempts: 1,
      errorCode: retryable ? pullErrorCode(error) : 'REMOTE_PULL_INVALID',
      errorMessage: error instanceof Error ? error.message : 'Could not apply the remote replica.',
    });
  }

  private recordReplicaRecoveryQuarantine(
    quarantine: ReplicaPullRecoveryResult['quarantined'][number]
  ): void {
    const nowMs = this.nowMs();
    const job = enqueueWorkspaceSyncJob(this.db, {
      id: this.deps.createJobId?.() ?? randomUUID(),
      workspaceId: quarantine.workspaceId,
      operation: 'refresh',
      idempotencyKey: `replica-recovery:${quarantine.workspaceUuid}`,
      nowMs,
    });
    markWorkspaceSyncJobFailed(this.db, {
      id: job.id,
      nowMs,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'REPLICA_RECOVERY_REQUIRED',
      errorMessage: `Interrupted cloud replica recovery requires attention: ${quarantine.errorMessage}`,
    });
    this.invalidateWorkspace(quarantine.workspaceId, 'queue_changed');
  }

  private async currentLocalHeadSha(binding: BoundWorkspaceRow): Promise<string | null> {
    if (this.deps.getCurrentLocalHeadSha) {
      return this.deps.getCurrentLocalHeadSha({
        workspaceId: binding.workspace_id,
        workspaceUuid: binding.workspace_uuid,
        repoPath: binding.workspace_path,
        remoteWorkspaceId: binding.remote_workspace_id,
        remoteLatestVersionId: binding.remote_latest_version_id,
      });
    }
    return resolveHeadCommit(binding.workspace_path);
  }

  private async localReplicaMatchesAck(
    binding: BoundWorkspaceRow,
    localHeadSha: string | null
  ): Promise<boolean> {
    if (
      !binding.last_acked_local_head_sha ||
      !binding.remote_latest_version_id ||
      !localHeadSha ||
      localHeadSha !== binding.last_acked_local_head_sha
    ) {
      return false;
    }
    if (hasUnsavedWorkspaceBuffers(getWorkspaceScopedDirtyState(this.db)[binding.workspace_uuid])) {
      return false;
    }
    if (this.deps.hasLocalWorkingChanges) {
      return !(await this.deps.hasLocalWorkingChanges({
        workspaceId: binding.workspace_id,
        workspaceUuid: binding.workspace_uuid,
        repoPath: binding.workspace_path,
        remoteWorkspaceId: binding.remote_workspace_id,
        remoteLatestVersionId: binding.remote_latest_version_id,
      }));
    }
    return !(await hasWorkspaceSyncWorkingChanges(binding.workspace_path));
  }

  private async drainUploads(): Promise<WorkspaceSyncRuntimeDrainResult> {
    const result: WorkspaceSyncRuntimeDrainResult = {
      processed: 0,
      uploaded: 0,
      retryWait: 0,
      failed: 0,
    };
    if (this.deps.isRendererReady && !this.deps.isRendererReady()) return result;
    for (const uuid of this.preReadyChangedWorkspaces) {
      this.preReadyChangedWorkspaces.delete(uuid);
      this.uploadWorker.scheduleWorkspaceChanged(uuid);
    }
    const maxJobs = this.deps.maxDrainJobs ?? DEFAULT_MAX_DRAIN_JOBS;

    for (let i = 0; i < maxJobs; i += 1) {
      if (this.stopping || (this.deps.isRendererReady && !this.deps.isRendererReady())) break;
      const run = await this.uploadWorker.runNext();
      if (run.status === 'idle') break;
      result.processed += 1;
      if (run.status === 'uploaded') result.uploaded += 1;
      if (run.status === 'retry_wait') result.retryWait += 1;
      if (run.status === 'failed') result.failed += 1;
    }

    return result;
  }

  private scheduleWorkspaceChangedWhenReady(workspaceUuid: string): void {
    if (this.stopping) return;
    if (this.deps.isRendererReady && !this.deps.isRendererReady()) {
      this.preReadyChangedWorkspaces.add(workspaceUuid);
      return;
    }
    this.uploadWorker.scheduleWorkspaceChanged(workspaceUuid);
  }

  private async watchBoundWorkspaces(): Promise<number> {
    const rows = selectBoundWorkspaceUuids(this.db);
    let watched = 0;
    for (const row of rows) {
      if (this.stopping) break;
      try {
        await this.watcher.ensureWatching(row.workspace_uuid);
        if (this.stopping || !workspaceBindingIsCurrentlyWatchable(this.db, row)) {
          this.watcher.stopWatching?.(row.workspace_uuid);
          if (this.stopping) break;
          continue;
        }
        watched += 1;
      } catch (error) {
        console.warn(
          `[WorkspaceSyncRuntime] Failed to watch ${row.workspace_uuid}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return watched;
  }

  private startPoller(): void {
    if (this.pollHandle !== null) return;
    const setPollInterval = this.deps.setPollInterval ?? setInterval;
    this.pollHandle = setPollInterval(async () => {
      await this.runDueUploads().catch((error) => {
        console.warn(
          '[WorkspaceSyncRuntime] Upload retry loop failed:',
          error instanceof Error ? error.message : String(error)
        );
      });
      if (this.replicaPullIsDue()) await this.runScheduledReplicaPull();
    }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  private replicaPullIsDue(): boolean {
    if (this.lastScheduledReplicaPullAtMs === null) return true;
    const elapsedMs = this.nowMs() - this.lastScheduledReplicaPullAtMs;
    return (
      elapsedMs < 0 ||
      elapsedMs >= (this.deps.replicaPullIntervalMs ?? DEFAULT_REPLICA_PULL_INTERVAL_MS)
    );
  }

  private async runScheduledReplicaPull(): Promise<void> {
    this.lastScheduledReplicaPullAtMs = this.nowMs();
    await this.pullNewerRemotes().catch((error) => {
      console.warn(
        '[WorkspaceSyncRuntime] Replica pull failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  private stopPoller(): void {
    if (this.pollHandle === null) return;
    const clearPollInterval = this.deps.clearPollInterval ?? clearInterval;
    clearPollInterval(this.pollHandle as never);
    this.pollHandle = null;
  }

  private async gitAuthor(): Promise<{ name: string; email: string } | undefined> {
    const session = await getActiveStoredSession();
    if (!session) return undefined;
    return {
      name: session.displayName ?? session.email ?? 'DNAForge user',
      email: session.email ?? 'workspace@dnaforge.local',
    };
  }

  private async activeAccountId(): Promise<string | null> {
    if (this.deps.getActiveAccountId) return this.deps.getActiveAccountId();
    return (await getActiveStoredSession())?.accountId ?? null;
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private invalidateWorkspace(workspaceId: number, reason: 'queue_changed'): void {
    const row = selectWorkspaceUuidById(this.db, workspaceId);
    if (row) this.deps.statusPublisher?.invalidate(row.workspace_uuid, reason);
  }
}

function emptyDrainResult(): WorkspaceSyncRuntimeDrainResult {
  return { processed: 0, uploaded: 0, retryWait: 0, failed: 0 };
}

function emptyStartResult(): WorkspaceSyncRuntimeStartResult {
  return {
    recovery: { staleReclaimed: 0, accountBlocked: 0, accountUnblocked: 0 },
    drain: emptyDrainResult(),
    watched: 0,
  };
}

function selectBoundWorkspaceUuids(
  db: Database.Database,
  ownerAccountId: string | null = null
): BoundWorkspaceRow[] {
  return db
    .prepare(
      `SELECT b.workspace_id,
              b.workspace_uuid,
              w.path AS workspace_path,
              b.owner_account_id,
              b.owner_org_id,
              b.remote_workspace_id,
              b.remote_latest_version_id,
              b.remote_latest_version_number,
              b.remote_latest_content_sha256,
              b.last_acked_local_head_sha,
              b.remote_owner_account_id,
              b.access_role,
              b.access_source,
              b.shared_with_others
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.enabled = 1
         AND b.remote_workspace_id IS NOT NULL
         AND b.detached_reason IS NULL
         AND (@ownerAccountId IS NULL OR b.owner_account_id = @ownerAccountId)
         AND w.repo_uuid IS NOT NULL
         AND w.archived_at IS NULL
         AND w.trashed_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_sync_queue recovery
           WHERE recovery.workspace_id = b.workspace_id
             AND recovery.error_code IN ('REPLICA_RECOVERY_REQUIRED', 'PACKAGE_RECOVERY_REQUIRED')
             AND recovery.status = 'failed'
         )
       ORDER BY b.workspace_id`
    )
    .all({ ownerAccountId }) as BoundWorkspaceRow[];
}

function workspaceBindingIsCurrentlyWatchable(
  db: Database.Database,
  expected: Pick<BoundWorkspaceRow, 'workspace_id' | 'workspace_uuid' | 'workspace_path'>
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM workspace_sync_bindings b
         JOIN workspaces w ON w.id = b.workspace_id
         WHERE b.workspace_id = ?
           AND b.workspace_uuid = ?
           AND b.enabled = 1
           AND b.remote_workspace_id IS NOT NULL
           AND w.path = ?
           AND w.repo_uuid IS NOT NULL
           AND w.archived_at IS NULL
           AND w.trashed_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_sync_queue recovery
             WHERE recovery.workspace_id = b.workspace_id
               AND recovery.error_code IN ('REPLICA_RECOVERY_REQUIRED', 'PACKAGE_RECOVERY_REQUIRED')
               AND recovery.status = 'failed'
           )
         LIMIT 1`
      )
      .get(expected.workspace_id, expected.workspace_uuid, expected.workspace_path)
  );
}

function admitBoundRemotePull(
  binding: BoundWorkspaceRow,
  remote: DesktopSyncWorkspaceSummaryResponse | undefined
):
  | { kind: 'pull'; remote: DesktopSyncWorkspaceSummaryResponse }
  | { kind: 'fail'; versionId: string | null; error: Error }
  | { kind: 'skip'; clearFailures: boolean } {
  if (!remote) {
    return {
      kind: 'fail',
      versionId: binding.remote_latest_version_id,
      error: new Error('Bound cloud workspace is missing from the authenticated workspace list.'),
    };
  }
  if (!remoteOwnerMatchesBinding(binding, remote)) {
    return {
      kind: 'fail',
      versionId: remote.latest.versionId,
      error: new Error('Cloud workspace owner does not match the bound local replica owner.'),
    };
  }
  if (!remote.latest.versionId) {
    if (
      remote.latest.versionNumber === 0 &&
      remote.latest.contentSha256 === null &&
      remote.versionCount === 0 &&
      binding.remote_latest_version_id === null &&
      binding.remote_latest_version_number === null &&
      binding.remote_latest_content_sha256 === null &&
      binding.last_acked_local_head_sha === null
    ) {
      return { kind: 'skip', clearFailures: false };
    }
    return {
      kind: 'fail',
      versionId: null,
      error: new Error('Bound cloud workspace does not report a latest version.'),
    };
  }
  if (remote.latest.versionId === binding.remote_latest_version_id) {
    if (!remoteVersionIdentityMatchesBinding(binding, remote)) {
      return {
        kind: 'fail',
        versionId: remote.latest.versionId,
        error: new Error('Cloud workspace reused a version id with different version metadata.'),
      };
    }
    return { kind: 'skip', clearFailures: true };
  }
  if (binding.remote_latest_version_number === null) {
    return {
      kind: 'fail',
      versionId: remote.latest.versionId,
      error: new Error('Bound local replica does not record a remote version number.'),
    };
  }
  if (remote.latest.versionNumber <= binding.remote_latest_version_number) {
    return {
      kind: 'fail',
      versionId: remote.latest.versionId,
      error: new Error('Cloud workspace reports a non-newer version under a different id.'),
    };
  }
  return { kind: 'pull', remote };
}

function remoteOwnerMatchesBinding(
  binding: BoundWorkspaceRow,
  remote: DesktopSyncWorkspaceSummaryResponse
): boolean {
  if (remote.owner.kind === 'personal') {
    const expectedOwner = binding.remote_owner_account_id ?? binding.owner_account_id;
    return binding.owner_org_id === null && remote.owner.accountId === expectedOwner;
  }
  return binding.owner_org_id !== null && remote.owner.orgId === binding.owner_org_id;
}

function bindingObservationFacts(binding: {
  owner_org_id: string | null;
  access_source: string | null;
  access_role: string | null;
  shared_with_others: number | null;
}): { is_shared: boolean; sync_access_role: ReturnType<typeof workspaceSyncAccessRole> } {
  return {
    is_shared: isSharedAccessBinding(binding),
    sync_access_role: workspaceSyncAccessRole(binding.access_role),
  };
}

function bindingIsSharedProject(binding: BoundWorkspaceRow): boolean {
  return isSharedAccessBinding({
    owner_org_id: binding.owner_org_id,
    access_source: binding.access_source,
    shared_with_others: binding.shared_with_others,
  });
}

function remoteVersionIdentityMatchesBinding(
  binding: BoundWorkspaceRow,
  remote: DesktopSyncWorkspaceSummaryResponse
): boolean {
  return (
    remote.latest.versionId === binding.remote_latest_version_id &&
    remote.latest.versionNumber === binding.remote_latest_version_number &&
    remote.latest.contentSha256 === binding.remote_latest_content_sha256
  );
}

function assertDownloadedRemoteVersionIsMonotonic(
  binding: BoundWorkspaceRow,
  remote: DesktopSyncWorkspaceSummaryResponse,
  latest: DesktopSyncMaterializableVersion
): void {
  if (latest.workspaceId !== binding.remote_workspace_id) {
    throw new Error('Downloaded cloud version does not match the bound remote workspace.');
  }
  if (
    binding.remote_latest_version_number === null ||
    latest.version.versionNumber <= binding.remote_latest_version_number
  ) {
    throw new Error('Downloaded cloud version is not newer than the bound local replica version.');
  }
  if (latest.version.versionNumber < remote.latest.versionNumber) {
    throw new Error('Downloaded cloud version is older than the listed remote version.');
  }
  if (latest.version.versionNumber !== remote.latest.versionNumber) return;
  if (latest.version.id !== remote.latest.versionId) {
    throw new Error('Downloaded cloud version id does not match the listed remote version.');
  }
  if (remote.latest.contentSha256 && latest.version.contentSha256 !== remote.latest.contentSha256) {
    throw new Error('Downloaded cloud version hash does not match the listed remote version.');
  }
}

function isRetryablePullError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    Boolean((error as { retryable?: unknown }).retryable)
  );
}

function pullErrorCode(error: unknown): 'NETWORK' | 'RATE_LIMITED' | 'SERVER' | 'FEATURE_DISABLED' {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'RATE_LIMITED' || code === 'SERVER' || code === 'FEATURE_DISABLED') return code;
  }
  return 'NETWORK';
}

function hasPendingUpload(db: Database.Database, workspaceId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND operation = 'upload'
         AND status IN ('pending', 'running', 'retry_wait', 'blocked')
       LIMIT 1`
    )
    .get(workspaceId) as { present: number } | undefined;
  return row != null;
}

function defaultApplyRemoteLatest(
  db: Database.Database,
  client: WorkspaceSyncProjectsClient
): (input: ApplyRemoteLatestInput) => Promise<void> {
  return (input) => applyLatestToExistingManagedRepo(db, { ...input, client });
}

function selectWorkspaceUuidById(
  db: Database.Database,
  workspaceId: number
): Pick<BoundWorkspaceRow, 'workspace_id' | 'workspace_uuid'> | null {
  const row = db
    .prepare(
      `SELECT workspace_id, workspace_uuid
       FROM workspace_sync_bindings
       WHERE workspace_id = ?
       LIMIT 1`
    )
    .get(workspaceId) as Pick<BoundWorkspaceRow, 'workspace_id' | 'workspace_uuid'> | undefined;
  return row ?? null;
}
