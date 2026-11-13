export type TileCoord = { z: number; i: number };

export type BpRange = { startBp: number; endBp: number };

export type TileIndexRange = { first: number; last: number };

function clampInt(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export function tileCountAtLevel(z: number): number {
  return 2 ** z;
}

export function tileSpanBp(L: number, z: number): number {
  return L / 2 ** z;
}

export function tileIndexForBp(L: number, z: number, bp: number): number {
  const count = 2 ** z;
  if (L <= 0) return 0;
  const spanBp = L / count;
  const raw = Math.floor(bp / spanBp);
  return clampInt(raw, 0, count - 1);
}

export function tileRangeBp(L: number, z: number, i: number): BpRange {
  const count = 2 ** z;
  return {
    startBp: (i * L) / count,
    endBp: ((i + 1) * L) / count,
  };
}

export function visibleTiles(
  L: number,
  z: number,
  viewStartBp: number,
  viewEndBp: number
): TileIndexRange {
  const count = 2 ** z;
  const first = tileIndexForBp(L, z, viewStartBp);
  if (viewEndBp <= viewStartBp) {
    return { first, last: first };
  }
  const spanBp = L / count;
  let last = tileIndexForBp(L, z, viewEndBp);
  const onInteriorBoundary = viewEndBp < L && viewEndBp % spanBp === 0;
  if (onInteriorBoundary && last > first) last -= 1;
  last = clampInt(last, first, count - 1);
  return { first, last };
}

export function parentTile(z: number, i: number): TileCoord | null {
  if (z <= 0) return null;
  return { z: z - 1, i: Math.floor(i / 2) };
}

export function childTiles(z: number, i: number): [TileCoord, TileCoord] {
  return [
    { z: z + 1, i: 2 * i },
    { z: z + 1, i: 2 * i + 1 },
  ];
}

export function selectLevel(params: {
  L: number;
  visibleBp: number;
  screenPx: number;
  tilePx?: number;
  maxLevel: number;
}): number {
  const { L, visibleBp, screenPx, maxLevel } = params;
  const tilePx = params.tilePx ?? 512;
  if (visibleBp <= 0 || screenPx <= 0 || L <= 0 || tilePx <= 0) {
    return clampInt(0, 0, maxLevel);
  }
  const ratio = (screenPx * L) / (visibleBp * tilePx);
  const z = Math.round(Math.log2(ratio));
  return clampInt(z, 0, maxLevel);
}

export function tileKey(z: number, i: number): string {
  return `${z}/${i}`;
}

export function crossoverLevel(p: {
  L: number;
  medianFeatureSpanBp: number;
  tilePx?: number;
  crossoverPx?: number;
  maxLevel: number;
}): number {
  const { L, medianFeatureSpanBp, maxLevel } = p;
  const tilePx = p.tilePx ?? 512;
  const crossoverPx = p.crossoverPx ?? 1.0;

  if (!Number.isFinite(medianFeatureSpanBp) || medianFeatureSpanBp <= 0) {
    return clampInt(maxLevel, 0, maxLevel);
  }
  if (
    !Number.isFinite(L) ||
    L <= 0 ||
    !Number.isFinite(tilePx) ||
    tilePx <= 0 ||
    !Number.isFinite(crossoverPx) ||
    crossoverPx <= 0
  ) {
    return clampInt(0, 0, maxLevel);
  }

  const ratio = (crossoverPx * L) / (tilePx * medianFeatureSpanBp);
  const z = Math.ceil(Math.log2(ratio));
  return clampInt(z, 0, maxLevel);
}

export function isRasterLevel(z: number, zXover: number): boolean {
  return z < zXover;
}
