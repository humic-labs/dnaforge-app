import { describe, expect, it } from 'vitest';
import type { CoverageGrid } from './coverage-raster';
import { encodeCoverageGridToRGBA } from './coverage-encode';

function grid(coverage: number[], rows: number, bins: number): CoverageGrid {
  return {
    coverage: Float32Array.from(coverage),
    rows,
    bins,
    laneToRow: new Map(),
  };
}

describe('encodeCoverageGridToRGBA', () => {
  it('emits width=bins * height=rows * 4 bytes (row-major)', () => {
    const out = encodeCoverageGridToRGBA(grid([0, 0, 0, 0, 0, 0], 2, 3), 0x123456);
    expect(out.length).toBe(2 * 3 * 4);
  });

  it('zero coverage → alpha 0, RGB still the base color', () => {
    const out = encodeCoverageGridToRGBA(grid([0], 1, 1), 0x3366cc);
    expect([...out]).toEqual([0x33, 0x66, 0xcc, 0]);
  });

  it('full coverage → alpha 255', () => {
    const out = encodeCoverageGridToRGBA(grid([1], 1, 1), 0xffffff);
    expect(out[3]).toBe(255);
  });

  it('fractional coverage → rounded [0,255] alpha, monotonic', () => {
    const out = encodeCoverageGridToRGBA(grid([0.25, 0.5, 0.75], 1, 3), 0x000000);
    expect(out[3]).toBe(Math.round(0.25 * 255));
    expect(out[7]).toBe(Math.round(0.5 * 255));
    expect(out[11]).toBe(Math.round(0.75 * 255));
    expect(out[3]).toBeLessThan(out[7]);
    expect(out[7]).toBeLessThan(out[11]);
  });

  it('decomposes 0xRRGGBB into the right channels', () => {
    const out = encodeCoverageGridToRGBA(grid([1], 1, 1), 0xab12fe);
    expect(out[0]).toBe(0xab);
    expect(out[1]).toBe(0x12);
    expect(out[2]).toBe(0xfe);
  });

  it('row-major: (row,bin) lands at (row*bins+bin)*4', () => {
    const out = encodeCoverageGridToRGBA(grid([0, 0, 1, 0], 2, 2), 0x010203);
    const idx = (1 * 2 + 0) * 4;
    expect(out[idx + 3]).toBe(255);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(0);
    expect(out[(1 * 2 + 1) * 4 + 3]).toBe(0);
  });

  it('clamps out-of-range coverage defensively (>1 → 255, <0 → 0)', () => {
    const out = encodeCoverageGridToRGBA(grid([1.5, -0.2], 1, 2), 0xffffff);
    expect(out[3]).toBe(255);
    expect(out[7]).toBe(0);
  });

  it('rows=0 produces an empty buffer (caller substitutes a 1×1 stub)', () => {
    const out = encodeCoverageGridToRGBA(grid([], 0, 4), 0x123456);
    expect(out.length).toBe(0);
  });
});
