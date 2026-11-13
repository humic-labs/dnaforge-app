import type { VerificationSession } from '../types';
import { InlineEditableText } from './InlineEditableText';
import { ArchiveIcon, UnarchiveIcon } from './icons';

interface SessionListItemProps {
  session: VerificationSession;
  isActive: boolean;
  isStale: boolean;
  isPending: boolean;
  pendingCount: number;
  isConfirmingDelete: boolean;
  onSetActive: (sessionId: string) => void;
  onRename: (sessionId: string, name: string) => void;
  onRerun: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
  onRequestDelete: (sessionId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (sessionId: string) => void;
}

export function SessionListItem({
  session,
  isActive,
  isStale,
  isPending,
  pendingCount,
  isConfirmingDelete,
  onSetActive,
  onRename,
  onRerun,
  onArchive,
  onUnarchive,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: SessionListItemProps) {
  const isAligning = isPending;
  const isArchived = session.archived === true;
  const hasRetainedEvidence =
    Boolean(session.alignmentOperation?.evidenceRunId) ||
    [...session.tracks, ...(session.historicalTracks ?? [])].some((track) =>
      Boolean(track.evidenceRunId)
    );
  const modeLabel = session.mode === 'one-per-clone' ? '1/clone' : 'multi/clone';

  if (isConfirmingDelete) {
    return (
      <div
        data-testid={`alignment-session-${session.id}`}
        className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-y border-red-500/30"
      >
        <span className="text-xs text-red-400 flex-1">Delete &ldquo;{session.name}&rdquo;?</span>
        <button
          onClick={() => onCancelDelete()}
          className="px-2 py-1 text-xs text-fg-muted hover:text-fg rounded border border-border"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirmDelete(session.id)}
          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 rounded border border-red-500/30 hover:bg-red-500/20"
        >
          Delete
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid={`alignment-session-${session.id}`}
      onClick={() => onSetActive(session.id)}
      className={`group flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
        isActive ? 'bg-accent/10' : 'hover:bg-bg-subtle'
      } ${isArchived ? 'opacity-50' : ''}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <InlineEditableText
            value={session.name}
            onSave={(name) => onRename(session.id, name)}
            className="font-medium text-sm truncate"
          />
          {isStale && !isAligning && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRerun(session.id);
              }}
              className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-700 dark:text-yellow-400 border border-amber-600/30 dark:border-yellow-500/30 hover:bg-amber-500/25 transition-colors flex items-center gap-1"
              title="Reference sequence has changed — click to re-run alignments"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0V4zm.75 7.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
              </svg>
              Re-run
            </button>
          )}
          {isArchived && (
            <span className="px-1 py-0.5 rounded text-[10px] bg-bg-subtle text-fg-muted border border-border">
              Archived
            </span>
          )}
          {isAligning && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400 flex items-center gap-1">
              <span className="animate-spin">⟳</span>
              {pendingCount}
            </span>
          )}
        </div>
        <div className="text-xs text-fg-muted">
          {session.tracks.length} clone{session.tracks.length !== 1 ? 's' : ''} • {modeLabel}
        </div>
        {session.alignmentOperation?.attachmentError && (
          <p
            role="status"
            data-testid="alignment-result-not-attached"
            className="text-xs text-amber-700 dark:text-yellow-400 mt-1"
          >
            Result available in Jobs, not attached. {session.alignmentOperation.attachmentError}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (isArchived) {
              onUnarchive(session.id);
            } else {
              onArchive(session.id);
            }
          }}
          className="text-fg-muted hover:text-fg p-1 rounded hover:bg-bg-subtle transition-colors"
          aria-label={isArchived ? 'Unarchive' : 'Archive'}
          title={isArchived ? 'Unarchive' : 'Archive'}
        >
          {isArchived ? <UnarchiveIcon /> : <ArchiveIcon />}
        </button>
        {}
        {!hasRetainedEvidence && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(session.id);
            }}
            className="text-fg-muted hover:text-red-500 p-1 rounded hover:bg-red-500/10 transition-colors"
            aria-label="Delete session"
            title="Delete session"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
