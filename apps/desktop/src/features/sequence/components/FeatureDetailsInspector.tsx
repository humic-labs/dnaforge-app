import { toUserMessage } from '@waypoint/user-messages';
import { featureDisplayName } from './indexed-genome-legacy-adapter';
import type { FeatureDetailsState } from './useIndexedFeatureDetails';

export function FeatureDetailsInspector({ state }: { state: FeatureDetailsState }) {
  if (state.kind === 'idle') {
    return <div className="sr-only" aria-live="polite" />;
  }
  const label =
    state.kind === 'ready' && state.details.feature
      ? featureDisplayName(state.details.feature)
      : state.annotation.name;
  const featureType =
    state.kind === 'ready'
      ? (state.details.feature?.type ?? state.annotation.type)
      : state.annotation.type;
  const sourceId =
    state.kind === 'ready'
      ? (state.details.feature?.attributes.ID?.[0] ??
        state.details.featureId ??
        state.annotation.name)
      : state.annotation.name;

  const showSourceId = sourceId !== label;

  return (
    <div
      data-testid="indexed-genome-feature-inspector"
      data-state={state.kind}
      className="ml-auto flex min-w-48 shrink-0 items-center justify-end overflow-hidden pl-4 text-xs text-fg"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center justify-end gap-x-3 overflow-hidden whitespace-nowrap">
        <span className="max-w-[28rem] truncate font-medium" title={label}>
          {label}
        </span>
        {showSourceId && (
          <span className="truncate text-fg-muted" title={sourceId}>
            {sourceId}
          </span>
        )}
        <span className="text-fg-muted">{featureType}</span>
        {state.kind === 'loading' && <span className="text-fg-muted">Loading details</span>}
        {state.kind === 'error' && (
          <span
            className="truncate text-error"
            title={toUserMessage(state.message, 'tracks.loadFailed')}
          >
            {toUserMessage(state.message, 'tracks.loadFailed')}
          </span>
        )}
        {state.kind === 'ready' && (
          <>
            <span className="text-fg-muted">
              {state.details.relatedFeatures.length.toLocaleString()} related records
            </span>
            <span className="text-fg-muted">
              {state.details.window.start.toLocaleString()}-
              {state.details.window.end.toLocaleString()} bp
            </span>
            {state.details.truncated && <span className="text-warning">Details limited</span>}
          </>
        )}
      </div>
    </div>
  );
}
