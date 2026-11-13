import { describe, expect, it } from 'vitest';

import type { AnnotationRecord } from './records';
import { buildTextIntervalQueryIndex, queryTextIntervalRegions } from './text-interval-query';

const records: AnnotationRecord[] = [
  { chrom: 'chr1', start: 0, end: 1_000, name: 'long' },
  { chrom: 'chr1', start: 100, end: 120, name: 'left' },
  { chrom: 'chr1', start: 160, end: 180, name: 'right' },
  { chrom: 'chr2', start: 10, end: 20, name: 'other-reference' },
];

describe('text interval regional query contract', () => {
  it('returns exact overlapping records without losing intervals that begin before the viewport', () => {
    const index = buildTextIntervalQueryIndex(records);

    expect(
      queryTextIntervalRegions(index, [{ refName: 'chr1', start: 150, end: 170 }], {
        maxRecords: 10,
        maxOverlap: 32,
        densityBinCount: 8,
      })
    ).toEqual([
      {
        kind: 'records',
        records: [records[0], records[2]],
        totalRecords: 2,
      },
    ]);
  });

  it('falls back to bounded deterministic density bins when exact records exceed the cap', () => {
    const dense = Array.from({ length: 100 }, (_, index) => ({
      chrom: 'chr1',
      start: index,
      end: index + 10,
      name: `feature-${index}`,
    }));
    const index = buildTextIntervalQueryIndex(dense);

    const [result] = queryTextIntervalRegions(index, [{ refName: 'chr1', start: 0, end: 100 }], {
      maxRecords: 20,
      maxOverlap: 32,
      densityBinCount: 10,
    });

    expect(result.kind).toBe('density');
    if (result.kind !== 'density') throw new Error('expected density');
    expect(result.totalRecords).toBe(100);
    expect(result.bins).toHaveLength(10);
    expect(result.bins[0]).toEqual({ start: 0, end: 10, count: 10 });
    expect(result.bins.at(-1)).toEqual({ start: 90, end: 100, count: 19 });
    expect(Math.max(...result.bins.map((bin) => bin.count))).toBe(19);
  });

  it('returns one empty exact result for a reference absent from the source', () => {
    const index = buildTextIntervalQueryIndex(records);

    expect(
      queryTextIntervalRegions(index, [{ refName: 'chrM', start: 0, end: 100 }], {
        maxRecords: 10,
        maxOverlap: 32,
        densityBinCount: 8,
      })
    ).toEqual([{ kind: 'records', records: [], totalRecords: 0 }]);
  });

  it('uses density before exact lane packing would discard overlapping records', () => {
    const overlapping = Array.from({ length: 6 }, (_, recordIndex) => ({
      chrom: 'chr1',
      start: recordIndex,
      end: 100,
    }));

    expect(
      queryTextIntervalRegions(
        buildTextIntervalQueryIndex(overlapping),
        [{ refName: 'chr1', start: 0, end: 100 }],
        { maxRecords: 100, maxOverlap: 4, densityBinCount: 10 }
      )[0].kind
    ).toBe('density');
  });
});
