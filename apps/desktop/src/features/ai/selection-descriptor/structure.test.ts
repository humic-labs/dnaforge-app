import { describe, expect, it } from 'vitest';

import { buildSelectionDescriptor } from './build';
import { hasCompleteStructureResidueIdentities } from './structure';

describe("buildSelectionDescriptor — kind:'structure'", () => {
  it('preserves exact disjoint auth_seq_id residues and optional linked-DNA context', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'structure:1FS0',
      label: '1FS0 catalytic residues',
      residues: [
        { chain: 'G', authAsymId: 'G', position: 195, labelCompId: 'SER' },
        { chain: 'G', authAsymId: 'G', position: 57, labelCompId: 'HIS' },
        { chain: 'G', authAsymId: 'G', position: 102, labelCompId: 'ASP' },
      ],
      visibleRepresentations: [
        {
          layerId: 'polymer-cartoon',
          representation: 'cartoon',
          target: 'all-polymer',
          colorMode: 'chain',
        },
      ],
      linkedCodingDna: {
        documentId: 'sequence-document-trypsin',
        regions: [
          {
            codingDnaMapped: true,
            start: 169,
            end: 171,
            strand: '+',
            residues: [{ chain: 'G', residueNumber: 57, proteinResidue: 57 }],
          },
          {
            codingDnaMapped: true,
            start: 304,
            end: 306,
            strand: '+',
            residues: [{ chain: 'G', residueNumber: 102, proteinResidue: 102 }],
          },
          {
            codingDnaMapped: true,
            start: 583,
            end: 585,
            strand: '+',
            residues: [{ chain: 'G', residueNumber: 195, proteinResidue: 195 }],
          },
        ],
      },
    });

    expect(result.kind).toBe('structure');
    if (result.kind !== 'structure') throw new Error(`Expected structure, got ${result.kind}`);

    expect(result.coordinateSystem).toBe('auth_seq_id-1-indexed-inclusive');
    expect(result.locator.path).toBe('structure:1FS0');
    expect(result.measured).toMatchObject({
      structureRef: 'structure:1FS0',
      residueCount: 3,
      regionCount: 3,
      disjoint: true,
      selections: [
        {
          chain: 'G',
          authAsymId: 'G',
          regions: [
            { start: 57, end: 57 },
            { start: 102, end: 102 },
            { start: 195, end: 195 },
          ],
        },
      ],
      linkedCodingDna: {
        documentId: 'sequence-document-trypsin',
        regions: expect.any(Array),
      },
      residueIdentities: [
        { chain: 'G', authAsymId: 'G', authSeqId: 57, labelCompId: 'HIS', oneLetterCode: 'H' },
        { chain: 'G', authAsymId: 'G', authSeqId: 102, labelCompId: 'ASP', oneLetterCode: 'D' },
        { chain: 'G', authAsymId: 'G', authSeqId: 195, labelCompId: 'SER', oneLetterCode: 'S' },
      ],
      residues: [
        {
          chain: 'G',
          authAsymId: 'G',
          authSeqId: 57,
          labelCompId: 'HIS',
          oneLetterCode: 'H',
          identityStatus: 'known',
        },
        {
          chain: 'G',
          authAsymId: 'G',
          authSeqId: 102,
          labelCompId: 'ASP',
          oneLetterCode: 'D',
          identityStatus: 'known',
        },
        {
          chain: 'G',
          authAsymId: 'G',
          authSeqId: 195,
          labelCompId: 'SER',
          oneLetterCode: 'S',
          identityStatus: 'known',
        },
      ],
      residueOmittedCount: 0,
      residueIdentityKnownCount: 3,
      residueIdentityUnknownCount: 0,
      residueIdentityOmittedCount: 0,
    });
    expect(result.measured.selections[0]?.regions).not.toContainEqual({ start: 57, end: 195 });
    expect(result.measured.visibleRepresentations).toEqual([
      {
        layerId: 'polymer-cartoon',
        representation: 'cartoon',
        target: 'all-polymer',
        colorMode: 'chain',
      },
    ]);
    expect(result.bases).toBe('never');
  });

  it('keeps repeated author residue numbers separate when their assembly scopes differ', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'structure:dimer',
      label: 'Dimer residues',
      residues: [
        {
          chain: 'A',
          baseChain: 'A',
          authAsymId: 'A',
          labelAsymId: 'A',
          entityId: '1',
          operator: 'ASM_1',
          position: 57,
        },
        {
          chain: 'A2',
          baseChain: 'A',
          authAsymId: 'A',
          labelAsymId: 'A',
          entityId: '1',
          operator: 'ASM_2',
          position: 57,
        },
      ],
      visibleRepresentations: [],
    });

    expect(result.kind).toBe('structure');
    if (result.kind !== 'structure') return;
    expect(result.measured.selections).toEqual([
      expect.objectContaining({ chain: 'A', operator: 'ASM_1', regions: [{ start: 57, end: 57 }] }),
      expect.objectContaining({
        chain: 'A2',
        operator: 'ASM_2',
        regions: [{ start: 57, end: 57 }],
      }),
    ]);
  });

  it('preserves ligand identity when a heteroatom shares an author residue number', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'structure:ligand-only',
      label: 'ATP ligand',
      residues: [
        {
          chain: 'A',
          labelAsymId: 'L',
          authAsymId: 'A',
          entityId: '7',
          position: 601,
          compId: 'ATP',
        },
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          entityId: '1',
          position: 601,
        },
      ],
      visibleRepresentations: [],
    });

    expect(result.kind).toBe('structure');
    if (result.kind !== 'structure') return;
    expect(result.measured.selections).toEqual([
      {
        chain: 'A',
        labelAsymId: 'L',
        authAsymId: 'A',
        entityId: '7',
        compId: 'ATP',
        regions: [{ start: 601, end: 601 }],
      },
      {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        regions: [{ start: 601, end: 601 }],
      },
    ]);
  });

  it('bounds enumerated identities and reports exact known, unknown, and omitted counts', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'structure:large-selection',
      label: 'Large polymer selection',
      residues: [
        ...Array.from({ length: 202 }, (_, index) => ({
          chain: 'A',
          position: index + 1,
          labelCompId: 'GLU',
        })),
        { chain: 'A', position: 999 },
      ],
      visibleRepresentations: [],
    });

    expect(result.kind).toBe('structure');
    if (result.kind !== 'structure') return;
    expect(result.measured.residueIdentities).toHaveLength(200);
    expect(result.measured.residues).toHaveLength(200);
    expect(result.measured.residueIdentities[0]).toMatchObject({
      authSeqId: 1,
      labelCompId: 'GLU',
      oneLetterCode: 'E',
    });
    expect(result.measured.residues[0]).toMatchObject({
      authSeqId: 1,
      labelCompId: 'GLU',
      oneLetterCode: 'E',
      identityStatus: 'known',
    });
    expect(result.measured).toMatchObject({
      residueIdentityKnownCount: 202,
      residueIdentityUnknownCount: 1,
      residueIdentityOmittedCount: 2,
      residueOmittedCount: 3,
    });
  });

  it('enumerates unknown identity as an explicit residue object instead of dropping it', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'PDB:3OAA',
      label: 'Unknown identity selection',
      residues: [{ chain: 'A', authAsymId: 'A', position: 402 }],
      visibleRepresentations: [],
    });

    expect(result.kind).toBe('structure');
    if (result.kind !== 'structure') return;
    expect(result.measured.residues).toEqual([
      {
        chain: 'A',
        authAsymId: 'A',
        authSeqId: 402,
        labelCompId: null,
        oneLetterCode: null,
        identityStatus: 'unknown',
      },
    ]);
    expect(result.measured.residueIdentities).toEqual([]);
    expect(result.measured.residueOmittedCount).toBe(0);
  });

  it('rejects a capped identity list that omits any selected residue', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'structure:over-cap',
      label: '201 selected residues',
      residues: Array.from({ length: 201 }, (_, index) => ({
        chain: 'A',
        position: index + 1,
        labelCompId: 'GLY',
      })),
      visibleRepresentations: [],
    });

    expect(result.kind).toBe('structure');
    expect(hasCompleteStructureResidueIdentities(result)).toBe(false);
  });

  it('rejects unresolved component sentinels even when the descriptor labels them known', () => {
    const result = buildSelectionDescriptor({
      kind: 'structure',
      path: 'structure:unknown-sentinel',
      label: 'Unknown residue sentinel',
      residues: [{ chain: 'A', position: 7, labelCompId: 'UNK' }],
      visibleRepresentations: [],
    });

    expect(result.kind).toBe('structure');
    expect(hasCompleteStructureResidueIdentities(result)).toBe(false);
  });
});
