import { describe, expect, it } from 'vitest';
import { buildCustomGeneticCode } from '@waypoint/sequence-utils';
import { computeCodonCells } from './codon-rendering';

const SEQUENCE = 'ATGAAATGAAAATAGAAA';

function letters(geneticCode?: Parameters<typeof computeCodonCells>[8]) {
  return computeCodonCells(
    { start: 0, end: SEQUENCE.length - 1, direction: 1 },
    0,
    SEQUENCE.length,
    0,
    10,
    SEQUENCE,
    SEQUENCE.length,
    { type: 'normal' },
    geneticCode
  ).map((cell) => cell.display?.full ?? cell.aa);
}

describe('the codon track and the record genetic code', () => {
  it('reads the standard code when the record says nothing', () => {
    expect(letters()).toEqual(['M', 'K', '*', 'K', '*', 'K']);
  });

  it("reads TGA as tryptophan under the record's mold mitochondrial code", () => {
    expect(letters(4)).toEqual(['M', 'K', 'W', 'K', '*', 'K']);
  });

  it('names a non-standard residue the record code puts on a codon', () => {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision: 1,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');
    expect(letters(built.definition)).toEqual(['M', 'K', '*', 'K', 'pAzF', 'K']);
  });

  it("still lets a feature's own declaration win over the record's code", () => {
    const cells = computeCodonCells(
      {
        start: 0,
        end: SEQUENCE.length - 1,
        direction: 1,
        qualifiers: { transl_table: ['1'] },
      },
      0,
      SEQUENCE.length,
      0,
      10,
      SEQUENCE,
      SEQUENCE.length,
      { type: 'normal' },
      4
    );
    expect(cells.map((cell) => cell.aa)).toEqual(['M', 'K', '*', 'K', '*', 'K']);
  });
});
