import { useEffect, useState } from 'react';
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
  onSaveSelectionRules?: (rules: string) => void;
  onApproveSelection?: () => void;

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
  onSaveSelectionRules,
  onApproveSelection,
  organizations = [],
  ownerChoice = { kind: 'personal' },
  onOwnerChoiceChange,
  mergeConflict = null,
  onReconcile,
  onResolveMerge,
}: CloudWorkspacePanelProps) {
  const shared = syncStatus?.shared ?? false;
  const selection = uploadPreview?.selection;
  const savedRules =
    selection?.ruleFiles.find((file) => file.relativePath === '.gitignore')?.content ?? '';
  const [rules, setRules] = useState(savedRules);
  useEffect(() => {
    setRules(savedRules);
  }, [savedRules, syncWorkspaceUuid]);
  const rulesChanged = rules !== savedRules;
  const selectionPending = selection?.state === 'review-required';
  const selectedFilesSynced =
    syncStatus?.syncAxis === 'idle_synced' &&
    (uploadPreview?.excludedSummary.ignoredCount ?? 0) > 0;
  const exclusionReason = (reason: string): string =>
    (
      ({
        'project-ignore': 'kept local by project rules',
        unsupported: 'unsupported file type',
        'private-raw-data': 'raw data stays local',
        'reference-pointer': 'reference data stays local',
        'file-too-large': 'exceeds the file allowance',
        'bundle-too-large': 'exceeds the project allowance',
        'selection-review': 'waiting for selection review',
      }) as Record<string, string>
    )[reason] ?? reason;
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
          {selectionPending
            ? 'Review file selection'
            : selectedFilesSynced
              ? 'Selected files backed up'
              : syncDisplay.label}
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
        <div className="mt-2 max-h-64 overflow-auto rounded border border-border bg-bg px-1.5 py-1">
          <div data-testid="account-cloud-backup-preview">
            {uploadPreviewError ? (
              <p className="text-[11px] leading-4 text-warning">
                {toUserMessage(uploadPreviewError, 'account.failed')}
              </p>
            ) : null}
            {uploadPreview ? (
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
          {uploadPreview ? (
            <>
              {uploadPreview.excludedFiles && uploadPreview.excludedFiles.length > 0 && (
                <div
                  className="mt-2 border-t border-border pt-2"
                  data-testid="account-cloud-backup-excluded-files"
                >
                  <p className="text-[10px] uppercase tracking-wide text-fg-muted">
                    Kept on this device
                  </p>
                  <ul className="mt-1 space-y-1">
                    {uploadPreview.excludedFiles.map((file) => (
                      <li key={file.relativePath} className="text-[11px] leading-4 text-fg-muted">
                        <span className="break-all">{file.relativePath}</span> —{' '}
                        {exclusionReason(file.reason)} ({formatBytes(file.sizeBytes)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selection?.protectedFiles && selection.protectedFiles.length > 0 && (
                <p className="mt-2 text-[11px] leading-4 text-fg-muted">
                  Included despite rules:{' '}
                  {selection.protectedFiles
                    .map(
                      (file) =>
                        `${file.relativePath} (${file.reason === 'already-backed-up' ? 'already backed up' : file.reason === 'required-scientific' ? 'required scientific member' : 'shared project rules'})`
                    )
                    .join(', ')}
                  .
                </p>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {selection && onSaveSelectionRules && onApproveSelection ? (
        <div className="mt-3 space-y-2 rounded border border-border p-2">
          <label className="block text-xs text-fg" htmlFor="account-cloud-backup-rules">
            Files to keep local
          </label>
          <p className="text-[11px] leading-4 text-fg-muted">
            Project .gitignore patterns keep new files local. Files already backed up remain
            included; removing shared files is a separate action. Required scientific members and
            project rules stay included.
          </p>
          <textarea
            id="account-cloud-backup-rules"
            data-testid="account-cloud-backup-rules"
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            disabled={commandInFlight || syncStatus?.accessRole === 'viewer'}
            rows={4}
            spellCheck={false}
            className="w-full resize-y rounded border border-border bg-bg p-2 font-mono text-xs text-fg disabled:opacity-50"
          />
          {selection.ruleFiles
            .filter((file) => file.relativePath !== '.gitignore')
            .map((file) => (
              <p key={file.relativePath} className="text-[11px] text-fg-muted">
                Also applies: {file.relativePath}. Edit this file in the project to change its
                rules.
              </p>
            ))}
          {selectionPending && (
            <p className="text-xs text-warning">
              Review the included and excluded files, then apply this selection before backing up.
              {selection.newlyIncludedPaths.length > 0
                ? ` ${selection.newlyIncludedPaths.length} files in previously excluded folders are now eligible.`
                : ''}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="account-cloud-backup-save-rules"
              disabled={commandInFlight || !rulesChanged || syncStatus?.accessRole === 'viewer'}
              onClick={() => onSaveSelectionRules(rules)}
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
            >
              Save rules
            </button>
            <button
              type="button"
              data-testid="account-cloud-backup-apply-selection"
              disabled={
                commandInFlight ||
                rulesChanged ||
                !selectionPending ||
                syncStatus?.accessRole === 'viewer'
              }
              onClick={onApproveSelection}
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
            >
              Apply selection
            </button>
          </div>
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
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted wp-interactive disabled:cursor-not-allowed disabled:opacity-50"
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
            disabled={
              !syncDisplay.canEnableSync ||
              commandInFlight ||
              selectionPending ||
              rulesChanged ||
              Boolean(uploadPreviewError)
            }
            onClick={() => onRunAction('enable')}
            data-testid="account-enable-sync"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted wp-interactive disabled:cursor-not-allowed disabled:opacity-50 "
          >
            Enable
          </button>
          <button
            type="button"
            disabled={
              !syncDisplay.canForceSync || commandInFlight || selectionPending || rulesChanged
            }
            onClick={() => onRunAction('force')}
            data-testid="account-sync-now"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted wp-interactive disabled:cursor-not-allowed disabled:opacity-50 "
          >
            {syncBusy === 'force' ? 'Backing up' : 'Backup'}
          </button>
          <button
            type="button"
            disabled={!syncDisplay.canCopyShareLink || commandInFlight}
            onClick={() => onRunAction('share')}
            data-testid="account-copy-sync-link"
            title="Pin a snapshot and copy a public read-only link. This is not an invitation."
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted wp-interactive disabled:cursor-not-allowed disabled:opacity-50 "
          >
            {syncBusy === 'share' ? 'Copying' : 'Public link'}
          </button>
          <button
            type="button"
            disabled={!syncDisplay.canDeleteCloudCopy || commandInFlight}
            onClick={() => onRunAction('delete')}
            data-testid="account-delete-cloud-copy"
            className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted wp-interactive disabled:cursor-not-allowed disabled:opacity-50 "
          >
            {syncBusy === 'delete' ? 'Removing' : 'Remove'}
          </button>
        </div>
      )}
    </div>
  );
}
