import type { ConflictResolution, SyncAction } from './useCloudWorkspaceController';

export interface WorkspaceConflictActionsProps {
  syncBusy: SyncAction | null;
  commandInFlight: boolean;
  onResolve: (resolution: ConflictResolution) => void;
}

export function WorkspaceConflictActions({
  syncBusy,
  commandInFlight,
  onResolve,
}: WorkspaceConflictActionsProps) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-1">
      <button
        type="button"
        role="menuitem"
        disabled={commandInFlight}
        onClick={() => onResolve('keep_local')}
        data-testid="account-resolve-keep-local"
        className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {syncBusy === 'resolve-keep-local' ? 'Queueing' : 'Upload local'}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={commandInFlight}
        onClick={() => onResolve('use_remote')}
        data-testid="account-resolve-use-remote"
        className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {syncBusy === 'resolve-use-remote' ? 'Opening' : 'Open cloud'}
      </button>
    </div>
  );
}
