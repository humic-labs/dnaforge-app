import { useState, useCallback } from 'react';
import type { GitLogEntry } from '../../workspace/public/git';
import type { DiffResult, SequenceChange } from '../diff/sequence-diff';
import { SequenceChangeList } from './SequenceChangeList';

interface GitHistoryDrawerProps {
  log: GitLogEntry[];
  isLoading: boolean;
  isGitRepo: boolean;
  selectedCommitHash: string | null;
  hasUncommittedChanges: boolean;
  diffResult: DiffResult | null;

  onScrollToChange: (change: SequenceChange) => void;

  isDiffViewActive: boolean;

  onToggleDiffView: () => void;
  onSelectCommit: (hash: string) => void;
  onCommit: (message: string) => Promise<void>;
  onRevert: () => Promise<void>;
}

export function GitHistoryDrawer({
  log,
  isLoading,
  isGitRepo,
  selectedCommitHash,
  hasUncommittedChanges,
  diffResult,
  onScrollToChange,
  isDiffViewActive,
  onToggleDiffView,
  onSelectCommit,
  onCommit,
  onRevert,
}: GitHistoryDrawerProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setIsCommitting(true);
    try {
      await onCommit(commitMessage.trim());
      setCommitMessage('');
    } finally {
      setIsCommitting(false);
    }
  }, [commitMessage, onCommit]);

  const handleRevert = useCallback(async () => {
    setIsReverting(true);
    try {
      await onRevert();
    } finally {
      setIsReverting(false);
    }
  }, [onRevert]);

  if (!isGitRepo) {
    return (
      <div className="flex flex-col h-full text-sm">
        <div className="px-3 py-2 border-b border-border font-medium text-fg">Git History</div>
        <div className="px-3 py-4 text-xs text-fg-muted space-y-2">
          <p>This file is not in a git repository.</p>
          <p>
            To track changes, open files from a git-initialized directory, or run{' '}
            <code className="px-1 py-0.5 rounded bg-bg-elevated text-fg text-[10px]">git init</code>{' '}
            in the file&apos;s parent directory.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-sm">
      {}
      <div className="px-3 py-2 border-b border-border font-medium text-fg">Git History</div>

      {}
      {diffResult && (
        <SequenceChangeList
          diffResult={diffResult}
          onScrollToChange={(change) => onScrollToChange(change)}
          isDiffViewActive={isDiffViewActive}
          onToggleDiffView={onToggleDiffView}
        />
      )}
      {!hasUncommittedChanges && !isLoading && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-xs text-fg-muted">No changes to commit</div>
        </div>
      )}

      {}
      <div className="px-3 py-3 border-b border-border space-y-2">
        <div>
          <label className="text-xs text-fg-muted block mb-1">Commit message:</label>
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCommit()}
            placeholder="Describe your changes..."
            className="w-full px-2 py-1 rounded bg-bg-elevated border border-border text-fg text-xs focus:outline-none focus:border-accent"
            disabled={isCommitting || !hasUncommittedChanges}
          />
        </div>
        <button
          onClick={handleCommit}
          disabled={isCommitting || !commitMessage.trim() || !hasUncommittedChanges}
          className="w-full px-2 py-1 rounded text-xs bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isCommitting ? 'Committing...' : 'Commit this file'}
        </button>
        <button
          onClick={handleRevert}
          disabled={isReverting || !hasUncommittedChanges}
          className="w-full px-2 py-1 rounded text-xs text-fg-muted hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isReverting ? 'Reverting...' : 'Discard changes'}
        </button>
      </div>

      {}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2 text-xs text-fg-muted font-medium">History</div>
        {isLoading && <div className="px-3 py-2 text-xs text-fg-muted">Loading...</div>}
        {!isLoading && log.length === 0 && (
          <div className="px-3 py-2 text-xs text-fg-muted">No commits yet</div>
        )}
        {log.map((entry) => (
          <div
            key={entry.hash}
            className={`px-3 py-2 border-b border-border/50 ${
              selectedCommitHash === entry.hash ? 'bg-accent/5' : ''
            }`}
          >
            <div className="text-xs text-fg truncate">{entry.message}</div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-fg-muted">{entry.relativeDate}</span>
              <button
                onClick={() => onSelectCommit(entry.hash)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  selectedCommitHash === entry.hash
                    ? 'bg-accent/20 text-accent'
                    : 'text-fg-muted hover:text-accent hover:bg-accent/10'
                }`}
              >
                {selectedCommitHash === entry.hash ? 'Hide diff' : 'Diff'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
