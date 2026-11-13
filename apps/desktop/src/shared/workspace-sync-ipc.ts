import type { UserMessage } from '@waypoint/user-messages';
import type {
  WorkspaceSyncAccessRole,
  WorkspaceSyncAccessSource,
  WorkspaceSyncStatus,
} from './cloud-sync-status';

export type { WorkspaceSyncAccessRole, WorkspaceSyncAccessSource };

export type WorkspaceSyncStatusChangeReason =
  | 'subscribe'
  | 'workspace_changed'
  | 'binding_changed'
  | 'queue_changed'
  | 'restore_changed'
  | 'auth_changed'
  | 'dirty_changed'
  | 'head_changed'
  | 'network_changed'
  | 'manual_refresh';

export interface WorkspaceSyncStatusEvent {
  workspaceUuid: string | null;
  status: WorkspaceSyncStatus;
  reason: WorkspaceSyncStatusChangeReason;
  sequence: number;
  emittedAt: number;
}

interface WorkspaceSyncReplicaEventBase {
  deliveryId: string;
  workspaceUuid: string;
  workspaceRoot: string;
  remoteVersionId: string;
}

export interface WorkspaceSyncReplicaPreparingEvent extends WorkspaceSyncReplicaEventBase {
  phase: 'preparing';

  affectedNotebookIds: string[];

  affectedDesignIds: string[];
}

export interface WorkspaceSyncReplicaAppliedEvent extends WorkspaceSyncReplicaEventBase {
  phase: 'applied';

  mutationToken: string;
  changedPaths: string[];
  deletedPaths: string[];
  affectedNotebookIds: string[];
  affectedDesignIds: string[];
  deletedDesignIds: string[];
  warnings?: UserMessage[];
}

export interface WorkspaceSyncReplicaAbortedEvent extends WorkspaceSyncReplicaEventBase {
  phase: 'aborted';

  committed?: boolean;
}

export type WorkspaceSyncReplicaLifecycleEvent =
  | WorkspaceSyncReplicaPreparingEvent
  | WorkspaceSyncReplicaAppliedEvent
  | WorkspaceSyncReplicaAbortedEvent;

export interface WorkspaceSyncReplicaDeliveryAck {
  deliveryId: string;
  phase: 'preparing' | 'applied';
  status: 'ok' | 'failed';
  error?: string;
}

export type WorkspaceSyncConflictResolution = 'keep_local' | 'use_remote';

export type WorkspaceSyncActionErrorCode = 'NOT_IMPLEMENTED' | 'INVALID_REQUEST';

export interface WorkspaceSyncActionError {
  ok: false;
  code: WorkspaceSyncActionErrorCode;
  message: string;
}

export interface WorkspaceSyncActionOk {
  ok: true;
}

export type WorkspaceSyncActionResult = WorkspaceSyncActionOk | WorkspaceSyncActionError;

export type WorkspaceSyncSetEnabledResult = WorkspaceSyncActionResult;
export type WorkspaceSyncForceSyncResult = WorkspaceSyncActionResult;

export interface WorkspaceSyncDeleteCloudCopyOk extends WorkspaceSyncActionOk {
  remoteWorkspaceId: string;
  sharesRevoked: number;
  objectsRemoved: number;
  readyVersionsDeleted: number;
  rowsRemoved?: number;
}

export type WorkspaceSyncDeleteCloudCopyResult =
  | WorkspaceSyncDeleteCloudCopyOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncResolveConflictOk extends WorkspaceSyncActionOk {
  resolution: WorkspaceSyncConflictResolution;
  workspaceUuid?: string;
  warnings?: UserMessage[];
}

export type WorkspaceSyncResolveConflictResult =
  | WorkspaceSyncResolveConflictOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncCopyShareLinkOk extends WorkspaceSyncActionOk {
  url: string;
  versionId: string;

  versionNumber?: number;
  shortId?: string;
  contentSha256?: string;
}

export type WorkspaceSyncCopyShareLinkResult =
  | WorkspaceSyncCopyShareLinkOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncProjectSummary {
  remoteWorkspaceId: string;
  displayName: string;
  ownerAccountId: string;
  ownerOrgId: string | null;

  ownerDisplayName: string;

  accessRole: WorkspaceSyncAccessRole;
  accessSource: WorkspaceSyncAccessSource;
  accessOrgId: string | null;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  updatedAt: number;
}

export interface WorkspaceSyncHistoryVersion {
  id: string;
  versionNumber: number;
  representation: 'bundle_v1' | 'manifest_v1' | 'scientific_manifest_v1';

  fileManifestSha256?: string;
  manifestSchemaVersion: number | null;
  contentSha256: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
  finalizedAt: string | null;
  createdBy: {
    accountId: string;
    email: string | null;
    displayName: string | null;
  } | null;
}

export interface WorkspaceSyncVersionHistory {
  workspaceId: string;
  versions: WorkspaceSyncHistoryVersion[];
  nextBeforeVersionNumber: number | null;
}

export interface WorkspaceSyncHistoryOptions {
  limit?: number;
  beforeVersionNumber?: number;
}

export type WorkspaceSyncOwnerChoice = { kind: 'personal' } | { kind: 'org'; orgId: string };

export interface WorkspaceSyncEnableOptions {
  owner?: WorkspaceSyncOwnerChoice;
}

export type WorkspaceSyncGrantRole = 'viewer' | 'editor' | 'manager';

export interface WorkspaceSyncOrganizationSummary {
  orgId: string;
  slug: string;
  displayName: string;
  role: string;
  canCreateManagedProjects: boolean;
  isAdministrator: boolean;
}

export interface WorkspaceSyncAccessSourceView {
  kind: WorkspaceSyncAccessSource;
  role: WorkspaceSyncAccessRole;
  orgId: string | null;
}

export interface WorkspaceSyncAccessGrantView {
  id: string;
  subjectKind: 'account' | 'org';
  accountId: string | null;
  email: string | null;
  displayName: string | null;
  orgId: string | null;
  orgName: string | null;
  role: WorkspaceSyncGrantRole;
  grantedBy: string | null;
  createdAt: string;
}

export interface WorkspaceSyncInviteView {
  id: string;
  email: string;
  role: WorkspaceSyncGrantRole;
  invitedBy: string;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface WorkspaceSyncAccessAdminView {
  accountId: string;
  email: string;
  displayName: string | null;
  orgRole: string;
}

export type WorkspaceSyncAccessOwnerView =
  | { kind: 'personal'; accountId: string; email: string; displayName: string | null }
  | { kind: 'org'; orgId: string; slug: string; displayName: string };

export interface WorkspaceSyncAccessListing {
  workspaceId: string;
  displayName: string;
  viewer: { role: WorkspaceSyncAccessRole; sources: WorkspaceSyncAccessSourceView[] };
  canManage: boolean;
  owner: WorkspaceSyncAccessOwnerView;
  admins: WorkspaceSyncAccessAdminView[];
  grants: WorkspaceSyncAccessGrantView[];
  invites: WorkspaceSyncInviteView[];
}

export interface WorkspaceSyncAccessListingOk extends WorkspaceSyncActionOk {
  listing: WorkspaceSyncAccessListing;
}
export type WorkspaceSyncAccessListingResult =
  | WorkspaceSyncAccessListingOk
  | WorkspaceSyncActionError;

export type WorkspaceSyncAccessSubject =
  | { kind: 'account'; accountId: string }
  | { kind: 'org'; orgId: string };

export interface WorkspaceSyncSetAccessRequest {
  subject: WorkspaceSyncAccessSubject;

  role: WorkspaceSyncGrantRole | null;
}

export interface WorkspaceSyncSetAccessOk extends WorkspaceSyncActionOk {
  status: 'granted' | 'changed' | 'revoked' | 'unchanged';
  role: WorkspaceSyncGrantRole | null;
  previousRole: WorkspaceSyncGrantRole | null;
  revokedInviteIds: string[];
}
export type WorkspaceSyncSetAccessResult = WorkspaceSyncSetAccessOk | WorkspaceSyncActionError;

export interface WorkspaceSyncInviteRequest {
  email: string;
  role: WorkspaceSyncGrantRole;
}

export type WorkspaceSyncInvitationDeliveryStatus =
  | 'pending'
  | 'retrying'
  | 'accepted'
  | 'failed'
  | 'uncertain'
  | 'canceled';

export interface WorkspaceSyncInviteOk extends WorkspaceSyncActionOk {
  inviteId: string;
  email: string;
  role: WorkspaceSyncGrantRole;
  expiresAt: string;
  emailSent: boolean;
  emailDeliveryStatus?: WorkspaceSyncInvitationDeliveryStatus;
  emailError?: 'email_unconfigured' | 'email_failed';
  acceptUrl: string;
}
export type WorkspaceSyncInviteResult = WorkspaceSyncInviteOk | WorkspaceSyncActionError;

export interface WorkspaceSyncRevokeInviteOk extends WorkspaceSyncActionOk {
  status: 'revoked' | 'not_pending';
}
export type WorkspaceSyncRevokeInviteResult =
  | WorkspaceSyncRevokeInviteOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOrganizationsOk extends WorkspaceSyncActionOk {
  organizations: WorkspaceSyncOrganizationSummary[];
}
export type WorkspaceSyncOrganizationsResult =
  | WorkspaceSyncOrganizationsOk
  | WorkspaceSyncActionError;

export type WorkspaceSyncOrgRole = 'owner' | 'admin' | 'member';
export type WorkspaceSyncAssignableOrgRole = 'admin' | 'member';
export type WorkspaceSyncInvitableOrgRole = WorkspaceSyncOrgRole;

export interface WorkspaceSyncCreateOrganizationRequest {
  displayName: string;
  slug: string;
}

export interface WorkspaceSyncCreateOrganizationOk extends WorkspaceSyncActionOk {
  orgId: string;
  slug: string;
  displayName: string;
}
export type WorkspaceSyncCreateOrganizationResult =
  | WorkspaceSyncCreateOrganizationOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncUpdateOrganizationRequest {
  displayName?: string;
  slug?: string;
}

export interface WorkspaceSyncUpdateOrganizationOk extends WorkspaceSyncActionOk {
  orgId: string;
  slug: string;
  displayName: string;
}
export type WorkspaceSyncUpdateOrganizationResult =
  | WorkspaceSyncUpdateOrganizationOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncDeleteOrganizationOk extends WorkspaceSyncActionOk {
  status: 'deleted';
}
export type WorkspaceSyncDeleteOrganizationResult =
  | WorkspaceSyncDeleteOrganizationOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOrgMemberView {
  accountId: string;
  role: WorkspaceSyncOrgRole;
  displayName: string;
  email: string;
  joinedAt: string;
}

export interface WorkspaceSyncOrgInviteView {
  id: string;
  email: string;
  role: WorkspaceSyncInvitableOrgRole;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceSyncOrgDirectory {
  orgId: string;
  slug: string;
  displayName: string;
  viewer: {
    accountId: string;
    role: WorkspaceSyncOrgRole;
    canInvite: boolean;
    canChangeRole: boolean;
    canRemove: boolean;
    canEditSettings: boolean;
    canDelete: boolean;
    canViewAudit: boolean;
    canConfigureProvisioning: boolean;
    isOwner: boolean;
  };
  members: WorkspaceSyncOrgMemberView[];
  invites: WorkspaceSyncOrgInviteView[];
}

export interface WorkspaceSyncOrgDirectoryOk extends WorkspaceSyncActionOk {
  directory: WorkspaceSyncOrgDirectory;
}
export type WorkspaceSyncOrgDirectoryResult =
  | WorkspaceSyncOrgDirectoryOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOrgAuditEventView {
  id: string;
  eventType: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

export interface WorkspaceSyncOrganizationAuditOk extends WorkspaceSyncActionOk {
  events: WorkspaceSyncOrgAuditEventView[];
  eventTypes: string[];
}
export type WorkspaceSyncOrganizationAuditResult =
  | WorkspaceSyncOrganizationAuditOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOrgInviteRequest {
  email: string;
  roleId: WorkspaceSyncInvitableOrgRole;
}

export interface WorkspaceSyncOrgInviteOk extends WorkspaceSyncActionOk {
  inviteId: string;
  email: string;
  role: WorkspaceSyncInvitableOrgRole;
  emailSent: boolean;
  emailDeliveryStatus?: WorkspaceSyncInvitationDeliveryStatus;
  emailError?: 'email_unconfigured' | 'email_failed';
  acceptUrl: string;
}
export type WorkspaceSyncOrgInviteResult = WorkspaceSyncOrgInviteOk | WorkspaceSyncActionError;

export interface WorkspaceSyncOrgMemberMutationOk extends WorkspaceSyncActionOk {
  revokedInviteCount: number;
}
export type WorkspaceSyncOrgMemberMutationResult =
  | WorkspaceSyncOrgMemberMutationOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncTransferOrganizationOwnershipOk extends WorkspaceSyncActionOk {
  status: 'transferred';
}
export type WorkspaceSyncTransferOrganizationOwnershipResult =
  | WorkspaceSyncTransferOrganizationOwnershipOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOrganizationProvisioningGroup {
  externalId: string;
  displayName: string;
  active: boolean;
  roleId: WorkspaceSyncAssignableOrgRole | null;
}

export type WorkspaceSyncOrganizationProvisioningStatus =
  | {
      orgId: string;
      configured: false;
      seatCount: number;
      seatLimit: number | null;
    }
  | {
      orgId: string;
      configured: true;
      provider: 'workos_directory_sync';
      workosOrganizationId: string | null;
      directoryId: string | null;
      status: 'pending' | 'active' | 'disabled' | 'deleted';
      defaultRole: string;
      userCount: number;
      activeUserCount: number;
      pendingAccountCount: number;
      groupCount: number;
      groups: WorkspaceSyncOrganizationProvisioningGroup[];
      provisionedMemberCount: number;
      eventReceiptCount: number;
      seatCount: number;
      seatLimit: number | null;
      lastEventAt: string | null;
      lastAppliedAt: string | null;
      lastError: string | null;
    };

export interface WorkspaceSyncOrganizationProvisioningStatusOk extends WorkspaceSyncActionOk {
  status: WorkspaceSyncOrganizationProvisioningStatus;
}
export type WorkspaceSyncOrganizationProvisioningStatusResult =
  | WorkspaceSyncOrganizationProvisioningStatusOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOpenOrganizationProvisioningPortalOk extends WorkspaceSyncActionOk {
  status: 'opened';
}
export type WorkspaceSyncOpenOrganizationProvisioningPortalResult =
  | WorkspaceSyncOpenOrganizationProvisioningPortalOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest {
  externalGroupId: string;
  roleId: WorkspaceSyncAssignableOrgRole;
}

export interface WorkspaceSyncSetOrganizationProvisioningGroupRoleOk extends WorkspaceSyncActionOk {
  externalGroupId: string;
  roleId: WorkspaceSyncAssignableOrgRole;
}
export type WorkspaceSyncSetOrganizationProvisioningGroupRoleResult =
  | WorkspaceSyncSetOrganizationProvisioningGroupRoleOk
  | WorkspaceSyncActionError;

export function parseWorkspaceSyncSetOrganizationProvisioningGroupRoleRequest(
  value: unknown
): WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('directory group role request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.externalGroupId !== 'string' ||
    !record.externalGroupId.trim() ||
    record.externalGroupId.length > 500 ||
    (record.roleId !== 'admin' && record.roleId !== 'member')
  ) {
    throw new Error('directory group role request is invalid');
  }
  return { externalGroupId: record.externalGroupId.trim(), roleId: record.roleId };
}

export type WorkspaceSyncMergeResourceKind = 'file' | 'sequence-package' | 'notebook-package';
export type WorkspaceSyncMergeConflictReason =
  | 'edit-edit'
  | 'rename-rename'
  | 'delete-edit'
  | 'move-delete'
  | 'membership-remove-edit'
  | 'identity-conflict'
  | 'path-conflict';
export type WorkspaceSyncMergeChoice = 'mine' | 'theirs' | 'both';

export interface WorkspaceSyncMergeSideSummary {
  path: string;
  fileCount: number;
  sizeBytes: number;
  contentHash: string;

  preview: string | null;

  sequence?: WorkspaceSyncMergeSequenceSummary;
}

export interface WorkspaceSyncMergeSequenceSummary {
  productPath: string;
  productSha256: string;
  metadataSha256: string;
  attachmentSha256: string;
  attachmentCount: number;
  attachments: Array<{ memberId: string | null; path: string; role: string; sha256: string }>;
  buildRecordCount: number;
  baseCount?: number;
  topology?: 'circular' | 'linear';
  basesSha256?: string;
  annotationsSha256?: string;
  annotationCount?: number;
  annotationNames?: string[];
  inspectionUnavailableReason: string | null;
}

export interface WorkspaceSyncMergeConflictItemView {
  resourceId: string;
  kind: WorkspaceSyncMergeResourceKind;
  reason: WorkspaceSyncMergeConflictReason;
  path: string;
  canKeepBoth: boolean;
  base: WorkspaceSyncMergeSideSummary | null;
  local: WorkspaceSyncMergeSideSummary | null;
  remote: WorkspaceSyncMergeSideSummary | null;
}

export function workspaceSyncMergeConflictItemFingerprint(
  item: Pick<
    WorkspaceSyncMergeConflictItemView,
    'resourceId' | 'kind' | 'reason' | 'path' | 'canKeepBoth'
  > & {
    base: Pick<WorkspaceSyncMergeSideSummary, 'path' | 'contentHash'> | null;
    local: Pick<WorkspaceSyncMergeSideSummary, 'path' | 'contentHash'> | null;
    remote: Pick<WorkspaceSyncMergeSideSummary, 'path' | 'contentHash'> | null;
  }
): string {
  const side = (value: typeof item.local) => (value ? [value.path, value.contentHash] : null);
  return JSON.stringify([
    item.resourceId,
    item.kind,
    item.reason,
    item.path,
    item.canKeepBoth,
    side(item.base),
    side(item.local),
    side(item.remote),
  ]);
}

export interface WorkspaceSyncMergeConflictView {
  conflictId: string;
  workspaceUuid: string;
  remoteVersionId: string;
  remoteVersionNumber: number | null;
  remoteAuthor: string | null;
  baseVersionId: string | null;
  createdAt: number;
  items: WorkspaceSyncMergeConflictItemView[];
}

export interface WorkspaceSyncMergeSummary {
  takenFromLocal: string[];
  takenFromRemote: string[];
  unchanged: string[];
  deleted: string[];
}

export type WorkspaceSyncReconcileOk =
  | { ok: true; outcome: 'no_remote_change' }
  | {
      ok: true;
      outcome: 'merged';
      summary: WorkspaceSyncMergeSummary;
      remoteVersionNumber: number;
      remoteAuthor: string | null;
    }
  | { ok: true; outcome: 'conflicts'; conflict: WorkspaceSyncMergeConflictView };
export type WorkspaceSyncReconcileResult = WorkspaceSyncReconcileOk | WorkspaceSyncActionError;

export interface WorkspaceSyncResolveMergeRequest {
  conflictId: string;
  choices: Record<string, WorkspaceSyncMergeChoice>;
}

export interface WorkspaceSyncMergeConflictOk extends WorkspaceSyncActionOk {
  conflict: WorkspaceSyncMergeConflictView | null;
}
export type WorkspaceSyncMergeConflictResult =
  | WorkspaceSyncMergeConflictOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncOpenProjectOk extends WorkspaceSyncActionOk {
  workspaceUuid: string;
  warnings?: UserMessage[];
}

export type WorkspaceSyncOpenProjectResult = WorkspaceSyncOpenProjectOk | WorkspaceSyncActionError;

export type WorkspaceSyncScientificRecoveryResult =
  | (WorkspaceSyncOpenProjectOk & {
      profilePath: string;
      projectPath: string;
      draftsPath: string;
      changedDraftFiles: number;
      coverage: 'captured-bytes' | 'incomplete';
      missingPaths: readonly string[];
    })
  | WorkspaceSyncActionError;

export interface WorkspaceSyncUploadPreviewFile {
  relativePath: string;
  name: string;
  kind: string;
  sizeBytes: number;
}

export interface WorkspaceSyncUploadPreviewOk extends WorkspaceSyncActionOk {
  workspaceUuid: string;
  includedFiles: WorkspaceSyncUploadPreviewFile[];
  includedFileCount: number;
  includedBytes: number;
  excludedSummary: import('./cloud-sync-status').WorkspaceSyncExcludedSummary;
  limits: {
    maxFileBytes: number;
    maxBundleBytes: number;
    maxFiles: number;
  };
}

export type WorkspaceSyncUploadPreviewResult =
  | WorkspaceSyncUploadPreviewOk
  | WorkspaceSyncActionError;

export interface WorkspaceSyncSubscribeStatusRequest {
  workspaceUuid: string;
  subscriptionId: string;
}

const OPAQUE_WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseWorkspaceUuid(value: unknown, label = 'workspaceUuid'): string {
  return parseOpaqueWorkspaceId(value, label);
}

export function parseRemoteWorkspaceId(value: unknown, label = 'remoteWorkspaceId'): string {
  return parseOpaqueWorkspaceId(value, label);
}

export function parseWorkspaceSyncHistoryOptions(value: unknown): WorkspaceSyncHistoryOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('history options must be an object');
  }
  const record = value as Record<string, unknown>;
  const options: WorkspaceSyncHistoryOptions = {};
  for (const key of Object.keys(record)) {
    if (key !== 'limit' && key !== 'beforeVersionNumber') {
      throw new Error(`unknown history option: ${key}`);
    }
    const number = record[key];
    if (number === undefined) continue;
    if (!Number.isSafeInteger(number) || (number as number) < 1) {
      throw new Error(`${key} must be a positive safe integer`);
    }
    if (key === 'limit' && (number as number) > 100) {
      throw new Error('history limit must not exceed 100');
    }
    options[key] = number as number;
  }
  return options;
}

export function parseWorkspaceSyncSubscriptionId(value: unknown): string {
  return parseOpaqueWorkspaceId(value, 'subscriptionId');
}

export function parseWorkspaceSyncSubscribeStatusRequest(
  value: unknown
): WorkspaceSyncSubscribeStatusRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subscribeStatus request must be an object');
  }
  const record = value as Record<string, unknown>;
  return {
    workspaceUuid: parseWorkspaceUuid(record.workspaceUuid),
    subscriptionId: parseWorkspaceSyncSubscriptionId(record.subscriptionId),
  };
}

export function parseWorkspaceSyncEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return value;
}

export function parseWorkspaceSyncConflictResolution(
  value: unknown
): WorkspaceSyncConflictResolution {
  if (value === 'keep_local' || value === 'use_remote') return value;
  throw new Error('conflict resolution must be keep_local or use_remote');
}

export function workspaceSyncNotImplemented(action: string): WorkspaceSyncActionError {
  return {
    ok: false,
    code: 'NOT_IMPLEMENTED',
    message: `${action} is not implemented yet.`,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseWorkspaceSyncEnableOptions(value: unknown): WorkspaceSyncEnableOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('enable options must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.owner === undefined || record.owner === null) return {};
  const owner = record.owner;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new Error('owner must be an object');
  }
  const ownerRecord = owner as Record<string, unknown>;
  if (ownerRecord.kind === 'personal') return { owner: { kind: 'personal' } };
  if (ownerRecord.kind === 'org') {
    if (typeof ownerRecord.orgId !== 'string' || !UUID_RE.test(ownerRecord.orgId)) {
      throw new Error('owner.orgId must be a UUID');
    }
    return { owner: { kind: 'org', orgId: ownerRecord.orgId.toLowerCase() } };
  }
  throw new Error('owner.kind must be personal or org');
}

export function parseWorkspaceSyncGrantRole(value: unknown): WorkspaceSyncGrantRole {
  if (value === 'viewer' || value === 'editor' || value === 'manager') return value;
  throw new Error('role must be viewer, editor, or manager');
}

export function parseWorkspaceSyncSetAccessRequest(value: unknown): WorkspaceSyncSetAccessRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('setAccess request must be an object');
  }
  const record = value as Record<string, unknown>;
  const subject = record.subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    throw new Error('subject must be an object');
  }
  const subjectRecord = subject as Record<string, unknown>;
  let parsedSubject: WorkspaceSyncAccessSubject;
  if (subjectRecord.kind === 'account') {
    if (typeof subjectRecord.accountId !== 'string' || !UUID_RE.test(subjectRecord.accountId)) {
      throw new Error('subject.accountId must be a UUID');
    }
    parsedSubject = { kind: 'account', accountId: subjectRecord.accountId.toLowerCase() };
  } else if (subjectRecord.kind === 'org') {
    if (typeof subjectRecord.orgId !== 'string' || !UUID_RE.test(subjectRecord.orgId)) {
      throw new Error('subject.orgId must be a UUID');
    }
    parsedSubject = { kind: 'org', orgId: subjectRecord.orgId.toLowerCase() };
  } else {
    throw new Error('subject.kind must be account or org');
  }
  const role =
    record.role === null || record.role === undefined
      ? null
      : parseWorkspaceSyncGrantRole(record.role);
  return { subject: parsedSubject, role };
}

export function parseWorkspaceSyncInviteRequest(value: unknown): WorkspaceSyncInviteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invite request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.email !== 'string') throw new Error('email must be a string');
  const email = record.email.trim();
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    throw new Error('email must be a valid address');
  }
  return { email, role: parseWorkspaceSyncGrantRole(record.role) };
}

export function parseWorkspaceSyncResolveMergeRequest(
  value: unknown
): WorkspaceSyncResolveMergeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('resolve request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.conflictId !== 'string' || !record.conflictId.trim()) {
    throw new Error('conflictId is required');
  }
  const choices: Record<string, WorkspaceSyncMergeChoice> = {};
  if (record.choices && typeof record.choices === 'object' && !Array.isArray(record.choices)) {
    for (const [resourceId, choice] of Object.entries(record.choices as Record<string, unknown>)) {
      if (choice !== 'mine' && choice !== 'theirs' && choice !== 'both') {
        throw new Error(`choice for ${resourceId} must be mine, theirs, or both`);
      }
      if (resourceId.length === 0 || resourceId.length > 2048) {
        throw new Error('resource id is invalid');
      }
      choices[resourceId] = choice;
    }
  }
  return { conflictId: record.conflictId.trim(), choices };
}

export function parseWorkspaceSyncInviteId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error('inviteId must be a UUID');
  }
  return value.toLowerCase();
}

export function parseWorkspaceSyncOrgId(value: unknown, label = 'orgId'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export function parseWorkspaceSyncCreateOrganizationRequest(
  value: unknown
): WorkspaceSyncCreateOrganizationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('createOrganization request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.displayName !== 'string' || !record.displayName.trim()) {
    throw new Error('displayName is required');
  }
  if (typeof record.slug !== 'string' || !record.slug.trim()) {
    throw new Error('slug is required');
  }
  return { displayName: record.displayName.trim(), slug: record.slug.trim().toLowerCase() };
}

export function parseWorkspaceSyncUpdateOrganizationRequest(
  value: unknown
): WorkspaceSyncUpdateOrganizationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('updateOrganization request must be an object');
  }
  const record = value as Record<string, unknown>;
  const request: WorkspaceSyncUpdateOrganizationRequest = {};
  if (Object.prototype.hasOwnProperty.call(record, 'displayName')) {
    if (typeof record.displayName !== 'string' || !record.displayName.trim()) {
      throw new Error('displayName is required');
    }
    request.displayName = record.displayName.trim();
  }
  if (Object.prototype.hasOwnProperty.call(record, 'slug')) {
    if (typeof record.slug !== 'string' || !record.slug.trim()) {
      throw new Error('slug is required');
    }
    request.slug = record.slug.trim().toLowerCase();
  }
  if (request.displayName === undefined && request.slug === undefined) {
    throw new Error('updateOrganization request is empty');
  }
  return request;
}

export function parseWorkspaceSyncOrgInviteRequest(value: unknown): WorkspaceSyncOrgInviteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('organization invite request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.email !== 'string') throw new Error('email must be a string');
  const email = record.email.trim();
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    throw new Error('email must be a valid address');
  }
  if (record.roleId !== 'owner' && record.roleId !== 'admin' && record.roleId !== 'member') {
    throw new Error('roleId must be owner, admin, or member');
  }
  return { email, roleId: record.roleId };
}

export function parseWorkspaceSyncOrgRoleChangeRequest(value: unknown): {
  roleId: WorkspaceSyncOrgRole;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('role change request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.roleId !== 'owner' && record.roleId !== 'admin' && record.roleId !== 'member') {
    throw new Error('roleId must be owner, admin, or member');
  }
  return { roleId: record.roleId };
}

function parseOpaqueWorkspaceId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a workspace UUID`);
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    !OPAQUE_WORKSPACE_ID_RE.test(trimmed)
  ) {
    throw new Error(`${label} must be a workspace UUID`);
  }
  return trimmed;
}
