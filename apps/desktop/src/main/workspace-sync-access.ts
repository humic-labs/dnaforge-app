import type Database from 'better-sqlite3';

export {
  WORKSPACE_SYNC_ACCESS_REMOVED_CODE,
  isAccessRemovedError,
  isSharedAccessBinding,
  markWorkspaceSyncAccessRemoved,
  readWorkspaceSyncAccessBinding,
  updateWorkspaceSyncAccessRecord,
  type MarkAccessRemovedInput,
  type WorkspaceSyncAccessBindingRow,
} from './workspace-sync-access-record';
import {
  isAccessRemovedError,
  markWorkspaceSyncAccessRemoved,
  readWorkspaceSyncAccessBinding,
  updateWorkspaceSyncAccessRecord,
  type WorkspaceSyncAccessBindingRow,
} from './workspace-sync-access-record';

import type {
  WorkspaceSyncAccessListing,
  WorkspaceSyncAccessListingResult,
  WorkspaceSyncActionError,
  WorkspaceSyncCreateOrganizationRequest,
  WorkspaceSyncCreateOrganizationResult,
  WorkspaceSyncDeleteOrganizationResult,
  WorkspaceSyncInviteRequest,
  WorkspaceSyncInviteResult,
  WorkspaceSyncOrgDirectory,
  WorkspaceSyncOrgDirectoryResult,
  WorkspaceSyncOrganizationAuditResult,
  WorkspaceSyncOrgInviteRequest,
  WorkspaceSyncOrgInviteResult,
  WorkspaceSyncOrgMemberMutationResult,
  WorkspaceSyncOrgRole,
  WorkspaceSyncOrganizationSummary,
  WorkspaceSyncOrganizationProvisioningGroup,
  WorkspaceSyncOrganizationProvisioningStatus,
  WorkspaceSyncOrganizationProvisioningStatusResult,
  WorkspaceSyncOpenOrganizationProvisioningPortalResult,
  WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest,
  WorkspaceSyncSetOrganizationProvisioningGroupRoleResult,
  WorkspaceSyncOrganizationsResult,
  WorkspaceSyncRevokeInviteResult,
  WorkspaceSyncSetAccessRequest,
  WorkspaceSyncSetAccessResult,
  WorkspaceSyncTransferOrganizationOwnershipResult,
  WorkspaceSyncUpdateOrganizationRequest,
  WorkspaceSyncUpdateOrganizationResult,
} from '../shared/workspace-sync-ipc';
import type { WorkspaceSyncStatusChangeReason } from '../shared/workspace-sync-ipc';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import {
  createDesktopSyncClient,
  DesktopSyncClientError,
  type DesktopSyncClient,
} from './desktop-sync-client';

export interface WorkspaceSyncAccessClient {
  listOrganizations(expectedAccountId: string): Promise<WorkspaceSyncOrganizationSummary[]>;
  createOrganization(
    expectedAccountId: string,
    request: WorkspaceSyncCreateOrganizationRequest
  ): Promise<Omit<Extract<WorkspaceSyncCreateOrganizationResult, { ok: true }>, 'ok'>>;
  getOrganizationDirectory(
    expectedAccountId: string,
    orgId: string
  ): Promise<WorkspaceSyncOrgDirectory>;
  getOrganizationProvisioningStatus(
    expectedAccountId: string,
    orgId: string
  ): Promise<WorkspaceSyncOrganizationProvisioningStatus>;
  createOrganizationProvisioningPortal(
    expectedAccountId: string,
    orgId: string
  ): Promise<{ url: string }>;
  setOrganizationProvisioningGroupRole(
    expectedAccountId: string,
    orgId: string,
    request: WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest
  ): Promise<{ externalGroupId: string; roleId: 'admin' | 'member' }>;
  listOrganizationAudit(
    expectedAccountId: string,
    orgId: string,
    type?: string
  ): Promise<Omit<Extract<WorkspaceSyncOrganizationAuditResult, { ok: true }>, 'ok'>>;
  updateOrganization(
    expectedAccountId: string,
    orgId: string,
    request: WorkspaceSyncUpdateOrganizationRequest
  ): Promise<Omit<Extract<WorkspaceSyncUpdateOrganizationResult, { ok: true }>, 'ok'>>;
  deleteOrganization(expectedAccountId: string, orgId: string): Promise<{ status: 'deleted' }>;
  inviteOrganizationMember(
    expectedAccountId: string,
    orgId: string,
    request: WorkspaceSyncOrgInviteRequest
  ): Promise<Omit<Extract<WorkspaceSyncOrgInviteResult, { ok: true }>, 'ok'>>;
  resendOrganizationInvite(
    expectedAccountId: string,
    orgId: string,
    inviteId: string
  ): Promise<Omit<Extract<WorkspaceSyncOrgInviteResult, { ok: true }>, 'ok'>>;
  revokeOrganizationInvite(
    expectedAccountId: string,
    orgId: string,
    inviteId: string
  ): Promise<{ status: 'revoked' }>;
  changeOrganizationMemberRole(
    expectedAccountId: string,
    orgId: string,
    accountId: string,
    roleId: WorkspaceSyncOrgRole
  ): Promise<{ revokedInviteCount: number }>;
  removeOrganizationMember(
    expectedAccountId: string,
    orgId: string,
    accountId: string
  ): Promise<{ revokedInviteCount: number }>;
  transferOrganizationOwnership(
    expectedAccountId: string,
    orgId: string,
    accountId: string
  ): Promise<{ status: 'transferred' }>;
  listAccess(
    remoteWorkspaceId: string,
    expectedAccountId: string
  ): Promise<WorkspaceSyncAccessListing>;
  setAccess(
    remoteWorkspaceId: string,
    expectedAccountId: string,
    request: WorkspaceSyncSetAccessRequest
  ): Promise<Omit<Extract<WorkspaceSyncSetAccessResult, { ok: true }>, 'ok'>>;
  invite(
    remoteWorkspaceId: string,
    expectedAccountId: string,
    request: WorkspaceSyncInviteRequest
  ): Promise<Omit<Extract<WorkspaceSyncInviteResult, { ok: true }>, 'ok'>>;
  revokeInvite(
    remoteWorkspaceId: string,
    expectedAccountId: string,
    inviteId: string
  ): Promise<{ status: 'revoked' | 'not_pending' }>;
  resendInvite(
    remoteWorkspaceId: string,
    expectedAccountId: string,
    inviteId: string
  ): Promise<Omit<Extract<WorkspaceSyncInviteResult, { ok: true }>, 'ok'>>;
}

export function createWorkspaceSyncAccessClient(
  client: DesktopSyncClient = createDesktopSyncClient()
): WorkspaceSyncAccessClient {
  const workspacePath = (remoteWorkspaceId: string): string =>
    `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}`;
  return {
    listOrganizations: async (expectedAccountId) => {
      const response = await client.requestJson<unknown>(
        '/api/desktop-sync/account/organizations',
        {
          method: 'GET',
          expectedAccountId,
        }
      );
      return parseOrganizations(response);
    },
    createOrganization: async (expectedAccountId, request) => {
      const response = await client.requestJson<unknown>(
        '/api/desktop-sync/account/organizations',
        {
          method: 'POST',
          expectedAccountId,
          body: request,
        }
      );
      return parseCreatedOrganization(response);
    },
    getOrganizationDirectory: async (expectedAccountId, orgId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}`,
        { method: 'GET', expectedAccountId }
      );
      return parseOrgDirectory(response);
    },
    getOrganizationProvisioningStatus: async (expectedAccountId, orgId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/provisioning`,
        { method: 'GET', expectedAccountId }
      );
      return parseOrganizationProvisioningStatus(response);
    },
    createOrganizationProvisioningPortal: async (expectedAccountId, orgId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/provisioning`,
        { method: 'POST', expectedAccountId }
      );
      return parseOrganizationProvisioningPortal(response);
    },
    setOrganizationProvisioningGroupRole: async (expectedAccountId, orgId, request) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/provisioning`,
        { method: 'PATCH', expectedAccountId, body: request }
      );
      return parseOrganizationProvisioningGroupRole(response);
    },
    listOrganizationAudit: async (expectedAccountId, orgId, type) => {
      const path = type
        ? `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/audit?type=${encodeURIComponent(type)}`
        : `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/audit`;
      const response = await client.requestJson<unknown>(path, {
        method: 'GET',
        expectedAccountId,
      });
      return parseOrgAudit(response);
    },
    updateOrganization: async (expectedAccountId, orgId, request) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}`,
        { method: 'PATCH', expectedAccountId, body: request }
      );
      return parseUpdatedOrganization(response);
    },
    deleteOrganization: async (expectedAccountId, orgId) => {
      await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}`,
        { method: 'DELETE', expectedAccountId }
      );
      return { status: 'deleted' as const };
    },
    inviteOrganizationMember: async (expectedAccountId, orgId, request) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/invites`,
        { method: 'POST', expectedAccountId, body: request }
      );
      return parseOrgInvite(response);
    },
    resendOrganizationInvite: async (expectedAccountId, orgId, inviteId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
        { method: 'POST', expectedAccountId }
      );
      return parseOrgInvite(response);
    },
    revokeOrganizationInvite: async (expectedAccountId, orgId, inviteId) => {
      await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
        { method: 'DELETE', expectedAccountId }
      );
      return { status: 'revoked' as const };
    },
    changeOrganizationMemberRole: async (expectedAccountId, orgId, accountId, roleId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`,
        { method: 'POST', expectedAccountId, body: { roleId } }
      );
      return parseMemberMutation(response);
    },
    removeOrganizationMember: async (expectedAccountId, orgId, accountId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`,
        { method: 'DELETE', expectedAccountId }
      );
      return parseMemberMutation(response);
    },
    transferOrganizationOwnership: async (expectedAccountId, orgId, accountId) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}/ownership`,
        { method: 'POST', expectedAccountId }
      );
      return parseOwnershipTransfer(response);
    },
    listAccess: async (remoteWorkspaceId, expectedAccountId) => {
      const response = await client.requestJson<unknown>(
        `${workspacePath(remoteWorkspaceId)}/access`,
        {
          method: 'GET',
          expectedAccountId,
        }
      );
      return parseAccessListing(response);
    },
    setAccess: async (remoteWorkspaceId, expectedAccountId, request) => {
      const response = await client.requestJson<unknown>(
        `${workspacePath(remoteWorkspaceId)}/access`,
        {
          method: 'POST',
          expectedAccountId,
          body: request,
        }
      );
      return parseSetAccess(response);
    },
    invite: async (remoteWorkspaceId, expectedAccountId, request) => {
      const response = await client.requestJson<unknown>(
        `${workspacePath(remoteWorkspaceId)}/invitations`,
        { method: 'POST', expectedAccountId, body: request }
      );
      return parseInvite(response);
    },
    revokeInvite: async (remoteWorkspaceId, expectedAccountId, inviteId) => {
      const response = await client.requestJson<unknown>(
        `${workspacePath(remoteWorkspaceId)}/invitations/${encodeURIComponent(inviteId)}`,
        { method: 'DELETE', expectedAccountId }
      );
      const record = requireRecord(response, 'Desktop sync returned an invalid invitation result.');
      return { status: record.status === 'revoked' ? 'revoked' : 'not_pending' };
    },
    resendInvite: async (remoteWorkspaceId, expectedAccountId, inviteId) => {
      const response = await client.requestJson<unknown>(
        `${workspacePath(remoteWorkspaceId)}/invitations/${encodeURIComponent(inviteId)}`,
        { method: 'POST', expectedAccountId }
      );
      return parseInvite(response);
    },
  };
}

export interface WorkspaceSyncAccessActionDeps {
  client?: WorkspaceSyncAccessClient;
  getActiveSession?: () => Promise<StoredSession | null>;
  nowMs?: () => number;
  invalidateStatus?: (workspaceUuid: string, reason: WorkspaceSyncStatusChangeReason) => void;
  openExternal?: (url: string) => Promise<void>;
}

export async function listWorkspaceSyncOrganizations(
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrganizationsResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to see your organizations.');
  try {
    const organizations = await client(deps).listOrganizations(session.accountId);
    return { ok: true, organizations };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not load your organizations.'));
  }
}

export async function createWorkspaceSyncOrganization(
  request: WorkspaceSyncCreateOrganizationRequest,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncCreateOrganizationResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to create an organization.');
  try {
    const created = await client(deps).createOrganization(session.accountId, request);
    return { ok: true, ...created };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not create the organization.'));
  }
}

export async function updateWorkspaceSyncOrganization(
  orgId: string,
  request: WorkspaceSyncUpdateOrganizationRequest,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncUpdateOrganizationResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to change organization settings.');
  try {
    const updated = await client(deps).updateOrganization(session.accountId, orgId, request);
    return { ok: true, ...updated };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not save changes.'));
  }
}

export async function deleteWorkspaceSyncOrganization(
  orgId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncDeleteOrganizationResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to delete an organization.');
  try {
    const result = await client(deps).deleteOrganization(session.accountId, orgId);
    return { ok: true, status: result.status };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not delete the organization.'));
  }
}

export async function listWorkspaceSyncOrganizationAudit(
  orgId: string,
  type: string | undefined,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrganizationAuditResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to see the audit log.');
  try {
    const result = await client(deps).listOrganizationAudit(session.accountId, orgId, type);
    return { ok: true, ...result };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not load the audit log.'));
  }
}

export async function listWorkspaceSyncOrganizationDirectory(
  orgId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrgDirectoryResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to see organization members.');
  try {
    const directory = await client(deps).getOrganizationDirectory(session.accountId, orgId);
    return { ok: true, directory };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not load organization members.'));
  }
}

export async function getWorkspaceSyncOrganizationProvisioningStatus(
  orgId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrganizationProvisioningStatusResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to see directory provisioning.');
  try {
    const status = await client(deps).getOrganizationProvisioningStatus(session.accountId, orgId);
    return { ok: true, status };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not load directory provisioning.'));
  }
}

export async function openWorkspaceSyncOrganizationProvisioningPortal(
  orgId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOpenOrganizationProvisioningPortalResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to configure directory provisioning.');
  if (!deps.openExternal) return actionError('Secure directory setup is unavailable.');
  try {
    const portal = await client(deps).createOrganizationProvisioningPortal(
      session.accountId,
      orgId
    );

    if (!isSafeWorkOsPortalUrl(portal.url)) {
      return actionError('Directory setup returned an invalid address.');
    }
    await deps.openExternal(portal.url);
    return { ok: true, status: 'opened' };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not open directory setup.'));
  }
}

export async function setWorkspaceSyncOrganizationProvisioningGroupRole(
  orgId: string,
  request: WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncSetOrganizationProvisioningGroupRoleResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to map directory groups.');
  try {
    const result = await client(deps).setOrganizationProvisioningGroupRole(
      session.accountId,
      orgId,
      request
    );
    return { ok: true, ...result };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not save the directory group role.'));
  }
}

export async function inviteWorkspaceSyncOrganizationMember(
  orgId: string,
  request: WorkspaceSyncOrgInviteRequest,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrgInviteResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to invite people.');
  try {
    const result = await client(deps).inviteOrganizationMember(session.accountId, orgId, request);
    return { ok: true, ...result };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not send the invite.'));
  }
}

export async function resendWorkspaceSyncOrganizationInvite(
  orgId: string,
  inviteId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrgInviteResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to resend invites.');
  try {
    const result = await client(deps).resendOrganizationInvite(session.accountId, orgId, inviteId);
    return { ok: true, ...result };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not resend the invite.'));
  }
}

export async function revokeWorkspaceSyncOrganizationInvite(
  orgId: string,
  inviteId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncRevokeInviteResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to revoke invites.');
  try {
    const result = await client(deps).revokeOrganizationInvite(session.accountId, orgId, inviteId);
    return { ok: true, status: result.status };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not revoke the invite.'));
  }
}

export async function changeWorkspaceSyncOrganizationMemberRole(
  orgId: string,
  accountId: string,
  roleId: WorkspaceSyncOrgRole,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrgMemberMutationResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to change roles.');
  try {
    const result = await client(deps).changeOrganizationMemberRole(
      session.accountId,
      orgId,
      accountId,
      roleId
    );
    return { ok: true, ...result };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not change the role.'));
  }
}

export async function removeWorkspaceSyncOrganizationMember(
  orgId: string,
  accountId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncOrgMemberMutationResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to remove members.');
  try {
    const result = await client(deps).removeOrganizationMember(session.accountId, orgId, accountId);
    return { ok: true, ...result };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not remove the member.'));
  }
}

export async function transferWorkspaceSyncOrganizationOwnership(
  orgId: string,
  accountId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncTransferOrganizationOwnershipResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in to transfer ownership.');
  try {
    const result = await client(deps).transferOrganizationOwnership(
      session.accountId,
      orgId,
      accountId
    );
    return { ok: true, status: result.status };
  } catch (error) {
    return actionError(messageFromError(error, 'Could not transfer ownership.'));
  }
}

export async function listWorkspaceSyncAccess(
  db: Database.Database,
  workspaceUuid: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncAccessListingResult> {
  const bound = await requireBoundShared(db, workspaceUuid, deps);
  if ('error' in bound) return bound.error;
  try {
    const listing = await client(deps).listAccess(bound.remoteWorkspaceId, bound.accountId);
    if (!bindingStillMatches(db, bound)) return changedBindingError();
    updateWorkspaceSyncAccessRecord(db, {
      workspaceId: bound.binding.workspace_id,
      role: listing.viewer.role,
      source: listing.viewer.sources[0]?.kind ?? 'owner',
      sharedWithOthers:
        listing.owner.kind === 'org' || listing.grants.length > 0 || listing.invites.length > 0,
      nowMs: deps.nowMs?.() ?? Date.now(),
    });
    deps.invalidateStatus?.(workspaceUuid, 'binding_changed');
    return { ok: true, listing };
  } catch (error) {
    return handleAccessError(db, bound, error, deps, {
      permission: 'read',
      fallback: 'Could not load who has access.',
    });
  }
}

export async function setWorkspaceSyncAccess(
  db: Database.Database,
  workspaceUuid: string,
  request: WorkspaceSyncSetAccessRequest,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncSetAccessResult> {
  const bound = await requireBoundShared(db, workspaceUuid, deps);
  if ('error' in bound) return bound.error;
  try {
    const result = await client(deps).setAccess(bound.remoteWorkspaceId, bound.accountId, request);
    if (!bindingStillMatches(db, bound)) return changedBindingError();
    if (result.status !== 'unchanged') {
      updateWorkspaceSyncAccessRecord(db, {
        workspaceId: bound.binding.workspace_id,
        role: bound.binding.access_role ?? 'owner',
        source: bound.binding.access_source ?? 'owner',
        sharedWithOthers: true,
        nowMs: deps.nowMs?.() ?? Date.now(),
      });
      deps.invalidateStatus?.(workspaceUuid, 'binding_changed');
    }
    return { ok: true, ...result };
  } catch (error) {
    return handleAccessError(db, bound, error, deps, {
      permission: 'manage',
      fallback: 'Could not change access.',
    });
  }
}

export async function inviteWorkspaceSyncCollaborator(
  db: Database.Database,
  workspaceUuid: string,
  request: WorkspaceSyncInviteRequest,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncInviteResult> {
  const bound = await requireBoundShared(db, workspaceUuid, deps);
  if ('error' in bound) return bound.error;
  try {
    const result = await client(deps).invite(bound.remoteWorkspaceId, bound.accountId, request);
    if (!bindingStillMatches(db, bound)) return changedBindingError();
    updateWorkspaceSyncAccessRecord(db, {
      workspaceId: bound.binding.workspace_id,
      role: bound.binding.access_role ?? 'owner',
      source: bound.binding.access_source ?? 'owner',
      sharedWithOthers: true,
      nowMs: deps.nowMs?.() ?? Date.now(),
    });
    deps.invalidateStatus?.(workspaceUuid, 'binding_changed');
    return { ok: true, ...result };
  } catch (error) {
    return handleAccessError(db, bound, error, deps, {
      permission: 'manage',
      fallback: 'Could not send the invitation.',
    });
  }
}

export async function revokeWorkspaceSyncInvite(
  db: Database.Database,
  workspaceUuid: string,
  inviteId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncRevokeInviteResult> {
  const bound = await requireBoundShared(db, workspaceUuid, deps);
  if ('error' in bound) return bound.error;
  try {
    const result = await client(deps).revokeInvite(
      bound.remoteWorkspaceId,
      bound.accountId,
      inviteId
    );
    if (!bindingStillMatches(db, bound)) return changedBindingError();
    return { ok: true, status: result.status };
  } catch (error) {
    return handleAccessError(db, bound, error, deps, {
      permission: 'manage',
      fallback: 'Could not revoke the invitation.',
    });
  }
}

export async function resendWorkspaceSyncInvite(
  db: Database.Database,
  workspaceUuid: string,
  inviteId: string,
  deps: WorkspaceSyncAccessActionDeps = {}
): Promise<WorkspaceSyncInviteResult> {
  const bound = await requireBoundShared(db, workspaceUuid, deps);
  if ('error' in bound) return bound.error;
  try {
    const result = await client(deps).resendInvite(
      bound.remoteWorkspaceId,
      bound.accountId,
      inviteId
    );
    if (!bindingStillMatches(db, bound)) return changedBindingError();
    return { ok: true, ...result };
  } catch (error) {
    return handleAccessError(db, bound, error, deps, {
      permission: 'manage',
      fallback: 'Could not resend the invitation.',
    });
  }
}

interface BoundShared {
  binding: WorkspaceSyncAccessBindingRow;
  remoteWorkspaceId: string;
  accountId: string;
}

async function requireBoundShared(
  db: Database.Database,
  workspaceUuid: string,
  deps: WorkspaceSyncAccessActionDeps
): Promise<BoundShared | { error: WorkspaceSyncActionError }> {
  const session = await activeSession(deps);
  if (!session) return { error: actionError('Sign in to manage who has access.') };
  const binding = readWorkspaceSyncAccessBinding(db, workspaceUuid);
  if (!binding || !binding.remote_workspace_id) {
    return { error: actionError('Turn on cloud sync for this project before sharing it.') };
  }
  if (binding.owner_account_id !== session.accountId) {
    return { error: actionError('This project is bound to a different signed-in account.') };
  }
  if (binding.detached_reason === 'access_removed') {
    return { error: actionError('You no longer have access to this shared project.') };
  }
  return { binding, remoteWorkspaceId: binding.remote_workspace_id, accountId: session.accountId };
}

function bindingStillMatches(db: Database.Database, bound: BoundShared): boolean {
  const current = readWorkspaceSyncAccessBinding(db, bound.binding.workspace_uuid);
  return (
    current !== null &&
    current.workspace_id === bound.binding.workspace_id &&
    current.owner_account_id === bound.accountId &&
    current.owner_org_id === bound.binding.owner_org_id &&
    current.remote_workspace_id === bound.remoteWorkspaceId &&
    current.enabled === bound.binding.enabled &&
    current.detached_reason === bound.binding.detached_reason
  );
}

function changedBindingError(): WorkspaceSyncActionError {
  return actionError(
    'The project changed while this request was running. Refresh its access list.'
  );
}

async function handleAccessError(
  db: Database.Database,
  bound: BoundShared,
  error: unknown,
  deps: WorkspaceSyncAccessActionDeps,
  action: { permission: 'read' | 'manage'; fallback: string }
): Promise<WorkspaceSyncActionError> {
  if (!bindingStillMatches(db, bound)) return changedBindingError();
  if (
    action.permission === 'manage' &&
    error instanceof DesktopSyncClientError &&
    error.code === 'NOT_FOUND'
  ) {
    const access = await listWorkspaceSyncAccess(db, bound.binding.workspace_uuid, deps);
    if (!access.ok) return access;
    return actionError('That person, organization, or invitation is no longer available.');
  }
  const managementDenied =
    action.permission === 'manage' &&
    error instanceof DesktopSyncClientError &&
    error.code === 'FORBIDDEN';
  if (
    !managementDenied &&
    isAccessRemovedError(error) &&
    (bound.binding.access_source ?? 'owner') !== 'owner'
  ) {
    markWorkspaceSyncAccessRemoved(db, {
      workspaceId: bound.binding.workspace_id,
      nowMs: deps.nowMs?.() ?? Date.now(),
    });
    deps.invalidateStatus?.(bound.binding.workspace_uuid, 'binding_changed');
    return actionError(
      'You no longer have access to this shared project. Your unsent changes are kept on this computer.'
    );
  }
  return actionError(messageFromError(error, action.fallback));
}

function client(deps: WorkspaceSyncAccessActionDeps): WorkspaceSyncAccessClient {
  return deps.client ?? createWorkspaceSyncAccessClient();
}

async function activeSession(deps: WorkspaceSyncAccessActionDeps): Promise<StoredSession | null> {
  return deps.getActiveSession ? deps.getActiveSession() : getActiveStoredSession();
}

function actionError(message: string): WorkspaceSyncActionError {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof DesktopSyncClientError) {
    if (error.code === 'FORBIDDEN') return 'You do not have permission to do that on this project.';
    if (error.code === 'NOT_FOUND') return 'This project is not available to your account.';
    if (error.code === 'NETWORK') return 'You appear to be offline. Try again when connected.';
    if (error.code === 'SIGNED_OUT' || error.code === 'SESSION_REVOKED') {
      return 'Sign in again to continue.';
    }
    return error.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function parseCreatedOrganization(
  value: unknown
): Omit<Extract<WorkspaceSyncCreateOrganizationResult, { ok: true }>, 'ok'> {
  const record = requireRecord(value, 'Desktop sync returned an invalid organization.');
  if (
    typeof record.orgId !== 'string' ||
    typeof record.slug !== 'string' ||
    typeof record.displayName !== 'string'
  ) {
    throw new Error('Desktop sync returned an invalid organization.');
  }
  return { orgId: record.orgId, slug: record.slug, displayName: record.displayName };
}

function parseUpdatedOrganization(
  value: unknown
): Omit<Extract<WorkspaceSyncUpdateOrganizationResult, { ok: true }>, 'ok'> {
  const record = requireRecord(value, 'Desktop sync returned an invalid organization update.');
  if (
    typeof record.orgId !== 'string' ||
    typeof record.slug !== 'string' ||
    typeof record.displayName !== 'string'
  ) {
    throw new Error('Desktop sync returned an invalid organization update.');
  }
  return {
    orgId: record.orgId,
    slug: record.slug,
    displayName: record.displayName,
  };
}

function parseOrgAudit(
  value: unknown
): Omit<Extract<WorkspaceSyncOrganizationAuditResult, { ok: true }>, 'ok'> {
  const record = requireRecord(value, 'Desktop sync returned an invalid audit log.');
  const eventTypes = Array.isArray(record.eventTypes)
    ? record.eventTypes.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const events = Array.isArray(record.events)
    ? record.events.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const event = entry as Record<string, unknown>;
        if (
          typeof event.id !== 'string' ||
          typeof event.eventType !== 'string' ||
          typeof event.summary !== 'string' ||
          typeof event.actorName !== 'string' ||
          typeof event.createdAt !== 'string'
        ) {
          return [];
        }
        return [
          {
            id: event.id,
            eventType: event.eventType,
            summary: event.summary,
            actorName: event.actorName,
            createdAt: event.createdAt,
          },
        ];
      })
    : [];
  return { events, eventTypes };
}

function parseOrgDirectory(value: unknown): WorkspaceSyncOrgDirectory {
  const record = requireRecord(value, 'Desktop sync returned an invalid organization directory.');
  const viewer = requireRecord(
    record.viewer,
    'Desktop sync returned an invalid organization directory.'
  );
  if (
    typeof record.orgId !== 'string' ||
    typeof record.slug !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof viewer.accountId !== 'string' ||
    (viewer.role !== 'owner' && viewer.role !== 'admin' && viewer.role !== 'member')
  ) {
    throw new Error('Desktop sync returned an invalid organization directory.');
  }
  return {
    orgId: record.orgId,
    slug: record.slug,
    displayName: record.displayName,
    viewer: {
      accountId: viewer.accountId,
      role: viewer.role,
      canInvite: viewer.canInvite === true,
      canChangeRole: viewer.canChangeRole === true,
      canRemove: viewer.canRemove === true,
      canEditSettings: viewer.canEditSettings === true,
      canDelete: viewer.canDelete === true,
      canViewAudit: viewer.canViewAudit === true,
      canConfigureProvisioning: viewer.canConfigureProvisioning === true,
      isOwner: viewer.isOwner === true,
    },
    members: Array.isArray(record.members)
      ? record.members.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const member = entry as Record<string, unknown>;
          if (
            typeof member.accountId !== 'string' ||
            (member.role !== 'owner' && member.role !== 'admin' && member.role !== 'member')
          ) {
            return [];
          }
          return [
            {
              accountId: member.accountId,
              role: member.role,
              displayName: String(member.displayName ?? ''),
              email: String(member.email ?? ''),
              joinedAt: String(member.joinedAt ?? ''),
            },
          ];
        })
      : [],
    invites: Array.isArray(record.invites)
      ? record.invites.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const invite = entry as Record<string, unknown>;
          if (
            typeof invite.id !== 'string' ||
            typeof invite.email !== 'string' ||
            (invite.role !== 'owner' && invite.role !== 'admin' && invite.role !== 'member')
          ) {
            return [];
          }
          return [
            {
              id: invite.id,
              email: invite.email,
              role: invite.role,
              createdAt: String(invite.createdAt ?? ''),
              expiresAt: String(invite.expiresAt ?? ''),
            },
          ];
        })
      : [],
  };
}

function parseOrganizationProvisioningStatus(
  value: unknown
): WorkspaceSyncOrganizationProvisioningStatus {
  const record = requireRecord(value, 'Desktop sync returned invalid directory provisioning.');
  const orgId = requiredText(record.orgId);
  const seatCount = nonNegativeCount(record.seatCount);
  const seatLimit = record.seatLimit === null ? null : nonNegativeCount(record.seatLimit);
  if (record.configured === false) return { orgId, configured: false, seatCount, seatLimit };
  if (
    record.configured !== true ||
    record.provider !== 'workos_directory_sync' ||
    (record.status !== 'pending' &&
      record.status !== 'active' &&
      record.status !== 'disabled' &&
      record.status !== 'deleted')
  ) {
    throw new Error('Desktop sync returned invalid directory provisioning.');
  }
  const directoryId = nullableText(record.directoryId);
  const workosOrganizationId = nullableText(record.workosOrganizationId);
  if (record.status === 'active' && !directoryId) {
    throw new Error('Desktop sync returned invalid directory provisioning.');
  }
  if (record.status === 'pending' && !workosOrganizationId) {
    throw new Error('Desktop sync returned invalid directory provisioning.');
  }
  return {
    orgId,
    configured: true,
    provider: 'workos_directory_sync',
    workosOrganizationId,
    directoryId,
    status: record.status,
    defaultRole: requiredText(record.defaultRole),
    userCount: nonNegativeCount(record.userCount),
    activeUserCount: nonNegativeCount(record.activeUserCount),
    pendingAccountCount: nonNegativeCount(record.pendingAccountCount),
    groupCount: nonNegativeCount(record.groupCount),
    groups: parseOrganizationProvisioningGroups(record.groups),
    provisionedMemberCount: nonNegativeCount(record.provisionedMemberCount),
    eventReceiptCount: nonNegativeCount(record.eventReceiptCount),
    seatCount,
    seatLimit,
    lastEventAt: nullableText(record.lastEventAt),
    lastAppliedAt: nullableText(record.lastAppliedAt),
    lastError: nullableText(record.lastError),
  };
}

function parseOrganizationProvisioningGroups(
  value: unknown
): WorkspaceSyncOrganizationProvisioningGroup[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('Desktop sync returned invalid directory provisioning.');
  }
  return value.map((entry) => {
    const group = requireRecord(entry, 'Desktop sync returned invalid directory provisioning.');
    if (
      typeof group.active !== 'boolean' ||
      (group.roleId !== null && group.roleId !== 'admin' && group.roleId !== 'member')
    ) {
      throw new Error('Desktop sync returned invalid directory provisioning.');
    }
    return {
      externalId: requiredText(group.externalId),
      displayName: requiredText(group.displayName),
      active: group.active,
      roleId: group.roleId,
    };
  });
}

function parseOrganizationProvisioningGroupRole(value: unknown): {
  externalGroupId: string;
  roleId: 'admin' | 'member';
} {
  const record = requireRecord(value, 'Desktop sync returned an invalid directory group role.');
  if (record.roleId !== 'admin' && record.roleId !== 'member') {
    throw new Error('Desktop sync returned an invalid directory group role.');
  }
  return { externalGroupId: requiredText(record.externalGroupId), roleId: record.roleId };
}

function parseOrganizationProvisioningPortal(value: unknown): { url: string } {
  const record = requireRecord(value, 'Desktop sync returned an invalid directory setup link.');
  if (!isSafeWorkOsPortalUrl(record.url)) {
    throw new Error('Desktop sync returned an invalid directory setup link.');
  }
  return { url: record.url };
}

function isSafeWorkOsPortalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'setup.workos.com' || url.hostname.endsWith('.workos.com'))
    );
  } catch {
    return false;
  }
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Desktop sync returned invalid directory provisioning.');
  }
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value);
}

function nonNegativeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Desktop sync returned invalid directory provisioning.');
  }
  return value as number;
}

function parseOrgInvite(
  value: unknown
): Omit<Extract<WorkspaceSyncOrgInviteResult, { ok: true }>, 'ok'> {
  const record = requireRecord(value, 'Desktop sync returned an invalid organization invite.');
  if (
    typeof record.inviteId !== 'string' ||
    typeof record.email !== 'string' ||
    (record.role !== 'owner' && record.role !== 'admin' && record.role !== 'member') ||
    typeof record.acceptUrl !== 'string'
  ) {
    throw new Error('Desktop sync returned an invalid organization invite.');
  }
  return {
    inviteId: record.inviteId,
    email: record.email,
    role: record.role,
    emailSent: record.emailSent === true,
    ...(invitationDeliveryStatus(record.emailDeliveryStatus)
      ? { emailDeliveryStatus: invitationDeliveryStatus(record.emailDeliveryStatus) }
      : {}),
    ...(record.emailError === 'email_unconfigured' || record.emailError === 'email_failed'
      ? { emailError: record.emailError }
      : {}),
    acceptUrl: record.acceptUrl,
  };
}

function parseMemberMutation(value: unknown): { revokedInviteCount: number } {
  const record = requireRecord(value, 'Desktop sync returned an invalid member change.');
  return {
    revokedInviteCount:
      typeof record.revokedInviteCount === 'number' ? record.revokedInviteCount : 0,
  };
}

function parseOwnershipTransfer(value: unknown): { status: 'transferred' } {
  const record = requireRecord(value, 'Desktop sync returned an invalid ownership transfer.');
  if (record.status !== 'transferred') {
    throw new Error('Desktop sync returned an invalid ownership transfer.');
  }
  return { status: 'transferred' };
}

function parseOrganizations(value: unknown): WorkspaceSyncOrganizationSummary[] {
  const record = requireRecord(value, 'Desktop sync returned an invalid organization list.');
  if (!Array.isArray(record.organizations)) {
    throw new Error('Desktop sync returned an invalid organization list.');
  }
  return record.organizations.flatMap((entry): WorkspaceSyncOrganizationSummary[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const org = entry as Record<string, unknown>;
    if (
      typeof org.orgId !== 'string' ||
      typeof org.slug !== 'string' ||
      typeof org.displayName !== 'string' ||
      typeof org.role !== 'string'
    ) {
      return [];
    }
    return [
      {
        orgId: org.orgId,
        slug: org.slug,
        displayName: org.displayName,
        role: org.role,
        canCreateManagedProjects: org.canCreateManagedProjects === true,
        isAdministrator: org.isAdministrator === true,
      },
    ];
  });
}

const ROLES = new Set(['viewer', 'editor', 'manager', 'owner']);
const GRANT_ROLES = new Set(['viewer', 'editor', 'manager']);
const SOURCES = new Set(['owner', 'org_admin', 'direct', 'org_audience']);

function parseAccessListing(value: unknown): WorkspaceSyncAccessListing {
  const record = requireRecord(value, 'Desktop sync returned an invalid access listing.');
  const viewer = requireRecord(record.viewer, 'Desktop sync returned an invalid access listing.');
  const owner = requireRecord(record.owner, 'Desktop sync returned an invalid access listing.');
  if (typeof viewer.role !== 'string' || !ROLES.has(viewer.role)) {
    throw new Error('Desktop sync returned an invalid access listing.');
  }
  const role = viewer.role as WorkspaceSyncAccessListing['viewer']['role'];
  const sources = Array.isArray(viewer.sources)
    ? viewer.sources.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const source = entry as Record<string, unknown>;
        if (
          typeof source.kind !== 'string' ||
          !SOURCES.has(source.kind) ||
          typeof source.role !== 'string' ||
          !ROLES.has(source.role)
        ) {
          return [];
        }
        return [
          {
            kind: source.kind as WorkspaceSyncAccessListing['viewer']['sources'][number]['kind'],
            role: source.role as WorkspaceSyncAccessListing['viewer']['role'],
            orgId: typeof source.orgId === 'string' ? source.orgId : null,
          },
        ];
      })
    : [];
  const parsedOwner: WorkspaceSyncAccessListing['owner'] =
    owner.kind === 'org'
      ? {
          kind: 'org',
          orgId: String(owner.orgId ?? ''),
          slug: String(owner.slug ?? ''),
          displayName: String(owner.displayName ?? ''),
        }
      : {
          kind: 'personal',
          accountId: String(owner.accountId ?? ''),
          email: String(owner.email ?? ''),
          displayName: typeof owner.displayName === 'string' ? owner.displayName : null,
        };
  return {
    workspaceId: String(record.workspaceId ?? ''),
    displayName: String(record.displayName ?? ''),
    viewer: { role, sources },
    canManage: record.canManage === true,
    owner: parsedOwner,
    admins: Array.isArray(record.admins)
      ? record.admins.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const admin = entry as Record<string, unknown>;
          if (typeof admin.accountId !== 'string' || typeof admin.email !== 'string') return [];
          return [
            {
              accountId: admin.accountId,
              email: admin.email,
              displayName: typeof admin.displayName === 'string' ? admin.displayName : null,
              orgRole: String(admin.orgRole ?? ''),
            },
          ];
        })
      : [],
    grants: Array.isArray(record.grants)
      ? record.grants.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const grant = entry as Record<string, unknown>;
          if (
            typeof grant.id !== 'string' ||
            (grant.subjectKind !== 'account' && grant.subjectKind !== 'org') ||
            typeof grant.role !== 'string' ||
            !GRANT_ROLES.has(grant.role)
          ) {
            return [];
          }
          return [
            {
              id: grant.id,
              subjectKind: grant.subjectKind,
              accountId: typeof grant.accountId === 'string' ? grant.accountId : null,
              email: typeof grant.email === 'string' ? grant.email : null,
              displayName: typeof grant.displayName === 'string' ? grant.displayName : null,
              orgId: typeof grant.orgId === 'string' ? grant.orgId : null,
              orgName: typeof grant.orgName === 'string' ? grant.orgName : null,
              role: grant.role as 'viewer' | 'editor' | 'manager',
              grantedBy: typeof grant.grantedBy === 'string' ? grant.grantedBy : null,
              createdAt: String(grant.createdAt ?? ''),
            },
          ];
        })
      : [],
    invites: Array.isArray(record.invites)
      ? record.invites.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const invite = entry as Record<string, unknown>;
          if (
            typeof invite.id !== 'string' ||
            typeof invite.email !== 'string' ||
            typeof invite.role !== 'string' ||
            !GRANT_ROLES.has(invite.role)
          ) {
            return [];
          }
          return [
            {
              id: invite.id,
              email: invite.email,
              role: invite.role as 'viewer' | 'editor' | 'manager',
              invitedBy: String(invite.invitedBy ?? ''),
              invitedByName: typeof invite.invitedByName === 'string' ? invite.invitedByName : null,
              createdAt: String(invite.createdAt ?? ''),
              expiresAt: String(invite.expiresAt ?? ''),
              expired: invite.expired === true,
            },
          ];
        })
      : [],
  };
}

function parseSetAccess(
  value: unknown
): Omit<Extract<WorkspaceSyncSetAccessResult, { ok: true }>, 'ok'> {
  const record = requireRecord(value, 'Desktop sync returned an invalid access result.');
  const status = record.status;
  if (
    status !== 'granted' &&
    status !== 'changed' &&
    status !== 'revoked' &&
    status !== 'unchanged'
  ) {
    throw new Error('Desktop sync returned an invalid access result.');
  }
  return {
    status,
    role: grantRoleOrNull(record.role),
    previousRole: grantRoleOrNull(record.previousRole),
    revokedInviteIds: Array.isArray(record.revokedInviteIds)
      ? record.revokedInviteIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function parseInvite(value: unknown): Omit<Extract<WorkspaceSyncInviteResult, { ok: true }>, 'ok'> {
  const record = requireRecord(value, 'Desktop sync returned an invalid invitation.');
  const role = grantRoleOrNull(record.role);
  if (
    typeof record.inviteId !== 'string' ||
    typeof record.email !== 'string' ||
    !role ||
    typeof record.expiresAt !== 'string' ||
    typeof record.acceptUrl !== 'string'
  ) {
    throw new Error('Desktop sync returned an invalid invitation.');
  }
  const emailError =
    record.emailError === 'email_unconfigured' || record.emailError === 'email_failed'
      ? record.emailError
      : undefined;
  return {
    inviteId: record.inviteId,
    email: record.email,
    role,
    expiresAt: record.expiresAt,
    emailSent: record.emailSent === true,
    ...(invitationDeliveryStatus(record.emailDeliveryStatus)
      ? { emailDeliveryStatus: invitationDeliveryStatus(record.emailDeliveryStatus) }
      : {}),
    ...(emailError ? { emailError } : {}),
    acceptUrl: record.acceptUrl,
  };
}

function invitationDeliveryStatus(
  value: unknown
): 'pending' | 'retrying' | 'accepted' | 'failed' | 'uncertain' | 'canceled' | undefined {
  return value === 'pending' ||
    value === 'retrying' ||
    value === 'accepted' ||
    value === 'failed' ||
    value === 'uncertain' ||
    value === 'canceled'
    ? value
    : undefined;
}

function grantRoleOrNull(value: unknown): 'viewer' | 'editor' | 'manager' | null {
  return value === 'viewer' || value === 'editor' || value === 'manager' ? value : null;
}
