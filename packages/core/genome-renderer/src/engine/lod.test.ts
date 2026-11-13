import { describe, it, expect } from 'vitest';
import type { Chromosome } from '../chromosome';
import { buildAssembly } from '../assembly-layout';
import {
  bpPerPx,
  baseLevelForBpPerPx,
  pickLevel,
  shouldPrefetchCoarser,
  shouldPrefetchFiner,
  visibleTiles,
  PREFETCH_MARGIN_TILES,
} from './lod';
import { binBp } from './constants';
import {
  assertBaseLevel,
  assertHysteresis,
  assertPrefetch,
  assertVisibleTilesBounds,
  assertVisibleTilesLeftClamp,
  assertVisibleTilesRightClamp,
  assertVisibleTilesEndExclusive,
  type LodImpl,
} from './lod-assertions';

function chrom(id: string, length: number): Chromosome {
  return { id, displayName: id, length, cytobands: [] };
}
const asm = buildAssembly('test', 'test', [chrom('chr1', 10_000), chrom('chr2', 8_000)]);

const impl: LodImpl = {
  bpPerPx,
  baseLevelForBpPerPx,
  pickLevel,
  shouldPrefetchCoarser,
  shouldPrefetchFiner,
  visibleTiles,
  PREFETCH_MARGIN_TILES,
};

describe('engine/lod — LOD pick + visible tiles', () => {
  it('bpPerPx = (end-start)/px', () => {
    expect(bpPerPx({ globalStart: 0, globalEnd: 1000, viewportPx: 100 })).toBe(10);
  });

  it('base level = finest L with binBp(L) >= bpPerPx', () => assertBaseLevel(impl));
  it('hysteresis: sticks within band, switches only past the edges', () => assertHysteresis(impl));
  it('zoom-in hysteresis keeps presented coverage bins within two density columns', () => {
    const view = { globalStart: 0, globalEnd: 373_000, viewportPx: 1_000 };
    const level = pickLevel(view, 22, 10);

    expect(binBp(level) / bpPerPx(view)).toBeLessThanOrEqual(2);
    expect(level).toBe(9);
  });
  it('prefetch the adjacent handoff LOD before switching levels', () => assertPrefetch(impl));

  it('visibleTiles bounds = core tiles + 1-tile margin', () => assertVisibleTilesBounds(impl, asm));
  it('visibleTiles orders core viewport tiles before speculative margin tiles', () => {
    const tiles = visibleTiles({ globalStart: 3000, globalEnd: 5000, viewportPx: 1000 }, 0, asm, 2);
    expect(tiles.map((t) => t.index)).toEqual([2, 3, 4, 1, 5, 0, 6]);
  });
  it('visibleTiles left-clamps to >= 0', () => assertVisibleTilesLeftClamp(impl, asm));
  it('visibleTiles right-clamps to maxTileIndex', () => assertVisibleTilesRightClamp(impl, asm));
  it('visibleTiles end-exclusive on the global range', () =>
    assertVisibleTilesEndExclusive(impl, asm));

  it('PREFETCH_MARGIN_TILES is 1', () => expect(PREFETCH_MARGIN_TILES).toBe(1));

  it('a tile straddling the chr1/chr2 seam fans out to BOTH chromosomes', () => {
    const tiles = visibleTiles({ globalStart: 9000, globalEnd: 11000, viewportPx: 1000 }, 12, asm);
    const seamTile = tiles.find((t) => t.globalStart <= 9000 && t.globalEnd > 11000);
    expect(seamTile).toBeDefined();
    const chroms = seamTile!.segments.map((s) => s.chrom);
    expect(chroms).toContain('chr1');
    expect(chroms).toContain('chr2');
  });
});
