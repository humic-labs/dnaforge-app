import { describe, it, expect } from 'vitest';
import { cdsToProteinSpliced } from './translation';
import type { Annotation } from './types';

function cds(over: Partial<Annotation>): Annotation {
  return {
    name: 'test',
    type: 'CDS',
    start: 1,
    end: 1,
    direction: 1,
    ...over,
  };
}

describe('cdsToProteinSpliced — segment-aware translation', () => {
  it('translates a +1 frameshift (one base SKIPPED) from its segments, not its outer span', () => {
    const seq = 'ATGAAAGCCCGGGTTT';
    const annotation = cds({
      start: 1,
      end: 16,
      segments: [
        { start: 1, end: 6 },
        { start: 8, end: 16 },
      ],
    });

    expect(cdsToProteinSpliced(annotation, seq)).toBe('MKPGF');
  });

  it('translates a -1 frameshift (one base READ TWICE) — the case an outer span cannot express', () => {
    const seq = 'ATGAAACCCGGGTTT';
    const annotation = cds({
      start: 1,
      end: 15,
      segments: [
        { start: 1, end: 6 },
        { start: 6, end: 15 },
      ],
    });

    expect(cdsToProteinSpliced(annotation, seq)).toBe('MKTRV');
  });

  it('translates a reverse-strand spliced CDS in coding order', () => {
    const forward = 'ATGAAAGCCCGGGTTT';
    const seq = 'AAACCCGGGCTTTCAT';
    void forward;
    const annotation = cds({
      start: 1,
      end: 16,
      direction: -1,
      segments: [
        { start: 1, end: 9 },
        { start: 11, end: 16 },
      ],
    });

    expect(cdsToProteinSpliced(annotation, seq)).toBe('MKPGF');
  });

  it('honors /codon_start by trimming leading bases from the SPLICED sequence', () => {
    const seq = 'ATGAAAGCCCGGGTTT';
    const annotation = cds({
      start: 1,
      end: 16,
      qualifiers: { codon_start: ['2'] },
      segments: [
        { start: 1, end: 6 },
        { start: 8, end: 16 },
      ],
    });

    expect(cdsToProteinSpliced(annotation, seq)).toBe('*NPG');
  });

  it('falls back to contiguous translation when there are no segments', () => {
    const seq = 'ATGGCTTAA';
    const annotation = cds({ start: 1, end: 9 });
    expect(cdsToProteinSpliced(annotation, seq)).toBe('MA');
  });

  it('falls back to contiguous translation for a single segment', () => {
    const seq = 'ATGGCTTAA';
    const annotation = cds({ start: 1, end: 9, segments: [{ start: 1, end: 9 }] });
    expect(cdsToProteinSpliced(annotation, seq)).toBe('MA');
  });

  it('translates a declared non-standard genetic code on that code', () => {
    const seq = 'ATGTGAAAA';
    const annotation = cds({
      start: 1,
      end: 9,
      qualifiers: { transl_table: ['4'] },
    });
    expect(cdsToProteinSpliced(annotation, seq)).toBe('MWK');
    expect(cdsToProteinSpliced(cds({ start: 1, end: 9 }), seq)).toBe('M*K');
  });

  it('inherits the record genetic code when the feature declares none', () => {
    const seq = 'ATGTGAAAA';
    const annotation = cds({ start: 1, end: 9 });
    expect(cdsToProteinSpliced(annotation, seq, { sequenceGeneticCode: 4 })).toBe('MWK');
    expect(cdsToProteinSpliced(annotation, seq)).toBe('M*K');
  });

  it('lets a feature declaration override the record genetic code', () => {
    const seq = 'ATGTGAAAA';
    const declaredStandard = cds({ start: 1, end: 9, qualifiers: { transl_table: ['1'] } });
    expect(cdsToProteinSpliced(declaredStandard, seq, { sequenceGeneticCode: 4 })).toBe('M*K');
  });

  it('accepts genetic code 11 (bacterial), which shares the standard codon assignments', () => {
    const seq = 'ATGGCTTAA';
    const annotation = cds({
      start: 1,
      end: 9,
      qualifiers: { transl_table: ['11'] },
    });
    expect(cdsToProteinSpliced(annotation, seq)).toBe('MA');
  });

  it('drops a single trailing stop, matching GenBank /translation convention', () => {
    const seq = 'ATGAAAGCCCGGGTAA';
    const annotation = cds({
      start: 1,
      end: 16,
      segments: [
        { start: 1, end: 6 },
        { start: 8, end: 16 },
      ],
    });
    expect(cdsToProteinSpliced(annotation, seq)).toBe('MKPG');
  });
});
