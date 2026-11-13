import {
  type UserMessage,
  userMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import type {
  WorkspaceSyncAxis,
  WorkspaceSyncExcludedSummary,
  WorkspaceSyncStatus,
} from '../../shared/cloud-sync-status';

export type WorkspaceSyncTone = 'muted' | 'info' | 'success' | 'warning' | 'danger';

export interface WorkspaceSyncDisplayInput {
  signedIn: boolean;
  status: WorkspaceSyncStatus | null;

  statusUnavailable?: boolean;
}

export interface WorkspaceSyncDisplay {
  label: string;
  detail: UserMessage;

  scopeDetail: UserMessage | null;

  exclusionDetail: UserMessage | null;
  tone: WorkspaceSyncTone;
  canForceSync: boolean;
  canCopyShareLink: boolean;
  canEnableSync: boolean;
  canDeleteCloudCopy: boolean;
}

export const CLOUD_BACKUP_SCOPE_DETAIL = userMessage(
  'copy.uploads-eligible-design-files-only-genbank-fasta-notebooks-design'
);

export function describeWorkspaceSyncDisplay(
  input: WorkspaceSyncDisplayInput
): WorkspaceSyncDisplay {
  const status = input.status;
  const canDelete = canDeleteCloudCopy(input);
  const exclusionDetail = formatExclusionDetail(status?.excludedSummary ?? null);

  if (!input.signedIn) {
    return {
      label: 'Off',
      detail: userMessage('copy.'),
      scopeDetail: null,
      exclusionDetail: null,
      tone: 'muted',
      canForceSync: false,
      canCopyShareLink: false,
      canEnableSync: false,
      canDeleteCloudCopy: false,
    };
  }

  if (input.statusUnavailable) {
    return {
      label: 'Status unavailable',
      detail: userMessage('copy.could-not-read-cloud-backup-status-close-and-reopen-this-menu-to-'),
      scopeDetail: null,
      exclusionDetail: null,
      tone: 'warning',
      canForceSync: false,
      canCopyShareLink: false,
      canEnableSync: false,
      canDeleteCloudCopy: false,
    };
  }

  if (!status || !status.workspaceUuid || status.syncAxis === 'local_only') {
    return {
      label: 'Local only',
      detail: userMessage('copy.enable-backup-for-this-managed-project-to-use-another-mac-or-shar'),
      scopeDetail: null,
      exclusionDetail,
      tone: 'muted',
      canForceSync: false,
      canCopyShareLink: false,
      canEnableSync: Boolean(status?.workspaceUuid),
      canDeleteCloudCopy: canDelete,
    };
  }

  if (
    status.terminalErrorCode === 'QUOTA_EXCEEDED' ||
    status.terminalErrorMessage?.toLowerCase().includes('quota')
  ) {
    return {
      label: 'Storage limit reached',
      detail: toUserMessage(
        status.terminalErrorMessage,
        'copy.cloud-storage-is-full-for-this-account'
      ),
      scopeDetail: null,
      exclusionDetail,
      tone: 'danger',
      canForceSync: false,
      canCopyShareLink: false,
      canEnableSync: false,
      canDeleteCloudCopy: canDelete,
    };
  }

  if (status.blockers.includes('excluded_authoritative_state')) {
    return {
      label: 'Some files stay local',
      detail:
        exclusionDetail ??
        userMessage('copy.this-project-has-files-or-state-that-cloud-backup-cannot-upload-y'),
      scopeDetail: null,
      exclusionDetail,
      tone: 'warning',

      canForceSync:
        status.bufferAxis === 'clean' &&
        status.accessRole !== 'viewer' &&
        ![
          'auth_paused',
          'view_only',
          'access_removed',
          'restoring',
          'refreshing',
          'archived_paused',
          'trashed_paused',
        ].includes(status.syncAxis) &&
        !status.blockers.some((blocker) =>
          [
            'auth_unavailable',
            'missing_remote_binding',
            'access_removed',
            'renderer_refresh_pending',
            'workspace_archived',
            'workspace_trashed',
          ].includes(blocker)
        ),
      canCopyShareLink: false,
      canEnableSync: false,
      canDeleteCloudCopy: canDelete,
    };
  }

  const shared = status.shared;
  switch (status.syncAxis) {
    case 'access_removed':
      return display(
        'Access removed',
        userMessage('copy.you-no-longer-have-access-to-this-shared-project-your-unsent-chan'),
        'danger',
        false,
        false,
        exclusionDetail
      );
    case 'view_only':
      return display(
        'View only',
        userMessage('copy.you-can-open-and-read-this-shared-project-changes-you-make-stay-o'),
        'info',
        false,
        false,
        exclusionDetail
      );
    case 'refreshing':
      return display(
        'Refreshing desktop',
        userMessage('copy.incoming-changes-are-saved-updating-the-desktop-before-backup-con'),
        'info',
        false,
        canDelete,
        exclusionDetail
      );
    case 'binding':
      return display(
        'Preparing backup',
        userMessage('copy.creating-the-cloud-project-binding'),
        'info',
        false,
        canDelete,
        exclusionDetail
      );
    case 'debouncing':
    case 'snapshotting':
    case 'queued':
    case 'uploading':
      return display(
        shared ? 'Syncing' : 'Backing up',
        userMessageWithValues('copy.details-value', {
          value0: userMessageValue(backingUpDetail(status.syncAxis)),
        }),
        'info',
        false,
        canDelete,
        exclusionDetail
      );
    case 'idle_synced':
      return status.canDisplayPlainSynced
        ? display(
            'Up to date',
            shared
              ? userMessage('copy.your-copy-matches-the-latest-shared-version')
              : userMessage('copy.eligible-design-files-match-the-latest-cloud-version'),
            'success',
            true,
            canDelete,
            exclusionDetail
          )
        : display(
            shared ? 'Changes waiting to sync' : 'Unsaved changes',
            shared
              ? userMessage('copy.saved-changes-on-this-computer-have-not-been-shared-yet')
              : userMessage('copy.local-changes-are-waiting-for-backup'),
            'warning',
            true,
            canDelete,
            exclusionDetail
          );
    case 'dirty_pending':
      return display(
        shared ? 'Changes waiting to sync' : 'Unsaved changes',
        shared
          ? userMessage('copy.saved-changes-on-this-computer-have-not-been-shared-yet')
          : userMessage('copy.local-changes-are-waiting-for-backup'),
        'warning',
        true,
        canDelete,
        exclusionDetail
      );
    case 'offline_retry':
      return display(
        shared ? 'Offline — changes saved on this computer' : 'Offline, retrying',
        shared
          ? userMessage('copy.your-work-is-safe-here-and-will-sync-when-you-reconnect')
          : userMessage('copy.backup-will-retry-when-the-network-is-available'),
        'warning',
        true,
        canDelete,
        exclusionDetail
      );
    case 'service_paused':
      return display(
        'Cloud backup unavailable',
        userMessage('copy.cloud-backup-is-paused-for-this-dnaforge-environment-and-will-ret'),
        'warning',
        false,
        canDelete,
        exclusionDetail
      );
    case 'auth_paused':
      return display(
        'Sign in to resume backup',
        userMessage('copy.the-bound-account-must-be-active-to-continue'),
        'warning',
        false,
        canDelete,
        exclusionDetail
      );
    case 'conflict':
      return display(
        shared ? 'Changes need your attention' : 'Backup conflict',
        shared
          ? userMessage('copy.someone-else-changed-the-same-content-choose-which-version-to-kee')
          : userMessage('copy.remote-changes-need-a-resolution-before-upload-continues'),
        'danger',
        false,
        canDelete,
        exclusionDetail
      );
    case 'terminal_error':
      if (status.blockers.includes('renderer_refresh_pending')) {
        return display(
          'Desktop refresh needs attention',
          toUserMessage(
            status.terminalErrorMessage,
            'copy.incoming-changes-are-saved-the-desktop-must-finish-refreshing-bef'
          ),
          'danger',
          false,
          canDelete,
          exclusionDetail
        );
      }
      return display(
        shared ? 'Needs attention' : 'Backup stopped',
        toUserMessage(status.terminalErrorMessage, 'copy.cloud-backup-needs-attention'),
        'danger',
        true,
        canDelete,
        exclusionDetail
      );
    case 'restoring':
      return display(
        'Restoring',
        userMessage('copy.opening-the-cloud-version-locally'),
        'info',
        false,
        canDelete,
        exclusionDetail
      );
    case 'archived_paused':
      return display(
        'Archived',
        userMessage('copy.archived-projects-do-not-back-up'),
        'muted',
        false,
        canDelete,
        exclusionDetail
      );
    case 'trashed_paused':
      return display(
        'In Trash',
        userMessage('copy.trashed-projects-do-not-back-up'),
        'muted',
        false,
        canDelete,
        exclusionDetail
      );
    default:
      return exhaustiveAxis(status.syncAxis);
  }
}

export function formatExclusionDetail(
  summary: WorkspaceSyncExcludedSummary | null | undefined
): UserMessage | null {
  if (!summary) return null;
  const parts: string[] = [];
  pushCount(parts, summary.privateRawDataCount, 'raw/sequencing');
  pushCount(parts, summary.referencePointerCount, 'reference annotations');
  pushCount(parts, summary.fileTooLargeCount, 'too large');
  pushCount(parts, summary.bundleTooLargeCount, 'over bundle cap');
  pushCount(parts, summary.unsupportedCount, 'unsupported type');
  if (parts.length === 0) return null;
  return userMessageWithValues('copy.left-local-value', {
    value0: userMessageValue(parts.join(', ')),
  });
}

function pushCount(parts: string[], count: number | undefined, label: string): void {
  if (!count || count <= 0) return;
  parts.push(`${count} ${label}`);
}

function display(
  label: string,
  detail: UserMessage,
  tone: WorkspaceSyncTone,
  canRun: boolean,
  canDelete: boolean,
  exclusionDetail: UserMessage | null
): WorkspaceSyncDisplay {
  return {
    label,
    detail,
    scopeDetail: null,
    exclusionDetail,
    tone,
    canForceSync: canRun,
    canCopyShareLink: canRun,
    canEnableSync: false,
    canDeleteCloudCopy: canDelete,
  };
}

function canDeleteCloudCopy(input: WorkspaceSyncDisplayInput): boolean {
  const status = input.status;

  const ownerLevel = status?.accessRole == null || status.accessRole === 'owner';
  return Boolean(
    input.signedIn &&
    status?.workspaceUuid &&
    ownerLevel &&
    !status.blockers.includes('missing_remote_binding') &&
    !status.blockers.includes('renderer_refresh_pending') &&
    !status.blockers.includes('access_removed')
  );
}

function backingUpDetail(axis: WorkspaceSyncAxis): string {
  if (axis === 'queued') return 'Backup is queued behind earlier work.';
  if (axis === 'debouncing') return 'Waiting for file changes to settle.';
  if (axis === 'snapshotting') return 'Packaging eligible design files.';
  return 'Uploading the latest eligible design files.';
}

function exhaustiveAxis(axis: never): never {
  throw new Error(`Unhandled workspace sync axis: ${axis}`);
}
