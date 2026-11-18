import { useEffect, useId, useRef, useState } from 'react';

import { safeFocus } from '../../../shared/utils/safeFocus';
import type { LaneLimit } from './indexed-genome-legacy-adapter';
import type { TranscriptDisplayMode } from './isoform-collapse';

const MAX_EXACT_ANNOTATION_LANE_LIMIT = 64;

interface ReferenceTrackControlsProps {
  laneLimit: LaneLimit;
  onChangeLaneLimit: (next: LaneLimit) => void;
  maxSupportedFiniteLaneLimit?: number;
  transcriptDisplayMode: TranscriptDisplayMode;
  onToggleTranscriptDisplayMode: () => void;
  expandedGeneCount: number;
  annotationPreparationState?: 'idle' | 'preparing' | 'error';
}

export function ReferenceTrackControls({
  laneLimit,
  onChangeLaneLimit,
  maxSupportedFiniteLaneLimit,
  transcriptDisplayMode,
  onToggleTranscriptDisplayMode,
  expandedGeneCount,
  annotationPreparationState = 'idle',
}: ReferenceTrackControlsProps) {
  const finiteLaneCapability =
    maxSupportedFiniteLaneLimit !== undefined &&
    Number.isSafeInteger(maxSupportedFiniteLaneLimit) &&
    maxSupportedFiniteLaneLimit > 0
      ? Math.min(maxSupportedFiniteLaneLimit, MAX_EXACT_ANNOTATION_LANE_LIMIT)
      : undefined;
  const displayedLaneLimit =
    finiteLaneCapability !== undefined && (laneLimit === null || laneLimit > finiteLaneCapability)
      ? finiteLaneCapability
      : laneLimit;
  const preparing = annotationPreparationState === 'preparing';
  const laneErrorId = useId();
  const committedLaneText = displayedLaneLimit === null ? 'All' : String(displayedLaneLimit);
  const [laneDraft, setLaneDraft] = useState(committedLaneText);
  const laneInputRef = useRef<HTMLInputElement>(null);
  const cancelBlurCommitRef = useRef(false);
  useEffect(() => setLaneDraft(committedLaneText), [committedLaneText]);
  useEffect(() => {
    if (annotationPreparationState === 'error') setLaneDraft(committedLaneText);
  }, [annotationPreparationState, committedLaneText]);
  const parsedLaneDraft = parseLaneLimitDraft(laneDraft, finiteLaneCapability);
  const laneDraftInvalid = !parsedLaneDraft.valid;
  const maxFiniteLaneLimit = finiteLaneCapability ?? MAX_EXACT_ANNOTATION_LANE_LIMIT;
  const spinValue = parsedLaneDraft.valid ? parsedLaneDraft.value : displayedLaneLimit;
  const canIncreaseLaneLimit =
    !parsedLaneDraft.valid ||
    (spinValue !== null && (spinValue < maxFiniteLaneLimit || finiteLaneCapability === undefined));
  const canDecreaseLaneLimit = !parsedLaneDraft.valid || spinValue === null || spinValue > 1;

  const commitLaneDraft = (draft = laneDraft) => {
    const parsed = parseLaneLimitDraft(draft, finiteLaneCapability);
    if (!parsed.valid) {
      setLaneDraft(committedLaneText);
      return;
    }
    const canonical = parsed.value === null ? 'All' : String(parsed.value);
    setLaneDraft(canonical);
    if (parsed.value !== displayedLaneLimit) onChangeLaneLimit(parsed.value);
  };

  const stepLaneLimit = (direction: -1 | 1) => {
    if (preparing) return;
    const parsed = parseLaneLimitDraft(laneDraft, finiteLaneCapability);
    const current = parsed.valid ? parsed.value : displayedLaneLimit;
    let next: LaneLimit;
    if (current === null) {
      next = direction < 0 ? maxFiniteLaneLimit : null;
    } else if (direction > 0) {
      next =
        current >= maxFiniteLaneLimit
          ? finiteLaneCapability === undefined
            ? null
            : maxFiniteLaneLimit
          : current + 1;
    } else {
      next = Math.max(1, current - 1);
    }
    if (next === current) {
      if (!parsed.valid) setLaneDraft(current === null ? 'All' : String(current));
      safeFocus(laneInputRef.current);
      return;
    }
    setLaneDraft(next === null ? 'All' : String(next));
    onChangeLaneLimit(next);
    safeFocus(laneInputRef.current);
  };

  return (
    <div
      data-testid="reference-track-controls"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-fg-muted"
    >
      <button
        type="button"
        onClick={onToggleTranscriptDisplayMode}
        disabled={preparing}
        aria-busy={preparing}
        className={`rounded border px-1.5 py-0.5 font-semibold transition-colors ${
          transcriptDisplayMode === 'expanded'
            ? 'border-emerald-600 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border bg-bg text-fg-muted hover:border-emerald-400'
        }`}
        title={
          transcriptDisplayMode === 'expanded'
            ? 'Showing all isoforms. Click to show only the primary isoform.'
            : `Showing primary isoforms.${
                expandedGeneCount > 0 ? ` ${expandedGeneCount} gene(s) expanded.` : ''
              } Click to show all isoforms.`
        }
      >
        {transcriptDisplayMode === 'expanded' ? '✓ All isoforms' : 'Primary only'}
      </button>
      <div className="inline-flex items-center gap-1">
        <span className="font-medium">Lanes</span>
        <div
          data-testid="lane-limit-spinbox"
          className="relative flex h-6 w-14 overflow-hidden rounded-md border border-border bg-bg transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30"
        >
          <input
            ref={laneInputRef}
            type="text"
            inputMode="numeric"
            role="spinbutton"
            aria-label="Max lanes"
            aria-valuemin={1}
            aria-valuemax={
              finiteLaneCapability === undefined ? maxFiniteLaneLimit + 1 : maxFiniteLaneLimit
            }
            aria-valuenow={spinValue === null ? maxFiniteLaneLimit + 1 : spinValue}
            aria-valuetext={spinValue === null ? 'All lanes' : `${spinValue} lanes`}
            aria-invalid={laneDraftInvalid}
            aria-describedby={laneDraftInvalid ? laneErrorId : undefined}
            value={laneDraft}
            disabled={preparing}
            onChange={(event) => setLaneDraft(event.target.value)}
            onBlur={() => {
              if (cancelBlurCommitRef.current) {
                cancelBlurCommitRef.current = false;
              } else {
                commitLaneDraft();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitLaneDraft();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelBlurCommitRef.current = true;
                setLaneDraft(committedLaneText);
                event.currentTarget.blur();
              } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                stepLaneLimit(event.key === 'ArrowUp' ? 1 : -1);
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent pl-1.5 pr-0.5 text-[10px] tabular-nums text-fg outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex w-4 shrink-0 flex-col border-l border-border/80">
            <button
              type="button"
              aria-label="Increase max lanes"
              disabled={preparing || !canIncreaseLaneLimit}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepLaneLimit(1)}
              className="flex min-h-0 flex-1 items-center justify-center text-fg-muted wp-interactive disabled:opacity-40"
            >
              <svg viewBox="0 0 8 5" className="h-1.5 w-2" aria-hidden>
                <path d="M1 4 4 1l3 3" fill="none" stroke="currentColor" strokeWidth="1.25" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Decrease max lanes"
              disabled={preparing || !canDecreaseLaneLimit}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepLaneLimit(-1)}
              className="flex min-h-0 flex-1 items-center justify-center border-t border-border/80 text-fg-muted wp-interactive disabled:opacity-40"
            >
              <svg viewBox="0 0 8 5" className="h-1.5 w-2" aria-hidden>
                <path d="m1 1 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.25" />
              </svg>
            </button>
          </div>
        </div>
        {laneDraftInvalid ? (
          <span id={laneErrorId} className="sr-only">
            Enter {finiteLaneCapability === undefined ? 'All or ' : ''}a lane count from 1 to
            {` ${finiteLaneCapability ?? MAX_EXACT_ANNOTATION_LANE_LIMIT}`}.
          </span>
        ) : null}
      </div>
      {annotationPreparationState !== 'idle' ? (
        <span
          data-testid="annotation-policy-preparation-state"
          role="status"
          aria-live="polite"
          title={
            annotationPreparationState === 'error'
              ? 'The previous annotation settings are still displayed.'
              : undefined
          }
          className={annotationPreparationState === 'error' ? 'text-red-500' : 'text-fg-muted'}
        >
          {annotationPreparationState === 'error'
            ? 'Couldn’t apply annotation settings'
            : 'Applying annotation settings…'}
        </span>
      ) : null}
    </div>
  );
}

function parseLaneLimitDraft(
  value: string,
  finiteLaneCapability?: number
): { valid: true; value: LaneLimit } | { valid: false } {
  const trimmed = value.trim();
  if (finiteLaneCapability === undefined && trimmed.toLowerCase() === 'all') {
    return { valid: true, value: null };
  }
  if (!/^[1-9]\d*$/.test(trimmed)) return { valid: false };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return { valid: false };
  if (parsed > (finiteLaneCapability ?? MAX_EXACT_ANNOTATION_LANE_LIMIT)) {
    return { valid: false };
  }
  return { valid: true, value: parsed };
}
