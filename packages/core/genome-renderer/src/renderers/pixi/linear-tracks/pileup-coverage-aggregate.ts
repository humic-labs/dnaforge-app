import { sampleBinnedDepthColumn } from './pileup-coverage-resample';

const COVERAGE_CONTRAST_MIN_VISIBLE_DEPTHS = 8;
const COVERAGE_CONTRAST_MIN_DEPTH_CV = 0.025;
const COVERAGE_CONTRAST_STDDEV_MULTIPLIER = 2;
const COVERAGE_CONTRAST_MIN_FILL_FRACTION = 0.52;
const TILE_ENGINE_COVERAGE_CONTRAST_MIN_FILL_FRACTION = 0.22;
const TILE_ENGINE_COVERAGE_SOFT_CONTRAST_CENTER = 0.35;
const TILE_ENGINE_COVERAGE_SOFT_CONTRAST_GAIN = 0.6;
const TILE_ENGINE_COVERAGE_SOFT_CONTRAST_KNEE = 2;

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

export function coverageHeightFieldKey(
  field: { startBp: number; endBp: number; bins: { length: number } } | null | undefined
): string {
  if (!field) return 'none';
  return `${Math.round(field.startBp)}:${Math.round(field.endBp)}:${field.bins.length}`;
}

export function coverageExactFieldKey(
  allowExactFieldOverride: boolean,
  field:
    | {
        startBp: number;
        endBp: number;
        binSizeBp: number;
        exactDepthRows: { length: number };
        maxExactDepthRows: number;
      }
    | null
    | undefined
): string {
  if (!allowExactFieldOverride || !field) return 'none';
  return `${Math.round(field.startBp)}:${Math.round(field.endBp)}:${field.binSizeBp}:${field.exactDepthRows.length}:${field.maxExactDepthRows}`;
}

export function coverageAggregateMeshKey(parts: {
  resident: boolean;
  viewStartCol: number;
  viewEndCol: number;
  columnCount: number;
  densityHeightPx: number;
  morphBucket: number;
  heightFieldKey: string;
  fieldKey: string;
  color: number;
  coverageScaleMode: string;
  coverageStatistic: string;
  cutoffKey: number;
  pctKey: string;
  forcedPresentationBinSize: number | null;
}): string {
  return `${parts.resident ? 'resident' : 'camera'}:${parts.viewStartCol}:${parts.viewEndCol}:${parts.columnCount}:${Math.round(parts.densityHeightPx)}:${parts.morphBucket}:${parts.heightFieldKey}:${parts.fieldKey}:${parts.color}:${parts.coverageScaleMode}:${parts.coverageStatistic}:${parts.cutoffKey}:${parts.pctKey}:fault-bin-${parts.forcedPresentationBinSize ?? 'none'}`;
}

export function isResidentCoverageGeometry(args: {
  tileEngineAuthority: boolean;
  exact: boolean | undefined;
  cameraStart: number;
  cameraEnd: number;
  coverageStart: number;
  coverageEnd: number;
  binSize: number;
  viewportWidthPx: number;
  cameraSpan: number;
  binCount: number;
  maxResidentColumns: number;
}): boolean {
  return (
    args.tileEngineAuthority &&
    args.exact === true &&
    args.cameraStart >= args.coverageStart - 1 &&
    args.cameraEnd <= args.coverageEnd + 1 &&
    (args.binSize * Math.max(1, args.viewportWidthPx)) / args.cameraSpan <= 1.001 &&
    args.binCount <= args.maxResidentColumns
  );
}

export function forcedCoveragePresentationBinSize(
  isDev: boolean,
  forcedCoverageLevel: unknown
): number | null {
  return isDev && typeof forcedCoverageLevel === 'number' && Number.isFinite(forcedCoverageLevel)
    ? 2 ** Math.max(0, Math.min(52, Math.floor(forcedCoverageLevel)))
    : null;
}

export function shouldUseExactFieldBase(
  allowExactFieldOverride: boolean,
  field: { binSizeBp: number } | null | undefined,
  fieldDepths: ArrayLike<number> | null | undefined,
  coverageBinSize: number
): boolean {
  return (
    allowExactFieldOverride &&
    field != null &&
    fieldDepths != null &&
    field.binSizeBp > 0 &&
    field.binSizeBp <= coverageBinSize
  );
}

export function sampleCoverageAggregateColumnDepths(args: {
  columnCount: number;
  viewStart: number;
  columnBp: number;
  forcedPresentationBinSize: number | null;
  useFieldBase: boolean;
  fieldDepths: ArrayLike<number> | null;
  field: { startBp: number; endBp: number; binSizeBp: number } | null;
  coverageBins: ArrayLike<number>;
  coverageBinSize: number;
  coverageStartBp: number;
  useMean: boolean;
  sampledDepths: Float32Array;
}): {
  depthVisible: number;
  depthSum: number;
  depthSumSq: number;
  sampledMaxDepth: number;
} {
  let depthVisible = 0;
  let depthSum = 0;
  let depthSumSq = 0;
  let sampledMaxDepth = 0;
  for (let c = 0; c < args.columnCount; c++) {
    const colStartBp = args.viewStart + c * args.columnBp;
    const colEndBp = colStartBp + args.columnBp;
    const sampleStartBp =
      args.forcedPresentationBinSize == null
        ? colStartBp
        : Math.floor(colStartBp / args.forcedPresentationBinSize) * args.forcedPresentationBinSize;
    const sampleEndBp =
      args.forcedPresentationBinSize == null
        ? colEndBp
        : sampleStartBp + args.forcedPresentationBinSize;
    let d = 0;
    if (
      args.useFieldBase &&
      args.field != null &&
      args.fieldDepths != null &&
      colStartBp >= args.field.startBp &&
      colEndBp <= args.field.endBp
    ) {
      d = sampleBinnedDepthColumn(
        args.fieldDepths,
        args.field.binSizeBp,
        args.field.startBp,
        sampleStartBp,
        sampleEndBp,
        args.useMean
      );
    } else {
      d = sampleBinnedDepthColumn(
        args.coverageBins,
        args.coverageBinSize,
        args.coverageStartBp,
        sampleStartBp,
        sampleEndBp,
        args.useMean
      );
    }
    args.sampledDepths[c] = d;
    if (d > sampledMaxDepth) sampledMaxDepth = d;
    if (d > 0) {
      depthVisible++;
      depthSum += d;
      depthSumSq += d * d;
    }
  }
  return { depthVisible, depthSum, depthSumSq, sampledMaxDepth };
}

export type CoverageContrastPolicy = {
  useVisibleDepthContrast: boolean;
  useTileEngineSoftContrast: boolean;
  contrastMinFill: number;
  collapsedMaxFill: number;
  gaussianContrastLow: number;
  gaussianContrastHigh: number;
  tileEngineSoftContrastScale: number;
  tileEngineSoftContrastDenominator: number;
  sourceP50: number;
};

export function resolveCoverageContrastPolicy(args: {
  tileEngineAuthority: boolean;
  depthVisible: number;
  depthCv: number;
  depthMean: number;
  depthStdDev: number;
  collapsedMaxFill: number;
  minFillFraction: number;
  sourceP10: number;
  sourceP50: number;
  sourceP90: number;
}): CoverageContrastPolicy {
  const gaussianContrastLow = Math.max(
    0,
    args.depthMean - COVERAGE_CONTRAST_STDDEV_MULTIPLIER * args.depthStdDev
  );
  const gaussianContrastHigh =
    args.depthMean + COVERAGE_CONTRAST_STDDEV_MULTIPLIER * args.depthStdDev;
  const tileEngineSoftContrastSpan = args.sourceP90 - args.sourceP10;
  const useTileEngineSoftContrast =
    args.tileEngineAuthority &&
    args.depthVisible >= COVERAGE_CONTRAST_MIN_VISIBLE_DEPTHS &&
    tileEngineSoftContrastSpan >= Math.max(2, args.depthMean * 0.02);
  const tileEngineSoftContrastDenominator = Math.asinh(TILE_ENGINE_COVERAGE_SOFT_CONTRAST_KNEE);
  const tileEngineSoftContrastScale = Math.max(
    tileEngineSoftContrastSpan,
    args.sourceP50 * 0.04,
    2
  );
  const useVisibleDepthContrast =
    args.depthVisible >= COVERAGE_CONTRAST_MIN_VISIBLE_DEPTHS &&
    args.depthCv >= COVERAGE_CONTRAST_MIN_DEPTH_CV &&
    (useTileEngineSoftContrast || gaussianContrastHigh > gaussianContrastLow) &&
    args.collapsedMaxFill > 0;
  const contrastMinFill = Math.min(
    args.collapsedMaxFill,
    Math.max(
      args.minFillFraction,
      args.collapsedMaxFill *
        (args.tileEngineAuthority
          ? TILE_ENGINE_COVERAGE_CONTRAST_MIN_FILL_FRACTION
          : COVERAGE_CONTRAST_MIN_FILL_FRACTION)
    )
  );
  return {
    useVisibleDepthContrast,
    useTileEngineSoftContrast,
    contrastMinFill,
    collapsedMaxFill: args.collapsedMaxFill,
    gaussianContrastLow,
    gaussianContrastHigh,
    tileEngineSoftContrastScale,
    tileEngineSoftContrastDenominator,
    sourceP50: args.sourceP50,
  };
}

export function coverageDepthFillFraction(
  d: number,
  policy: CoverageContrastPolicy,
  coverageScale: string,
  depthDenominator: number,
  minFillFraction: number
): number {
  if (d <= 0) return 0;
  if (policy.useVisibleDepthContrast) {
    const normalizedDepth = policy.useTileEngineSoftContrast
      ? clamp01(
          TILE_ENGINE_COVERAGE_SOFT_CONTRAST_CENTER +
            (TILE_ENGINE_COVERAGE_SOFT_CONTRAST_GAIN *
              Math.asinh((d - policy.sourceP50) / policy.tileEngineSoftContrastScale)) /
              policy.tileEngineSoftContrastDenominator
        )
      : clamp01(
          (d - policy.gaussianContrastLow) /
            (policy.gaussianContrastHigh - policy.gaussianContrastLow)
        );
    return (
      policy.contrastMinFill +
      normalizedDepth * Math.max(0, policy.collapsedMaxFill - policy.contrastMinFill)
    );
  }
  const normalizedDepth =
    coverageScale === 'log' ? Math.log1p(d) / depthDenominator : d / depthDenominator;
  return Math.max(
    minFillFraction,
    Math.min(policy.collapsedMaxFill, Math.max(0, normalizedDepth * policy.collapsedMaxFill))
  );
}

export function fillCoverageSegmentHeights(args: {
  columnCount: number;
  sampledDepths: ArrayLike<number>;
  cutoffDepth: number;
  globalPct: { max: number } | null;
  fillCutoff: (d: number) => number;
  fillFromGlobalPercentiles: (d: number) => number;
  fillFromContrast: (d: number) => number;
  rowStackHeights: ArrayLike<number> | null;
  visibleRowCapacity: number;
  morph: number;
  maxRowStackFillFraction: number;
  densityHeightPx: number;
  segmentHeights: Float32Array;
}): { rowStackVisible: number; rowStackFillSum: number; rowStackMaxFill: number } {
  let rowStackVisible = 0;
  let rowStackFillSum = 0;
  let rowStackMaxFill = 0;
  for (let c = 0; c < args.columnCount; c++) {
    const d = args.sampledDepths[c] ?? 0;
    let coverageFill = 0;
    if (d > 0) {
      if (args.cutoffDepth > 0) {
        coverageFill = args.fillCutoff(d);
      } else if (args.globalPct) {
        coverageFill = args.fillFromGlobalPercentiles(d);
      } else {
        coverageFill = args.fillFromContrast(d);
      }
    }
    let rowStackFill = 0;
    if (args.rowStackHeights) {
      rowStackFill = Math.max(
        0,
        Math.min(
          args.maxRowStackFillFraction,
          (args.rowStackHeights[c] ?? 0) / args.visibleRowCapacity
        )
      );
      if (rowStackFill > 0) {
        rowStackVisible++;
        rowStackFillSum += rowStackFill;
        if (rowStackFill > rowStackMaxFill) rowStackMaxFill = rowStackFill;
      }
    }
    const exactCappedCoverageFill =
      args.rowStackHeights && rowStackFill > 0
        ? Math.min(coverageFill, rowStackFill)
        : coverageFill;
    const fill = args.rowStackHeights
      ? exactCappedCoverageFill + (rowStackFill - exactCappedCoverageFill) * args.morph
      : coverageFill;
    args.segmentHeights[c] = fill * args.densityHeightPx;
  }
  return { rowStackVisible, rowStackFillSum, rowStackMaxFill };
}

export function fillExperimentalHybridPileupSegmentHeights(args: {
  columnCount: number;
  sampledDepths: ArrayLike<number>;
  packedSourceRows: ArrayLike<number> | null;
  exactColumnMask: ArrayLike<number> | null;
  effectiveMaxRows: number;
  rowPitchPx: number;
  morph: number;
  segmentHeights: Float32Array;
}): { packedVisible: number; packedFillSum: number; packedMaxFill: number } {
  const maxRows = Math.max(0, args.effectiveMaxRows);
  const rowPitchPx = Math.max(0, args.rowPitchPx);
  const morph = clamp01(args.morph);
  const fullHeightPx = maxRows * rowPitchPx;
  let packedVisible = 0;
  let packedFillSum = 0;
  let packedMaxFill = 0;

  for (let column = 0; column < args.columnCount; column += 1) {
    const bigWigRows = Math.min(maxRows, Math.max(0, args.sampledDepths[column] ?? 0));
    const exactAvailable =
      args.packedSourceRows !== null &&
      (args.exactColumnMask === null || (args.exactColumnMask[column] ?? 0) > 0);
    const packedRows = exactAvailable
      ? Math.min(maxRows, Math.max(0, args.packedSourceRows![column] ?? 0))
      : bigWigRows;
    const bigWigHeightPx = bigWigRows > 0 ? Math.max(0, bigWigRows * rowPitchPx - 1) : 0;
    const packedHeightPx = packedRows > 0 ? Math.max(0, packedRows * rowPitchPx - 1) : 0;
    args.segmentHeights[column] = bigWigHeightPx + (packedHeightPx - bigWigHeightPx) * morph;

    if (packedHeightPx > 0) {
      const packedFill = fullHeightPx > 0 ? packedHeightPx / fullHeightPx : 0;
      packedVisible += 1;
      packedFillSum += packedFill;
      if (packedFill > packedMaxFill) packedMaxFill = packedFill;
    }
  }

  return { packedVisible, packedFillSum, packedMaxFill };
}

export function fillExperimentalHybridOverflowCounts(args: {
  columnCount: number;
  sampledDepths: ArrayLike<number>;
  exactHiddenCounts: ArrayLike<number> | null;
  exactColumnMask: ArrayLike<number> | null;
  effectiveMaxRows: number;
  morph: number;
  hiddenCounts: Float32Array;
}): number {
  const maxRows = Math.max(0, args.effectiveMaxRows);
  const morph = clamp01(args.morph);
  let maxHiddenCount = 0;
  for (let column = 0; column < args.columnCount; column += 1) {
    const bigWigHidden = Math.max(0, (args.sampledDepths[column] ?? 0) - maxRows);
    const exactAvailable =
      args.exactHiddenCounts !== null &&
      (args.exactColumnMask === null || (args.exactColumnMask[column] ?? 0) > 0);
    const exactHidden = exactAvailable
      ? Math.max(0, args.exactHiddenCounts![column] ?? 0)
      : bigWigHidden;
    const hidden = bigWigHidden + (exactHidden - bigWigHidden) * morph;
    args.hiddenCounts[column] = hidden;
    if (hidden > maxHiddenCount) maxHiddenCount = hidden;
  }
  return maxHiddenCount;
}
