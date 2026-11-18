import type { Feature } from '../../../types';
import type { UnifiedLayout } from '../shared/track-layout';
import type { PathMapper } from '../shared/path-mapper';
import {
  AnnotationDensityAtlasBudgetExceededError,
  DEFAULT_DENSITY_ATLAS_MAX_TOTAL_BINS,
  buildAnnotationDensityAtlas,
  densityAtlasBinBp,
  densityAtlasLevelBinBps,
  estimateDensityAtlasBinCount,
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

export type RetainedOverviewPreparation = {
  presentationKey: string;
  contexts: readonly {
    context: AnnotationOverviewCacheContext;
    pixelsPerBpMin: number;
    pixelsPerBpMax: number;
  }[];
};

export type RetainedOverviewPreparationReceipt =
  | {
      kind: 'ready';
      generation: number;
      presentationKey: string;
      contextLevelKeys: readonly string[];
      exactBinCount: number;
    }
  | {
      kind: 'unprepared';
      generation: number;
      reason: 'stale-generation' | 'retention-budget-exceeded' | 'bin-budget-exceeded';
    };

export type RetainedOverviewBodyRead =
  | { kind: 'ready'; cache: RetainedOverviewBodyCache }
  | {
      kind: 'unprepared';
      request: { generation: number; contextKey: string; selectedBinBp: number };
    }
  | { kind: 'budget-exceeded'; diagnostics: OverviewDensityAtlasDiagnostics };

type RetainedLevelRequest = {
  key: string;
  context: AnnotationOverviewCacheContext;
  binBp: number;
};

const MAX_RESIDENT_DENSITY_LEVELS = 8;

function yieldPreparationTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

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
  private readonly sourceIds = new WeakMap<Feature[], number>();
  private nextSourceId = 0;
  private generation = 0;
  private readonly maxResidentRetainedLevels: number;
  private readonly maxPreparedRetainedBins: number;
  private readonly preparations = new Map<string, Promise<RetainedOverviewPreparationReceipt>>();

  lastCacheHit = false;

  constructor(
    options: {
      maxResidentRetainedLevels?: number;
      maxPreparedRetainedBins?: number;
    } = {}
  ) {
    this.maxResidentRetainedLevels = Math.max(
      1,
      Math.floor(options.maxResidentRetainedLevels ?? MAX_RESIDENT_DENSITY_LEVELS)
    );
    this.maxPreparedRetainedBins = Math.max(
      1,
      Math.floor(options.maxPreparedRetainedBins ?? DEFAULT_DENSITY_ATLAS_MAX_TOTAL_BINS)
    );
  }

  invalidate(): void {
    this.generation += 1;
    this.preparations.clear();
    this.overviewAggregationCache = null;
    this.overviewDensityAtlasCache = null;
    this.overviewDensityLevels.clear();
    this.retainedOverviewBodyCache = null;
    this.retainedOverviewDensityAtlasCache = null;
    this.retainedOverviewDensityLevels.clear();
    this.lastCacheHit = false;
  }

  prepareRetainedOverview(
    input: RetainedOverviewPreparation
  ): Promise<RetainedOverviewPreparationReceipt> {
    const generation = this.generation;
    const requests = new Map<string, RetainedLevelRequest>();
    for (const { context, pixelsPerBpMin, pixelsPerBpMax } of input.contexts) {
      if (
        !Number.isFinite(pixelsPerBpMin) ||
        !Number.isFinite(pixelsPerBpMax) ||
        pixelsPerBpMin <= 0 ||
        pixelsPerBpMax < pixelsPerBpMin
      ) {
        throw new RangeError(
          'Retained overview preparation requires a finite positive camera domain.'
        );
      }
      const levels = this.levelBinBps(context);
      const first = levels.indexOf(this.selectedBinBp(context, pixelsPerBpMax));
      const last = levels.indexOf(this.selectedBinBp(context, pixelsPerBpMin));
      for (const binBp of levels.slice(first, last + 1)) {
        const key = this.levelKey(true, context, binBp);
        requests.set(key, { key, context, binBp });
      }
    }
    const preparationKey = JSON.stringify([
      generation,
      input.presentationKey,
      [...requests.keys()],
    ]);
    const existing = this.preparations.get(preparationKey);
    if (existing) return existing;
    const preparation = this.buildPreparedRetainedOverview(input, generation, [
      ...requests.values(),
    ]);
    this.preparations.set(preparationKey, preparation);
    void preparation
      .finally(() => {
        if (this.preparations.get(preparationKey) === preparation) {
          this.preparations.delete(preparationKey);
        }
      })
      .catch(() => {});
    return preparation;
  }

  private async buildPreparedRetainedOverview(
    input: RetainedOverviewPreparation,
    generation: number,
    requests: readonly RetainedLevelRequest[]
  ): Promise<RetainedOverviewPreparationReceipt> {
    await yieldPreparationTask();
    const stale = (): RetainedOverviewPreparationReceipt => ({
      kind: 'unprepared',
      generation,
      reason: 'stale-generation',
    });
    if (generation !== this.generation) return stale();
    if (requests.length > this.maxResidentRetainedLevels) {
      return { kind: 'unprepared', generation, reason: 'retention-budget-exceeded' };
    }
    let exactBinCount = 0;
    for (const { key, context, binBp } of requests) {
      const existing = this.retainedOverviewDensityLevels.get(key);
      exactBinCount +=
        existing?.atlas?.estimatedBinCount ??
        estimateDensityAtlasBinCount(
          this.atlasOptions(true, context),
          [binBp],
          this.maxPreparedRetainedBins - exactBinCount
        );
      if (exactBinCount > this.maxPreparedRetainedBins) {
        return { kind: 'unprepared', generation, reason: 'bin-budget-exceeded' };
      }
    }
    const prepared: OverviewDensityAtlasCache[] = [];
    for (const { key, context, binBp } of requests) {
      if (generation !== this.generation) return stale();
      const existing = this.retainedOverviewDensityLevels.get(key);
      if (existing?.atlas) {
        prepared.push(existing);
        continue;
      }
      const atlas = buildAnnotationDensityAtlas({
        ...this.atlasOptions(true, context),
        minBinBp: binBp,
        maxBinBp: binBp,
        maxTotalBins: this.maxPreparedRetainedBins,
      });
      prepared.push({ key, atlas, budgetExceeded: null });
      await yieldPreparationTask();
    }
    if (generation !== this.generation) return stale();
    for (const cache of prepared) {
      this.retainedOverviewDensityLevels.delete(cache.key);
      this.retainedOverviewDensityLevels.set(cache.key, cache);
    }
    this.trimRetainedLevels();
    return {
      kind: 'ready',
      generation,
      presentationKey: input.presentationKey,
      contextLevelKeys: requests.map(({ key }) => key),
      exactBinCount,
    };
  }

  readRetainedOverviewBodyCache(
    path: Pick<PathMapper, 'pixelsPerBp'>,
    ctx: AnnotationOverviewCacheContext
  ): RetainedOverviewBodyRead {
    const selectedBinBp = this.selectedBinBp(ctx, path.pixelsPerBp);
    const contextKey = this.overviewDensityAtlasKey(true, ctx);
    const key = this.levelKey(true, ctx, selectedBinBp);
    const cache = this.retainedOverviewDensityLevels.get(key);
    if (!cache) {
      this.lastCacheHit = false;
      return {
        kind: 'unprepared',
        request: { generation: this.generation, contextKey, selectedBinBp },
      };
    }
    this.retainedOverviewDensityLevels.delete(key);
    this.retainedOverviewDensityLevels.set(key, cache);
    this.retainedOverviewDensityAtlasCache = cache;
    if (!cache.atlas)
      return { kind: 'budget-exceeded', diagnostics: densityAtlasDiagnostics(cache) };
    return { kind: 'ready', cache: this.retainedBody(cache, path.pixelsPerBp) };
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
    return this.retainedBody(atlasCache, path.pixelsPerBp);
  }

  private retainedBody(
    atlasCache: OverviewDensityAtlasCache,
    pixelsPerBp: number
  ): RetainedOverviewBodyCache {
    const level = selectAnnotationDensityAtlasLevel(atlasCache.atlas!, pixelsPerBp);
    const key = `retained-${atlasCache.key}|level:${level.binBp.toFixed(3)}`;
    if (this.retainedOverviewBodyCache?.key === key) {
      this.lastCacheHit = true;
      return this.retainedOverviewBodyCache;
    }
    this.lastCacheHit = false;

    this.retainedOverviewBodyCache = {
      key,
      binBp: level.binBp,
      atlasLevelCount: atlasCache.atlas!.levels.length,
      bins: level.bins,
      passthroughFeatures: level.passthroughFeatures,
    };
    return this.retainedOverviewBodyCache;
  }

  private overviewDensityAtlasKey(featureScoped: boolean, ctx: AnnotationOverviewCacheContext) {
    const L = ctx.layout;
    let sourceId = this.sourceIds.get(ctx.features);
    if (sourceId === undefined) {
      sourceId = ++this.nextSourceId;
      this.sourceIds.set(ctx.features, sourceId);
    }
    return [
      'annotation-density-atlas-v2',
      featureScoped ? 'feature-scoped' : 'merged',
      ctx.genomeLength,
      sourceId,
      ctx.features.length,
      OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
      densityAtlasBinBp(
        OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
        OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX
      ).toFixed(3),
      L?.annotationOffset ?? '',
      L?.annotationStep ?? '',
      L?.cdsBarOffset ?? '',
      L?.cdsLaneStep ?? '',
      ctx.maxAnnotationLane,
      ctx.maxCdsLane,
    ].join('|');
  }

  private levelBinBps(ctx: AnnotationOverviewCacheContext): number[] {
    return densityAtlasLevelBinBps(
      densityAtlasBinBp(
        OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
        OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX
      ),
      ctx.genomeLength
    );
  }

  private selectedBinBp(ctx: AnnotationOverviewCacheContext, pixelsPerBp: number): number {
    const desiredBinBp = densityAtlasBinBp(pixelsPerBp, OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX);
    return this.levelBinBps(ctx).reduce((closest, candidate) =>
      Math.abs(Math.log2(candidate / desiredBinBp)) < Math.abs(Math.log2(closest / desiredBinBp))
        ? candidate
        : closest
    );
  }

  private levelKey(
    featureScoped: boolean,
    ctx: AnnotationOverviewCacheContext,
    binBp: number
  ): string {
    return `${this.overviewDensityAtlasKey(featureScoped, ctx)}|bin:${binBp}`;
  }

  private atlasOptions(featureScoped: boolean, ctx: AnnotationOverviewCacheContext) {
    return {
      features: ctx.features,
      genomeLength: ctx.genomeLength,
      sampleScreenPx: OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
      minVisiblePixels: 0,
      aggregateBelowPixels: featureScoped ? undefined : ctx.minAggregateFeaturePixels,
      featureScoped,
      getEndBp: ctx.getEndBp,
      getOffset: ctx.getOffset,
      getHalfHeight: ctx.getHalfHeight,
      getColor: ctx.getColor,
      getAlpha: (feature: Feature) => ctx.getAlpha(feature, featureScoped),
      shouldPassThrough: (feature: Feature) => ctx.shouldPassThrough(feature, featureScoped),
    };
  }

  private trimRetainedLevels(): void {
    let bins = [...this.retainedOverviewDensityLevels.values()].reduce(
      (total, cache) => total + (cache.atlas?.estimatedBinCount ?? 0),
      0
    );
    while (
      this.retainedOverviewDensityLevels.size > this.maxResidentRetainedLevels ||
      bins > this.maxPreparedRetainedBins
    ) {
      const oldest = this.retainedOverviewDensityLevels.keys().next().value!;
      bins -= this.retainedOverviewDensityLevels.get(oldest)?.atlas?.estimatedBinCount ?? 0;
      this.retainedOverviewDensityLevels.delete(oldest);
    }
  }

  private getOverviewDensityAtlas(
    featureScoped: boolean,
    ctx: AnnotationOverviewCacheContext,
    pixelsPerBp: number
  ): OverviewDensityAtlasCache {
    const selectedBinBp = this.selectedBinBp(ctx, pixelsPerBp);
    const key = this.levelKey(featureScoped, ctx, selectedBinBp);
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
        ...this.atlasOptions(featureScoped, ctx),
        minBinBp: selectedBinBp,
        maxBinBp: selectedBinBp,
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
    if (featureScoped) {
      this.trimRetainedLevels();
      this.retainedOverviewDensityAtlasCache = cache;
    } else {
      while (resident.size > MAX_RESIDENT_DENSITY_LEVELS) {
        resident.delete(resident.keys().next().value!);
      }
      this.overviewDensityAtlasCache = cache;
    }
    return cache;
  }
}
