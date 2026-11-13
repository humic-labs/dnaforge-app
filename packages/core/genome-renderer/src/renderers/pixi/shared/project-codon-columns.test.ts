import { describe, expect, it } from 'vitest';
import { translateCDS } from '../../../biology/translation';
import { projectCodonColumns } from './project-codon-columns';

describe('native translated codons in supplied display columns', () => {
  it('splits a native codon around a display gap without translating or painting the gap', () => {
    const sequence = 'ATGAAA';
    const codons = translateCDS(sequence, 0, 6, 'forward', sequence.length, false);
    const columns = [0, 1, 3, 4, 5, 6];
    const projected = projectCodonColumns(codons, sequence.length, (base) => columns[base] ?? null);
    expect(
      projected.map(({ startBp, endBp, codon, aa, renderLetter }) => ({
        startBp,
        endBp,
        codon,
        aa,
        renderLetter,
      }))
    ).toEqual([
      { startBp: 0, endBp: 2, codon: 'ATG', aa: 'M', renderLetter: true },
      { startBp: 3, endBp: 4, codon: 'ATG', aa: 'M', renderLetter: false },
      { startBp: 4, endBp: 7, codon: 'AAA', aa: 'K', renderLetter: true },
    ]);
    expect(projected[0].codonStartBp).toBe(0);
    expect(projected[0].codonEndBp).toBe(3);
  });

  it('preserves reverse-strand amino acids and existing splice fragments', () => {
    const sequence = 'TTTCAT';
    const codons = translateCDS(sequence, 0, 6, 'reverse', sequence.length, false);
    const columns = [0, 1, 2, 4, 5, 6];
    const projected = projectCodonColumns(codons, sequence.length, (base) => columns[base] ?? null);
    expect(projected.map((codon) => codon.aa)).toEqual(['M', 'K']);
    expect(projected.map((codon) => [codon.startBp, codon.endBp])).toEqual([
      [4, 7],
      [0, 3],
    ]);
    const split = [
      {
        ...codons[0],
        startBp: 3,
        endBp: 4,
        renderLetter: false,
        isPartialPreIntron: true,
        codonStartBp: 3,
        codonEndBp: 5,
      },
    ];
    expect(
      projectCodonColumns(split, sequence.length, (base) => columns[base] ?? null)[0]
    ).toMatchObject({
      isPartialPreIntron: true,
      renderLetter: false,
      codonStartBp: 4,
      codonEndBp: 6,
    });
  });
});
