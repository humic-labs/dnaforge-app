import { useEffect, useRef, useState } from 'react';
import { comparisonChangeColor, type ComparisonColorOverrides } from './sequence-comparison-colors';

const labels = {
  insertion: 'Added',
  deletion: 'Removed',
  substitution: 'Changed',
  unchanged: 'Unchanged',
} as const;

export function ComparisonColorControls({
  colors,
  onChange,
}: {
  readonly colors: ComparisonColorOverrides;
  readonly onChange: (colors: ComparisonColorOverrides) => void;
}) {
  const [open, setOpen] = useState(false);
  const owner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!owner.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div
      ref={owner}
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label="Comparison colors"
        className="rounded px-2 py-0.5 text-fg-muted wp-interactive "
        onClick={() => setOpen((value) => !value)}
      >
        DNA colors
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Comparison colors"
          className="absolute bottom-full right-0 z-50 mb-2 w-60 rounded border border-border bg-bg p-3 text-xs text-fg shadow-lg"
        >
          <p className="mb-2 font-medium">Underlying DNA differences</p>
          <p className="mb-3 text-fg-muted">
            Annotations use the DNA differences within their covered regions. DNA and ruler marks
            use the same palette.
          </p>
          {(Object.keys(labels) as Array<keyof typeof labels>).map((kind) => (
            <label key={kind} className="mb-2 flex items-center justify-between gap-3">
              <span>{labels[kind]}</span>
              <input
                type="color"
                aria-label={`${labels[kind]} change color`}
                value={`#${comparisonChangeColor(kind, colors).toString(16).padStart(6, '0')}`}
                onChange={(event) => onChange({ ...colors, [kind]: event.target.value })}
                className="h-6 w-9 cursor-pointer rounded border border-border bg-bg p-0.5"
              />
            </label>
          ))}
          <button
            type="button"
            className="mt-1 rounded border border-border px-2 py-1 wp-interactive"
            onClick={() => onChange({})}
          >
            Reset colors
          </button>
        </div>
      )}
    </div>
  );
}
