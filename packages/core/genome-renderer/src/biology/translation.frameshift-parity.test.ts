import { describe, it, expect } from 'vitest';
import { getCDSIntrons } from './translation';

const SEQ = 'ACGT'.repeat(500);

function introns(segments: Array<{ start: number; end: number }>) {
  const starts = segments.map((s) => s.start);
  const ends = segments.map((s) => s.end);
  return getCDSIntrons(SEQ, Math.min(...starts) - 1, Math.max(...ends), 'forward', { segments });
}

describe('getCDSIntrons — frameshift junctions are not introns (parity copy)', () => {
  it('emits NO intron for a -1 slip (base re-read)', () => {
    expect(
      introns([
        { start: 1, end: 60 },
        { start: 60, end: 120 },
      ])
    ).toHaveLength(0);
  });

  it('emits NO intron for a +1 skip (base skipped)', () => {
    expect(
      introns([
        { start: 1, end: 60 },
        { start: 62, end: 120 },
      ])
    ).toHaveLength(0);
  });

  it('emits NO intron for adjacent segments (gap 0)', () => {
    expect(
      introns([
        { start: 1, end: 60 },
        { start: 61, end: 120 },
      ])
    ).toHaveLength(0);
  });

  it('STILL emits a real intron for a genuine splice gap', () => {
    const result = introns([
      { start: 1, end: 60 },
      { start: 161, end: 220 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].length).toBe(100);
  });

  it('never reports an intron longer than the CDS footprint', () => {
    const result = introns([
      { start: 1, end: 60 },
      { start: 60, end: 120 },
    ]);
    for (const intron of result) {
      expect(intron.length).toBeLessThan(120);
    }
  });

  it('keeps every real intron in a CDS that mixes introns with a frameshift', () => {
    const result = introns([
      { start: 1, end: 30 },
      { start: 231, end: 290 },
      { start: 292, end: 350 },
      { start: 551, end: 610 },
    ]);
    expect(result.map((i) => i.length)).toEqual([200, 200]);
  });
});
