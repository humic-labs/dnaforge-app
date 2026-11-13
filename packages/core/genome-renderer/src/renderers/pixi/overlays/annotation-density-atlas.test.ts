import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import {
  AnnotationDensityAtlasBudgetExceededError,
  buildAnnotationDensityAtlas,
  buildAnnotationDensityAtlasLevel,
  densityAtlasBinBp,
  densityAtlasLevelBinBps,
  selectAnnotationDensityAtlasLevel,
} from './annotation-density-atlas';

function feature(partial: Partial<Feature>): Feature {
  return {
    id: partial.id ?? 1,
    type: partial.type ?? 'gene',
    start: partial.start ?? 100,
    end: partial.end ?? 600,
    direction: partial.direction ?? 'none',
    displayName: partial.displayName ?? 'feature',
    color: partial.color ?? 0x3b82f6,
    lane: partial.lane ?? 0,
    ...partial,
  };
}

describe('annotation density atlas', () => {
  it('uses subpixel screen samples for overview antialiasing', () => {
    expect(densityAtlasBinBp(0.001, 0.25)).toBe(250);
  });

  it('builds power-of-two atlas levels over the requested sequence span', () => {
    expect(densityAtlasLevelBinBps(125, 1000)).toEqual([125, 250, 500, 1000]);
    expect(densityAtlasLevelBinBps(125, 900)).toEqual([125, 250, 500, 900]);
  });

  it('builds source-colored feature-scoped bins at the requested atlas resolution', () => {
    const level = buildAnnotationDensityAtlasLevel({
      features: [feature({ id: 5, start: 1000, end: 1500, color: 0x22c55e })],
      genomeLength: 10_000,
      pixelsPerBp: 0.001,
      sampleScreenPx: 0.25,
      minVisiblePixels: 0.3,
      featureScoped: true,
      getEndBp: (f) => f.end,
      getOffset: () => -24,
      getHalfHeight: () => 5,
      getColor: (f) => f.color ?? 0,
      getAlpha: () => 0.85,
      shouldPassThrough: () => false,
    });

    expect(level.binBp).toBe(250);
    expect(level.sampleScreenPx).toBe(0.25);
    expect(level.pixelsPerBp).toBe(0.001);
    expect(level.passthroughFeatures).toEqual([]);
    expect(level.bins).toHaveLength(2);
    expect(level.bins.every((bin) => bin.color === 0x22c55e)).toBe(true);
    expect(level.bins.every((bin) => bin.alpha === 0.85)).toBe(true);
    expect(level.bins.every((bin) => bin.coverageRatio === 1)).toBe(true);
    expect(level.bins.every((bin) => bin.featureId === 5)).toBe(true);
  });

  it('passes through features that cannot be represented by the density atlas', () => {
    const spliced = feature({ id: 8, start: 100, end: 900 });
    const level = buildAnnotationDensityAtlasLevel({
      features: [spliced],
      genomeLength: 10_000,
      pixelsPerBp: 0.001,
      sampleScreenPx: 0.25,
      minVisiblePixels: 0.3,
      getEndBp: (f) => f.end,
      getOffset: () => -24,
      getHalfHeight: () => 5,
      getColor: (f) => f.color ?? 0,
      getAlpha: () => 0.85,
      shouldPassThrough: () => true,
    });

    expect(level.bins).toEqual([]);
    expect(level.passthroughFeatures).toEqual([spliced]);
  });

  it('diagnoses features skipped by min-visible-pixel culling', () => {
    const tiny = feature({ id: 1, start: 10, end: 20 });
    const normal = feature({ id: 2, start: 1000, end: 1500 });
    const passthrough = feature({ id: 3, type: 'mRNA', start: 2000, end: 3000 });
    const level = buildAnnotationDensityAtlasLevel({
      features: [tiny, normal, passthrough],
      genomeLength: 10_000,
      pixelsPerBp: 0.001,
      sampleScreenPx: 0.25,
      minVisiblePixels: 0.3,
      aggregateBelowPixels: 2,
      getEndBp: (f) => f.end,
      getOffset: () => -24,
      getHalfHeight: () => 5,
      getColor: (f) => f.color ?? 0,
      getAlpha: () => 0.85,
      shouldPassThrough: (f) => f.type === 'mRNA',
    });

    expect(level.diagnostics).toMatchObject({
      inputFeatureCount: 3,
      skippedMinVisibleFeatureCount: 1,
      passthroughFeatureCount: 1,
      aggregateWideFeatureCount: 0,
      aggregatedFeatureCount: 1,
    });
    expect(level.diagnostics.binContributionCount).toBeGreaterThan(0);
  });

  it('builds and selects a multi-level density atlas without recomputing a per-zoom level', () => {
    const atlas = buildAnnotationDensityAtlas({
      features: [feature({ id: 5, start: 1000, end: 1500, color: 0x22c55e })],
      genomeLength: 10_000,
      sampleScreenPx: 0.25,
      minBinBp: 125,
      maxBinBp: 1000,
      minVisiblePixels: 0.3,
      featureScoped: true,
      getEndBp: (f) => f.end,
      getOffset: () => -24,
      getHalfHeight: () => 5,
      getColor: (f) => f.color ?? 0,
      getAlpha: () => 0.85,
      shouldPassThrough: () => false,
    });

    expect(atlas.levels.map((level) => level.binBp)).toEqual([125, 250, 500, 1000]);
    expect(atlas.wasCoarsened).toBe(false);
    expect(atlas.estimatedBinCount).toBe(6);
    expect(selectAnnotationDensityAtlasLevel(atlas, 0.001).binBp).toBe(250);
    expect(selectAnnotationDensityAtlasLevel(atlas, 0.00025).binBp).toBe(1000);
    expect(atlas.levels.every((level) => level.bins.every((bin) => bin.color === 0x22c55e))).toBe(
      true
    );
  });

  it('coarsens atlas levels before building an unsafe number of bins', () => {
    const atlas = buildAnnotationDensityAtlas({
      features: [feature({ id: 5, start: 0, end: 1_000_000, color: 0x22c55e })],
      genomeLength: 1_000_000,
      sampleScreenPx: 1,
      minBinBp: 1,
      maxBinBp: 1_000_000,
      maxTotalBins: 1_000,
      budgetPolicy: 'coarsen',
      minVisiblePixels: 0.01,
      featureScoped: true,
      getEndBp: (f) => f.end,
      getOffset: () => -24,
      getHalfHeight: () => 5,
      getColor: (f) => f.color ?? 0,
      getAlpha: () => 0.85,
      shouldPassThrough: () => false,
    });

    const builtBinCount = atlas.levels.reduce((sum, level) => sum + level.bins.length, 0);
    expect(atlas.wasCoarsened).toBe(true);
    expect(atlas.minBinBp).toBeGreaterThan(1);
    expect(atlas.estimatedBinCount).toBeLessThanOrEqual(1_000);
    expect(builtBinCount).toBeLessThanOrEqual(1_000);
  });

  it('fails loudly by default instead of silently overcoarsening the atlas', () => {
    expect(() =>
      buildAnnotationDensityAtlas({
        features: [feature({ id: 5, start: 0, end: 1_000_000, color: 0x22c55e })],
        genomeLength: 1_000_000,
        sampleScreenPx: 1,
        minBinBp: 1,
        maxBinBp: 1_000_000,
        maxTotalBins: 1_000,
        minVisiblePixels: 0.01,
        featureScoped: true,
        getEndBp: (f) => f.end,
        getOffset: () => -24,
        getHalfHeight: () => 5,
        getColor: (f) => f.color ?? 0,
        getAlpha: () => 0.85,
        shouldPassThrough: () => false,
      })
    ).toThrow(AnnotationDensityAtlasBudgetExceededError);
  });

  it('records partial bin coverage for density antialiasing', () => {
    const level = buildAnnotationDensityAtlasLevel({
      features: [feature({ id: 5, start: 1000, end: 1125, color: 0x22c55e })],
      genomeLength: 10_000,
      pixelsPerBp: 0.001,
      sampleScreenPx: 0.25,
      minVisiblePixels: 0.01,
      featureScoped: true,
      getEndBp: (f) => f.end,
      getOffset: () => -24,
      getHalfHeight: () => 5,
      getColor: (f) => f.color ?? 0,
      getAlpha: () => 0.85,
      shouldPassThrough: () => false,
    });

    expect(level.binBp).toBe(250);
    expect(level.bins).toHaveLength(1);
    expect(level.bins[0].coverageBp).toBe(125);
    expect(level.bins[0].coverageRatio).toBe(0.5);
    expect(level.bins[0].sourceCount).toBe(1);
  });
});
