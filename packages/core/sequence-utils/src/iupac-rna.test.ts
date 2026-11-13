import { describe, expect, it } from 'vitest';
import {
  IUPAC_COMPLEMENT,
  IUPAC_RNA_COMPLEMENT,
  complementBase,
  complementTable,
  reverseComplement,
  toNucleicAcid,
} from './iupac';
import { nucleicAcidOf, nucleicAcidOfBases } from './molecule-type';

const RNA_ALPHABET = 'ACGURYSWKMBDHVNacgurynwkmbdhvn-.';

describe('RNA complement (single source of truth)', () => {
  it('pairs A with U and never produces T', () => {
    expect(reverseComplement('AUGGCC', 'rna')).toBe('GGCCAU');
    expect(reverseComplement('augc', 'rna')).toBe('gcau');
    expect(complementBase('A', 'rna')).toBe('U');
    expect(complementBase('a', 'rna')).toBe('u');
    expect(Object.values(IUPAC_RNA_COMPLEMENT).join('')).not.toMatch(/[Tt]/);
  });

  it('is an involution over the RNA alphabet', () => {
    for (const base of RNA_ALPHABET) {
      expect(complementBase(complementBase(base, 'rna'), 'rna')).toBe(base);
    }
    expect(reverseComplement(reverseComplement(RNA_ALPHABET, 'rna'), 'rna')).toBe(RNA_ALPHABET);
  });

  it('is derived from the DNA table rather than hand-typed', () => {
    for (const [base, complement] of Object.entries(IUPAC_COMPLEMENT)) {
      expect(IUPAC_RNA_COMPLEMENT[base]).toBe(
        complement === 'T' ? 'U' : complement === 't' ? 'u' : complement
      );
    }
    expect(complementTable()).toBe(IUPAC_COMPLEMENT);
    expect(complementTable('rna')).toBe(IUPAC_RNA_COMPLEMENT);
  });

  it('keeps DNA behaviour unchanged by default', () => {
    expect(reverseComplement('ATGGCC')).toBe('GGCCAT');
    expect(complementBase('A')).toBe('T');
  });

  it('converts typed or pasted bases into the document nucleic acid', () => {
    expect(toNucleicAcid('ATGtac', 'rna')).toBe('AUGuac');
    expect(toNucleicAcid('ATGtac', 'dna')).toBe('ATGtac');
    expect(toNucleicAcid('AUGuac', 'dna')).toBe('ATGtac');
  });

  it('reads the nucleic acid from the sequence molecule label', () => {
    expect(nucleicAcidOf({})).toBe('dna');
    expect(nucleicAcidOf({ molecule: 'ds-DNA' })).toBe('dna');
    expect(nucleicAcidOf({ molecule: 'RNA' })).toBe('rna');
    expect(nucleicAcidOf({ molecule: 'mRNA' })).toBe('rna');
  });

  it('reads the nucleic acid of unlabelled bases', () => {
    expect(nucleicAcidOfBases('AUGC')).toBe('rna');
    expect(nucleicAcidOfBases('ATGC')).toBe('dna');
    expect(nucleicAcidOfBases('AGC')).toBe('dna');
    expect(nucleicAcidOfBases('ATGU')).toBe('dna');
  });
});
