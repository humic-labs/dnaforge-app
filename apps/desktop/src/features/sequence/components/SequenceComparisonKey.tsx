import type { ReactNode } from 'react';

interface SequenceComparisonKeyProps {
  readonly colorControls?: ReactNode;
  readonly referenceName: string;
  readonly referenceOrigin: number;
  readonly selectionSource: 'before' | 'after';

  readonly selection: { start: number; end: number } | null;
}

export function SequenceComparisonKey({
  referenceName,
  referenceOrigin,
  selectionSource,
  selection,
  colorControls,
}: SequenceComparisonKeyProps) {
  const origin = selectionSource === 'before' ? referenceOrigin : 0;
  const first = selection ? origin + selection.start + 1 : 0;
  const last = selection ? origin + selection.end + 1 : 0;
  const range = first === last ? String(first) : `${first}–${last}`;
  const selectedMolecule =
    selectionSource === 'before' ? `Original DNA · ${referenceName}:` : 'Edited DNA · ';
  const summary = selection
    ? `${selectedMolecule}${range} · ${selection.end - selection.start + 1} bp`
    : 'Select DNA to see its coordinates.';

  return (
    <div
      role="status"
      aria-label="DNA selection"
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-bg px-3 text-[11px] text-fg-muted"
    >
      <p
        data-testid="comparison-selection-summary"
        title={summary}
        className="min-w-0 flex-1 truncate tabular-nums text-fg"
      >
        {summary}
      </p>
      {colorControls}
    </div>
  );
}
