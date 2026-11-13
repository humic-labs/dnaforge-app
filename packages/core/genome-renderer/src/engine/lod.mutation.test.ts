import { describe, it } from 'vitest';
import type { Assembly } from '../assembly';
import type { Chromosome } from '../chromosome';
import { buildAssembly, globalRangeToSegments } from '../assembly-layout';
import { binBp, tileSpanBp, tileIndex, BASE_BIN_BP } from './constants';
import {
  bpPerPx as realBpPerPx,
  baseLevelForBpPerPx as realBaseLevel,
  pickLevel as realPickLevel,
  shouldPrefetchCoarser as realPrefetch,
  shouldPrefetchFiner as realPrefetchFiner,
  visibleTiles as realVisibleTiles,
  PREFETCH_MARGIN_TILES,
  HYSTERESIS_DOWN_FRACTION,
  HYSTERESIS_UP_FRACTION,
  PREFETCH_FRACTION,
  type Viewport,
  type VisibleTile,
} from './lod';
import {
  assertBaseLevel,
  assertHysteresis,
  assertPrefetch,
  assertVisibleTilesBounds,
  assertVisibleTilesLeftClamp,
  assertVisibleTilesEndExclusive,
  type LodImpl,
} from './lod-assertions';
import { assertMutantKilled, assertCorrectImplPasses } from './testing/mutation-harness';

function chrom(id: string, length: number): Chromosome {
  return { id, displayName: id, length, cytobands: [] };
}
const asm: Assembly = buildAssembly('test', 'test', [chrom('chr1', 10_000), chrom('chr2', 8_000)]);

const realImpl: LodImpl = {
  bpPerPx: realBpPerPx,
  baseLevelForBpPerPx: realBaseLevel,
  pickLevel: realPickLevel,
  shouldPrefetchCoarser: realPrefetch,
  shouldPrefetchFiner: realPrefetchFiner,
  visibleTiles: realVisibleTiles,
  PREFETCH_MARGIN_TILES,
};

function baseLevelMutant(kind: 'floor' | 'plus1') {
  return (bpp: number, maxLevel: number) => {
    const log = Math.log(bpp / BASE_BIN_BP) / Math.log(2);
    const raw = kind === 'floor' ? Math.floor(log) : Math.ceil(log) + 1;
    return Math.min(maxLevel, Math.max(0, raw));
  };
}

function pickLevelMutant(kind: 'drop-hysteresis' | 'down-gte') {
  return (view: Viewport, maxLevel: number, lastLevel: number | null) => {
    const bpp = realBpPerPx(view);
    const base = realBaseLevel(bpp, maxLevel);
    if (kind === 'drop-hysteresis') return base;
    if (lastLevel === null) return base;
    const L = Math.min(maxLevel, Math.max(0, lastLevel));
    if (bpp >= HYSTERESIS_DOWN_FRACTION * binBp(L)) return Math.min(maxLevel, L + 1);
    if (L > 0 && bpp < HYSTERESIS_UP_FRACTION * binBp(L - 1)) return Math.max(0, L - 1);
    return L;
  };
}

function prefetchMutant(kind: 'fraction-1' | 'gte') {
  return (view: Viewport, currentLevel: number) => {
    const f = kind === 'fraction-1' ? 1.0 : PREFETCH_FRACTION;
    const lhs = realBpPerPx(view);
    const rhs = f * binBp(currentLevel);
    return kind === 'gte' ? lhs >= rhs : lhs > rhs;
  };
}

function finerPrefetchMutant(kind: 'fraction-1' | 'lte') {
  return (view: Viewport, currentLevel: number) => {
    if (currentLevel <= 0) return false;
    const f = kind === 'fraction-1' ? 1.0 : PREFETCH_FRACTION;
    const lhs = realBpPerPx(view);
    const rhs = f * binBp(currentLevel - 1);
    return kind === 'lte' ? lhs <= rhs : lhs < rhs;
  };
}

function visibleTilesMutant(kind: 'no-margin' | 'inclusive-end' | 'no-left-clamp') {
  return (view: Viewport, level: number, assembly: Assembly): VisibleTile[] => {
    const span = tileSpanBp(level);
    const maxIdx = Math.max(0, Math.floor((assembly.totalLengthBp - 1) / span));
    const margin = kind === 'no-margin' ? 0 : PREFETCH_MARGIN_TILES;
    const endBp = kind === 'inclusive-end' ? view.globalEnd : view.globalEnd - 1;
    let i0 = tileIndex(view.globalStart, level) - margin;
    let i1 = tileIndex(endBp, level) + margin;
    if (kind !== 'no-left-clamp') i0 = Math.max(0, i0);
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
      out.push({
        level,
        index: i,
        globalStart,
        globalEnd,
        segments,
        core: i >= tileIndex(view.globalStart, level) && i <= tileIndex(endBp, level),
        marginDistanceTiles: Math.max(
          0,
          tileIndex(view.globalStart, level) - i,
          i - tileIndex(endBp, level)
        ),
      });
    }
    return out;
  };
}

function withVisibleTiles(fn: LodImpl['visibleTiles']): LodImpl {
  return { ...realImpl, visibleTiles: fn };
}

describe('engine/lod — MUTATION kills', () => {
  it('baseLevel ceil→floor is killed by assertBaseLevel', () => {
    assertMutantKilled('baseLevel: ceil→floor', () =>
      assertBaseLevel({ ...realImpl, baseLevelForBpPerPx: baseLevelMutant('floor') })
    );
  });
  it('baseLevel spurious +1 is killed by assertBaseLevel', () => {
    assertMutantKilled('baseLevel: +1', () =>
      assertBaseLevel({ ...realImpl, baseLevelForBpPerPx: baseLevelMutant('plus1') })
    );
  });

  it('pickLevel drop-hysteresis is killed by assertHysteresis', () => {
    assertMutantKilled('pickLevel: drop-hysteresis', () =>
      assertHysteresis({ ...realImpl, pickLevel: pickLevelMutant('drop-hysteresis') })
    );
  });
  it('pickLevel down-edge `>`→`>=` is killed by assertHysteresis', () => {
    assertMutantKilled('pickLevel: down `>`→`>=`', () =>
      assertHysteresis({ ...realImpl, pickLevel: pickLevelMutant('down-gte') })
    );
  });

  it('prefetch 0.7→1.0 is killed by assertPrefetch', () => {
    assertMutantKilled('prefetch: 0.7→1.0', () =>
      assertPrefetch({ ...realImpl, shouldPrefetchCoarser: prefetchMutant('fraction-1') })
    );
  });
  it('prefetch `>`→`>=` is killed by assertPrefetch (boundary at the threshold)', () => {
    assertMutantKilled('prefetch: `>`→`>=`', () =>
      assertPrefetch({ ...realImpl, shouldPrefetchCoarser: prefetchMutant('gte') })
    );
  });
  it('finer prefetch 0.7→1.0 is killed by assertPrefetch', () => {
    assertMutantKilled('finer prefetch: 0.7→1.0', () =>
      assertPrefetch({ ...realImpl, shouldPrefetchFiner: finerPrefetchMutant('fraction-1') })
    );
  });
  it('finer prefetch `<`→`<=` is killed by assertPrefetch (boundary at the threshold)', () => {
    assertMutantKilled('finer prefetch: `<`→`<=`', () =>
      assertPrefetch({ ...realImpl, shouldPrefetchFiner: finerPrefetchMutant('lte') })
    );
  });

  it('visibleTiles drop-margin is killed by assertVisibleTilesBounds', () => {
    assertMutantKilled('visibleTiles: no-margin', () =>
      assertVisibleTilesBounds(withVisibleTiles(visibleTilesMutant('no-margin')), asm)
    );
  });
  it('visibleTiles inclusive-end (off-by-one) is killed by the end-exclusive block', () => {
    assertMutantKilled('visibleTiles: inclusive-end', () =>
      assertVisibleTilesEndExclusive(withVisibleTiles(visibleTilesMutant('inclusive-end')), asm)
    );
  });
  it('visibleTiles no-left-clamp (negative indices) is killed by the left-clamp block', () => {
    assertMutantKilled('visibleTiles: no-left-clamp', () =>
      assertVisibleTilesLeftClamp(withVisibleTiles(visibleTilesMutant('no-left-clamp')), asm)
    );
  });

  it('CONTROL: every shared block PASSES on the correct impl (not vacuous)', () => {
    assertCorrectImplPasses('baseLevel', () => assertBaseLevel(realImpl));
    assertCorrectImplPasses('hysteresis', () => assertHysteresis(realImpl));
    assertCorrectImplPasses('prefetch', () => assertPrefetch(realImpl));
    assertCorrectImplPasses('vt-bounds', () => assertVisibleTilesBounds(realImpl, asm));
    assertCorrectImplPasses('vt-left', () => assertVisibleTilesLeftClamp(realImpl, asm));
    assertCorrectImplPasses('vt-end', () => assertVisibleTilesEndExclusive(realImpl, asm));
  });
});
