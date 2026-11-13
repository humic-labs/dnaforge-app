// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { CatalogRecord } from '@waypoint/genome-data/annotation-catalog';

import {
  buildRecordHoverIndex,
  buildStrandHoverIndexes,
  nearestRecordAt,
  sortRecordsBySpanStart,
} from './record-hover-index';

function unit(id: string, start: number, end: number): CatalogRecord {
  return {
    id,
    kind: 'transcription_unit',
    strand: '+',
    location: { shape: 'region', start, end },
    genes: [],
    geneLocusTags: [],
    name: null,
    score: null,
    conditions: [],
  };
}

function startSite(id: string, bp: number): CatalogRecord {
  return {
    id,
    kind: 'tss',
    strand: '-',
    location: { shape: 'point', bp },
    classification: null,
    name: null,
    score: null,
    conditions: [],
  };
}

describe('record hover index', () => {
  const index = buildRecordHoverIndex(
    sortRecordsBySpanStart([
      startSite('tss-500', 500),
      unit('long', 0, 10_000),
      unit('short', 400, 600),
      startSite('tss-9000', 9_000),
    ])
  );

  it('prefers the shortest record containing the position', () => {
    expect(nearestRecordAt(index, 450, 2)?.id).toBe('short');
    expect(nearestRecordAt(index, 5_000, 2)?.id).toBe('long');
  });

  it('finds a point record within the tolerance and nothing beyond it', () => {
    expect(nearestRecordAt(index, 500.5, 1)?.id).toBe('tss-500');
    expect(nearestRecordAt(index, 12_000, 4)).toBeNull();
  });

  it('still reaches records whose start is far left of the pointer', () => {
    expect(nearestRecordAt(index, 9_999.5, 0)?.id).toBe('long');
  });

  it('splits records by strand so a lookup never answers with the other strand', () => {
    const byStrand = buildStrandHoverIndexes(
      sortRecordsBySpanStart([startSite('tss-500', 500), unit('short', 400, 600)])
    );
    expect(nearestRecordAt(byStrand['+'], 500.5, 1)?.id).toBe('short');
    expect(nearestRecordAt(byStrand['-'], 500.5, 1)?.id).toBe('tss-500');
    expect(nearestRecordAt(byStrand['-'], 450, 2)).toBeNull();
  });
});
