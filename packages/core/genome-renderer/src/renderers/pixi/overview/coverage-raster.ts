export interface CoverageItem {
  startBp: number;
  endBp: number;
  lane: number;
}

export interface RasterizeOptions {
  lo: number;
  hi: number;
  bins: number;
}

export interface CoverageGrid {
  coverage: Float32Array;
  rows: number;
  bins: number;
  laneToRow: Map<number, number>;
}

export function denseLaneRows(occupiedLanes: Iterable<number>): Map<number, number> {
  const sorted = [...new Set(occupiedLanes)].sort((a, b) => a - b);
  const map = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) map.set(sorted[i], i);
  return map;
}

export function rasterizeCoverage(
  items: readonly CoverageItem[],
  { lo, hi, bins }: RasterizeOptions
): CoverageGrid {
  const span = Math.max(1e-9, hi - lo);
  const binCount = Math.max(1, Math.trunc(bins));
  const bpPerBin = span / binCount;

  const occupied: number[] = [];
  for (const it of items) {
    if (it.endBp <= lo || it.startBp >= hi) continue;
    occupied.push(it.lane);
  }
  const laneToRow = denseLaneRows(occupied);
  const rows = laneToRow.size;
  const coverage = new Float32Array(rows * binCount);
  if (rows === 0) return { coverage, rows: 0, bins: binCount, laneToRow };

  for (const it of items) {
    const s = Math.max(lo, it.startBp);
    const e = Math.min(hi, it.endBp);
    if (e <= s) continue;
    const row = laneToRow.get(it.lane);
    if (row === undefined) continue;
    const b0 = Math.max(0, Math.min(binCount - 1, Math.floor((s - lo) / bpPerBin)));
    const b1 = Math.max(0, Math.min(binCount - 1, Math.floor((e - lo - 1e-9) / bpPerBin)));
    const base = row * binCount;
    for (let b = b0; b <= b1; b++) {
      const binLo = lo + b * bpPerBin;
      const binHi = binLo + bpPerBin;
      const ov = Math.min(e, binHi) - Math.max(s, binLo);
      if (ov <= 0) continue;
      const idx = base + b;
      const v = coverage[idx] + ov / bpPerBin;
      coverage[idx] = v > 1 ? 1 : v;
    }
  }
  return { coverage, rows, bins: binCount, laneToRow };
}
