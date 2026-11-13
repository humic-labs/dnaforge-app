import type { PlannotateRangeControl as RangeControl } from './usePlannotateRangeControl';

const fieldClass =
  'w-16 px-1.5 py-0.5 text-xs rounded border border-border bg-bg text-fg ' +
  'tabular-nums disabled:opacity-50 disabled:cursor-not-allowed';

export function PlannotateRangeControl({ control }: { control: RangeControl }) {
  const { enabled, startText, endText, wraps, hasSelection, setEnabled, setStartText, setEndText } =
    control;

  return (
    <div className="mt-2 text-xs" data-testid="plannotate-range-control">
      <label className="flex items-center gap-1.5 cursor-pointer select-none text-fg-muted">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="plannotate-range-enabled"
          className="accent-accent"
        />
        <span>Annotate selection only</span>
      </label>

      {enabled && (
        <>
          <div className="mt-1.5 flex items-center gap-1.5 pl-5">
            <input
              type="number"
              min={1}
              value={startText}
              placeholder="start"
              onChange={(e) => setStartText(e.target.value)}
              data-testid="plannotate-range-start"
              aria-label="Annotate range start"
              className={fieldClass}
            />
            <span className="text-fg-muted">–</span>
            <input
              type="number"
              min={1}
              value={endText}
              placeholder="end"
              onChange={(e) => setEndText(e.target.value)}
              data-testid="plannotate-range-end"
              aria-label="Annotate range end"
              className={fieldClass}
            />
          </div>

          {wraps && startText === '' && endText === '' && (
            <p className="mt-1 pl-5 text-fg-muted" data-testid="plannotate-range-wraps-note">
              Selection crosses the origin. Annotating the whole sequence instead.
            </p>
          )}

          {!wraps && !hasSelection && startText === '' && endText === '' && (
            <p className="mt-1 pl-5 text-fg-muted">
              No selection — type a range or highlight one in the viewer.
            </p>
          )}
        </>
      )}
    </div>
  );
}
