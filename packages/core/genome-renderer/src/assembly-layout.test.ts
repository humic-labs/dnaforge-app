import { describe, it, expect } from 'vitest';
import type { Chromosome } from './chromosome';
import {
  buildAssembly,
  globalBpToChrom,
  chromLocalBpToGlobal,
  placementForChrom,
  placementsInGlobalRange,
  globalRangeToSegments,
} from './assembly-layout';

function chrom(id: string, length: number): Chromosome {
  return { id, displayName: id, length, cytobands: [] };
}

describe('assembly-layout  multi-chromosome shared axis)', () => {
  const chr1 = chrom('chr1', 248_956_422);
  const chr11 = chrom('chr11', 135_086_622);
  const chr22 = chrom('chr22', 50_818_468);
  const asm = buildAssembly('grch38', 'GRCh38', [chr1, chr11, chr22]);

  it('lays chromosomes end-to-end with cumulative offsets; total == Σ lengths', () => {
    expect(asm.totalLengthBp).toBe(248_956_422 + 135_086_622 + 50_818_468);
    expect(asm.chromosomes.map((p) => p.globalStartBp)).toEqual([
      0,
      248_956_422,
      248_956_422 + 135_086_622,
    ]);
    expect(asm.chromosomes.map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it('boundaries carry ZERO bp: globalEnd(n) === globalStart(n+1)', () => {
    for (let i = 0; i + 1 < asm.chromosomes.length; i++) {
      expect(asm.chromosomes[i].globalEndBp).toBe(asm.chromosomes[i + 1].globalStartBp);
    }
  });

  it('round-trips local↔global inside every chromosome (incl. boundaries)', () => {
    for (const p of asm.chromosomes) {
      const samples = [0, 1, Math.floor(p.chromosome.length / 2), p.chromosome.length - 1];
      for (const localBp of samples) {
        const g = chromLocalBpToGlobal(asm, p.chromosome.id, localBp);
        expect(g).not.toBeNull();
        const back = globalBpToChrom(asm, g as number);
        expect(back?.chrom).toBe(p.chromosome.id);
        expect(back?.localBp).toBe(localBp);
      }
    }
  });

  it('maps the boundary global bp to the NEXT chromosome bp 0 (end-exclusive)', () => {
    const g = chromLocalBpToGlobal(asm, 'chr1', chr1.length);
    expect(g).toBe(248_956_422);
    expect(globalBpToChrom(asm, g as number)).toMatchObject({ chrom: 'chr11', localBp: 0 });
  });

  it('returns null for out-of-range / unknown inputs', () => {
    expect(globalBpToChrom(asm, -1)).toBeNull();
    expect(globalBpToChrom(asm, asm.totalLengthBp)).toBeNull();
    expect(globalBpToChrom(asm, Number.NaN)).toBeNull();
    expect(chromLocalBpToGlobal(asm, 'chrX', 0)).toBeNull();
    expect(chromLocalBpToGlobal(asm, 'chr1', -1)).toBeNull();
    expect(chromLocalBpToGlobal(asm, 'chr1', chr1.length + 1)).toBeNull();
    expect(chromLocalBpToGlobal(asm, 'chr1', chr1.length)).toBe(chr1.length);
  });

  it('length-scaling: band width is proportional to chromosome length', () => {
    const widths = asm.chromosomes.map((p) => p.globalEndBp - p.globalStartBp);
    expect(widths).toEqual([248_956_422, 135_086_622, 50_818_468]);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
  });

  it('placementForChrom finds by id; null when absent', () => {
    expect(placementForChrom(asm, 'chr11')?.globalStartBp).toBe(248_956_422);
    expect(placementForChrom(asm, 'chrY')).toBeNull();
  });

  it('placementsInGlobalRange returns only overlapping segments', () => {
    const inChr11 = placementsInGlobalRange(asm, 248_956_422 + 1000, 248_956_422 + 2000);
    expect(inChr11.map((p) => p.chromosome.id)).toEqual(['chr11']);

    const straddle = placementsInGlobalRange(asm, 248_956_422 - 500, 248_956_422 + 500);
    expect(straddle.map((p) => p.chromosome.id)).toEqual(['chr1', 'chr11']);

    expect(placementsInGlobalRange(asm, 0, asm.totalLengthBp)).toHaveLength(3);
    expect(placementsInGlobalRange(asm, 100, 100)).toHaveLength(0);
  });

  it('single chromosome is the degenerate N=1 assembly (offset 0, total == length)', () => {
    const solo = buildAssembly('chr11', 'chr11', [chr11]);
    expect(solo.totalLengthBp).toBe(chr11.length);
    expect(solo.chromosomes[0].globalStartBp).toBe(0);
    expect(solo.chromosomes[0].globalEndBp).toBe(chr11.length);
    expect(globalBpToChrom(solo, 5)).toMatchObject({ chrom: 'chr11', localBp: 5 });
  });
});

describe('globalRangeToSegments  LOD continuum — local clip + offset)', () => {
  const chr1 = chrom('chr1', 248_956_422);
  const chr11 = chrom('chr11', 135_086_622);
  const chr22 = chrom('chr22', 50_818_468);
  const asm = buildAssembly('grch38', 'GRCh38', [chr1, chr11, chr22]);
  const chr11Start = 248_956_422;
  const chr22Start = 248_956_422 + 135_086_622;

  it('clips a viewport wholly inside one chromosome to its LOCAL range', () => {
    const segs = globalRangeToSegments(asm, chr11Start + 1000, chr11Start + 6000);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      chrom: 'chr11',
      localStart: 1000,
      localEnd: 6000,
      globalStart: chr11Start,
    });
  });

  it('offsetting a segment local range back by globalStart recovers the global viewport', () => {
    const gStart = chr11Start + 1000;
    const gEnd = chr11Start + 6000;
    const [s] = globalRangeToSegments(asm, gStart, gEnd);
    expect(s.localStart + s.globalStart).toBe(gStart);
    expect(s.localEnd + s.globalStart).toBe(gEnd);
  });

  it('splits a seam-spanning viewport into one segment per chromosome, ordered left→right', () => {
    const segs = globalRangeToSegments(asm, chr11Start - 500, chr11Start + 700);
    expect(segs.map((s) => s.chrom)).toEqual(['chr1', 'chr11']);
    expect(segs[0]).toMatchObject({
      chrom: 'chr1',
      localStart: chr1.length - 500,
      localEnd: chr1.length,
      globalStart: 0,
    });
    expect(segs[1]).toMatchObject({
      chrom: 'chr11',
      localStart: 0,
      localEnd: 700,
      globalStart: chr11Start,
    });
  });

  it('a genome-wide viewport returns every chromosome clipped to its full local span', () => {
    const segs = globalRangeToSegments(asm, 0, asm.totalLengthBp);
    expect(segs.map((s) => s.chrom)).toEqual(['chr1', 'chr11', 'chr22']);
    expect(segs.map((s) => s.localStart)).toEqual([0, 0, 0]);
    expect(segs.map((s) => s.localEnd)).toEqual([chr1.length, chr11.length, chr22.length]);
    expect(segs.map((s) => s.globalStart)).toEqual([0, chr11Start, chr22Start]);
  });

  it('clamps a viewport that overshoots the axis ends to real local bounds', () => {
    const segs = globalRangeToSegments(asm, chr22Start + 10, asm.totalLengthBp + 5_000_000);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      chrom: 'chr22',
      localStart: 10,
      localEnd: chr22.length,
      globalStart: chr22Start,
    });
  });

  it('empty / inverted ranges and non-finite inputs return no segments', () => {
    expect(globalRangeToSegments(asm, 100, 100)).toEqual([]);
    expect(globalRangeToSegments(asm, 200, 100)).toEqual([]);
    expect(globalRangeToSegments(asm, Number.NaN, 100)).toEqual([]);
    expect(globalRangeToSegments(asm, 0, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('IDENTITY ORACLE: assembly-of-one → exactly one segment, globalStart 0, local ≡ global', () => {
    const solo = buildAssembly('chr11', 'chr11', [chr11]);
    const segs = globalRangeToSegments(solo, 0, chr11.length);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      chrom: 'chr11',
      localStart: 0,
      localEnd: chr11.length,
      globalStart: 0,
    });
    const [sub] = globalRangeToSegments(solo, 10_000, 20_000);
    expect(sub).toMatchObject({ localStart: 10_000, localEnd: 20_000, globalStart: 0 });
  });
});
