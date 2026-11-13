// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { hoveredResidueForSequenceCodon } from './sequence-structure-hover';
import type { StructureLinkEntry } from '../state/use-structure-link-registry';

const BASE_LINK: StructureLinkEntry = {
  structureId: 'structure:rcsb:1ABC:auth-H',
  sequenceDocumentId: '/fixtures/mg1655.gb',
  cdsLabel: 'pdb-linked CDS',
  translation: 'MTEST',
  cdsStart: 99,
  cdsEnd: 398,
  strand: 1,
};

describe('hoveredResidueForSequenceCodon', () => {
  it('maps sequence codon hover to the scoped PDB residue target instead of hard-coding chain A', () => {
    const result = hoveredResidueForSequenceCodon(
      { start: 129, end: 131, strand: 1 },
      '/fixtures/mg1655.gb',
      {
        [BASE_LINK.structureId]: {
          ...BASE_LINK,
          residueTarget: {
            chain: 'H',
            baseChain: 'B',
            labelAsymId: 'B',
            authAsymId: 'H',
            entityId: '1',
            residueMappingKind: 'identity',
          },
        },
      }
    );

    expect(result).toEqual({
      structureId: 'structure:rcsb:1ABC:auth-H',
      chain: 'H',
      position: 11,
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'H',
      entityId: '1',
    });
  });

  it('does not synthesize identity numbering for scoped targets that did not declare identity mapping', () => {
    const result = hoveredResidueForSequenceCodon(
      { start: 129, end: 131, strand: 1 },
      '/fixtures/mg1655.gb',
      {
        [BASE_LINK.structureId]: {
          ...BASE_LINK,
          residueTarget: {
            chain: 'H',
            labelAsymId: 'B',
            authAsymId: 'H',
            entityId: '1',
          },
        },
      }
    );

    expect(result).toBeNull();
  });

  it('maps sequence codon hover through explicit protein-order to structure-position residue maps', () => {
    const result = hoveredResidueForSequenceCodon(
      { start: 129, end: 131, strand: 1 },
      '/fixtures/mg1655.gb',
      {
        [BASE_LINK.structureId]: {
          ...BASE_LINK,
          residueTarget: {
            chain: 'H',
            baseChain: 'B',
            labelAsymId: 'B',
            authAsymId: 'H',
            entityId: '1',
            residues: [{ residueIndex: 10, position: 19 }],
          },
        },
      }
    );

    expect(result).toEqual({
      structureId: 'structure:rcsb:1ABC:auth-H',
      chain: 'H',
      position: 19,
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'H',
      entityId: '1',
    });
  });

  it('does not fall back to chain-local numbering when an explicit residue map lacks the hovered residue', () => {
    const result = hoveredResidueForSequenceCodon(
      { start: 129, end: 131, strand: 1 },
      '/fixtures/mg1655.gb',
      {
        [BASE_LINK.structureId]: {
          ...BASE_LINK,
          residueTarget: {
            chain: 'H',
            authAsymId: 'H',
            residues: [],
          },
        },
      }
    );

    expect(result).toBeNull();
  });

  it('uses the first multimer target that explicitly maps the hovered residue', () => {
    const result = hoveredResidueForSequenceCodon(
      { start: 129, end: 131, strand: 1 },
      '/fixtures/mg1655.gb',
      {
        [BASE_LINK.structureId]: {
          ...BASE_LINK,
          residueTarget: {
            chain: 'F',
            authAsymId: 'F',
            residues: [],
          },
          residueTargets: [
            {
              chain: 'F',
              authAsymId: 'F',
              residues: [],
            },
            {
              chain: 'D',
              labelAsymId: 'J',
              authAsymId: 'D',
              entityId: '6',
              residues: [{ residueIndex: 10, position: 12 }],
            },
          ],
        },
      }
    );

    expect(result).toMatchObject({
      structureId: 'structure:rcsb:1ABC:auth-H',
      chain: 'D',
      labelAsymId: 'J',
      authAsymId: 'D',
      entityId: '6',
      position: 12,
    });
  });

  it('keeps the AlphaFold chain-A fallback for unscoped structure links', () => {
    const result = hoveredResidueForSequenceCodon(
      { start: 99, end: 101, strand: 1 },
      '/fixtures/mg1655.gb',
      { [BASE_LINK.structureId]: BASE_LINK }
    );

    expect(result).toMatchObject({
      structureId: 'structure:rcsb:1ABC:auth-H',
      chain: 'A',
      position: 1,
    });
  });

  it('returns null when the codon belongs to a different sequence or strand', () => {
    expect(
      hoveredResidueForSequenceCodon({ start: 99, end: 101, strand: -1 }, '/fixtures/mg1655.gb', {
        [BASE_LINK.structureId]: BASE_LINK,
      })
    ).toBeNull();
    expect(
      hoveredResidueForSequenceCodon({ start: 99, end: 101, strand: 1 }, '/other.gb', {
        [BASE_LINK.structureId]: BASE_LINK,
      })
    ).toBeNull();
  });
});
