import { settleWorkspaceSyncRestoreTelemetry } from './workspace-sync-restore-telemetry';
import type Database from 'better-sqlite3';
import type { ScientificCloudHistoryV1 } from '@waypoint/scientific-objects';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle';
import { createHash } from 'node:crypto';
import type {
  DesktopSyncManifestVersionResponse,
  DesktopSyncWorkspaceSummaryResponse,
} from './workspace-sync-project-types';
import type { WorkspaceSyncReplicaAppliedNotice } from './workspace-sync-replica-publisher';
import type { WorkspaceSyncExcludedSummary } from '../shared/cloud-sync-status';
import { workspaceSyncScientificContentSha256 } from './workspace-sync-scientific-history';
import { recordWorkspaceSyncReplicaFiles } from './workspace-sync-replica-files';
import { recordPendingWorkspaceSyncRendererRefresh } from './workspace-sync-renderer-refresh-pending';
import {
  rehydrateWorkspaceSyncState,
  LEGACY_LIMS_NOT_IMPORTED_WARNING,
} from './workspace-sync-restore';
import { serializeWorkspaceSyncExcludedSummary } from './workspace-sync-exclusions';
import { assertScientificRestoreOwner } from './scientific-object-store';

export interface ScientificCloudReplicaCommit {
  readonly mode: 'apply' | 'restore';
  readonly workspaceUuid: string;
  readonly repoPath: string;
  readonly ownerAccountId: string;
  readonly remote: DesktopSyncWorkspaceSummaryResponse;
  readonly version: DesktopSyncManifestVersionResponse['version'];
  readonly baseVersionId: string | null;
  readonly baseVersionNumber: number | null;
  readonly localHeadSha: string;
  readonly installedPaths: readonly string[];
  readonly excludedSummary: WorkspaceSyncExcludedSummary;
  readonly nowMs: number;
  readonly restoreLockId?: string;
  readonly rendererNotice?: WorkspaceSyncReplicaAppliedNotice;
}

export function activateScientificRestoreInsideTx(
  db: Database.Database,
  workspaceId: number,
  input: ScientificCloudReplicaCommit
): void {
  if (!db.inTransaction || input.mode !== 'restore' || !input.restoreLockId)
    throw new Error('Scientific staging activation requires its owned restore transaction.');
  assertScientificRestoreOwner(db, workspaceId, {
    workspaceUuid: input.workspaceUuid,
    repoPath: input.repoPath,
    ownerAccountId: input.ownerAccountId,
    remoteWorkspaceId: input.remote.workspaceId,
    remoteVersionId: input.version.id,
    lockId: input.restoreLockId,
  });
  const updated = db
    .prepare(
      'UPDATE workspaces SET archived_at=NULL,last_opened_at=? WHERE id=? AND trashed_at IS NULL'
    )
    .run(input.nowMs, workspaceId);
  if (updated.changes !== 1)
    throw new Error('Scientific staging project could not activate inside acceptance.');
}

export function recordAppliedCloudVersionInsideTx(
  db: Database.Database,
  input: {
    workspaceId: number;
    version: Pick<
      DesktopSyncManifestVersionResponse['version'],
      'id' | 'versionNumber' | 'contentSha256' | 'fileCount' | 'sizeBytes' | 'createdBy'
    >;
    localHeadSha: string;
    excludedSummary: WorkspaceSyncExcludedSummary;
    nowMs: number;
  }
): void {
  if (!db.inTransaction)
    throw new Error('Cloud version acceptance requires its database transaction.');
  const version = input.version;
  const collision = db
    .prepare('SELECT workspace_id FROM workspace_sync_versions WHERE id=? OR remote_version_id=?')
    .get(version.id, version.id) as { workspace_id: number } | undefined;
  if (collision && collision.workspace_id !== input.workspaceId)
    throw new Error('Cloud version belongs to another local workspace.');
  db.prepare('UPDATE workspace_sync_versions SET is_latest=0 WHERE workspace_id=?').run(
    input.workspaceId
  );
  db.prepare(
    `INSERT INTO workspace_sync_versions (
    id,workspace_id,remote_version_id,version_number,content_sha256,local_head_sha,file_count,size_bytes,
    excluded_summary_json,status,is_latest,created_at,updated_at,created_by_account_id,created_by_display
  ) VALUES (?,?,?,?,?,?,?,?,?,'ready',1,?,?,?,?)
  ON CONFLICT(remote_version_id) DO UPDATE SET version_number=excluded.version_number,content_sha256=excluded.content_sha256,
    local_head_sha=excluded.local_head_sha,file_count=excluded.file_count,size_bytes=excluded.size_bytes,
    excluded_summary_json=excluded.excluded_summary_json,status='ready',is_latest=1,updated_at=excluded.updated_at,deleted_at=NULL,
    created_by_account_id=COALESCE(excluded.created_by_account_id,created_by_account_id),
    created_by_display=COALESCE(excluded.created_by_display,created_by_display)`
  ).run(
    version.id,
    input.workspaceId,
    version.id,
    version.versionNumber,
    version.contentSha256,
    input.localHeadSha,
    version.fileCount,
    version.sizeBytes,
    serializeWorkspaceSyncExcludedSummary(input.excludedSummary),
    input.nowMs,
    input.nowMs,
    version.createdBy?.accountId ?? null,
    version.createdBy?.displayName ??
      version.createdBy?.email ??
      version.createdBy?.accountId ??
      null
  );
  const updated = db
    .prepare(
      `UPDATE workspace_sync_bindings SET remote_latest_version_id=?,remote_latest_version_number=?,
    remote_latest_content_sha256=?,last_acked_local_head_sha=?,last_downloaded_at=?,updated_at=? WHERE workspace_id=? AND enabled=1`
    )
    .run(
      version.id,
      version.versionNumber,
      version.contentSha256,
      input.localHeadSha,
      input.nowMs,
      input.nowMs,
      input.workspaceId
    );
  if (updated.changes !== 1) throw new Error('Cloud binding changed before version acceptance.');
}

export function commitScientificCloudReplicaInsideTx(
  db: Database.Database,
  workspaceId: number,
  input: ScientificCloudReplicaCommit,
  descriptor: ScientificCloudHistoryV1,
  manifest: WorkspaceSyncManifestV1
): void {
  if (!db.inTransaction)
    throw new Error('Scientific cloud replica requires its acceptance transaction.');
  const workspace = db
    .prepare('SELECT path,repo_uuid,archived_at,trashed_at FROM workspaces WHERE id=?')
    .get(workspaceId) as
    | { path: string; repo_uuid: string; archived_at: number | null; trashed_at: number | null }
    | undefined;
  if (
    !workspace ||
    workspace.path !== input.repoPath ||
    workspace.repo_uuid !== input.workspaceUuid ||
    workspace.archived_at !== null ||
    workspace.trashed_at !== null
  )
    throw new Error('Scientific receiving workspace changed before acceptance.');
  const fileSha = createHash('sha256')
    .update(workspaceSyncManifestHashInput(manifest))
    .digest('hex');
  if (
    input.version.representation !== 'scientific_manifest_v1' ||
    input.version.fileManifestSha256 !== fileSha ||
    input.version.contentSha256 !== workspaceSyncScientificContentSha256(fileSha, descriptor) ||
    input.version.fileCount !== manifest.files.length ||
    input.version.sizeBytes !== manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)
  )
    throw new Error('Scientific cloud commit has inconsistent authority.');
  const identity = db
    .prepare(
      'SELECT logical_workspace_id,remote_workspace_id FROM scientific_workspace_identities WHERE workspace_id=?'
    )
    .get(workspaceId) as { logical_workspace_id: string; remote_workspace_id: string } | undefined;
  const accepted = db
    .prepare(
      "SELECT head FROM scientific_revision_refs WHERE workspace_id=? AND ref_name='accepted'"
    )
    .get(workspaceId) as { head: string | null } | undefined;
  if (
    identity?.logical_workspace_id !== descriptor.logicalWorkspaceId ||
    identity.remote_workspace_id !== input.remote.workspaceId ||
    accepted?.head !== descriptor.acceptedHead
  )
    throw new Error('Scientific cloud commit does not match adopted graph authority.');
  if (
    db
      .prepare(
        "SELECT 1 FROM workspace_sync_queue WHERE workspace_id=? AND error_code='PACKAGE_RECOVERY_REQUIRED' AND status='failed'"
      )
      .get(workspaceId)
  )
    throw new Error('Scientific workspace has unfinished package recovery.');
  let restoreLockId: string | undefined;
  if (input.mode === 'restore') {
    const lock = db
      .prepare(
        `SELECT lock_id,source_remote_version_id,remote_workspace_id,owner_account_id,status FROM workspace_sync_restore_locks WHERE workspace_id=?`
      )
      .get(workspaceId) as
      | {
          lock_id: string;
          source_remote_version_id: string;
          remote_workspace_id: string;
          owner_account_id: string;
          status: string;
        }
      | undefined;
    if (
      !input.restoreLockId ||
      !lock ||
      lock.lock_id !== input.restoreLockId ||
      lock.source_remote_version_id !== input.version.id ||
      lock.remote_workspace_id !== input.remote.workspaceId ||
      lock.owner_account_id !== input.ownerAccountId ||
      lock.status !== 'restoring' ||
      db.prepare('SELECT 1 FROM workspace_sync_bindings WHERE workspace_id=?').get(workspaceId)
    )
      throw new Error('Scientific restore intent changed before acceptance.');
    restoreLockId = lock.lock_id;
    const org = input.remote.owner.kind === 'org' ? input.remote.owner.orgId : null;
    const remoteOwner =
      input.remote.owner.kind === 'personal' ? input.remote.owner.accountId : null;
    const access = input.remote.access ?? {
      role: 'owner',
      source: org ? 'org_admin' : 'owner',
      orgId: org,
    };
    db.prepare(
      `INSERT INTO workspace_sync_bindings (workspace_id,workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,
      remote_latest_version_id,remote_latest_version_number,remote_latest_content_sha256,last_acked_local_head_sha,last_downloaded_at,
      created_at,updated_at,remote_owner_account_id,access_role,access_source,shared_with_others) VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      workspaceId,
      input.workspaceUuid,
      input.ownerAccountId,
      org,
      input.remote.workspaceId,
      input.version.id,
      input.version.versionNumber,
      input.version.contentSha256,
      input.localHeadSha,
      input.nowMs,
      input.nowMs,
      input.nowMs,
      remoteOwner,
      access.role,
      access.source,
      org || access.source !== 'owner' ? 1 : 0
    );
  } else {
    const binding = db
      .prepare(
        `SELECT workspace_uuid,owner_account_id,remote_workspace_id,remote_latest_version_id,
      remote_latest_version_number,owner_org_id,remote_owner_account_id,enabled FROM workspace_sync_bindings WHERE workspace_id=?`
      )
      .get(workspaceId) as
      | {
          workspace_uuid: string;
          owner_account_id: string;
          remote_workspace_id: string;
          remote_latest_version_id: string | null;
          remote_latest_version_number: number | null;
          owner_org_id: string | null;
          remote_owner_account_id: string | null;
          enabled: number;
        }
      | undefined;
    const ownerMatches =
      input.remote.owner.kind === 'org'
        ? binding?.owner_org_id === input.remote.owner.orgId
        : binding?.owner_org_id === null &&
          (binding.remote_owner_account_id ?? binding.owner_account_id) ===
            input.remote.owner.accountId;
    if (
      !binding ||
      !ownerMatches ||
      binding.enabled !== 1 ||
      binding.workspace_uuid !== input.workspaceUuid ||
      binding.owner_account_id !== input.ownerAccountId ||
      binding.remote_workspace_id !== input.remote.workspaceId ||
      binding.remote_latest_version_id !== input.baseVersionId ||
      binding.remote_latest_version_number !== input.baseVersionNumber
    )
      throw new Error('Scientific cloud binding changed before acceptance.');
  }
  const rehydrated = rehydrateWorkspaceSyncState(db, {
    workspaceId,
    workspaceRoot: input.repoPath,
    nowMs: input.nowMs,
    strict: true,
    scientificHistoryFormat: 1,
  });
  recordAppliedCloudVersionInsideTx(db, { ...input, workspaceId });
  recordWorkspaceSyncReplicaFiles(db, {
    workspaceUuid: input.workspaceUuid,
    remoteWorkspaceId: input.remote.workspaceId,
    remoteVersionId: input.version.id,
    paths: input.installedPaths,
    nowMs: input.nowMs,
  });

  if (descriptor.acceptedHead !== null)
    db.prepare(
      `UPDATE scientific_materialization_jobs SET status='succeeded',last_error=NULL,updated_at=?
    WHERE workspace_id=? AND version_id=? AND delivery_kind='history-adoption' AND status='pending'`
    ).run(input.nowMs, workspaceId, descriptor.acceptedHead);
  if (input.rendererNotice) {
    const notebooks = db
      .prepare(
        "SELECT DISTINCT entity_id FROM catalog_entity_files WHERE workspace_id=? AND file_kind='waypoint-notebook' AND status='current' AND entity_id IS NOT NULL ORDER BY entity_id"
      )
      .all(workspaceId) as { entity_id: string }[];
    recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId,
      localHeadSha: input.localHeadSha,
      nowMs: input.nowMs,
      notice: {
        ...input.rendererNotice,
        affectedNotebookIds: [
          ...new Set([
            ...input.rendererNotice.affectedNotebookIds,
            ...notebooks.map((row) => row.entity_id),
          ]),
        ],
        ...(rehydrated.legacyLimsIgnored ? { warnings: [LEGACY_LIMS_NOT_IMPORTED_WARNING] } : {}),
      },
    });
  }
  if (restoreLockId !== undefined) {
    const done = db
      .prepare(
        "UPDATE workspace_sync_restore_locks SET status='completed',completed_at=?,error_message=NULL WHERE workspace_id=? AND lock_id=? AND status='restoring'"
      )
      .run(Math.max(input.nowMs, Date.now()), workspaceId, restoreLockId);
    if (done.changes !== 1)
      throw new Error('Scientific restore intent could not settle atomically.');
    settleWorkspaceSyncRestoreTelemetry(db, restoreLockId);
    db.prepare('UPDATE workspaces SET last_opened_at=? WHERE id=?').run(input.nowMs, workspaceId);
  }
}

export function scientificCloudReplicaWasCommitted(
  db: Database.Database,
  workspaceId: number,
  input: ScientificCloudReplicaCommit,
  descriptor: ScientificCloudHistoryV1
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM workspace_sync_bindings b JOIN workspace_sync_versions v ON v.workspace_id=b.workspace_id
    JOIN scientific_workspace_identities i ON i.workspace_id=b.workspace_id JOIN scientific_revision_refs r ON r.workspace_id=b.workspace_id AND r.ref_name='accepted'
    WHERE b.workspace_id=? AND b.workspace_uuid=? AND b.owner_account_id=? AND b.remote_workspace_id=? AND b.remote_latest_version_id=?
      AND b.remote_latest_content_sha256=? AND b.last_acked_local_head_sha=? AND v.remote_version_id=? AND v.content_sha256=?
      AND v.local_head_sha=? AND v.status='ready' AND v.is_latest=1 AND i.logical_workspace_id=? AND i.remote_workspace_id=? AND r.head IS ?`
      )
      .get(
        workspaceId,
        input.workspaceUuid,
        input.ownerAccountId,
        input.remote.workspaceId,
        input.version.id,
        input.version.contentSha256,
        input.localHeadSha,
        input.version.id,
        input.version.contentSha256,
        input.localHeadSha,
        descriptor.logicalWorkspaceId,
        input.remote.workspaceId,
        descriptor.acceptedHead
      )
  );
}
