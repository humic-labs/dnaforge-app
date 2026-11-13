// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import { generateSyntheticPileup } from './synth-pileup-generator';

function meanDepth(reads: readonly PileupRecord[], start: number, end: number): Int32Array {
  const depth = new Int32Array(Math.max(0, end - start));
  for (const r of reads) {
    const s = Math.max(r.start, start);
    const e = Math.min(r.end, end);
    for (let p = s; p < e; p++) depth[p - start] += 1;
  }
  return depth;
}

const BASE = {
  chrom: 'chr11',
  windowStart: 1_000_000,
  windowEnd: 1_020_000,
  depth: 30,
  readLength: 150,
} as const;

describe('generateSyntheticPileup', () => {
  it('is deterministic for a given seed', () => {
    const a = generateSyntheticPileup({ ...BASE, seed: 42 });
    const b = generateSyntheticPileup({ ...BASE, seed: 42 });
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('differs across seeds', () => {
    const a = generateSyntheticPileup({ ...BASE, seed: 1 });
    const b = generateSyntheticPileup({ ...BASE, seed: 2 });
    expect(b).not.toEqual(a);
  });

  it('emits in-bounds 0-based-half-open reads with read identity', () => {
    const reads = generateSyntheticPileup({ ...BASE, seed: 7 });
    expect(reads.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const r of reads) {
      expect(r.chrom).toBe('chr11');
      expect(r.end).toBeGreaterThan(r.start);
      expect(r.start).toBeGreaterThanOrEqual(BASE.windowStart);
      expect(r.end).toBeLessThanOrEqual(BASE.windowEnd);
      expect(r.end - r.start).toBe(BASE.readLength);
      expect(['+', '-']).toContain(r.strand);
      expect(typeof r.mapq).toBe('number');
      ids.add(r.readId);
    }
    expect(ids.size).toBe(reads.length);
  });

  it('achieves approximately the requested mean coverage', () => {
    const reads = generateSyntheticPileup({ ...BASE, seed: 99 });
    const cov = meanDepth(reads, BASE.windowStart, BASE.windowEnd);
    const edge = BASE.readLength;
    let sum = 0;
    let n = 0;
    for (let i = edge; i < cov.length - edge; i++) {
      sum += cov[i];
      n++;
    }
    const mean = sum / n;
    expect(mean).toBeGreaterThan(BASE.depth * 0.85);
    expect(mean).toBeLessThan(BASE.depth * 1.15);
  });
});
