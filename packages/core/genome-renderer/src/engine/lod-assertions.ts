import { expect } from 'vitest';
import type { Assembly } from '../assembly';
import type { Viewport, VisibleTile } from './lod';

export interface LodImpl {
  bpPerPx(view: Viewport): number;
  baseLevelForBpPerPx(bpp: number, maxLevel: number): number;
  pickLevel(view: Viewport, maxLevel: number, lastLevel: number | null): number;
  shouldPrefetchCoarser(view: Viewport, currentLevel: number): boolean;
  shouldPrefetchFiner(view: Viewport, currentLevel: number): boolean;
  visibleTiles(view: Viewport, level: number, assembly: Assembly): VisibleTile[];
  PREFETCH_MARGIN_TILES: number;
}

function view(globalStart: number, globalEnd: number, viewportPx: number): Viewport {
  return { globalStart, globalEnd, viewportPx };
}

export function assertBaseLevel(impl: LodImpl): void {
  const M = 22;
  expect(impl.baseLevelForBpPerPx(1, M)).toBe(0);
  expect(impl.baseLevelForBpPerPx(1.5, M)).toBe(1);
  expect(impl.baseLevelForBpPerPx(2, M)).toBe(1);
  expect(impl.baseLevelForBpPerPx(3, M)).toBe(2);
  expect(impl.baseLevelForBpPerPx(4, M)).toBe(2);
  expect(impl.baseLevelForBpPerPx(5, M)).toBe(3);
  expect(impl.baseLevelForBpPerPx(1024, M)).toBe(10);
  expect(impl.baseLevelForBpPerPx(0.25, M)).toBe(0);
  expect(impl.baseLevelForBpPerPx(1e12, M)).toBe(M);
}

export function assertHysteresis(impl: LodImpl): void {
  const M = 22;
  const px = 1000;
  const at = (bpp: number) => view(0, bpp * px, px);
  expect(impl.pickLevel(at(16), M, 4)).toBe(4);
  expect(impl.pickLevel(at(10), M, 4)).toBe(4);
  expect(impl.pickLevel(at(8), M, 4)).toBe(4);
  expect(impl.pickLevel(at(17), M, 4)).toBe(5);
  expect(impl.pickLevel(at(7.9), M, 4)).toBe(3);
  expect(impl.pickLevel(at(10), M, null)).toBe(impl.baseLevelForBpPerPx(10, M));
  expect(impl.pickLevel(at(15.9), M, 4)).toBe(4);
  expect(impl.pickLevel(at(16.0), M, 4)).toBe(4);
}

export function assertPrefetch(impl: LodImpl): void {
  const px = 1000;
  const at = (bpp: number) => view(0, bpp * px, px);
  expect(impl.shouldPrefetchCoarser(at(11.0), 4)).toBe(false);
  expect(impl.shouldPrefetchCoarser(at(11.2), 4)).toBe(false);
  expect(impl.shouldPrefetchCoarser(at(11.3), 4)).toBe(true);
  expect(impl.shouldPrefetchCoarser(at(16), 4)).toBe(true);
  expect(impl.shouldPrefetchCoarser(at(0.6), 0)).toBe(false);
  expect(impl.shouldPrefetchCoarser(at(0.8), 0)).toBe(true);

  expect(impl.shouldPrefetchFiner(at(16.1), 4)).toBe(false);
  expect(impl.shouldPrefetchFiner(at(16), 4)).toBe(false);
  expect(impl.shouldPrefetchFiner(at(15.9), 4)).toBe(true);
  expect(impl.shouldPrefetchFiner(at(8.1), 4)).toBe(true);
  expect(impl.shouldPrefetchFiner(at(0.2), 0)).toBe(false);
}

export function assertVisibleTilesBounds(impl: LodImpl, asm: Assembly): void {
  const v = view(3000, 5000, 1000);
  const tiles = impl.visibleTiles(v, 0, asm);
  const indices = tiles.map((t) => t.index);
  expect([...indices].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  for (const t of tiles) {
    expect(t.globalStart).toBe(t.index * 1024);
    expect(t.globalEnd).toBe((t.index + 1) * 1024);
    expect(t.segments.length).toBeGreaterThanOrEqual(1);
  }
}

export function assertVisibleTilesLeftClamp(impl: LodImpl, asm: Assembly): void {
  const v = view(0, 500, 1000);
  const indices = impl.visibleTiles(v, 0, asm).map((t) => t.index);
  expect(indices).toEqual([0, 1]);
  expect(indices.every((i) => i >= 0)).toBe(true);
}

export function assertVisibleTilesRightClamp(impl: LodImpl, asm: Assembly): void {
  const total = asm.totalLengthBp;
  const v = view(total - 500, total, 1000);
  const maxIdx = Math.floor((total - 1) / 1024);
  const indices = impl.visibleTiles(v, 0, asm).map((t) => t.index);
  expect(Math.max(...indices)).toBeLessThanOrEqual(maxIdx);
  expect(indices).toContain(maxIdx);
}

export function assertVisibleTilesEndExclusive(impl: LodImpl, asm: Assembly): void {
  const v = view(0, 1024, 1000);
  const indices = impl.visibleTiles(v, 0, asm).map((t) => t.index);
  expect(indices).toEqual([0, 1]);
  const v2 = view(0, 1023, 1000);
  expect(impl.visibleTiles(v2, 0, asm).map((t) => t.index)).toEqual([0, 1]);
}
