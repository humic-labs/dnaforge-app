import { describe, expect, it } from 'vitest';
import {
  childTiles,
  crossoverLevel,
  isRasterLevel,
  parentTile,
  selectLevel,
  tileCountAtLevel,
  tileIndexForBp,
  tileKey,
  tileRangeBp,
  tileSpanBp,
  visibleTiles,
} from './tile-pyramid-coords';

const L = 1_048_576;
const HUMAN_L = 3.088e9;

describe('tileCountAtLevel', () => {
  it('is 2^z', () => {
    expect(tileCountAtLevel(0)).toBe(1);
    expect(tileCountAtLevel(1)).toBe(2);
    expect(tileCountAtLevel(10)).toBe(1024);
    expect(tileCountAtLevel(24)).toBe(16_777_216);
  });
});

describe('tileSpanBp', () => {
  it('divides the genome into 2^z equal spans', () => {
    expect(tileSpanBp(L, 0)).toBe(L);
    expect(tileSpanBp(L, 1)).toBe(L / 2);
    expect(tileSpanBp(L, 20)).toBe(1);
  });

  it('z=0 spans the whole genome', () => {
    expect(tileSpanBp(HUMAN_L, 0)).toBe(HUMAN_L);
  });

  it('can be fractional when L is not a power of two', () => {
    expect(tileSpanBp(1000, 2)).toBe(250);
    expect(tileSpanBp(1000, 3)).toBe(125);
    expect(tileSpanBp(100, 3)).toBeCloseTo(12.5, 10);
  });
});

describe('tileIndexForBp', () => {
  it('z=0: everything lands in the single tile 0', () => {
    expect(tileIndexForBp(L, 0, 0)).toBe(0);
    expect(tileIndexForBp(L, 0, L / 2)).toBe(0);
    expect(tileIndexForBp(L, 0, L - 1)).toBe(0);
  });

  it('maps bp to the half-open tile [i*span, (i+1)*span)', () => {
    const span = L / 4;
    expect(tileIndexForBp(L, 2, 0)).toBe(0);
    expect(tileIndexForBp(L, 2, span - 1)).toBe(0);
    expect(tileIndexForBp(L, 2, span)).toBe(1);
    expect(tileIndexForBp(L, 2, 2 * span)).toBe(2);
    expect(tileIndexForBp(L, 2, 3 * span)).toBe(3);
    expect(tileIndexForBp(L, 2, L - 1)).toBe(3);
  });

  it('bp at exactly L clamps to the last tile (one past the genome)', () => {
    expect(tileIndexForBp(L, 2, L)).toBe(3);
    expect(tileIndexForBp(L, 10, L)).toBe(1023);
    expect(tileIndexForBp(L, 0, L)).toBe(0);
  });

  it('bp beyond L still clamps to the last tile', () => {
    expect(tileIndexForBp(L, 4, L * 2)).toBe(15);
  });

  it('negative bp clamps to tile 0', () => {
    expect(tileIndexForBp(L, 5, -1)).toBe(0);
    expect(tileIndexForBp(L, 5, -1e9)).toBe(0);
  });

  it('fractional bp boundaries floor into the correct tile', () => {
    expect(tileIndexForBp(1000, 3, 124.999)).toBe(0);
    expect(tileIndexForBp(1000, 3, 125)).toBe(1);
    expect(tileIndexForBp(1000, 3, 125.0001)).toBe(1);
    expect(tileIndexForBp(1000, 3, 999.999)).toBe(7);
  });

  it('round-trips against tileRangeBp at every tile of a level', () => {
    const z = 6;
    const count = tileCountAtLevel(z);
    for (let i = 0; i < count; i++) {
      const { startBp, endBp } = tileRangeBp(L, z, i);
      expect(tileIndexForBp(L, z, startBp)).toBe(i);
      expect(tileIndexForBp(L, z, (startBp + endBp) / 2)).toBe(i);
      const expectedNext = Math.min(i + 1, count - 1);
      expect(tileIndexForBp(L, z, endBp)).toBe(expectedNext);
    }
  });
});

describe('tileRangeBp', () => {
  it('tile 0 starts at 0; the last tile ends at L', () => {
    expect(tileRangeBp(L, 3, 0)).toEqual({ startBp: 0, endBp: L / 8 });
    expect(tileRangeBp(L, 3, 7)).toEqual({ startBp: (7 * L) / 8, endBp: L });
  });

  it('z=0 is the whole genome', () => {
    expect(tileRangeBp(L, 0, 0)).toEqual({ startBp: 0, endBp: L });
  });

  it('adjacent tiles are contiguous (no gap, no overlap)', () => {
    const z = 5;
    const count = tileCountAtLevel(z);
    for (let i = 0; i < count - 1; i++) {
      expect(tileRangeBp(L, z, i).endBp).toBe(tileRangeBp(L, z, i + 1).startBp);
    }
  });

  it('produces fractional boundaries for non-power-of-two L', () => {
    expect(tileRangeBp(100, 3, 1)).toEqual({ startBp: 12.5, endBp: 25 });
  });
});

describe('visibleTiles', () => {
  it('a viewport fully inside one tile yields that single tile', () => {
    expect(visibleTiles(L, 4, 1000, 2000)).toEqual({ first: 0, last: 0 });
  });

  it('a viewport spanning several tiles yields the inclusive index range', () => {
    const span = L / 16;
    expect(visibleTiles(L, 4, span * 2 + 10, span * 5 + 10)).toEqual({
      first: 2,
      last: 5,
    });
  });

  it('does NOT include the next tile when the viewport ends exactly on a boundary', () => {
    const span = L / 16;
    expect(visibleTiles(L, 4, 0, span * 3)).toEqual({ first: 0, last: 2 });
  });

  it('genome-wide viewport covers every tile at the level', () => {
    expect(visibleTiles(L, 3, 0, L)).toEqual({ first: 0, last: 7 });
    expect(visibleTiles(L, 0, 0, L)).toEqual({ first: 0, last: 0 });
  });

  it('clamps a viewport that runs past the genome ends', () => {
    expect(visibleTiles(L, 4, -5000, L + 5000)).toEqual({ first: 0, last: 15 });
  });

  it('a zero-width viewport collapses to the single tile at the point', () => {
    const span = L / 16;
    expect(visibleTiles(L, 4, span * 3, span * 3)).toEqual({ first: 3, last: 3 });
  });

  it('an inverted viewport (end <= start) collapses to the start tile', () => {
    const span = L / 16;
    expect(visibleTiles(L, 4, span * 5, span * 2)).toEqual({ first: 5, last: 5 });
  });
});

describe('selectLevel', () => {
  const screenPx = 5194;

  it('genome-wide (visibleBp = L) selects a shallow level', () => {
    expect(selectLevel({ L: HUMAN_L, visibleBp: HUMAN_L, screenPx, maxLevel: 24 })).toBe(3);
  });

  it('mid zoom (visibleBp = 1e6) selects a mid level', () => {
    expect(selectLevel({ L: HUMAN_L, visibleBp: 1e6, screenPx, maxLevel: 24 })).toBe(15);
  });

  it('deep zoom (visibleBp = 1e3) selects a deep level, clamped to maxLevel', () => {
    expect(selectLevel({ L: HUMAN_L, visibleBp: 1e3, screenPx, maxLevel: 24 })).toBe(24);
  });

  it('respects maxLevel (clamps high)', () => {
    expect(selectLevel({ L: HUMAN_L, visibleBp: 1e3, screenPx, maxLevel: 18 })).toBe(18);
  });

  it('clamps low at 0 when the screen is smaller than one genome-wide tile', () => {
    expect(selectLevel({ L: HUMAN_L, visibleBp: HUMAN_L, screenPx: 100, maxLevel: 24 })).toBe(0);
  });

  it('honors a non-default tilePx (smaller tiles ⇒ deeper level)', () => {
    const big = selectLevel({
      L: HUMAN_L,
      visibleBp: 1e6,
      screenPx,
      tilePx: 128,
      maxLevel: 24,
    });
    const small = selectLevel({
      L: HUMAN_L,
      visibleBp: 1e6,
      screenPx,
      tilePx: 2048,
      maxLevel: 24,
    });
    expect(big).toBe(17);
    expect(small).toBe(13);
  });

  it('realizes roughly screenPx/tilePx tiles spanning the screen at the chosen level', () => {
    const visibleBp = 1e6;
    const z = selectLevel({ L: HUMAN_L, visibleBp, screenPx, maxLevel: 24 });
    const tilesPerScreen = visibleBp / tileSpanBp(HUMAN_L, z);
    const ideal = screenPx / 512;
    expect(tilesPerScreen).toBeGreaterThan(ideal / Math.SQRT2);
    expect(tilesPerScreen).toBeLessThan(ideal * Math.SQRT2);
  });

  it('degenerate inputs (zero/negative visibleBp or screenPx) return 0', () => {
    expect(selectLevel({ L: HUMAN_L, visibleBp: 0, screenPx, maxLevel: 24 })).toBe(0);
    expect(selectLevel({ L: HUMAN_L, visibleBp: -1, screenPx, maxLevel: 24 })).toBe(0);
    expect(selectLevel({ L: HUMAN_L, visibleBp: 1e6, screenPx: 0, maxLevel: 24 })).toBe(0);
  });
});

describe('parentTile', () => {
  it('halves the index and decrements the level', () => {
    expect(parentTile(5, 17)).toEqual({ z: 4, i: 8 });
    expect(parentTile(5, 16)).toEqual({ z: 4, i: 8 });
    expect(parentTile(1, 1)).toEqual({ z: 0, i: 0 });
  });

  it('is null at the root (z=0)', () => {
    expect(parentTile(0, 0)).toBeNull();
  });
});

describe('childTiles', () => {
  it('splits a tile into two at the next level', () => {
    expect(childTiles(3, 4)).toEqual([
      { z: 4, i: 8 },
      { z: 4, i: 9 },
    ]);
    expect(childTiles(0, 0)).toEqual([
      { z: 1, i: 0 },
      { z: 1, i: 1 },
    ]);
  });

  it('parent ↔ child are inverse (both children point back to the parent)', () => {
    const z = 6;
    const i = 21;
    const [a, b] = childTiles(z, i);
    expect(parentTile(a.z, a.i)).toEqual({ z, i });
    expect(parentTile(b.z, b.i)).toEqual({ z, i });
  });

  it('a child covers exactly half its parent bp range', () => {
    const z = 4;
    const i = 5;
    const parentRange = tileRangeBp(L, z, i);
    const [a, b] = childTiles(z, i);
    const aRange = tileRangeBp(L, a.z, a.i);
    const bRange = tileRangeBp(L, b.z, b.i);
    expect(aRange.startBp).toBe(parentRange.startBp);
    expect(aRange.endBp).toBe(bRange.startBp);
    expect(bRange.endBp).toBe(parentRange.endBp);
  });
});

describe('tileKey', () => {
  it('is the stable "z/i" form', () => {
    expect(tileKey(0, 0)).toBe('0/0');
    expect(tileKey(5, 17)).toBe('5/17');
    expect(tileKey(24, 16_777_215)).toBe('24/16777215');
  });

  it('is collision-free across distinct (z, i) pairs', () => {
    const seen = new Set<string>();
    for (let z = 0; z <= 8; z++) {
      for (let i = 0; i < tileCountAtLevel(z); i++) {
        const key = tileKey(z, i);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('human-scale (3 Gb) precision', () => {
  it('tileIndexForBp is exact at deep levels without forming bp*2^z', () => {
    const z = 24;
    const span = tileSpanBp(HUMAN_L, z);
    expect(span).toBeCloseTo(HUMAN_L / 2 ** 24, 6);
    const start = tileRangeBp(HUMAN_L, z, 1_000_000).startBp;
    expect(tileIndexForBp(HUMAN_L, z, start)).toBe(1_000_000);
  });

  it('the last tile at a deep level ends exactly at L', () => {
    const z = 20;
    const last = tileCountAtLevel(z) - 1;
    expect(tileRangeBp(HUMAN_L, z, last).endBp).toBe(HUMAN_L);
    expect(tileIndexForBp(HUMAN_L, z, HUMAN_L)).toBe(last);
  });

  it('boundaries stay sub-texel-exact even where i*L exceeds MAX_SAFE_INTEGER (documented)', () => {
    const z = 24;
    const count = 2 ** z;
    const i = count - 1;
    expect(i * HUMAN_L).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const span = tileSpanBp(HUMAN_L, z);
    const idealStart = (i * HUMAN_L) / count;
    expect(Math.abs(tileRangeBp(HUMAN_L, z, i).startBp - idealStart)).toBeLessThan(span);
    expect(tileIndexForBp(HUMAN_L, z, tileRangeBp(HUMAN_L, z, i).startBp)).toBe(i);
  });
});

describe('crossoverLevel', () => {
  it('pins the architecture worked case: sparse genome (median span 154,400 bp) ⇒ z_xover=6', () => {
    expect(
      crossoverLevel({
        L: HUMAN_L,
        medianFeatureSpanBp: 154_400,
        tilePx: 512,
        crossoverPx: 1.0,
        maxLevel: 24,
      })
    ).toBe(6);
  });

  it('pins the architecture worked case: dense genome (median span 1,544 bp) ⇒ z_xover=12', () => {
    expect(
      crossoverLevel({
        L: HUMAN_L,
        medianFeatureSpanBp: 1_544,
        tilePx: 512,
        crossoverPx: 1.0,
        maxLevel: 24,
      })
    ).toBe(12);
  });

  it('defaults tilePx=512 and crossoverPx=1.0 (omitting them reproduces the worked cases)', () => {
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 154_400, maxLevel: 24 })).toBe(6);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 1_544, maxLevel: 24 })).toBe(12);
  });

  it('takes the SMALLEST level whose median-feature width reaches crossoverPx', () => {
    const z = crossoverLevel({
      L: HUMAN_L,
      medianFeatureSpanBp: 154_400,
      tilePx: 512,
      crossoverPx: 1.0,
      maxLevel: 24,
    });
    const widthPxAt = (level: number) => (154_400 * 512) / tileSpanBp(HUMAN_L, level);
    expect(widthPxAt(z)).toBeGreaterThanOrEqual(1.0);
    expect(widthPxAt(z - 1)).toBeLessThan(1.0);
  });

  it('density self-adjusts: denser features (smaller span) ⇒ strictly higher z_xover (monotonic)', () => {
    const spans = [1_544, 15_440, 154_400, 1_544_000];
    const levels = spans.map((medianFeatureSpanBp) =>
      crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp, maxLevel: 24 })
    );
    expect(levels).toEqual([12, 9, 6, 2]);
    for (let k = 0; k < levels.length - 1; k++) {
      expect(levels[k]).toBeGreaterThan(levels[k + 1]);
    }
  });

  it('clamps HIGH to maxLevel (very dense genome would otherwise cross over past the pyramid)', () => {
    const z = crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 1, maxLevel: 18 });
    expect(z).toBe(18);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 1, maxLevel: 10 })).toBe(10);
  });

  it('clamps LOW to 0 (a feature already wider than crossoverPx genome-wide ⇒ vector everywhere)', () => {
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: HUMAN_L, maxLevel: 24 })).toBe(0);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: HUMAN_L / 2, maxLevel: 24 })).toBe(0);
  });

  it('a larger crossoverPx threshold pushes z_xover higher (needs more pixels of width)', () => {
    const base = crossoverLevel({
      L: HUMAN_L,
      medianFeatureSpanBp: 154_400,
      crossoverPx: 1.0,
      maxLevel: 24,
    });
    const wider = crossoverLevel({
      L: HUMAN_L,
      medianFeatureSpanBp: 154_400,
      crossoverPx: 4.0,
      maxLevel: 24,
    });
    expect(base).toBe(6);
    expect(wider).toBe(8);
  });

  it('a smaller tilePx pushes z_xover higher (fewer texels per tile ⇒ less width per level)', () => {
    const base = crossoverLevel({
      L: HUMAN_L,
      medianFeatureSpanBp: 154_400,
      tilePx: 512,
      maxLevel: 24,
    });
    const small = crossoverLevel({
      L: HUMAN_L,
      medianFeatureSpanBp: 154_400,
      tilePx: 128,
      maxLevel: 24,
    });
    expect(base).toBe(6);
    expect(small).toBe(8);
  });

  it('guards non-positive / non-finite medianFeatureSpanBp ⇒ stay raster everywhere (maxLevel)', () => {
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 0, maxLevel: 24 })).toBe(24);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: -5, maxLevel: 24 })).toBe(24);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: NaN, maxLevel: 24 })).toBe(24);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: Infinity, maxLevel: 24 })).toBe(24);
    expect(crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 0, maxLevel: 7 })).toBe(7);
  });

  it('guards bad L / tilePx / crossoverPx ⇒ cross over immediately (0)', () => {
    expect(crossoverLevel({ L: 0, medianFeatureSpanBp: 1_544, maxLevel: 24 })).toBe(0);
    expect(crossoverLevel({ L: -1, medianFeatureSpanBp: 1_544, maxLevel: 24 })).toBe(0);
    expect(crossoverLevel({ L: NaN, medianFeatureSpanBp: 1_544, maxLevel: 24 })).toBe(0);
    expect(
      crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 1_544, tilePx: 0, maxLevel: 24 })
    ).toBe(0);
    expect(
      crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 1_544, crossoverPx: 0, maxLevel: 24 })
    ).toBe(0);
    expect(
      crossoverLevel({
        L: HUMAN_L,
        medianFeatureSpanBp: 1_544,
        crossoverPx: -1,
        maxLevel: 24,
      })
    ).toBe(0);
  });
});

describe('isRasterLevel', () => {
  it('levels below the crossover are raster; the crossover level and above are vector', () => {
    const zXover = 6;
    expect(isRasterLevel(0, zXover)).toBe(true);
    expect(isRasterLevel(5, zXover)).toBe(true);
    expect(isRasterLevel(6, zXover)).toBe(false);
    expect(isRasterLevel(7, zXover)).toBe(false);
    expect(isRasterLevel(24, zXover)).toBe(false);
  });

  it('zXover=0 ⇒ vector everywhere (no raster levels)', () => {
    for (let z = 0; z <= 24; z++) {
      expect(isRasterLevel(z, 0)).toBe(false);
    }
  });

  it('a large zXover (e.g. maxLevel) ⇒ raster everywhere below it', () => {
    const zXover = 24;
    for (let z = 0; z < 24; z++) {
      expect(isRasterLevel(z, zXover)).toBe(true);
    }
    expect(isRasterLevel(24, zXover)).toBe(false);
  });

  it('agrees with crossoverLevel on the worked case (raster < 6, vector >= 6)', () => {
    const zXover = crossoverLevel({ L: HUMAN_L, medianFeatureSpanBp: 154_400, maxLevel: 24 });
    expect(zXover).toBe(6);
    expect(isRasterLevel(zXover - 1, zXover)).toBe(true);
    expect(isRasterLevel(zXover, zXover)).toBe(false);
  });
});
