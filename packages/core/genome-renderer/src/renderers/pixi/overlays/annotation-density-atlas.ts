import type { Feature } from '../../../types';

export const DEFAULT_DENSITY_ATLAS_MAX_TOTAL_BINS = 500_000;

export class AnnotationDensityAtlasBudgetExceededError extends Error {
  constructor(
    readonly requestedMinBinBp: number,
    readonly maxBinBp: number,
    readonly estimatedBinCount: number,
    readonly maxTotalBins: number
  ) {
    super(
      `Annotation density atlas would allocate ${estimatedBinCount} bins, exceeding budget ${maxTotalBins}`
    );
    this.name = 'AnnotationDensityAtlasBudgetExceededError';
  }
}

export type AnnotationDensityAtlasBin = {
  startBp: number;
  endBp: number;
  offset: number;
  halfHeight: number;
  color: number;
  alpha: number;
  coverageBp: number;
  coverageRatio: number;
  sourceCount: number;
  featureId?: number;
  featureStart?: number;
  featureEnd?: number;
  featureRawEnd?: number;
  featureDirection?: Feature['direction'];
};

export type AnnotationDensityAtlasLevel = {
  binBp: number;
  genomeLength: number;
  sampleScreenPx: number;
  pixelsPerBp: number;
  bins: AnnotationDensityAtlasBin[];
  passthroughFeatures: Feature[];
  diagnostics: AnnotationDensityAtlasLevelDiagnostics;
};

export type AnnotationDensityAtlasLevelDiagnostics = {
  inputFeatureCount: number;
  skippedMinVisibleFeatureCount: number;
  passthroughFeatureCount: number;
  aggregateWideFeatureCount: number;
  aggregatedFeatureCount: number;
  binContributionCount: number;
};

export type AnnotationDensityAtlasOptions = {
  features: readonly Feature[];
  genomeLength: number;
  pixelsPerBp: number;
  binBp?: number;
  sampleScreenPx: number;
  minVisiblePixels: number;
  aggregateBelowPixels?: number;
  featureScoped?: boolean;
  getEndBp: (feature: Feature) => number;
  getOffset: (feature: Feature) => number;
  getHalfHeight: (feature: Feature) => number;
  getColor: (feature: Feature) => number;
  getAlpha: (feature: Feature) => number;
  shouldPassThrough: (feature: Feature, pixelWidth: number) => boolean;
};

export type AnnotationDensityAtlas = {
  genomeLength: number;
  sampleScreenPx: number;
  minBinBp: number;
  maxBinBp: number;
  estimatedBinCount: number;
  wasCoarsened: boolean;
  levels: AnnotationDensityAtlasLevel[];
};

export type AnnotationDensityAtlasBuildOptions = Omit<
  AnnotationDensityAtlasOptions,
  'pixelsPerBp'
> & {
  minBinBp: number;
  maxBinBp?: number;
  maxTotalBins?: number;
  budgetPolicy?: 'throw' | 'coarsen';
};

export function densityAtlasBinBp(pixelsPerBp: number, sampleScreenPx: number): number {
  return Math.max(1, sampleScreenPx / Math.max(pixelsPerBp, 1e-6));
}

export function densityAtlasLevelBinBps(minBinBp: number, maxBinBp: number): number[] {
  const min = Math.max(1, minBinBp);
  const max = Math.max(min, maxBinBp);
  const levels: number[] = [];
  let binBp = min;
  while (binBp < max) {
    levels.push(binBp);
    binBp *= 2;
  }
  levels.push(max);
  return levels;
}

export function selectAnnotationDensityAtlasLevel(
  atlas: AnnotationDensityAtlas,
  pixelsPerBp: number
): AnnotationDensityAtlasLevel {
  const desiredBinBp = densityAtlasBinBp(pixelsPerBp, atlas.sampleScreenPx);
  let best = atlas.levels[0];
  let bestDistance = Infinity;
  for (const level of atlas.levels) {
    const distance = Math.abs(Math.log2(level.binBp / desiredBinBp));
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

export function buildAnnotationDensityAtlas({
  minBinBp,
  maxBinBp = Math.max(1, minBinBp),
  maxTotalBins = DEFAULT_DENSITY_ATLAS_MAX_TOTAL_BINS,
  budgetPolicy = 'throw',
  ...levelOptions
}: AnnotationDensityAtlasBuildOptions): AnnotationDensityAtlas {
  const requestedMinBinBp = Math.max(1, minBinBp);
  const requestedMaxBinBp = Math.max(requestedMinBinBp, maxBinBp);
  const requestedLevelBinBps = densityAtlasLevelBinBps(requestedMinBinBp, requestedMaxBinBp);
  const requestedEstimatedBinCount = estimateDensityAtlasBinCount(
    levelOptions,
    requestedLevelBinBps,
    maxTotalBins
  );
  if (requestedEstimatedBinCount > maxTotalBins && budgetPolicy === 'throw') {
    throw new AnnotationDensityAtlasBudgetExceededError(
      requestedMinBinBp,
      requestedMaxBinBp,
      requestedEstimatedBinCount,
      maxTotalBins
    );
  }

  const budgeted = budgetDensityAtlasLevels({
    ...levelOptions,
    minBinBp: requestedMinBinBp,
    maxBinBp: requestedMaxBinBp,
    maxTotalBins,
  });
  return {
    genomeLength: levelOptions.genomeLength,
    sampleScreenPx: levelOptions.sampleScreenPx,
    minBinBp: budgeted.levelBinBps[0],
    maxBinBp: budgeted.levelBinBps[budgeted.levelBinBps.length - 1],
    estimatedBinCount: budgeted.estimatedBinCount,
    wasCoarsened: budgeted.minBinBp !== requestedMinBinBp,
    levels: budgeted.levelBinBps.map((binBp) =>
      buildAnnotationDensityAtlasLevel({
        ...levelOptions,
        pixelsPerBp: levelOptions.sampleScreenPx / binBp,
        binBp,
      })
    ),
  };
}

type DensityAtlasBudgetOptions = Omit<AnnotationDensityAtlasBuildOptions, 'maxBinBp'> & {
  maxBinBp: number;
  maxTotalBins: number;
};

function budgetDensityAtlasLevels({
  minBinBp,
  maxBinBp,
  maxTotalBins,
  ...levelOptions
}: DensityAtlasBudgetOptions): {
  minBinBp: number;
  levelBinBps: number[];
  estimatedBinCount: number;
} {
  const budget = Math.max(1, Math.floor(maxTotalBins));
  let budgetedMinBinBp = Math.max(1, minBinBp);
  let levelBinBps = densityAtlasLevelBinBps(budgetedMinBinBp, maxBinBp);
  let estimatedBinCount = estimateDensityAtlasBinCount(levelOptions, levelBinBps, budget);

  while (estimatedBinCount > budget && budgetedMinBinBp < maxBinBp) {
    budgetedMinBinBp = Math.min(maxBinBp, budgetedMinBinBp * 2);
    levelBinBps = densityAtlasLevelBinBps(budgetedMinBinBp, maxBinBp);
    estimatedBinCount = estimateDensityAtlasBinCount(levelOptions, levelBinBps, budget);
  }

  return { minBinBp: budgetedMinBinBp, levelBinBps, estimatedBinCount };
}

export function estimateDensityAtlasBinCount(
  options: Omit<AnnotationDensityAtlasOptions, 'pixelsPerBp' | 'binBp'>,
  levelBinBps: readonly number[],
  stopAfter: number
): number {
  let total = 0;
  for (const binBp of levelBinBps) {
    const pixelsPerBp = options.sampleScreenPx / binBp;
    for (const feature of options.features) {
      const featureLen =
        feature.end > feature.start
          ? feature.end - feature.start
          : options.genomeLength - feature.start + feature.end;
      const pixelWidth = featureLen * pixelsPerBp;
      if (pixelWidth < options.minVisiblePixels) continue;
      if (options.shouldPassThrough(feature, pixelWidth)) continue;
      if (
        options.aggregateBelowPixels !== undefined &&
        pixelWidth >= options.aggregateBelowPixels
      ) {
        continue;
      }

      const rawStart = feature.start;
      const rawEnd = Math.max(rawStart + 1, options.getEndBp(feature));
      const firstBin = Math.floor(rawStart / binBp);
      const lastBin = Math.floor((rawEnd - 1) / binBp);
      total += Math.max(0, lastBin - firstBin + 1);
      if (total > stopAfter) return total;
    }
  }
  return total;
}

export function buildAnnotationDensityAtlasLevel({
  features,
  genomeLength,
  pixelsPerBp,
  binBp: explicitBinBp,
  sampleScreenPx,
  minVisiblePixels,
  aggregateBelowPixels,
  featureScoped = false,
  getEndBp,
  getOffset,
  getHalfHeight,
  getColor,
  getAlpha,
  shouldPassThrough,
}: AnnotationDensityAtlasOptions): AnnotationDensityAtlasLevel {
  const binBp = Math.max(1, explicitBinBp ?? densityAtlasBinBp(pixelsPerBp, sampleScreenPx));
  const bins = new Map<string, AnnotationDensityAtlasBin>();
  const passthroughFeatures: Feature[] = [];
  const diagnostics: AnnotationDensityAtlasLevelDiagnostics = {
    inputFeatureCount: features.length,
    skippedMinVisibleFeatureCount: 0,
    passthroughFeatureCount: 0,
    aggregateWideFeatureCount: 0,
    aggregatedFeatureCount: 0,
    binContributionCount: 0,
  };

  for (const feature of features) {
    const featureLen =
      feature.end > feature.start
        ? feature.end - feature.start
        : genomeLength - feature.start + feature.end;
    const pixelWidth = featureLen * pixelsPerBp;
    if (pixelWidth < minVisiblePixels) {
      diagnostics.skippedMinVisibleFeatureCount += 1;
      continue;
    }

    if (shouldPassThrough(feature, pixelWidth)) {
      diagnostics.passthroughFeatureCount += 1;
      passthroughFeatures.push(feature);
      continue;
    }
    if (aggregateBelowPixels !== undefined && pixelWidth >= aggregateBelowPixels) {
      diagnostics.passthroughFeatureCount += 1;
      diagnostics.aggregateWideFeatureCount += 1;
      passthroughFeatures.push(feature);
      continue;
    }

    const rawStart = feature.start;
    const rawEnd = Math.max(rawStart + 1, getEndBp(feature));
    const firstBin = Math.floor(rawStart / binBp);
    const lastBin = Math.floor((rawEnd - 1) / binBp);
    const offset = getOffset(feature);
    const laneKey = Math.round(offset * 10);
    const color = getColor(feature);
    const alpha = getAlpha(feature);
    const halfHeight = getHalfHeight(feature);
    let contributed = false;

    for (let bin = firstBin; bin <= lastBin; bin++) {
      const binStart = bin * binBp;
      const binEnd = binStart + binBp;
      const startBp = Math.max(rawStart, binStart);
      const endClamped = Math.min(rawEnd, binEnd);
      if (endClamped <= startBp) continue;
      diagnostics.binContributionCount += 1;
      contributed = true;

      const key = featureScoped
        ? `${laneKey}:${color}:${feature.id}:${bin}`
        : `${laneKey}:${color}:${bin}`;
      const existing = bins.get(key);
      if (existing) {
        existing.startBp = Math.min(existing.startBp, startBp);
        existing.endBp = Math.max(existing.endBp, endClamped);
        existing.coverageBp += endClamped - startBp;
        existing.sourceCount += 1;
      } else {
        bins.set(key, {
          startBp,
          endBp: endClamped,
          offset,
          halfHeight,
          color,
          alpha,
          coverageBp: endClamped - startBp,
          coverageRatio: 0,
          sourceCount: 1,
          featureId: featureScoped ? feature.id : undefined,
          featureStart: featureScoped ? feature.start : undefined,
          featureEnd: featureScoped ? feature.end : undefined,
          featureRawEnd: featureScoped ? rawEnd : undefined,
          featureDirection: featureScoped ? feature.direction : undefined,
        });
      }
    }
    if (contributed) diagnostics.aggregatedFeatureCount += 1;
  }

  for (const bin of bins.values()) {
    bin.coverageRatio = Math.max(0, Math.min(1, bin.coverageBp / binBp));
  }

  return {
    binBp,
    genomeLength,
    sampleScreenPx,
    pixelsPerBp,
    bins: [...bins.values()],
    passthroughFeatures,
    diagnostics,
  };
}
