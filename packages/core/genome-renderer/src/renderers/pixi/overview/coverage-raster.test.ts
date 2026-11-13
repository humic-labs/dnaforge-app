import { describe, it, expect } from 'vitest';
import { rasterizeCoverage, denseLaneRows, type CoverageItem } from './coverage-raster';

const it_ = (startBp: number, endBp: number, lane: number): CoverageItem => ({
  startBp,
  endBp,
  lane,
});
const IS_CI = process.env.CI === 'true';

function chromosomeScaleRaster() {
  const N = 50_000;
  const GEN = 135_086_622;
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const items: CoverageItem[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const st = Math.floor(rnd() * GEN);
    items[i] = it_(st, st + 1 + Math.floor(rnd() * 50_000), i % 32);
  }
  const t0 = performance.now();
  const raster = rasterizeCoverage(items, { lo: 0, hi: GEN, bins: 2048 });
  return { raster, elapsedMs: performance.now() - t0 };
}

describe('denseLaneRows', () => {
  it('compacts sparse lanes to contiguous rows, order preserved', () => {
    const m = denseLaneRows([5, 0, 5, 2]);
    expect([...m.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 0],
      [2, 1],
      [5, 2],
    ]);
  });
  it('empty input → empty map', () => {
    expect(denseLaneRows([]).size).toBe(0);
  });
});

describe('rasterizeCoverage', () => {
  it('a feature fully spanning its bins reads ~1.0', () => {
    const g = rasterizeCoverage([it_(0, 100, 0)], { lo: 0, hi: 100, bins: 10 });
    expect(g.rows).toBe(1);
    expect(g.bins).toBe(10);
    for (let i = 0; i < 10; i++) expect(g.coverage[i]).toBeCloseTo(1, 5);
  });

  it('partial bin coverage is the bp fraction', () => {
    const g = rasterizeCoverage([it_(0, 5, 0)], { lo: 0, hi: 100, bins: 10 });
    expect(g.coverage[0]).toBeCloseTo(0.5, 5);
    expect(g.coverage[1]).toBe(0);
  });

  it('multi-bin feature fills middle bins, partial at edges', () => {
    const g = rasterizeCoverage([it_(5, 25, 0)], { lo: 0, hi: 100, bins: 10 });
    expect(g.coverage[0]).toBeCloseTo(0.5, 5);
    expect(g.coverage[1]).toBeCloseTo(1, 5);
    expect(g.coverage[2]).toBeCloseTo(0.5, 5);
    expect(g.coverage[3]).toBe(0);
  });

  it('lanes map to dense rows; row-major layout', () => {
    const g = rasterizeCoverage([it_(0, 100, 0), it_(0, 100, 7)], { lo: 0, hi: 100, bins: 4 });
    expect(g.rows).toBe(2);
    expect(g.laneToRow.get(0)).toBe(0);
    expect(g.laneToRow.get(7)).toBe(1);
    expect(g.coverage[0]).toBeCloseTo(1, 5);
    expect(g.coverage[4]).toBeCloseTo(1, 5);
  });

  it('overlapping features on same row accumulate, capped at 1', () => {
    const g = rasterizeCoverage([it_(0, 10, 0), it_(0, 10, 0)], { lo: 0, hi: 10, bins: 1 });
    expect(g.coverage[0]).toBe(1);
  });

  it('features outside the window contribute nothing and drop their lane', () => {
    const g = rasterizeCoverage([it_(-100, -1, 3), it_(500, 600, 4), it_(10, 20, 9)], {
      lo: 0,
      hi: 100,
      bins: 10,
    });
    expect(g.rows).toBe(1);
    expect(g.laneToRow.get(9)).toBe(0);
    expect(g.coverage[1]).toBeCloseTo(1, 5);
  });

  it('empty / degenerate', () => {
    const g = rasterizeCoverage([], { lo: 0, hi: 100, bins: 10 });
    expect(g.rows).toBe(0);
    expect(g.coverage.length).toBe(0);
  });

  it('chromosome-scale: 50k features over 135 Mb, 2048 bins stays bounded', () => {
    const { raster: g } = chromosomeScaleRaster();
    expect(g.rows).toBe(32);
    expect(g.coverage.length).toBe(32 * 2048);
    for (const v of g.coverage)
      (expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1));
  });

  it.skipIf(IS_CI)(
    'benchmark: chromosome-scale raster stays under 50 ms (isolated runs only)',
    () => {
      const { elapsedMs } = chromosomeScaleRaster();
      expect(elapsedMs).toBeLessThan(50);
      // eslint-disable-next-line no-console
      console.log(`[coverage-raster] 50k feats / 135Mb / 2048 bins = ${elapsedMs.toFixed(2)}ms`);
    }
  );
});
