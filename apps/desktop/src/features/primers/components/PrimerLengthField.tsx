import { useState } from 'react';
import { StepperTriangle } from '@waypoint/ui-components';
import { SETTINGS_FIELD_CLASS } from '../../../components/SettingsSubsection';

interface PrimerLengthFieldProps {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  editable: boolean;
  quantity?: 'length' | 'position';
  wrap?: boolean;
  className?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function PrimerLengthField({
  value,
  min,
  max,
  onChange,
  editable,
  quantity = 'length',
  wrap = false,
  className = '',
}: PrimerLengthFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? String(value);
  const label = quantity === 'position' ? 'binding position' : 'length';
  const testId = quantity === 'position' ? 'primer-3prime-position' : 'primer-3prime-length';

  const commitNumber = (n: number) => {
    onChange(clamp(n, min, max));
    setDraft(null);
  };

  const commitDraft = () => commitNumber(draft === '' || draft == null ? min : parseInt(draft, 10));
  const step = (delta: number) => {
    const next = value + delta;
    commitNumber(wrap && next > max ? min : wrap && next < min ? max : next);
  };

  if (!editable) {
    return (
      <div
        className={`flex h-8 min-w-0 items-center gap-1 text-sm font-semibold tabular-nums text-fg ${className}`}
      >
        <span data-testid={testId}>{value}</span>
      </div>
    );
  }

  return (
    <div
      className={`${SETTINGS_FIELD_CLASS} group flex !h-8 items-center gap-0.5 !px-1.5 font-semibold tabular-nums focus-within:ring-2 focus-within:ring-accent/20 ${className}`}
      data-testid={testId}
    >
      <input
        type="text"
        inputMode="numeric"
        aria-label={`3′ ${label}`}
        title={`Click or double-click to type a ${label}, Enter to apply`}
        data-testid={quantity === 'position' ? 'primer-position-input' : 'primer-length-input'}
        size={String(max).length}
        value={displayValue}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '' || /^\d+$/.test(raw)) setDraft(raw);
        }}
        onFocus={(e) => {
          setDraft(String(value));
          e.target.select();
        }}
        onDoubleClick={(e) => e.currentTarget.select()}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            step(-1);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            commitDraft();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className="w-0 min-w-0 flex-1 cursor-text rounded border-0 bg-transparent px-0.5 text-left text-sm font-semibold tabular-nums text-fg hover:bg-bg-muted focus:bg-bg-muted focus:outline-none"
      />
      <span className="flex shrink-0 flex-col opacity-70 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => step(1)}
          disabled={!wrap && value >= max}
          tabIndex={-1}
          className="flex items-center justify-center rounded px-0.5 py-px text-fg-muted wp-interactive disabled:opacity-20"
        >
          <StepperTriangle direction="up" className="h-2 w-3" />
        </button>
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => step(-1)}
          disabled={!wrap && value <= min}
          tabIndex={-1}
          className="flex items-center justify-center rounded px-0.5 py-px text-fg-muted wp-interactive disabled:opacity-20"
        >
          <StepperTriangle direction="down" className="h-2 w-3" />
        </button>
      </span>
    </div>
  );
}
