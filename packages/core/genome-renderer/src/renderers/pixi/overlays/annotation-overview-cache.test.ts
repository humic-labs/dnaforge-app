import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  AnnotationOverviewCacheManager,
  type AnnotationOverviewCacheContext,
} from './annotation-overview-cache';
import {
  buildAnnotationDensityAtlas,
  densityAtlasBinBp,
  selectAnnotationDensityAtlasLevel,
} from './annotation-density-atlas';
import {
  OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
  OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
} from './annotation-lod-policy';

function createPath(pixelsPerBp: number): PathMapper {
  return { pixelsPerBp } as PathMapper;
}

function createContext(features: Feature[]): AnnotationOverviewCacheContext {
  return {
    features,
    genomeLength: 10_000,
    layout: null,
    maxAnnotationLane: 0,
    maxCdsLane: 0,
    minAggregateFeaturePixels: 2,
    getEndBp: (feature) => (feature.end > feature.start ? feature.end : feature.end + 10_000),
    getOffset: () => -14,
    getHalfHeight: () => 7,
    getColor: (feature) => feature.color ?? 0x3b82f6,
    getAlpha: (feature, featureScoped) =>
      featureScoped && feature.qualifiers?.source === 'pLannotate-draft' ? 0.35 : 0.85,
    shouldPassThrough: (feature, featureScoped) =>
      featureScoped
        ? feature.type === 'CDS' && Boolean(feature.segments?.length)
        : feature.qualifiers?.source === 'pLannotate-draft' ||
          (feature.type === 'CDS' && Boolean(feature.segments?.length)),
  };
}

describe('AnnotationOverviewCacheManager', () => {
  it('builds the selected overview level with the same bins as the full atlas', () => {
    const manager = new AnnotationOverviewCacheManager();
    const ctx = createContext([
      {
        id: 1,
        type: 'gene',
        start: 100,
        end: 800,
        direction: 'forward',
        displayName: 'first',
        color: 0x22c55e,
        lane: 0,
      },
      {
        id: 2,
        type: 'gene',
        start: 500,
        end: 1500,
        direction: 'reverse',
        displayName: 'second',
        color: 0x3b82f6,
        lane: 0,
      },
      {
        id: 3,
        type: 'CDS',
        start: 4000,
        end: 4300,
        direction: 'forward',
        displayName: 'third',
        color: 0x22c55e,
        lane: 0,
        segments: [{ start: 4000, end: 4300 }],
      },
    ]);
    const fullAtlas = buildAnnotationDensityAtlas({
      features: ctx.features,
      genomeLength: ctx.genomeLength,
      sampleScreenPx: OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
      minBinBp: densityAtlasBinBp(
        OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
        OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX
      ),
      maxBinBp: ctx.genomeLength,
      minVisiblePixels: 0,
      aggregateBelowPixels: ctx.minAggregateFeaturePixels,
      getEndBp: ctx.getEndBp,
      getOffset: ctx.getOffset,
      getHalfHeight: ctx.getHalfHeight,
      getColor: ctx.getColor,
      getAlpha: (feature) => ctx.getAlpha(feature, false),
      shouldPassThrough: (feature) => ctx.shouldPassThrough(feature, false),
    });

    const first = manager.getOverviewAggregationCache(createPath(0.0002), ctx);
    for (const pixelsPerBp of [0.0002, 0.001, 0.01]) {
      const expected = selectAnnotationDensityAtlasLevel(fullAtlas, pixelsPerBp);
      const actual = manager.getOverviewAggregationCache(createPath(pixelsPerBp), ctx);
      expect(actual?.binBp).toBe(expected.binBp);
      expect(actual?.bins).toEqual(expected.bins);
      expect(actual?.passthroughFeatures).toEqual(expected.passthroughFeatures);
      expect(actual?.atlasLevelCount).toBe(1);
    }
    expect(manager.getOverviewAggregationCache(createPath(0.0002), ctx)?.bins).toBe(first?.bins);
  });

  it('centralizes overview aggregation cache hits and invalidation', () => {
    const manager = new AnnotationOverviewCacheManager();
    const ctx = createContext([
      {
        id: 1,
        type: 'gene',
        start: 1000,
        end: 1200,
        direction: 'none',
        displayName: 'gene',
        color: 0x22c55e,
        lane: 0,
      },
    ]);
    const path = createPath(0.001);

    const first = manager.getOverviewAggregationCache(path, ctx);
    expect(first).not.toBeNull();
    expect(manager.lastCacheHit).toBe(false);

    const second = manager.getOverviewAggregationCache(path, ctx);
    expect(second).toBe(first);
    expect(manager.lastCacheHit).toBe(true);

    manager.invalidate();
    const afterInvalidate = manager.getOverviewAggregationCache(path, ctx);
    expect(afterInvalidate).not.toBe(first);
    expect(manager.lastCacheHit).toBe(false);
  });

  it('keeps spliced CDS features as passthroughs for retained hit parity', () => {
    const manager = new AnnotationOverviewCacheManager();
    const splicedCds: Feature = {
      id: 2,
      type: 'CDS',
      start: 1000,
      end: 1700,
      direction: 'forward',
      displayName: 'spliced',
      color: 0x3b82f6,
      lane: 0,
      segments: [
        { start: 1000, end: 1200 },
        { start: 1500, end: 1700 },
      ],
      qualifiers: { _locationString: 'join(1000..1200,1500..1700)' },
    };

    const cache = manager.getRetainedOverviewBodyCache(
      createPath(0.001),
      createContext([splicedCds])
    );
    expect(cache?.passthroughFeatures.map((feature) => feature.id)).toContain(splicedCds.id);
  });
});
