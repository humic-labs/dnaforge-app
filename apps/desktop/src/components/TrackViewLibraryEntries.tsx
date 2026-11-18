import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { useCallback, useEffect, useState } from 'react';
import { platform } from '../platform';
import type { TrackViewList } from '../shared/track-view';
import { TRACK_VIEW_LIBRARY_CHANGED } from '../features/sequence/track-view-library';
import { FileTypeIcon, SpinnerIcon } from './icons';

export function useIsTrackViewLibrary(path: string): boolean {
  const [directory, setDirectory] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void platform()
      .trackViews.locations()
      .then(
        ({ defaultDirectory }) => {
          if (current) setDirectory(defaultDirectory);
        },
        (error: unknown) => console.warn('[TrackViewLibrary] Could not resolve library:', error)
      );
    return () => {
      current = false;
    };
  }, []);
  return directory === path;
}

export function TrackViewLibraryEntries({
  onOpenView,
  activePath,
  refreshToken,
}: {
  onOpenView: (path: string) => void;
  activePath: string | null;
  refreshToken: string;
}) {
  const [library, setLibrary] = useState<TrackViewList | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    let current = true;
    void platform()
      .trackViews.list()
      .then(
        (next) => {
          if (current) {
            setLibrary(next);
            setFailed(false);
          }
        },
        (error: unknown) => {
          console.warn('[TrackViewLibrary] Could not list saved views:', error);
          if (current) setFailed(true);
        }
      );
    return () => {
      current = false;
    };
  }, []);
  useEffect(refresh, [refresh, refreshToken]);
  useEffect(() => {
    const changed = () => {
      refresh();
    };
    window.addEventListener(TRACK_VIEW_LIBRARY_CHANGED, changed);
    return () => window.removeEventListener(TRACK_VIEW_LIBRARY_CHANGED, changed);
  }, [refresh]);
  return (
    <div data-testid="track-view-library-entries">
      {!library && !failed && (
        <div className="px-4 py-2">
          <SpinnerIcon />
        </div>
      )}
      {library?.views.map((saved) => (
        <button
          key={saved.document.id}
          type="button"
          role="treeitem"
          aria-selected={saved.path === activePath}
          data-selected={saved.path === activePath}
          data-track-view-id={saved.document.id}
          data-entry-kind="track-view"
          data-entry-path={saved.path}
          title={saved.document.name}
          onClick={() => onOpenView(saved.path)}
          className={`${INTERACTION_CLASS} flex w-full min-w-0 items-center gap-1.5 py-1 pl-7 pr-2 text-left text-sm`}
        >
          <FileTypeIcon
            category="genome"
            path={saved.path}
            context={{ kind: 'track-view' }}
            className="h-4 w-4 shrink-0"
          />
          <span className="truncate">{saved.document.name}</span>
        </button>
      ))}
      {library?.views.length === 0 && !failed && (
        <p className="px-4 py-2 text-xs text-fg-muted">No saved Track views.</p>
      )}
      {(failed || Boolean(library?.errors.length)) && (
        <div role="alert" className="px-4 py-2 text-xs text-error">
          <p>Some saved Track views could not be opened. Their files have been preserved.</p>
          <button type="button" onClick={refresh} className="text-accent hover:underline">
            Retry saved views
          </button>
        </div>
      )}
    </div>
  );
}
