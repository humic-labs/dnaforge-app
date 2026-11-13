import type { Feature } from '../../../types';
import type { UnifiedLayout } from '../shared/track-layout';
import type { PathMapper } from '../shared/path-mapper';
import {
  AnnotationDensityAtlasBudgetExceededError,
  buildAnnotationDensityAtlas,
  densityAtlasBinBp,
  densityAtlasLevelBinBps,
  selectAnnotationDensityAtlasLevel,
  type AnnotationDensityAtlas,
  type AnnotationDensityAtlasBin,
  type AnnotationDensityAtlasLevelDiagnostics,
} from './annotation-density-atlas';
import {
  OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
  OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
} from './annotation-lod-policy';

export type OverviewBin = AnnotationDensityAtlasBin;

export type OverviewAggregationCache = {
  key: string;
  binBp: number;
  atlasLevelCount: number;
  bins: OverviewBin[];
  passthroughFeatures: Feature[];
  diagnostics: AnnotationDensityAtlasLevelDiagnostics;
};

export type RetainedOverviewBodyCache = {
  key: string;
  binBp: number;
  atlasLevelCount: number;
  bins: OverviewBin[];
  passthroughFeatures: Feature[];
};

export type OverviewDensityAtlasDiagnostics = {
  estimatedBinCount: number;
  wasCoarsened: boolean;
  budgetExceeded: boolean;
};

export type AnnotationOverviewCacheContext = {
  features: Feature[];
  genomeLength: number;
  layout: UnifiedLayout | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  minAggregateFeaturePixels: number;
  getEndBp: (feature: Feature) => number;
  getOffset: (feature: Feature) => number;
  getHalfHeight: () => number;
  getColor: (feature: Feature) => number;
  getAlpha: (feature: Feature, featureScoped: boolean) => number;
  shouldPassThrough: (feature: Feature, featureScoped: boolean) => boolean;
};

type OverviewDensityAtlasCache = {
  key: string;
  atlas: AnnotationDensityAtlas | null;
  budgetExceeded: AnnotationDensityAtlasBudgetExceededError | null;
};

const MAX_RESIDENT_DENSITY_LEVELS = 8;

function warnOutsideTests(message: string): void {
  if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
    console.warn(message);
  }
}

function densityAtlasDiagnostics(
  cache: OverviewDensityAtlasCache | null
): OverviewDensityAtlasDiagnostics {
  return {
    estimatedBinCount:
      cache?.atlas?.estimatedBinCount ?? cache?.budgetExceeded?.estimatedBinCount ?? 0,
    wasCoarsened: cache?.atlas?.wasCoarsened ?? false,
    budgetExceeded: Boolean(cache?.budgetExceeded),
  };
}

export class AnnotationOverviewCacheManager {
  private overviewAggregationCache: OverviewAggregationCache | null = null;
  private overviewDensityAtlasCache: OverviewDensityAtlasCache | null = null;
  private readonly overviewDensityLevels = new Map<string, OverviewDensityAtlasCache>();
  private retainedOverviewBodyCache: RetainedOverviewBodyCache | null = null;
  private retainedOverviewDensityAtlasCache: OverviewDensityAtlasCache | null = null;
  private readonly retainedOverviewDensityLevels = new Map<string, OverviewDensityAtlasCache>();

  lastCacheHit = false;

  invalidate(): void {
    this.overviewAggregationCache = null;
    this.overviewDensityAtlasCache = null;
    this.overviewDensityLevels.clear();
    this.retainedOverviewBodyCache = null;
    this.retainedOverviewDensityAtlasCache = null;
    this.retainedOverviewDensityLevels.clear();
    this.lastCacheHit = false;
  }

  mergedDensityAtlasDiagnostics(): OverviewDensityAtlasDiagnostics {
    return densityAtlasDiagnostics(this.overviewDensityAtlasCache);
  }

  retainedDensityAtlasDiagnostics(): OverviewDensityAtlasDiagnostics {
    return densityAtlasDiagnostics(this.retainedOverviewDensityAtlasCache);
  }

  getOverviewAggregationCache(
    path: PathMapper,
    ctx: AnnotationOverviewCacheContext
  ): OverviewAggregationCache | null {
    const atlasCache = this.getOverviewDensityAtlas(false, ctx, path.pixelsPerBp);
    if (!atlasCache.atlas) return null;
    const level = selectAnnotationDensityAtlasLevel(atlasCache.atlas, path.pixelsPerBp);
    const key = `${atlasCache.key}|level:${level.binBp.toFixed(3)}`;
    if (this.overviewAggregationCache?.key === key) {
      this.lastCacheHit = true;
      return this.overviewAggregationCache;
    }
    this.lastCacheHit = false;

    this.overviewAggregationCache = {
      key,
      binBp: level.binBp,
      atlasLevelCount: atlasCache.atlas.levels.length,
      bins: level.bins,
      passthroughFeatures: level.passthroughFeatures,
      diagnostics: level.diagnostics,
    };
    return this.overviewAggregationCache;
  }

  getRetainedOverviewBodyCache(
    path: Pick<PathMapper, 'pixelsPerBp'>,
    ctx: AnnotationOverviewCacheContext
  ): RetainedOverviewBodyCache | null {
    const atlasCache = this.getOverviewDensityAtlas(true, ctx, path.pixelsPerBp);
    if (!atlasCache.atlas) return null;
    const level = selectAnnotationDensityAtlasLevel(atlasCache.atlas, path.pixelsPerBp);
    const key = `retained-${atlasCache.key}|level:${level.binBp.toFixed(3)}`;
    if (this.retainedOverviewBodyCache?.key === key) {
      this.lastCacheHit = true;
      return this.retainedOverviewBodyCache;
    }
    this.lastCacheHit = false;

    this.retainedOverviewBodyCache = {
      key,
      binBp: level.binBp,
      atlasLevelCount: atlasCache.atlas.levels.length,
      bins: level.bins,
      passthroughFeatures: level.passthroughFeatures,
    };
    return this.retainedOverviewBodyCache;
  }

  private overviewDensityAtlasKey(featureScoped: boolean, ctx: AnnotationOverviewCacheContext) {
    const L = ctx.layout;
    return [
      'annotation-density-atlas-v2',
      featureScoped ? 'feature-scoped' : 'merged',
      ctx.genomeLength,
      ctx.features.length,
      OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
      densityAtlasBinBp(
        OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
        OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX
      ).toFixed(3),
      L?.annotationOffset?.toFixed(2) ?? '',
      L?.annotationStep?.toFixed(2) ?? '',
      L?.cdsBarOffset?.toFixed(2) ?? '',
      L?.cdsLaneStep?.toFixed(2) ?? '',
      ctx.maxAnnotationLane,
      ctx.maxCdsLane,
    ].join('|');
  }

  private getOverviewDensityAtlas(
    featureScoped: boolean,
    ctx: AnnotationOverviewCacheContext,
    pixelsPerBp: number
  ): OverviewDensityAtlasCache {
    const minBinBp = densityAtlasBinBp(
      OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
      OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX
    );
    const desiredBinBp = densityAtlasBinBp(pixelsPerBp, OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX);
    const levels = densityAtlasLevelBinBps(minBinBp, ctx.genomeLength);
    const selectedBinBp = levels.reduce((closest, candidate) =>
      Math.abs(Math.log2(candidate / desiredBinBp)) < Math.abs(Math.log2(closest / desiredBinBp))
        ? candidate
        : closest
    );
    const key = `${this.overviewDensityAtlasKey(featureScoped, ctx)}|bin:${selectedBinBp}`;
    const resident = featureScoped
      ? this.retainedOverviewDensityLevels
      : this.overviewDensityLevels;
    const existing = resident.get(key);
    if (existing) {
      resident.delete(key);
      resident.set(key, existing);
      if (featureScoped) this.retainedOverviewDensityAtlasCache = existing;
      else this.overviewDensityAtlasCache = existing;
      return existing;
    }

    let atlas: AnnotationDensityAtlas | null = null;
    let budgetExceeded: AnnotationDensityAtlasBudgetExceededError | null = null;
    try {
      atlas = buildAnnotationDensityAtlas({
        features: ctx.features,
        genomeLength: ctx.genomeLength,
        sampleScreenPx: OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
        minBinBp: selectedBinBp,
        maxBinBp: selectedBinBp,
        minVisiblePixels: 0,
        aggregateBelowPixels: featureScoped ? undefined : ctx.minAggregateFeaturePixels,
        featureScoped,
        getEndBp: ctx.getEndBp,
        getOffset: ctx.getOffset,
        getHalfHeight: ctx.getHalfHeight,
        getColor: ctx.getColor,
        getAlpha: (feature) => ctx.getAlpha(feature, featureScoped),
        shouldPassThrough: (feature) => ctx.shouldPassThrough(feature, featureScoped),
      });
    } catch (error) {
      if (!(error instanceof AnnotationDensityAtlasBudgetExceededError)) throw error;
      budgetExceeded = error;
      warnOutsideTests(
        `[WebGL] Annotation density atlas disabled: estimated ${error.estimatedBinCount} bins exceeds budget ${error.maxTotalBins}.`
      );
    }

    const cache = { key, atlas, budgetExceeded };
    resident.set(key, cache);
    while (resident.size > MAX_RESIDENT_DENSITY_LEVELS) {
      resident.delete(resident.keys().next().value!);
    }
    if (featureScoped) {
      this.retainedOverviewDensityAtlasCache = cache;
    } else {
      this.overviewDensityAtlasCache = cache;
    }
    return cache;
  }
}
