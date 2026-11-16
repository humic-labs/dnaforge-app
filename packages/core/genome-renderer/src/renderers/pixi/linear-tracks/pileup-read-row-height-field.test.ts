import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import {
  advanceReadRowHeightFieldJob,
  beginReadRowHeightFieldJob,
  finishReadRowHeightFieldJob,
  isReadRowHeightFieldJobComplete,
} from './pileup-read-row-height-field';

function read(start: number, end: number): PileupRecord {
  return { chrom: 'chr1', start, end, readId: `${start}-${end}`, mapq: 60, strand: '+' };
}

describe('read row height preparation', () => {
  it('resumes elapsed work without publishing an incomplete field', () => {
    const job = beginReadRowHeightFieldJob(
      [read(0, 48), read(16, 64), read(48, 80), read(0, 80)],
      new Int32Array([0, 4, 2, -1]),
      0,
      80
    );
    let clock = 0;
    const now = () => (clock += 0.1);
    const advanced = advanceReadRowHeightFieldJob(job, 100, { workBudgetMs: 0.25, now });
    expect(advanced).toBeGreaterThan(0);
    expect(isReadRowHeightFieldJobComplete(job)).toBe(false);
    expect(() => finishReadRowHeightFieldJob(job)).toThrow(/incomplete/i);
    while (!isReadRowHeightFieldJobComplete(job)) {
      advanceReadRowHeightFieldJob(job, 100, { workBudgetMs: 0.25, now });
    }
    expect(finishReadRowHeightFieldJob(job)).toEqual({
      startBp: 0,
      endBp: 80,
      binSizeBp: 16,
      bins: new Uint16Array([1, 5, 5, 5, 3]),
    });
  });

  it('bounds bin updates within a single long read', () => {
    const job = beginReadRowHeightFieldJob([read(0, 1024)], new Int32Array([7]), 0, 1024);
    for (let i = 0; i < 32; i++) {
      expect(advanceReadRowHeightFieldJob(job, 1)).toBeLessThanOrEqual(1);
      expect(isReadRowHeightFieldJobComplete(job)).toBe(false);
    }
    let calls = 32;
    while (!isReadRowHeightFieldJobComplete(job) && calls++ < 100) {
      advanceReadRowHeightFieldJob(job, 1);
    }
    expect(isReadRowHeightFieldJobComplete(job)).toBe(true);
    expect(finishReadRowHeightFieldJob(job)?.bins).toEqual(new Uint16Array(64).fill(8));
  });

  it('counts hidden and clipped records against the item cap', () => {
    const job = beginReadRowHeightFieldJob(
      [read(0, 16), read(100, 116), read(0, 16), read(0, 16)],
      new Int32Array([-1, 1, -1, 2]),
      0,
      16
    );
    for (let i = 0; i < 3; i++) {
      expect(advanceReadRowHeightFieldJob(job, 1)).toBe(1);
      expect(isReadRowHeightFieldJobComplete(job)).toBe(false);
    }
    advanceReadRowHeightFieldJob(job, 10);
    expect(finishReadRowHeightFieldJob(job)?.bins).toEqual(new Uint16Array([3]));
  });

  it('preserves clipping, the bin ceiling and saturated heights', () => {
    const job = beginReadRowHeightFieldJob(
      [read(-16, 16), read(16, 48)],
      new Int32Array([70_000, 1]),
      0,
      32
    );
    advanceReadRowHeightFieldJob(job, 100);
    expect(finishReadRowHeightFieldJob(job)?.bins).toEqual(new Uint16Array([65535, 2]));
    const large = beginReadRowHeightFieldJob(
      [read(0, 1_000_000)],
      new Int32Array([0]),
      0,
      1_000_000
    );
    advanceReadRowHeightFieldJob(large, Number.POSITIVE_INFINITY);
    expect(finishReadRowHeightFieldJob(large)?.bins.length).toBe(32768);
  });

  it('finishes invalid and empty inputs without work', () => {
    for (const job of [
      beginReadRowHeightFieldJob([], new Int32Array(), 0, 16),
      beginReadRowHeightFieldJob([read(0, 16)], null, 0, 16),
      beginReadRowHeightFieldJob([read(0, 16)], new Int32Array(), 0, 16),
      beginReadRowHeightFieldJob([read(0, 16)], new Int32Array([0]), 16, 16),
    ]) {
      expect(isReadRowHeightFieldJobComplete(job)).toBe(true);
      expect(advanceReadRowHeightFieldJob(job, 1)).toBe(0);
      expect(finishReadRowHeightFieldJob(job)).toBeNull();
    }
  });
});
