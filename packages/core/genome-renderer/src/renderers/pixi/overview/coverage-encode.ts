import type { CoverageGrid } from './coverage-raster';

export function encodeCoverageGridToRGBA(grid: CoverageGrid, color: number): Uint8Array {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const { coverage, rows, bins } = grid;
  const out = new Uint8Array(rows * bins * 4);
  for (let i = 0; i < rows * bins; i++) {
    const cov = coverage[i];
    const a = cov <= 0 ? 0 : cov >= 1 ? 255 : Math.round(cov * 255);
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}
