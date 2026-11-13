// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { GenomeFeature } from '@waypoint/genome-data';

import {
  LANE_ASSIGNMENT_VERSION,
  computeLaneEpoch,
  computeStableLaneAssignment,
  stableFeatureKey,
} from './stable-lane-assignment';

function feature(overrides: Partial<GenomeFeature> = {}): GenomeFeature {
  return {
    chrom: 'chr11',
    source: 'test',
    type: 'mRNA',
    start: 0,
    end: 1000,
    score: null,
    strand: '+',
    phase: null,
    attributes: {},
    raw: '',
    ...overrides,
  };
}

describe('computeLaneEpoch (Slice 1)', () => {
  it('produces identical strings for identical inputs', () => {
    const a = computeLaneEpoch({
      sourceFingerprint: 'fp-chr11',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA', 'gene']),
      laneLimit: 8,
    });
    const b = computeLaneEpoch({
      sourceFingerprint: 'fp-chr11',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA', 'gene']),
      laneLimit: 8,
    });
    expect(a).toMatch(/\S/);
    expect(a).toBe(b);
  });

  it('is insensitive to visibleTypes insertion order', () => {
    const a = computeLaneEpoch({
      sourceFingerprint: 'fp-chr11',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA', 'gene', 'lncRNA']),
      laneLimit: null,
    });
    const b = computeLaneEpoch({
      sourceFingerprint: 'fp-chr11',
      chrom: 'chr11',
      visibleTypes: new Set(['lncRNA', 'mRNA', 'gene']),
      laneLimit: null,
    });
    expect(a).toMatch(/\S/);
    expect(a).toBe(b);
  });

  it('changes when sourceFingerprint changes', () => {
    const a = computeLaneEpoch({
      sourceFingerprint: 'fp-chr11-v0',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    const b = computeLaneEpoch({
      sourceFingerprint: 'fp-chr11-v1',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    expect(a).not.toBe(b);
  });

  it('changes when chrom changes', () => {
    const a = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    const b = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr1',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    expect(a).not.toBe(b);
  });

  it('changes when visibleTypes membership changes', () => {
    const a = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    const b = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA', 'gene']),
      laneLimit: null,
    });
    expect(a).not.toBe(b);
  });

  it('changes when laneLimit changes (null vs number, number vs number)', () => {
    const uncapped = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    const capped8 = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: 8,
    });
    const capped16 = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: 16,
    });
    expect(uncapped).not.toBe(capped8);
    expect(uncapped).not.toBe(capped16);
    expect(capped8).not.toBe(capped16);
  });

  it('includes the LANE_ASSIGNMENT_VERSION so algorithm bumps force invalidation', () => {
    const epoch = computeLaneEpoch({
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    expect(epoch).toContain(`lane-v${LANE_ASSIGNMENT_VERSION}`);
  });
});

describe('computeStableLaneAssignment (Slice 1)', () => {
  it('returns the same {key → lane} map for identical inputs', () => {
    const features = [
      feature({ start: 100, end: 200, attributes: { ID: ['a'] } }),
      feature({ start: 150, end: 300, attributes: { ID: ['b'] } }),
      feature({ start: 400, end: 500, attributes: { ID: ['c'] } }),
    ];
    const a = computeStableLaneAssignment({
      features,
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    const b = computeStableLaneAssignment({
      features,
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });

    const stringify = (m: Map<string, number>) =>
      JSON.stringify([...m.entries()].sort(([k1], [k2]) => k1.localeCompare(k2)));

    expect(stringify(a.laneByFeatureKey)).toBe(stringify(b.laneByFeatureKey));
    expect(a.laneEpoch).toBe(b.laneEpoch);
  });

  it('filters by annotationLayerType (visibleTypes is the layer set, not raw feature.type)', () => {
    const lncRow = feature({
      type: 'ncRNA',
      start: 100,
      end: 200,
      attributes: { ID: ['lnc-1'], ncRNA_class: ['lncRNA'] },
    });
    const mRnaRow = feature({
      type: 'mRNA',
      start: 300,
      end: 400,
      attributes: { ID: ['mrna-1'] },
    });

    const lncOnly = computeStableLaneAssignment({
      features: [lncRow, mRnaRow],
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['lncRNA']),
      laneLimit: null,
    });
    expect(lncOnly.typeFilteredCount).toBe(1);
    expect(lncOnly.laneByFeatureKey.has(stableFeatureKey(lncRow))).toBe(true);
    expect(lncOnly.laneByFeatureKey.has(stableFeatureKey(mRnaRow))).toBe(false);

    const mRnaOnly = computeStableLaneAssignment({
      features: [lncRow, mRnaRow],
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    expect(mRnaOnly.typeFilteredCount).toBe(1);
    expect(mRnaOnly.laneByFeatureKey.has(stableFeatureKey(mRnaRow))).toBe(true);
    expect(mRnaOnly.laneByFeatureKey.has(stableFeatureKey(lncRow))).toBe(false);
  });

  it('drops features on a different chrom', () => {
    const onChr11 = feature({ chrom: 'chr11', start: 0, end: 100, attributes: { ID: ['a'] } });
    const onChr1 = feature({ chrom: 'chr1', start: 0, end: 100, attributes: { ID: ['b'] } });

    const result = computeStableLaneAssignment({
      features: [onChr11, onChr1],
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });

    expect(result.typeFilteredCount).toBe(1);
    expect(result.laneByFeatureKey.has(stableFeatureKey(onChr11))).toBe(true);
    expect(result.laneByFeatureKey.has(stableFeatureKey(onChr1))).toBe(false);
  });

  it('applies laneLimit to drop overflow features (recorded in droppedCount)', () => {
    const features = [
      feature({ start: 100, end: 200, attributes: { ID: ['a'] } }),
      feature({ start: 110, end: 210, attributes: { ID: ['b'] } }),
      feature({ start: 120, end: 220, attributes: { ID: ['c'] } }),
    ];
    const uncapped = computeStableLaneAssignment({
      features,
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
    });
    expect(uncapped.laneByFeatureKey.size).toBe(3);
    expect(uncapped.droppedCount).toBe(0);

    const capped = computeStableLaneAssignment({
      features,
      sourceFingerprint: 'fp',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: 1,
    });
    expect(capped.laneByFeatureKey.size).toBe(1);
    expect(capped.droppedCount).toBe(2);
  });

  it('returns a laneEpoch that matches computeLaneEpoch for the same inputs', () => {
    const epochFromAssignment = computeStableLaneAssignment({
      features: [feature()],
      sourceFingerprint: 'fp-X',
      chrom: 'chr11',
      length: 1000,
      visibleTypes: new Set(['mRNA', 'gene']),
      laneLimit: 8,
    }).laneEpoch;
    const epochFromHelper = computeLaneEpoch({
      sourceFingerprint: 'fp-X',
      chrom: 'chr11',
      visibleTypes: new Set(['mRNA', 'gene']),
      laneLimit: 8,
    });
    expect(epochFromAssignment).toBe(epochFromHelper);
  });
});
