import type { GenomeTrackTile } from '../../../shared/indexed-genome';

export function AnnotationSummaryStatus({
  state,
  fidelity,
  message,
  recordCount,
  sourceRecordCount,
}: {
  state: GenomeTrackTile['state'];
  fidelity: GenomeTrackTile['fidelity'];
  message?: string;
  recordCount: number;
  sourceRecordCount: number;
}) {
  const isPending =
    state === 'queued' || state === 'loading' || state === 'building_summary' || state === 'stale';
  if (!isPending) return null;
  const statusCopy =
    state === 'stale' ? 'Annotation summary is out of date.' : 'Updating annotations…';

  return (
    <div
      data-testid="indexed-genome-summary-state"
      data-tile-state={state}
      data-fidelity={fidelity}
      data-record-count={recordCount}
      data-source-record-count={sourceRecordCount}
      className="pointer-events-none absolute inset-x-3 top-3 z-10 rounded-md border border-border bg-bg-subtle/95 px-3 py-2 text-xs text-fg-muted shadow-sm"
      aria-live="polite"
    >
      <span className="font-medium text-fg">Annotations</span>
      <span className="ml-2">{statusCopy}</span>
      {message && <span className="ml-2">{message}</span>}
    </div>
  );
}
