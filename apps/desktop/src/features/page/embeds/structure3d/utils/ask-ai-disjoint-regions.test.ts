import { describe, it, expect } from 'vitest';
import {
  deriveAskAiRegionsFromStructureResidues,
  residueLabelClause,
  type AskAiRegionsDerivation,
} from './ask-ai-disjoint-regions';
import type { ResidueSelectionLink } from './residueSelectionBridge';
import type { ResidueLocation } from '../types';

const LINK: ResidueSelectionLink = {
  sequenceDocumentId: '/fixtures/mg1655.gb',
  cdsStart: 190,
  cdsEnd: 300,
  strand: 1,
  cdsLabel: 'thrA',
  residueTarget: {
    chain: 'A',
    residues: [
      { residueIndex: 0, position: 10 },
      { residueIndex: 1, position: 11 },
      { residueIndex: 2, position: 12 },
      { residueIndex: 5, position: 15 },
      { residueIndex: 12, position: 22 },
    ],
  } as never,
  residueTargets: [
    {
      chain: 'A',
      residues: [
        { residueIndex: 0, position: 10 },
        { residueIndex: 1, position: 11 },
        { residueIndex: 2, position: 12 },
        { residueIndex: 5, position: 15 },
        { residueIndex: 12, position: 22 },
      ],
    },
  ] as never,
};

const r = (position: number, extra: Partial<ResidueLocation> = {}): ResidueLocation => ({
  chain: 'A',
  position,
  ...extra,
});

function mappedSpans(d: AskAiRegionsDerivation): Array<[number, number]> {
  return d.regions
    .filter((region) => region.codingDnaMapped)
    .map((region) => [region.start as number, region.end as number]);
}

describe('deriveAskAiRegionsFromStructureResidues', () => {
  it('a DISCONTIGUOUS triad yields N disjoint per-residue regions — NOT one min..max span', () => {
    const derivation = deriveAskAiRegionsFromStructureResidues(LINK, [r(10), r(15), r(22)]);

    expect(mappedSpans(derivation)).toEqual([
      [191, 193],
      [206, 208],
      [227, 229],
    ]);
    expect(derivation.disjoint).toBe(true);
    expect(derivation.mappedRegionCount).toBe(3);

    expect(mappedSpans(derivation)).not.toContainEqual([191, 229]);
    expect(derivation.regions.some((region) => region.start === 191 && region.end === 229)).toBe(
      false
    );

    expect(derivation.regions[0].residues).toEqual([
      { chain: 'A', residueNumber: 10, proteinResidue: 1 },
    ]);
    expect(derivation.regions[1].residues).toEqual([
      { chain: 'A', residueNumber: 15, proteinResidue: 6 },
    ]);
    expect(derivation.regions[2].residues).toEqual([
      { chain: 'A', residueNumber: 22, proteinResidue: 13 },
    ]);

    expect(derivation.primaryRange).toEqual({ start: 191, end: 193 });
    expect(derivation.proteinResidueNumbers).toEqual([1, 6, 13]);
  });

  it('a CONTIGUOUS run of residues MERGES back to a single region (single-region path)', () => {
    const derivation = deriveAskAiRegionsFromStructureResidues(LINK, [r(10), r(11), r(12)]);

    expect(mappedSpans(derivation)).toEqual([[191, 199]]);
    expect(derivation.mappedRegionCount).toBe(1);
    expect(derivation.disjoint).toBe(false);
    expect(derivation.regions[0].residues).toEqual([
      { chain: 'A', residueNumber: 10, proteinResidue: 1 },
      { chain: 'A', residueNumber: 11, proteinResidue: 2 },
      { chain: 'A', residueNumber: 12, proteinResidue: 3 },
    ]);
    expect(derivation.primaryRange).toEqual({ start: 191, end: 199 });
  });

  it('an UNLINKED structure marks every residue codingDnaMapped:false + reason, NO fabricated coords', () => {
    const derivation = deriveAskAiRegionsFromStructureResidues(null, [r(10), r(15)]);

    expect(derivation.mappedRegionCount).toBe(0);
    expect(derivation.primaryRange).toBeNull();
    expect(derivation.regions).toHaveLength(1);
    const bucket = derivation.regions[0];
    expect(bucket.codingDnaMapped).toBe(false);
    expect(bucket.reason).toBe('unlinked-structure-no-coding-dna');
    expect(bucket.start).toBeUndefined();
    expect(bucket.end).toBeUndefined();
    expect(bucket.residues).toEqual([
      { chain: 'A', residueNumber: 10 },
      { chain: 'A', residueNumber: 15 },
    ]);
  });

  it('a LIGAND/heteroatom mixed in is surfaced as codingDnaMapped:false, never guessed', () => {
    const derivation = deriveAskAiRegionsFromStructureResidues(LINK, [
      r(10),
      r(999, { compId: 'MG' }),
    ]);

    expect(mappedSpans(derivation)).toEqual([[191, 193]]);
    expect(derivation.mappedRegionCount).toBe(1);
    expect(derivation.disjoint).toBe(true);
    const bucket = derivation.regions.find((region) => !region.codingDnaMapped)!;
    expect(bucket.reason).toBe('residue-not-in-coding-dna');
    expect(bucket.start).toBeUndefined();
    expect(bucket.residues).toEqual([{ chain: 'A', residueNumber: 999 }]);
    expect(derivation.primaryRange).toEqual({ start: 191, end: 193 });
  });

  it('a single residue is a single region (byte-identical single-region path)', () => {
    const derivation = deriveAskAiRegionsFromStructureResidues(LINK, [r(15)]);
    expect(mappedSpans(derivation)).toEqual([[206, 208]]);
    expect(derivation.disjoint).toBe(false);
    expect(derivation.proteinResidueNumbers).toEqual([6]);
  });
});

describe('residueLabelClause', () => {
  it('names a single residue', () => {
    expect(residueLabelClause([57])).toBe('residue 57');
  });
  it('names a contiguous run as a range', () => {
    expect(residueLabelClause([55, 56, 57, 58])).toBe('residues 55–58');
  });
  it('names a disjoint triad as a comma list (never a range)', () => {
    expect(residueLabelClause([57, 102, 195])).toBe('residues 57, 102, 195');
  });
  it('caps a long disjoint list with +N more', () => {
    expect(residueLabelClause([1, 10, 20, 30, 40, 50])).toBe('residues 1, 10, 20, 30 +2 more');
  });
  it('is empty for no residues', () => {
    expect(residueLabelClause([])).toBe('');
  });
});
