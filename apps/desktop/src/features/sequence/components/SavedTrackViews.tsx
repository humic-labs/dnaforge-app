import { useCallback, useEffect, useState } from 'react';
import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import type { TrackViewList } from '../../../shared/track-view';
import { requestRegistryOpen } from '../../../shared/registry-events';
import { listSavedTrackViews, TRACK_VIEW_LIBRARY_CHANGED } from '../track-view-library';

function trackCount(view: TrackViewList['views'][number]['document']): number {
  return view.dataTracks.length + view.bamTracks.length + (view.variantSource ? 1 : 0);
}

function updatedLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function locationLabel(view: TrackViewList['views'][number]): string {
  if (!view.workspaceRoot) return 'App library';
  const relative = view.path.slice(view.workspaceRoot.length).replace(/^[\\/]+/u, '');
  const parts = relative.split(/[\\/]/u).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Project root';
}

export function SavedTrackViews({
  filter,
  onOpenView,
}: {
  filter: string;
  onOpenView: (path: string) => void;
}) {
  const [library, setLibrary] = useState<TrackViewList>({ views: [], errors: [] });
  const [error, setError] = useState<UserMessage | null>(null);
  const refresh = useCallback(() => {
    void listSavedTrackViews()
      .then((next) => {
        setLibrary(next);
        setError(null);
      })
      .catch((error: unknown) => {
        console.warn('[SavedTrackViews] Could not load the saved view library:', error);
        setError(toUserMessage(error, 'tracks.loadFailed'));
      });
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(TRACK_VIEW_LIBRARY_CHANGED, refresh);
    return () => window.removeEventListener(TRACK_VIEW_LIBRARY_CHANGED, refresh);
  }, [refresh]);
  const views = library.views.filter(({ document }) =>
    `${document.name} ${document.reference.name} ${document.reference.assemblyId}`
      .toLowerCase()
      .includes(filter.toLowerCase())
  );
  const viewInRegistry = () => {
    requestRegistryOpen({ entityId: null, fallbackSearch: 'track-view' });
  };
  return (
    <section
      aria-label="Saved Track views"
      className="overflow-hidden border border-border bg-bg"
      data-testid="saved-track-views"
    >
      <div className="flex h-10 items-center justify-between border-b border-border bg-bg-subtle px-4">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          Saved views
          <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[9px] tracking-normal text-fg-subtle">
            {library.views.length}
          </span>
        </h3>
        {library.views.length > 0 ? (
          <button
            type="button"
            onClick={viewInRegistry}
            className="text-xs font-medium text-accent hover:underline"
          >
            View in Registry
          </button>
        ) : null}
      </div>
      <div className="grid h-7 grid-cols-[minmax(12rem,1.45fr)_minmax(7rem,.7fr)_5rem_6rem_minmax(7rem,.65fr)] items-center border-b border-border px-4 text-[9px] font-semibold uppercase tracking-wider text-fg-subtle">
        <span>Name</span>
        <span>Reference</span>
        <span>Tracks</span>
        <span>Updated</span>
        <span>Location</span>
      </div>
      {views.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-muted">
          {library.views.length
            ? 'No saved views match this search.'
            : 'Open a reference, add tracks, and save a view to return to it here.'}
        </p>
      ) : (
        <ul>
          {views.map((saved) => {
            const { document } = saved;
            return (
              <li key={document.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  data-testid={`saved-track-view-${document.id}`}
                  onClick={() => onOpenView(saved.path)}
                  className="grid min-h-12 w-full grid-cols-[minmax(12rem,1.45fr)_minmax(7rem,.7fr)_5rem_6rem_minmax(7rem,.65fr)] items-center px-4 py-2 text-left hover:bg-bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">
                      {document.name}
                    </span>
                    <span className="block truncate text-[11px] text-fg-muted">
                      Saved Track view
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-fg-muted">
                    {document.reference.assemblyId}
                  </span>
                  <span className="text-xs text-fg-muted">{trackCount(document)}</span>
                  <span className="text-xs text-fg-muted">{updatedLabel(document.updatedAt)}</span>
                  <span className="truncate text-xs text-fg-subtle" title={saved.path}>
                    {locationLabel(saved)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="border-t border-border px-4 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {library.errors.map((issue) => (
        <p
          key={issue.name}
          role="alert"
          className="border-t border-border px-4 py-2 text-xs text-red-600"
        >
          {toUserMessage(issue, 'tracks.loadFailed')}
        </p>
      ))}
    </section>
  );
}
