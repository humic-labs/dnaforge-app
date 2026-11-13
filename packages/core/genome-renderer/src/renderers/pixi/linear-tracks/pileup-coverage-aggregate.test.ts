import { describe, expect, it } from 'vitest';
import {
  coverageDepthFillFraction,
  fillExperimentalHybridOverflowCounts,
  fillExperimentalHybridPileupSegmentHeights,
  fillCoverageSegmentHeights,
  forcedCoveragePresentationBinSize,
  isResidentCoverageGeometry,
  resolveCoverageContrastPolicy,
  sampleCoverageAggregateColumnDepths,
  shouldUseExactFieldBase,
} from './pileup-coverage-aggregate';

describe('isResidentCoverageGeometry', () => {
  it('requires exact tile-engine coverage that contains the camera at <=1px bins', () => {
    const base = {
      tileEngineAuthority: true,
      exact: true as boolean | undefined,
      cameraStart: 100,
      cameraEnd: 200,
      coverageStart: 100,
      coverageEnd: 200,
      binSize: 1,
      viewportWidthPx: 100,
      cameraSpan: 100,
      binCount: 100,
      maxResidentColumns: 32_768,
    };
    expect(isResidentCoverageGeometry(base)).toBe(true);
    expect(isResidentCoverageGeometry({ ...base, tileEngineAuthority: false })).toBe(false);
    expect(isResidentCoverageGeometry({ ...base, exact: false })).toBe(false);
    expect(isResidentCoverageGeometry({ ...base, cameraEnd: 400 })).toBe(false);
    expect(isResidentCoverageGeometry({ ...base, binSize: 64, viewportWidthPx: 800 })).toBe(false);
  });
});

describe('forcedCoveragePresentationBinSize / shouldUseExactFieldBase', () => {
  it('only materializes a coarse presentation bin in dev', () => {
    expect(forcedCoveragePresentationBinSize(false, 6)).toBeNull();
    expect(forcedCoveragePresentationBinSize(true, 6)).toBe(64);
    expect(forcedCoveragePresentationBinSize(true, '6')).toBeNull();
  });

  it('uses the exact field only when it is at least as fine as the coverage bins', () => {
    expect(shouldUseExactFieldBase(true, { binSizeBp: 1 }, [1], 4)).toBe(true);
    expect(shouldUseExactFieldBase(true, { binSizeBp: 8 }, [1], 4)).toBe(false);
    expect(shouldUseExactFieldBase(false, { binSizeBp: 1 }, [1], 4)).toBe(false);
  });
});

describe('sampleCoverageAggregateColumnDepths', () => {
  it('samples coverage bins and records nonzero depth stats', () => {
    const sampledDepths = new Float32Array(4);
    const stats = sampleCoverageAggregateColumnDepths({
      columnCount: 4,
      viewStart: 0,
      columnBp: 1,
      forcedPresentationBinSize: null,
      useFieldBase: false,
      fieldDepths: null,
      field: null,
      coverageBins: [0, 4, 6, 0],
      coverageBinSize: 1,
      coverageStartBp: 0,
      useMean: true,
      sampledDepths,
    });
    expect(Array.from(sampledDepths)).toEqual([0, 4, 6, 0]);
    expect(stats).toEqual({
      depthVisible: 2,
      depthSum: 10,
      depthSumSq: 52,
      sampledMaxDepth: 6,
    });
  });
});

describe('resolveCoverageContrastPolicy / fillCoverageSegmentHeights', () => {
  it('enables tile-engine soft contrast on a high-cv visible histogram', () => {
    const policy = resolveCoverageContrastPolicy({
      tileEngineAuthority: true,
      depthVisible: 20,
      depthCv: 0.4,
      depthMean: 10,
      depthStdDev: 4,
      collapsedMaxFill: 0.9,
      minFillFraction: 0.04,
      sourceP10: 2,
      sourceP50: 8,
      sourceP90: 20,
    });
    expect(policy.useTileEngineSoftContrast).toBe(true);
    expect(policy.useVisibleDepthContrast).toBe(true);
    expect(coverageDepthFillFraction(0, policy, 'linear', 10, 0.04)).toBe(0);
  });

  it('caps coverage fill by row-stack height while morphing', () => {
    const segmentHeights = new Float32Array(2);
    const result = fillCoverageSegmentHeights({
      columnCount: 2,
      sampledDepths: [10, 0],
      cutoffDepth: 0,
      globalPct: null,
      fillCutoff: () => 1,
      fillFromGlobalPercentiles: () => 1,
      fillFromContrast: () => 0.8,
      rowStackHeights: [2, 0],
      visibleRowCapacity: 10,
      morph: 0,
      maxRowStackFillFraction: 0.98,
      densityHeightPx: 100,
      segmentHeights,
    });
    expect(result.rowStackVisible).toBe(1);
    expect(segmentHeights[0]).toBeCloseTo(20);
    expect(segmentHeights[1]).toBe(0);
  });
});

describe('experimental BigWig to packed-read height morph', () => {
  it('starts at actual BigWig depth in row units and ends at the packing-aware row envelope', () => {
    const segmentHeights = new Float32Array(2);

    fillExperimentalHybridPileupSegmentHeights({
      columnCount: 2,
      sampledDepths: [2, 1],
      packedSourceRows: [2, 2],
      exactColumnMask: [1, 1],
      effectiveMaxRows: 4,
      rowPitchPx: 10,
      morph: 0,
      segmentHeights,
    });
    expect(Array.from(segmentHeights)).toEqual([19, 9]);

    fillExperimentalHybridPileupSegmentHeights({
      columnCount: 2,
      sampledDepths: [2, 1],
      packedSourceRows: [2, 2],
      exactColumnMask: [1, 1],
      effectiveMaxRows: 4,
      rowPitchPx: 10,
      morph: 0.5,
      segmentHeights,
    });
    expect(Array.from(segmentHeights)).toEqual([19, 14]);

    fillExperimentalHybridPileupSegmentHeights({
      columnCount: 2,
      sampledDepths: [2, 1],
      packedSourceRows: [2, 2],
      exactColumnMask: [1, 1],
      effectiveMaxRows: 4,
      rowPitchPx: 10,
      morph: 1,
      segmentHeights,
    });
    expect(Array.from(segmentHeights)).toEqual([19, 19]);
  });

  it('keeps columns outside the committed BAM field on the actual BigWig height', () => {
    const segmentHeights = new Float32Array(2);
    fillExperimentalHybridPileupSegmentHeights({
      columnCount: 2,
      sampledDepths: [3, 2],
      packedSourceRows: [1, 1],
      exactColumnMask: [1, 0],
      effectiveMaxRows: 4,
      rowPitchPx: 3,
      morph: 1,
      segmentHeights,
    });
    expect(Array.from(segmentHeights)).toEqual([2, 5]);
  });

  it('morphs BigWig overflow depth into the exact hidden-read count', () => {
    const hiddenCounts = new Float32Array(2);
    fillExperimentalHybridOverflowCounts({
      columnCount: 2,
      sampledDepths: [7, 3],
      exactHiddenCounts: [1, 0],
      exactColumnMask: [1, 1],
      effectiveMaxRows: 4,
      morph: 0.5,
      hiddenCounts,
    });
    expect(Array.from(hiddenCounts)).toEqual([2, 0]);
  });
});
