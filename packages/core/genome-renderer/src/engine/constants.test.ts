import { describe, it, expect } from 'vitest';
import {
  TILE_PX,
  BASE_BIN_BP,
  LEVEL_FACTOR,
  binBp,
  tileSpanBp,
  tileIndex,
  tileGlobalStart,
  tileGlobalEnd,
  maxLevelForLength,
  CONTINUOUS_QUANTITATIVE_SAMPLES_PER_PIXEL,
  quantitativeSourceBasesPerSpan,
} from './constants';
import {
  assertBinBp,
  assertTileSpanBp,
  assertTileIndexFloorEndExclusive,
  assertContiguousEndExclusive,
  assertRoundTrip,
  assertMaxLevel,
  type ConstantsImpl,
} from './constants-assertions';

const impl: ConstantsImpl = {
  TILE_PX,
  binBp,
  tileSpanBp,
  tileIndex,
  tileGlobalStart,
  tileGlobalEnd,
  maxLevelForLength,
};

describe('engine/constants — frozen pyramid values', () => {
  it('pins the literal constants (mirrored to Python in P2 — must not drift)', () => {
    expect(TILE_PX).toBe(1024);
    expect(BASE_BIN_BP).toBe(1);
    expect(LEVEL_FACTOR).toBe(2);
  });

  it('binBp(L) = BASE_BIN_BP * LEVEL_FACTOR^L', () => assertBinBp(impl));
  it('tileSpanBp(L) = TILE_PX * binBp(L) (product, not sum)', () => assertTileSpanBp(impl));
  it('tileIndex is floor + end-exclusive', () => assertTileIndexFloorEndExclusive(impl));
  it('boundaries contiguous + end-exclusive: end(i) === start(i+1)', () =>
    assertContiguousEndExclusive(impl));
  it('bp owned by tile i round-trips back to i', () => assertRoundTrip(impl));
  it('maxLevelForLength: whole genome fits in one tile at L', () => assertMaxLevel(impl));

  it('supersamples continuous quantitative tracks while preserving native interval widths', () => {
    expect(CONTINUOUS_QUANTITATIVE_SAMPLES_PER_PIXEL).toBe(4);
    for (const level of [0, 1, 6, 12, 18]) {
      expect(quantitativeSourceBasesPerSpan(level)).toBe(
        Math.max(BASE_BIN_BP, binBp(level) / CONTINUOUS_QUANTITATIVE_SAMPLES_PER_PIXEL)
      );
      expect(quantitativeSourceBasesPerSpan(level, 'native-interval')).toBe(BASE_BIN_BP);
    }
  });

  it('single-chromosome genome is the N=1 identity case', () => {
    const chromosomeLength = 135_086_622;
    const L = maxLevelForLength(chromosomeLength);
    expect(tileIndex(chromosomeLength - 1, L)).toBe(0);
    expect(tileSpanBp(L)).toBeGreaterThanOrEqual(chromosomeLength);
  });
});
