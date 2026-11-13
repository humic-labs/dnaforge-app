import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type {
  WorkspaceSyncActionError,
  WorkspaceSyncConflictResolution,
  WorkspaceSyncResolveConflictResult,
} from '../shared/workspace-sync-ipc';
import { enqueueWorkspaceSyncJob } from './workspace-sync-queue';
import {
  createWorkspaceSyncProjectsClient,
  openWorkspaceSyncProject,
  downloadLatestMaterializableVersion,
  scientificManifestDetail,
  downloadScientificReceivingHistory,
  assertScientificReceivingAuthorization,
  remoteAccess,
  applyLatestToExistingManagedRepo,
  type DesktopSyncMaterializableVersion,
  type WorkspaceSyncReplacementQuiescer,
  type WorkspaceSyncProjectsClient,
} from './workspace-sync-projects';
import { resolveHeadCommit } from './workspace-git';
import { assertValidDesktopSyncLatestBundle } from './workspace-sync-bundle-integrity';
import { hasScientificCloudHistoryBinding } from './scientific-cloud-admission';
import { ScientificObjectStore } from './scientific-object-store';
import { installScientificWorkspaceCloudHistory } from './scientific-cloud-transfer';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { getActiveStoredSession } from './auth/session-store';
import { readPendingWorkspaceSyncRendererRefresh } from './workspace-sync-renderer-refresh-pending';
import {
  scientificCloudReplicaWasCommitted,
  type ScientificCloudReplicaCommit,
} from './workspace-sync-scientific-commit';
import { observeWorkspaceSync, workspaceSyncErrorCode } from './workspace-sync-observation';

export type WorkspaceSyncConflictClient = WorkspaceSyncProjectsClient;

export interface ResolveWorkspaceSyncConflictInput {
  workspaceUuid: string;
  resolution: WorkspaceSyncConflictResolution;
  managedRootDir: string;
  client?: WorkspaceSyncConflictClient;
  nowMs?: () => number;
  createJobId?: () => string;
  getCurrentLocalHeadSha?: (
    workspace: WorkspaceSyncConflictWorkspaceContext
  ) => string | null | Promise<string | null>;
  createWorkspaceUuid?: () => string;
  createRestoreLockId?: () => string;
  restoreLockTtlMs?: number;
  withReplacementSourceQuiesced?: WorkspaceSyncReplacementQuiescer;
  getActiveAccountId?: () => string | null | Promise<string | null>;
  scientificReplica?: Pick<
    Parameters<typeof applyLatestToExistingManagedRepo>[1],
    'onReplicaPreparing' | 'onReplicaApplied' | 'onReplicaAborted'
  >;
  resumeScientificReplica?: (workspaceUuid: string) => Promise<void>;
}

export interface WorkspaceSyncConflictWorkspaceContext {
  workspaceId: number;
  workspaceUuid: string;
  repoPath: string;
  remoteWorkspaceId: string;
  remoteLatestVersionId: string | null;
}

interface ConflictBindingRow {
  workspace_id: number;
  workspace_uuid: string;
  workspace_path: string;
  owner_account_id: string;
  remote_workspace_id: string | null;
  enabled: number;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  remote_latest_content_sha256: string | null;
  last_acked_local_head_sha: string | null;
  last_downloaded_at: number | null;
  updated_at: number;
}

interface ConflictJobRow {
  id: string;
  error_code: string | null;
  error_message: string | null;
}

interface RemoteVersionRow {
  workspace_id: number;
}

const RESOLVABLE_CONFLICT_CODES = new Set(['CONFLICT', 'SYNC_CONFLICT']);

export async function resolveWorkspaceSyncConflict(
  db: Database.Database,
  input: ResolveWorkspaceSyncConflictInput
): Promise<WorkspaceSyncResolveConflictResult> {
  const now = () => input.nowMs?.() ?? Date.now();
  const startedAt = now();
  const observe = (sync_outcome: 'kept_local' | 'used_remote' | 'failed', error_code?: string) =>
    observeWorkspaceSync({
      sync_operation: 'conflict_resolve',
      sync_outcome,
      ...(error_code ? { error_code } : {}),
      duration_ms: Math.max(0, now() - startedAt),
    });
  try {
    const binding = requireConflictBinding(db, input.workspaceUuid);
    if (!binding.remote_workspace_id) {
      throw new Error('Workspace is not bound to a cloud sync project.');
    }

    const conflictJobs = selectResolvableConflictJobs(db, binding.workspace_id);
    if (conflictJobs.length === 0) {
      throw new Error('No stale-base sync conflict is pending for this workspace.');
    }

    const result =
      input.resolution === 'keep_local'
        ? await resolveKeepLocal(db, input, binding, conflictJobs)
        : await resolveUseRemote(db, input, binding, conflictJobs);
    if (result.ok) observe(result.resolution === 'keep_local' ? 'kept_local' : 'used_remote');
    else observe('failed', workspaceSyncErrorCode(result.code));
    return result;
  } catch (error) {
    observe('failed', workspaceSyncErrorCode(error));
    return actionError(error instanceof Error ? error.message : 'Could not resolve sync conflict.');
  }
}

async function resolveKeepLocal(
  db: Database.Database,
  input: ResolveWorkspaceSyncConflictInput,
  binding: ConflictBindingRow,
  conflictJobs: readonly ConflictJobRow[]
): Promise<WorkspaceSyncResolveConflictResult> {
  if (hasScientificCloudHistoryBinding(db, binding.workspace_id)) {
    if (!input.withReplacementSourceQuiesced)
      throw new Error('Scientific conflict resolution requires its native runtime owner.');
    return input.withReplacementSourceQuiesced(binding.workspace_uuid, () =>
      resolveScientificKeepLocal(db, input, binding, conflictJobs)
    );
  }
  const latest = await client(input).downloadLatest(requireRemoteWorkspaceId(binding));
  assertLatestMatchesBinding(latest, binding);
  assertValidDesktopSyncLatestBundle(latest);

  const localHeadSha = await currentLocalHeadSha(input, binding);
  const nowMs = input.nowMs?.() ?? Date.now();

  db.transaction(() => {
    recordRemoteLatestVersion(db, {
      workspaceId: binding.workspace_id,
      latest,
      localHeadSha: null,
      nowMs,
    });
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = ?,
           remote_latest_version_number = ?,
           remote_latest_content_sha256 = ?,
           last_downloaded_at = ?,
           updated_at = ?
       WHERE workspace_id = ?`
    ).run(
      latest.version.id,
      latest.version.versionNumber,
      latest.version.contentSha256,
      nowMs,
      nowMs,
      binding.workspace_id
    );
    cancelConflictJobs(db, conflictJobs, 'CONFLICT_RESOLVED_KEEP_LOCAL', nowMs);
    enqueueWorkspaceSyncJob(db, {
      id: input.createJobId?.() ?? randomUUID(),
      workspaceId: binding.workspace_id,
      operation: 'upload',
      idempotencyKey: idempotencyKeyFor(binding.workspace_uuid, latest.version.id, localHeadSha),
      baseRemoteVersionId: latest.version.id,
      localHeadSha,
      nowMs,
    });
  })();

  return { ok: true, resolution: 'keep_local' };
}

async function resolveScientificKeepLocal(
  db: Database.Database,
  input: ResolveWorkspaceSyncConflictInput,
  binding: ConflictBindingRow,
  conflictJobs: readonly ConflictJobRow[]
): Promise<WorkspaceSyncResolveConflictResult> {
  const transport = client(input);
  const accountId =
    (await input.getActiveAccountId?.()) ?? (await getActiveStoredSession())?.accountId;
  if (accountId !== binding.owner_account_id)
    throw new Error('Scientific conflict belongs to another active account.');
  const remote = (await transport.listWorkspaces()).find(
    (value) => value.workspaceId === binding.remote_workspace_id
  );
  if (!remote || remoteAccess(remote).role === 'viewer')
    throw new Error('Scientific project is unavailable for keeping local changes.');
  const latest = scientificManifestDetail(
    await downloadLatestMaterializableVersion(transport, remote)
  );
  if (!latest)
    throw new Error('Scientific conflict cannot discard its history through a file-only version.');
  assertLatestMatchesBinding(latest, binding);
  const downloaded = await downloadScientificReceivingHistory(transport, accountId, remote, latest);
  const release = await acquireWorkspaceSyncMutationLease(binding.workspace_path);
  try {
    const head = new ScientificObjectStore(db, binding.workspace_id).catalog().head;
    const localHeadSha = await currentLocalHeadSha(input, binding);
    if (!localHeadSha)
      throw new Error('Scientific local history requires its durable repository head.');
    const retained = await installScientificWorkspaceCloudHistory(db, {
      workspaceId: binding.workspace_id,
      mutationLease: release,
      descriptor: latest.scientificHistory!,
      archive: downloaded.archive,
      sources: downloaded.sources,
      manifest: latest.manifest,
      blobRefs: latest.scientificBlobRefs!,
      expectedHead: head,
      remoteWorkspaceId: remote.workspaceId,
      binding: {
        ownerAccountId: accountId,
        remoteWorkspaceId: remote.workspaceId,
        baseVersionId: binding.remote_latest_version_id,
      },
      resolution: 'retain-only',
      beforeCommit: async () => {
        await assertScientificReceivingAuthorization(transport, accountId, remote, latest);
        assertConflictBindingUnchanged(db, binding);
      },
    });
    if (retained.kind !== 'retained')
      throw new Error('Scientific local history changed while retaining the remote branch.');

    await assertScientificReceivingAuthorization(transport, accountId, remote, latest);
    const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      db.transaction(() => {
        assertConflictBindingUnchanged(db, binding);
        if (new ScientificObjectStore(db, binding.workspace_id).catalog().head !== head)
          throw new Error('Scientific accepted head changed before keeping local history.');
        const nowMs = input.nowMs?.() ?? Date.now();
        recordRemoteLatestVersion(db, {
          workspaceId: binding.workspace_id,
          latest,
          localHeadSha: null,
          nowMs,
        });
        db.prepare(
          `UPDATE workspace_sync_bindings SET remote_latest_version_id=?,remote_latest_version_number=?,remote_latest_content_sha256=?,
          last_downloaded_at=?,updated_at=?,access_role=?,access_source=? WHERE workspace_id=?`
        ).run(
          latest.version.id,
          latest.version.versionNumber,
          latest.version.contentSha256,
          nowMs,
          nowMs,
          remoteAccess(remote).role,
          remoteAccess(remote).source,
          binding.workspace_id
        );
        cancelConflictJobs(db, conflictJobs, 'CONFLICT_RESOLVED_KEEP_LOCAL', nowMs);
        enqueueWorkspaceSyncJob(db, {
          id: input.createJobId?.() ?? randomUUID(),
          workspaceId: binding.workspace_id,
          operation: 'upload',
          idempotencyKey: idempotencyKeyFor(
            binding.workspace_uuid,
            latest.version.id,
            localHeadSha
          ),
          baseRemoteVersionId: latest.version.id,
          localHeadSha,
          nowMs,
        });
      })();
    } finally {
      releaseFence();
    }
    return { ok: true, resolution: 'keep_local', workspaceUuid: binding.workspace_uuid };
  } finally {
    release();
  }
}

function assertConflictBindingUnchanged(db: Database.Database, expected: ConflictBindingRow): void {
  const current = requireConflictBinding(db, expected.workspace_uuid);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error('Scientific conflict binding changed before resolution.');
}

async function resolveUseRemote(
  db: Database.Database,
  input: ResolveWorkspaceSyncConflictInput,
  binding: ConflictBindingRow,
  conflictJobs: readonly ConflictJobRow[]
): Promise<WorkspaceSyncResolveConflictResult> {
  if (hasScientificCloudHistoryBinding(db, binding.workspace_id)) {
    if (!input.withReplacementSourceQuiesced)
      throw new Error('Scientific conflict resolution requires its native runtime owner.');
    return input.withReplacementSourceQuiesced(binding.workspace_uuid, () =>
      resolveScientificUseRemote(db, input, binding, conflictJobs)
    );
  }
  const remoteWorkspaceId = requireRemoteWorkspaceId(binding);
  const nowMs = input.nowMs?.() ?? Date.now();

  const result = await openWorkspaceSyncProject(db, {
    remoteWorkspaceId,
    managedRootDir: input.managedRootDir,
    client: client(input),
    nowMs: () => nowMs,
    createWorkspaceUuid: input.createWorkspaceUuid,
    createRestoreLockId: input.createRestoreLockId,
    restoreLockTtlMs: input.restoreLockTtlMs,
    withReplacementSourceQuiesced: input.withReplacementSourceQuiesced,
    getActiveAccountId: input.getActiveAccountId,
    replacementCutover: {
      sourceWorkspaceId: binding.workspace_id,
      remoteWorkspaceId,
      commit: () => commitUseRemoteCutover(db, binding, conflictJobs, nowMs),
    },
  });
  if (!result.ok) return result;

  return {
    ok: true,
    resolution: 'use_remote',
    workspaceUuid: result.workspaceUuid,
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

async function resolveScientificUseRemote(
  db: Database.Database,
  input: ResolveWorkspaceSyncConflictInput,
  binding: ConflictBindingRow,
  conflictJobs: readonly ConflictJobRow[]
): Promise<WorkspaceSyncResolveConflictResult> {
  const transport = client(input);
  const accountId =
    (await input.getActiveAccountId?.()) ?? (await getActiveStoredSession())?.accountId;
  if (accountId !== binding.owner_account_id)
    throw new Error('Scientific conflict belongs to another active account.');
  const remote = (await transport.listWorkspaces()).find(
    (value) => value.workspaceId === binding.remote_workspace_id
  );
  if (!remote) throw new Error('Scientific remote history is unavailable for this account.');
  const latest = scientificManifestDetail(
    await downloadLatestMaterializableVersion(transport, remote)
  );
  if (!latest || !binding.remote_latest_version_id)
    throw new Error(
      'Scientific conflict requires complete retained history and its current cloud base.'
    );
  assertLatestMatchesBinding(latest, binding);
  const localHeadSha = await currentLocalHeadSha(input, binding);
  if (!localHeadSha)
    throw new Error('Scientific local history requires its durable repository head.');
  const commit: ScientificCloudReplicaCommit = {
    mode: 'apply',
    workspaceUuid: binding.workspace_uuid,
    repoPath: binding.workspace_path,
    ownerAccountId: accountId,
    remote,
    version: latest.version,
    baseVersionId: binding.remote_latest_version_id,
    baseVersionNumber: binding.remote_latest_version_number,
    localHeadSha: binding.last_acked_local_head_sha ?? '',
    installedPaths: latest.manifest.files.map((file) => file.path),
    excludedSummary: {},
    nowMs: input.nowMs?.() ?? Date.now(),
  };
  if (
    scientificCloudReplicaWasCommitted(
      db,
      binding.workspace_id,
      commit,
      latest.scientificHistory!
    ) &&
    localHeadSha === binding.last_acked_local_head_sha
  ) {
    await assertScientificReceivingAuthorization(transport, accountId, remote, latest);
    if (
      readPendingWorkspaceSyncRendererRefresh(db, binding.workspace_id) &&
      !input.resumeScientificReplica
    )
      throw new Error('Scientific committed replica still requires its native viewer refresh.');
    await input.resumeScientificReplica?.(binding.workspace_uuid);
  } else
    await applyLatestToExistingManagedRepo(db, {
      workspaceId: binding.workspace_id,
      workspaceUuid: binding.workspace_uuid,
      repoPath: binding.workspace_path,
      remote,
      latest,
      client: transport,
      downloadManifestFile: transport.downloadManifestFile,
      expectedLocalHeadSha: localHeadSha,
      expectedRemoteVersionId: binding.remote_latest_version_id,
      nowMs: input.nowMs?.() ?? Date.now(),
      scientificResolution: 'replace-and-retain',
      ...input.scientificReplica,
    });
  const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    db.transaction(() => {
      const current = requireConflictBinding(db, binding.workspace_uuid);
      if (
        current.owner_account_id !== accountId ||
        current.remote_workspace_id !== remote.workspaceId ||
        current.remote_latest_version_id !== latest.version.id
      )
        throw new Error('Scientific remote choice changed before its conflict could settle.');
      const nowMs = input.nowMs?.() ?? Date.now();
      cancelConflictJobs(db, conflictJobs, 'CONFLICT_RESOLVED_USE_REMOTE', nowMs);

      if (remoteAccess(remote).role !== 'viewer')
        enqueueWorkspaceSyncJob(db, {
          id: input.createJobId?.() ?? randomUUID(),
          workspaceId: binding.workspace_id,
          operation: 'upload',
          idempotencyKey: idempotencyKeyFor(
            binding.workspace_uuid,
            latest.version.id,
            current.last_acked_local_head_sha
          ),
          baseRemoteVersionId: latest.version.id,
          localHeadSha: current.last_acked_local_head_sha,
          nowMs,
        });
    })();
  } finally {
    releaseFence();
  }
  return { ok: true, resolution: 'use_remote', workspaceUuid: binding.workspace_uuid };
}

function requireConflictBinding(db: Database.Database, workspaceUuid: string): ConflictBindingRow {
  const row = db
    .prepare(
      `SELECT b.workspace_id,
              b.workspace_uuid,
              w.path AS workspace_path,
              b.owner_account_id,
              b.remote_workspace_id,
              b.enabled,
              b.remote_latest_version_id,
              b.remote_latest_version_number,
              b.remote_latest_content_sha256,
              b.last_acked_local_head_sha,
              b.last_downloaded_at,
              b.updated_at
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.workspace_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as ConflictBindingRow | undefined;
  if (!row) throw new Error(`Workspace sync binding not found for ${workspaceUuid}.`);
  return row;
}

function selectResolvableConflictJobs(
  db: Database.Database,
  workspaceId: number
): ConflictJobRow[] {
  const rows = db
    .prepare(
      `SELECT id, error_code, error_message
       FROM workspace_sync_queue
       WHERE workspace_id = ?
         AND status = 'failed'
         AND error_code IN ('CONFLICT', 'SYNC_CONFLICT')
       ORDER BY updated_at DESC, created_at DESC, id`
    )
    .all(workspaceId) as ConflictJobRow[];
  return rows.filter((row) => RESOLVABLE_CONFLICT_CODES.has(row.error_code ?? ''));
}

function recordRemoteLatestVersion(
  db: Database.Database,
  input: {
    workspaceId: number;
    latest: DesktopSyncMaterializableVersion;
    localHeadSha: string | null;
    nowMs: number;
  }
): void {
  const collision = selectRemoteVersion(db, input.latest.version.id);
  if (collision && collision.workspace_id !== input.workspaceId) {
    throw new Error('Remote version is already linked to another local workspace.');
  }

  db.prepare(`UPDATE workspace_sync_versions SET is_latest = 0 WHERE workspace_id = ?`).run(
    input.workspaceId
  );
  db.prepare(
    `INSERT INTO workspace_sync_versions (
      id, workspace_id, remote_version_id, version_number, content_sha256,
      local_head_sha, file_count, size_bytes, status, is_latest, created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @remoteVersionId, @versionNumber, @contentSha256,
      @localHeadSha, @fileCount, @sizeBytes, 'ready', 1, @nowMs, @nowMs
    )
    ON CONFLICT(remote_version_id) DO UPDATE SET
      version_number = excluded.version_number,
      content_sha256 = excluded.content_sha256,
      local_head_sha = excluded.local_head_sha,
      file_count = excluded.file_count,
      size_bytes = excluded.size_bytes,
      status = 'ready',
      is_latest = 1,
      updated_at = excluded.updated_at,
      deleted_at = NULL`
  ).run({
    id: input.latest.version.id,
    workspaceId: input.workspaceId,
    remoteVersionId: input.latest.version.id,
    versionNumber: input.latest.version.versionNumber,
    contentSha256: input.latest.version.contentSha256,
    localHeadSha: input.localHeadSha,
    fileCount: input.latest.version.fileCount,
    sizeBytes: input.latest.version.sizeBytes,
    nowMs: input.nowMs,
  });
}

function selectRemoteVersion(
  db: Database.Database,
  remoteVersionId: string
): RemoteVersionRow | null {
  const row = db
    .prepare(
      `SELECT workspace_id
       FROM workspace_sync_versions
       WHERE remote_version_id = ?
       LIMIT 1`
    )
    .get(remoteVersionId) as RemoteVersionRow | undefined;
  return row ?? null;
}

function cancelConflictJobs(
  db: Database.Database,
  jobs: readonly ConflictJobRow[],
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

function commitUseRemoteCutover(
  db: Database.Database,
  binding: ConflictBindingRow,
  conflictJobs: readonly ConflictJobRow[],
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
         AND remote_workspace_id IS @remoteWorkspaceId
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
      remoteWorkspaceId: binding.remote_workspace_id,
      enabled: binding.enabled,
      remoteLatestVersionId: binding.remote_latest_version_id,
      remoteLatestVersionNumber: binding.remote_latest_version_number,
      remoteLatestContentSha256: binding.remote_latest_content_sha256,
      lastAckedLocalHeadSha: binding.last_acked_local_head_sha,
      lastDownloadedAt: binding.last_downloaded_at,
    }).changes;
  if (changed !== 1) {
    throw new Error('The synced project binding changed before replacement could commit.');
  }
  cancelConflictJobs(db, conflictJobs, 'CONFLICT_RESOLVED_USE_REMOTE', nowMs);
}

async function currentLocalHeadSha(
  input: ResolveWorkspaceSyncConflictInput,
  binding: ConflictBindingRow
): Promise<string | null> {
  const context: WorkspaceSyncConflictWorkspaceContext = {
    workspaceId: binding.workspace_id,
    workspaceUuid: binding.workspace_uuid,
    repoPath: binding.workspace_path,
    remoteWorkspaceId: requireRemoteWorkspaceId(binding),
    remoteLatestVersionId: binding.remote_latest_version_id,
  };
  return input.getCurrentLocalHeadSha
    ? await input.getCurrentLocalHeadSha(context)
    : await resolveHeadCommit(binding.workspace_path);
}

function client(input: ResolveWorkspaceSyncConflictInput): WorkspaceSyncConflictClient {
  return input.client ?? createWorkspaceSyncProjectsClient();
}

function assertLatestMatchesBinding(
  latest: DesktopSyncMaterializableVersion,
  binding: ConflictBindingRow
): void {
  if (latest.workspaceId !== binding.remote_workspace_id) {
    throw new Error('Latest cloud version does not match the bound workspace.');
  }
  if (
    binding.remote_latest_version_number !== null &&
    latest.version.versionNumber < binding.remote_latest_version_number
  ) {
    throw new Error('Latest cloud version is older than the bound replica version.');
  }
  if (
    binding.remote_latest_version_number !== null &&
    latest.version.versionNumber === binding.remote_latest_version_number &&
    binding.remote_latest_version_id !== null &&
    latest.version.id !== binding.remote_latest_version_id
  ) {
    throw new Error('Latest cloud version id conflicts with the bound replica version number.');
  }
}

function requireRemoteWorkspaceId(binding: ConflictBindingRow): string {
  if (!binding.remote_workspace_id) {
    throw new Error('Workspace is not bound to a cloud sync project.');
  }
  return binding.remote_workspace_id;
}

function idempotencyKeyFor(
  workspaceUuid: string,
  baseRemoteVersionId: string | null,
  localHeadSha: string | null
): string {
  return `upload:${workspaceUuid}:${baseRemoteVersionId ?? 'no-base'}:${localHeadSha ?? 'no-head'}`;
}

function actionError(message: string): WorkspaceSyncActionError {
  return {
    ok: false,
    code: 'INVALID_REQUEST',
    message,
  };
}
