import { describe, expect, it } from 'vitest';
import { translateCDS, translateDnaCodon } from './translation';

const SEQ = 'ATGTGAAAA';

describe('translateCDS honors /transl_table', () => {
  it('reads TGA as a stop under the standard code', () => {
    const codons = translateCDS(SEQ, 0, 9, 'forward', 9, false);
    expect(codons.map((c) => c.aa).join('')).toBe('M*K');
    expect(codons[1].isStop).toBe(true);
  });

  it('reads TGA as tryptophan when the feature declares table 4', () => {
    const codons = translateCDS(SEQ, 0, 9, 'forward', 9, false, {
      qualifiers: { transl_table: '4' },
    });
    expect(codons.map((c) => c.aa).join('')).toBe('MWK');
    expect(codons.some((c) => c.isStop)).toBe(false);
  });

  it('inherits the record code when the feature declares nothing', () => {
    const codons = translateCDS(SEQ, 0, 9, 'forward', 9, false, {
      sequenceGeneticCode: 4,
    });
    expect(codons.map((c) => c.aa).join('')).toBe('MWK');
  });

  it('lets a feature declaration override the record code', () => {
    const codons = translateCDS(SEQ, 0, 9, 'forward', 9, false, {
      qualifiers: { transl_table: '1' },
      sequenceGeneticCode: 4,
    });
    expect(codons.map((c) => c.aa).join('')).toBe('M*K');
  });

  it('falls back to the standard code for an unpublished table id', () => {
    const codons = translateCDS(SEQ, 0, 9, 'forward', 9, false, {
      qualifiers: { transl_table: '7' },
    });
    expect(codons.map((c) => c.aa).join('')).toBe('M*K');
  });

  it('stamps the code it used on every emitted codon', () => {
    const codons = translateCDS(SEQ, 0, 9, 'forward', 9, false, {
      qualifiers: { transl_table: '4' },
    });
    for (const codon of codons) {
      expect(codon.geneticCode).toBe(4);
      expect(translateDnaCodon(codon.codon, codon.geneticCode)).toBe(codon.aa);
    }
  });

  it('carries the code through a spliced CDS too', () => {
    const spliced = translateCDS('ATGCCCCCTGAAAA', 0, 14, 'forward', 14, false, {
      segments: [
        { start: 0, end: 3 },
        { start: 8, end: 14 },
      ],
      qualifiers: { transl_table: '4' },
    });
    expect(spliced.length).toBeGreaterThan(0);
    for (const codon of spliced) {
      expect(codon.geneticCode).toBe(4);
    }
  });
});
