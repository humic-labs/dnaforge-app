import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import {
  buildPileupReadDifferenceMarks,
  PILEUP_DIFFERENCE_COLOR_BY_THEME,
  pileupDifferenceColor,
} from './pileup-read-glyphs';

const READ: PileupRecord = {
  chrom: 'chr7',
  start: 1_000,
  end: 1_010,
  readId: 'read-1',
  flag: 99,
  strand: '+',
  mapq: 60,
  mismatches: [
    { pos: 1_002, kind: 'sub', length: 1, refBase: 'A', readBase: 'T', baseQ: 38 },
    { pos: 1_004, kind: 'ins', length: 2, readBase: 'GG', baseQ: 31 },
    { pos: 1_006, kind: 'del', length: 3, refBase: 'CCC' },
  ],
};

describe('pileup read difference marks', () => {
  it('keeps substitutions and indel spans on exact assembly-global coordinates', () => {
    const marks = buildPileupReadDifferenceMarks({
      records: [READ],
      rows: new Int32Array([2]),
      viewportStartBp: 999,
      viewportEndBp: 1_011,
    });

    expect(
      marks.map(({ bp, length, row, recordIndex, event }) => ({
        bp,
        length,
        row,
        recordIndex,
        kind: event.kind,
        baseQ: event.baseQ,
      }))
    ).toEqual([
      { bp: 1_002, length: 1, row: 2, recordIndex: 0, kind: 'sub', baseQ: 38 },
      { bp: 1_004, length: 2, row: 2, recordIndex: 0, kind: 'ins', baseQ: 31 },
      { bp: 1_006, length: 3, row: 2, recordIndex: 0, kind: 'del', baseQ: undefined },
    ]);
  });

  it('clips by event span and ignores hidden read rows', () => {
    expect(
      buildPileupReadDifferenceMarks({
        records: [READ],
        rows: new Int32Array([0]),
        viewportStartBp: 1_008,
        viewportEndBp: 1_009,
      }).map((mark) => mark.event.kind)
    ).toEqual(['del']);

    expect(
      buildPileupReadDifferenceMarks({
        records: [READ],
        rows: new Int32Array([-1]),
        viewportStartBp: 999,
        viewportEndBp: 1_011,
      })
    ).toEqual([]);
  });

  it('uses one theme-adjusted accent for every read difference', () => {
    expect(pileupDifferenceColor('light')).toEqual([224 / 255, 68 / 255, 25 / 255]);
    expect(pileupDifferenceColor('dark')).toEqual([1, 107 / 255, 92 / 255]);
    expect(pileupDifferenceColor('light')).toEqual(PILEUP_DIFFERENCE_COLOR_BY_THEME.light);
    expect(pileupDifferenceColor('dark')).toEqual(PILEUP_DIFFERENCE_COLOR_BY_THEME.dark);
  });
});
