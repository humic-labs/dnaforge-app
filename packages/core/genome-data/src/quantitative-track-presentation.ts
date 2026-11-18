import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';

export const QUANTITATIVE_SOURCE_SUMMARY_V1 = 'dnaforge.quantitative-source-summary.v1' as const;

export const QUANTITATIVE_SOURCE_SUMMARY_ALGORITHM_V1 =
  'equal-genomic-bin-means-r7-quantiles-v1' as const;

export type QuantitativeScaleMode = 'robust-global' | 'full-global' | 'visible-window' | 'fixed';

export type QuantitativeScaleTransform = 'linear' | 'log1p';

export type QuantitativeGraph = 'bar' | 'band' | 'points';

export type QuantitativeColorPalette = keyof typeof SCIENTIFIC_COLOR_PALETTES;

export const QUANTITATIVE_COLOR_PALETTE_IDS = Object.keys(SCIENTIFIC_COLOR_PALETTES) as [
  QuantitativeColorPalette,
  ...QuantitativeColorPalette[],
];

export type QuantitativeSmoothing = 'none' | 'gaussian-subtle';

export const MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS = 10;

export const DEFAULT_QUANTITATIVE_SMOOTHING_SIGMA_BINS = 1;

export const QUANTITATIVE_SMOOTHING_SIGMA_STEP_BINS = 0.5;

export const LEGACY_SUBTLE_GAUSSIAN_SIGMA_BINS = 0.6;

export interface QuantitativeSourceSummaryV1 {
  readonly contract: typeof QUANTITATIVE_SOURCE_SUMMARY_V1;
  readonly algorithm: typeof QUANTITATIVE_SOURCE_SUMMARY_ALGORITHM_V1;
  readonly targetSampleCount: number;
  readonly sampleCount: number;
  readonly lowerQuantile: number;
  readonly upperQuantile: number;
  readonly robustMin: number;
  readonly robustMax: number;
  readonly fullMin: number;
  readonly fullMax: number;
  readonly missingData: 'excluded';
}

export interface QuantitativeTrackPresentationV1 {
  readonly version: 1;
  readonly graph: QuantitativeGraph;
  readonly palette?: QuantitativeColorPalette;
  readonly showRange: boolean;
  readonly smoothingSigmaBins?: number;
  readonly smoothing?: QuantitativeSmoothing;
  readonly scale: {
    readonly mode: QuantitativeScaleMode;
    readonly transform: QuantitativeScaleTransform;
    readonly min?: number;
    readonly max?: number;
    readonly groupId?: string;
  };
}

export const DEFAULT_QUANTITATIVE_TRACK_PRESENTATION: QuantitativeTrackPresentationV1 =
  Object.freeze({
    version: 1,
    graph: 'bar',
    showRange: true,
    smoothingSigmaBins: DEFAULT_QUANTITATIVE_SMOOTHING_SIGMA_BINS,
    scale: Object.freeze({
      mode: 'robust-global',
      transform: 'linear',
    }),
  });

export interface ResolvedQuantitativeDisplayRange {
  readonly rawMin: number;
  readonly rawMax: number;
  readonly displayMin: number;
  readonly displayMax: number;
  readonly mode: QuantitativeScaleMode;
  readonly transform: QuantitativeScaleTransform;
  readonly source: 'source-robust' | 'source-full' | 'visible' | 'visible-fallback' | 'fixed';
  readonly clippedLowCount: number;
  readonly clippedHighCount: number;
}

export interface QuantitativeValueCollection {
  forEach(visit: (value: number) => void): void;
}

export function buildQuantitativeSourceSummary(input: {
  readonly samples: ReadonlyArray<number>;
  readonly targetSampleCount: number;
  readonly fullMin?: number;
  readonly fullMax?: number;
  readonly lowerQuantile?: number;
  readonly upperQuantile?: number;
}): QuantitativeSourceSummaryV1 {
  const samples = input.samples.filter(Number.isFinite).sort((left, right) => left - right);
  if (samples.length === 0) {
    throw new Error('A quantitative source summary requires at least one finite signal bin.');
  }
  const targetSampleCount = requirePositiveInteger(input.targetSampleCount, 'target sample count');
  const lowerQuantile = input.lowerQuantile ?? 0.005;
  const upperQuantile = input.upperQuantile ?? 0.995;
  if (
    !Number.isFinite(lowerQuantile) ||
    !Number.isFinite(upperQuantile) ||
    lowerQuantile < 0 ||
    upperQuantile > 1 ||
    lowerQuantile >= upperQuantile
  ) {
    throw new Error('Quantitative summary quantiles must satisfy 0 <= lower < upper <= 1.');
  }
  const sampleMin = samples[0];
  const sampleMax = samples[samples.length - 1];
  const fullMin = finiteOr(input.fullMin, sampleMin);
  const fullMax = finiteOr(input.fullMax, sampleMax);
  if (fullMin > fullMax) throw new Error('Quantitative source minimum exceeds its maximum.');
  return {
    contract: QUANTITATIVE_SOURCE_SUMMARY_V1,
    algorithm: QUANTITATIVE_SOURCE_SUMMARY_ALGORITHM_V1,
    targetSampleCount,
    sampleCount: samples.length,
    lowerQuantile,
    upperQuantile,
    robustMin: r7Quantile(samples, lowerQuantile),
    robustMax: r7Quantile(samples, upperQuantile),
    fullMin,
    fullMax,
    missingData: 'excluded',
  };
}

export function isQuantitativeSourceSummaryV1(
  value: unknown
): value is QuantitativeSourceSummaryV1 {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<QuantitativeSourceSummaryV1>;
  return (
    summary.contract === QUANTITATIVE_SOURCE_SUMMARY_V1 &&
    summary.algorithm === QUANTITATIVE_SOURCE_SUMMARY_ALGORITHM_V1 &&
    isPositiveInteger(summary.targetSampleCount) &&
    isPositiveInteger(summary.sampleCount) &&
    isUnitNumber(summary.lowerQuantile) &&
    isUnitNumber(summary.upperQuantile) &&
    (summary.lowerQuantile ?? 1) < (summary.upperQuantile ?? 0) &&
    isFiniteNumber(summary.robustMin) &&
    isFiniteNumber(summary.robustMax) &&
    (summary.robustMin ?? 1) <= (summary.robustMax ?? 0) &&
    isFiniteNumber(summary.fullMin) &&
    isFiniteNumber(summary.fullMax) &&
    (summary.fullMin ?? 1) <= (summary.fullMax ?? 0) &&
    summary.missingData === 'excluded'
  );
}

export function normalizeQuantitativeTrackPresentation(
  value: QuantitativeTrackPresentationV1 | undefined
): QuantitativeTrackPresentationV1 {
  if (value === undefined) return DEFAULT_QUANTITATIVE_TRACK_PRESENTATION;
  if (
    value.version !== 1 ||
    !['bar', 'band', 'points'].includes(value.graph) ||
    typeof value.showRange !== 'boolean'
  ) {
    throw new Error('Invalid quantitative track presentation contract.');
  }
  if (value.palette !== undefined && !Object.hasOwn(SCIENTIFIC_COLOR_PALETTES, value.palette)) {
    throw new Error(`Unsupported quantitative color palette: ${String(value.palette)}.`);
  }
  const { mode, transform } = value.scale;
  const legacySmoothing = value.smoothing;
  if (
    legacySmoothing !== undefined &&
    legacySmoothing !== 'none' &&
    legacySmoothing !== 'gaussian-subtle'
  ) {
    throw new Error(`Unsupported quantitative smoothing mode: ${String(legacySmoothing)}.`);
  }
  if (value.smoothingSigmaBins !== undefined && legacySmoothing !== undefined) {
    throw new Error('Specify a quantitative smoothing sigma or the legacy mode, not both.');
  }
  const smoothingSigmaBins =
    value.smoothingSigmaBins ??
    (legacySmoothing === undefined
      ? DEFAULT_QUANTITATIVE_SMOOTHING_SIGMA_BINS
      : legacySmoothing === 'gaussian-subtle'
        ? LEGACY_SUBTLE_GAUSSIAN_SIGMA_BINS
        : 0);
  if (
    !Number.isFinite(smoothingSigmaBins) ||
    smoothingSigmaBins < 0 ||
    smoothingSigmaBins > MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS
  ) {
    throw new Error(
      `Quantitative smoothing must be between 0 and ${MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS} source bins.`
    );
  }
  if (!['robust-global', 'full-global', 'visible-window', 'fixed'].includes(mode)) {
    throw new Error(`Unsupported quantitative scale mode: ${String(mode)}.`);
  }
  if (transform !== 'linear' && transform !== 'log1p') {
    throw new Error(`Unsupported quantitative scale transform: ${String(transform)}.`);
  }
  const groupId = value.scale.groupId?.trim();
  if (value.scale.groupId !== undefined && !groupId) {
    throw new Error('A quantitative scale group identity cannot be empty.');
  }
  if (mode === 'fixed') {
    const min = value.scale.min;
    const max = value.scale.max;
    if (!isFiniteNumber(min) || !isFiniteNumber(max) || min >= max) {
      throw new Error('A fixed quantitative scale requires a finite minimum below its maximum.');
    }
  }
  return {
    version: 1,
    graph: value.graph,
    ...(value.palette !== undefined ? { palette: value.palette } : {}),
    showRange: value.showRange,
    smoothingSigmaBins,
    scale: {
      mode,
      transform,
      ...(mode === 'fixed' ? { min: value.scale.min, max: value.scale.max } : {}),
      ...(groupId ? { groupId } : {}),
    },
  };
}

export function assertQuantitativeTransformCompatible(
  presentation: QuantitativeTrackPresentationV1,
  summary: QuantitativeSourceSummaryV1 | undefined,
  visibleValues: QuantitativeValueCollection = []
): void {
  if (presentation.scale.transform !== 'log1p') return;
  const observedMin = finiteExtrema(visibleValues)?.min;
  const knownMin = summary?.fullMin ?? observedMin;
  if (knownMin === undefined) {
    throw new Error('Log scaling requires a source summary or loaded nonnegative signal.');
  }
  if (knownMin < 0) {
    throw new Error('Log scaling is unavailable for a track containing negative signal values.');
  }
}

export function resolveQuantitativeDisplayRange(input: {
  readonly presentation?: QuantitativeTrackPresentationV1;
  readonly sourceSummary?: QuantitativeSourceSummaryV1;
  readonly visibleValues: QuantitativeValueCollection;
}): ResolvedQuantitativeDisplayRange {
  const presentation = normalizeQuantitativeTrackPresentation(input.presentation);
  const visible = finiteExtrema(input.visibleValues);
  let min: number;
  let max: number;
  let source: ResolvedQuantitativeDisplayRange['source'];
  switch (presentation.scale.mode) {
    case 'robust-global':
      if (input.sourceSummary) {
        min = input.sourceSummary.robustMin;
        max = input.sourceSummary.robustMax;
        source = 'source-robust';
      } else {
        ({ min, max } = visible ?? { min: 0, max: 1 });
        source = 'visible-fallback';
      }
      break;
    case 'full-global':
      if (input.sourceSummary) {
        min = input.sourceSummary.fullMin;
        max = input.sourceSummary.fullMax;
        source = 'source-full';
      } else {
        ({ min, max } = visible ?? { min: 0, max: 1 });
        source = 'visible-fallback';
      }
      break;
    case 'visible-window':
      ({ min, max } = visible ?? { min: 0, max: 1 });
      source = 'visible';
      break;
    case 'fixed':
      min = presentation.scale.min as number;
      max = presentation.scale.max as number;
      source = 'fixed';
      break;
  }
  min = Math.min(0, min);
  max = Math.max(0, max);
  if (max <= min) max = min + 1;
  assertQuantitativeTransformCompatible(presentation, input.sourceSummary, input.visibleValues);
  let clippedLowCount = 0;
  let clippedHighCount = 0;
  input.visibleValues.forEach((value) => {
    if (!Number.isFinite(value)) return;
    if (value < min) clippedLowCount += 1;
    if (value > max) clippedHighCount += 1;
  });
  const displayMin = transformValue(min, presentation.scale.transform);
  const displayMax = transformValue(max, presentation.scale.transform);
  return {
    rawMin: min,
    rawMax: max,
    displayMin,
    displayMax: displayMax > displayMin ? displayMax : displayMin + 1,
    mode: presentation.scale.mode,
    transform: presentation.scale.transform,
    source,
    clippedLowCount,
    clippedHighCount,
  };
}

export function transformQuantitativeValue(
  value: number,
  transform: QuantitativeScaleTransform
): number {
  return transformValue(value, transform);
}

function transformValue(value: number, transform: QuantitativeScaleTransform): number {
  if (transform === 'linear') return value;
  if (value < 0) throw new Error('Log scaling cannot transform negative quantitative signal.');
  return Math.log1p(value);
}

function r7Quantile(sorted: ReadonlyArray<number>, probability: number): number {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const fraction = index - lowerIndex;
  const lower = sorted[lowerIndex];
  const upper = sorted[Math.min(sorted.length - 1, lowerIndex + 1)];
  return lower + (upper - lower) * fraction;
}

function finiteExtrema(values: QuantitativeValueCollection): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  values.forEach((value) => {
    if (!Number.isFinite(value)) return;
    min = Math.min(min, value);
    max = Math.max(max, value);
  });
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!isPositiveInteger(value))
    throw new Error(`Quantitative ${label} must be a positive integer.`);
  return value;
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}
