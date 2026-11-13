import { useEffect, useRef, useState } from 'react';

interface WorkbenchNumberControlProps {
  label: string;
  testId: string;
  value: number;
  committedValue?: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange?: (value: number) => void;
  onPreview?: (value: number) => void;
  onCommit?: (value: number) => void;
  onCancel?: () => void;
}

const PREVIEW_AUTO_COMMIT_DEBOUNCE_MS = 250;

export function WorkbenchNumberControl({
  label,
  testId,
  value,
  committedValue,
  min,
  max,
  disabled,
  onChange,
  onPreview,
  onCommit,
  onCancel,
}: WorkbenchNumberControlProps) {
  const [draftValue, setDraftValue] = useState(String(value));
  const hasPreviewedChangeRef = useRef(false);
  const autoCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutoCommitValueRef = useRef<number | null>(null);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const lastEmittedPreviewValueRef = useRef<number | null>(null);

  useEffect(() => {
    setDraftValue(String(value));
    if (autoCommitTimerRef.current !== null && value !== lastEmittedPreviewValueRef.current) {
      clearTimeout(autoCommitTimerRef.current);
      autoCommitTimerRef.current = null;
      pendingAutoCommitValueRef.current = null;
      lastEmittedPreviewValueRef.current = null;
    }
  }, [value]);

  const cancelAutoCommit = () => {
    if (autoCommitTimerRef.current !== null) {
      clearTimeout(autoCommitTimerRef.current);
      autoCommitTimerRef.current = null;
    }
    pendingAutoCommitValueRef.current = null;
    lastEmittedPreviewValueRef.current = null;
  };

  useEffect(() => () => cancelAutoCommit(), []);

  const commit = () => {
    cancelAutoCommit();
    if (disabled) return;
    const parsedValue = draftValue.trim() === '' ? Number.NaN : Number(draftValue);
    if (!Number.isFinite(parsedValue)) {
      setDraftValue(String(value));
      return;
    }
    const nextValue = clampNumber(parsedValue, min, max);
    setDraftValue(String(nextValue));
    const compareValue = committedValue ?? value;
    const shouldCommit =
      onCommit !== undefined
        ? hasPreviewedChangeRef.current || nextValue !== compareValue
        : nextValue !== compareValue;
    hasPreviewedChangeRef.current = false;
    if (shouldCommit) (onCommit ?? onChange)?.(nextValue);
  };

  const preview = (rawValue: string) => {
    setDraftValue(rawValue);
    if (disabled) return;
    const parsedValue = rawValue.trim() === '' ? Number.NaN : Number(rawValue);
    if (!Number.isFinite(parsedValue)) return;
    const nextValue = clampNumber(parsedValue, min, max);
    if (nextValue === value) return;
    hasPreviewedChangeRef.current = true;
    cancelAutoCommit();
    lastEmittedPreviewValueRef.current = nextValue;
    pendingAutoCommitValueRef.current = nextValue;
    (onPreview ?? onChange)?.(nextValue);
    autoCommitTimerRef.current = setTimeout(() => {
      autoCommitTimerRef.current = null;
      const pending = pendingAutoCommitValueRef.current;
      pendingAutoCommitValueRef.current = null;
      if (pending === null || disabledRef.current) return;
      const compareValue = committedValue ?? value;
      const shouldCommit =
        onCommit !== undefined
          ? hasPreviewedChangeRef.current || pending !== compareValue
          : pending !== compareValue;
      hasPreviewedChangeRef.current = false;
      if (shouldCommit) (onCommit ?? onChange)?.(pending);
    }, PREVIEW_AUTO_COMMIT_DEBOUNCE_MS);
  };

  return (
    <label
      data-testid={`${testId}-control`}
      data-number-control-label={label}
      className="relative block h-6 min-w-0 rounded-[3px] border border-border/70 bg-bg px-1 shadow-inner shadow-black/[0.02] focus-within:border-accent/70"
      title={label}
    >
      <span className="pointer-events-none absolute left-1 top-0 truncate text-[7px] uppercase leading-3 tracking-wide text-fg-muted">
        {label}
      </span>
      <input
        data-testid={testId}
        type="number"
        min={min}
        max={max}
        value={draftValue}
        disabled={disabled}
        onChange={(event) => preview(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            cancelAutoCommit();
            setDraftValue(String(value));
            hasPreviewedChangeRef.current = false;
            onCancel?.();
          }
        }}
        className="h-full w-full min-w-0 border-0 bg-transparent px-0 pt-2 text-center font-mono text-[11px] font-medium leading-4 normal-case tracking-normal text-fg outline-none disabled:text-fg-muted"
      />
    </label>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
