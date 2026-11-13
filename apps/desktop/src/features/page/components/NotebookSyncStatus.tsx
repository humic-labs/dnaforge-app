import type { NotebookSyncState } from '../hooks/useNotebookFileWatcher';
import { UI_SECONDARY_BUTTON_CLASS } from '../../../components/ui/styles';

export function NotebookSyncStatus({
  state,
  onReload,
  onRetry,
  onKeepLocal,
}: {
  state: NotebookSyncState;
  onReload: () => void;
  onRetry: () => void;
  onKeepLocal: () => void;
}) {
  if (state === 'current') return null;
  return (
    <details className="relative ml-auto">
      <summary data-testid="notebook-sync-status" className={UI_SECONDARY_BUTTON_CLASS}>
        Review changes
      </summary>
      <div
        role="dialog"
        aria-label="Notebook changes"
        className="absolute right-0 top-full z-50 mt-2 w-80 rounded border border-border bg-surface p-4 text-sm text-fg shadow-lg"
      >
        <p className="mb-3">
          {state === 'conflict'
            ? 'This notebook changed outside DNAForge. Choose which version to keep.'
            : 'The changed notebook could not be read. Your current edits are still available.'}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={state === 'conflict' ? onReload : onRetry}
            className={UI_SECONDARY_BUTTON_CLASS}
          >
            {state === 'conflict' ? 'Reload from file' : 'Retry'}
          </button>
          {state === 'conflict' && (
            <button type="button" onClick={onKeepLocal} className={UI_SECONDARY_BUTTON_CLASS}>
              Keep my edits
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
