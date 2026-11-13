import type { PileupRecord } from '@waypoint/genome-data';

export interface SyntheticPileupOptions {
  chrom: string;
  windowStart: number;
  windowEnd: number;
  depth: number;
  readLength: number;
  seed?: number;
}

export function generateSyntheticPileup(opts: SyntheticPileupOptions): PileupRecord[] {
  const { chrom, windowStart, windowEnd, depth, readLength } = opts;
  const windowLength = Math.max(0, windowEnd - windowStart);
  if (windowLength <= readLength || depth <= 0 || readLength <= 0) return [];

  const numReads = Math.round((depth * windowLength) / readLength);

  let state = (opts.seed ?? 1) >>> 0 || 1;
  const rnd = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  const maxStart = windowEnd - readLength;
  const span = maxStart - windowStart;

  const reads: PileupRecord[] = [];
  for (let i = 0; i < numReads; i++) {
    const start = windowStart + Math.floor(rnd() * (span + 1));
    const strand: '+' | '-' = rnd() < 0.5 ? '+' : '-';
    reads.push({
      chrom,
      start,
      end: start + readLength,
      readId: `synth-read-${i}`,
      strand,
      mapq: 60,
    });
  }
  return reads;
}
