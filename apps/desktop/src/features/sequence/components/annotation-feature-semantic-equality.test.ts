// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';
import {
  annotationFeatureArraysSemanticallyEqual,
  annotationFeaturesSemanticallyEqual,
} from './annotation-feature-semantic-equality';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 7,
    type: 'mRNA',
    annotationTrackId: 'mRNA',
    annotationTrackLane: 2,
    annotationTrackLaneCapacity: 12,
    start: 100,
    end: 900,
    direction: 'forward',
    displayName: 'TX7',
    color: 0x3b82f6,
    outlineOnly: false,
    lane: 2,
    cdsLane: 1,
    segments: [{ start: 101, end: 900 }],
    exons: [
      { start: 101, end: 200 },
      { start: 701, end: 900 },
    ],
    cds: [
      { start: 121, end: 200 },
      { start: 701, end: 850 },
    ],
    transcriptId: 'tx-7',
    sourceId: 'source-7',
    canonicalIdentity: 'annotation.v2:tx-7',
    qualifiers: { ID: 'tx-7', codon_start: '1' },
    ...overrides,
  };
}

describe('annotation feature semantic equality', () => {
  it('accepts separately allocated but exactly equal feature content', () => {
    const left = feature();
    const right = feature({
      segments: left.segments?.map((range) => ({ ...range })),
      exons: left.exons?.map((range) => ({ ...range })),
      cds: left.cds?.map((range) => ({ ...range })),
      qualifiers: { ...left.qualifiers },
    });
    expect(annotationFeaturesSemanticallyEqual(left, right)).toBe(true);
    expect(annotationFeatureArraysSemanticallyEqual([left], [right])).toBe(true);
  });

  it.each([
    [
      'exon coordinates',
      {
        exons: [
          { start: 101, end: 250 },
          { start: 701, end: 900 },
        ],
      },
    ],
    [
      'CDS coordinates',
      {
        cds: [
          { start: 141, end: 200 },
          { start: 701, end: 850 },
        ],
      },
    ],
    ['segment coordinates', { segments: [{ start: 121, end: 900 }] }],
    ['canonical identity', { canonicalIdentity: 'annotation.v2:tx-7-refined' }],
    ['transcript identity', { transcriptId: 'tx-7-refined' }],
    ['source identity', { sourceId: 'source-7-refined' }],
    ['display label', { displayName: 'TX7 refined' }],
    ['color', { color: 0xef4444 }],
    ['qualifier value', { qualifiers: { ID: 'tx-7', codon_start: '2' } }],
    ['qualifier key set', { qualifiers: { ID: 'tx-7', codon_start: '1', Parent: 'gene-7' } }],
  ] satisfies Array<[string, Partial<Feature>]>)(
    'rejects same-count/same-outer-range publications with changed %s',
    (_label, change) => {
      expect(annotationFeaturesSemanticallyEqual(feature(), feature(change))).toBe(false);
      expect(annotationFeatureArraysSemanticallyEqual([feature()], [feature(change)])).toBe(false);
    }
  );
});
