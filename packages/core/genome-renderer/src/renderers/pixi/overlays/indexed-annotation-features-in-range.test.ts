import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import {
  featuresInRange,
  indexAnnotationFeaturesForRange,
  type FeaturesInRangeHost,
} from './indexed-annotation-features-in-range';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    ...overrides,
  };
}

function rangeHost(overrides: Partial<FeaturesInRangeHost> = {}): FeaturesInRangeHost {
  return {
    features: [],
    featuresSortedByStart: null,
    maxFeatureLenBp: 0,
    genomeLength: 1000,
    circularWrappedFeatures: [],
    wrappedFeatureOverlapsRange: () => false,
    ...overrides,
  };
}

describe('indexed annotation features in range', () => {
  it('falls back to host.features when the sorted index is empty or null', () => {
    const all = [feature({ id: 1, start: 10, end: 20 })];
    expect(
      featuresInRange(rangeHost({ features: all, featuresSortedByStart: null }), 0, 5)
    ).toEqual(all);
    expect(featuresInRange(rangeHost({ features: all, featuresSortedByStart: [] }), 0, 5)).toEqual(
      all
    );
  });

  it('binary-search culls to features that overlap the viewport', () => {
    const left = feature({ id: 1, start: 0, end: 10 });
    const overlap = feature({ id: 2, start: 40, end: 60 });
    const startsNearbyButEndsBefore = feature({ id: 3, start: 20, end: 25 });
    const right = feature({ id: 4, start: 90, end: 110 });
    const sorted = [left, startsNearbyButEndsBefore, overlap, right];
    const host = rangeHost({
      features: sorted,
      featuresSortedByStart: sorted,
      maxFeatureLenBp: 30,
    });
    expect(featuresInRange(host, 45, 55).map((next) => next.id)).toEqual([2]);
  });

  it('does not walk the whole chromosome to draw a viewport at the genome end', () => {
    const genomeLength = 50_000_000;
    const featureCount = 20_000;
    const spanning = feature({ id: 0, start: 0, end: genomeLength, type: 'region' });
    const features = [spanning];
    for (let index = 0; index < featureCount; index += 1) {
      const start = Math.floor((index * genomeLength) / featureCount);
      features.push(
        feature({
          id: index + 1,
          start,
          end: Math.min(genomeLength, start + 100),
        })
      );
    }
    const terminalGene = feature({
      id: featureCount + 1,
      start: genomeLength - 500,
      end: genomeLength - 100,
    });
    features.push(terminalGene);
    const windowStart = genomeLength - 1_000;
    const indexed = indexAnnotationFeaturesForRange(features, genomeLength, false);
    expect(indexed.longFeatures.map((item) => item.id)).toEqual([0]);
    expect(indexed.maxIndexedFeatureLenBp).toBeLessThanOrEqual(1_000_000);

    let examined = 0;
    const sorted = new Proxy(indexed.sortedByStart, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) examined += 1;
        return Reflect.get(target, prop, receiver);
      },
    }) as Feature[];
    const hits = featuresInRange(
      rangeHost({
        features,
        featuresSortedByStart: sorted,
        longFeatures: indexed.longFeatures,
        maxFeatureLenBp: indexed.maxIndexedFeatureLenBp,
        genomeLength,
      }),
      windowStart,
      genomeLength
    );
    const ids = hits.map((item) => item.id);

    expect(ids).toContain(0);
    expect(ids).toContain(terminalGene.id);
    expect(ids.indexOf(0)).toBeLessThan(ids.indexOf(terminalGene.id));
    expect(
      hits.filter((item) => item.id !== 0).every((item) => item.start >= windowStart - 1_000_000)
    ).toBe(true);
    expect(examined).toBeLessThan(500);
  });

  it('keeps a circular wrap out of the linear lookback', () => {
    const wrapped = feature({ id: 7, start: 900, end: 20 });
    const gene = feature({ id: 8, start: 100, end: 130 });
    const indexed = indexAnnotationFeaturesForRange([wrapped, gene], 1_000, true);

    expect(indexed.circularWrappedFeatures).toEqual([wrapped]);
    expect(indexed.sortedByStart).toEqual([gene]);
    expect(indexed.longFeatures).toEqual([]);
    expect(indexed.maxIndexedFeatureLenBp).toBe(30);
  });

  it('does not treat a linear inverted interval as a genome-length feature', () => {
    const inverted = feature({ id: 3, start: 800, end: 10 });
    const gene = feature({ id: 4, start: 100, end: 140 });
    const indexed = indexAnnotationFeaturesForRange([inverted, gene], 50_000_000, false);

    expect(indexed.maxIndexedFeatureLenBp).toBe(40);
    expect(indexed.sortedByStart).toEqual([gene]);
    expect(indexed.longFeatures).toEqual([]);
    expect(indexed.circularWrappedFeatures).toEqual([]);
  });
});
