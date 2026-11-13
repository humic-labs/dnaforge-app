import { describe, expect, it } from 'vitest';
import type { ReadyCoverageSlice } from './tile-engine-coverage';
import {
  applyRankedCoverageContributors,
  applyReadsDerivedCoverage,
  collectExactSupportRanges,
  collectResidentSupportRanges,
  collectValidExactSlicesByResolution,
  coverageOutputBinTooWideForPresentation,
  hasAnyCoverageComposeSource,
  rangesCoverViewport,
  resolveForcedCoverageLevel,
  selectCompleteSupportOutputLevel,
} from './tile-engine-resampled-coverage';

function view(start: number, end: number, viewportPx = end - start) {
  return { globalStart: start, globalEnd: end, viewportPx };
}

function slice(
  overrides: Partial<ReadyCoverageSlice> & { bins?: number[] } = {}
): ReadyCoverageSlice {
  const bins = overrides.bins ?? [1, 2];
  return {
    globalStart: overrides.globalStart ?? 0,
    globalEnd: overrides.globalEnd ?? bins.length,
    binSize: overrides.binSize ?? 1,
    payload: { bins, ...(overrides.payload ?? {}) },
  };
}

describe('resolveForcedCoverageLevel / hasAnyCoverageComposeSource', () => {
  it('leaves an unset fault as undefined and clamps a requested level', () => {
    expect(resolveForcedCoverageLevel(null, 10)).toBeUndefined();
    expect(resolveForcedCoverageLevel(-2, 10)).toBe(0);
    expect(resolveForcedCoverageLevel(99, 10)).toBe(10);
  });

  it('requires at least one compose source', () => {
    expect(hasAnyCoverageComposeSource(0, false, false)).toBe(false);
    expect(hasAnyCoverageComposeSource(1, false, false)).toBe(true);
    expect(hasAnyCoverageComposeSource(0, true, false)).toBe(true);
    expect(hasAnyCoverageComposeSource(0, false, true)).toBe(true);
  });
});

describe('coverageOutputBinTooWideForPresentation', () => {
  it('never rejects a one-base bin or a forced coarse fault', () => {
    expect(coverageOutputBinTooWideForPresentation(undefined, 1, 800, 10)).toBe(false);
    expect(coverageOutputBinTooWideForPresentation(6, 64, 800, 10)).toBe(false);
  });

  it('rejects a wide bin that would occupy more than one screen pixel', () => {
    expect(coverageOutputBinTooWideForPresentation(undefined, 64, 800, 10)).toBe(true);
  });
});

describe('collectExactSupportRanges / collectValidExactSlicesByResolution', () => {
  it('drops zero-size and empty-payload slices from support ranges', () => {
    const ranges = collectExactSupportRanges([
      {
        slices: [
          slice({ binSize: 0, bins: [1] }),
          slice({ globalStart: 10, globalEnd: 12, binSize: 1, bins: [4, 5] }),
          slice({ globalStart: 20, globalEnd: 20, binSize: 1, bins: [] }),
        ],
      },
    ]);
    expect(ranges).toEqual([{ resolution: 1, ranges: [{ globalStart: 10, globalEnd: 12 }] }]);
  });

  it('rejects negative or non-finite exact bins', () => {
    const valid = collectValidExactSlicesByResolution([
      {
        slices: [
          slice({ bins: [1, -1] }),
          slice({ globalStart: 4, globalEnd: 6, bins: [3, Number.NaN] }),
          slice({ globalStart: 8, globalEnd: 10, bins: [7, 8] }),
        ],
      },
    ]);
    expect([...valid.keys()]).toEqual([1]);
    expect(valid.get(1)).toEqual([
      expect.objectContaining({ globalStart: 8, globalEnd: 10, binSize: 1 }),
    ]);
  });
});

describe('collectResidentSupportRanges', () => {
  it('keeps a uniform-resolution pyramid level and skips mixed bin sizes', () => {
    const uniform = new Map([
      ['chr1', { globalStart: 0, globalEnd: 8, binSize: 4, bins: new Float32Array([1, 2]) }],
    ]);
    const mixed = new Map([
      ['chr1', { globalStart: 0, binSize: 4, bins: new Float32Array([1]) }],
      ['chr2', { globalStart: 4, binSize: 8, bins: new Float32Array([1]) }],
    ]);
    expect(collectResidentSupportRanges([uniform, mixed])).toEqual([
      { resolution: 4, ranges: [{ globalStart: 0, globalEnd: 8 }] },
    ]);
  });
});

describe('selectCompleteSupportOutputLevel / rangesCoverViewport', () => {
  it('returns the forced level without consulting support', () => {
    expect(
      selectCompleteSupportOutputLevel({
        forcedLevel: 3,
        capLevel: 0,
        maxLevel: 10,
        supportRanges: [],
        view: view(0, 100),
      })
    ).toBe(3);
  });

  it('picks the first candidate whose support covers the viewport', () => {
    expect(
      selectCompleteSupportOutputLevel({
        forcedLevel: undefined,
        capLevel: 0,
        maxLevel: 6,
        supportRanges: [{ resolution: 4, ranges: [{ globalStart: 0, globalEnd: 100 }] }],
        view: view(0, 100),
      })
    ).toBe(2);
  });

  it('returns undefined when support has a gap', () => {
    expect(rangesCoverViewport([{ globalStart: 0, globalEnd: 40 }], view(0, 100))).toBe(false);
    expect(
      selectCompleteSupportOutputLevel({
        forcedLevel: undefined,
        capLevel: 0,
        maxLevel: 4,
        supportRanges: [{ resolution: 1, ranges: [{ globalStart: 0, globalEnd: 40 }] }],
        view: view(0, 100),
      })
    ).toBeUndefined();
  });
});

describe('applyReadsDerivedCoverage', () => {
  it('claims only bins with positive depth inside the read window', () => {
    const bins = [0, 0, 0, 0];
    const covered = new Uint8Array(4);
    applyReadsDerivedCoverage({
      records: [
        { start: 0, end: 2 },
        { start: 1, end: 2 },
      ],
      signalStart: 0,
      outBin: 1,
      totalBins: 4,
      windowStartBp: 0,
      windowEndBp: 3,
      bins,
      covered,
    });
    expect(Array.from(covered)).toEqual([1, 1, 0, 0]);
    expect(bins).toEqual([1, 2, 0, 0]);
  });
});

describe('applyRankedCoverageContributors', () => {
  it('skips coarser-than-output sources and fills uncovered exact bins', () => {
    const bins = [0, 0, 0, 0];
    const covered = new Uint8Array(4);
    applyRankedCoverageContributors({
      contributors: [
        {
          kind: 'exact',
          resolution: 8,
          slices: [slice({ globalStart: 0, globalEnd: 4, binSize: 8, bins: [9, 9, 9, 9] })],
        },
        {
          kind: 'exact',
          resolution: 1,
          slices: [slice({ globalStart: 0, globalEnd: 4, binSize: 1, bins: [3, 4, 5, 6] })],
        },
      ],
      outBin: 1,
      signalStart: 0,
      signalEnd: 4,
      totalBins: 4,
      view: view(0, 4),
      bins,
      covered,
      useMeanPool: true,
    });
    expect(Array.from(covered)).toEqual([1, 1, 1, 1]);
    expect(bins).toEqual([3, 4, 5, 6]);
  });

  it('lets finer exact data win over already-uncovered resident fill order', () => {
    const bins = [0, 0];
    const covered = new Uint8Array(2);
    applyRankedCoverageContributors({
      contributors: [
        {
          kind: 'exact',
          resolution: 1,
          slices: [slice({ globalStart: 0, globalEnd: 2, binSize: 1, bins: [10, 20] })],
        },
        {
          kind: 'resident',
          resolution: 1,
          layers: new Map([
            ['chr1', { globalStart: 0, globalEnd: 2, binSize: 1, bins: new Float32Array([1, 1]) }],
          ]),
        },
      ],
      outBin: 1,
      signalStart: 0,
      signalEnd: 2,
      totalBins: 2,
      view: view(0, 2),
      bins,
      covered,
      useMeanPool: true,
    });
    expect(bins).toEqual([10, 20]);
  });
});
