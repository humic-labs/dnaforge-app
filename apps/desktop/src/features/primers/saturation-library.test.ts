import { describe, expect, it } from 'vitest';
import {
  expandDegenerateSequence,
  reverseComplement,
  translateCodon,
} from '@waypoint/sequence-utils';
import {
  designSaturationLibrary,
  saturationLibraryTsv,
  type SaturationLibraryInput,
} from './saturation-library';

const flank = 'ACGTTGCAACGTTGCAACGT';
const cds = 'ATGGCTTGGCCG';
const input: SaturationLibraryInput = {
  reference: flank + cds + flank,
  cdsStart: flank.length,
  cdsEnd: flank.length + cds.length,
  strand: 'forward',
  firstResidue: 1,
  lastResidue: 4,
  codon: 'NNK',
  flankLength: 15,
};

describe('saturation library', () => {
  it('replaces exactly one distinct codon per residue and preserves both matching flanks', () => {
    const pairs = designSaturationLibrary(input);
    expect(pairs.map((pair) => pair.nativeCodon)).toEqual(['ATG', 'GCT', 'TGG', 'CCG']);
    expect(pairs.map((pair) => pair.nativeAminoAcid)).toEqual(['M', 'A', 'W', 'P']);
    for (const pair of pairs) {
      const codonStart = input.cdsStart + (pair.residue - 1) * 3;
      expect(pair.templateStart).toBe(codonStart - 15);
      expect(pair.templateEnd).toBe(codonStart + 18);
      expect(pair.forward).toBe(
        input.reference.slice(codonStart - 15, codonStart) +
          'NNK' +
          input.reference.slice(codonStart + 3, codonStart + 18)
      );
      expect(pair.forward).toHaveLength(33);
      expect(pair.reverse).toBe(reverseComplement(pair.forward));
      expect(pair.reverse.slice(15, 18)).toBe('MNN');
    }
  });

  it('maps reverse-strand CDS residues from the high coordinate and emits coding-oriented oligos', () => {
    const forward = designSaturationLibrary(input);
    const reference = reverseComplement(input.reference);
    const reverse = designSaturationLibrary({ ...input, reference, strand: 'reverse' });
    expect(reverse.map((pair) => pair.forward)).toEqual(forward.map((pair) => pair.forward));
    expect(reverse.map((pair) => pair.nativeCodon)).toEqual(
      forward.map((pair) => pair.nativeCodon)
    );
    for (let index = 0; index < forward.length; index += 1) {
      expect(reverse[index].templateStart).toBe(reference.length - forward[index].templateEnd);
      expect(reverse[index].templateEnd).toBe(reference.length - forward[index].templateStart);
    }
  });

  it.each(['NNK', 'NNS'] as const)(
    '%s contains 32 codons, all 20 amino acids and one stop',
    (codon) => {
      const concrete = expandDegenerateSequence(codon);
      if (!concrete) throw new Error('A degenerate codon must expand within the limit.');
      expect(concrete).toHaveLength(32);
      const aminoAcids = concrete.map((value) => translateCodon(value));
      expect(new Set(aminoAcids).size).toBe(21);
      expect(aminoAcids.filter((value) => value === '*')).toHaveLength(1);
      const pairs = designSaturationLibrary({ ...input, codon });
      expect(pairs.every((pair) => pair.forward.slice(15, 18) === codon)).toBe(true);
    }
  );

  it('exports both 5-prime-to-3-prime oligos with inclusive 1-based template bounds', () => {
    const pairs = designSaturationLibrary({ ...input, firstResidue: 2, lastResidue: 2 });
    const rows = saturationLibraryTsv(pairs, 'NNK').split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toBe(`A2_NNK_F\t2\tGCT\tA\t9\t41\tforward\t${pairs[0].forward}`);
    expect(rows[2]).toBe(`A2_NNK_R\t2\tGCT\tA\t9\t41\tforward\t${pairs[0].reverse}`);
  });

  it.each([
    { cdsStart: -1 },
    { cdsEnd: input.cdsEnd + 1 },
    { cdsEnd: input.reference.length + 1 },
    { firstResidue: 0 },
    { firstResidue: 4, lastResidue: 3 },
    { lastResidue: 5 },
    { firstResidue: 1.5 },
    { flankLength: 14 },
    { flankLength: 51 },
    { reference: input.reference + 'N' },
  ])('rejects invalid input %j', (change) => {
    expect(() => designSaturationLibrary({ ...input, ...change })).toThrow();
  });

  it('rejects missing terminal flanks rather than silently truncating a primer', () => {
    expect(() =>
      designSaturationLibrary({ ...input, reference: cds, cdsStart: 0, cdsEnd: cds.length })
    ).toThrow(/Residue 1 needs/);
    expect(() => designSaturationLibrary({ ...input, flankLength: 25 })).toThrow(/Residue 1 needs/);
  });

  it('does not treat a terminal stop codon as an amino-acid residue to saturate', () => {
    expect(() =>
      designSaturationLibrary({ ...input, reference: flank + 'ATGGCTTGGTAA' + flank })
    ).toThrow(/Position 4 is a stop codon/);
    expect(
      designSaturationLibrary({
        ...input,
        reference: flank + 'ATGGCTTGGTAA' + flank,
        lastResidue: 3,
      })
    ).toHaveLength(3);
  });
});
