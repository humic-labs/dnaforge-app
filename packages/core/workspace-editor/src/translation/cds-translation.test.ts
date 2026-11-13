import { describe, it, expect } from 'vitest';
import { aminoAcidCreationBlockedReason, getCDSTranslation } from './cds-translation';
import type { Annotation } from '@waypoint/sequence-utils';

describe('getCDSTranslation', () => {
  it('translates a simple contiguous CDS', () => {
    const seq = 'ATGGCTGAA';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
    };

    const result = getCDSTranslation(cds, seq);
    expect(result).toBe('MAE');
  });

  it('translates a spliced CDS skipping introns', () => {
    const seq = 'ATGGCT' + 'nnn' + 'GAAAAA';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 15,
      direction: 1,
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: ['join(1..6,10..15)'] },
    };

    const result = getCDSTranslation(cds, seq);
    expect(result).toBe('MAEK');
  });

  it('translates a reverse strand CDS', () => {
    const seq = 'TTCAGCCAT';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: -1,
    };

    const result = getCDSTranslation(cds, seq);
    expect(result).toBe('MAE');
  });

  it('strips trailing stop codon from output', () => {
    const seq = 'ATGGCTTAA';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
    };

    const result = getCDSTranslation(cds, seq);
    expect(result).toBe('MA');
  });

  it('respects codon_start on non-spliced CDS', () => {
    const seq = 'NATGGCT';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 7,
      direction: 1,
      qualifiers: { codon_start: ['2'] },
    };

    const result = getCDSTranslation(cds, seq);
    expect(result).toBe('MA');
  });

  it('handles empty sequence gracefully', () => {
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
    };
    const result = getCDSTranslation(cds, '');
    expect(result).toBe('');
  });
});

describe('aminoAcidCreationBlockedReason  slice 1.2)', () => {
  it('allows a clean CDS with a valid trailing-stop-only translation', () => {
    const cds: Annotation = { name: 'test', type: 'CDS', start: 1, end: 9, direction: 1 };
    expect(aminoAcidCreationBlockedReason(cds, 'ATGGCTTAA')).toBeNull();
  });

  it('blocks a CDS whose coding length is not a multiple of 3', () => {
    const cds: Annotation = { name: 'test', type: 'CDS', start: 1, end: 8, direction: 1 };
    expect(aminoAcidCreationBlockedReason(cds, 'ATGGCTGA')).toBe('invalid_length');
  });

  it('blocks a CDS with an internal stop codon', () => {
    const cds: Annotation = { name: 'test', type: 'CDS', start: 1, end: 9, direction: 1 };
    expect(aminoAcidCreationBlockedReason(cds, 'ATGTAAGCT')).toBe('internal_stop');
  });

  it("blocks a CDS whose recomputed translation mismatches the record's own /translation qualifier (e.g. a GTG-start gene under the standard table)", () => {
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      qualifiers: { translation: ['VAE'] },
    };
    expect(aminoAcidCreationBlockedReason(cds, 'ATGGCTGAA')).toBe('translation_mismatch');
  });

  it('allows a CDS whose recomputed translation matches its own /translation qualifier', () => {
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      qualifiers: { translation: ['MAE'] },
    };
    expect(aminoAcidCreationBlockedReason(cds, 'ATGGCTGAA')).toBeNull();
  });

  it('allows a spliced CDS whose introns keep the coding sequence in frame', () => {
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 15,
      direction: 1,
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: ['join(1..6,10..15)'] },
    };
    expect(aminoAcidCreationBlockedReason(cds, 'ATGGCT' + 'nnn' + 'GAAAAA')).toBeNull();
  });
});
