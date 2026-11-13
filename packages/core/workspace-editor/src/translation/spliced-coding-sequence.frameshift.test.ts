import { describe, it, expect } from 'vitest';
import { buildSplicedCodingSequence } from './spliced-coding-sequence';
import type { Annotation } from '@waypoint/sequence-utils';

function splicedCds(
  segments: Array<{ start: number; end: number }>,
  over: Partial<Annotation> = {}
): Annotation {
  const starts = segments.map((s) => s.start);
  const ends = segments.map((s) => s.end);
  const locationString = `join(${segments.map((s) => `${s.start}..${s.end}`).join(',')})`;
  return {
    name: 'test',
    type: 'CDS',
    start: Math.min(...starts),
    end: Math.max(...ends),
    direction: 1,
    segments,
    qualifiers: { _locationString: [locationString] },
    ...over,
  };
}

const SEQ = 'ACGT'.repeat(500);

describe('buildSplicedCodingSequence — frameshift junctions are not introns', () => {
  it('emits NO intron for a -1 slip (base re-read) — today it fabricates a genome-length one', () => {
    const cds = splicedCds([
      { start: 1, end: 60 },
      { start: 60, end: 120 },
    ]);

    const result = buildSplicedCodingSequence(cds, SEQ);

    expect(result.introns).toHaveLength(0);
  });

  it('emits no circular intron for a multi-base overlap in a linear CDS', () => {
    const cds = splicedCds([
      { start: 1, end: 60 },
      { start: 58, end: 120 },
    ]);
    expect(buildSplicedCodingSequence(cds, SEQ).introns).toHaveLength(0);
  });

  it('emits NO intron for a +1 skip (base skipped) — today it reports a 1 bp intron', () => {
    const cds = splicedCds([
      { start: 1, end: 60 },
      { start: 62, end: 120 },
    ]);

    const result = buildSplicedCodingSequence(cds, SEQ);

    expect(result.introns).toHaveLength(0);
  });

  it('still emits NO intron for adjacent segments (gap 0) — pUC19 AmpR shape', () => {
    const cds = splicedCds([
      { start: 1, end: 60 },
      { start: 61, end: 120 },
    ]);

    const result = buildSplicedCodingSequence(cds, SEQ);

    expect(result.introns).toHaveLength(0);
  });

  it('STILL emits a real intron for a genuine splice gap', () => {
    const cds = splicedCds([
      { start: 1, end: 60 },
      { start: 161, end: 220 },
    ]);

    const result = buildSplicedCodingSequence(cds, SEQ);

    expect(result.introns).toHaveLength(1);
    expect(result.introns[0].length).toBe(100);
    expect(result.introns[0].genomicStart).toBe(60);
    expect(result.introns[0].genomicEnd).toBe(159);
  });

  it('handles a CDS mixing real introns with a frameshift (the human OAZ3 shape)', () => {
    const cds = splicedCds([
      { start: 1, end: 30 },
      { start: 231, end: 290 },
      { start: 292, end: 350 },
      { start: 551, end: 610 },
    ]);

    const result = buildSplicedCodingSequence(cds, SEQ);

    expect(result.introns).toHaveLength(2);
    expect(result.introns.map((i) => i.length)).toEqual([200, 200]);
  });

  it('emits no intron for a -1 slip on the reverse strand', () => {
    const cds = splicedCds(
      [
        { start: 1, end: 60 },
        { start: 60, end: 120 },
      ],
      { direction: -1 }
    );

    const result = buildSplicedCodingSequence(cds, SEQ);

    expect(result.introns).toHaveLength(0);
  });

  it('never reports an intron longer than the CDS footprint', () => {
    const cds = splicedCds([
      { start: 1, end: 60 },
      { start: 60, end: 120 },
    ]);

    const result = buildSplicedCodingSequence(cds, SEQ);
    const footprint = cds.end - cds.start + 1;

    for (const intron of result.introns) {
      expect(intron.length).toBeLessThan(footprint);
    }
  });
});
