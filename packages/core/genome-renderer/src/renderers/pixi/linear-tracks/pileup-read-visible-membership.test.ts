import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import {
  advanceReadVisibleMembershipJob,
  beginReadVisibleMembershipJob,
  finishReadVisibleMembershipJob,
  isReadVisibleMembershipJobComplete,
} from './pileup-read-visible-membership';

function read(start: number, end: number, readId = `${start}-${end}`): PileupRecord {
  return { chrom: 'chr1', start, end, readId, mapq: 60, strand: '+' };
}

function compare(candidate: PileupRecord[], incoming: PileupRecord[], start = 100, end = 200) {
  const job = beginReadVisibleMembershipJob(candidate, incoming, start, end);
  advanceReadVisibleMembershipJob(job, Number.POSITIVE_INFINITY);
  return finishReadVisibleMembershipJob(job);
}

describe('current visible read membership', () => {
  it('accepts changed offscreen bands while retaining edge-crossing reads', () => {
    const left = read(80, 110);
    const middle = read(120, 140);
    const right = read(190, 220);
    expect(compare([left, middle, right], [read(0, 10), left, middle, right, read(300, 400)])).toBe(
      true
    );
  });

  it('rejects newly visible, removed, copied and repeated records', () => {
    const a = read(100, 150, 'same-id');
    const b = read(120, 160, 'same-id');
    expect(compare([a], [a, b])).toBe(false);
    expect(compare([a, b], [a])).toBe(false);
    expect(compare([a], [{ ...a }])).toBe(false);
    expect(compare([a, b], [a, a])).toBe(false);
    expect(compare([a, b], [b, a])).toBe(false);
  });

  it('does not certify a visible read that the candidate row limit hid', () => {
    const crossing = read(90, 200);
    const job = beginReadVisibleMembershipJob(
      [read(0, 100), crossing],
      [crossing],
      150,
      160,
      new Int32Array([0, -1])
    );
    advanceReadVisibleMembershipJob(job, 100);
    expect(finishReadVisibleMembershipJob(job)).toBe(false);
  });

  it('yields without admitting incomplete comparisons and resumes exactly', () => {
    const shared = Array.from({ length: 80 }, (_, i) => read(i * 5, i * 5 + 12));
    const job = beginReadVisibleMembershipJob(shared, [...shared, read(1000, 1010)], 100, 200);
    let clock = 0;
    const now = () => (clock += 0.1);
    expect(advanceReadVisibleMembershipJob(job, 1000, { workBudgetMs: 0.25, now })).toBeGreaterThan(
      0
    );
    expect(isReadVisibleMembershipJobComplete(job)).toBe(false);
    expect(() => finishReadVisibleMembershipJob(job)).toThrow(/incomplete/i);
    let calls = 0;
    while (!isReadVisibleMembershipJobComplete(job) && calls++ < 200) {
      expect(advanceReadVisibleMembershipJob(job, 1)).toBeLessThanOrEqual(1);
    }
    expect(finishReadVisibleMembershipJob(job)).toBe(true);
  });

  it('counts skipped offscreen records against the work cap', () => {
    const a = read(120, 150);
    const job = beginReadVisibleMembershipJob([read(0, 10), read(20, 30), a], [a], 100, 200);
    expect(advanceReadVisibleMembershipJob(job, 1)).toBe(1);
    expect(isReadVisibleMembershipJobComplete(job)).toBe(false);
    expect(advanceReadVisibleMembershipJob(job, 1)).toBe(1);
    expect(isReadVisibleMembershipJobComplete(job)).toBe(false);
    advanceReadVisibleMembershipJob(job, 100);
    expect(finishReadVisibleMembershipJob(job)).toBe(true);
  });

  it('preserves empty membership and fails closed for invalid viewport bounds', () => {
    expect(compare([], [])).toBe(true);
    expect(compare([read(0, 10)], [read(200, 210)])).toBe(true);
    expect(compare([], [], 200, 100)).toBe(false);
  });

  it('does not read the clock again without consuming more input', () => {
    const shared = Array.from({ length: 32 }, (_, i) => read(100 + i, 200 + i));
    const job = beginReadVisibleMembershipJob(shared, [...shared], 100, 400);
    const checkedItems: number[] = [];
    advanceReadVisibleMembershipJob(job, Number.POSITIVE_INFINITY, {
      workBudgetMs: 2,
      now: () => {
        checkedItems.push(job.candidateCursor + job.incomingCursor);
        return 0;
      },
    });
    expect(checkedItems).toEqual(Array.from({ length: 17 }, (_, i) => i * 4));
    expect(finishReadVisibleMembershipJob(job)).toBe(true);
  });

  it.each([100, 2000])('yields long matching scans with viewport starting at %i', (start) => {
    const shared = Array.from({ length: 1000 }, (_, i) => read(100 + i, 200 + i));
    const job = beginReadVisibleMembershipJob(shared, [...shared], start, start + 1400);
    let checks = 0;
    const consumed = advanceReadVisibleMembershipJob(job, Number.POSITIVE_INFINITY, {
      workBudgetMs: 2,
      now: () => checks++,
    });
    expect(consumed).toBe(8);
    expect(job.candidateCursor + job.incomingCursor).toBe(8);
    expect(isReadVisibleMembershipJobComplete(job)).toBe(false);
    advanceReadVisibleMembershipJob(job, Number.POSITIVE_INFINITY);
    expect(finishReadVisibleMembershipJob(job)).toBe(true);
  });
});
