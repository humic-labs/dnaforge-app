import { toUserMessage } from '@waypoint/user-messages';
import type { WorkspaceSyncStatus } from '../../shared/cloud-sync-status';
import type {
  WorkspaceSyncMergeChoice,
  WorkspaceSyncMergeConflictView,
  WorkspaceSyncOrganizationSummary,
  WorkspaceSyncOwnerChoice,
  WorkspaceSyncUploadPreviewOk,
} from '../../shared/workspace-sync-ipc';
import type { WorkspaceSyncDisplay, WorkspaceSyncTone } from './workspace-sync-display';
import type { ConflictResolution, SyncAction } from './useCloudWorkspaceController';
import { WorkspaceConflictActions } from './WorkspaceConflictActions';
import { MergeConflictPanel } from './MergeConflictPanel';
import { SharedProjectOwnerPicker } from './SharedProjectOwnerPicker';

function toneClass(tone: WorkspaceSyncTone): string {
  switch (tone) {
    case 'success':
      return 'border-success/30 bg-success/10 text-success';
    case 'warning':
      return 'border-warning/30 bg-warning/10 text-warning';
    case 'danger':
      return 'border-error/30 bg-error/10 text-error';
    case 'info':
      return 'border-accent/30 bg-accent/10 text-accent';
    case 'muted':
      return 'border-border bg-bg-muted text-fg-muted';
    default:
      return exhaustiveTone(tone);
  }
}

function exhaustiveTone(tone: never): never {
  throw new Error(`Unhandled sync tone: ${tone}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatFileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

export interface CloudWorkspacePanelProps {
  syncStatus: WorkspaceSyncStatus | null;
  syncWorkspaceUuid: string | null;
  syncDisplay: WorkspaceSyncDisplay;
  syncBusy: SyncAction | null;

  commandInFlight: boolean;
  uploadPreview: WorkspaceSyncUploadPreviewOk | null;
  uploadPreviewError: string | null;
  onRunAction: (action: SyncAction) => void;
  onResolveConflict: (resolution: ConflictResolution) => void;
  onRecoverScientificDrafts?: () => void;

  organizations?: WorkspaceSyncOrganizationSummary[];
  ownerChoice?: WorkspaceSyncOwnerChoice;
  onOwnerChoiceChange?: (choice: WorkspaceSyncOwnerChoice) => void;
  mergeConflict?: WorkspaceSyncMergeConflictView | null;
  onReconcile?: () => void;
  onResolveMerge?: (choices: Record<string, WorkspaceSyncMergeChoice>) => void;
}

export function CloudWorkspacePanel({
  syncStatus,
  syncWorkspaceUuid,
  syncDisplay,
  syncBusy,
  commandInFlight,
  uploadPreview,
  uploadPreviewError,
  onRunAction,
  onResolveConflict,
  onRecoverScientificDrafts,
  organizations = [],
  ownerChoice = { kind: 'personal' },
  onOwnerChoiceChange,
  mergeConflict = null,
  onReconcile,
  onResolveMerge,
}: CloudWorkspacePanelProps) {
  const shared = syncStatus?.shared ?? false;
  return (
    <div
      data-testid="account-sync-status"
      data-sync-axis={syncStatus?.syncAxis ?? 'unknown'}
      className="rounded border border-border bg-bg-subtle p-2"
    >
      {syncStatus?.recoveryCandidate?.representation === 'scientific_manifest_v1' &&
        onRecoverScientificDrafts && (
          <div
            className="mb-3 rounded border border-border p-2"
            data-testid="scientific-cloud-recovery"
          >
            <p className="text-xs text-fg-muted">
              Saved history and working drafts are available until{' '}
              {new Date(syncStatus.recoveryCandidate.expiresAt).toLocaleDateString()}.
            </p>
            <button
              type="button"
              data-testid="recover-scientific-drafts"
              disabled={commandInFlight}
              className="mt-2 rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
              onClick={onRecoverScientificDrafts}
            >
              Create an isolated recovery copy
            </button>
          </div>
        )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-fg-muted">This project</span>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${toneClass(
            syncDisplay.tone
          )}`}
        >
          {syncDisplay.label}
        </span>
      </div>
      {syncDisplay.detail ? (
        <p className="mt-1 text-xs leading-4 text-fg-muted">
          {toUserMessage(syncDisplay.detail, 'account.failed')}
        </p>
      ) : null}
      {syncDisplay.exclusionDetail ? (
        <p
          data-testid="account-cloud-backup-exclusions"
          className="mt-1 text-[11px] leading-4 text-warning"
        >
          {syncDisplay.exclusionDetail}
        </p>
      ) : null}
      {syncWorkspaceUuid ? (
        <div
          data-testid="account-cloud-backup-preview"
          className="mt-2 max-h-64 overflow-auto rounded border border-border bg-bg px-1.5 py-1"
        >
          {uploadPreviewError ? (
            <p className="text-[11px] leading-4 text-warning">
              {toUserMessage(uploadPreviewError, 'account.failed')}
            </p>
          ) : uploadPreview ? (
            <>
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">
                Will upload ({formatFileCount(uploadPreview.includedFileCount)},{' '}
                {formatBytes(uploadPreview.includedBytes)})
              </p>
              <ul className="mt-1 space-y-0.5">
                {uploadPreview.includedFiles.map((file) => (
                  <li
                    key={file.relativePath}
                    className="truncate text-[11px] leading-4 text-fg-muted"
                    title={file.relativePath}
                  >
                    {file.relativePath}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[11px] leading-4 text-fg-muted">Checking what will upload…</p>
          )}
        </div>
      ) : null}
      {syncDisplay.canEnableSync && onOwnerChoiceChange ? (
        <SharedProjectOwnerPicker
          organizations={organizations}
          value={ownerChoice}
          disabled={commandInFlight}
          onChange={onOwnerChoiceChange}
        />
      ) : null}
      {syncStatus?.syncAxis === 'conflict' && mergeConflict && onResolveMerge && onReconcile ? (
        <MergeConflictPanel
          conflict={mergeConflict}
          commandInFlight={commandInFlight}
          onResolve={onResolveMerge}
          onReconcileAgain={onReconcile}
        />
      ) : syncStatus?.syncAxis === 'conflict' && shared && onReconcile ? (
        <div className="mt-2 grid grid-cols-1 gap-1">
          <p className="text-[11px] leading-4 text-fg-muted">
            A newer shared version exists. DNAForge combines compatible changes automatically;
            anything that overlaps will be shown for you to decide.
          </p>
          <button
            type="button"
            disabled={commandInFlight}
            onClick={onReconcile}
            data-testid="account-reconcile-now"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncBusy === 'reconcile' ? 'Combining…' : 'Combine changes now'}
          </button>
        </div>
      ) : syncStatus?.syncAxis === 'conflict' ? (
        <WorkspaceConflictActions
          syncBusy={syncBusy}
          commandInFlight={commandInFlight}
          onResolve={onResolveConflict}
        />
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-1">
          <button
            type="button"
            disabled={!syncDisplay.canEnableSync || commandInFlight}
            onClick={() => onRunAction('enable')}
            data-testid="account-enable-sync"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Enable
          </button>
          <button
            type="button"
            disabled={!syncDisplay.canForceSync || commandInFlight}
            onClick={() => onRunAction('force')}
            data-testid="account-sync-now"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {syncBusy === 'force' ? 'Backing up' : 'Backup'}
          </button>
          <button
            type="button"
            disabled={!syncDisplay.canCopyShareLink || commandInFlight}
            onClick={() => onRunAction('share')}
            data-testid="account-copy-sync-link"
            title="Pin a snapshot and copy a public read-only link. This is not an invitation."
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {syncBusy === 'share' ? 'Copying' : 'Public link'}
          </button>
          <button
            type="button"
            disabled={!syncDisplay.canDeleteCloudCopy || commandInFlight}
            onClick={() => onRunAction('delete')}
            data-testid="account-delete-cloud-copy"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {syncBusy === 'delete' ? 'Removing' : 'Remove'}
          </button>
        </div>
      )}
    </div>
  );
}
