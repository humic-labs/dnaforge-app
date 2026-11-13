import { describe, expect, it } from 'vitest';

import type { PileupMismatch, PileupRecord, PileupTrackData } from './records';

describe('PileupRecord', () => {
  it('is a 0-based half-open interval carrying read identity', () => {
    const r: PileupRecord = {
      chrom: 'chr11',
      start: 100,
      end: 250,
      readId: 'r1',
      strand: '+',
      mapq: 60,
    };
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.mismatches).toBeUndefined();
  });

  it('carries optional per-base mismatches in chromosome coordinates', () => {
    const mm: PileupMismatch = { pos: 120, kind: 'sub', refBase: 'A', readBase: 'G' };
    const r: PileupRecord = {
      chrom: 'chr11',
      start: 100,
      end: 250,
      readId: 'r2',
      strand: '-',
      mapq: 30,
      mismatches: [mm],
    };
    const first = r.mismatches?.[0];
    expect(first?.pos).toBe(120);
    expect(first?.pos).toBeGreaterThanOrEqual(r.start);
    expect(first?.pos).toBeLessThan(r.end);
  });

  it('carries optional paired-end metadata for read coloring and future filters', () => {
    const r: PileupRecord = {
      chrom: 'chr11',
      start: 100,
      end: 250,
      readId: 'pair/1',
      strand: '+',
      mapq: 60,
      pair: {
        paired: true,
        properPair: true,
        readNumber: 1,
        mateUnmapped: false,
        mateReverse: true,
        mateStart: 310,
        templateLength: 360,
      },
    };
    expect(r.pair?.paired).toBe(true);
    expect(r.pair?.properPair).toBe(true);
    expect(r.pair?.readNumber).toBe(1);
  });

  it('PileupTrackData wraps a records array (the setTrackData payload)', () => {
    const data: PileupTrackData = {
      dataAuthority: 'static',
      records: [],
      readSource: { truncated: false, windowStartBp: 100, windowEndBp: 200 },
    };
    expect(data.records).toHaveLength(0);
    expect(data.readSource?.truncated).toBe(false);
  });
});
