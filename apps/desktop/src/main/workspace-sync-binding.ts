import type Database from 'better-sqlite3';
import type { DesktopSyncClaimOwner } from '@waypoint/share-bundle/protocol';
import { recordWorkspaceSyncEnablement } from './workspace-sync-enablement';
import { acceptWorkspaceSyncEnablementTelemetry } from './workspace-sync-enablement-telemetry';

import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import {
  assertScientificCloudTransferSupported,
  hasRetainedScientificAuthority,
  hasScientificCloudHistoryBinding,
} from './scientific-cloud-admission';
import {
  pinScientificHistoryWorkspaceIdentity,
  scientificHistoryWorkspaceIdentity,
} from './scientific-history-identity';

export type WorkspaceSyncBindingErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NOT_MANAGED'
  | 'WORKSPACE_ARCHIVED'
  | 'WORKSPACE_TRASHED'
  | 'OWNER_MISMATCH'
  | 'CLAIM_OWNER_MISMATCH'
  | 'CLAIM_RESPONSE_INVALID';

export class WorkspaceSyncBindingError extends Error {
  constructor(
    readonly code: WorkspaceSyncBindingErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceSyncBindingError';
  }
}

export interface WorkspaceSyncClaimRequest {
  clientWorkspaceId: string;
  displayName: string;
  ownerAccountId: string;
  ownerOrgId: string | null;
  scientificHistoryFormat?: 1;
}

export interface WorkspaceSyncClaimResponse {
  remoteWorkspaceId: string;
  clientWorkspaceId: string;
  claimedByAccountId: string;
  owner: DesktopSyncClaimOwner;
  remoteLatestVersionId?: string | null;
  remoteLatestVersionNumber?: number | null;
  remoteLatestContentSha256?: string | null;
  scientificHistoryFormats?: readonly number[];
}

export interface WorkspaceSyncClaimClient {
  readonly supportsScientificHistory?: boolean;
  claimWorkspace(request: WorkspaceSyncClaimRequest): Promise<WorkspaceSyncClaimResponse>;
}

export interface EnsureWorkspaceSyncBindingInput {
  workspaceUuid: string;
  ownerAccountId: string;
  ownerOrgId: string | null;
  nowMs: number;
  claimClient: WorkspaceSyncClaimClient;
}

export interface ReadWorkspaceSyncBindingInput {
  workspaceUuid: string;
}

export interface WorkspaceSyncBinding {
  workspaceId: number;
  workspaceUuid: string;
  ownerAccountId: string;
  ownerOrgId: string | null;
  remoteWorkspaceId: string | null;
  enabled: boolean;
  remoteLatestVersionId: string | null;
  remoteLatestVersionNumber: number | null;
  remoteLatestContentSha256: string | null;
  lastAckedLocalHeadSha: string | null;
  lastUploadedAt: number | null;
  lastDownloadedAt: number | null;
  createdAt: number;
  updatedAt: number;
  didClaimRemote: boolean;
}

interface WorkspaceRow {
  id: number;
  name: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

interface WorkspaceSyncBindingRow {
  workspace_id: number;
  workspace_uuid: string;
  owner_account_id: string;
  owner_org_id: string | null;
  remote_workspace_id: string | null;
  enabled: number;
  remote_latest_version_id: string | null;
  remote_latest_version_number: number | null;
  remote_latest_content_sha256: string | null;
  last_acked_local_head_sha: string | null;
  last_uploaded_at: number | null;
  last_downloaded_at: number | null;
  created_at: number;
  updated_at: number;
}

export function readWorkspaceSyncBinding(
  db: Database.Database,
  input: ReadWorkspaceSyncBindingInput
): WorkspaceSyncBinding | null {
  const row = selectBindingByWorkspaceUuid(db, input.workspaceUuid);
  return row ? toBinding(row, false) : null;
}

export async function ensureWorkspaceSyncBinding(
  db: Database.Database,
  input: EnsureWorkspaceSyncBindingInput
): Promise<WorkspaceSyncBinding> {
  const workspace = selectEligibleWorkspace(db, input.workspaceUuid);
  const scientific = hasRetainedScientificAuthority(db, workspace.id);
  const scientificHistoryFormat =
    scientific && input.claimClient.supportsScientificHistory === true ? 1 : undefined;
  assertScientificCloudTransferSupported(db, workspace.id, scientificHistoryFormat);
  const existing = selectBindingByWorkspaceId(db, workspace.id);
  if (existing) {
    assertOwnerMatches(existing, input);
    if (
      existing.remote_workspace_id &&
      (!scientific || hasScientificCloudHistoryBinding(db, workspace.id))
    ) {
      if (existing.enabled !== 1) {
        return db
          .transaction(() => {
            const current = selectBindingByWorkspaceId(db, existing.workspace_id);
            if (!current)
              throw new WorkspaceSyncBindingError(
                'CLAIM_RESPONSE_INVALID',
                `Workspace sync binding was not stored for ${input.workspaceUuid}`
              );
            assertOwnerMatches(current, input);
            if (current.enabled === 1) return toBinding(current, false);
            assertScientificCloudTransferSupported(db, workspace.id, scientificHistoryFormat);
            db.prepare(
              `UPDATE workspace_sync_bindings
           SET enabled = 1,
               updated_at = @nowMs
           WHERE workspace_id = @workspaceId`
            ).run({
              workspaceId: existing.workspace_id,
              nowMs: input.nowMs,
            });
            const reenabled = selectBindingByWorkspaceId(db, existing.workspace_id);
            if (!reenabled?.remote_workspace_id) {
              throw new WorkspaceSyncBindingError(
                'CLAIM_RESPONSE_INVALID',
                `Workspace sync binding was not stored for ${input.workspaceUuid}`
              );
            }
            const episode = recordWorkspaceSyncEnablement(db, {
              workspaceUuid: reenabled.workspace_uuid,
              ownerAccountId: reenabled.owner_account_id,
              ownerOrgId: reenabled.owner_org_id,
              remoteWorkspaceId: reenabled.remote_workspace_id,
            });
            acceptWorkspaceSyncEnablementTelemetry(db, {
              workspaceUuid: reenabled.workspace_uuid,
              operationId: episode.operationId,
            });
            return toBinding(reenabled, false);
          })
          .immediate();
      }
      return toBinding(existing, false);
    }
  }

  const claimed = await input.claimClient.claimWorkspace({
    clientWorkspaceId: input.workspaceUuid,
    displayName: workspace.name,
    ownerAccountId: input.ownerAccountId,
    ownerOrgId: input.ownerOrgId,
    ...(scientificHistoryFormat ? { scientificHistoryFormat } : {}),
  });
  assertClaimMatchesInput(claimed, input);
  if (
    scientificHistoryFormat &&
    !claimed.scientificHistoryFormats?.includes(scientificHistoryFormat)
  )
    throw new WorkspaceSyncBindingError(
      'CLAIM_RESPONSE_INVALID',
      'The cloud service does not support this project’s complete scientific history. Update it before enabling sync.'
    );
  return db
    .transaction(() => {
      assertScientificCloudTransferSupported(db, workspace.id, scientificHistoryFormat);
      const current = selectBindingByWorkspaceId(db, workspace.id);
      if (current) assertOwnerMatches(current, input);
      if (current?.remote_workspace_id && current.remote_workspace_id !== claimed.remoteWorkspaceId)
        throw new WorkspaceSyncBindingError(
          'CLAIM_RESPONSE_INVALID',
          'Scientific history claim changed the bound remote project.'
        );
      if (scientificHistoryFormat)
        pinScientificHistoryWorkspaceIdentity(
          db,
          workspace.id,
          scientificHistoryWorkspaceIdentity(db, workspace.id),
          claimed.remoteWorkspaceId
        );

      if (current) {
        const preserveBase = current.remote_workspace_id === claimed.remoteWorkspaceId;
        db.prepare(
          `UPDATE workspace_sync_bindings
       SET remote_workspace_id = @remoteWorkspaceId,
           remote_latest_version_id = @remoteLatestVersionId,
           remote_latest_version_number = @remoteLatestVersionNumber,
           remote_latest_content_sha256 = @remoteLatestContentSha256,
           enabled = 1,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId`
        ).run({
          workspaceId: workspace.id,
          remoteWorkspaceId: claimed.remoteWorkspaceId,
          remoteLatestVersionId: preserveBase
            ? current.remote_latest_version_id
            : (claimed.remoteLatestVersionId ?? null),
          remoteLatestVersionNumber: preserveBase
            ? current.remote_latest_version_number
            : (claimed.remoteLatestVersionNumber ?? null),
          remoteLatestContentSha256: preserveBase
            ? current.remote_latest_content_sha256
            : (claimed.remoteLatestContentSha256 ?? null),
          nowMs: input.nowMs,
        });
      } else {
        db.prepare(
          `INSERT INTO workspace_sync_bindings (
        workspace_id, workspace_uuid, owner_account_id, owner_org_id,
        remote_workspace_id, enabled, remote_latest_version_id,
        remote_latest_version_number, remote_latest_content_sha256,
        created_at, updated_at
      ) VALUES (
        @workspaceId, @workspaceUuid, @ownerAccountId, @ownerOrgId,
        @remoteWorkspaceId, 1, @remoteLatestVersionId,
        @remoteLatestVersionNumber, @remoteLatestContentSha256,
        @nowMs, @nowMs
      )`
        ).run({
          workspaceId: workspace.id,
          workspaceUuid: input.workspaceUuid,
          ownerAccountId: input.ownerAccountId,
          ownerOrgId: input.ownerOrgId,
          remoteWorkspaceId: claimed.remoteWorkspaceId,
          remoteLatestVersionId: claimed.remoteLatestVersionId ?? null,
          remoteLatestVersionNumber: claimed.remoteLatestVersionNumber ?? null,
          remoteLatestContentSha256: claimed.remoteLatestContentSha256 ?? null,
          nowMs: input.nowMs,
        });
      }

      const stored = selectBindingByWorkspaceId(db, workspace.id);
      if (!stored?.remote_workspace_id) {
        throw new WorkspaceSyncBindingError(
          'CLAIM_RESPONSE_INVALID',
          `Workspace sync binding was not stored for ${input.workspaceUuid}`
        );
      }
      if (!current?.remote_workspace_id || current.enabled !== 1) {
        const episode = recordWorkspaceSyncEnablement(db, {
          workspaceUuid: stored.workspace_uuid,
          ownerAccountId: stored.owner_account_id,
          ownerOrgId: stored.owner_org_id,
          remoteWorkspaceId: stored.remote_workspace_id,
        });
        acceptWorkspaceSyncEnablementTelemetry(db, {
          workspaceUuid: stored.workspace_uuid,
          operationId: episode.operationId,
        });
      }
      return toBinding(stored, true);
    })
    .immediate();
}

function selectEligibleWorkspace(db: Database.Database, workspaceUuid: string): WorkspaceRow {
  const workspace = db
    .prepare(
      `SELECT id, name, repo_uuid, archived_at, trashed_at
       FROM workspaces
       WHERE repo_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceRow | undefined;

  if (!workspace) {
    throw new WorkspaceSyncBindingError(
      'WORKSPACE_NOT_FOUND',
      `Managed workspace not found for repo_uuid ${workspaceUuid}`
    );
  }
  if (!workspace.repo_uuid) {
    throw new WorkspaceSyncBindingError(
      'WORKSPACE_NOT_MANAGED',
      `Workspace ${workspaceUuid} is not a managed workspace`
    );
  }
  if (workspace.archived_at !== null) {
    throw new WorkspaceSyncBindingError(
      'WORKSPACE_ARCHIVED',
      `Workspace ${workspaceUuid} is archived and cannot bind sync`
    );
  }
  if (workspace.trashed_at !== null) {
    throw new WorkspaceSyncBindingError(
      'WORKSPACE_TRASHED',
      `Workspace ${workspaceUuid} is trashed and cannot bind sync`
    );
  }
  return workspace;
}

function selectBindingByWorkspaceUuid(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceSyncBindingRow | undefined {
  return db
    .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_uuid = ? LIMIT 1`)
    .get(workspaceUuid) as WorkspaceSyncBindingRow | undefined;
}

function selectBindingByWorkspaceId(
  db: Database.Database,
  workspaceId: number
): WorkspaceSyncBindingRow | undefined {
  return db
    .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_id = ? LIMIT 1`)
    .get(workspaceId) as WorkspaceSyncBindingRow | undefined;
}

function assertOwnerMatches(
  existing: WorkspaceSyncBindingRow,
  input: Pick<EnsureWorkspaceSyncBindingInput, 'workspaceUuid' | 'ownerAccountId' | 'ownerOrgId'>
): void {
  if (
    existing.owner_account_id !== input.ownerAccountId ||
    (existing.owner_org_id ?? null) !== (input.ownerOrgId ?? null)
  ) {
    throw new WorkspaceSyncBindingError(
      'OWNER_MISMATCH',
      `Workspace ${input.workspaceUuid} is already bound to a different sync owner`
    );
  }
}

function assertClaimMatchesInput(
  claimed: WorkspaceSyncClaimResponse,
  input: Pick<EnsureWorkspaceSyncBindingInput, 'workspaceUuid' | 'ownerAccountId' | 'ownerOrgId'>
): void {
  if (!isWorkspaceSyncRemoteUuid(claimed.remoteWorkspaceId)) {
    throw new WorkspaceSyncBindingError(
      'CLAIM_RESPONSE_INVALID',
      `Workspace claim for ${input.workspaceUuid} did not return a valid remote workspace id`
    );
  }
  if (claimed.clientWorkspaceId !== input.workspaceUuid) {
    throw new WorkspaceSyncBindingError(
      'CLAIM_RESPONSE_INVALID',
      `Workspace claim for ${input.workspaceUuid} answered for a different local workspace`
    );
  }
  if (claimed.claimedByAccountId !== input.ownerAccountId) {
    throw new WorkspaceSyncBindingError(
      'CLAIM_OWNER_MISMATCH',
      `Workspace claim for ${input.workspaceUuid} returned a different owner: it was claimed by another account`
    );
  }
  const expectedOrgId = input.ownerOrgId ?? null;
  const ownerMatches =
    expectedOrgId === null
      ? claimed.owner.kind === 'personal' && claimed.owner.accountId === input.ownerAccountId
      : claimed.owner.kind === 'org' && claimed.owner.orgId === expectedOrgId;
  if (!ownerMatches) {
    throw new WorkspaceSyncBindingError(
      'CLAIM_OWNER_MISMATCH',
      `Workspace claim for ${input.workspaceUuid} returned a different owner`
    );
  }
}

function toBinding(row: WorkspaceSyncBindingRow, didClaimRemote: boolean): WorkspaceSyncBinding {
  return {
    workspaceId: row.workspace_id,
    workspaceUuid: row.workspace_uuid,
    ownerAccountId: row.owner_account_id,
    ownerOrgId: row.owner_org_id,
    remoteWorkspaceId: row.remote_workspace_id,
    enabled: row.enabled === 1,
    remoteLatestVersionId: row.remote_latest_version_id,
    remoteLatestVersionNumber: row.remote_latest_version_number,
    remoteLatestContentSha256: row.remote_latest_content_sha256,
    lastAckedLocalHeadSha: row.last_acked_local_head_sha,
    lastUploadedAt: row.last_uploaded_at,
    lastDownloadedAt: row.last_downloaded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    didClaimRemote,
  };
}
