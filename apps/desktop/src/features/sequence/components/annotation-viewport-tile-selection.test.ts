// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { selectActiveAnnotationViewportTile } from './annotation-viewport-tile-selection';

function tile(startBp: number, endBp: number, tag = `${startBp}-${endBp}`) {
  return { startBp, endBp, tag };
}

describe('selectActiveAnnotationViewportTile  no-disappear contract)', () => {
  it('returns null when there are no tiles', () => {
    expect(selectActiveAnnotationViewportTile([], { start: 0, end: 100 })).toBeNull();
  });

  it('returns the newest tile when the viewport is unknown', () => {
    const tiles = [tile(0, 100), tile(200, 300)];
    expect(selectActiveAnnotationViewportTile(tiles, null)?.tag).toBe('200-300');
  });

  it('returns a tile that FULLY covers the viewport (newest-first)', () => {
    const tiles = [tile(0, 1_000_000)];
    const sel = selectActiveAnnotationViewportTile(tiles, { start: 400_000, end: 410_000 });
    expect(sel?.tag).toBe('0-1000000');
  });

  it('NO-DISAPPEAR: when the viewport pans just past full coverage, keeps the best-overlapping tile (not null)', () => {
    const tiles = [tile(0, 100_000)];
    const sel = selectActiveAnnotationViewportTile(tiles, { start: 50_000, end: 100_001 });
    expect(sel).not.toBeNull();
    expect(sel?.tag).toBe('0-100000');
  });

  it('NO-DISAPPEAR: prefers the tile with the LARGEST overlap when none fully covers', () => {
    const tiles = [tile(0, 60_000), tile(40_000, 120_000)];
    const sel = selectActiveAnnotationViewportTile(tiles, { start: 55_000, end: 130_000 });
    expect(sel?.tag).toBe('40000-120000');
  });

  it('does not retain a stale tile when only a sliver overlaps the viewport', () => {
    const tiles = [tile(0, 100_000)];
    const sel = selectActiveAnnotationViewportTile(tiles, { start: 99_999, end: 199_999 });
    expect(sel).toBeNull();
  });

  it('blanks (null) when the viewport shares no meaningful overlap with any tile', () => {
    const tiles = [tile(0, 100_000)];
    const sel = selectActiveAnnotationViewportTile(tiles, { start: 500_000, end: 600_000 });
    expect(sel).toBeNull();
  });

  it('touching-but-not-overlapping ranges do not count as overlap', () => {
    const tiles = [tile(0, 100_000)];
    const sel = selectActiveAnnotationViewportTile(tiles, { start: 100_000, end: 200_000 });
    expect(sel).toBeNull();
  });
});
