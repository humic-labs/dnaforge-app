import { afterEach, describe, expect, it } from 'vitest';

import {
  genomeTilePyramidEnabled,
  overviewGlyphTilesEnabled,
  retainedOverviewAnnotationsEnabled,
} from './retained-overview-style';

type OverviewFlagGlobal = typeof globalThis & {
  __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
  __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean;
  __WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES?: boolean;
};

function clearOverviewFlags(): void {
  const g = globalThis as OverviewFlagGlobal;
  delete g.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
  delete g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID;
  delete g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES;
}

describe('retained overview flag polarity', () => {
  afterEach(clearOverviewFlags);

  it('keeps retained overview annotations on unless explicitly disabled', () => {
    clearOverviewFlags();
    expect(retainedOverviewAnnotationsEnabled()).toBe(true);
    (globalThis as OverviewFlagGlobal).__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = false;
    expect(retainedOverviewAnnotationsEnabled()).toBe(false);
  });

  it('keeps the detail tile pyramid off until opted in', () => {
    clearOverviewFlags();
    expect(genomeTilePyramidEnabled()).toBe(false);
    (globalThis as OverviewFlagGlobal).__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = true;
    expect(genomeTilePyramidEnabled()).toBe(true);
  });

  it('keeps overview glyph tiles off until opted in', () => {
    clearOverviewFlags();
    expect(overviewGlyphTilesEnabled()).toBe(false);
    (globalThis as OverviewFlagGlobal).__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = true;
    expect(overviewGlyphTilesEnabled()).toBe(true);
  });
});
