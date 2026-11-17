import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import {
  buildPileupReadDifferenceMarks,
  beginPileupReadDifferenceMarksJob,
  advancePileupReadDifferenceMarksJob,
  isPileupReadDifferenceMarksJobComplete,
  finishPileupReadDifferenceMarksJob,
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

describe('bounded read-difference preparation', () => {
  it('yields inside one event-heavy read and resumes every mark exactly once', () => {
    const record: PileupRecord = {
      ...READ,
      end: 1_200,
      mismatches: Array.from({ length: 64 }, (_, index) => ({
        pos: 1_002 + index,
        kind: (['sub', 'ins', 'del'] as const)[index % 3]!,
        length: (index % 3) + 1,
        baseQ: index,
      })),
    };
    const input = { records: [record], rows: new Int32Array([2]) };
    const expected = buildPileupReadDifferenceMarks(input);
    const job = beginPileupReadDifferenceMarksJob(input);
    let clock = 0;
    const emitted: number[] = [];
    const options = {
      workBudgetMs: 2,
      now: () => clock,
      onMark: (_mark: unknown, index: number) => {
        emitted.push(index);
        clock += 0.5;
      },
    };

    expect(
      advancePileupReadDifferenceMarksJob(job, Number.POSITIVE_INFINITY, options)
    ).toBeGreaterThan(0);
    expect(job.marks.length).toBeGreaterThan(0);
    expect(job.marks.length).toBeLessThan(expected.length);
    expect(clock).toBeLessThanOrEqual(4);
    expect(isPileupReadDifferenceMarksJobComplete(job)).toBe(false);
    expect(() => finishPileupReadDifferenceMarksJob(job)).toThrow();

    let turns = 0;
    while (!isPileupReadDifferenceMarksJobComplete(job) && turns++ < 100) {
      expect(
        advancePileupReadDifferenceMarksJob(job, Number.POSITIVE_INFINITY, options)
      ).toBeGreaterThan(0);
    }
    expect(isPileupReadDifferenceMarksJobComplete(job)).toBe(true);
    expect(finishPileupReadDifferenceMarksJob(job)).toEqual(expected);
    expect(emitted).toEqual(Array.from({ length: expected.length }, (_, index) => index));
    expect(job.rowMarkIndices.get(2)).toEqual(emitted);
  });

  it.each(['empty', 'hidden', 'outside'] as const)(
    'bounds scanning %s records without producing marks',
    (kind) => {
      const records = Array.from({ length: 64 }, (_, index) => ({
        ...READ,
        readId: 'read-' + index,
        mismatches: kind === 'empty' ? undefined : READ.mismatches,
      }));
      const input = {
        records,
        rows: new Int32Array(records.length).fill(kind === 'hidden' ? -1 : 0),
        ...(kind === 'outside' ? { viewportStartBp: 5_000, viewportEndBp: 6_000 } : {}),
      };
      const job = beginPileupReadDifferenceMarksJob(input);
      let clock = 0;
      const consumed = advancePileupReadDifferenceMarksJob(job, Number.POSITIVE_INFINITY, {
        workBudgetMs: 2,
        now: () => (clock += 0.5),
      });
      expect(consumed).toBeGreaterThan(0);
      expect(consumed).toBeLessThan(records.length);
      expect(job.marks).toEqual([]);
      expect(isPileupReadDifferenceMarksJobComplete(job)).toBe(false);

      let turns = 0;
      while (!isPileupReadDifferenceMarksJobComplete(job) && turns++ < records.length) {
        const advanced = advancePileupReadDifferenceMarksJob(job, 3);
        expect(advanced).toBeGreaterThan(0);
        expect(advanced).toBeLessThanOrEqual(3);
      }
      expect(isPileupReadDifferenceMarksJobComplete(job)).toBe(true);
      expect(finishPileupReadDifferenceMarksJob(job)).toEqual([]);
    }
  );

  it('preserves raw event order, clipped indel spans and row buckets across item-limited calls', () => {
    const input = {
      records: [
        { ...READ, start: 1_020, end: 1_030, mismatches: [{ pos: 1_021, kind: 'sub' as const }] },
        READ,
        { ...READ, readId: 'hidden' },
      ],
      rows: new Int32Array([3, 1, -1]),
      viewportStartBp: 1_003,
      viewportEndBp: 1_024,
    };
    const job = beginPileupReadDifferenceMarksJob(input);
    let turns = 0;
    while (!isPileupReadDifferenceMarksJobComplete(job) && turns++ < 100) {
      const previousMarkCount = job.marks.length;
      expect(
        advancePileupReadDifferenceMarksJob(job, 1, {
          now: () => {
            throw new Error('No elapsed budget was requested');
          },
        })
      ).toBe(1);
      expect(job.marks.length - previousMarkCount).toBeLessThanOrEqual(1);
    }
    expect(isPileupReadDifferenceMarksJobComplete(job)).toBe(true);
    expect(finishPileupReadDifferenceMarksJob(job)).toEqual(buildPileupReadDifferenceMarks(input));
    expect(job.rowMarkIndices.get(3)).toEqual([0]);
    expect(job.rowMarkIndices.get(1)).toEqual([1, 2]);
    expect(job.rowMarkIndices.has(-1)).toBe(false);
  });
});
