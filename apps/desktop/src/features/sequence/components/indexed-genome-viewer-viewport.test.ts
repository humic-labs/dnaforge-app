// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AnnotationViewportTileState } from './indexed-genome-viewer-viewport';
import {
  MAX_RETAINED_ANNOTATION_VIEWPORT_TILES,
  annotationViewportCoverageFromTile,
  annotationViewportTileFromGenomeTile,
  retainAnnotationViewportCoverages,
  retainAnnotationViewportTiles,
  sceneViewportPublicationKey,
  sequenceViewportRangesEqual,
  sameStringArray,
  shouldDeferAnnotationViewportTileCommit,
  uniqueSorted,
} from './indexed-genome-viewer-viewport';

function tile(overrides: Partial<AnnotationViewportTileState> = {}): AnnotationViewportTileState {
  return {
    startBp: 0,
    endBp: 100,
    generation: 1,
    state: 'ready',
    fidelity: 'exact',
    featureModel: 'glyph' as AnnotationViewportTileState['featureModel'],
    cacheState: 'warm' as AnnotationViewportTileState['cacheState'],
    recordCount: 0,
    byteCount: 0,
    layerTypes: [],
    features: [],
    ...overrides,
  };
}

describe('indexed genome viewer viewport helpers', () => {
  it('keeps unique sorted names and compares arrays by value', () => {
    expect(uniqueSorted(['b', '', 'a', 'b'])).toEqual(['a', 'b']);
    expect(sameStringArray(['mRNA', 'CDS'], ['mRNA', 'CDS'])).toBe(true);
    expect(sameStringArray(['mRNA'], ['CDS'])).toBe(false);
  });

  it('retains viewport tiles by range and generation, capped', () => {
    const first = tile({ startBp: 0, endBp: 10, generation: 1 });
    const second = tile({ startBp: 10, endBp: 20, generation: 1 });
    const replaced = tile({ startBp: 0, endBp: 10, generation: 1, recordCount: 9 });
    expect(retainAnnotationViewportTiles([first], replaced)).toEqual([replaced]);
    const grown = Array.from({ length: MAX_RETAINED_ANNOTATION_VIEWPORT_TILES }, (_, i) =>
      tile({ startBp: i, endBp: i + 1, generation: i })
    );
    const extra = tile({ startBp: 99, endBp: 100, generation: 99 });
    expect(retainAnnotationViewportTiles(grown, extra)).toHaveLength(
      MAX_RETAINED_ANNOTATION_VIEWPORT_TILES
    );
    expect(retainAnnotationViewportTiles(grown, extra).at(-1)).toEqual(extra);
    expect(
      retainAnnotationViewportCoverages([{ startBp: 0, endBp: 10 }], { startBp: 0, endBp: 10 })
    ).toEqual([{ startBp: 0, endBp: 10 }]);
  });

  it('compares sequence ranges and publishes a stable single-chrom key', () => {
    expect(sequenceViewportRangesEqual(null, null)).toBe(true);
    expect(sequenceViewportRangesEqual({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true);
    expect(sequenceViewportRangesEqual({ start: 1, end: 2 }, { start: 1, end: 3 })).toBe(false);
    expect(sceneViewportPublicationKey(null)).toBeNull();
    expect(sceneViewportPublicationKey({ start: 0, end: 1000 })).toMatch(/^single-chrom-data:/);
  });

  it('maps a genome tile onto the viewer viewport tile and coverage', () => {
    const mapped = annotationViewportTileFromGenomeTile(
      {
        start: 10,
        end: 20,
        generation: 4,
        state: 'ready',
        fidelity: 'exact',
        laneEpoch: undefined,
        featureModel: undefined,
        cacheState: undefined,
        recordCount: 3,
        byteCount: 12,
        layerTypes: undefined,
        features: [{ id: 1 } as never],
      } as never,
      'epoch-fallback'
    );
    expect(mapped).toMatchObject({
      startBp: 10,
      endBp: 20,
      generation: 4,
      laneEpoch: 'epoch-fallback',
      featureModel: 'raw-gff3',
      cacheState: 'none',
      layerTypes: [],
      recordCount: 3,
    });
    expect(mapped.features).toHaveLength(1);
    expect(annotationViewportCoverageFromTile({ state: 'ready', start: 10, end: 20 })).toEqual({
      startBp: 10,
      endBp: 20,
    });
    expect(annotationViewportCoverageFromTile({ state: 'loading', start: 10, end: 20 })).toBeNull();
    expect(shouldDeferAnnotationViewportTileCommit(false, 0)).toBe(false);
    expect(shouldDeferAnnotationViewportTileCommit(true, 0)).toBe(true);
    expect(shouldDeferAnnotationViewportTileCommit(false, 16)).toBe(true);
  });
});
