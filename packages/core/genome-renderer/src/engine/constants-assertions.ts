import { expect } from 'vitest';

export interface ConstantsImpl {
  binBp(level: number): number;
  tileSpanBp(level: number): number;
  tileIndex(globalBp: number, level: number): number;
  tileGlobalStart(index: number, level: number): number;
  tileGlobalEnd(index: number, level: number): number;
  maxLevelForLength(totalLengthBp: number): number;
  TILE_PX: number;
}

export function assertBinBp(impl: ConstantsImpl): void {
  expect(impl.binBp(0)).toBe(1);
  expect(impl.binBp(1)).toBe(2);
  expect(impl.binBp(2)).toBe(4);
  expect(impl.binBp(3)).toBe(8);
  expect(impl.binBp(4)).toBe(16);
  expect(impl.binBp(5)).toBe(32);
  expect(impl.binBp(6)).toBe(64);
}

export function assertTileSpanBp(impl: ConstantsImpl): void {
  expect(impl.tileSpanBp(0)).toBe(1024);
  expect(impl.tileSpanBp(1)).toBe(2048);
  expect(impl.tileSpanBp(2)).toBe(4096);
  expect(impl.tileSpanBp(10)).toBe(1024 * 1024);
  expect(impl.tileSpanBp(1)).not.toBe(impl.TILE_PX + impl.binBp(1));
}

export function assertTileIndexFloorEndExclusive(impl: ConstantsImpl): void {
  expect(impl.tileIndex(0, 0)).toBe(0);
  expect(impl.tileIndex(1, 0)).toBe(0);
  expect(impl.tileIndex(1023, 0)).toBe(0);
  expect(impl.tileIndex(1024, 0)).toBe(1);
  expect(impl.tileIndex(2047, 0)).toBe(1);
  expect(impl.tileIndex(2048, 0)).toBe(2);
}

export function assertContiguousEndExclusive(impl: ConstantsImpl): void {
  for (const L of [0, 1, 5, 12]) {
    for (let i = 0; i < 4; i++) {
      expect(impl.tileGlobalStart(i, L)).toBe(i * impl.tileSpanBp(L));
      expect(impl.tileGlobalEnd(i, L)).toBe((i + 1) * impl.tileSpanBp(L));
      expect(impl.tileGlobalEnd(i, L)).toBe(impl.tileGlobalStart(i + 1, L));
    }
  }
}

export function assertRoundTrip(impl: ConstantsImpl): void {
  for (const L of [0, 1, 7]) {
    for (let i = 0; i < 5; i++) {
      const start = impl.tileGlobalStart(i, L);
      const end = impl.tileGlobalEnd(i, L);
      expect(impl.tileIndex(start, L)).toBe(i);
      expect(impl.tileIndex(end - 1, L)).toBe(i);
      expect(impl.tileIndex(end, L)).toBe(i + 1);
    }
  }
}

export function assertMaxLevel(impl: ConstantsImpl): void {
  const grch38 = 3_088_269_832;
  const L = impl.maxLevelForLength(grch38);
  expect(L).toBe(22);
  expect(impl.tileSpanBp(L)).toBeGreaterThanOrEqual(grch38);
  expect(impl.tileIndex(grch38 - 1, L)).toBe(0);
  expect(impl.tileSpanBp(L - 1)).toBeLessThan(grch38);
}
