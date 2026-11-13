import type { Assembly } from '../assembly';
import { globalRangeToSegments, type AssemblySegment } from '../assembly-layout';
import { binBp, tileSpanBp, tileIndex, maxLevelForLength, TILE_PX, BASE_BIN_BP } from './constants';

export interface Viewport {
  globalStart: number;
  globalEnd: number;
  viewportPx: number;
}

export function bpPerPx(view: Viewport): number {
  return (view.globalEnd - view.globalStart) / view.viewportPx;
}

export function baseLevelForBpPerPx(bpp: number, maxLevel: number): number {
  const raw = Math.ceil(Math.log(bpp / BASE_BIN_BP) / Math.log(2));
  return Math.min(maxLevel, Math.max(0, raw));
}

export const HYSTERESIS_DOWN_FRACTION = 1.0;
export const HYSTERESIS_UP_FRACTION = 1.0;
export const PREFETCH_FRACTION = 0.7;
export const PREFETCH_FINER_FRACTION = 2.0;

export function pickLevel(view: Viewport, maxLevel: number, lastLevel: number | null): number {
  const bpp = bpPerPx(view);
  const base = baseLevelForBpPerPx(bpp, maxLevel);
  if (lastLevel === null) return base;
  const L = Math.min(maxLevel, Math.max(0, lastLevel));
  if (bpp > HYSTERESIS_DOWN_FRACTION * binBp(L)) {
    return Math.min(maxLevel, L + 1);
  }
  if (L > 0 && bpp < HYSTERESIS_UP_FRACTION * binBp(L - 1)) {
    return Math.max(0, L - 1);
  }
  return L;
}

export function shouldPrefetchCoarser(view: Viewport, currentLevel: number): boolean {
  return bpPerPx(view) > PREFETCH_FRACTION * binBp(currentLevel);
}

export function shouldPrefetchFiner(view: Viewport, currentLevel: number): boolean {
  if (currentLevel <= 0) return false;
  return bpPerPx(view) < PREFETCH_FINER_FRACTION * binBp(currentLevel - 1);
}

export interface VisibleTile {
  level: number;
  index: number;
  core: boolean;
  marginDistanceTiles: number;
  globalStart: number;
  globalEnd: number;
  segments: AssemblySegment[];
}

export const PREFETCH_MARGIN_TILES = 1;

export function visibleTiles(
  view: Viewport,
  level: number,
  assembly: Assembly,
  marginTiles = PREFETCH_MARGIN_TILES
): VisibleTile[] {
  const span = tileSpanBp(level);
  const maxIdx = Math.max(0, Math.floor((assembly.totalLengthBp - 1) / span));
  const margin = Math.max(0, Math.floor(marginTiles));
  const core0 = Math.max(0, Math.min(maxIdx, tileIndex(view.globalStart, level)));
  const core1 = Math.max(0, Math.min(maxIdx, tileIndex(view.globalEnd - 1, level)));
  let i0 = core0 - margin;
  let i1 = core1 + margin;
  i0 = Math.max(0, i0);
  i1 = Math.min(maxIdx, i1);
  const out: VisibleTile[] = [];
  for (let i = i0; i <= i1; i++) {
    const globalStart = i * span;
    const globalEnd = (i + 1) * span;
    const segments = globalRangeToSegments(
      assembly,
      Math.max(0, globalStart),
      Math.min(assembly.totalLengthBp, globalEnd)
    );
    const core = i >= core0 && i <= core1;
    const marginDistanceTiles = core ? 0 : i < core0 ? core0 - i : i - core1;
    out.push({ level, index: i, core, marginDistanceTiles, globalStart, globalEnd, segments });
  }
  return out.sort((a, b) => {
    const aCore = a.index >= core0 && a.index <= core1;
    const bCore = b.index >= core0 && b.index <= core1;
    if (aCore !== bCore) return aCore ? -1 : 1;
    if (aCore) return a.index - b.index;
    const aDistance = a.index < core0 ? core0 - a.index : a.index - core1;
    const bDistance = b.index < core0 ? core0 - b.index : b.index - core1;
    return aDistance - bDistance || a.index - b.index;
  });
}

export function maxLevelForAssembly(assembly: Assembly): number {
  return maxLevelForLength(assembly.totalLengthBp);
}

export { TILE_PX };
