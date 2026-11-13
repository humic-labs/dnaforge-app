import type Database from 'better-sqlite3';
import { assertScientificCloudTransferSupported } from './scientific-cloud-admission';

import {
  type WorkspaceSyncActionError,
  type WorkspaceSyncCopyShareLinkResult,
} from '../shared/workspace-sync-ipc';
import {
  DesktopSyncClientError,
  createDesktopSyncClient,
  type DesktopSyncClient,
} from './desktop-sync-client';
import { resolveHeadCommit } from './workspace-git';
import { hasWorkspaceSyncWorkingChanges } from './workspace-sync-git-state';

export interface WorkspaceSyncPinnedShareRequest {
  remoteWorkspaceId: string;

  ownerAccountId: string;
  expectedLatestVersionId: string;
}

export interface WorkspaceSyncPinnedShareResponse {
  workspaceId: string;
  revisionPolicy: 'pinned_version';
  pinnedVersion: {
    id: string;
    versionNumber: number;
    contentSha256: string;
    sizeBytes: number;
    fileCount: number;
    createdAt: string;
  };
  share: {
    id: string;
    shortId: string;
    linkToken: string;
    url: string;
    scopeMode: string;
    displayLabel: string | null;
    expiresAt: string | null;
    createdAt: string;
  };
  short_id: string;
  link_token: string;
  url: string;
}

export interface WorkspaceSyncShareClient {
  createPinnedShare(
    request: WorkspaceSyncPinnedShareRequest
  ): Promise<WorkspaceSyncPinnedShareResponse>;
}

export class DesktopSyncShareClientError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'DesktopSyncShareClientError';
  }
}

export interface WorkspaceSyncShareContext {
  workspaceId: number;
  workspaceUuid: string;
  repoPath: string;
  remoteWorkspaceId: string;
  ownerAccountId: string;
  remoteLatestVersionId: string | null;
  remoteLatestVersionNumber: number | null;
  remoteLatestContentSha256: string | null;
  lastAckedLocalHeadSha: string | null;
}

export interface CopyWorkspaceSyncShareLinkInput {
  workspaceUuid: string;
  client?: WorkspaceSyncShareClient;
  getCurrentLocalHeadSha?: (
    context: WorkspaceSyncShareContext
  ) => string | null | Promise<string | null>;
  hasWorkingChanges?: (context: WorkspaceSyncShareContext) => boolean | Promise<boolean>;
  syncBeforeShare?: (context: WorkspaceSyncShareContext) => void | Promise<void>;
}

interface ShareContextRow {
  workspace_id: number;
  workspace_uuid: string;
  owner_account_id: string;
  repo_path: string;
  remote_workspace_id: string | null;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  remote_latest_content_sha256: string | null;
  last_acked_local_head_sha: string | null;
  enabled: number;
  archived_at: number | null;
  trashed_at: number | null;
}

interface LatestReadyVersionRow {
  remote_version_id: string;
  version_number: number;
  content_sha256: string;
  local_head_sha: string | null;
}

type ShareReadiness =
  | { ready: true; context: WorkspaceSyncShareContext; latest: LatestReadyVersionRow }
  | { ready: false; context: WorkspaceSyncShareContext | null; message: string };

export async function copyWorkspaceSyncShareLink(
  db: Database.Database,
  input: CopyWorkspaceSyncShareLinkInput
): Promise<WorkspaceSyncCopyShareLinkResult> {
  try {
    let readiness = await readShareReadiness(db, input);
    if (!readiness.ready && input.syncBeforeShare && readiness.context) {
      await input.syncBeforeShare(readiness.context);
      readiness = await readShareReadiness(db, input);
    }
    if (!readiness.ready) {
      return actionError(readiness.message);
    }

    const response = await (input.client ?? createWorkspaceSyncShareClient()).createPinnedShare({
      remoteWorkspaceId: readiness.context.remoteWorkspaceId,
      ownerAccountId: readiness.context.ownerAccountId,
      expectedLatestVersionId: readiness.latest.remote_version_id,
    });
    const validationError = validateShareResponse(response, readiness.latest.remote_version_id);
    if (validationError) return actionError(validationError);

    return {
      ok: true,
      url: response.url,
      versionId: readiness.latest.remote_version_id,
      versionNumber: response.pinnedVersion?.versionNumber ?? readiness.latest.version_number,
      shortId: response.share?.shortId ?? response.short_id,
      contentSha256: response.pinnedVersion?.contentSha256 ?? readiness.latest.content_sha256,
    };
  } catch (error) {
    return actionError(messageFromError(error));
  }
}

export function createWorkspaceSyncShareClient(
  client: DesktopSyncClient = createDesktopSyncClient()
): WorkspaceSyncShareClient {
  return {
    createPinnedShare: async (request) => {
      try {
        return await client.requestJson<WorkspaceSyncPinnedShareResponse>(
          `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}/shares`,
          {
            method: 'POST',
            expectedAccountId: request.ownerAccountId,
            body: {
              mode: 'pinned',
              expectedLatestVersionId: request.expectedLatestVersionId,
            },
          }
        );
      } catch (error) {
        throw toShareClientError(error);
      }
    },
  };
}

async function readShareReadiness(
  db: Database.Database,
  input: CopyWorkspaceSyncShareLinkInput
): Promise<ShareReadiness> {
  const contextOrError = selectShareContext(db, input.workspaceUuid);
  if (typeof contextOrError === 'string') {
    return { ready: false, context: null, message: contextOrError };
  }
  const context = contextOrError;
  assertScientificCloudTransferSupported(db, context.workspaceId);
  const latest = selectLatestReadyVersion(db, context);
  if (!latest) {
    return {
      ready: false,
      context,
      message: 'No synced version is available for sharing yet.',
    };
  }

  if (await localWorkspaceHasChanges(input, context)) {
    return {
      ready: false,
      context,
      message: 'Sync this project before sharing so the link includes your latest changes.',
    };
  }

  const currentLocalHeadSha = await currentLocalHead(input, context);
  if (
    !latest.local_head_sha ||
    context.lastAckedLocalHeadSha !== latest.local_head_sha ||
    currentLocalHeadSha !== latest.local_head_sha
  ) {
    return {
      ready: false,
      context,
      message: 'Sync this project before sharing so the link includes your latest changes.',
    };
  }

  assertScientificCloudTransferSupported(db, context.workspaceId);
  return { ready: true, context, latest };
}

function selectShareContext(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceSyncShareContext | string {
  const row = db
    .prepare(
      `SELECT b.workspace_id, b.workspace_uuid, b.owner_account_id, w.path AS repo_path,
              b.remote_workspace_id, b.remote_latest_version_id,
              b.remote_latest_version_number, b.remote_latest_content_sha256,
              b.last_acked_local_head_sha, b.enabled, w.archived_at, w.trashed_at
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE b.workspace_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as ShareContextRow | undefined;

  if (!row) return 'Workspace sync is not set up for this project.';
  if (row.archived_at !== null) return 'Archived projects cannot be shared from sync.';
  if (row.trashed_at !== null) return 'Trashed projects cannot be shared from sync.';
  if (row.enabled !== 1) return 'Turn on auto sync before sharing this project.';
  if (!row.remote_workspace_id) return 'This project has not been connected to cloud sync yet.';

  return {
    workspaceId: row.workspace_id,
    workspaceUuid: row.workspace_uuid,
    repoPath: row.repo_path,
    remoteWorkspaceId: row.remote_workspace_id,
    ownerAccountId: row.owner_account_id,
    remoteLatestVersionId: row.remote_latest_version_id,
    remoteLatestVersionNumber: row.remote_latest_version_number,
    remoteLatestContentSha256: row.remote_latest_content_sha256,
    lastAckedLocalHeadSha: row.last_acked_local_head_sha,
  };
}

function selectLatestReadyVersion(
  db: Database.Database,
  context: WorkspaceSyncShareContext
): LatestReadyVersionRow | null {
  if (!context.remoteLatestVersionId) return null;
  const row = db
    .prepare(
      `SELECT remote_version_id, version_number, content_sha256, local_head_sha
       FROM workspace_sync_versions
       WHERE workspace_id = ?
         AND remote_version_id = ?
         AND status = 'ready'
         AND is_latest = 1
       LIMIT 1`
    )
    .get(context.workspaceId, context.remoteLatestVersionId) as LatestReadyVersionRow | undefined;
  if (!row) return null;
  if (row.version_number !== context.remoteLatestVersionNumber) return null;
  if (row.content_sha256 !== context.remoteLatestContentSha256) return null;
  return row;
}

async function currentLocalHead(
  input: CopyWorkspaceSyncShareLinkInput,
  context: WorkspaceSyncShareContext
): Promise<string | null> {
  if (input.getCurrentLocalHeadSha) {
    return input.getCurrentLocalHeadSha(context);
  }
  return resolveHeadCommit(context.repoPath);
}

async function localWorkspaceHasChanges(
  input: CopyWorkspaceSyncShareLinkInput,
  context: WorkspaceSyncShareContext
): Promise<boolean> {
  if (input.hasWorkingChanges) {
    return input.hasWorkingChanges(context);
  }
  return hasWorkspaceSyncWorkingChanges(context.repoPath);
}

function validateShareResponse(
  response: WorkspaceSyncPinnedShareResponse,
  expectedVersionId: string
): string | null {
  if (!isRecord(response) || typeof response.url !== 'string' || response.url.length === 0) {
    return 'Share response did not include a usable URL.';
  }
  if (!isRecord(response.pinnedVersion) || response.pinnedVersion.id !== expectedVersionId) {
    return 'Share response pinned a different version than the latest synced upload.';
  }
  return null;
}

function toShareClientError(error: unknown): DesktopSyncShareClientError {
  if (error instanceof DesktopSyncShareClientError) return error;
  if (error instanceof DesktopSyncClientError) {
    return new DesktopSyncShareClientError(error.code, error.message);
  }
  if (error instanceof Error) {
    return new DesktopSyncShareClientError('UNKNOWN', error.message);
  }
  return new DesktopSyncShareClientError('UNKNOWN', 'Unable to create a sync share link.');
}

function messageFromError(error: unknown): string {
  if (error instanceof DesktopSyncShareClientError || error instanceof DesktopSyncClientError) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Unable to create a sync share link.';
}

function actionError(message: string): WorkspaceSyncActionError {
  return {
    ok: false,
    code: 'INVALID_REQUEST',
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
