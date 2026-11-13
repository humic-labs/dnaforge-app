// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  projectAlignmentAlternateColumn,
  projectAlignmentReadRow,
  projectAlignmentReadRows,
  type AlignmentReadRow,
} from './tile-engine-driver';

describe('projectAlignmentReadRow', () => {
  it('projects every read and mismatch coordinate onto the assembly-global axis', () => {
    const row: AlignmentReadRow = {
      start: 10,
      end: 20,
      strand: '+',
      mapq: 60,
      readId: 'duplicate-qname',
      flag: 99,
      pair: {
        paired: true,
        properPair: true,
        readNumber: 1,
        mateUnmapped: false,
        mateReverse: true,
        mateStart: 40,
        templateLength: 80,
      },
      mismatches: [
        { pos: 14, kind: 'sub', length: 1, refBase: 'A', readBase: 'T', baseQ: 40 },
        { pos: 18, kind: 'ins', length: 2, readBase: 'GG', baseQ: 37 },
      ],
    };

    expect(
      projectAlignmentReadRow(row, {
        chrom: 'chr7',
        globalStartBp: 1_500_000_000,
      })
    ).toEqual({
      chrom: 'chr7',
      start: 1_500_000_010,
      end: 1_500_000_020,
      readId: 'duplicate-qname',
      strand: '+',
      mapq: 60,
      flag: 99,
      pair: {
        paired: true,
        properPair: true,
        readNumber: 1,
        mateUnmapped: false,
        mateReverse: true,
        mateStart: 1_500_000_040,
        templateLength: 80,
      },
      mismatches: [
        {
          pos: 1_500_000_014,
          kind: 'sub',
          length: 1,
          refBase: 'A',
          readBase: 'T',
          baseQ: 40,
        },
        {
          pos: 1_500_000_018,
          kind: 'ins',
          length: 2,
          readBase: 'GG',
          baseQ: 37,
        },
      ],
    });
  });

  it('draws a spliced short read as separate exon blocks, not one bar across the intron', () => {
    const row: AlignmentReadRow = {
      start: 1_000,
      end: 12_080,
      strand: '+',
      mapq: 60,
      readId: 'spliced',
      blocks: [
        { start: 1_000, end: 1_050 },
        { start: 12_050, end: 12_080 },
      ],
      mismatches: [{ pos: 1_010, kind: 'sub', length: 1, refBase: 'A', readBase: 'G' }],
    };
    const projected = projectAlignmentReadRows(row, { chrom: 'chr16', globalStartBp: 100_000 });
    expect(projected.map((record) => [record.start, record.end])).toEqual([
      [101_000, 101_050],
      [112_050, 112_080],
    ]);
    expect(projected[0]?.mismatches).toEqual([
      { pos: 101_010, kind: 'sub', length: 1, refBase: 'A', readBase: 'G' },
    ]);
    expect(projected[1]?.mismatches).toEqual([]);
    expect(projected[0]?.alignmentStart).toBeUndefined();
    expect(projected[1]?.alignmentStart).toBe(101_000);
    expect(projected.every((record) => record.end - record.start < 200)).toBe(true);
  });

  it('projects quality-weighted alternate columns onto the assembly-global axis', () => {
    expect(
      projectAlignmentAlternateColumn(
        {
          pos: 14,
          kind: 'sub',
          length: 1,
          refBase: 'A',
          readBase: 'T',
          coveringReadCount: 10,
          supportingReadCount: 4,
          weightedDepth: 9.9,
          weightedSupport: 3.9,
          weightedFraction: 0.394,
        },
        { globalStartBp: 1_500_000_000 }
      )
    ).toMatchObject({ pos: 1_500_000_014, weightedFraction: 0.394 });
  });
});
