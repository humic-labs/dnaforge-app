// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';

import {
  DEBUG_FEATURE_LANE_SAMPLE_LIMIT,
  buildRendererFeatureLaneSamples,
  findCdsLociFromRendererFeatures,
  findFeatureStructuresFromRendererFeatures,
} from './indexed-genome-debug-snapshot';

function feature(id: number, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'mRNA',
    displayName: `feature-${id}`,
    start: id * 1000,
    end: id * 1000 + 500,
    direction: 'forward',
    lane: id,
    qualifiers: { ID: `feature-${id}` },
    ...overrides,
  } as Feature;
}

describe('indexed-genome debug snapshot helpers', () => {
  it('bounds always-on renderer feature lane samples', () => {
    const features = Array.from({ length: DEBUG_FEATURE_LANE_SAMPLE_LIMIT + 50 }, (_, i) =>
      feature(i)
    );

    const samples = buildRendererFeatureLaneSamples(features);

    expect(samples).toHaveLength(DEBUG_FEATURE_LANE_SAMPLE_LIMIT);
    expect(samples[0]).toMatchObject({ label: 'feature-0', lane: 0 });
    expect(samples.at(-1)).toMatchObject({
      label: `feature-${DEBUG_FEATURE_LANE_SAMPLE_LIMIT - 1}`,
      lane: DEBUG_FEATURE_LANE_SAMPLE_LIMIT - 1,
    });
  });

  it('finds CDS loci beyond the bounded debug sample', () => {
    const features = Array.from({ length: DEBUG_FEATURE_LANE_SAMPLE_LIMIT + 10 }, (_, i) =>
      feature(i)
    );
    features[DEBUG_FEATURE_LANE_SAMPLE_LIMIT + 5] = feature(DEBUG_FEATURE_LANE_SAMPLE_LIMIT + 5, {
      displayName: 'late-compact-cds',
      start: 10_000,
      end: 10_300,
      cds: [{ start: 10_020, end: 10_280 }],
    });
    features[DEBUG_FEATURE_LANE_SAMPLE_LIMIT + 6] = feature(DEBUG_FEATURE_LANE_SAMPLE_LIMIT + 6, {
      displayName: 'late-wide-cds',
      start: 20_000,
      end: 40_000,
      cds: [{ start: 21_000, end: 39_000 }],
    });

    const samples = buildRendererFeatureLaneSamples(features);
    const loci = findCdsLociFromRendererFeatures(features, 2);

    expect(samples.some((sample) => sample.label === 'late-compact-cds')).toBe(false);
    expect(loci).toEqual([
      expect.objectContaining({
        label: 'late-compact-cds',
        spanBp: 300,
        cdsFeatureCount: 2,
        totalVisible: features.length,
      }),
      expect.objectContaining({
        label: 'late-wide-cds',
        spanBp: 20_000,
        cdsFeatureCount: 2,
        totalVisible: features.length,
      }),
    ]);
  });

  it('returns bounded structural snapshots from the authoritative renderer features', () => {
    const features = [
      feature(1, {
        displayName: 'LGALS12',
        transcriptId: 'NM_033101.4',
        qualifiers: { ID: 'LGALS12.mrna.1', gene: 'LGALS12' },
        cds: [{ start: 110, end: 180 }],
        exons: [
          { start: 100, end: 140 },
          { start: 160, end: 200 },
        ],
      }),
      feature(2, { displayName: 'unrelated' }),
    ];

    expect(findFeatureStructuresFromRendererFeatures(features, 'lgals12', 1)).toEqual([
      {
        type: 'mRNA',
        start: 1000,
        end: 1500,
        lane: 1,
        displayName: 'LGALS12',
        transcriptId: 'NM_033101.4',
        qualifiers: { ID: 'LGALS12.mrna.1', gene: 'LGALS12' },
        cds: [{ start: 110, end: 180 }],
        exons: [
          { start: 100, end: 140 },
          { start: 160, end: 200 },
        ],
      },
    ]);
    expect(findFeatureStructuresFromRendererFeatures(features, '', 1)).toEqual([]);
    expect(findFeatureStructuresFromRendererFeatures(features, 'lgals12', 0)).toEqual([]);
  });
});
