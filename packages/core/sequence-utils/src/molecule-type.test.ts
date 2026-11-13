import { describe, expect, it } from 'vitest';
import { classifyMoleculeType } from './molecule-type';

const PUC19_LACZ_ALPHA =
  'ATGACCATGATTACGCCAAGCTTGCATGCCTGCAGGTCGACTCTAGAGGATCCCCGGGTACCGAGCTCGAATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTGGCG';
const HUMAN_INSULIN_PRECURSOR =
  'MALWMRLLPLLALLALWGPDPAAAFVNQHLCGSHLVEALYLVCGERGFFYTPKTRREAEDLQVGQVELGGGPGAGSLQPLALEGSLQKRGIVEQCCTSICSLYQLENYCN';

describe('classifyMoleculeType', () => {
  it('classifies real DNA, RNA and protein', () => {
    expect(classifyMoleculeType(PUC19_LACZ_ALPHA)).toEqual({ kind: 'dna' });
    expect(classifyMoleculeType(PUC19_LACZ_ALPHA.replace(/T/g, 'U'))).toEqual({ kind: 'rna' });
    expect(classifyMoleculeType(HUMAN_INSULIN_PRECURSOR)).toEqual({ kind: 'protein' });
  });

  it('ignores case, whitespace and line breaks', () => {
    expect(
      classifyMoleculeType(
        `${PUC19_LACZ_ALPHA.slice(0, 60).toLowerCase()}\n${PUC19_LACZ_ALPHA.slice(60)}`
      )
    ).toEqual({
      kind: 'dna',
    });
  });

  it('keeps sparse ambiguity codes in DNA', () => {
    expect(classifyMoleculeType(`${PUC19_LACZ_ALPHA}NNRY`)).toEqual({ kind: 'dna' });
  });

  it('never calls ambiguity-code proteins nucleotide', () => {
    expect(classifyMoleculeType('MKWVSHRDMKWVSHRDMKWVSHRD')).toEqual({
      kind: 'ambiguous',
      reason: 'ambiguity_codes',
    });
  });

  it('asks instead of guessing for short or low-variety records', () => {
    expect(classifyMoleculeType('ACGTACGTAC')).toEqual({ kind: 'ambiguous', reason: 'too_short' });
    expect(classifyMoleculeType('GAGAGAGAGAGAGAGAGAGAGAGAGAGAGA')).toEqual({
      kind: 'ambiguous',
      reason: 'low_complexity',
    });
  });

  it('refuses mixed T and U, empty input, and DNA with stray protein residues', () => {
    expect(classifyMoleculeType(`${PUC19_LACZ_ALPHA}UUUU`)).toEqual({
      kind: 'ambiguous',
      reason: 'mixed_t_u',
    });
    expect(classifyMoleculeType('  \n')).toEqual({ kind: 'ambiguous', reason: 'empty' });
    expect(classifyMoleculeType(`${PUC19_LACZ_ALPHA}E`)).toEqual({
      kind: 'ambiguous',
      reason: 'foreign_residues',
    });
  });
});
