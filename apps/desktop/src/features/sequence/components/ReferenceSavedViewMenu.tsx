import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { platform } from '../../../platform';
import type { LimsEntity } from '../../../shared/lims';
import { LIMS_ENTITY_QUERY_HARD_MAX } from '../../../shared/lims-registry';
import { requestRegistryOpen, subscribeRegistryChanged } from '../../../shared/registry-events';

interface ReferenceSavedViewMenuProps {
  referenceId: string;
  referenceKeys: ReadonlyArray<string | null | undefined>;
  onOpenView: (path: string) => void;
}

export function ReferenceSavedViewMenu({
  referenceId,
  referenceKeys,
  onOpenView,
}: ReferenceSavedViewMenuProps) {
  const keySignature = [
    ...new Set(referenceKeys.filter((key): key is string => Boolean(key))),
  ].join('\0');
  const [views, setViews] = useState<LimsEntity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const keys = keySignature.split('\0').filter(Boolean);
    const refresh = () => {
      const currentRevision = ++revision;
      void platform()
        .lims.queryEntities({ kind: 'track-view', limit: LIMS_ENTITY_QUERY_HARD_MAX })
        .then((entities) => {
          if (cancelled || currentRevision !== revision) return;
          setViews(
            entities
              .filter(
                (entity) =>
                  entity.kind === 'track-view' &&
                  !entity.tombstone &&
                  keys.includes(String(entity.fields.referenceAssemblyId))
              )
              .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
          );
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled || currentRevision !== revision) return;
          setError(toUserMessage(cause, 'failure.could-not-load-saved-views'));
        });
    };
    refresh();
    const unsubscribe = subscribeRegistryChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [keySignature]);

  const openView = async (id: string) => {
    try {
      const saved = await platform().trackViews.read(id);
      onOpenView(saved.path);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.could-not-open-the-saved-view'));
    }
  };

  return (
    <div
      data-testid={`reference-saved-views-${referenceId}`}
      className="border-b border-border bg-bg-subtle px-8 py-2"
    >
      {error ? (
        <p role="alert" className="px-2 py-1 text-xs text-red-600">
          {toUserMessage(error, 'tracks.loadFailed')}
        </p>
      ) : null}
      {views.length > 0 ? (
        <>
          <h4 className="px-2 py-1.5 text-xs font-semibold text-fg-muted">Saved views</h4>
          <ul>
            {views.map((view) => (
              <li key={view.id} className="flex items-center gap-2 rounded hover:bg-bg">
                <button
                  type="button"
                  data-testid={`reference-saved-view-${view.id}`}
                  onClick={() => void openView(view.id)}
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm text-fg"
                >
                  {view.name}
                </button>
                <span className="shrink-0 text-xs text-fg-subtle">
                  {typeof view.fields.trackCount === 'number'
                    ? `${view.fields.trackCount} tracks`
                    : ''}
                </span>
                <button
                  type="button"
                  aria-label={`Details for ${view.name}`}
                  onClick={() =>
                    requestRegistryOpen({ entityId: view.id, fallbackSearch: 'track-view' })
                  }
                  className="shrink-0 px-2 py-1.5 text-xs text-accent hover:underline"
                >
                  Details
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
