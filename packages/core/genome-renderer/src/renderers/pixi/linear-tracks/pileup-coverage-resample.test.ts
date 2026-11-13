import { describe, it, expect } from 'vitest';
import {
  resampleCoverageColumns,
  sampleBinnedDepthColumn,
  sampleBinnedDepthColumnNearest,
  smoothCoverageColumnsInPlace,
} from './pileup-coverage-resample';

describe('pileup-coverage-resample — anti-staircase linear interpolation  FIX #1)', () => {
  it('a DELIBERATELY COARSE signal (4 bins across 1000 columns) produces a per-column ramp with NO flat run wider than 1 column', () => {
    const bins = [10, 20, 40, 80];
    const binSize = 250;
    const signalStartBp = 0.5;
    const columnCount = 1000;
    const columnBp = 1;
    const out = new Float32Array(columnCount);

    resampleCoverageColumns({
      bins,
      binSize,
      signalStartBp,
      viewStart: 0,
      columnBp,
      columnCount,
      useMean: false,
      out,
    });

    const firstCenterCol = 125;
    const lastCenterCol = 875;
    let flatPairs = 0;
    let maxFlatRun = 0;
    let currentRun = 1;
    for (let c = firstCenterCol + 1; c <= lastCenterCol; c++) {
      const delta = out[c] - out[c - 1];
      if (delta === 0) {
        flatPairs++;
        currentRun++;
        if (currentRun > maxFlatRun) maxFlatRun = currentRun;
      } else {
        currentRun = 1;
      }
    }
    expect(flatPairs).toBe(0);
    expect(maxFlatRun).toBeLessThanOrEqual(1);

    expect(out[125]).toBeCloseTo(10, 5);
    expect(out[375]).toBeCloseTo(20, 5);
    expect(out[625]).toBeCloseTo(40, 5);
    expect(out[875]).toBeCloseTo(80, 5);

    expect(out[187]).toBeGreaterThan(10);
    expect(out[187]).toBeLessThan(20);
  });

  it('preserves MAX/MEAN aggregation verbatim when a column spans >= 2 bins (zoomed out)', () => {
    const bins = [10, 20, 40, 80];
    const binSize = 250;
    const max = sampleBinnedDepthColumn(bins, binSize, 0, 0, 1000, false);
    const mean = sampleBinnedDepthColumn(bins, binSize, 0, 0, 1000, true);
    expect(max).toBe(80);
    expect(mean).toBeCloseTo((10 + 20 + 40 + 80) / 4, 5);
  });

  it('returns 0 for a column entirely outside the signal window', () => {
    const bins = [5, 5, 5];
    expect(sampleBinnedDepthColumn(bins, 100, 1000, 0, 100, false)).toBe(0);
    expect(sampleBinnedDepthColumn(bins, 100, 0, 5000, 5100, false)).toBe(0);
  });

  it('a FLAT coarse signal stays flat (interpolation invents nothing)', () => {
    const bins = [42, 42, 42, 42];
    const out = new Float32Array(400);
    resampleCoverageColumns({
      bins,
      binSize: 100,
      signalStartBp: 0,
      viewStart: 0,
      columnBp: 1,
      columnCount: 400,
      useMean: false,
      out,
    });
    for (let c = 0; c < 400; c++) expect(out[c]).toBeCloseTo(42, 5);
  });

  it('the DEV fault-control sampler recreates wide nearest-neighbour plateaus', () => {
    const bins = [10, 20, 40, 80];
    const sampled = Array.from({ length: 1000 }, (_, column) =>
      sampleBinnedDepthColumnNearest(bins, 250, 0, column, column + 1)
    );
    expect(new Set(sampled.slice(0, 250))).toEqual(new Set([10]));
    expect(new Set(sampled.slice(250, 500))).toEqual(new Set([20]));
    expect(new Set(sampled.slice(500, 750))).toEqual(new Set([40]));
    expect(new Set(sampled.slice(750))).toEqual(new Set([80]));
  });

  it('applies the shared normalized five-tap kernel in place without edge attenuation', () => {
    const depths = new Float32Array([10, 10, 10, 10, 10, 10, 10]);
    smoothCoverageColumnsInPlace(depths, new Float32Array(depths.length));
    expect(Array.from(depths)).toEqual([10, 10, 10, 10, 10, 10, 10]);

    const impulse = new Float32Array([0, 0, 0, 100, 0, 0, 0]);
    smoothCoverageColumnsInPlace(impulse, new Float32Array(impulse.length));
    expect(impulse[0]).toBe(0);
    expect(impulse[1]).toBeCloseTo(6 / 0.94, 6);
    expect(Array.from(impulse.slice(2, 5))).toEqual([24, 40, 24]);
    expect(impulse[5]).toBeCloseTo(6 / 0.94, 6);
    expect(impulse[6]).toBe(0);
  });
});
