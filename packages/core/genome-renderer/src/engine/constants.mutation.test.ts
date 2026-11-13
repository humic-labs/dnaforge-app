import { describe, it } from 'vitest';
import {
  TILE_PX,
  BASE_BIN_BP,
  LEVEL_FACTOR,
  binBp as realBinBp,
  tileSpanBp as realTileSpanBp,
  tileIndex as realTileIndex,
  tileGlobalStart as realTileGlobalStart,
  tileGlobalEnd as realTileGlobalEnd,
  maxLevelForLength as realMaxLevel,
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
import { assertMutantKilled, assertCorrectImplPasses } from './testing/mutation-harness';

const realImpl: ConstantsImpl = {
  TILE_PX,
  binBp: realBinBp,
  tileSpanBp: realTileSpanBp,
  tileIndex: realTileIndex,
  tileGlobalStart: realTileGlobalStart,
  tileGlobalEnd: realTileGlobalEnd,
  maxLevelForLength: realMaxLevel,
};

function mutate(overrides: Partial<ConstantsImpl>): ConstantsImpl {
  const binBp = overrides.binBp ?? ((L: number) => BASE_BIN_BP * LEVEL_FACTOR ** L);
  const tilePx = overrides.TILE_PX ?? TILE_PX;
  const tileSpanBp = overrides.tileSpanBp ?? ((L: number) => tilePx * binBp(L));
  const tileIndex =
    overrides.tileIndex ?? ((gbp: number, L: number) => Math.floor(gbp / tileSpanBp(L)));
  const tileGlobalStart =
    overrides.tileGlobalStart ?? ((i: number, L: number) => i * tileSpanBp(L));
  const tileGlobalEnd =
    overrides.tileGlobalEnd ?? ((i: number, L: number) => (i + 1) * tileSpanBp(L));
  const maxLevelForLength =
    overrides.maxLevelForLength ??
    ((len: number) => {
      if (len <= tilePx * BASE_BIN_BP) return 0;
      return Math.ceil(Math.log(len / (tilePx * BASE_BIN_BP)) / Math.log(LEVEL_FACTOR));
    });
  return {
    TILE_PX: tilePx,
    binBp,
    tileSpanBp,
    tileIndex,
    tileGlobalStart,
    tileGlobalEnd,
    maxLevelForLength,
  };
}

describe('engine/constants — MUTATION kills (each seeded mutant must die)', () => {
  it('binBp exp→mul (`L_FACTOR ** L` → `L_FACTOR * L`) is killed by assertBinBp', () => {
    const m = mutate({ binBp: (L: number) => BASE_BIN_BP * (LEVEL_FACTOR * L) });
    assertMutantKilled('binBp: exp→mul', () => assertBinBp(m));
  });

  it('tileSpanBp mul→add (`TILE_PX * binBp` → `TILE_PX + binBp`) is killed by assertTileSpanBp', () => {
    const m = mutate({ tileSpanBp: (L: number) => TILE_PX + realBinBp(L) });
    assertMutantKilled('tileSpanBp: mul→add', () => assertTileSpanBp(m));
  });

  it('tileIndex floor→ceil is killed by assertTileIndexFloorEndExclusive', () => {
    const m = mutate({
      tileIndex: (gbp: number, L: number) => Math.ceil(gbp / realTileSpanBp(L)),
    });
    assertMutantKilled('tileIndex: floor→ceil', () => assertTileIndexFloorEndExclusive(m));
  });

  it('tileIndex floor→ceil is ALSO caught by the round-trip block', () => {
    const m = mutate({
      tileIndex: (gbp: number, L: number) => Math.ceil(gbp / realTileSpanBp(L)),
    });
    assertMutantKilled('tileIndex: floor→ceil (round-trip)', () => assertRoundTrip(m));
  });

  it('tileGlobalEnd +1→+0 (`(i+1)*span` → `i*span`) is killed by the contiguity block', () => {
    const m = mutate({ tileGlobalEnd: (i: number, L: number) => i * realTileSpanBp(L) });
    assertMutantKilled('tileGlobalEnd: +1→+0', () => assertContiguousEndExclusive(m));
  });

  it('maxLevelForLength ceil→floor is killed by assertMaxLevel', () => {
    const m = mutate({
      maxLevelForLength: (len: number) => {
        if (len <= TILE_PX * BASE_BIN_BP) return 0;
        return Math.floor(Math.log(len / (TILE_PX * BASE_BIN_BP)) / Math.log(LEVEL_FACTOR));
      },
    });
    assertMutantKilled('maxLevel: ceil→floor', () => assertMaxLevel(m));
  });

  it('CONTROL: every shared block PASSES on the correct impl (blocks not vacuous)', () => {
    assertCorrectImplPasses('binBp', () => assertBinBp(realImpl));
    assertCorrectImplPasses('tileSpanBp', () => assertTileSpanBp(realImpl));
    assertCorrectImplPasses('tileIndex', () => assertTileIndexFloorEndExclusive(realImpl));
    assertCorrectImplPasses('contiguity', () => assertContiguousEndExclusive(realImpl));
    assertCorrectImplPasses('roundTrip', () => assertRoundTrip(realImpl));
    assertCorrectImplPasses('maxLevel', () => assertMaxLevel(realImpl));
  });
});
