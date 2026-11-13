import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  validateWorkspaceSyncBundle,
  workspaceSyncBundleHashInput,
  type WorkspaceSyncBundle,
  type WorkspaceSyncFile,
} from '@waypoint/share-bundle';

import {
  workspaceSyncMergeConflictItemFingerprint,
  type WorkspaceSyncMergeConflictItemView,
  type WorkspaceSyncMergeConflictView,
  type WorkspaceSyncReconcileResult,
  type WorkspaceSyncResolveMergeRequest,
} from '../shared/workspace-sync-ipc';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import { commitAllIfDirty, resolveHeadCommit } from './workspace-git';
import { DesktopSyncClientError } from './desktop-sync-client';
import {
  applyLatestToExistingManagedRepo,
  createWorkspaceSyncProjectsClient,
  downloadLatestMaterializableVersion,
  materializeDesktopSyncVersionBundle,
  versionAuthorDisplay,
  WorkspaceSyncPullConflictError,
  type DesktopSyncMaterializableVersion,
  type DesktopSyncLatestVersionResponse,
  type DesktopSyncWorkspaceSummaryResponse,
  type WorkspaceSyncProjectsClient,
} from './workspace-sync-projects';
import { enqueueWorkspaceSyncJob } from './workspace-sync-queue';
import {
  reconcileWithChoices,
  reconcileWorkspaceBundles,
  type ReconcileChoice,
  type ReconcileConflictItem,
  type ReconcileOutcome,
} from './workspace-sync-reconcile';
import { summarizeReconcileResource } from './workspace-sync-reconcile-comparison';
import {
  assertWorkspaceSyncSnapshotMatchesCommit,
  buildWorkspaceSyncSnapshot,
} from './workspace-sync-snapshotter';
import { prepareWorkspaceSyncProjection } from './workspace-sync-projection';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import type { WorkspaceSyncReplicaAppliedNotice } from './workspace-sync-replica-publisher';
import type { WorkspaceSyncReplicaPreparingNotice } from './workspace-sync-replica-publisher';

export interface WorkspaceSyncReconcileDeps {
  appVersion: string;
  client?: WorkspaceSyncProjectsClient;
  getActiveSession?: () => Promise<StoredSession | null>;
  nowMs?: () => number;
  createId?: () => string;
  prepareReplicaApply?: (event: WorkspaceSyncReplicaPreparingNotice) => Promise<string | null>;
  publishReplicaApplied?: (
    preparationId: string | null,
    event: WorkspaceSyncReplicaAppliedNotice
  ) => Promise<void>;
  abortReplicaApply?: (
    preparationId: string | null,
    event: WorkspaceSyncReplicaPreparingNotice & { committed?: boolean }
  ) => void | Promise<void>;
  withWorkspaceQuiesced?: <T>(workspaceUuid: string, operation: () => Promise<T>) => Promise<T>;
  invalidateStatus?: (workspaceUuid: string) => void;
}

interface BindingRow {
  workspace_id: number;
  workspace_uuid: string;
  workspace_path: string;
  owner_account_id: string;
  remote_workspace_id: string | null;
  enabled: number;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  last_acked_local_head_sha: string | null;
  access_role: string | null;
  detached_reason: string | null;
}

interface ConflictRow {
  id: string;
  workspace_id: number;
  workspace_uuid: string;
  base_remote_version_id: string | null;
  remote_version_id: string;
  remote_version_number: number | null;
  remote_author: string | null;
  local_head_sha: string | null;
  status: string;
  conflicts_json: string;
  payload_json: string;
  resolution_json: string | null;
  created_at: number;
}

interface ConflictPayload {
  base: WorkspaceSyncBundle | null;
  local: WorkspaceSyncBundle;
  remote: WorkspaceSyncBundle;
  remoteVersion: DesktopSyncLatestVersionResponse['version'];
  localAuthorLabel: string | null;
  remoteAuthorLabel: string | null;
  localCaptureComplete?: boolean;
}

const RESOLVABLE_CONFLICT_CODES = "('CONFLICT', 'SYNC_CONFLICT')";

export async function reconcileWorkspaceSyncConflict(
  db: Database.Database,
  workspaceUuid: string,
  deps: WorkspaceSyncReconcileDeps
): Promise<WorkspaceSyncReconcileResult> {
  const run = async (): Promise<WorkspaceSyncReconcileResult> => {
    const session = await activeSession(deps);
    if (!session) return failure('Sign in to sync this project.');
    const binding = readBinding(db, workspaceUuid);
    if (!binding || !binding.remote_workspace_id) {
      return failure('This project is not connected to cloud sync.');
    }
    if (binding.owner_account_id !== session.accountId) {
      return failure('This project is bound to a different signed-in account.');
    }
    if (binding.detached_reason === 'access_removed') {
      return failure('You no longer have access to this shared project.');
    }
    if (binding.access_role === 'viewer') {
      return failure('You can view this project but not publish changes to it.');
    }
    const remoteWorkspaceId = binding.remote_workspace_id;
    const client = deps.client ?? createWorkspaceSyncProjectsClient();

    const { snapshot, localHead } = await captureReconciliationSnapshot(db, binding, session, deps);

    await assertAccountUnchanged(deps, session.accountId);
    const remote = (await client.listWorkspaces()).find(
      (entry) => entry.workspaceId === remoteWorkspaceId
    );
    if (!remote) return failure('This project is not available to your account right now.');
    if (!remote.latest.versionId)
      return failure('The shared project has no published version yet.');

    await assertAccountUnchanged(deps, session.accountId);
    const latest = await downloadLatestMaterializableVersion(client, remote);
    const latestBundle = await materializeDesktopSyncVersionBundle({
      remote,
      latest,
      downloadManifestFile: client.downloadManifestFile,
    });
    const baseVersionId = binding.remote_latest_version_id;
    if (latest.version.id === baseVersionId) {
      clearConflictJobs(
        db,
        binding.workspace_id,
        nowMs(deps),
        'CONFLICT_RESOLVED_NO_REMOTE_CHANGE'
      );
      supersedeOpenConflicts(db, binding.workspace_id, nowMs(deps));
      deps.invalidateStatus?.(workspaceUuid);
      return { ok: true, outcome: 'no_remote_change' };
    }

    await assertAccountUnchanged(deps, session.accountId);
    const baseVersion = baseVersionId
      ? await downloadBase(client, remoteWorkspaceId, baseVersionId)
      : null;
    const baseBundle = baseVersion
      ? await materializeDesktopSyncVersionBundle({
          remote,
          latest: baseVersion,
          downloadManifestFile: client.downloadManifestFile,
        })
      : null;
    const headAfterSnapshot = await resolveHeadCommit(binding.workspace_path);
    if (headAfterSnapshot !== localHead) {
      return failure('The project changed while it was being reconciled. Try again.');
    }

    const labels = {
      localAuthorLabel: session.displayName ?? session.email ?? null,
      remoteAuthorLabel: versionAuthorDisplay(latest.version.createdBy),
    };
    const outcome = reconcileWorkspaceBundles({
      workspaceId: remoteWorkspaceId,
      base: baseBundle,
      local: snapshot.bundle,
      remote: latestBundle,
      localCaptureComplete: true,
      ...labels,
    });

    await assertAccountUnchanged(deps, session.accountId);
    if (outcome.kind === 'merged') {
      await applyMergedTree(db, deps, {
        binding,
        remote,
        latest,
        localHead,
        template: snapshot.bundle,
        files: outcome.files,
        commitMessage: `Merge shared changes from ${labels.remoteAuthorLabel ?? 'a collaborator'} (v${latest.version.versionNumber})`,
      });
      supersedeOpenConflicts(db, binding.workspace_id, nowMs(deps));
      deps.invalidateStatus?.(workspaceUuid);
      return {
        ok: true,
        outcome: 'merged',
        summary: outcome.summary,
        remoteVersionNumber: latest.version.versionNumber,
        remoteAuthor: labels.remoteAuthorLabel,
      };
    }

    if (outcome.kind === 'conflicts') {
      const conflictId = await recordConflict(db, deps, {
        binding,
        baseVersionId,
        latest,
        localHead,
        payload: {
          base: baseBundle,
          local: snapshot.bundle,
          remote: latestBundle,
          remoteVersion: latest.version,
          localCaptureComplete: true,
          ...labels,
        },
        items: outcome.conflicts,
      });
      deps.invalidateStatus?.(workspaceUuid);
      return {
        ok: true,
        outcome: 'conflicts',
        conflict: readConflictView(db, binding.workspace_id, conflictId),
      };
    }

    return failure(outcome.reason);
  };

  try {
    return deps.withWorkspaceQuiesced
      ? await deps.withWorkspaceQuiesced(workspaceUuid, run)
      : await run();
  } catch (error) {
    if (error instanceof DesktopSyncClientError && error.code === 'NETWORK') {
      return failure('You appear to be offline. Reconciliation will retry when you reconnect.');
    }
    return failure(error instanceof Error ? error.message : 'Reconciliation failed.');
  }
}

export function readWorkspaceSyncMergeConflict(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceSyncMergeConflictView | null {
  const binding = readBinding(db, workspaceUuid);
  if (!binding) return null;
  const row = db
    .prepare(
      `SELECT id FROM workspace_sync_merge_conflicts
       WHERE workspace_id = ? AND status = 'open'
       ORDER BY created_at DESC, id LIMIT 1`
    )
    .get(binding.workspace_id) as { id: string } | undefined;
  return row ? readConflictView(db, binding.workspace_id, row.id) : null;
}

export async function resolveWorkspaceSyncMergeConflict(
  db: Database.Database,
  workspaceUuid: string,
  request: WorkspaceSyncResolveMergeRequest,
  deps: WorkspaceSyncReconcileDeps,
  options: { carriedChoices?: boolean } = {}
): Promise<WorkspaceSyncReconcileResult> {
  const startOver = async (
    binding: BindingRow,
    reviewedPayload: ConflictPayload
  ): Promise<WorkspaceSyncReconcileResult> => {
    supersedeOpenConflicts(db, binding.workspace_id, nowMs(deps));
    const again = await reconcileWorkspaceSyncConflict(db, workspaceUuid, deps);
    const reviewed = reconcileWorkspaceBundles({
      workspaceId: binding.remote_workspace_id!,
      base: reviewedPayload.base,
      local: reviewedPayload.local,
      remote: reviewedPayload.remote,
      localCaptureComplete: reviewedPayload.localCaptureComplete,
    });
    const fingerprints = new Map(
      reviewed.kind === 'conflicts'
        ? reviewed.conflicts.map((item) => [
            item.resourceId,
            workspaceSyncMergeConflictItemFingerprint(item),
          ])
        : []
    );
    const normalizedChoices = normalizeChoices(request.choices);
    if (
      !options.carriedChoices &&
      again.ok &&
      again.outcome === 'conflicts' &&
      again.conflict.items.every(
        (item) =>
          normalizedChoices[item.resourceId] !== undefined &&
          fingerprints.get(item.resourceId) === workspaceSyncMergeConflictItemFingerprint(item)
      )
    ) {
      return resolveWorkspaceSyncMergeConflict(
        db,
        workspaceUuid,
        { conflictId: again.conflict.conflictId, choices: request.choices },
        deps,
        { carriedChoices: true }
      );
    }
    return again;
  };

  const run = async (): Promise<WorkspaceSyncReconcileResult> => {
    const session = await activeSession(deps);
    if (!session) return failure('Sign in to resolve this conflict.');
    const binding = readBinding(db, workspaceUuid);
    if (!binding || !binding.remote_workspace_id) {
      return failure('This project is not connected to cloud sync.');
    }
    if (binding.owner_account_id !== session.accountId) {
      return failure('This project is bound to a different signed-in account.');
    }
    const row = db
      .prepare(`SELECT * FROM workspace_sync_merge_conflicts WHERE id = ? AND workspace_id = ?`)
      .get(request.conflictId, binding.workspace_id) as ConflictRow | undefined;
    if (!row || row.status !== 'open') {
      return failure('That conflict is no longer open. Refresh and try again.');
    }
    const payload = JSON.parse(row.payload_json) as ConflictPayload;
    const remoteWorkspaceId = binding.remote_workspace_id;
    const client = deps.client ?? createWorkspaceSyncProjectsClient();

    await commitAllIfDirty(
      binding.workspace_path,
      'Auto sync: commit local changes before resolving a conflict',
      { author: gitAuthor(session) }
    );
    const localHead = await resolveHeadCommit(binding.workspace_path);
    if (!localHead || localHead !== row.local_head_sha) {
      return startOver(binding, payload);
    }

    const choices = normalizeChoices(request.choices);
    let outcome = reconcileWithChoices(
      {
        workspaceId: remoteWorkspaceId,
        base: payload.base,
        local: payload.local,
        remote: payload.remote,
        localCaptureComplete: payload.localCaptureComplete,
        localAuthorLabel: payload.localAuthorLabel,
        remoteAuthorLabel: payload.remoteAuthorLabel,
      },
      choices
    );
    if (outcome.kind === 'conflicts') {
      await updateConflictItems(
        db,
        row.id,
        outcome.conflicts,
        nowMs(deps),
        deps,
        session.accountId
      );
      return {
        ok: true,
        outcome: 'conflicts',
        conflict: readConflictView(db, binding.workspace_id, row.id),
      };
    }
    if (outcome.kind === 'failed') return failure(outcome.reason);

    await assertAccountUnchanged(deps, session.accountId);
    const remote = (await client.listWorkspaces()).find(
      (entry) => entry.workspaceId === remoteWorkspaceId
    );
    if (!remote) return failure('This project is not available to your account right now.');
    await assertAccountUnchanged(deps, session.accountId);
    const latest = await downloadLatestMaterializableVersion(client, remote);
    const latestBundle = await materializeDesktopSyncVersionBundle({
      remote,
      latest,
      downloadManifestFile: client.downloadManifestFile,
    });
    let resolvedFiles = outcome.files;
    let remoteLabel = payload.remoteAuthorLabel;

    if (latest.version.id !== row.remote_version_id) {
      const resolvedBundle = bundleFrom(payload.local, resolvedFiles, deps);
      const again = reconcileWorkspaceBundles({
        workspaceId: remoteWorkspaceId,
        base: payload.remote,
        local: resolvedBundle,
        remote: latestBundle,
        localCaptureComplete: payload.localCaptureComplete,
        localAuthorLabel: payload.localAuthorLabel,
        remoteAuthorLabel: versionAuthorDisplay(latest.version.createdBy),
      });
      remoteLabel = versionAuthorDisplay(latest.version.createdBy);
      if (again.kind === 'conflicts') {
        markConflictResolved(db, row.id, choices, nowMs(deps));
        const nextId = await recordConflict(db, deps, {
          binding,
          baseVersionId: row.remote_version_id,
          latest,
          localHead,
          payload: {
            base: payload.remote,
            local: resolvedBundle,
            remote: latestBundle,
            remoteVersion: latest.version,
            localCaptureComplete: payload.localCaptureComplete,
            localAuthorLabel: payload.localAuthorLabel,
            remoteAuthorLabel: remoteLabel,
          },
          items: again.conflicts,
        });
        deps.invalidateStatus?.(workspaceUuid);
        return {
          ok: true,
          outcome: 'conflicts',
          conflict: readConflictView(db, binding.workspace_id, nextId),
        };
      }
      if (again.kind === 'failed') return failure(again.reason);
      outcome = again;
      resolvedFiles = again.files;
    }

    await assertAccountUnchanged(deps, session.accountId);
    try {
      await applyMergedTree(db, deps, {
        binding,
        remote,
        latest,
        localHead,
        template: payload.local,
        files: resolvedFiles,
        commitMessage: `Resolve shared changes from ${remoteLabel ?? 'a collaborator'} (v${latest.version.versionNumber})`,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceSyncPullConflictError)) throw error;
      return startOver(binding, payload);
    }
    markConflictResolved(db, row.id, choices, nowMs(deps));
    deps.invalidateStatus?.(workspaceUuid);
    return {
      ok: true,
      outcome: 'merged',
      summary: outcome.summary,
      remoteVersionNumber: latest.version.versionNumber,
      remoteAuthor: remoteLabel,
    };
  };

  try {
    return deps.withWorkspaceQuiesced
      ? await deps.withWorkspaceQuiesced(workspaceUuid, run)
      : await run();
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Could not resolve the conflict.');
  }
}

async function applyMergedTree(
  db: Database.Database,
  deps: WorkspaceSyncReconcileDeps,
  input: {
    binding: BindingRow;
    remote: DesktopSyncWorkspaceSummaryResponse;
    latest: DesktopSyncMaterializableVersion;
    localHead: string;
    template: WorkspaceSyncBundle;
    files: WorkspaceSyncFile[];
    commitMessage: string;
  }
): Promise<void> {
  const merged = bundleFrom(input.template, input.files, deps);
  const encoded = JSON.stringify(merged);
  const syntheticLatest: DesktopSyncLatestVersionResponse = {
    workspaceId: input.latest.workspaceId,
    version: {
      ...input.latest.version,
      contentSha256: merged.provenance.contentSha256,
      sizeBytes:
        merged.schemaVersion === 3
          ? merged.files.reduce((total, file) => total + file.sizeBytes, 0)
          : Buffer.byteLength(encoded, 'utf8'),
      fileCount: merged.files.length,
    },
    bundle: merged,
  };
  const syntheticRemote: DesktopSyncWorkspaceSummaryResponse = {
    ...input.remote,
    latest: {
      ...input.remote.latest,
      versionId: input.latest.version.id,
      versionNumber: input.latest.version.versionNumber,
      contentSha256: merged.provenance.contentSha256,
    },
  };
  const expectedRemoteVersionId = input.binding.remote_latest_version_id;
  if (!expectedRemoteVersionId) {
    throw new Error('The project has no acknowledged shared version to reconcile from.');
  }
  await applyLatestToExistingManagedRepo(db, {
    workspaceId: input.binding.workspace_id,
    workspaceUuid: input.binding.workspace_uuid,
    repoPath: input.binding.workspace_path,
    remote: syntheticRemote,
    latest: syntheticLatest,
    expectedLocalHeadSha: input.localHead,
    expectedRemoteVersionId,
    nowMs: nowMs(deps),
    client: deps.client ?? createWorkspaceSyncProjectsClient(),
    reconciledLocalPaths: input.template.files.map((file) => file.relativePath),
    reconciled: { remoteVersion: input.latest.version, commitMessage: input.commitMessage },
    ...(deps.prepareReplicaApply ? { onReplicaPreparing: deps.prepareReplicaApply } : {}),
    ...(deps.publishReplicaApplied ? { onReplicaApplied: deps.publishReplicaApplied } : {}),
    ...(deps.abortReplicaApply ? { onReplicaAborted: deps.abortReplicaApply } : {}),
  });

  const mergedHead = await resolveHeadCommit(input.binding.workspace_path);
  if (!mergedHead) throw new Error('The merged project could not be committed.');
  const at = nowMs(deps);
  db.transaction(() => {
    clearConflictJobs(db, input.binding.workspace_id, at, 'CONFLICT_RESOLVED_MERGED');
    enqueueWorkspaceSyncJob(db, {
      id: deps.createId?.() ?? randomUUID(),
      workspaceId: input.binding.workspace_id,
      operation: 'upload',
      idempotencyKey: `upload:${input.binding.workspace_uuid}:${input.latest.version.id}:${mergedHead}`,
      baseRemoteVersionId: input.latest.version.id,
      localHeadSha: mergedHead,
      nowMs: at,
    });
  })();
}

function bundleFrom(
  template: WorkspaceSyncBundle,
  files: WorkspaceSyncFile[],
  deps: WorkspaceSyncReconcileDeps
): WorkspaceSyncBundle {
  const candidate: WorkspaceSyncBundle = {
    ...template,
    schemaVersion:
      template.schemaVersion === 3 || files.some((file) => file.encoding === 'blob')
        ? 3
        : template.schemaVersion,
    capturedAt: new Date(nowMs(deps)).toISOString(),
    files: files.map((file) => ({ ...file })),
    provenance: { ...template.provenance, contentSha256: '' },
  };
  candidate.provenance.contentSha256 = createHash('sha256')
    .update(workspaceSyncBundleHashInput(candidate))
    .digest('hex');
  const validated = validateWorkspaceSyncBundle(candidate);
  if (!validated.ok) {
    throw new Error(
      `The merged project is not a valid sync bundle: ${validated.errors.join('; ')}`
    );
  }
  return validated.bundle;
}

async function downloadBase(
  client: WorkspaceSyncProjectsClient,
  remoteWorkspaceId: string,
  versionId: string
): Promise<DesktopSyncMaterializableVersion | null> {
  if (!client.downloadVersion) return null;
  try {
    return await client.downloadVersion(remoteWorkspaceId, versionId);
  } catch (error) {
    if (error instanceof DesktopSyncClientError && error.code === 'MANIFEST_RESTORE_REQUIRED') {
      if (!client.downloadManifestVersion) {
        throw new Error('This DNAForge version cannot restore manifest-backed projects.');
      }
      return await client.downloadManifestVersion(remoteWorkspaceId, versionId);
    }
    if (
      error instanceof DesktopSyncClientError &&
      (error.code === 'NOT_FOUND' || error.code === 'VALIDATION')
    ) {
      return null;
    }
    throw error;
  }
}

async function recordConflict(
  db: Database.Database,
  deps: WorkspaceSyncReconcileDeps,
  input: {
    binding: BindingRow;
    baseVersionId: string | null;
    latest: DesktopSyncMaterializableVersion;
    localHead: string;
    payload: ConflictPayload;
    items: ReconcileConflictItem[];
  }
): Promise<string> {
  const views = await serializeConflictItems(input.items);
  await assertAccountUnchanged(deps, input.binding.owner_account_id);
  const at = nowMs(deps);
  const id = deps.createId?.() ?? randomUUID();
  db.transaction(() => {
    supersedeOpenConflicts(db, input.binding.workspace_id, at);
    db.prepare(
      `INSERT INTO workspace_sync_merge_conflicts (
         id, workspace_id, workspace_uuid, base_remote_version_id, remote_version_id,
         remote_version_number, remote_author, local_head_sha, status,
         conflicts_json, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
    ).run(
      id,
      input.binding.workspace_id,
      input.binding.workspace_uuid,
      input.baseVersionId,
      input.latest.version.id,
      input.latest.version.versionNumber,
      input.payload.remoteAuthorLabel,
      input.localHead,
      JSON.stringify(views),
      JSON.stringify(input.payload),
      at,
      at
    );
  })();
  return id;
}

async function updateConflictItems(
  db: Database.Database,
  conflictId: string,
  items: ReconcileConflictItem[],
  at: number,
  deps: WorkspaceSyncReconcileDeps,
  accountId: string
): Promise<void> {
  const views = await serializeConflictItems(items);
  await assertAccountUnchanged(deps, accountId);
  db.prepare(
    `UPDATE workspace_sync_merge_conflicts SET conflicts_json = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(views), at, conflictId);
}

function markConflictResolved(
  db: Database.Database,
  conflictId: string,
  choices: Record<string, ReconcileChoice>,
  at: number
): void {
  db.prepare(
    `UPDATE workspace_sync_merge_conflicts
     SET status = 'resolved', resolution_json = ?, resolved_at = ?, updated_at = ?
     WHERE id = ? AND status = 'open'`
  ).run(JSON.stringify(choices), at, at, conflictId);
}

function supersedeOpenConflicts(db: Database.Database, workspaceId: number, at: number): void {
  db.prepare(
    `UPDATE workspace_sync_merge_conflicts
     SET status = 'superseded', updated_at = ?
     WHERE workspace_id = ? AND status = 'open'`
  ).run(at, workspaceId);
}

function clearConflictJobs(
  db: Database.Database,
  workspaceId: number,
  at: number,
  code: string
): void {
  db.prepare(
    `UPDATE workspace_sync_queue
     SET status = 'canceled', error_code = ?, updated_at = ?
     WHERE workspace_id = ?
       AND status = 'failed'
       AND error_code IN ${RESOLVABLE_CONFLICT_CODES}`
  ).run(code, at, workspaceId);
}

function readConflictView(
  db: Database.Database,
  workspaceId: number,
  conflictId: string
): WorkspaceSyncMergeConflictView {
  const row = db
    .prepare(`SELECT * FROM workspace_sync_merge_conflicts WHERE id = ? AND workspace_id = ?`)
    .get(conflictId, workspaceId) as ConflictRow | undefined;
  if (!row) throw new Error('Conflict record not found.');
  const items = JSON.parse(row.conflicts_json) as WorkspaceSyncMergeConflictItemView[];
  return {
    conflictId: row.id,
    workspaceUuid: row.workspace_uuid,
    remoteVersionId: row.remote_version_id,
    remoteVersionNumber: row.remote_version_number,
    remoteAuthor: row.remote_author,
    baseVersionId: row.base_remote_version_id,
    createdAt: row.created_at,
    items,
  };
}

async function serializeConflictItems(
  items: ReconcileConflictItem[]
): Promise<WorkspaceSyncMergeConflictItemView[]> {
  const views: WorkspaceSyncMergeConflictItemView[] = [];
  for (const item of items)
    views.push({
      resourceId: item.resourceId,
      kind: item.kind,
      reason: item.reason,
      path: item.path,
      canKeepBoth: item.canKeepBoth,
      base: await summarizeReconcileResource(item.base),
      local: await summarizeReconcileResource(item.local),
      remote: await summarizeReconcileResource(item.remote),
    });
  return views;
}

function normalizeChoices(
  choices: Readonly<Record<string, string>>
): Record<string, ReconcileChoice> {
  const normalized: Record<string, ReconcileChoice> = {};
  for (const [resourceId, choice] of Object.entries(choices)) {
    if (choice === 'mine' || choice === 'theirs' || choice === 'both') {
      normalized[resourceId] = choice;
    }
  }
  return normalized;
}

async function captureReconciliationSnapshot(
  db: Database.Database,
  binding: BindingRow,
  session: StoredSession,
  deps: WorkspaceSyncReconcileDeps
) {
  const release = await acquireWorkspaceSyncMutationLease(binding.workspace_path);
  try {
    const { assertNativeCatalogRecordPublicationsSettled } =
      await import('./native-catalog-record-mutations');
    assertNativeCatalogRecordPublicationsSettled(db, binding.workspace_path);
    await assertWorkspaceMigrationActionsSettled(binding.workspace_path);
    prepareWorkspaceSyncProjection(db, {
      workspaceId: binding.workspace_id,
      workspaceRoot: binding.workspace_path,
    });
    await commitAllIfDirty(
      binding.workspace_path,
      'Auto sync: commit local changes before reconciliation',
      {
        author: gitAuthor(session),
      }
    );
    const localHead = await resolveHeadCommit(binding.workspace_path);
    if (!localHead) throw new Error('The local project has no committed state to reconcile.');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: binding.workspace_uuid,
      appVersion: deps.appVersion,
      prepareProjection: false,
      directStorage: true,
    });
    await assertWorkspaceSyncSnapshotMatchesCommit(snapshot, localHead);
    return { snapshot, localHead };
  } finally {
    release();
  }
}

function readBinding(db: Database.Database, workspaceUuid: string): BindingRow | null {
  const row = db
    .prepare(
      `SELECT b.workspace_id, b.workspace_uuid, w.path AS workspace_path, b.owner_account_id,
              b.remote_workspace_id, b.enabled, b.remote_latest_version_id,
              b.remote_latest_version_number, b.last_acked_local_head_sha,
              b.access_role, b.detached_reason
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.workspace_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as BindingRow | undefined;
  return row ?? null;
}

async function activeSession(deps: WorkspaceSyncReconcileDeps): Promise<StoredSession | null> {
  return deps.getActiveSession ? deps.getActiveSession() : getActiveStoredSession();
}

async function assertAccountUnchanged(
  deps: WorkspaceSyncReconcileDeps,
  expectedAccountId: string
): Promise<void> {
  const current = await activeSession(deps);
  if (!current || current.accountId !== expectedAccountId) {
    throw new Error('The signed-in account changed during reconciliation. Nothing was changed.');
  }
}

function gitAuthor(session: StoredSession): { name: string; email: string } {
  return {
    name: session.displayName ?? session.email ?? 'DNAForge user',
    email: session.email ?? 'workspace@dnaforge.local',
  };
}

function nowMs(deps: WorkspaceSyncReconcileDeps): number {
  return deps.nowMs?.() ?? Date.now();
}

function failure(message: string): WorkspaceSyncReconcileResult {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

export type { ReconcileOutcome };
