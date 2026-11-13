import type { GitLogEntry } from '../features/workspace/git';

export function ProjectHistoryTimeline({
  entries,
  loading,
}: {
  entries: GitLogEntry[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div data-testid="project-history-loading" className="px-3 py-2 text-xs text-fg-muted">
        Loading history...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="project-history-empty" className="px-3 py-2 text-xs text-fg-muted">
        No commit history available
      </div>
    );
  }

  return (
    <div data-testid="project-history-timeline" className="divide-y divide-border/60">
      {entries.map((entry) => (
        <div key={entry.hash} className="px-3 py-2">
          <div className="truncate text-sm font-medium text-fg">{entry.message}</div>
          <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-fg-muted">
            <span>{entry.relativeDate}</span>
            <span className="font-mono">{entry.hash.slice(0, 7)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
