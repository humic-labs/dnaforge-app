import { cancelWorkspaceSyncJobsForReplacedReplica } from './workspace-sync-queue';
import { userMessage, type UserMessage } from '@waypoint/user-messages';
import {
  acceptWorkspaceSyncRestoreTelemetry,
  settleWorkspaceSyncRestoreTelemetry,
  publishWorkspaceSyncRestoreTelemetry,
} from './workspace-sync-restore-telemetry';
import { createHash, randomUUID } from 'node:crypto';
import { withActiveFilesystemWork } from './active-filesystem-work';
import { flushFile } from './fs-durability';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type Database from 'better-sqlite3';
import type { BlobRef } from '@waypoint/workspace-revisions';
import type { ScientificCloudHistoryV1 } from '@waypoint/scientific-objects';
import {
  parseWorkspaceSyncScientificHistoryMetadata,
  parseScientificCloudResourceIdentities,
  workspaceSyncScientificContentSha256,
} from './workspace-sync-scientific-history';
import {
  classifyShareFile,
  decodeBundleFileContent,
  parseWorkspaceSyncManifest,
  workspaceSyncManifestHashInput,
  workspaceSyncResourceMediaType,
  type WorkspaceSyncBundle,
  type WorkspaceSyncBundleV3,
  type WorkspaceSyncManifestFileV1,
  type WorkspaceSyncStoragePolicy,
  WORKSPACE_SYNC_MANIFEST_READ_LIMITS,
  validateWorkspaceSyncBundle,
  DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES,
} from '@waypoint/share-bundle';

import type {
  WorkspaceSyncActionError,
  WorkspaceSyncOpenProjectResult,
  WorkspaceSyncProjectSummary,
  WorkspaceSyncReplicaAppliedEvent,
  WorkspaceSyncReplicaPreparingEvent,
} from '../shared/workspace-sync-ipc';
import {
  HOSTED_RESOURCE_BINDINGS_PATH,
  serializeHostedResourceBindings,
} from '../shared/hosted-resource-bindings';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { getActiveStoredSession } from './auth/session-store';
import { materializeLimsGitReadableExportInDb } from './lims-git-export';
import {
  readWorkspaceSyncCapturePolicy,
  readWorkspaceSyncStoragePolicy,
} from './workspace-sync-storage-policy';
import {
  DesktopSyncClientError,
  MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
  createDesktopSyncClient,
  type DesktopSyncClient,
} from './desktop-sync-client';
import { MANAGED_WORKSPACE_MARKER } from './workspace-git/import';
import {
  commitAllIfDirty,
  commitPathsIfDirty,
  flushManagedCommitDurably,
  initManagedRepo,
  restoreManagedHeadAndIndex,
  resolveHeadCommit,
} from './workspace-git';
import {
  collectPlasmidPackageGitFiles,
  convertTreeToPlasmidPackages,
} from './workspace-git/convert-tree-to-packages';
import {
  assertValidDesktopSyncLatestBundle,
  markDesktopSyncLatestBundleValidated,
  parseDesktopSyncVersionAuthor,
} from './workspace-sync-bundle-integrity';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { hasWorkspaceSyncWorkingChanges } from './workspace-sync-git-state';
import {
  serializeWorkspaceSyncExcludedSummary,
  toWorkspaceSyncStatusExcludedSummary,
} from './workspace-sync-exclusions';
import {
  LEGACY_LIMS_NOT_IMPORTED_WARNING,
  rehydrateWorkspaceSyncState,
} from './workspace-sync-restore';
import {
  getWorkspaceScopedDirtyState,
  hasUnsavedWorkspaceBuffers,
} from './workspace-sync-dirty-state';
import {
  acquireWorkspaceSyncReplicaApplyLease,
  acquireWorkspaceSyncMutationLease,
} from './workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  assertScientificCloudTransferSupported,
  hasScientificCloudHistoryBinding,
} from './scientific-cloud-admission';
import { recoverMissingScientificRepo } from './scientific-missing-repo-recovery';
import { ScientificObjectStore } from './scientific-object-store';
import {
  downloadScientificWorkspaceCloudHistory,
  installScientificWorkspaceCloudHistory,
} from './scientific-cloud-transfer';
import {
  scientificCloudReplicaWasCommitted,
  recordAppliedCloudVersionInsideTx,
  type ScientificCloudReplicaCommit,
} from './workspace-sync-scientific-commit';
import { parseAndValidateDesktopSyncLatestInDedicatedWorker } from './workspace-sync-latest-worker-client';
import {
  createReplicaPullJournal,
  createReplicaPullStagingJournal,
  replicaPullStagingPrefix,
} from './workspace-sync-replica-journal';
import { previewWorkspaceSyncUploadWithHeldMutationLease } from './workspace-sync-snapshotter';
import {
  readWorkspaceSyncReplicaFiles,
  recordWorkspaceSyncReplicaFiles,
  validateWorkspaceSyncReplicaPaths,
} from './workspace-sync-replica-files';
import {
  markWorkspaceSyncRendererRefreshSucceeded,
  recordPendingWorkspaceSyncRendererRefresh,
  readPendingWorkspaceSyncRendererRefresh,
  recordWorkspaceSyncRendererRefreshFailure,
  readWorkspaceSyncRendererDeliveryStatus,
} from './workspace-sync-renderer-refresh-pending';
import {
  captureWorkspaceSyncBlob,
  hashWorkspaceSyncFileOnDisk,
  materializeWorkspaceSyncFile,
  receiveWorkspaceSyncBlob,
  verifyWorkspaceSyncBlob,
  workspaceSyncBlobPath,
} from './workspace-sync-blob-cache';
import {
  observeWorkspaceSync,
  workspaceSyncAccessRole,
  workspaceSyncErrorCode,
  workspaceSyncVersionFacts,
} from './workspace-sync-observation';

import type {
  DesktopSyncWorkspaceAccessResponse,
  DesktopSyncWorkspaceSummaryResponse,
  DesktopSyncLatestVersionResponse,
  DesktopSyncManifestVersionResponse,
  DesktopSyncMaterializableVersion,
} from './workspace-sync-project-types';
export type {
  DesktopSyncWorkspaceAccessResponse,
  DesktopSyncWorkspaceSummaryResponse,
  DesktopSyncLatestVersionResponse,
  DesktopSyncManifestVersionResponse,
  DesktopSyncMaterializableVersion,
} from './workspace-sync-project-types';

export interface WorkspaceSyncProjectsClient {
  readonly supportsScientificHistory?: boolean;

  assertAccount?(accountId: string): Promise<void>;

  readStoragePolicy?(
    remoteWorkspaceId: string,
    expectedAccountId: string
  ): Promise<WorkspaceSyncStoragePolicy>;

  readVersionPaths?(
    remoteWorkspaceId: string,
    versionId: string,
    signal?: AbortSignal
  ): Promise<string[]>;
  listWorkspaces(signal?: AbortSignal): Promise<DesktopSyncWorkspaceSummaryResponse[]>;
  downloadLatest(
    remoteWorkspaceId: string,
    signal?: AbortSignal
  ): Promise<DesktopSyncLatestVersionResponse>;

  downloadLatestForRestore?(
    remoteWorkspaceId: string,
    signal?: AbortSignal
  ): Promise<DesktopSyncMaterializableVersion>;

  downloadVersion?(
    remoteWorkspaceId: string,
    versionId: string,
    signal?: AbortSignal
  ): Promise<DesktopSyncLatestVersionResponse>;
  downloadManifestVersion?(
    remoteWorkspaceId: string,
    versionId: string,
    signal?: AbortSignal
  ): Promise<DesktopSyncManifestVersionResponse>;
  downloadManifestFile?(
    remoteWorkspaceId: string,
    versionId: string,
    file: WorkspaceSyncManifestFileV1,
    signal?: AbortSignal,
    expectedAccountId?: string
  ): Promise<Response>;
  downloadScientificHistoryBlob?(
    remoteWorkspaceId: string,
    versionId: string,
    blob: BlobRef,
    signal?: AbortSignal,
    expectedAccountId?: string
  ): Promise<Response>;
}

export async function downloadLatestMaterializableVersion(
  client: WorkspaceSyncProjectsClient,
  remote: DesktopSyncWorkspaceSummaryResponse,
  signal?: AbortSignal
): Promise<DesktopSyncMaterializableVersion> {
  if (client.supportsScientificHistory && client.downloadLatestForRestore) {
    const latest = await client.downloadLatestForRestore(remote.workspaceId, signal);
    return scientificManifestDetail(latest) ?? latest;
  }
  try {
    const bundleVersion = await client.downloadLatest(remote.workspaceId, signal);
    return {
      ...bundleVersion,
      bundle: assertValidDesktopSyncLatestBundle(bundleVersion),
    };
  } catch (error) {
    if (!(error instanceof DesktopSyncClientError) || error.code !== 'MANIFEST_RESTORE_REQUIRED') {
      throw error;
    }
    if (!remote.latest.versionId || !client.downloadManifestVersion) {
      throw new Error('This DNAForge version cannot restore manifest-backed projects.');
    }
    return signal === undefined
      ? await client.downloadManifestVersion(remote.workspaceId, remote.latest.versionId)
      : await client.downloadManifestVersion(remote.workspaceId, remote.latest.versionId, signal);
  }
}

export interface OpenWorkspaceSyncProjectInput {
  remoteWorkspaceId: string;
  managedRootDir: string;
  client?: WorkspaceSyncProjectsClient;
  getActiveAccountId?: () => string | null | Promise<string | null>;
  nowMs?: () => number;
  createWorkspaceUuid?: () => string;
  createRestoreLockId?: () => string;
  restoreLockTtlMs?: number;
  replacementCutover?: WorkspaceSyncReplacementCutover;
  durability?: ReplicaDurabilityBarrier;
  withReplacementSourceQuiesced?: WorkspaceSyncReplacementQuiescer;
}

export type WorkspaceSyncReplacementQuiescer = <T>(
  workspaceUuid: string,
  operation: () => Promise<T>
) => Promise<T>;

export interface WorkspaceSyncReplacementCutover {
  sourceWorkspaceId: number;
  remoteWorkspaceId: string;
  commit(): void;
}

interface ExistingBindingRow {
  workspace_uuid: string;
  workspace_id: number;
  path: string;
  remote_workspace_id: string;
  enabled: number;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  remote_latest_content_sha256: string | null;
  last_acked_local_head_sha: string | null;
  last_downloaded_at: number | null;
}

interface WorkspaceCollisionRow {
  id: number;
  repo_uuid: string | null;
}

interface RemoteVersionCollisionRow {
  workspace_id: number;
  workspace_uuid: string | null;
}

interface ReusableRestoreIntentRow {
  workspace_id: number;
  workspace_uuid: string;
  workspace_path: string;
  lock_id: string;
  source_remote_version_id: string | null;
  remote_workspace_id: string;
  owner_account_id: string;
  owner_org_id: string | null;
  status: 'failed';
}

interface FreshRestoreIntent {
  reusable: false;
  workspaceUuid: string;
  workspaceId: number;
  workspacePath: string;
  lockId: string;
}

interface RestartedRestoreIntent {
  reusable: true;
  workspaceUuid: string;
  workspaceId: number;
  workspacePath: string;
  lockId: string;
}

type WorkspaceRestoreIntent = FreshRestoreIntent | RestartedRestoreIntent;

interface RestoreIntentCreationInput {
  managedRootDir: string;
  remote: DesktopSyncWorkspaceSummaryResponse;
  latest: DesktopSyncMaterializableVersion;
  ownerAccountId: string;
  nowMs: number;
  createWorkspaceUuid?: () => string;
  createRestoreLockId?: () => string;
  restoreLockTtlMs?: number;
}

interface CompletedRestoreLockRow {
  lock_id: string;
}

interface WorkspaceIdentityRow {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  origin_path: string | null;
}

const REPLACEMENT_ARCHIVED_PROJECTION_TABLES = new Set([
  'workspace_sync_renderer_deliveries',

  'workspace_sync_merge_conflicts',
  'indexed_files',
  'graph_nodes',
  'graph_edges',
  'primers',
  'catalog_entities',
  'catalog_entity_files',

  'catalog_workspace_placements',

  'workspace_sync_merge_conflicts',
]);

const REPLACEMENT_PRIVATE_AUTHORITY_TABLES = new Set([
  'scientific_workspace_identities',
  'native_catalog_publication_outbox',

  'scientific_revision_records',
  'scientific_revision_refs',
  'scientific_revision_blobs',
  'scientific_materialization_jobs',
]);

function assertReplacementPrivateAuthorityEmpty(db: Database.Database, workspaceId: number): void {
  if (readWorkspaceSyncRendererDeliveryStatus(db, workspaceId).pendingCount > 0) {
    throw new Error(
      'Cannot replace this local workspace while its committed screen delivery needs recovery.'
    );
  }
  for (const table of REPLACEMENT_PRIVATE_AUTHORITY_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
      continue;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? LIMIT 1`).get(workspaceId)) {
      throw new Error(
        table.startsWith('scientific_')
          ? 'Cannot replace this local workspace: preserve its accepted scientific history and delivery receipts in the original project.'
          : 'Cannot replace this local workspace: preserve its pending publication in the original workspace first.'
      );
    }
  }
}

const REPLACEMENT_ACTIVE_IDENTITY_TABLES = new Set([
  'lims_schema',
  'lims_schema_revision',
  'lims_entity',
  'lims_link',
  'lims_audit',

  'workspace_sync_bindings',
  'workspace_sync_queue',
  'workspace_sync_versions',
  'workspace_sync_restore_locks',

  'workspace_sync_merge_conflicts',
]);

const DEFAULT_RESTORE_LOCK_TTL_MS = 10 * 60_000;

export class WorkspaceSyncPullConflictError extends Error {
  readonly code = 'SYNC_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSyncPullConflictError';
  }
}

class MissingLocalReplicaError extends Error {
  constructor() {
    super('The synced project binding points to a missing local workspace.');
    this.name = 'MissingLocalReplicaError';
  }
}

class UnusableReusableRestorePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableReusableRestorePathError';
  }
}

type ReplicaRenameFile = (sourcePath: string, destinationPath: string) => Promise<void>;
type ReplicaInstallFile = (sourcePath: string, destinationPath: string) => Promise<void>;

export interface ReplicaDurabilityBarrier {
  flushFile(path: string): Promise<void>;
  flushDirectory(path: string): Promise<void>;
  flushGitCommit(repoPath: string, commitOid: string, paths: readonly string[]): Promise<void>;
}

const DEFAULT_REPLICA_DURABILITY: ReplicaDurabilityBarrier = {
  flushFile: flushReplicaFileRequired,
  flushDirectory: flushReplicaDirectoryBestEffort,
  flushGitCommit: flushManagedCommitDurably,
};

const workspaceProjectOpenTails = new Map<string, Promise<void>>();

async function withWorkspaceSyncDatabaseFence<T>(
  db: Database.Database,
  operation: () => T | Promise<T>
): Promise<T> {
  const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    return await operation();
  } finally {
    releaseFence();
  }
}

export async function listWorkspaceSyncProjects(
  client: WorkspaceSyncProjectsClient = createWorkspaceSyncProjectsClient()
): Promise<WorkspaceSyncProjectSummary[]> {
  const workspaces = await client.listWorkspaces();
  return workspaces.map(toProjectSummary);
}

export async function openWorkspaceSyncProject(
  db: Database.Database,
  input: OpenWorkspaceSyncProjectInput
): Promise<WorkspaceSyncOpenProjectResult> {
  const previous = workspaceProjectOpenTails.get(input.remoteWorkspaceId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const tail = previous.then(() => current);
  workspaceProjectOpenTails.set(input.remoteWorkspaceId, tail);

  await previous;
  try {
    return await openWorkspaceSyncProjectSerialized(db, input);
  } finally {
    releaseCurrent();
    publishWorkspaceSyncRestoreTelemetry(db);
    if (workspaceProjectOpenTails.get(input.remoteWorkspaceId) === tail) {
      workspaceProjectOpenTails.delete(input.remoteWorkspaceId);
    }
  }
}

async function openWorkspaceSyncProjectSerialized(
  db: Database.Database,
  input: OpenWorkspaceSyncProjectInput
): Promise<WorkspaceSyncOpenProjectResult> {
  const startedAt = nowMs(input);
  const restoreDuration = () => Math.max(0, nowMs(input) - startedAt);
  try {
    const existing = await withWorkspaceSyncDatabaseFence(db, () =>
      selectBindingByRemoteWorkspaceId(db, input.remoteWorkspaceId)
    );
    let replacementCutover = input.replacementCutover;
    if (input.replacementCutover) {
      if (
        input.replacementCutover.remoteWorkspaceId !== input.remoteWorkspaceId ||
        existing?.workspace_id !== input.replacementCutover.sourceWorkspaceId
      ) {
        throw new Error('The synced project binding changed before replacement could begin.');
      }
    } else if (existing) {
      try {
        if (
          hasScientificCloudHistoryBinding(db, existing.workspace_id) &&
          db
            .prepare('SELECT 1 FROM settings WHERE key=?')
            .get(`scientific-missing-repo-recovery:${existing.workspace_id}`)
        )
          throw new MissingLocalReplicaError();
        await assertExistingBindingUsable(existing, input.remoteWorkspaceId);
      } catch (error) {
        if (!(error instanceof MissingLocalReplicaError)) throw error;
        if (hasScientificCloudHistoryBinding(db, existing.workspace_id)) {
          if (!input.withReplacementSourceQuiesced)
            throw new Error('Scientific repository recovery requires its native runtime owner.');
          await input.withReplacementSourceQuiesced(existing.workspace_uuid, () =>
            withActiveFilesystemWork(() =>
              recoverMissingScientificRepo(db, {
                workspaceId: existing.workspace_id,
                workspaceUuid: existing.workspace_uuid,
                repoPath: existing.path,
                managedRootDir: input.managedRootDir,
              })
            )
          );
          await assertExistingBindingUsable(existing, input.remoteWorkspaceId);
          return {
            ok: true,
            workspaceUuid: existing.workspace_uuid,
            warnings: [userMessage('sync.repositoryRebuilt')],
          };
        }
        const repairNowMs = nowMs(input);
        replacementCutover = {
          sourceWorkspaceId: existing.workspace_id,
          remoteWorkspaceId: input.remoteWorkspaceId,
          commit: () =>
            commitMissingLocalReplicaRepair(db, existing, input.remoteWorkspaceId, repairNowMs),
        };
      }
      if (!replacementCutover) {
        await withWorkspaceSyncDatabaseFence(db, async () => {
          assertBindingSnapshotCurrent(db, existing);
          await cleanupCompletedRestoreRecoveryBestEffort(db, {
            binding: existing,
            managedRootDir: input.managedRootDir,
            remoteWorkspaceId: input.remoteWorkspaceId,
            durability: input.durability ?? DEFAULT_REPLICA_DURABILITY,
          });
          db.prepare(
            `UPDATE workspaces
             SET last_opened_at = ?, archived_at = NULL, trashed_at = NULL
             WHERE id = ?`
          ).run(nowMs(input), existing.workspace_id);
        });
        observeWorkspaceSync({
          sync_operation: 'restore',
          sync_outcome: 'reused_local',
          duration_ms: restoreDuration(),
        });
        return { ok: true, workspaceUuid: existing.workspace_uuid };
      }
    }

    const restoreRemoteProject = (): Promise<WorkspaceSyncOpenProjectResult> =>
      withActiveFilesystemWork(async () => {
        if (replacementCutover && existing) {
          await withWorkspaceSyncDatabaseFence(db, async () => {
            assertBindingSnapshotCurrent(db, existing);
            assertReplacementPrivateAuthorityEmpty(db, existing.workspace_id);
            await cleanupCompletedRestoreRecovery(db, {
              binding: existing,
              managedRootDir: input.managedRootDir,
              remoteWorkspaceId: input.remoteWorkspaceId,
              durability: input.durability ?? DEFAULT_REPLICA_DURABILITY,
            });
          });
        }
        const client = input.client ?? createWorkspaceSyncProjectsClient();
        const remote = (await client.listWorkspaces()).find(
          (workspace) => workspace.workspaceId === input.remoteWorkspaceId
        );
        if (!remote) {
          observeWorkspaceSync({
            sync_operation: 'restore',
            sync_outcome: 'failed',
            error_code: 'not_found',
            duration_ms: restoreDuration(),
          });
          return actionError('Synced project is not available for this account.');
        }

        const replicaAccountId = await ownerAccountId(input, remote);
        if (client.readStoragePolicy) {
          await readWorkspaceSyncCapturePolicy(db, {
            remoteWorkspaceId: remote.workspaceId,
            expectedAccountId: replicaAccountId,
            readPolicy: () => client.readStoragePolicy!(remote.workspaceId, replicaAccountId),
            runDatabase: (operation) => withWorkspaceSyncDatabaseFence(db, operation),
          });
        }

        const latest = client.downloadLatestForRestore
          ? await client.downloadLatestForRestore(remote.workspaceId)
          : await downloadLatestMaterializableVersion(client, remote);
        assertDownloadedLatestNotOlderThanSummary(remote, latest);
        if ((await ownerAccountId(input, remote)) !== replicaAccountId) {
          throw new Error('The signed-in account changed while opening the synced project.');
        }

        const materialized = await materializeSyncedWorkspace(db, {
          managedRootDir: input.managedRootDir,
          remote,
          latest,
          downloadManifestFile: client.downloadManifestFile,
          ownerAccountId: replicaAccountId,
          nowMs: nowMs(input),
          readClock: () => nowMs(input),
          createWorkspaceUuid: input.createWorkspaceUuid,
          createRestoreLockId: input.createRestoreLockId,
          restoreLockTtlMs: input.restoreLockTtlMs,
          replacementCutover,
          durability: input.durability,
          client,
        });
        observeWorkspaceSync({
          sync_operation: 'restore',
          sync_outcome: 'restored',
          duration_ms: restoreDuration(),
          is_shared: remote.owner.kind === 'org' || (remote.access?.source ?? 'owner') !== 'owner',
          sync_access_role: workspaceSyncAccessRole(remote.access?.role),
          ...workspaceSyncVersionFacts(latest.version),
        });
        return {
          ok: true,
          workspaceUuid: materialized.workspaceUuid,
          ...(materialized.warnings.length > 0 ? { warnings: materialized.warnings } : {}),
        };
      });

    if (replacementCutover && existing) {
      if (!input.withReplacementSourceQuiesced) {
        throw new Error('Replacing a synced local copy requires the workspace sync runtime.');
      }
      return await input.withReplacementSourceQuiesced(
        existing.workspace_uuid,
        restoreRemoteProject
      );
    }
    return await restoreRemoteProject();
  } catch (error) {
    observeWorkspaceSync({
      sync_operation: 'restore',
      sync_outcome: 'failed',
      error_code: workspaceSyncErrorCode(error),
      duration_ms: restoreDuration(),
    });
    return actionError(error instanceof Error ? error.message : 'Could not open synced project.');
  }
}

async function assertExistingBindingUsable(
  binding: ExistingBindingRow,
  remoteWorkspaceId: string
): Promise<void> {
  let stats;
  try {
    stats = await Promise.all([
      lstat(binding.path),
      lstat(join(binding.path, '.git')),
      lstat(join(binding.path, MANAGED_WORKSPACE_MARKER)),
    ]);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') throw new MissingLocalReplicaError();
    throw error;
  }
  const [repoStat, gitStat, markerStat] = stats;
  if (
    repoStat.isSymbolicLink() ||
    !repoStat.isDirectory() ||
    gitStat.isSymbolicLink() ||
    !gitStat.isDirectory() ||
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    markerStat.size > 64 * 1024
  ) {
    throw new Error('The synced project binding points to an invalid local workspace.');
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(binding.path, MANAGED_WORKSPACE_MARKER), 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') throw new MissingLocalReplicaError();
    if (error instanceof SyntaxError) {
      throw new Error('The synced project binding has an invalid local workspace marker.');
    }
    throw error;
  }
  if (
    !isRecord(marker) ||
    marker.schema !== 1 ||
    marker.workspaceUuid !== binding.workspace_uuid ||
    (marker.restoredFromRemoteWorkspaceId !== undefined &&
      marker.restoredFromRemoteWorkspaceId !== remoteWorkspaceId)
  ) {
    throw new Error('The synced project binding has an invalid local workspace marker.');
  }
}

export function createWorkspaceSyncProjectsClient(
  client: DesktopSyncClient = createDesktopSyncClient()
): WorkspaceSyncProjectsClient {
  const downloadManifestDetail = async (
    workspaceId: string,
    versionId: string | null,
    signal?: AbortSignal,
    accountId?: string
  ): Promise<DesktopSyncManifestVersionResponse> => {
    const base = `/api/desktop-sync/workspaces/${encodeURIComponent(workspaceId)}`;
    const response = await client.requestJson<unknown>(
      versionId
        ? `${base}/versions/${encodeURIComponent(versionId)}/manifest`
        : `${base}/latest/manifest`,
      {
        method: 'GET',
        signal,
        expectedAccountId: accountId,
        maxResponseBytes: DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES,
      }
    );
    const returnedId =
      isRecord(response) && isRecord(response.version) && typeof response.version.id === 'string'
        ? response.version.id
        : '';
    const detail = parseDesktopSyncManifestVersionResponse(
      response,
      workspaceId,
      versionId ?? returnedId
    );
    if (accountId) await client.assertAccount?.(accountId);
    return detail;
  };
  const downloadManifestBundle = async (
    workspaceId: string,
    versionId: string | null,
    signal?: AbortSignal
  ): Promise<DesktopSyncLatestVersionResponse> => {
    const accountId = await client.getAccountId?.();
    const base = `/api/desktop-sync/workspaces/${encodeURIComponent(workspaceId)}`;
    const detail = await downloadManifestDetail(workspaceId, versionId, signal, accountId);
    if (detail.scientificHistory)
      throw invalidDesktopSyncResponse(
        'Scientific history cannot be converted to a file-only cloud bundle.'
      );
    const bundle = await materializeManifestBlobBundle({
      detail,
      workspace: { id: workspaceId, name: 'Synced project' },
      signal,
      beforeFile: async () => {
        if (accountId) await client.assertAccount?.(accountId);
      },
      downloadFile: (file) =>
        client.requestStream(
          `${base}/versions/${encodeURIComponent(detail.version.id)}/files?path=${encodeURIComponent(file.path)}`,
          { method: 'GET', signal, expectedAccountId: accountId, timeoutMs: 30 * 60_000 }
        ),
    });
    if (accountId) await client.assertAccount?.(accountId);
    const latest = { workspaceId, version: detail.version, bundle };
    assertValidDesktopSyncLatestBundle(latest);
    markDesktopSyncLatestBundleValidated(latest);
    return latest;
  };
  return {
    supportsScientificHistory: true,
    assertAccount: async (accountId) => {
      if (!client.assertAccount)
        throw invalidDesktopSyncResponse('Scientific transfer requires an account-fenced client.');
      await client.assertAccount(accountId);
    },
    readStoragePolicy: (remoteWorkspaceId, expectedAccountId) =>
      readWorkspaceSyncStoragePolicy(client, remoteWorkspaceId, expectedAccountId),
    readVersionPaths: async (remoteWorkspaceId, versionId, signal) => {
      const accountId = await client.getAccountId?.();
      const base = `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}/versions/${encodeURIComponent(versionId)}`;
      let latest: DesktopSyncLatestVersionResponse;
      try {
        latest = await client.requestJson<DesktopSyncLatestVersionResponse>(base, {
          method: 'GET',
          signal,
          expectedAccountId: accountId,
          maxResponseBytes: MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
          parseResponse: (bytes) =>
            parseAndValidateDesktopSyncLatestInDedicatedWorker(bytes, { signal }),
        });
      } catch (error) {
        if (
          !(error instanceof DesktopSyncClientError) ||
          error.code !== 'MANIFEST_RESTORE_REQUIRED'
        )
          throw error;
        const response = await client.requestJson<unknown>(`${base}/manifest`, {
          method: 'GET',
          signal,
          expectedAccountId: accountId,
        });
        const detail = parseDesktopSyncManifestVersionResponse(
          response,
          remoteWorkspaceId,
          versionId
        );
        return validateWorkspaceSyncReplicaPaths(detail.manifest.files.map((file) => file.path));
      }
      if (latest.workspaceId !== remoteWorkspaceId || latest.version.id !== versionId) {
        throw invalidDesktopSyncResponse('The accepted sync version does not match this project.');
      }
      const bundle = assertValidDesktopSyncLatestBundle(latest);
      const stagingRoot = await mkdtemp(
        join((await import('node:os')).tmpdir(), 'dnaforge-sync-base-paths-')
      );
      try {
        await materializeWorkspaceSyncBundleFiles(stagingRoot, bundle);
        const conversion = await convertTreeToPlasmidPackages(stagingRoot);
        if (conversion.failures.length)
          throw invalidDesktopSyncResponse('The accepted sync version cannot be classified.');
        return validateWorkspaceSyncReplicaPaths([
          ...bundle.files.map((file) => file.relativePath),
          ...conversion.mutatedGitFiles,
        ]);
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    },
    listWorkspaces: async (signal) => {
      const accountId = await client.getAccountId?.();
      const workspaces: DesktopSyncWorkspaceSummaryResponse[] = [];
      const seen = new Set<string>();
      let after: string | null = null;

      for (let page = 0; page < 500; page++) {
        const query = new URLSearchParams({ format: 'paged-v1', limit: '200' });
        if (after) query.set('after', after);
        const response = await client.requestJson<unknown>(
          `/api/desktop-sync/workspaces?${query.toString()}`,
          { method: 'GET', signal, expectedAccountId: accountId, maxResponseBytes: 2 * 1024 * 1024 }
        );
        if (!isWorkspaceListResponse(response))
          throw invalidDesktopSyncResponse('Desktop sync returned an invalid workspace list.');
        const envelope = response as Record<string, unknown> & typeof response;
        if (envelope.format === undefined) {
          if (after || response.workspaces.length >= 1000)
            throw invalidDesktopSyncResponse(
              'Update the cloud service to load the complete project list.'
            );
          if (accountId) await client.assertAccount?.(accountId);
          return response.workspaces;
        }
        const rows = response.workspaces;
        if (
          envelope.format !== 'paged-v1' ||
          rows.length > 200 ||
          typeof envelope.hasMore !== 'boolean' ||
          (envelope.hasMore
            ? rows.length === 0 || envelope.nextCursor !== rows.at(-1)?.workspaceId
            : envelope.nextCursor !== null)
        )
          throw invalidDesktopSyncResponse('Desktop sync returned an invalid project page.');
        let previous = after;
        for (const row of rows) {
          const id = row.workspaceId.toLowerCase();
          if (seen.has(id) || (previous && id <= previous))
            throw invalidDesktopSyncResponse('Desktop sync repeated or reordered a project page.');
          seen.add(id);
          previous = id;
          workspaces.push(row);
        }
        if (!envelope.hasMore) {
          if (accountId) await client.assertAccount?.(accountId);
          return workspaces;
        }
        after = (envelope.nextCursor as string).toLowerCase();
      }
      throw invalidDesktopSyncResponse(
        'The cloud project list exceeds the supported directory boundary.'
      );
    },
    downloadLatestForRestore: async (remoteWorkspaceId, signal) => {
      const accountId = await client.getAccountId?.();
      try {
        const latest = await client.requestJson<DesktopSyncLatestVersionResponse>(
          `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}/latest`,
          {
            method: 'GET',
            signal,
            expectedAccountId: accountId,
            maxResponseBytes: MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
            parseResponse: (bytes) =>
              parseAndValidateDesktopSyncLatestInDedicatedWorker(bytes, { signal }),
          }
        );
        if (accountId) await client.assertAccount?.(accountId);
        markDesktopSyncLatestBundleValidated(latest);
        return latest;
      } catch (error) {
        if (
          !(error instanceof DesktopSyncClientError) ||
          error.code !== 'MANIFEST_RESTORE_REQUIRED'
        )
          throw error;
        return downloadManifestDetail(remoteWorkspaceId, null, signal, accountId);
      }
    },
    downloadLatest: async (remoteWorkspaceId, signal) => {
      try {
        const latest = await client.requestJson<DesktopSyncLatestVersionResponse>(
          `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}/latest`,
          {
            method: 'GET',
            signal,
            maxResponseBytes: MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
            parseResponse: (bytes) =>
              parseAndValidateDesktopSyncLatestInDedicatedWorker(bytes, { signal }),
          }
        );
        markDesktopSyncLatestBundleValidated(latest);
        return latest;
      } catch (error) {
        if (
          !(error instanceof DesktopSyncClientError) ||
          error.code !== 'MANIFEST_RESTORE_REQUIRED'
        )
          throw error;
        return downloadManifestBundle(remoteWorkspaceId, null, signal);
      }
    },
    downloadVersion: async (remoteWorkspaceId, versionId, signal) => {
      try {
        const version = await client.requestJson<DesktopSyncLatestVersionResponse>(
          `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}/versions/${encodeURIComponent(versionId)}`,
          {
            method: 'GET',
            signal,
            maxResponseBytes: MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES,
            parseResponse: (bytes) =>
              parseAndValidateDesktopSyncLatestInDedicatedWorker(bytes, { signal }),
          }
        );
        markDesktopSyncLatestBundleValidated(version);
        return version;
      } catch (error) {
        if (
          !(error instanceof DesktopSyncClientError) ||
          error.code !== 'MANIFEST_RESTORE_REQUIRED'
        )
          throw error;
        return downloadManifestBundle(remoteWorkspaceId, versionId, signal);
      }
    },
    downloadManifestVersion: async (remoteWorkspaceId, versionId, signal) => {
      const accountId = await client.getAccountId?.();
      return downloadManifestDetail(remoteWorkspaceId, versionId, signal, accountId);
    },
    downloadManifestFile: (remoteWorkspaceId, versionId, file, signal, expectedAccountId) =>
      client.requestStream(
        `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}` +
          `/versions/${encodeURIComponent(versionId)}/files?path=${encodeURIComponent(file.path)}`,
        {
          method: 'GET',
          signal,
          timeoutMs: 10 * 60 * 1000,
          expectedAccountId,
        }
      ),
    downloadScientificHistoryBlob: async (
      remoteWorkspaceId,
      versionId,
      blob,
      signal,
      expectedAccountId
    ) => {
      const accountId = expectedAccountId ?? (await client.getAccountId?.());
      const response = await client.requestStream(
        `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}` +
          `/versions/${encodeURIComponent(versionId)}/scientific-blobs/${encodeURIComponent(blob.hash.slice('sha256:'.length))}`,
        { method: 'GET', signal, expectedAccountId: accountId, timeoutMs: 30 * 60_000 }
      );
      if (accountId) await client.assertAccount?.(accountId);
      return response;
    },
  };
}

export function parseDesktopSyncManifestVersionResponse(
  value: unknown,
  expectedWorkspaceId: string,
  expectedVersionId: string
): DesktopSyncManifestVersionResponse {
  if (!isRecord(value) || !isRecord(value.version) || value.workspaceId !== expectedWorkspaceId) {
    throw invalidDesktopSyncResponse('Desktop sync returned an invalid workspace manifest.');
  }
  const parsed = parseWorkspaceSyncManifest(value.manifest);
  if (!parsed.ok) {
    throw invalidDesktopSyncResponse('Desktop sync returned an invalid workspace manifest.');
  }
  const version = parseDesktopSyncManifestVersionDescriptor(value.version, expectedVersionId);
  const manifestSha256 = createHash('sha256')
    .update(workspaceSyncManifestHashInput(parsed.manifest), 'utf8')
    .digest('hex');
  const manifestBytes = parsed.manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
  const scientific =
    version.representation === 'scientific_manifest_v1'
      ? parseWorkspaceSyncScientificHistoryMetadata(
          {
            scientificHistory: value.scientificHistory,
            scientificBlobRefs: value.scientificBlobRefs,
            fileManifestSha256: version.fileManifestSha256,
          },
          manifestSha256
        )
      : null;
  if (
    (!scientific &&
      (value.scientificHistory !== undefined || value.scientificBlobRefs !== undefined)) ||
    (version.representation === 'scientific_manifest_v1' && !scientific)
  )
    throw invalidDesktopSyncResponse(
      'Desktop sync returned incomplete or downgraded scientific authority.'
    );
  if (
    version.fileCount !== parsed.manifest.files.length ||
    version.sizeBytes !== manifestBytes ||
    version.contentSha256 !==
      (scientific
        ? workspaceSyncScientificContentSha256(manifestSha256, scientific.scientificHistory)
        : manifestSha256)
  ) {
    throw invalidDesktopSyncResponse('Desktop sync returned an inconsistent workspace manifest.');
  }
  if (!Array.isArray(value.resourceIdentities)) {
    throw invalidDesktopSyncResponse('Desktop sync returned invalid resource identities.');
  }
  const resources = scientific
    ? parseScientificCloudResourceIdentities(value.resourceIdentities, parsed.manifest)
    : value.resourceIdentities.map((candidate) => {
        if (
          !isRecord(candidate) ||
          typeof candidate.path !== 'string' ||
          typeof candidate.resourceId !== 'string' ||
          !isWorkspaceSyncRemoteUuid(candidate.resourceId)
        ) {
          throw invalidDesktopSyncResponse('Desktop sync returned invalid resource identities.');
        }
        return { path: candidate.path, resourceId: candidate.resourceId };
      });
  const paths = new Set(parsed.manifest.files.map((file) => file.path));
  if (
    resources.length !== paths.size ||
    new Set(resources.map((resource) => resource.path)).size !== resources.length ||
    new Set(resources.map((resource) => resource.resourceId)).size !== resources.length ||
    resources.some((resource) => !paths.has(resource.path))
  ) {
    throw invalidDesktopSyncResponse('Desktop sync returned inconsistent resource identities.');
  }
  return {
    workspaceId: expectedWorkspaceId,
    version,
    manifest: parsed.manifest,
    resourceIdentities: resources,
    ...(scientific
      ? {
          scientificHistory: scientific.scientificHistory,
          scientificBlobRefs: scientific.scientificBlobRefs,
        }
      : {}),
  };
}

function parseDesktopSyncManifestVersionDescriptor(
  version: Record<string, unknown>,
  expectedVersionId: string
): DesktopSyncManifestVersionResponse['version'] {
  if (
    version.id !== expectedVersionId ||
    (version.representation !== 'manifest_v1' &&
      version.representation !== 'scientific_manifest_v1') ||
    (version.representation === 'scientific_manifest_v1' &&
      (typeof version.fileManifestSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(version.fileManifestSha256))) ||
    version.manifestSchemaVersion !== 1 ||
    !isNonNegativeInteger(version.versionNumber) ||
    typeof version.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(version.contentSha256) ||
    !isNonNegativeInteger(version.sizeBytes) ||
    !isNonNegativeInteger(version.fileCount) ||
    typeof version.createdAt !== 'string' ||
    Number.isNaN(Date.parse(version.createdAt)) ||
    typeof version.finalizedAt !== 'string' ||
    Number.isNaN(Date.parse(version.finalizedAt))
  ) {
    throw invalidDesktopSyncResponse('Desktop sync returned an invalid workspace manifest.');
  }
  return {
    id: expectedVersionId,
    versionNumber: version.versionNumber,
    contentSha256: version.contentSha256,
    sizeBytes: version.sizeBytes,
    fileCount: version.fileCount,
    createdAt: version.createdAt,
    representation: version.representation,
    ...(version.representation === 'scientific_manifest_v1'
      ? { fileManifestSha256: version.fileManifestSha256 as string }
      : {}),
    manifestSchemaVersion: 1,
    finalizedAt: version.finalizedAt,
    ...(version.createdBy !== undefined
      ? { createdBy: parseDesktopSyncVersionAuthor(version.createdBy) }
      : {}),
  };
}

function isWorkspaceListResponse(
  value: unknown
): value is { workspaces: DesktopSyncWorkspaceSummaryResponse[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(isWorkspaceSummaryResponse)
  );
}

function isWorkspaceSummaryResponse(value: unknown): value is DesktopSyncWorkspaceSummaryResponse {
  if (!isRecord(value) || !isRecord(value.owner) || !isRecord(value.latest)) return false;
  const owner = value.owner;
  const validOwner =
    (owner.kind === 'personal' && isNonEmptyString(owner.accountId)) ||
    (owner.kind === 'org' && isNonEmptyString(owner.orgId));
  const validAccess =
    value.access === undefined ||
    (isRecord(value.access) &&
      (value.access.role === 'viewer' ||
        value.access.role === 'editor' ||
        value.access.role === 'manager' ||
        value.access.role === 'owner') &&
      (value.access.source === 'owner' ||
        value.access.source === 'org_admin' ||
        value.access.source === 'direct' ||
        value.access.source === 'org_audience') &&
      (value.access.orgId === null ||
        value.access.orgId === undefined ||
        isNonEmptyString(value.access.orgId)));
  const validOwnerDisplayName =
    value.ownerDisplayName === undefined || isNonEmptyString(value.ownerDisplayName);
  return (
    validAccess &&
    validOwnerDisplayName &&
    isWorkspaceSyncRemoteUuid(value.workspaceId) &&
    isNonEmptyString(value.clientWorkspaceId) &&
    isNonEmptyString(value.displayName) &&
    validOwner &&
    (value.latest.versionId === null || isWorkspaceSyncRemoteUuid(value.latest.versionId)) &&
    isNonNegativeInteger(value.latest.versionNumber) &&
    (value.latest.contentSha256 === null || typeof value.latest.contentSha256 === 'string') &&
    isNonNegativeInteger(value.storageBytesUsed) &&
    isNonNegativeInteger(value.versionCount) &&
    isNonEmptyString(value.updatedAt) &&
    isNonEmptyString(value.lastSeenAt) &&
    isNonEmptyString(value.deviceId)
  );
}

function invalidDesktopSyncResponse(message: string): DesktopSyncClientError {
  return new DesktopSyncClientError('BAD_RESPONSE', message, {
    retryable: true,
    terminal: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function scientificManifestDetail(
  latest: DesktopSyncMaterializableVersion
): DesktopSyncManifestVersionResponse | null {
  if (!('manifest' in latest) || latest.version.representation !== 'scientific_manifest_v1')
    return null;
  return parseDesktopSyncManifestVersionResponse(latest, latest.workspaceId, latest.version.id);
}

export async function assertScientificReceivingAuthorization(
  client: WorkspaceSyncProjectsClient | undefined,
  accountId: string | undefined,
  remote: DesktopSyncWorkspaceSummaryResponse,
  detail: DesktopSyncManifestVersionResponse
): Promise<void> {
  if (
    !accountId ||
    !client?.supportsScientificHistory ||
    !client.assertAccount ||
    !client.downloadManifestVersion ||
    !client.downloadScientificHistoryBlob
  )
    throw invalidDesktopSyncResponse(
      'Scientific receiving requires complete account-fenced history transport.'
    );
  await client.assertAccount(accountId);
  const listed = (await client.listWorkspaces()).find(
    (workspace) => workspace.workspaceId === remote.workspaceId
  );
  const previousAccess = remoteAccess(remote),
    currentAccess = listed ? remoteAccess(listed) : null;
  if (
    !listed ||
    JSON.stringify(listed.owner) !== JSON.stringify(remote.owner) ||
    currentAccess?.role !== previousAccess.role ||
    currentAccess.source !== previousAccess.source ||
    (currentAccess.orgId ?? null) !== (previousAccess.orgId ?? null)
  )
    throw invalidDesktopSyncResponse(
      'Scientific project access or ownership changed before acceptance.'
    );
  const fresh = scientificManifestDetail(
    await client.downloadManifestVersion(remote.workspaceId, detail.version.id)
  );
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(detail))
    throw invalidDesktopSyncResponse('Scientific version authority changed before acceptance.');
  await client.assertAccount(accountId);
}

export async function downloadScientificReceivingHistory(
  client: WorkspaceSyncProjectsClient | undefined,
  accountId: string | undefined,
  remote: DesktopSyncWorkspaceSummaryResponse,
  detail: DesktopSyncManifestVersionResponse
) {
  if (
    !accountId ||
    !client?.supportsScientificHistory ||
    !client.assertAccount ||
    !client.downloadScientificHistoryBlob ||
    !detail.scientificHistory ||
    !detail.scientificBlobRefs
  )
    throw invalidDesktopSyncResponse(
      'Scientific receiving requires complete account-fenced history transport.'
    );
  await client.assertAccount(accountId);
  return downloadScientificWorkspaceCloudHistory({
    descriptor: detail.scientificHistory,
    blobs: detail.scientificBlobRefs,
    beforeBlob: () => client.assertAccount!(accountId),
    downloadBlob: (blob, signal) =>
      client.downloadScientificHistoryBlob!(
        remote.workspaceId,
        detail.version.id,
        blob,
        signal,
        accountId
      ),
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toProjectSummary(
  workspace: DesktopSyncWorkspaceSummaryResponse
): WorkspaceSyncProjectSummary {
  const access = remoteAccess(workspace);
  return {
    remoteWorkspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    ownerAccountId: workspace.owner.kind === 'personal' ? workspace.owner.accountId : '',
    ownerOrgId: workspace.owner.kind === 'org' ? workspace.owner.orgId : null,
    ownerDisplayName:
      workspace.ownerDisplayName ?? (workspace.owner.kind === 'org' ? 'Organization' : 'Personal'),
    accessRole: access.role,
    accessSource: access.source,
    accessOrgId: access.orgId,
    latestVersionId: workspace.latest.versionId,
    latestVersionNumber: workspace.latest.versionNumber,
    updatedAt: parseTime(workspace.updatedAt),
  };
}

export function remoteAccess(
  workspace: Pick<DesktopSyncWorkspaceSummaryResponse, 'access' | 'owner'>
): DesktopSyncWorkspaceAccessResponse {
  if (workspace.access) return workspace.access;
  return workspace.owner.kind === 'org'
    ? { role: 'owner', source: 'org_admin', orgId: workspace.owner.orgId }
    : { role: 'owner', source: 'owner', orgId: null };
}

async function materializeSyncedWorkspace(
  db: Database.Database,
  input: {
    managedRootDir: string;
    remote: DesktopSyncWorkspaceSummaryResponse;
    latest: DesktopSyncMaterializableVersion;
    downloadManifestFile?: WorkspaceSyncProjectsClient['downloadManifestFile'];
    ownerAccountId: string;
    nowMs: number;
    readClock: () => number;
    createWorkspaceUuid?: () => string;
    createRestoreLockId?: () => string;
    restoreLockTtlMs?: number;
    replacementCutover?: WorkspaceSyncReplacementCutover;
    durability?: ReplicaDurabilityBarrier;
    client?: WorkspaceSyncProjectsClient;
  }
): Promise<{ workspaceUuid: string; warnings: UserMessage[] }> {
  if (input.latest.workspaceId !== input.remote.workspaceId) {
    throw new Error('Synced project latest response does not match the requested workspace.');
  }
  const managedRootRealPath = await ensureManagedRootDir(input.managedRootDir);
  let recoveryPath: string | null = null;
  let lockId: string | null = null;
  let workspaceId: number | null = null;
  let databaseCommitted = false;
  let legacyLimsIgnored = false;
  const durability = input.durability ?? DEFAULT_REPLICA_DURABILITY;
  const scientific = scientificManifestDetail(input.latest);
  let releaseScientificLease: (() => void) | undefined;
  let scientificCommit: ScientificCloudReplicaCommit | undefined;

  try {
    if (scientific && input.replacementCutover)
      throw new Error(
        'Scientific project replacement requires explicit retained-history resolution.'
      );
    let intent: WorkspaceRestoreIntent = await withWorkspaceSyncDatabaseFence(db, () => {
      const versionCollision = selectVersionByRemoteVersionId(db, input.latest.version.id);
      if (
        versionCollision &&
        versionCollision.workspace_id !== input.replacementCutover?.sourceWorkspaceId
      ) {
        throw new Error('Synced project version is already linked to another local workspace.');
      }
      const reusableIntent = selectReusableRestoreIntent(db, input.remote, input.ownerAccountId);
      if (!reusableIntent && selectActiveRestoreIntent(db, input.remote, input.ownerAccountId)) {
        throw new Error('This synced project is already being restored.');
      }
      if (reusableIntent) {
        const reusableLockId = validateRestoreLockId(reusableIntent.lock_id);
        restartWorkspaceRestoreIntent(db, {
          ...reusableIntent,
          actorAccountId: input.ownerAccountId,
          sourceRemoteVersionId: input.latest.version.id,
          displayName: input.remote.displayName,
          nowMs: input.nowMs,
          restoreLockTtlMs: input.restoreLockTtlMs ?? DEFAULT_RESTORE_LOCK_TTL_MS,
        });
        return {
          reusable: true,
          workspaceUuid: reusableIntent.workspace_uuid,
          workspaceId: reusableIntent.workspace_id,
          workspacePath: dirname(reusableIntent.workspace_path),
          lockId: reusableLockId,
        };
      }
      return createFreshRestoreIntent(db, input);
    });
    let workspaceUuid = intent.workspaceUuid;
    let workspacePath = intent.workspacePath;
    lockId = intent.lockId;
    workspaceId = intent.workspaceId;

    if (intent.reusable) {
      const priorIntent = intent;
      try {
        recoveryPath = await quarantineReusableRestorePath({
          workspacePath,
          managedRootRealPath,
          workspaceUuid,
          remoteWorkspaceId: input.remote.workspaceId,
          lockId,
        });
        await reserveManagedWorkspacePath({ workspacePath, managedRootRealPath, workspaceUuid });
      } catch (error) {
        if (!(error instanceof UnusableReusableRestorePathError)) throw error;
        intent = await withWorkspaceSyncDatabaseFence(db, () =>
          replaceUnusableRestoreIntent(db, {
            priorIntent,
            failureMessage: error.message,
            ...input,
          })
        );
        workspaceUuid = intent.workspaceUuid;
        workspacePath = intent.workspacePath;
        lockId = intent.lockId;
        workspaceId = intent.workspaceId;
        recoveryPath = null;
        await reserveManagedWorkspacePath({ workspacePath, managedRootRealPath, workspaceUuid });
      }
    } else {
      await reserveManagedWorkspacePath({ workspacePath, managedRootRealPath, workspaceUuid });
    }

    if (lockId === null || workspaceId === null) {
      throw new Error('Workspace restore intent was not initialized.');
    }
    const restoreLockId = lockId;
    const restoreWorkspaceId = workspaceId;
    const repoPath = join(workspacePath, 'repo');
    if (scientific) releaseScientificLease = await acquireWorkspaceSyncMutationLease(repoPath);
    const downloadedHistory = scientific
      ? await downloadScientificReceivingHistory(
          input.client,
          input.ownerAccountId,
          input.remote,
          scientific
        )
      : null;

    const conversion = await writeRemoteVersionIntoFreshManagedRepo(
      repoPath,
      input.remote,
      input.latest,
      workspaceUuid,
      input.nowMs,
      input.managedRootDir,
      scientific
        ? (workspaceId, versionId, file, signal) =>
            input.downloadManifestFile!(workspaceId, versionId, file, signal, input.ownerAccountId)
        : input.downloadManifestFile
    );
    if (conversion.failures.length > 0) {
      console.warn(
        `[workspace-sync] Restored workspace "${workspaceUuid}" with ` +
          `${conversion.failures.length} package conversion failure(s).`,
        conversion.failures
      );
    }
    const registryProjection: FreshRestoreRegistryProjection =
      'manifest' in input.latest && input.latest.version.representation === 'manifest_v1'
        ? await materializeFreshRestoreRegistryProjection(db, {
            workspaceId: restoreWorkspaceId,
            repoPath,
          })
        : { origin: 'existing', paths: [] };
    await initManagedRepo(repoPath);
    await commitAllIfDirty(repoPath, 'Restore synced workspace', {
      forceInclude: [
        ...(await collectPlasmidPackageGitFiles(repoPath)),
        ...(scientific ? scientific.manifest.files.map((file) => file.path) : []),
      ],
    });
    await withWorkspaceSyncDatabaseFence(db, () =>
      validateWorkspaceSyncProjection(db, {
        workspaceId: restoreWorkspaceId,
        workspaceRoot: repoPath,
        nowMs: input.nowMs,
        scientificHistoryFormat: scientific ? 1 : undefined,
      })
    );
    const localHeadSha = await resolveHeadCommit(repoPath);
    if (!localHeadSha) {
      throw new Error('Restored workspace does not have a durable managed Git commit.');
    }
    const restorePaths = [
      MANAGED_WORKSPACE_MARKER,
      ...remoteVersionPaths(input.latest),
      ...conversion.mutatedGitFiles,
    ];
    await flushFreshRestoreDurably({
      durability,
      managedRootRealPath,
      workspacePath,
      repoPath,
      localHeadSha,
      operationPaths: [...restorePaths, ...registryProjection.paths],
    });
    if (scientific && downloadedHistory && releaseScientificLease) {
      scientificCommit = {
        mode: 'restore',
        workspaceUuid,
        repoPath,
        ownerAccountId: input.ownerAccountId,
        remote: input.remote,
        version: scientific.version,
        baseVersionId: null,
        baseVersionNumber: null,
        localHeadSha,
        installedPaths: restorePaths,
        excludedSummary: toWorkspaceSyncStatusExcludedSummary(
          remoteVersionExcludedSummary(scientific)
        ),
        nowMs: input.nowMs,
        restoreLockId,
      };
      const installed = await installScientificWorkspaceCloudHistory(db, {
        workspaceId: restoreWorkspaceId,
        mutationLease: releaseScientificLease,
        descriptor: scientific.scientificHistory!,
        archive: downloadedHistory.archive,
        sources: downloadedHistory.sources,
        manifest: scientific.manifest,
        blobRefs: scientific.scientificBlobRefs!,
        expectedHead: null,
        remoteWorkspaceId: input.remote.workspaceId,
        replicaCommit: scientificCommit,
        beforeCommit: async () => {
          await assertScientificReceivingAuthorization(
            input.client,
            input.ownerAccountId,
            input.remote,
            scientific
          );
          for (const file of scientific.manifest.files) {
            const path = await resolvePathWithVerifiedParent(
              await realpath(repoPath),
              join(repoPath, file.path),
              false
            );
            const identity = await hashWorkspaceSyncFileOnDisk(path);
            if (identity.sha256 !== file.contentSha256 || identity.sizeBytes !== file.sizeBytes)
              throw new Error(`Scientific received file changed before acceptance: ${file.path}`);
          }
          if (
            (await resolveHeadCommit(repoPath)) !== localHeadSha ||
            (await hasWorkspaceSyncWorkingChanges(repoPath))
          )
            throw new Error('Scientific receiving repository changed before acceptance.');
        },
      });
      if (installed.kind === 'conflict')
        throw new Error(
          'Scientific restore acquired local history while receiving; both branches were retained.'
        );
      databaseCommitted = scientificCloudReplicaWasCommitted(
        db,
        restoreWorkspaceId,
        scientificCommit,
        scientific.scientificHistory!
      );
      if (!databaseCommitted)
        throw new Error('Scientific restore did not atomically acknowledge its cloud version.');
    } else {
      await withWorkspaceSyncDatabaseFence(db, () =>
        db.transaction(() => {
          let finalWorkspaceId = restoreWorkspaceId;
          if (input.replacementCutover) {
            input.replacementCutover.commit();
            const replacementCollision = selectVersionByRemoteVersionId(
              db,
              input.latest.version.id
            );
            if (
              replacementCollision &&
              replacementCollision.workspace_id !== input.replacementCutover.sourceWorkspaceId
            ) {
              throw new Error(
                'Synced project version is already linked to another local workspace.'
              );
            }
            if (replacementCollision) {
              db.prepare(
                `DELETE FROM workspace_sync_versions
             WHERE workspace_id = ? AND remote_version_id = ?`
              ).run(input.replacementCutover.sourceWorkspaceId, input.latest.version.id);
            }
            transferReplacementWorkspaceIdentity(db, {
              sourceWorkspaceId: input.replacementCutover.sourceWorkspaceId,
              restoreWorkspaceId,
              restoreLockId,
              nowMs: input.nowMs,
            });
            finalWorkspaceId = input.replacementCutover.sourceWorkspaceId;
          }

          const rehydrated = rehydrateWorkspaceSyncState(db, {
            workspaceId: finalWorkspaceId,
            workspaceRoot: repoPath,
            nowMs: input.nowMs,
            strict: true,
          });
          legacyLimsIgnored =
            registryProjection.origin === 'existing' && rehydrated.legacyLimsIgnored;

          if (input.replacementCutover) {
            const bindingUpdated = db
              .prepare(
                `UPDATE workspace_sync_bindings
             SET workspace_uuid = ?,
                 owner_account_id = ?,
                 owner_org_id = ?,
                 remote_workspace_id = ?,
                 enabled = 1,
                 remote_latest_version_id = ?,
                 remote_latest_version_number = ?,
                 remote_latest_content_sha256 = ?,
                 last_acked_local_head_sha = ?,
                 last_downloaded_at = ?,
                 updated_at = ?,
                 remote_owner_account_id = ?,
                 access_role = ?,
                 access_source = ?,
                 shared_with_others = ?,
                 detached_reason = NULL
             WHERE workspace_id = ?`
              )
              .run(
                workspaceUuid,
                input.ownerAccountId,
                ownerOrgId(input.remote),
                input.remote.workspaceId,
                input.latest.version.id,
                input.latest.version.versionNumber,
                input.latest.version.contentSha256,
                localHeadSha,
                input.nowMs,
                input.nowMs,
                remoteOwnerAccountId(input.remote),
                remoteAccess(input.remote).role,
                remoteAccess(input.remote).source,
                bindingSharedWithOthers(input.remote),
                finalWorkspaceId
              ).changes;
            if (bindingUpdated !== 1) {
              throw new Error('Replacement binding changed before finalization.');
            }
            db.prepare(`DELETE FROM workspace_sync_versions WHERE workspace_id = ?`).run(
              finalWorkspaceId
            );
          } else {
            db.prepare(
              `INSERT INTO workspace_sync_bindings (
          workspace_id, workspace_uuid, owner_account_id, owner_org_id,
          remote_workspace_id, enabled, remote_latest_version_id,
          remote_latest_version_number, remote_latest_content_sha256,
          last_acked_local_head_sha, last_downloaded_at, created_at, updated_at,
          remote_owner_account_id, access_role, access_source, shared_with_others
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              finalWorkspaceId,
              workspaceUuid,
              input.ownerAccountId,
              ownerOrgId(input.remote),
              input.remote.workspaceId,
              input.latest.version.id,
              input.latest.version.versionNumber,
              input.latest.version.contentSha256,
              localHeadSha,
              input.nowMs,
              input.nowMs,
              input.nowMs,
              remoteOwnerAccountId(input.remote),
              remoteAccess(input.remote).role,
              remoteAccess(input.remote).source,
              bindingSharedWithOthers(input.remote)
            );
          }
          db.prepare(
            `INSERT INTO workspace_sync_versions (
          id, workspace_id, remote_version_id, version_number, content_sha256,
          local_head_sha, file_count, size_bytes, excluded_summary_json,
          status, is_latest, created_at, updated_at,
          created_by_account_id, created_by_display
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?, ?, ?, ?)`
          ).run(
            input.latest.version.id,
            finalWorkspaceId,
            input.latest.version.id,
            input.latest.version.versionNumber,
            input.latest.version.contentSha256,
            localHeadSha,
            input.latest.version.fileCount,
            input.latest.version.sizeBytes,
            serializeWorkspaceSyncExcludedSummary(
              toWorkspaceSyncStatusExcludedSummary(remoteVersionExcludedSummary(input.latest))
            ),
            input.nowMs,
            input.nowMs,
            input.latest.version.createdBy?.accountId ?? null,
            versionAuthorDisplay(input.latest.version.createdBy)
          );
          recordWorkspaceSyncReplicaFiles(db, {
            workspaceUuid,
            remoteWorkspaceId: input.remote.workspaceId,
            remoteVersionId: input.latest.version.id,
            paths: restorePaths,
            nowMs: input.nowMs,
          });
          db.prepare(
            `UPDATE workspace_sync_restore_locks
         SET status = 'completed',
             completed_at = ?,
             error_message = NULL
         WHERE workspace_id = ?
           AND lock_id = ?`
          ).run(Math.max(input.nowMs, input.readClock()), finalWorkspaceId, restoreLockId);
          settleWorkspaceSyncRestoreTelemetry(db, restoreLockId);
          db.prepare(
            `UPDATE workspaces
         SET last_opened_at = ?, archived_at = NULL, trashed_at = NULL
         WHERE id = ?`
          ).run(input.nowMs, finalWorkspaceId);
        })()
      );
      databaseCommitted = true;
    }
    if (recoveryPath) {
      try {
        await rm(recoveryPath, { recursive: true, force: true });
        await durability.flushDirectory(managedRootRealPath);
      } catch (error: unknown) {
        console.warn(
          `[workspace-sync] Could not remove completed restore recovery at ${recoveryPath}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return {
      workspaceUuid,
      warnings: legacyLimsIgnored ? [LEGACY_LIMS_NOT_IMPORTED_WARNING] : [],
    };
  } catch (error) {
    if (
      scientific &&
      scientificCommit &&
      workspaceId !== null &&
      scientificCloudReplicaWasCommitted(
        db,
        workspaceId,
        scientificCommit,
        scientific.scientificHistory!
      )
    )
      databaseCommitted = true;
    if (!databaseCommitted && workspaceId !== null && lockId !== null) {
      const failedWorkspaceId = workspaceId;
      const failedLockId = lockId;
      try {
        await withWorkspaceSyncDatabaseFence(db, () =>
          markRestoreLockFailed(db, {
            workspaceId: failedWorkspaceId,
            lockId: failedLockId,
            nowMs: Math.max(input.nowMs, input.readClock()),
            errorMessage: error instanceof Error ? error.message : 'Restore failed.',
          })
        );
      } catch (markError) {
        console.warn(
          '[workspace-sync] Could not mark a failed restore intent; startup recovery will retry:',
          errorMessage(markError)
        );
      }
    }
    throw error;
  } finally {
    releaseScientificLease?.();
  }
}

export function reconcileInterruptedWorkspaceRestores(
  db: Database.Database,
  now: number = Date.now()
): number {
  const rows = db
    .prepare(
      `SELECT rl.workspace_id, rl.lock_id, rl.started_at, rl.status, w.archived_at
       FROM workspace_sync_restore_locks rl
       JOIN workspaces w ON w.id = rl.workspace_id
       LEFT JOIN workspace_sync_bindings b ON b.workspace_id = rl.workspace_id
       WHERE b.workspace_id IS NULL
         AND rl.status <> 'completed'`
    )
    .all() as Array<{
    workspace_id: number;
    lock_id: string;
    started_at: number;
    status: 'restoring' | 'failed' | 'canceled';
    archived_at: number | null;
  }>;
  return db.transaction(() => {
    const failInterrupted = db.prepare(
      `UPDATE workspace_sync_restore_locks
       SET status = 'failed',
           completed_at = @completedAt,
           error_message = 'Interrupted restore was quarantined for an idempotent retry.'
       WHERE workspace_id = @workspaceId
         AND status = 'restoring'`
    );
    const archiveShell = db.prepare(
      `UPDATE workspaces
       SET archived_at = COALESCE(archived_at, @archivedAt)
       WHERE id = @workspaceId`
    );
    let reconciled = 0;
    for (const row of rows) {
      const completedAt = Math.max(now, row.started_at);
      if (row.status === 'restoring') {
        failInterrupted.run({ workspaceId: row.workspace_id, completedAt });
        settleWorkspaceSyncRestoreTelemetry(db, row.lock_id);
      }
      if (row.archived_at === null) {
        archiveShell.run({ workspaceId: row.workspace_id, archivedAt: completedAt });
      }
      if (row.status === 'restoring' || row.archived_at === null) reconciled += 1;
    }
    return reconciled;
  })();
}

function selectReusableRestoreIntent(
  db: Database.Database,
  remote: DesktopSyncWorkspaceSummaryResponse,
  ownerAccountId: string
): ReusableRestoreIntentRow | null {
  const row = db
    .prepare(
      `SELECT rl.workspace_id,
              w.repo_uuid AS workspace_uuid,
              w.path AS workspace_path,
              rl.lock_id,
              rl.source_remote_version_id,
              rl.remote_workspace_id,
              rl.owner_account_id,
              rl.owner_org_id,
              rl.status
       FROM workspace_sync_restore_locks rl
       JOIN workspaces w ON w.id = rl.workspace_id
       LEFT JOIN workspace_sync_bindings b ON b.workspace_id = rl.workspace_id
       WHERE b.workspace_id IS NULL
         AND rl.status = 'failed'
         AND rl.remote_workspace_id = @remoteWorkspaceId
         AND (
           (@ownerOrgId IS NULL AND rl.owner_org_id IS NULL AND rl.owner_account_id = @ownerAccountId)
           OR (@ownerOrgId IS NOT NULL AND rl.owner_org_id = @ownerOrgId)
         )
       ORDER BY rl.started_at DESC
       LIMIT 1`
    )
    .get({
      remoteWorkspaceId: remote.workspaceId,
      ownerAccountId,
      ownerOrgId: ownerOrgId(remote),
    }) as ReusableRestoreIntentRow | undefined;
  return row ?? null;
}

function selectActiveRestoreIntent(
  db: Database.Database,
  remote: DesktopSyncWorkspaceSummaryResponse,
  ownerAccountId: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1
       FROM workspace_sync_restore_locks rl
       JOIN workspaces w ON w.id = rl.workspace_id
       LEFT JOIN workspace_sync_bindings b ON b.workspace_id = rl.workspace_id
       WHERE b.workspace_id IS NULL
         AND rl.status = 'restoring'
         AND rl.remote_workspace_id = @remoteWorkspaceId
         AND (
           (@ownerOrgId IS NULL AND rl.owner_org_id IS NULL AND rl.owner_account_id = @ownerAccountId)
           OR (@ownerOrgId IS NOT NULL AND rl.owner_org_id = @ownerOrgId)
         )
       LIMIT 1`
    )
    .get({
      remoteWorkspaceId: remote.workspaceId,
      ownerAccountId,
      ownerOrgId: ownerOrgId(remote),
    });
  return row !== undefined;
}

function restartWorkspaceRestoreIntent(
  db: Database.Database,
  input: ReusableRestoreIntentRow & {
    actorAccountId: string;
    sourceRemoteVersionId: string;
    displayName: string;
    nowMs: number;
    restoreLockTtlMs: number;
  }
): void {
  db.transaction(() => {
    const restarted = db
      .prepare(
        `UPDATE workspace_sync_restore_locks
       SET source_remote_version_id = ?,
           owner_account_id = ?,
           status = 'restoring',
           started_at = ?,
           expires_at = ?,
           completed_at = NULL,
           error_message = NULL
       WHERE workspace_id = ?
         AND lock_id = ?
         AND status = 'failed'
         AND remote_workspace_id = ?
         AND owner_account_id = ?
         AND owner_org_id IS ?`
      )
      .run(
        input.sourceRemoteVersionId,
        input.actorAccountId,
        input.nowMs,
        input.nowMs + input.restoreLockTtlMs,
        input.workspace_id,
        input.lock_id,
        input.remote_workspace_id,
        input.owner_account_id,
        input.owner_org_id
      ).changes;
    if (restarted !== 1) {
      throw new Error('Workspace restore intent changed before it could restart.');
    }
    db.prepare(
      `UPDATE workspaces
       SET name = ?, last_opened_at = ?
       WHERE id = ?`
    ).run(input.displayName, input.nowMs, input.workspace_id);
    acceptWorkspaceSyncRestoreTelemetry(db, input.lock_id);
  })();
}

function createFreshRestoreIntent(
  db: Database.Database,
  input: RestoreIntentCreationInput
): FreshRestoreIntent {
  const workspaceUuid = chooseWorkspaceUuid(db, input.remote, input.createWorkspaceUuid);
  const workspacePath = join(input.managedRootDir, workspaceUuid);
  const lockId = validateRestoreLockId(input.createRestoreLockId?.() ?? randomUUID());
  const workspaceId = createWorkspaceRestoreShell(db, {
    workspaceUuid,
    displayName: input.remote.displayName,
    repoPath: join(workspacePath, 'repo'),
    lockId,
    sourceRemoteVersionId: input.latest.version.id,
    remoteWorkspaceId: input.remote.workspaceId,
    ownerAccountId: input.ownerAccountId,
    ownerOrgId: ownerOrgId(input.remote),
    nowMs: input.nowMs,
    restoreLockTtlMs: input.restoreLockTtlMs ?? DEFAULT_RESTORE_LOCK_TTL_MS,
  });
  return { reusable: false, workspaceUuid, workspaceId, workspacePath, lockId };
}

function replaceUnusableRestoreIntent(
  db: Database.Database,
  input: RestoreIntentCreationInput & {
    priorIntent: RestartedRestoreIntent;
    failureMessage: string;
  }
): FreshRestoreIntent {
  return db.transaction(() => {
    const canceled = db
      .prepare(
        `UPDATE workspace_sync_restore_locks
         SET status = 'canceled',
             completed_at = ?,
             error_message = ?
         WHERE workspace_id = ?
           AND lock_id = ?
           AND status = 'restoring'`
      )
      .run(
        input.nowMs,
        `Unusable restore path was retired: ${input.failureMessage}`,
        input.priorIntent.workspaceId,
        input.priorIntent.lockId
      ).changes;
    if (canceled !== 1) {
      throw new Error('Workspace restore intent changed before its unusable path was retired.');
    }
    settleWorkspaceSyncRestoreTelemetry(db, input.priorIntent.lockId);
    const archived = db
      .prepare(
        `UPDATE workspaces
         SET archived_at = COALESCE(archived_at, ?),
             last_opened_at = ?
         WHERE id = ?`
      )
      .run(input.nowMs, input.nowMs, input.priorIntent.workspaceId).changes;
    if (archived !== 1) {
      throw new Error('Unusable workspace restore shell could not be archived.');
    }
    return createFreshRestoreIntent(db, input);
  })();
}

async function quarantineReusableRestorePath(input: {
  workspacePath: string;
  managedRootRealPath: string;
  workspaceUuid: string;
  remoteWorkspaceId: string;
  lockId: string;
}): Promise<string | null> {
  const workspaceParentRealPath = await realpath(dirname(input.workspacePath));
  if (
    workspaceParentRealPath !== input.managedRootRealPath ||
    basename(input.workspacePath) !== input.workspaceUuid
  ) {
    throw new UnusableReusableRestorePathError(
      'Interrupted restore path does not match its managed workspace identity.'
    );
  }
  const recoveryPath = `${input.workspacePath}.restore-recovery-${input.lockId}`;
  const recoveryStat = await lstat(recoveryPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (recoveryStat) {
    if (recoveryStat.isSymbolicLink() || !recoveryStat.isDirectory()) {
      throw new UnusableReusableRestorePathError(
        'Interrupted restore recovery path is not a managed directory.'
      );
    }
    if (
      !(await reusableRestorePathIsOwned({
        ...input,
        workspacePath: recoveryPath,
      }))
    ) {
      throw new UnusableReusableRestorePathError(
        'Interrupted restore recovery lacks matching managed ownership evidence.'
      );
    }
  }

  let stat;
  try {
    stat = await lstat(input.workspacePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return recoveryStat ? recoveryPath : null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnusableReusableRestorePathError(
      'Interrupted restore path is not a managed directory.'
    );
  }
  if (!(await reusableRestorePathIsOwned(input))) {
    throw new UnusableReusableRestorePathError(
      'Interrupted restore path lacks matching managed ownership evidence.'
    );
  }
  if (recoveryStat) {
    await rm(input.workspacePath, { recursive: true, force: false });
  } else {
    await rename(input.workspacePath, recoveryPath);
  }
  return recoveryPath;
}

async function reusableRestorePathIsOwned(input: {
  workspacePath: string;
  workspaceUuid: string;
  remoteWorkspaceId: string;
}): Promise<boolean> {
  const entries = await readdir(input.workspacePath, { withFileTypes: true });
  if (entries.length === 0) return true;
  if (entries.length === 1 && entries[0]?.name === 'repo' && entries[0].isDirectory()) {
    const repoEntries = await readdir(join(input.workspacePath, 'repo'));
    if (repoEntries.length === 0) return true;
  }
  try {
    const marker = JSON.parse(
      await readFile(join(input.workspacePath, 'repo', MANAGED_WORKSPACE_MARKER), 'utf8')
    ) as unknown;
    return (
      isRecord(marker) &&
      marker.workspaceUuid === input.workspaceUuid &&
      marker.restoredFromRemoteWorkspaceId === input.remoteWorkspaceId
    );
  } catch {
    return false;
  }
}

async function cleanupCompletedRestoreRecoveryBestEffort(
  db: Database.Database,
  input: {
    binding: ExistingBindingRow;
    managedRootDir: string;
    remoteWorkspaceId: string;
    durability: ReplicaDurabilityBarrier;
  }
): Promise<void> {
  try {
    await cleanupCompletedRestoreRecovery(db, input);
  } catch (error) {
    console.warn(
      '[workspace-sync] Could not remove a completed restore recovery copy:',
      errorMessage(error)
    );
  }
}

async function cleanupCompletedRestoreRecovery(
  db: Database.Database,
  input: {
    binding: ExistingBindingRow;
    managedRootDir: string;
    remoteWorkspaceId: string;
    durability: ReplicaDurabilityBarrier;
  }
): Promise<void> {
  const completedLock = db
    .prepare(
      `SELECT lock_id
       FROM workspace_sync_restore_locks
       WHERE workspace_id = ? AND status = 'completed'`
    )
    .get(input.binding.workspace_id) as CompletedRestoreLockRow | undefined;
  if (!completedLock) return;

  const lockId = validateRestoreLockId(completedLock.lock_id);
  const managedRootRealPath = await realpath(input.managedRootDir);
  const workspacePath = dirname(input.binding.path);
  const workspaceParentRealPath = await realpath(dirname(workspacePath));
  if (
    workspaceParentRealPath !== managedRootRealPath ||
    basename(workspacePath) !== input.binding.workspace_uuid
  ) {
    throw new Error('Completed restore path does not match its managed workspace identity.');
  }

  const recoveryPath = `${workspacePath}.restore-recovery-${lockId}`;
  const recoveryStat = await lstat(recoveryPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!recoveryStat) return;
  if (recoveryStat.isSymbolicLink() || !recoveryStat.isDirectory()) {
    throw new Error('Completed restore recovery path is not a managed directory.');
  }
  if (
    !(await reusableRestorePathIsOwned({
      workspacePath: recoveryPath,
      workspaceUuid: input.binding.workspace_uuid,
      remoteWorkspaceId: input.remoteWorkspaceId,
    }))
  ) {
    throw new Error('Completed restore recovery lacks matching managed ownership evidence.');
  }
  await rm(recoveryPath, { recursive: true, force: false });
  await input.durability.flushDirectory(managedRootRealPath);
}

function createWorkspaceRestoreShell(
  db: Database.Database,
  input: {
    workspaceUuid: string;
    displayName: string;
    repoPath: string;
    lockId: string;
    sourceRemoteVersionId: string;
    remoteWorkspaceId: string;
    ownerAccountId: string;
    ownerOrgId: string | null;
    nowMs: number;
    restoreLockTtlMs: number;
  }
): number {
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO workspaces (
           name, path, repo_uuid, origin_path, created_at, last_opened_at, archived_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        input.displayName,
        input.repoPath,
        input.workspaceUuid,
        input.nowMs,
        input.nowMs,
        input.nowMs
      );
    const workspaceId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, source_remote_version_id,
        remote_workspace_id, owner_account_id, owner_org_id, status,
        started_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'restoring', ?, ?)`
    ).run(
      workspaceId,
      input.lockId,
      input.sourceRemoteVersionId,
      input.remoteWorkspaceId,
      input.ownerAccountId,
      input.ownerOrgId,
      input.nowMs,
      input.nowMs + input.restoreLockTtlMs
    );
    acceptWorkspaceSyncRestoreTelemetry(db, input.lockId);
    return workspaceId;
  })();
}

function transferReplacementWorkspaceIdentity(
  db: Database.Database,
  input: {
    sourceWorkspaceId: number;
    restoreWorkspaceId: number;
    restoreLockId: string;
    nowMs: number;
  }
): void {
  if (input.sourceWorkspaceId === input.restoreWorkspaceId) {
    throw new Error('Replacement staging workspace must be distinct from its source workspace.');
  }
  const selectWorkspace = db.prepare(
    `SELECT id, name, path, repo_uuid, origin_path
     FROM workspaces
     WHERE id = ?`
  );
  const source = selectWorkspace.get(input.sourceWorkspaceId) as WorkspaceIdentityRow | undefined;
  const staged = selectWorkspace.get(input.restoreWorkspaceId) as WorkspaceIdentityRow | undefined;
  if (!source?.repo_uuid || !staged?.repo_uuid) {
    throw new Error('Replacement workspace identity changed before cutover.');
  }

  const previousSourceLock = db
    .prepare(`SELECT status FROM workspace_sync_restore_locks WHERE workspace_id = ?`)
    .get(source.id) as { status: string } | undefined;
  if (
    previousSourceLock &&
    previousSourceLock.status !== 'completed' &&
    previousSourceLock.status !== 'canceled'
  ) {
    throw new Error('The source workspace already has an active restore intent.');
  }
  if (previousSourceLock) {
    db.prepare(`DELETE FROM workspace_sync_restore_locks WHERE workspace_id = ?`).run(source.id);
  }

  archiveReplacementSourceProjections(db, source.id, staged.id);

  const temporaryStagedPath = `${staged.path}.identity-swap-${input.restoreLockId}`;
  const stagedReleased = db
    .prepare(
      `UPDATE workspaces
       SET path = ?, repo_uuid = NULL
       WHERE id = ? AND path = ? AND repo_uuid = ?`
    )
    .run(temporaryStagedPath, staged.id, staged.path, staged.repo_uuid).changes;
  if (stagedReleased !== 1) {
    throw new Error('Replacement staging workspace changed before cutover.');
  }

  const sourceActivated = db
    .prepare(
      `UPDATE workspaces
       SET name = ?, path = ?, repo_uuid = ?, origin_path = NULL,
           last_opened_at = ?, archived_at = NULL, trashed_at = NULL
       WHERE id = ? AND path = ? AND repo_uuid = ?`
    )
    .run(
      staged.name,
      staged.path,
      staged.repo_uuid,
      input.nowMs,
      source.id,
      source.path,
      source.repo_uuid
    ).changes;
  if (sourceActivated !== 1) {
    throw new Error('Source workspace changed before replacement cutover.');
  }

  const sourceArchived = db
    .prepare(
      `UPDATE workspaces
       SET name = ?, path = ?, repo_uuid = ?, origin_path = ?,
           last_opened_at = ?, archived_at = ?, trashed_at = NULL
       WHERE id = ? AND path = ? AND repo_uuid IS NULL`
    )
    .run(
      source.name,
      source.path,
      source.repo_uuid,
      source.origin_path,
      input.nowMs,
      input.nowMs,
      staged.id,
      temporaryStagedPath
    ).changes;
  if (sourceArchived !== 1) {
    throw new Error('Replacement staging workspace could not archive the prior local copy.');
  }

  const lockTransferred = db
    .prepare(
      `UPDATE workspace_sync_restore_locks
       SET workspace_id = ?
       WHERE workspace_id = ? AND lock_id = ? AND status = 'restoring'`
    )
    .run(source.id, staged.id, input.restoreLockId).changes;
  if (lockTransferred !== 1) {
    throw new Error('Replacement restore intent changed before cutover.');
  }
}

function archiveReplacementSourceProjections(
  db: Database.Database,
  sourceWorkspaceId: number,
  archivedWorkspaceId: number
): void {
  assertReplacementPrivateAuthorityEmpty(db, sourceWorkspaceId);
  const workspaceReferenceTables = (
    db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).filter(({ name }) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new Error('Database contains an unsafe table name.');
    }
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{
      table: string;
      from: string;
    }>;
    return foreignKeys.some(
      (foreignKey) => foreignKey.table === 'workspaces' && foreignKey.from === 'workspace_id'
    );
  });

  for (const { name } of workspaceReferenceTables) {
    if (
      !REPLACEMENT_ARCHIVED_PROJECTION_TABLES.has(name) &&
      !REPLACEMENT_ACTIVE_IDENTITY_TABLES.has(name) &&
      !REPLACEMENT_PRIVATE_AUTHORITY_TABLES.has(name)
    ) {
      throw new Error(`Replacement cutover has no workspace identity policy for table ${name}.`);
    }
  }

  for (const table of REPLACEMENT_ARCHIVED_PROJECTION_TABLES) {
    if (!workspaceReferenceTables.some(({ name }) => name === table)) continue;
    db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`).run(
      archivedWorkspaceId,
      sourceWorkspaceId
    );
  }
}

function markRestoreLockFailed(
  db: Database.Database,
  input: { workspaceId: number; lockId: string; nowMs: number; errorMessage: string }
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE workspace_sync_restore_locks
     SET status = 'failed',
         completed_at = ?,
         error_message = ?
     WHERE workspace_id = ?
       AND lock_id = ?
       AND status = 'restoring'`
    ).run(input.nowMs, input.errorMessage, input.workspaceId, input.lockId);
    settleWorkspaceSyncRestoreTelemetry(db, input.lockId);
  })();
}

export async function materializeDesktopSyncVersionBundle(input: {
  remote: DesktopSyncWorkspaceSummaryResponse;
  latest: DesktopSyncMaterializableVersion;
  downloadManifestFile?: WorkspaceSyncProjectsClient['downloadManifestFile'];
  acceptedLocalReplica?: { repoPath: string; paths: ReadonlySet<string> };
}): Promise<WorkspaceSyncBundle> {
  if ('bundle' in input.latest) {
    return assertValidDesktopSyncLatestBundle(input.latest);
  }
  if (!input.downloadManifestFile) {
    throw new Error('This DNAForge version cannot download manifest-backed project files.');
  }

  const localReplica = input.acceptedLocalReplica
    ? {
        root: await realpath(input.acceptedLocalReplica.repoPath),
        paths: new Set(validateWorkspaceSyncReplicaPaths([...input.acceptedLocalReplica.paths])),
      }
    : undefined;
  return materializeManifestBlobBundle({
    detail: input.latest,
    workspace: { id: input.remote.workspaceId, name: input.remote.displayName },
    scientificHistory: scientificManifestDetail(input.latest)?.scientificHistory,
    downloadFile: (file) =>
      input.downloadManifestFile!(input.remote.workspaceId, input.latest.version.id, file),
    reuseAcceptedFile: localReplica
      ? async (file) => {
          if (!localReplica.paths.has(file.path)) return false;
          try {
            const path = await resolvePathWithVerifiedParent(
              localReplica.root,
              join(localReplica.root, file.path),
              false
            );
            const before = await lstat(path);
            if (!before.isFile() || before.isSymbolicLink()) {
              throw new Error('Synced project accepted file is not a regular file.');
            }
            if (before.size !== file.sizeBytes) return false;
            const captured = await captureWorkspaceSyncBlob(path, {
              maxBytes: file.sizeBytes,
              expectedIdentity: before,
            });
            return captured.sha256 === file.contentSha256 && captured.sizeBytes === file.sizeBytes;
          } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') return false;
            throw error;
          }
        }
      : undefined,
  });
}

async function materializeManifestBlobBundle(input: {
  detail: DesktopSyncManifestVersionResponse;
  workspace: WorkspaceSyncBundle['workspace'];
  downloadFile: (file: WorkspaceSyncManifestFileV1) => Promise<Response>;
  signal?: AbortSignal;
  beforeFile?: () => Promise<void>;
  reuseAcceptedFile?: (file: WorkspaceSyncManifestFileV1) => Promise<boolean>;

  scientificHistory?: ScientificCloudHistoryV1;
}): Promise<WorkspaceSyncBundleV3> {
  const manifest = parseWorkspaceSyncManifest(input.detail.manifest);
  if (!manifest.ok) {
    throw invalidDesktopSyncResponse(
      `Workspace manifest is invalid: ${manifest.errors.join('; ')}`
    );
  }
  const files: WorkspaceSyncBundle['files'] = [];
  for (const file of manifest.manifest.files) {
    input.signal?.throwIfAborted();
    await input.beforeFile?.();
    const authority = /(?:^|\/)\.forge\/(?:plasmid|notebook|workspace)\.json$/u.test(file.path);
    if (authority && file.sizeBytes > 1024 * 1024) {
      throw new Error('Workspace authority metadata exceeds 1 MiB.');
    }
    const identity = { sha256: file.contentSha256, sizeBytes: file.sizeBytes };
    try {
      await verifyWorkspaceSyncBlob(identity, { signal: input.signal });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!(await input.reuseAcceptedFile?.(file))) {
        const response = await input.downloadFile(file);
        if (!response.body) throw new Error(`Manifest file download was empty for ${file.path}.`);
        const body = response.body;
        const chunks = async function* (): AsyncGenerator<Uint8Array> {
          const reader = body.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        };
        try {
          await receiveWorkspaceSyncBlob(chunks(), identity, { signal: input.signal });
        } finally {
          await body.cancel().catch(() => undefined);
        }
      }
    }
    const ordinary = classifyShareFile(
      file.path,
      file.sizeBytes,
      WORKSPACE_SYNC_MANIFEST_READ_LIMITS
    );

    const resourceType = input.scientificHistory
      ? file.contentType
      : ordinary.action === 'exclude' &&
          ordinary.reason === 'unsupported' &&
          !file.path.includes('/assets/')
        ? workspaceSyncResourceMediaType(file.path)
        : null;
    const kind =
      ordinary.action === 'include'
        ? ordinary.kind
        : resourceType
          ? 'workspace-resource'
          : file.path.includes('/assets/')
            ? 'notebook'
            : 'assembly-sidecar';
    files.push({
      id: createHash('sha256').update(file.path).digest('hex').slice(0, 32),
      relativePath: file.path,
      name: basename(file.path),
      kind,
      contentType:
        ordinary.action === 'include' ? ordinary.contentType : (resourceType ?? file.contentType),
      sizeBytes: file.sizeBytes,
      sha256: file.contentSha256,
      content: authority
        ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            await readFile(await workspaceSyncBlobPath(file.contentSha256))
          )
        : '',
      ...(authority ? {} : { encoding: 'blob' as const }),
    });
  }
  const bundle: WorkspaceSyncBundleV3 = {
    schemaVersion: 3,
    capturedAt: input.detail.version.createdAt,
    workspace: input.workspace,
    files,
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: WORKSPACE_SYNC_MANIFEST_READ_LIMITS,
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: 'manifest-v1',
      contentSha256: input.detail.version.contentSha256,
    },
  };

  const parsed = validateWorkspaceSyncBundle({
    ...bundle,
    files: files.filter((file) => file.kind !== 'workspace-resource'),
  });
  if (!parsed.ok) {
    throw invalidDesktopSyncResponse(
      `Workspace manifest is not restorable: ${parsed.errors.join('; ')}`
    );
  }
  return bundle;
}

export async function applyLatestToExistingManagedRepo(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceUuid: string;
    repoPath: string;
    remote: DesktopSyncWorkspaceSummaryResponse;
    latest: DesktopSyncMaterializableVersion;

    downloadManifestFile?: WorkspaceSyncProjectsClient['downloadManifestFile'];
    expectedLocalHeadSha: string;
    expectedRemoteVersionId: string;
    nowMs: number;
    client?: WorkspaceSyncProjectsClient;

    scientificResolution?: 'replace-and-retain';

    reconciledLocalPaths?: readonly string[];

    reconciled?: {
      remoteVersion: DesktopSyncLatestVersionResponse['version'];
      commitMessage: string;
    };

    renameFile?: ReplicaRenameFile;
    installFile?: ReplicaInstallFile;
    durability?: ReplicaDurabilityBarrier;
    cleanupStaging?: (stagingRoot: string) => Promise<void>;
    onReplicaPreparing?: (
      event: Omit<WorkspaceSyncReplicaPreparingEvent, 'deliveryId' | 'phase'>
    ) => Promise<string | null>;
    onReplicaApplied?: (
      preparationId: string | null,
      event: Omit<WorkspaceSyncReplicaAppliedEvent, 'deliveryId' | 'phase' | 'mutationToken'>
    ) => void | Promise<void>;
    onReplicaAborted?: (
      preparationId: string | null,
      event: Omit<WorkspaceSyncReplicaPreparingEvent, 'deliveryId' | 'phase'> & {
        committed?: boolean;
      }
    ) => void | Promise<void>;
  }
): Promise<void> {
  const scientific = scientificManifestDetail(input.latest);
  assertScientificCloudTransferSupported(db, input.workspaceId, scientific ? 1 : undefined);
  const releaseMutationLease = await acquireWorkspaceSyncReplicaApplyLease(input.repoPath);
  try {
    const { recoverNativeCatalogRecordsWithDatabaseFence } =
      await import('./native-catalog-record-mutations');
    await recoverNativeCatalogRecordsWithDatabaseFence(db, input.repoPath);
    await applyLatestToExistingManagedRepoWithLease(
      db,
      scientific ? { ...input, latest: scientific } : input,
      releaseMutationLease
    );
  } finally {
    releaseMutationLease();
  }
}

async function applyLatestToExistingManagedRepoWithLease(
  db: Database.Database,
  input: Parameters<typeof applyLatestToExistingManagedRepo>[1],
  mutationLease: () => void
): Promise<void> {
  const scientific = scientificManifestDetail(input.latest);
  assertScientificCloudTransferSupported(db, input.workspaceId, scientific ? 1 : undefined);
  const actingAccount = db
    .prepare('SELECT owner_account_id FROM workspace_sync_bindings WHERE workspace_id=?')
    .get(input.workspaceId) as { owner_account_id: string } | undefined;
  const scientificHead = scientific
    ? new ScientificObjectStore(db, input.workspaceId).catalog().head
    : null;
  const downloadedHistory = scientific
    ? await downloadScientificReceivingHistory(
        input.client,
        actingAccount?.owner_account_id,
        input.remote,
        scientific
      )
    : null;
  if (input.latest.workspaceId !== input.remote.workspaceId) {
    throw new Error('Synced project latest response does not match the requested workspace.');
  }
  assertDownloadedLatestNotOlderThanSummary(input.remote, input.latest);
  await assertExistingRepoMatchesPullBase(
    input.repoPath,
    input.expectedLocalHeadSha,
    'before classifying the current replica'
  );
  const expectedRemoteVersionNumber = assertExistingBindingMatchesPullBase(db, input);
  assertExistingBindingStillMatchesPullBase(db, input, expectedRemoteVersionNumber);
  assertWorkspaceHasNoUnsavedBuffers(db, input.workspaceUuid);
  assertRemoteVersionAvailableForWorkspace(db, input.latest.version.id, input.workspaceId);
  const replicaIdentity = {
    workspaceUuid: input.workspaceUuid,
    remoteWorkspaceId: input.remote.workspaceId,
    remoteVersionId: input.expectedRemoteVersionId,
  };
  const acceptedPaths =
    readWorkspaceSyncReplicaFiles(db, replicaIdentity) ??
    (input.reconciled && input.reconciledLocalPaths
      ? []
      : await input.client?.readVersionPaths?.(
          input.remote.workspaceId,
          input.expectedRemoteVersionId
        ));
  if (!acceptedPaths) {
    throw new WorkspaceSyncPullConflictError(
      'The accepted sync version file list is unavailable. Retry after reconnecting.'
    );
  }
  const replaceablePaths = new Set(
    validateWorkspaceSyncReplicaPaths([
      ...acceptedPaths,
      ...(input.reconciled ? (input.reconciledLocalPaths ?? []) : []),
    ])
  );
  const bundle = await materializeDesktopSyncVersionBundle({
    ...input,
    ...(scientific
      ? {
          downloadManifestFile: (
            workspaceId: string,
            versionId: string,
            file: WorkspaceSyncManifestFileV1,
            signal?: AbortSignal
          ) =>
            input.downloadManifestFile!(
              workspaceId,
              versionId,
              file,
              signal,
              actingAccount!.owner_account_id
            ),
        }
      : {}),
    acceptedLocalReplica: {
      repoPath: input.repoPath,
      paths: new Set(validateWorkspaceSyncReplicaPaths(acceptedPaths)),
    },
  });
  const notebookIdsBefore = selectCurrentWorkspaceNotebookIds(db, input.workspaceId);
  const notebookProjectionScope = selectWorkspaceProjectionScope(db, input.workspaceId);
  const notebookIdsFromBundle = selectBundleNotebookIds(bundle).map((id) =>
    scopedProjectionId(notebookProjectionScope, id)
  );
  const designIdsBefore = selectCurrentWorkspaceDesignIds(db, input.workspaceId);
  const designIdsFromBundle = selectBundleDesignIds(bundle);
  const replicaNotice = {
    workspaceUuid: input.workspaceUuid,
    workspaceRoot: input.repoPath,
    remoteVersionId: input.latest.version.id,
    affectedNotebookIds: [...new Set([...notebookIdsBefore, ...notebookIdsFromBundle])],
    affectedDesignIds: [...new Set([...designIdsBefore, ...designIdsFromBundle])],
  };
  let replicaApplyCompleted = false;
  const currentPreview = await previewWorkspaceSyncUploadWithHeldMutationLease(db, {
    workspaceUuid: input.workspaceUuid,
    scientificHistoryFormat: scientific ? 1 : undefined,
  });
  const currentIncludedPaths = [
    ...new Set([
      ...currentPreview.includedFiles.map((file) => file.relativePath),
      ...(scientific ? acceptedPaths : []),
    ]),
  ].filter((path) => replaceablePaths.has(path));

  const currentPackageGitFiles = (await collectPlasmidPackageGitFiles(input.repoPath)).map((path) =>
    relative(input.repoPath, path).replaceAll('\\', '/')
  );
  await assertExistingRepoMatchesPullBase(
    input.repoPath,
    input.expectedLocalHeadSha,
    'after classifying the current replica'
  );
  const initialOperationPaths = [
    MANAGED_WORKSPACE_MARKER,
    ...currentIncludedPaths,
    ...currentPackageGitFiles,
    ...bundle.files.map((file: { relativePath: string }) => file.relativePath),
  ];
  const installTransaction = await replaceBundleFilesInExistingManagedRepo(
    input.repoPath,
    input.remote,
    bundle,
    input.workspaceUuid,
    input.nowMs,
    input.expectedLocalHeadSha,
    currentIncludedPaths,
    initialOperationPaths,
    {
      workspaceUuid: input.workspaceUuid,
      targetRemoteVersionId: input.latest.version.id,
      targetRemoteVersionNumber: input.latest.version.versionNumber,
    },
    input.renameFile ?? rename,
    input.installFile ?? installStagedFileNoReplace,
    input.durability ?? DEFAULT_REPLICA_DURABILITY,
    input.cleanupStaging ?? cleanupReplicaStaging,
    () => assertWorkspaceHasNoUnsavedBuffers(db, input.workspaceUuid),
    (stagingRoot) =>
      validateWorkspaceSyncProjection(db, {
        workspaceId: input.workspaceId,
        workspaceRoot: stagingRoot,
        nowMs: input.nowMs,
        scientificHistoryFormat: scientific ? 1 : undefined,
      }),
    () => input.onReplicaPreparing?.(replicaNotice) ?? Promise.resolve(null),
    (preparationId) => input.onReplicaAborted?.(preparationId, replicaNotice)
  );
  const preparationId = installTransaction.preparationId;
  let committedHead: string | null = null;
  let databaseCommitted = false;
  let notebookIdsAfter: string[] = [];
  let replicaWarnings: UserMessage[] = [];
  let pendingRendererDeliveryId: string | null = null;
  let scientificCommit: ScientificCloudReplicaCommit | undefined;
  const operationPaths = installTransaction.operationPaths;
  const releasePreparedRendererAfterFailure = async (): Promise<void> => {
    if (replicaApplyCompleted || !input.onReplicaAborted) return;
    try {
      await input.onReplicaAborted(preparationId, {
        ...replicaNotice,
        committed: databaseCommitted,
      });
    } catch (error) {
      console.warn(
        '[WorkspaceSyncRuntime] Could not release the renderer after replica failure:',
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  try {
    await installTransaction.assertReadyToCommit();
    if ((await resolveHeadCommit(input.repoPath)) !== input.expectedLocalHeadSha) {
      throw new WorkspaceSyncPullConflictError(
        'Managed Git HEAD changed while a newer remote version was being installed.'
      );
    }
    assertWorkspaceHasNoUnsavedBuffers(db, input.workspaceUuid);
    committedHead = await commitPathsIfDirty(
      input.repoPath,
      input.reconciled?.commitMessage ?? 'Pull remote workspace version',
      {
        paths: operationPaths,
        forceInclude: [
          ...installTransaction.generatedPackageFiles,
          ...(scientific ? scientific.manifest.files.map((file) => file.path) : []),
        ],
      }
    );
    const localHeadSha = committedHead ?? (await resolveHeadCommit(input.repoPath));
    if (!localHeadSha || (await hasWorkspaceSyncWorkingChanges(input.repoPath))) {
      throw new Error('Pulled workspace could not be committed with clean shared content.');
    }
    await (input.durability ?? DEFAULT_REPLICA_DURABILITY).flushGitCommit(
      input.repoPath,
      localHeadSha,
      operationPaths
    );
    installTransaction.markGitCommitted(localHeadSha);
    assertWorkspaceHasNoUnsavedBuffers(db, input.workspaceUuid);
    if (scientific && downloadedHistory) {
      if (!actingAccount) throw new Error('Scientific receiving account is missing.');
      scientificCommit = {
        mode: 'apply',
        workspaceUuid: input.workspaceUuid,
        repoPath: input.repoPath,
        ownerAccountId: actingAccount.owner_account_id,
        remote: input.remote,
        version: scientific.version,
        baseVersionId: input.expectedRemoteVersionId,
        baseVersionNumber: expectedRemoteVersionNumber,
        localHeadSha,
        installedPaths: installTransaction.installedPaths,
        excludedSummary: toWorkspaceSyncStatusExcludedSummary(bundle.excludedSummary),
        nowMs: input.nowMs,
        ...(input.onReplicaApplied
          ? {
              rendererNotice: {
                ...replicaNotice,
                changedPaths: installTransaction.installedPaths.map((path) =>
                  join(input.repoPath, path)
                ),
                deletedPaths: installTransaction.deletedPaths.map((path) =>
                  join(input.repoPath, path)
                ),
                deletedDesignIds: designIdsBefore.filter((id) => !designIdsFromBundle.includes(id)),
              },
            }
          : {}),
      };
      const installed = await installScientificWorkspaceCloudHistory(db, {
        workspaceId: input.workspaceId,
        mutationLease,
        descriptor: scientific.scientificHistory!,
        archive: downloadedHistory.archive,
        sources: downloadedHistory.sources,
        manifest: scientific.manifest,
        blobRefs: scientific.scientificBlobRefs!,
        expectedHead: scientificHead,
        remoteWorkspaceId: input.remote.workspaceId,
        binding: {
          ownerAccountId: actingAccount.owner_account_id,
          remoteWorkspaceId: input.remote.workspaceId,
          baseVersionId: input.expectedRemoteVersionId,
        },
        replicaCommit: scientificCommit,
        resolution: input.scientificResolution,
        beforeCommit: async () => {
          await assertScientificReceivingAuthorization(
            input.client,
            actingAccount.owner_account_id,
            input.remote,
            scientific
          );
          await installTransaction.assertReadyToCommit();
          assertWorkspaceHasNoUnsavedBuffers(db, input.workspaceUuid);
          assertExistingBindingStillMatchesPullBase(db, input, expectedRemoteVersionNumber);
        },
      });
      if (installed.kind === 'conflict')
        throw new WorkspaceSyncPullConflictError(
          'Scientific histories diverged. Both branches were retained; explicit resolution is required.'
        );
      databaseCommitted = scientificCloudReplicaWasCommitted(
        db,
        input.workspaceId,
        scientificCommit,
        scientific.scientificHistory!
      );
      if (!databaseCommitted)
        throw new Error('Scientific replica did not atomically acknowledge its cloud version.');
      const pending = readPendingWorkspaceSyncRendererRefresh(db, input.workspaceId);
      pendingRendererDeliveryId = pending?.deliveryId ?? null;
    } else {
      const releaseDatabaseFence = await acquireWorkspaceSyncDatabaseFence(db);
      try {
        await installTransaction.assertReadyToCommit();
        db.transaction(() => {
          assertScientificCloudTransferSupported(db, input.workspaceId);

          assertWorkspaceHasNoUnsavedBuffers(db, input.workspaceUuid);
          assertExistingBindingStillMatchesPullBase(db, input, expectedRemoteVersionNumber);
          assertRemoteVersionAvailableForWorkspace(db, input.latest.version.id, input.workspaceId);
          const rehydrated = rehydrateWorkspaceSyncState(db, {
            workspaceId: input.workspaceId,
            workspaceRoot: input.repoPath,
            nowMs: input.nowMs,
            strict: true,
          });
          replicaWarnings = rehydrated.legacyLimsIgnored ? [LEGACY_LIMS_NOT_IMPORTED_WARNING] : [];
          recordWorkspaceSyncReplicaFiles(db, {
            workspaceUuid: input.workspaceUuid,
            remoteWorkspaceId: input.remote.workspaceId,
            remoteVersionId: input.latest.version.id,
            paths: installTransaction.installedPaths,
            nowMs: input.nowMs,
          });
          recordAppliedRemoteVersion(db, {
            ...input,
            bundle,
            localHeadSha,
          });
          notebookIdsAfter = selectCurrentWorkspaceNotebookIds(db, input.workspaceId);
          if (input.onReplicaApplied) {
            pendingRendererDeliveryId = recordPendingWorkspaceSyncRendererRefresh(db, {
              workspaceId: input.workspaceId,
              localHeadSha,
              notice: {
                ...replicaNotice,
                changedPaths: installTransaction.installedPaths.map((path) =>
                  join(input.repoPath, path)
                ),
                deletedPaths: installTransaction.deletedPaths.map((path) =>
                  join(input.repoPath, path)
                ),
                affectedNotebookIds: [...new Set([...notebookIdsBefore, ...notebookIdsAfter])],
                affectedDesignIds: replicaNotice.affectedDesignIds,
                deletedDesignIds: designIdsBefore.filter((id) => !designIdsFromBundle.includes(id)),
                ...(replicaWarnings.length > 0 ? { warnings: replicaWarnings } : {}),
              },
              nowMs: input.nowMs,
            });
          }
        })();
        databaseCommitted = true;
      } finally {
        releaseDatabaseFence();
      }
    }
    if (input.onReplicaApplied) {
      if (!pendingRendererDeliveryId) {
        throw new Error('Committed replica is missing its durable renderer refresh notice.');
      }
      const delivery = readPendingWorkspaceSyncRendererRefresh(db, input.workspaceId);
      if (!delivery || delivery.deliveryId !== pendingRendererDeliveryId) {
        throw new Error('Committed replica does not match its pending renderer delivery.');
      }
      await input.onReplicaApplied(preparationId, delivery.notice);

      replicaApplyCompleted = true;
      markWorkspaceSyncRendererRefreshSucceeded(db, {
        delivery,
        nowMs: input.nowMs,
      });
    } else {
      replicaApplyCompleted = true;
    }

    installTransaction.markSqliteCommitted();
    await installTransaction.commit();
  } catch (applyError) {
    if (
      scientific &&
      scientificCommit &&
      scientificCloudReplicaWasCommitted(
        db,
        input.workspaceId,
        scientificCommit,
        scientific.scientificHistory!
      )
    ) {
      databaseCommitted = true;
      pendingRendererDeliveryId =
        readPendingWorkspaceSyncRendererRefresh(db, input.workspaceId)?.deliveryId ?? null;
    }

    if (databaseCommitted) {
      recordWorkspaceSyncRendererRefreshFailure(db, {
        workspaceId: input.workspaceId,
        deliveryId: pendingRendererDeliveryId ?? undefined,
        error: applyError,
        nowMs: input.nowMs,
      });
      await releasePreparedRendererAfterFailure();
      throw applyError;
    }
    let rollbackFailure: unknown = null;
    try {
      await installTransaction.rollback();
    } catch (error) {
      rollbackFailure = error;
    }
    try {
      await restoreManagedHeadAndIndex(input.repoPath, {
        restoreHead: input.expectedLocalHeadSha,
        expectedCurrentHead: committedHead ?? input.expectedLocalHeadSha,
        paths: operationPaths,
      });
    } catch (error) {
      rollbackFailure = rollbackFailure
        ? new Error(
            `File rollback failed: ${errorMessage(rollbackFailure)}. Git rollback failed: ${errorMessage(error)}.`
          )
        : error;
    }
    await releasePreparedRendererAfterFailure();
    if (rollbackFailure) {
      throw new Error(
        `Remote replica apply failed and rollback could not finish. ` +
          `Recovery files may remain at ${installTransaction.recoveryPath}. ` +
          `Apply error: ${errorMessage(applyError)}. ` +
          `Rollback error: ${errorMessage(rollbackFailure)}.`
      );
    }
    await installTransaction.finishRollback();
    throw applyError;
  }
}

async function writeRemoteVersionIntoFreshManagedRepo(
  repoPath: string,
  remote: DesktopSyncWorkspaceSummaryResponse,
  latest: DesktopSyncMaterializableVersion,
  workspaceUuid: string,
  nowMs: number,
  managedRootPath: string,
  downloadManifestFile: WorkspaceSyncProjectsClient['downloadManifestFile'] | undefined
): Promise<Awaited<ReturnType<typeof convertTreeToPlasmidPackages>>> {
  await ensureNoSymlinkDirectoryChain(managedRootPath, repoPath);
  if ('bundle' in latest) {
    await writeBundleIntoFreshManagedRepo(repoPath, remote, latest.bundle, workspaceUuid, nowMs);
    return convertTreeToPlasmidPackages(repoPath);
  }
  if (!downloadManifestFile) {
    throw new Error('This DNAForge version cannot download manifest-backed project files.');
  }
  await writeManifestIntoFreshManagedRepo({
    repoPath,
    remote,
    latest,
    workspaceUuid,
    nowMs,
    downloadManifestFile,
  });
  return {
    converted: 0,
    packages: 0,
    skipped: 0,
    skippedDetails: [],
    failures: [],
    requiredGitFiles: [],
    mutatedGitFiles: [],
  };
}

async function writeManifestIntoFreshManagedRepo(input: {
  repoPath: string;
  remote: DesktopSyncWorkspaceSummaryResponse;
  latest: DesktopSyncManifestVersionResponse;
  workspaceUuid: string;
  nowMs: number;
  downloadManifestFile: NonNullable<WorkspaceSyncProjectsClient['downloadManifestFile']>;
}): Promise<void> {
  const repoRootRealPath = await realpath(input.repoPath);
  await createTextFileInsideRepo(
    repoRootRealPath,
    join(repoRootRealPath, MANAGED_WORKSPACE_MARKER),
    managedWorkspaceMarker(input.remote, input.workspaceUuid, input.nowMs)
  );
  const resourceIds = new Map(
    input.latest.resourceIdentities.map(({ path, resourceId }) => [path, resourceId])
  );
  await createTextFileInsideRepo(
    repoRootRealPath,
    join(repoRootRealPath, HOSTED_RESOURCE_BINDINGS_PATH),
    serializeHostedResourceBindings({
      schema: 1,
      remoteWorkspaceId: input.remote.workspaceId,
      remoteVersionId: input.latest.version.id,
      resources: input.latest.manifest.files.map((file) => {
        const resourceId = resourceIds.get(file.path);
        if (!resourceId) {
          throw new Error(`Workspace file is missing a hosted resource identity: ${file.path}.`);
        }
        return {
          resourceId,
          path: file.path,
          contentSha256: file.contentSha256,
        };
      }),
    })
  );
  for (const file of input.latest.manifest.files) {
    const response = await input.downloadManifestFile(
      input.remote.workspaceId,
      input.latest.version.id,
      file
    );
    await createVerifiedStreamFileInsideRepo(
      repoRootRealPath,
      join(repoRootRealPath, file.path),
      response,
      file
    );
  }
}

function remoteVersionPaths(latest: DesktopSyncMaterializableVersion): string[] {
  return 'bundle' in latest
    ? latest.bundle.files.map((file) => file.relativePath)
    : [HOSTED_RESOURCE_BINDINGS_PATH, ...latest.manifest.files.map((file) => file.path)];
}

function remoteVersionExcludedSummary(
  latest: DesktopSyncMaterializableVersion
): WorkspaceSyncBundle['excludedSummary'] {
  if ('bundle' in latest) return latest.bundle.excludedSummary;
  return {
    unsupported: { count: 0, bytesApprox: 0 },
    'private-raw-data': { count: 0, bytesApprox: 0 },
    'reference-pointer': { count: 0, bytesApprox: 0 },
    'file-too-large': { count: 0, bytesApprox: 0 },
    'bundle-too-large': { count: 0, bytesApprox: 0 },
  };
}

type FreshRestoreRegistryProjection =
  | { origin: 'existing'; paths: readonly [] }
  | { origin: 'generated'; paths: readonly [string, string, ...string[]] };

async function materializeFreshRestoreRegistryProjection(
  db: Database.Database,
  input: { workspaceId: number; repoPath: string }
): Promise<FreshRestoreRegistryProjection> {
  const repoRoot = await realpath(input.repoPath);
  try {
    await lstat(join(repoRoot, '.waypoint', 'lims'));
    return { origin: 'existing', paths: [] };
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  const stagingRoot = await mkdtemp(join(dirname(repoRoot), '.sync-registry-'));
  try {
    const projection = await withWorkspaceSyncDatabaseFence(db, () =>
      materializeLimsGitReadableExportInDb(db, {
        workspaceRoot: input.repoPath,
        workspaceId: input.workspaceId,
        outputRoot: stagingRoot,
      })
    );
    const paths: [string, string, ...string[]] = [
      '.waypoint/lims/manifest.json',
      relative(stagingRoot, projection.oligosCsvPath).split(sep).join('/'),
      ...projection.logFiles.map((path) => relative(stagingRoot, path).split(sep).join('/')),
    ];
    for (const relativePath of paths) {
      await createTextFileInsideRepo(
        repoRoot,
        join(repoRoot, relativePath),
        await readFile(join(stagingRoot, relativePath))
      );
    }
    return { origin: 'generated', paths };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function validateWorkspaceSyncProjection(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceRoot: string;
    nowMs: number;
    scientificHistoryFormat?: 1;
  }
): void {
  const rollbackValidation = new Error('WORKSPACE_SYNC_VALIDATION_ROLLBACK');
  try {
    db.transaction(() => {
      rehydrateWorkspaceSyncState(db, { ...input, strict: true });
      throw rollbackValidation;
    })();
  } catch (error) {
    if (error === rollbackValidation) return;
    throw error;
  }
}

function selectBundleNotebookIds(bundle: WorkspaceSyncBundle): string[] {
  const ids: string[] = [];
  for (const file of bundle.files) {
    if (!file.relativePath.replaceAll('\\', '/').endsWith('/.forge/notebook.json')) continue;
    try {
      const parsed = JSON.parse(
        Buffer.from(decodeBundleFileContent(file)).toString('utf8')
      ) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).id === 'string'
      ) {
        ids.push((parsed as Record<string, string>).id);
      }
    } catch {}
  }
  return [...new Set(ids)];
}

function selectBundleDesignIds(bundle: WorkspaceSyncBundle): string[] {
  const ids: string[] = [];
  for (const file of bundle.files) {
    if (!file.relativePath.replaceAll('\\', '/').toLowerCase().endsWith('.wpdesign.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        Buffer.from(decodeBundleFileContent(file)).toString('utf8')
      ) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schema === 'waypoint.design.v1' &&
        (parsed as Record<string, unknown>).kind === 'assembly-design' &&
        typeof (parsed as Record<string, unknown>).id === 'string'
      ) {
        ids.push((parsed as Record<string, string>).id);
      }
    } catch {}
  }
  return [...new Set(ids)];
}

function assertRemoteVersionAvailableForWorkspace(
  db: Database.Database,
  remoteVersionId: string,
  workspaceId: number
): void {
  const collision = db
    .prepare(
      `SELECT id, remote_version_id, workspace_id
       FROM workspace_sync_versions
       WHERE id = ? OR remote_version_id = ?
       LIMIT 1`
    )
    .get(remoteVersionId, remoteVersionId) as
    | { id: string; remote_version_id: string; workspace_id: number }
    | undefined;
  if (
    collision &&
    (collision.workspace_id !== workspaceId ||
      collision.id !== remoteVersionId ||
      collision.remote_version_id !== remoteVersionId)
  ) {
    throw new Error('Synced project version is already linked to another local workspace.');
  }
}

function assertExistingBindingStillMatchesPullBase(
  db: Database.Database,
  input: Parameters<typeof applyLatestToExistingManagedRepo>[1],
  expectedRemoteVersionNumber: number
): void {
  assertNoPackageRecoveryQuarantine(db, input.workspaceId);
  const binding = db
    .prepare(
      `SELECT b.workspace_uuid, b.remote_workspace_id, b.owner_account_id, b.owner_org_id,
              b.remote_owner_account_id,
              b.enabled, b.remote_latest_version_id, b.remote_latest_version_number,
              w.archived_at, w.trashed_at
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.workspace_id = ?
       LIMIT 1`
    )
    .get(input.workspaceId) as
    | {
        workspace_uuid: string;
        remote_workspace_id: string;
        owner_account_id: string;
        owner_org_id: string | null;
        remote_owner_account_id: string | null;
        enabled: number;
        remote_latest_version_id: string | null;
        remote_latest_version_number: number | null;
        archived_at: number | null;
        trashed_at: number | null;
      }
    | undefined;

  const ownerMatches =
    input.remote.owner.kind === 'personal'
      ? binding?.owner_org_id === null &&
        (binding.remote_owner_account_id ?? binding.owner_account_id) ===
          input.remote.owner.accountId
      : binding?.owner_org_id === input.remote.owner.orgId;
  if (
    !binding ||
    binding.enabled !== 1 ||
    binding.archived_at !== null ||
    binding.trashed_at !== null ||
    binding.workspace_uuid !== input.workspaceUuid ||
    binding.remote_workspace_id !== input.remote.workspaceId ||
    !ownerMatches ||
    binding.remote_latest_version_id !== input.expectedRemoteVersionId ||
    binding.remote_latest_version_number !== expectedRemoteVersionNumber
  ) {
    throw new WorkspaceSyncPullConflictError(
      'Workspace sync binding changed while a newer remote version was being applied.'
    );
  }
}

function recordAppliedRemoteVersion(
  db: Database.Database,
  input: Parameters<typeof applyLatestToExistingManagedRepo>[1] & {
    bundle: WorkspaceSyncBundle;
    localHeadSha: string;
  }
): void {
  const remoteVersion = input.reconciled?.remoteVersion ?? input.latest.version;
  if (input.reconciled && remoteVersion.id !== input.latest.version.id)
    throw new Error('Reconciled apply must name the remote version it was merged against.');
  recordAppliedCloudVersionInsideTx(db, {
    workspaceId: input.workspaceId,
    version: remoteVersion,
    localHeadSha: input.localHeadSha,
    excludedSummary: toWorkspaceSyncStatusExcludedSummary(input.bundle.excludedSummary),
    nowMs: input.nowMs,
  });
}

async function writeBundleIntoFreshManagedRepo(
  repoPath: string,
  remote: DesktopSyncWorkspaceSummaryResponse,
  bundle: WorkspaceSyncBundle,
  workspaceUuid: string,
  nowMs: number
): Promise<void> {
  const repoRootRealPath = await realpath(repoPath);
  await createTextFileInsideRepo(
    repoRootRealPath,
    join(repoRootRealPath, MANAGED_WORKSPACE_MARKER),
    `${JSON.stringify(
      {
        schema: 1,
        workspaceUuid,
        restoredFromRemoteWorkspaceId: remote.workspaceId,
        restoredAt: nowMs,
      },
      null,
      2
    )}\n`
  );
  await materializeWorkspaceSyncBundleFiles(repoRootRealPath, bundle);
}

export async function materializeWorkspaceSyncBundleFiles(
  repoPath: string,
  bundle: WorkspaceSyncBundle
): Promise<void> {
  const repoRootRealPath = await realpath(repoPath);
  for (const file of bundle.files) {
    const destination = join(repoRootRealPath, file.relativePath);
    await createBundleFileInsideRepo(repoRootRealPath, destination, file);
  }
}

async function replaceBundleFilesInExistingManagedRepo(
  repoPath: string,
  remote: DesktopSyncWorkspaceSummaryResponse,
  bundle: WorkspaceSyncBundle,
  workspaceUuid: string,
  nowMs: number,
  expectedLocalHeadSha: string,
  currentIncludedPaths: readonly string[],
  initialOperationPaths: readonly string[],
  journalIdentity: {
    workspaceUuid: string;
    targetRemoteVersionId: string;
    targetRemoteVersionNumber: number;
  },
  renameFile: ReplicaRenameFile,
  installFile: ReplicaInstallFile,
  durability: ReplicaDurabilityBarrier,
  cleanupStaging: (stagingRoot: string) => Promise<void>,
  assertCanWrite: () => void,
  validateStaged: (stagingRoot: string) => void,
  prepareToWrite: () => Promise<string | null>,
  abortPreparation: (preparationId: string | null) => void | Promise<void>
): Promise<ReplicaInstallTransaction> {
  const repoRootRealPath = await realpath(repoPath);
  const stagingRoot = await mkdtemp(
    join(dirname(repoRootRealPath), replicaPullStagingPrefix(journalIdentity.workspaceUuid))
  );
  const backups: BackedUpReplicaFile[] = [];
  const installed: InstalledReplicaFile[] = [];
  let preparationId: string | null = null;
  try {
    createReplicaPullStagingJournal(stagingRoot, {
      repoPath: repoRootRealPath,
      workspaceUuid: journalIdentity.workspaceUuid,
      oldHead: expectedLocalHeadSha,
      targetRemoteVersionId: journalIdentity.targetRemoteVersionId,
      targetRemoteVersionNumber: journalIdentity.targetRemoteVersionNumber,
    });
    const pathsToBackup = [...new Set([MANAGED_WORKSPACE_MARKER, ...currentIncludedPaths])];
    const expectedCurrentContents = await captureExpectedReplicaContents(
      repoRootRealPath,
      pathsToBackup
    );
    const markerContent = managedWorkspaceMarker(remote, workspaceUuid, nowMs);
    await createTextFileInsideRepo(
      stagingRoot,
      join(stagingRoot, MANAGED_WORKSPACE_MARKER),
      markerContent
    );
    for (const file of bundle.files) {
      await createBundleFileInsideRepo(stagingRoot, join(stagingRoot, file.relativePath), file);
    }
    const conversion = await convertTreeToPlasmidPackages(stagingRoot);
    if (conversion.failures.length > 0) {
      throw new Error(
        `Remote workspace package conversion failed: ${conversion.failures
          .map((failure) => `${failure.path}: ${failure.message}`)
          .join('; ')}`
      );
    }
    validateStaged(stagingRoot);

    const existingBundlePaths: string[] = [];
    for (const file of bundle.files) {
      try {
        const stagedStat = await lstat(join(stagingRoot, file.relativePath));
        if (stagedStat.isFile() && !stagedStat.isSymbolicLink()) {
          existingBundlePaths.push(file.relativePath);
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
    }
    const generatedPackageFiles = conversion.mutatedGitFiles;
    const pathsToInstall = [
      ...new Set([MANAGED_WORKSPACE_MARKER, ...existingBundlePaths, ...generatedPackageFiles]),
    ];
    const stagedContents = new Map<string, string>();
    const stagedDirectories = new Set<string>();
    for (const relativePath of pathsToInstall) {
      const stagedPath = join(stagingRoot, relativePath);
      stagedContents.set(relativePath, (await hashWorkspaceSyncFileOnDisk(stagedPath)).sha256);
      await durability.flushFile(stagedPath);
      collectReplicaDirectoryChain(stagedDirectories, dirname(stagedPath), stagingRoot);
    }
    for (const directoryPath of replicaDirectoriesChildFirst(stagedDirectories, stagingRoot)) {
      await durability.flushDirectory(directoryPath);
    }

    await assertExistingRepoMatchesPullBase(
      repoPath,
      expectedLocalHeadSha,
      'before installing the staged replica'
    );
    assertCanWrite();
    const currentIncludedPathSet = new Set(currentIncludedPaths);
    const collisionCandidatePaths = [
      ...new Set([
        ...bundle.files.map((file: { relativePath: string }) => file.relativePath),
        ...pathsToInstall,
      ]),
    ];
    for (const relativePath of collisionCandidatePaths) {
      if (relativePath === MANAGED_WORKSPACE_MARKER) continue;
      if (currentIncludedPathSet.has(relativePath)) continue;
      try {
        await lstat(join(repoRootRealPath, relativePath));
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue;
        throw error;
      }
      throw new WorkspaceSyncPullConflictError(
        `Remote path would overwrite excluded or newly created local data: ${relativePath}`
      );
    }
    for (const relativePath of [...new Set([...pathsToBackup, ...pathsToInstall])]) {
      await preflightReplaceDestination(repoRootRealPath, join(repoRootRealPath, relativePath));
    }
    preparationId = await prepareToWrite();
    assertCanWrite();
    const operationPaths = [...new Set([...initialOperationPaths, ...pathsToInstall])];
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath: repoRootRealPath,
      workspaceUuid: journalIdentity.workspaceUuid,
      oldHead: expectedLocalHeadSha,
      targetRemoteVersionId: journalIdentity.targetRemoteVersionId,
      targetRemoteVersionNumber: journalIdentity.targetRemoteVersionNumber,
      operationPaths,
      backups: [...expectedCurrentContents.entries()].map(([relativePath, content]) => ({
        relativePath,
        sha256: content,
      })),
      installs: pathsToInstall.map((relativePath) => ({
        relativePath,
        sha256: stagedContents.get(relativePath)!,
      })),
    });

    for (const relativePath of pathsToBackup) {
      assertCanWrite();
      await moveExistingReplicaFileToBackup(
        repoRootRealPath,
        stagingRoot,
        relativePath,
        expectedCurrentContents.get(relativePath) ?? null,
        renameFile,
        durability,
        (backup) => backups.push(backup)
      );
    }

    for (const relativePath of pathsToInstall) {
      assertCanWrite();
      installed.push({
        relativePath,
        expectedContent: stagedContents.get(relativePath)!,
      });
      await replaceStagedFileInsideRepo(
        repoRootRealPath,
        join(repoRootRealPath, relativePath),
        join(stagingRoot, relativePath),
        installFile,
        durability,
        stagingRoot
      );
    }
    journal.markFilesInstalled();

    const cleanup = async (): Promise<void> =>
      cleanupStagingBestEffort(stagingRoot, cleanupStaging);
    return {
      preparationId,
      generatedPackageFiles,
      operationPaths,
      installedPaths: pathsToInstall,
      deletedPaths: backups
        .map((backup) => backup.relativePath)
        .filter((relativePath) => !pathsToInstall.includes(relativePath)),
      markGitCommitted: (newHead) => {
        journal.markGitCommitted(newHead);
      },
      markSqliteCommitted: () => {
        journal.markSqliteCommitted();
      },
      assertReadyToCommit: async () => {
        await assertReplicaBackupsUnchanged(backups);
        await assertInstalledReplicaFilesUnchanged(repoRootRealPath, installed);
      },
      commit: () => journal.commit(cleanup),
      rollback: () =>
        journal.rollback(() =>
          rollbackReplicaFiles(repoRootRealPath, installed, backups, renameFile, durability)
        ),
      finishRollback: () => journal.finishRollback(cleanup),
      recoveryPath: stagingRoot,
    };
  } catch (installError) {
    try {
      await rollbackReplicaFiles(repoRootRealPath, installed, backups, renameFile, durability);
      await cleanupStagingBestEffort(stagingRoot, cleanupStaging);
    } catch (rollbackError) {
      throw new Error(
        `Remote replica installation failed and rollback could not finish. ` +
          `Recovery files were preserved at ${stagingRoot}. ` +
          `Install error: ${errorMessage(installError)}. ` +
          `Rollback error: ${errorMessage(rollbackError)}.`
      );
    }
    if (preparationId) {
      try {
        await abortPreparation(preparationId);
      } catch (abortError) {
        console.warn(
          '[WorkspaceSyncRuntime] Could not release the renderer after replica installation rollback:',
          errorMessage(abortError)
        );
      }
    }
    throw installError;
  }
}

interface ReplicaInstallTransaction {
  preparationId: string | null;
  generatedPackageFiles: readonly string[];
  operationPaths: readonly string[];
  installedPaths: readonly string[];
  deletedPaths: readonly string[];
  markGitCommitted(newHead: string): void;
  markSqliteCommitted(): void;
  assertReadyToCommit(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finishRollback(): Promise<void>;
  recoveryPath: string;
}

function selectCurrentWorkspaceNotebookIds(db: Database.Database, workspaceId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT entity_id
       FROM catalog_entity_files
       WHERE workspace_id = ?
         AND file_kind = 'waypoint-notebook'
         AND status = 'current'
         AND entity_id IS NOT NULL
       ORDER BY entity_id ASC`
    )
    .all(workspaceId) as Array<{ entity_id: string }>;
  return rows.map((row) => row.entity_id);
}

function selectWorkspaceProjectionScope(db: Database.Database, workspaceId: number): string | null {
  const row = db
    .prepare('SELECT repo_uuid FROM workspaces WHERE id = ? LIMIT 1')
    .get(workspaceId) as { repo_uuid: string | null } | undefined;
  return workspaceScopeKey(row?.repo_uuid ?? null, workspaceId);
}

function selectCurrentWorkspaceDesignIds(db: Database.Database, workspaceId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT entity_id
       FROM catalog_entity_files
       WHERE workspace_id = ?
         AND file_kind = 'waypoint-design'
         AND status = 'current'
         AND entity_id IS NOT NULL
       ORDER BY entity_id ASC`
    )
    .all(workspaceId) as Array<{ entity_id: string }>;
  return rows.map((row) => row.entity_id);
}

function assertWorkspaceHasNoUnsavedBuffers(db: Database.Database, workspaceUuid: string): void {
  if (!hasUnsavedWorkspaceBuffers(getWorkspaceScopedDirtyState(db)[workspaceUuid])) {
    return;
  }
  throw new WorkspaceSyncPullConflictError(
    'Remote has a newer version while this local copy has unsaved editor changes.'
  );
}

function managedWorkspaceMarker(
  remote: DesktopSyncWorkspaceSummaryResponse,
  workspaceUuid: string,
  nowMs: number
): string {
  return `${JSON.stringify(
    {
      schema: 1,
      workspaceUuid,
      restoredFromRemoteWorkspaceId: remote.workspaceId,
      restoredAt: nowMs,
    },
    null,
    2
  )}\n`;
}

interface BackedUpReplicaFile {
  relativePath: string;
  backupPath: string;
  expectedContent: string;
}

interface InstalledReplicaFile {
  relativePath: string;
  expectedContent: string;
}

async function moveExistingReplicaFileToBackup(
  repoRootRealPath: string,
  stagingRoot: string,
  relativePath: string,
  expectedContent: string | null,
  renameFile: ReplicaRenameFile,
  durability: ReplicaDurabilityBarrier,
  rememberBackup: (backup: BackedUpReplicaFile) => void
): Promise<void> {
  let destination: string;
  let destinationStat;
  try {
    destination = await resolvePathWithVerifiedParent(
      repoRootRealPath,
      join(repoRootRealPath, relativePath),
      false
    );
    destinationStat = await lstat(destination);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      if (expectedContent !== null) {
        throw new WorkspaceSyncPullConflictError(
          `Local file was deleted while the remote replica was staged: ${relativePath}`
        );
      }
      return;
    }
    throw error;
  }
  if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
    throw new Error('Synced project destination is not a regular file.');
  }
  const currentContent = (await hashWorkspaceSyncFileOnDisk(destination)).sha256;
  if (expectedContent === null || currentContent !== expectedContent) {
    throw new WorkspaceSyncPullConflictError(
      `Local file changed while the remote replica was staged: ${relativePath}`
    );
  }

  const backupPath = join(stagingRoot, '.backup', relativePath);
  await ensureNoSymlinkDirectoryChain(stagingRoot, dirname(backupPath));
  destination = await resolvePathWithVerifiedParent(repoRootRealPath, destination, false);
  await renameFile(destination, backupPath);

  rememberBackup({ relativePath, backupPath, expectedContent });
  await durability.flushFile(backupPath);
  await durability.flushDirectory(dirname(destination));
  await flushReplicaDirectoryChain(durability, dirname(backupPath), stagingRoot);
  const backedUpContent = (await hashWorkspaceSyncFileOnDisk(backupPath)).sha256;
  if (backedUpContent !== expectedContent) {
    throw new WorkspaceSyncPullConflictError(
      `Local file changed while it was moved into replica recovery: ${relativePath}`
    );
  }
}

async function captureExpectedReplicaContents(
  repoRootRealPath: string,
  paths: readonly string[]
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const relativePath of paths) {
    try {
      const destination = await resolvePathWithVerifiedParent(
        repoRootRealPath,
        join(repoRootRealPath, relativePath),
        false
      );
      const destinationStat = await lstat(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
        throw new Error('Synced project destination is not a regular file.');
      }
      contents.set(relativePath, (await hashWorkspaceSyncFileOnDisk(destination)).sha256);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  }
  return contents;
}

async function assertReplicaBackupsUnchanged(
  backups: readonly BackedUpReplicaFile[]
): Promise<void> {
  for (const backup of backups) {
    if ((await hashWorkspaceSyncFileOnDisk(backup.backupPath)).sha256 !== backup.expectedContent) {
      throw new WorkspaceSyncPullConflictError(
        `Replica recovery copy changed before finalization: ${backup.relativePath}`
      );
    }
  }
}

async function assertInstalledReplicaFilesUnchanged(
  repoRootRealPath: string,
  installed: readonly InstalledReplicaFile[]
): Promise<void> {
  for (const file of installed) {
    const destination = await resolvePathWithVerifiedParent(
      repoRootRealPath,
      resolve(repoRootRealPath, file.relativePath),
      false
    );
    let destinationStat;
    try {
      destinationStat = await lstat(destination);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new WorkspaceSyncPullConflictError(
          `Installed replica file disappeared before finalization: ${file.relativePath}`
        );
      }
      throw error;
    }
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      throw new WorkspaceSyncPullConflictError(
        `Installed replica path changed before finalization: ${file.relativePath}`
      );
    }
    if ((await hashWorkspaceSyncFileOnDisk(destination)).sha256 !== file.expectedContent) {
      throw new WorkspaceSyncPullConflictError(
        `Installed replica file changed before finalization: ${file.relativePath}`
      );
    }
  }
}

async function cleanupReplicaStaging(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true });
}

async function cleanupStagingBestEffort(
  stagingRoot: string,
  cleanupStaging: (path: string) => Promise<void>
): Promise<void> {
  try {
    await cleanupStaging(stagingRoot);
  } catch (error) {
    console.warn(
      `[workspace-sync] Could not remove completed replica staging at ${stagingRoot}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function flushReplicaFileRequired(path: string): Promise<void> {
  await flushFile(path);
}

async function flushReplicaDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close();
  }
}

async function flushReplicaDirectoryChain(
  durability: ReplicaDurabilityBarrier,
  startPath: string,
  rootPath: string
): Promise<void> {
  const directories = new Set<string>();
  collectReplicaDirectoryChain(directories, startPath, rootPath);
  for (const directoryPath of replicaDirectoriesChildFirst(directories, rootPath)) {
    await durability.flushDirectory(directoryPath);
  }
}

function collectReplicaDirectoryChain(
  directories: Set<string>,
  startPath: string,
  rootPath: string
): void {
  const root = resolve(rootPath);
  let current = resolve(startPath);
  const fromRoot = relative(root, current);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Replica durability directory escapes its owned root.');
  }
  directories.add(current);
  while (current !== root) {
    current = dirname(current);
    directories.add(current);
  }
}

function replicaDirectoriesChildFirst(
  directories: ReadonlySet<string>,
  rootPath: string
): string[] {
  const root = resolve(rootPath);
  return [...directories].sort((left, right) => {
    const leftRelative = relative(root, left);
    const rightRelative = relative(root, right);
    const leftDepth = leftRelative === '' ? 0 : leftRelative.split(sep).length;
    const rightDepth = rightRelative === '' ? 0 : rightRelative.split(sep).length;
    return rightDepth - leftDepth || left.localeCompare(right);
  });
}

async function rollbackReplicaFiles(
  repoRootRealPath: string,
  installed: readonly InstalledReplicaFile[],
  backups: readonly BackedUpReplicaFile[],
  renameFile: ReplicaRenameFile,
  durability: ReplicaDurabilityBarrier
): Promise<void> {
  const preservedConcurrentPaths = new Set<string>();
  for (const file of [...installed].reverse()) {
    let currentContent: string;
    let destination: string;
    try {
      destination = await resolvePathWithVerifiedParent(
        repoRootRealPath,
        resolve(repoRootRealPath, file.relativePath),
        false
      );
      currentContent = (await hashWorkspaceSyncFileOnDisk(destination)).sha256;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    if (currentContent !== file.expectedContent) {
      preservedConcurrentPaths.add(file.relativePath);
      continue;
    }
    await rm(destination, { force: true });
    await durability.flushDirectory(dirname(destination));
  }

  for (const file of [...backups].reverse()) {
    if (preservedConcurrentPaths.has(file.relativePath)) continue;
    const destination = await resolvePathWithVerifiedParent(
      repoRootRealPath,
      resolve(repoRootRealPath, file.relativePath)
    );
    try {
      await lstat(destination);
      throw new Error(
        `Replica rollback destination was recreated concurrently: ${file.relativePath}`
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    await ensureNoSymlinkDirectoryChain(repoRootRealPath, dirname(destination));
    await renameFile(file.backupPath, destination);
    await durability.flushFile(destination);
    await durability.flushDirectory(dirname(file.backupPath));
    await flushReplicaDirectoryChain(durability, dirname(destination), repoRootRealPath);
  }
}

function assertExistingBindingMatchesPullBase(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceUuid: string;
    expectedRemoteVersionId: string;
    latest: DesktopSyncMaterializableVersion;
  }
): number {
  assertNoPackageRecoveryQuarantine(db, input.workspaceId);
  const binding = db
    .prepare(
      `SELECT workspace_uuid, remote_latest_version_id, remote_latest_version_number
       FROM workspace_sync_bindings
       WHERE workspace_id = ?
       LIMIT 1`
    )
    .get(input.workspaceId) as
    | {
        workspace_uuid: string;
        remote_latest_version_id: string | null;
        remote_latest_version_number: number | null;
      }
    | undefined;
  if (
    !binding ||
    binding.workspace_uuid !== input.workspaceUuid ||
    binding.remote_latest_version_id !== input.expectedRemoteVersionId
  ) {
    throw new WorkspaceSyncPullConflictError(
      'Workspace sync binding changed before a newer remote version could be applied.'
    );
  }
  if (
    binding.remote_latest_version_number === null ||
    input.latest.version.versionNumber <= binding.remote_latest_version_number
  ) {
    throw new Error('Downloaded cloud version is not newer than the bound local replica version.');
  }
  return binding.remote_latest_version_number;
}

function assertNoPackageRecoveryQuarantine(db: Database.Database, workspaceId: number): void {
  const quarantine = db
    .prepare(
      `SELECT 1
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND error_code = 'PACKAGE_RECOVERY_REQUIRED'
         AND status = 'failed'
       LIMIT 1`
    )
    .get(workspaceId);
  if (quarantine) {
    throw new WorkspaceSyncPullConflictError(
      'An interrupted package replacement must be repaired before applying a remote replica.'
    );
  }
}

function assertDownloadedLatestNotOlderThanSummary(
  remote: DesktopSyncWorkspaceSummaryResponse,
  latest: DesktopSyncMaterializableVersion
): void {
  if (latest.workspaceId !== remote.workspaceId) {
    throw new Error('Synced project latest response does not match the requested workspace.');
  }
  if (latest.version.versionNumber < remote.latest.versionNumber) {
    throw new Error('Downloaded cloud version is older than the listed remote version.');
  }
  if (latest.version.versionNumber !== remote.latest.versionNumber) return;
  if (remote.latest.versionId && latest.version.id !== remote.latest.versionId) {
    throw new Error('Downloaded cloud version id does not match the listed remote version.');
  }
  if (remote.latest.contentSha256 && latest.version.contentSha256 !== remote.latest.contentSha256) {
    throw new Error('Downloaded cloud version hash does not match the listed remote version.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertExistingRepoMatchesPullBase(
  repoPath: string,
  expectedLocalHeadSha: string,
  phase: string
): Promise<void> {
  const currentHeadSha = await resolveHeadCommit(repoPath);
  if (
    !expectedLocalHeadSha ||
    currentHeadSha !== expectedLocalHeadSha ||
    (await hasWorkspaceSyncWorkingChanges(repoPath))
  ) {
    throw new WorkspaceSyncPullConflictError(
      `Remote has a newer version while this local copy has unacknowledged changes (${phase}).`
    );
  }
}

export async function flushFreshRestoreDurably(input: {
  durability: ReplicaDurabilityBarrier;
  managedRootRealPath: string;
  workspacePath: string;
  repoPath: string;
  localHeadSha: string;
  operationPaths: readonly string[];
}): Promise<void> {
  const repoRootRealPath = await realpath(input.repoPath);
  const workspaceRealPath = await realpath(input.workspacePath);
  const uniquePaths = [...new Set(input.operationPaths)];
  const repoDirectories = new Set<string>();
  for (const relativePath of uniquePaths) {
    let filePath: string;
    try {
      filePath = await resolvePathWithVerifiedParent(
        repoRootRealPath,
        resolve(repoRootRealPath, relativePath),
        false
      );
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Restored managed path is not a regular file: ${relativePath}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    await input.durability.flushFile(filePath);
    collectReplicaDirectoryChain(repoDirectories, dirname(filePath), repoRootRealPath);
  }
  for (const directoryPath of replicaDirectoriesChildFirst(repoDirectories, repoRootRealPath)) {
    await input.durability.flushDirectory(directoryPath);
  }
  await input.durability.flushGitCommit(input.repoPath, input.localHeadSha, uniquePaths);
  await input.durability.flushDirectory(workspaceRealPath);
  await input.durability.flushDirectory(input.managedRootRealPath);
}

async function ensureManagedRootDir(managedRootDir: string): Promise<string> {
  await mkdir(managedRootDir, { recursive: true });
  return realpath(managedRootDir);
}

async function ensureNoSymlinkDirectoryChain(
  rootRealPath: string,
  targetDirectory: string,
  createMissing = true
): Promise<string> {
  const root = resolve(rootRealPath);
  const physicalRoot = await realpath(root);
  const target = resolve(targetDirectory);
  assertPathInsideRoot(root, target, 'Synced project directory escapes its managed root.');

  const rootStat = await lstat(physicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Synced project root is not a regular directory.');
  }

  let current = physicalRoot;
  const relativeDirectory = relative(root, target);
  const segments = relativeDirectory === '' ? [] : relativeDirectory.split(sep);
  for (const segment of segments) {
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!createMissing || !isNodeError(error) || error.code !== 'ENOENT') throw error;
      await mkdir(current, { recursive: false });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Synced project directory chain contains a non-directory or link.');
    }
    const currentRealPath = await realpath(current);
    assertPathInsideRoot(
      physicalRoot,
      currentRealPath,
      'Synced project directory escapes its managed root.'
    );
    current = currentRealPath;
  }
  return current;
}

async function resolvePathWithVerifiedParent(
  rootRealPath: string,
  destination: string,
  createParent = true
): Promise<string> {
  const resolvedDestination = resolve(destination);
  assertPathInsideRoot(
    rootRealPath,
    resolvedDestination,
    'Synced project file path escapes the managed repo.'
  );
  const verifiedParent = await ensureNoSymlinkDirectoryChain(
    rootRealPath,
    dirname(resolvedDestination),
    createParent
  );
  return join(verifiedParent, basename(resolvedDestination));
}

async function reserveManagedWorkspacePath(input: {
  workspacePath: string;
  managedRootRealPath: string;
  workspaceUuid: string;
}): Promise<void> {
  try {
    await mkdir(input.workspacePath, { recursive: false });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`Managed workspace path already exists for ${input.workspaceUuid}.`);
    }
    throw error;
  }

  const workspaceRealPath = await realpath(input.workspacePath);
  assertPathInsideRoot(
    input.managedRootRealPath,
    workspaceRealPath,
    'Managed workspace path escapes the managed root.'
  );
}

async function createTextFileInsideRepo(
  repoRootRealPath: string,
  destination: string,
  content: string | Uint8Array
): Promise<void> {
  const resolvedDestination = await resolvePathWithVerifiedParent(repoRootRealPath, destination);

  const handle = await open(resolvedDestination, 'wx');
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }

  const fileStat = await lstat(resolvedDestination);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error('Synced project file was not materialized as a regular file.');
  }

  const destinationRealPath = await realpath(resolvedDestination);
  assertPathInsideRoot(
    repoRootRealPath,
    destinationRealPath,
    'Synced project file escapes the managed repo.'
  );
}

async function createVerifiedStreamFileInsideRepo(
  repoRootRealPath: string,
  destination: string,
  response: Response,
  expected: WorkspaceSyncManifestFileV1
): Promise<void> {
  if (!response.body) throw new Error(`Workspace file download was empty: ${expected.path}.`);
  const resolvedDestination = await resolvePathWithVerifiedParent(repoRootRealPath, destination);
  const handle = await open(resolvedDestination, 'wx');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let verified = false;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const value = chunk.value;
      sizeBytes += value.byteLength;
      if (sizeBytes > expected.sizeBytes) {
        throw new Error(`Workspace file exceeded its accepted byte count: ${expected.path}.`);
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const written = await handle.write(value, offset, value.byteLength - offset, null);
        if (written.bytesWritten <= 0) {
          throw new Error(`Workspace file could not be written completely: ${expected.path}.`);
        }
        offset += written.bytesWritten;
      }
    }
    const contentSha256 = hash.digest('hex');
    if (sizeBytes !== expected.sizeBytes || contentSha256 !== expected.contentSha256) {
      throw new Error(`Workspace file failed integrity verification: ${expected.path}.`);
    }
    await handle.sync();
    verified = true;
  } finally {
    if (!verified) await reader.cancel().catch(() => undefined);
    await handle.close();
    if (!verified) await rm(resolvedDestination, { force: true }).catch(() => undefined);
  }

  const fileStat = await lstat(resolvedDestination);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error('Synced project file was not materialized as a regular file.');
  }
  const destinationRealPath = await realpath(resolvedDestination);
  assertPathInsideRoot(
    repoRootRealPath,
    destinationRealPath,
    'Synced project file escapes the managed repo.'
  );
}

async function replaceStagedFileInsideRepo(
  repoRootRealPath: string,
  destination: string,
  stagedPath: string,
  installFile: ReplicaInstallFile = installStagedFileNoReplace,
  durability: ReplicaDurabilityBarrier = DEFAULT_REPLICA_DURABILITY,
  stagingRoot: string = dirname(stagedPath)
): Promise<void> {
  await preflightReplaceDestination(repoRootRealPath, destination);
  const resolvedDestination = await resolvePathWithVerifiedParent(
    repoRootRealPath,
    destination,
    false
  );
  try {
    await lstat(resolvedDestination);
    throw new WorkspaceSyncPullConflictError(
      `Local path was recreated while the remote replica was being installed: ${relative(
        repoRootRealPath,
        resolvedDestination
      )}`
    );
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  const stagedStat = await lstat(stagedPath);
  if (stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
    throw new Error('Staged synced project content is not a regular file.');
  }
  await installFile(stagedPath, resolvedDestination);
  await durability.flushFile(resolvedDestination);
  await flushReplicaDirectoryChain(durability, dirname(resolvedDestination), repoRootRealPath);
  await flushReplicaDirectoryChain(durability, dirname(stagedPath), stagingRoot);

  const installedStat = await lstat(resolvedDestination);
  if (installedStat.isSymbolicLink() || !installedStat.isFile()) {
    throw new Error('Synced project file was not materialized as a regular file.');
  }
  const destinationRealPath = await realpath(resolvedDestination);
  assertPathInsideRoot(
    repoRootRealPath,
    destinationRealPath,
    'Synced project file escapes the managed repo.'
  );
}

async function installStagedFileNoReplace(
  stagedPath: string,
  destinationPath: string
): Promise<void> {
  await link(stagedPath, destinationPath);
}

async function preflightReplaceDestination(
  repoRootRealPath: string,
  destination: string
): Promise<void> {
  const resolvedDestination = await resolvePathWithVerifiedParent(repoRootRealPath, destination);

  try {
    const destinationStat = await lstat(resolvedDestination);
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      throw new Error('Synced project destination is not a regular file.');
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

function assertPathInsideRoot(rootRealPath: string, candidatePath: string, message: string): void {
  const relativePath = relative(rootRealPath, candidatePath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return;
  }
  throw new Error(message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function chooseWorkspaceUuid(
  db: Database.Database,
  remote: DesktopSyncWorkspaceSummaryResponse,
  createWorkspaceUuid: (() => string) | undefined
): string {
  const preferred = parseLocalWorkspaceId(remote.clientWorkspaceId);
  if (!selectWorkspaceByUuid(db, preferred)) return preferred;

  const generated = createWorkspaceUuid?.() ?? randomUUID();
  const parsed = parseLocalWorkspaceId(generated);
  if (selectWorkspaceByUuid(db, parsed)) {
    throw new Error('Generated local workspace id already exists.');
  }
  return parsed;
}

function parseLocalWorkspaceId(value: string): string {
  const trimmed = value.trim();
  const windowsBaseName = trimmed.split('.', 1)[0];
  if (
    !trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.endsWith('.') ||
    /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/i.test(windowsBaseName) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)
  ) {
    throw new Error('Remote project returned an invalid local workspace id.');
  }
  return trimmed;
}

function validateRestoreLockId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
    throw new Error('Workspace restore lock id is invalid.');
  }
  return trimmed;
}

function selectBindingByRemoteWorkspaceId(
  db: Database.Database,
  remoteWorkspaceId: string
): ExistingBindingRow | null {
  const row = db
    .prepare(
      `SELECT b.workspace_uuid,
              b.workspace_id,
              w.path,
              b.remote_workspace_id,
              b.enabled,
              b.remote_latest_version_id,
              b.remote_latest_version_number,
              b.remote_latest_content_sha256,
              b.last_acked_local_head_sha,
              b.last_downloaded_at
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.remote_workspace_id = ?
       LIMIT 1`
    )
    .get(remoteWorkspaceId) as ExistingBindingRow | undefined;
  return row ?? null;
}

function assertBindingSnapshotCurrent(db: Database.Database, expected: ExistingBindingRow): void {
  const current = selectBindingByRemoteWorkspaceId(db, expected.remote_workspace_id);
  if (
    !current ||
    current.workspace_uuid !== expected.workspace_uuid ||
    current.workspace_id !== expected.workspace_id ||
    current.path !== expected.path ||
    current.enabled !== expected.enabled ||
    current.remote_latest_version_id !== expected.remote_latest_version_id ||
    current.remote_latest_version_number !== expected.remote_latest_version_number ||
    current.remote_latest_content_sha256 !== expected.remote_latest_content_sha256 ||
    current.last_acked_local_head_sha !== expected.last_acked_local_head_sha ||
    current.last_downloaded_at !== expected.last_downloaded_at
  ) {
    throw new Error('The synced project binding changed while it was being opened.');
  }
}

function commitMissingLocalReplicaRepair(
  db: Database.Database,
  binding: ExistingBindingRow,
  remoteWorkspaceId: string,
  nowMs: number
): void {
  const changed = db
    .prepare(
      `UPDATE workspace_sync_bindings
       SET remote_workspace_id = NULL,
           enabled = 0,
           remote_latest_version_id = NULL,
           remote_latest_version_number = NULL,
           remote_latest_content_sha256 = NULL,
           last_acked_local_head_sha = NULL,
           last_downloaded_at = NULL,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND workspace_uuid = @workspaceUuid
         AND remote_workspace_id = @remoteWorkspaceId
         AND enabled = @enabled
         AND remote_latest_version_id IS @remoteLatestVersionId
         AND remote_latest_version_number IS @remoteLatestVersionNumber
         AND remote_latest_content_sha256 IS @remoteLatestContentSha256
         AND last_acked_local_head_sha IS @lastAckedLocalHeadSha
         AND last_downloaded_at IS @lastDownloadedAt`
    )
    .run({
      nowMs,
      workspaceId: binding.workspace_id,
      workspaceUuid: binding.workspace_uuid,
      remoteWorkspaceId,
      enabled: binding.enabled,
      remoteLatestVersionId: binding.remote_latest_version_id,
      remoteLatestVersionNumber: binding.remote_latest_version_number,
      remoteLatestContentSha256: binding.remote_latest_content_sha256,
      lastAckedLocalHeadSha: binding.last_acked_local_head_sha,
      lastDownloadedAt: binding.last_downloaded_at,
    }).changes;
  if (changed !== 1) {
    throw new Error('The missing local replica binding changed before repair could commit.');
  }

  db.prepare(
    `DELETE FROM workspace_sync_upload_snapshots
     WHERE job_id IN (
       SELECT id FROM workspace_sync_queue WHERE workspace_id = @workspaceId
     )`
  ).run({ workspaceId: binding.workspace_id });
  cancelWorkspaceSyncJobsForReplacedReplica(db, { workspaceId: binding.workspace_id, nowMs });
  db.prepare(
    `UPDATE workspaces
     SET archived_at = COALESCE(archived_at, @nowMs),
         last_opened_at = @nowMs
     WHERE id = @workspaceId`
  ).run({ workspaceId: binding.workspace_id, nowMs });
}

function selectWorkspaceByUuid(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceCollisionRow | null {
  const row = db
    .prepare(`SELECT id, repo_uuid FROM workspaces WHERE repo_uuid = ? LIMIT 1`)
    .get(workspaceUuid) as WorkspaceCollisionRow | undefined;
  return row ?? null;
}

function selectVersionByRemoteVersionId(
  db: Database.Database,
  remoteVersionId: string
): RemoteVersionCollisionRow | null {
  const row = db
    .prepare(
      `SELECT v.workspace_id, b.workspace_uuid
       FROM workspace_sync_versions v
       LEFT JOIN workspace_sync_bindings b ON b.workspace_id = v.workspace_id
       WHERE v.remote_version_id = ?
       LIMIT 1`
    )
    .get(remoteVersionId) as RemoteVersionCollisionRow | undefined;
  return row ?? null;
}

async function ownerAccountId(
  input: Pick<OpenWorkspaceSyncProjectInput, 'getActiveAccountId'>,
  remote: DesktopSyncWorkspaceSummaryResponse
): Promise<string> {
  const activeAccountId =
    (await input.getActiveAccountId?.()) ?? (await getActiveStoredSession())?.accountId ?? null;
  if (!activeAccountId) {
    throw new Error('Sign in before opening a synced project.');
  }
  if (
    remote.owner.kind === 'personal' &&
    remote.owner.accountId !== activeAccountId &&
    remoteAccess(remote).source === 'owner'
  ) {
    throw new Error('The signed-in account does not own this synced project.');
  }
  return activeAccountId;
}

function ownerOrgId(remote: DesktopSyncWorkspaceSummaryResponse): string | null {
  return remote.owner.kind === 'org' ? remote.owner.orgId : null;
}

function remoteOwnerAccountId(remote: DesktopSyncWorkspaceSummaryResponse): string | null {
  return remote.owner.kind === 'personal' ? remote.owner.accountId : null;
}

function bindingSharedWithOthers(remote: DesktopSyncWorkspaceSummaryResponse): number {
  const access = remoteAccess(remote);
  return remote.owner.kind === 'org' || access.source !== 'owner' ? 1 : 0;
}

export function versionAuthorDisplay(
  author: { accountId: string; email: string | null; displayName: string | null } | null | undefined
): string | null {
  if (!author) return null;
  return author.displayName ?? author.email ?? author.accountId;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nowMs(input: Pick<OpenWorkspaceSyncProjectInput, 'nowMs'>): number {
  return input.nowMs?.() ?? Date.now();
}

function actionError(message: string): WorkspaceSyncActionError {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

async function createBundleFileInsideRepo(
  root: string,
  destination: string,
  file: WorkspaceSyncBundle['files'][number]
): Promise<void> {
  const path = await resolvePathWithVerifiedParent(root, destination);

  try {
    await lstat(path);
    throw new Error('Synced project destination already exists.');
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  await materializeWorkspaceSyncFile(file, path);
  assertPathInsideRoot(root, await realpath(path), 'Synced project file escapes the managed repo.');
}
