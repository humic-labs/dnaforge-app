export type WorkspaceSyncAxis =
  | 'local_only'
  | 'binding'
  | 'idle_synced'
  | 'dirty_pending'
  | 'debouncing'
  | 'snapshotting'
  | 'queued'
  | 'uploading'
  | 'offline_retry'
  | 'service_paused'
  | 'auth_paused'
  | 'conflict'
  | 'terminal_error'
  | 'refreshing'
  | 'restoring'
  | 'archived_paused'
  | 'trashed_paused'
  | 'access_removed'
  | 'view_only';

export type WorkspaceSyncAccessRole = 'viewer' | 'editor' | 'manager' | 'owner';
export type WorkspaceSyncAccessSource = 'owner' | 'org_admin' | 'direct' | 'org_audience';
export type WorkspaceSyncDetachedReason = 'access_removed';

export type WorkspaceBufferAxis = 'clean' | 'unsaved' | 'saving' | 'save_failed';

export type WorkspaceSyncBlocker =
  | 'not_managed_workspace'
  | 'sync_disabled'
  | 'missing_workspace_uuid'
  | 'missing_remote_binding'
  | 'workspace_archived'
  | 'workspace_trashed'
  | 'auth_unavailable'
  | 'conflict'
  | 'terminal_error'
  | 'offline_retry'
  | 'service_paused'
  | 'renderer_refresh_pending'
  | 'queued_work'
  | 'upload_in_flight'
  | 'dirty_buffers'
  | 'save_in_flight'
  | 'save_failed'
  | 'excluded_authoritative_state'
  | 'local_head_mismatch'
  | 'missing_ack'
  | 'access_removed'
  | 'view_only';

export type WorkspaceSyncInFlightPhase = 'debouncing' | 'snapshotting' | 'uploading' | 'restoring';

export interface WorkspaceScopedDirtyState {
  dirtyPageIds?: readonly string[];
  dirtySequenceDocumentIds?: readonly string[];
  dirtyFilePaths?: readonly string[];
  savingPageIds?: readonly string[];
  savingSequencePaths?: readonly string[];
  saveFailedPageIds?: readonly string[];
  saveFailedSequencePaths?: readonly string[];
}

export interface WorkspaceSyncExcludedSummary {
  ignoredCount?: number;
  unsupportedCount?: number;
  privateRawDataCount?: number;
  referencePointerCount?: number;
  fileTooLargeCount?: number;
  bundleTooLargeCount?: number;
}

export interface WorkspaceSyncStatusInput {
  workspaceUuid: string | null;
  isManagedWorkspace: boolean;
  syncEnabled: boolean;
  archived?: boolean;
  trashed?: boolean;
  remoteWorkspaceId?: string | null;
  queueDepth?: number;
  rendererRefreshPending?: boolean;
  inFlightPhase?: WorkspaceSyncInFlightPhase | null;
  offline?: boolean;
  servicePaused?: boolean;
  authState?: 'ok' | 'signed_out' | 'refreshing' | 'revoked';
  conflict?: boolean;
  terminalError?: string | null;
  terminalErrorCode?: string | null;
  currentLocalHeadSha?: string | null;
  latestAckedLocalHeadSha?: string | null;
  dirtyByWorkspace?: Readonly<Record<string, WorkspaceScopedDirtyState>>;
  excludedSummary?: WorkspaceSyncExcludedSummary | null;

  accessRole?: WorkspaceSyncAccessRole | null;
  accessSource?: WorkspaceSyncAccessSource | null;

  shared?: boolean;
  detachedReason?: WorkspaceSyncDetachedReason | null;
}

export type WorkspaceSyncAutomaticMerge =
  | { outcome: 'failed'; message: string; failedAt: string }
  | { outcome: 'conflicts'; conflictId: string };

export interface WorkspaceSyncStatus {
  workspaceUuid: string | null;
  syncAxis: WorkspaceSyncAxis;
  bufferAxis: WorkspaceBufferAxis;
  canDisplayPlainSynced: boolean;

  shared: boolean;
  accessRole: WorkspaceSyncAccessRole | null;
  accessSource: WorkspaceSyncAccessSource | null;
  blockers: WorkspaceSyncBlocker[];
  excludedAuthoritativeState: readonly WorkspaceSyncV1ExcludedState[];

  excludedSummary: WorkspaceSyncExcludedSummary | null;
  terminalErrorCode: string | null;
  terminalErrorMessage: string | null;
  automaticMerge?: WorkspaceSyncAutomaticMerge;
  recoveryCandidate?: {
    representation?: 'scientific_manifest_v1';
    candidateId: string;
    localHeadSha: string;
    contentSha256: string;
    coverage: 'captured-bytes' | 'incomplete';
    createdAt: string;
    expiresAt: string;
  };
}

export interface WorkspaceSyncV1ExcludedState {
  key: 'viewer_layout_memory' | 'external_unmanaged_folders';
  reason: string;
}

export const WORKSPACE_SYNC_V1_EXCLUDED_AUTHORITATIVE_STATE: readonly WorkspaceSyncV1ExcludedState[] =
  [
    {
      key: 'viewer_layout_memory',
      reason:
        'Viewer layout, camera, selection, and ephemeral UI memory are local projection state, not V1 sync content.',
    },
    {
      key: 'external_unmanaged_folders',
      reason:
        'External folders are not eligible for auto sync until imported into a managed workspace.',
    },
  ] as const;

export function deriveWorkspaceSyncStatus(input: WorkspaceSyncStatusInput): WorkspaceSyncStatus {
  const blockers: WorkspaceSyncBlocker[] = [];
  const dirty = input.workspaceUuid ? (input.dirtyByWorkspace?.[input.workspaceUuid] ?? {}) : {};
  const bufferAxis = deriveBufferAxis(dirty);

  if (!input.workspaceUuid) blockers.push('missing_workspace_uuid');
  if (!input.isManagedWorkspace) blockers.push('not_managed_workspace');
  if (!input.syncEnabled) blockers.push('sync_disabled');
  if (input.archived) blockers.push('workspace_archived');
  if (input.trashed) blockers.push('workspace_trashed');
  if (input.authState === 'signed_out' || input.authState === 'revoked') {
    blockers.push('auth_unavailable');
  }
  if (input.rendererRefreshPending) blockers.push('renderer_refresh_pending');
  if (input.conflict) blockers.push('conflict');
  if (input.terminalError) blockers.push('terminal_error');
  if (input.offline) blockers.push('offline_retry');
  if (input.servicePaused) blockers.push('service_paused');
  if (!input.remoteWorkspaceId) blockers.push('missing_remote_binding');
  if ((input.queueDepth ?? 0) > 0) blockers.push('queued_work');
  if (input.inFlightPhase && input.inFlightPhase !== 'restoring') blockers.push('upload_in_flight');
  if (bufferAxis === 'unsaved') blockers.push('dirty_buffers');
  if (bufferAxis === 'saving') blockers.push('save_in_flight');
  if (bufferAxis === 'save_failed') blockers.push('save_failed');
  if (hasExcludedState(input.excludedSummary)) blockers.push('excluded_authoritative_state');
  if (!input.latestAckedLocalHeadSha) blockers.push('missing_ack');
  if (
    input.currentLocalHeadSha &&
    input.latestAckedLocalHeadSha &&
    input.currentLocalHeadSha !== input.latestAckedLocalHeadSha
  ) {
    blockers.push('local_head_mismatch');
  }
  if (input.detachedReason === 'access_removed') blockers.push('access_removed');
  if (input.accessRole === 'viewer' && input.detachedReason !== 'access_removed') {
    blockers.push('view_only');
  }

  const syncAxis = deriveSyncAxis(input, blockers, bufferAxis);
  const canDisplayPlainSynced =
    syncAxis === 'idle_synced' &&
    bufferAxis === 'clean' &&
    blockers.length === 0 &&
    input.currentLocalHeadSha != null &&
    input.latestAckedLocalHeadSha === input.currentLocalHeadSha;

  return {
    workspaceUuid: input.workspaceUuid,
    syncAxis,
    bufferAxis,
    canDisplayPlainSynced,
    shared: input.shared ?? false,
    accessRole: input.accessRole ?? null,
    accessSource: input.accessSource ?? null,
    blockers,
    excludedAuthoritativeState: WORKSPACE_SYNC_V1_EXCLUDED_AUTHORITATIVE_STATE,
    excludedSummary: input.excludedSummary ?? null,
    terminalErrorCode: input.terminalErrorCode ?? null,
    terminalErrorMessage: input.terminalError ?? null,
  };
}

function deriveSyncAxis(
  input: WorkspaceSyncStatusInput,
  blockers: readonly WorkspaceSyncBlocker[],
  bufferAxis: WorkspaceBufferAxis
): WorkspaceSyncAxis {
  if (input.trashed) return 'trashed_paused';
  if (input.archived) return 'archived_paused';

  if (
    input.detachedReason === 'access_removed' &&
    input.workspaceUuid &&
    input.isManagedWorkspace
  ) {
    return 'access_removed';
  }
  if (!input.workspaceUuid || !input.isManagedWorkspace || !input.syncEnabled) return 'local_only';
  if (input.authState === 'signed_out' || input.authState === 'revoked') return 'auth_paused';
  if (input.conflict) return 'conflict';
  if (input.terminalError) return 'terminal_error';
  if (input.rendererRefreshPending) return 'refreshing';
  if (input.inFlightPhase === 'restoring') return 'restoring';
  if (!input.remoteWorkspaceId) return 'binding';
  if (input.servicePaused) return 'service_paused';
  if (input.offline) return 'offline_retry';

  if (input.accessRole === 'viewer') return 'view_only';
  if (input.inFlightPhase) return input.inFlightPhase;
  if ((input.queueDepth ?? 0) > 0) return 'queued';
  if (bufferAxis !== 'clean') return 'dirty_pending';
  if (blockers.includes('excluded_authoritative_state')) return 'dirty_pending';
  if (blockers.includes('missing_ack') || blockers.includes('local_head_mismatch')) {
    return 'dirty_pending';
  }
  return 'idle_synced';
}

function deriveBufferAxis(dirty: WorkspaceScopedDirtyState): WorkspaceBufferAxis {
  if (hasAny(dirty.saveFailedPageIds) || hasAny(dirty.saveFailedSequencePaths)) {
    return 'save_failed';
  }
  if (hasAny(dirty.savingPageIds) || hasAny(dirty.savingSequencePaths)) {
    return 'saving';
  }
  if (
    hasAny(dirty.dirtyPageIds) ||
    hasAny(dirty.dirtySequenceDocumentIds) ||
    hasAny(dirty.dirtyFilePaths)
  ) {
    return 'unsaved';
  }
  return 'clean';
}

function hasExcludedState(summary: WorkspaceSyncExcludedSummary | null | undefined): boolean {
  if (!summary) return false;
  return (
    (summary.unsupportedCount ?? 0) > 0 ||
    (summary.privateRawDataCount ?? 0) > 0 ||
    (summary.referencePointerCount ?? 0) > 0 ||
    (summary.fileTooLargeCount ?? 0) > 0 ||
    (summary.bundleTooLargeCount ?? 0) > 0
  );
}

function hasAny(values: readonly unknown[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}
