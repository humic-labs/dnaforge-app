// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  linkedResidueIndexForStructureResidue,
  structureResiduesForLinkedResidueIndex,
} from './residue-target-mapping';
import type { StructureLinkEntry } from '../state/use-structure-link-registry';

const BASE_LINK: Pick<StructureLinkEntry, 'residueTarget' | 'residueTargets'> = {};

describe('residue target mapping', () => {
  it('keeps the legacy no-target AlphaFold-style chain A identity default explicit', () => {
    expect(structureResiduesForLinkedResidueIndex(BASE_LINK, 4)).toEqual([
      { chain: 'A', position: 5 },
    ]);
    expect(linkedResidueIndexForStructureResidue(BASE_LINK, { chain: 'A', position: 5 })).toBe(4);
  });

  it('does not infer identity numbering for a provided bare chain target', () => {
    const link = { residueTarget: { chain: 'A' } };

    expect(structureResiduesForLinkedResidueIndex(link, 4)).toEqual([]);
    expect(linkedResidueIndexForStructureResidue(link, { chain: 'A', position: 5 })).toBeNull();
  });

  it('maps sequence residue indices through explicit per-chain structure residue maps', () => {
    const link = {
      residueTargets: [
        {
          chain: 'H',
          labelAsymId: 'H',
          authAsymId: 'F',
          entityId: '6',
          residues: [
            { residueIndex: 2, position: 2 },
            { residueIndex: 3, position: 3 },
          ],
        },
        {
          chain: 'J',
          labelAsymId: 'J',
          authAsymId: 'D',
          entityId: '6',
          residues: [
            { residueIndex: 0, position: 0 },
            { residueIndex: 2, position: 2 },
          ],
        },
      ],
    };

    expect(structureResiduesForLinkedResidueIndex(link, 2)).toEqual([
      {
        chain: 'H',
        labelAsymId: 'H',
        authAsymId: 'F',
        entityId: '6',
        position: 2,
      },
      {
        chain: 'J',
        labelAsymId: 'J',
        authAsymId: 'D',
        entityId: '6',
        position: 2,
      },
    ]);
    expect(
      linkedResidueIndexForStructureResidue(link, {
        chain: 'H',
        labelAsymId: 'H',
        authAsymId: 'F',
        entityId: '6',
        position: 2,
      })
    ).toBe(2);
  });

  it('uses label_seq_id to distinguish residues that share an author residue number', () => {
    const link: Pick<StructureLinkEntry, 'residueTarget' | 'residueTargets'> = {
      residueTarget: {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        residues: [
          { residueIndex: 4, position: 10, labelSeqId: 5 },
          { residueIndex: 9, position: 10, labelSeqId: 10 },
        ],
      },
    };

    expect(structureResiduesForLinkedResidueIndex(link, 9)).toEqual([
      {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        position: 10,
        labelSeqId: 10,
      },
    ]);
    expect(
      linkedResidueIndexForStructureResidue(link, {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        position: 10,
        labelSeqId: 10,
      })
    ).toBe(9);
    expect(
      linkedResidueIndexForStructureResidue(link, {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        position: 10,
      })
    ).toBeNull();
  });

  it('fails closed when the numeric residue position exists on a different scoped target', () => {
    const link = {
      residueTargets: [
        {
          chain: 'H',
          labelAsymId: 'H',
          authAsymId: 'F',
          entityId: '6',
          residues: [{ residueIndex: 2, position: 2 }],
        },
      ],
    };

    expect(
      linkedResidueIndexForStructureResidue(link, {
        chain: 'H',
        labelAsymId: 'H',
        authAsymId: 'D',
        entityId: '6',
        position: 2,
      })
    ).toBeNull();
  });

  it('canonicalizes an unscoped structure click only when chain and position identify one mapped target', () => {
    const uniqueLink = {
      residueTargets: [
        {
          chain: 'H',
          labelAsymId: 'H',
          authAsymId: 'F',
          entityId: '6',
          residues: [{ residueIndex: 2, position: 2 }],
        },
      ],
    };
    const ambiguousLink = {
      residueTargets: [
        {
          chain: 'H',
          labelAsymId: 'H',
          authAsymId: 'F',
          entityId: '6',
          residues: [{ residueIndex: 2, position: 2 }],
        },
        {
          chain: 'H',
          labelAsymId: 'H',
          authAsymId: 'D',
          entityId: '7',
          residues: [{ residueIndex: 12, position: 2 }],
        },
      ],
    };

    expect(linkedResidueIndexForStructureResidue(uniqueLink, { chain: 'H', position: 2 })).toBe(2);
    expect(
      linkedResidueIndexForStructureResidue(ambiguousLink, { chain: 'H', position: 2 })
    ).toBeNull();
  });

  it('requires explicit identity mapping for scoped structure targets', () => {
    const link = {
      residueTarget: {
        chain: 'H',
        labelAsymId: 'B',
        authAsymId: 'H',
        entityId: '1',
        residueMappingKind: 'identity' as const,
      },
    };

    expect(structureResiduesForLinkedResidueIndex(link, 4)).toEqual([
      {
        chain: 'H',
        labelAsymId: 'B',
        authAsymId: 'H',
        entityId: '1',
        position: 5,
      },
    ]);
    expect(
      linkedResidueIndexForStructureResidue(link, {
        chain: 'H',
        labelAsymId: 'B',
        authAsymId: 'H',
        entityId: '1',
        position: 5,
      })
    ).toBe(4);
  });
});
