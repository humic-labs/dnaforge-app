import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';

export const COVERAGE_CUTOFF_SLIDER_MAX = 1_000;

export interface CoverageDepthScale {
  min: number;
  auto: number;
  max: number;
}

interface CoverageDepthDiagnostics {
  coverageDepthP99?: unknown;
  coverageDepthMax?: unknown;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function coverageDepthScaleFromDiagnostics(
  diagnostics: CoverageDepthDiagnostics | null | undefined
): CoverageDepthScale | null {
  const auto = positiveFinite(diagnostics?.coverageDepthP99);
  const max = positiveFinite(diagnostics?.coverageDepthMax);
  if (auto === null || max === null) return null;
  return {
    min: 1,
    auto: Math.max(1, Math.round(auto)),
    max: Math.max(1, Math.round(auto), Math.round(max)),
  };
}

export function coverageDepthToSliderPosition(depth: number, scale: CoverageDepthScale): number {
  if (scale.max <= scale.min) return 0;
  const clamped = Math.max(scale.min, Math.min(scale.max, depth));
  const ratio =
    (Math.log(clamped) - Math.log(scale.min)) / (Math.log(scale.max) - Math.log(scale.min));
  return Math.round(ratio * COVERAGE_CUTOFF_SLIDER_MAX);
}

export function coverageSliderPositionToDepth(position: number, scale: CoverageDepthScale): number {
  if (scale.max <= scale.min) return Math.round(scale.min);
  const ratio =
    Math.max(0, Math.min(COVERAGE_CUTOFF_SLIDER_MAX, position)) / COVERAGE_CUTOFF_SLIDER_MAX;
  return Math.max(
    1,
    Math.round(Math.exp(Math.log(scale.min) + ratio * (Math.log(scale.max) - Math.log(scale.min))))
  );
}

interface CoverageCutoffControlProps {
  trackId: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  webglRef?: RefObject<IndexedGenomeTileNativeMapHandle | null>;
}

export function CoverageCutoffControl({
  trackId,
  label,
  value,
  onChange,
  webglRef,
}: CoverageCutoffControlProps) {
  const [sourceScale, setSourceScale] = useState<CoverageDepthScale | null>(null);

  useEffect(() => {
    if (!webglRef) return;
    let active = true;
    const readScale = () => {
      const diagnostics = webglRef.current
        ?.getLinearRenderer?.()
        ?.getTrackDiagnostics?.(trackId) as CoverageDepthDiagnostics | null | undefined;
      const next = coverageDepthScaleFromDiagnostics(diagnostics);
      if (!active || !next) return;
      setSourceScale((previous) =>
        previous?.min === next.min && previous.auto === next.auto && previous.max === next.max
          ? previous
          : next
      );
    };
    readScale();
    const interval = window.setInterval(readScale, 250);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [trackId, webglRef]);

  const manualDepth = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const scale = useMemo<CoverageDepthScale>(
    () =>
      sourceScale
        ? { ...sourceScale, max: Math.max(sourceScale.max, manualDepth) }
        : {
            min: 1,
            auto: Math.min(100, Math.max(1, manualDepth || 100)),
            max: Math.max(500, manualDepth),
          },
    [manualDepth, sourceScale]
  );
  const effectiveDepth = manualDepth || scale.auto;
  const [depthDraft, setDepthDraft] = useState(String(effectiveDepth));
  const cancelBlurCommit = useRef(false);
  useEffect(() => setDepthDraft(String(effectiveDepth)), [effectiveDepth]);
  const commitDepth = () => {
    if (cancelBlurCommit.current) {
      cancelBlurCommit.current = false;
      return;
    }
    const depth = Number(depthDraft);
    if (depthDraft.trim() && Number.isSafeInteger(depth) && depth >= 1 && depth <= 1_000_000_000) {
      if (depth !== manualDepth) onChange(depth);
    } else {
      setDepthDraft(String(effectiveDepth));
    }
  };
  const sliderPosition = coverageDepthToSliderPosition(effectiveDepth, scale);
  const scaleTitle = `Histogram height scale: 1× to ${scale.max.toLocaleString()}× (logarithmic). Automatic uses the source-wide p99 depth, ${scale.auto.toLocaleString()}×.`;

  return (
    <div
      className="flex min-w-0 items-center gap-1 text-[10px] text-fg-muted"
      title={scaleTitle}
      data-scale-source={sourceScale ? 'source-percentiles' : 'fallback'}
      data-scale-min={scale.min}
      data-scale-auto={scale.auto}
      data-scale-max={scale.max}
    >
      <span className="shrink-0 font-medium">Cutoff</span>
      <input
        type="range"
        min={0}
        max={COVERAGE_CUTOFF_SLIDER_MAX}
        step={1}
        value={sliderPosition}
        onChange={(event) =>
          onChange(coverageSliderPositionToDepth(Number(event.target.value), scale))
        }
        aria-label={`Coverage cutoff for ${label}`}
        aria-valuetext={`${manualDepth ? 'Manual' : 'Automatic'} cutoff ${effectiveDepth.toLocaleString()}×; range ${scale.min.toLocaleString()}× to ${scale.max.toLocaleString()}×`}
        data-testid={`coverage-cutoff-range-${trackId}`}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-emerald-600"
      />
      <input
        type="number"
        min={1}
        max={1_000_000_000}
        step={1}
        aria-label={`Exact coverage cutoff for ${label}`}
        value={depthDraft}
        onChange={(event) => setDepthDraft(event.target.value)}
        onBlur={commitDepth}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.stopPropagation();
            cancelBlurCommit.current = true;
            setDepthDraft(String(effectiveDepth));
            event.currentTarget.blur();
          }
        }}
        className="w-14 shrink-0 rounded border border-border bg-bg px-1 text-right tabular-nums"
        title="Coverage depth in reads per base. Enter the same cutoff on tracks you want to compare."
      />
      <span aria-hidden>×</span>
      <button
        type="button"
        onClick={() => onChange(0)}
        aria-label={`Use automatic coverage cutoff for ${label}`}
        aria-pressed={manualDepth === 0}
        className={`shrink-0 rounded px-1 py-0.5 font-medium ${
          manualDepth === 0
            ? 'bg-emerald-600 text-white'
            : 'border border-border text-fg-muted wp-interactive'
        }`}
      >
        Auto
      </button>
    </div>
  );
}
