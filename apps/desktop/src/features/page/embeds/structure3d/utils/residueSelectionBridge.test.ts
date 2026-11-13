// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { useStructure3dStore } from '../store';
import type { ResidueLocation } from '../types';
import type { ResidueSelection } from '@waypoint/workspace-editor';
import { selectedCodonsToResidueSelections } from '@waypoint/workspace-editor';
import {
  applyStructureSelectionIntentToResidueSelections,
  buildResidueSelectionsForStructureLink,
  canonicalResidueLocationForStructureLink,
  codingDnaRangeForStructureResidue,
  residueSelectionsToStructureResidues,
  residueSelectionMapsToStructureLink,
  residueSelectionOwnedByStructurePanel,
} from './residueSelectionBridge';

const LINK = {
  sequenceDocumentId: '/fixtures/mg1655.gb',
  cdsStart: 190,
  cdsEnd: 255,
  strand: 1 as const,
  cdsLabel: 'thrL',
  residueTarget: { chain: 'A', residueMappingKind: 'identity' as const },
  residueTargets: [{ chain: 'A', residueMappingKind: 'identity' as const }],
};

const VPS8_LABEL = 'VPS8 CDS (CORVET complex membrane-binding subunit VPS8)';
const VPS8_PATH = '/fixtures/structure-s288c-vps8-ape-label.gb';

const VPS8_ALIAS_LINK = {
  sequenceDocumentId: VPS8_PATH,
  cdsStart: 143706,
  cdsEnd: 147530,
  strand: 1 as const,
  cdsLabel: VPS8_LABEL,
  cdsFeatureId: 'VPS8',
  residueTarget: {
    chain: 'A',
    baseChain: 'A',
    labelAsymId: 'A',
    authAsymId: 'A',
    entityId: '1',
    operator: '1_555',
    residues: [{ residueIndex: 25, position: 26 }],
  },
  residueTargets: [
    {
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
      operator: '1_555',
      residues: [{ residueIndex: 25, position: 26 }],
    },
  ],
  residueMolecule: {
    moleculeId: `translated-cds:${VPS8_PATH}:VPS8:143707-147531:1`,
    moleculeKind: 'translated-cds',
    label: VPS8_LABEL,
  },
};

const VPS8_SEQUENCE_COMMAND_CLICK_SELECTION: ResidueSelection = {
  selectionId: `translation-track:${VPS8_PATH}:${VPS8_LABEL}:25`,
  source: {
    kind: 'translation-track',
    id: VPS8_PATH,
    surface: 'sequence-cds',
    label: VPS8_LABEL,
  },
  target: {
    moleculeId: `translated-cds:${VPS8_PATH}:${VPS8_LABEL}:143707-147531:1`,
    moleculeKind: 'translated-cds',
    coordinateSystem: 'residue',
    intervals: [{ start: 25, end: 25 }],
    label: VPS8_LABEL,
  },
  mappings: [
    {
      kind: 'coding-dna',
      referenceId: VPS8_PATH,
      featureId: VPS8_LABEL,
      strand: 1,
      intervals: [{ start: 143781, end: 143783 }],
    },
  ],
};

const VPS8_FEATURE_ID_COMMAND_CLICK_SELECTION: ResidueSelection = {
  ...VPS8_SEQUENCE_COMMAND_CLICK_SELECTION,
  selectionId: `translation-track:${VPS8_PATH}:VPS8:25`,
  target: {
    ...VPS8_SEQUENCE_COMMAND_CLICK_SELECTION.target,
    moleculeId: `translated-cds:${VPS8_PATH}:VPS8:143707-147531:1`,
  },
  mappings: [
    {
      kind: 'coding-dna',
      referenceId: VPS8_PATH,
      featureId: 'VPS8',
      strand: 1,
      intervals: [{ start: 143781, end: 143783 }],
    },
  ],
};

describe('buildResidueSelectionsForStructureLink', () => {
  it('maps MolStar residue selections into residue targets with coding-DNA and structure mappings', () => {
    const selections = buildResidueSelectionsForStructureLink({
      structureId: 'structure:uniprot:P0AD86',
      link: LINK,
      selectedResidues: [
        {
          chain: 'A',
          position: 5,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          entityId: '1',
          operator: '1_555',
        },
      ],
    });

    expect(selections).toEqual([
      {
        selectionId: 'structure:structure:uniprot:P0AD86:residue:4',
        source: {
          kind: 'structure',
          id: 'structure:uniprot:P0AD86',
          surface: 'molstar',
        },
        target: {
          moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
          moleculeKind: 'translated-cds',
          coordinateSystem: 'residue',
          intervals: [{ start: 4, end: 4 }],
          label: 'thrL',
        },
        mappings: [
          {
            kind: 'coding-dna',
            referenceId: '/fixtures/mg1655.gb',
            featureId: 'thrL',
            strand: 1,
            intervals: [{ start: 202, end: 204 }],
          },
          {
            kind: 'structure',
            structureId: 'structure:uniprot:P0AD86',
            chain: 'A',
            position: 5,
            residueStart: 5,
            residueEnd: 5,
            baseChain: 'A',
            labelAsymId: 'A',
            authAsymId: 'A',
            entityId: '1',
            operator: '1_555',
          },
        ],
      },
    ]);
  });

  it('filters ligand selections because they do not map to coding residues', () => {
    const selections = buildResidueSelectionsForStructureLink({
      structureId: 'structure:uniprot:P0AD86',
      link: LINK,
      selectedResidues: [{ chain: 'A', position: 999, compId: 'ATP' }],
    });

    expect(selections).toEqual([]);
  });

  it('does not invent a coding-DNA mapping for direct protein structure selections', () => {
    const proteinLink = {
      ...LINK,
      residueMolecule: {
        moleculeId: 'protein:uniprot:P0AD86',
        moleculeKind: 'protein',
        label: 'thrL protein',
      },
    };

    const selections = buildResidueSelectionsForStructureLink({
      structureId: 'structure:uniprot:P0AD86',
      link: proteinLink,
      selectedResidues: [{ chain: 'A', position: 5 }],
    });

    expect(selections[0].target).toMatchObject({
      moleculeId: 'protein:uniprot:P0AD86',
      moleculeKind: 'protein',
      coordinateSystem: 'residue',
      intervals: [{ start: 4, end: 4 }],
    });
    expect(selections[0].mappings).toEqual([
      {
        kind: 'structure',
        structureId: 'structure:uniprot:P0AD86',
        chain: 'A',
        position: 5,
        residueStart: 5,
        residueEnd: 5,
      },
    ]);
  });
});

describe('residueSelectionsToStructureResidues — ownership boundaries', () => {
  const sharedStructureId = 'structure:rcsb:RCSB:6OQR:ENTRY:all';
  const atpDLink = {
    ...LINK,
    cdsLabel: 'atpD',
    cdsFeatureId: 'atpD',
    residueMolecule: {
      moleculeId: 'translated-cds:/fixtures/mg1655.gb:atpD:3915551-3916933:1',
      moleculeKind: 'translated-cds',
      label: 'atpD',
    },
    residueTargets: [
      {
        chain: 'H',
        labelAsymId: 'H',
        authAsymId: 'D',
        entityId: '6',
        residues: [{ residueIndex: 2, position: 2 }],
      },
    ],
  };
  const atpELink = {
    ...LINK,
    cdsLabel: 'atpE',
    cdsFeatureId: 'atpE',
    residueMolecule: {
      moleculeId: 'translated-cds:/fixtures/mg1655.gb:atpE:3917416-3917655:1',
      moleculeKind: 'translated-cds',
      label: 'atpE',
    },
    residueTargets: [
      {
        chain: 'I',
        labelAsymId: 'I',
        authAsymId: 'I',
        entityId: '7',
        residues: [{ residueIndex: 2, position: 3 }],
      },
    ],
  };

  it('does not apply an explicit structure mapping to a different residue molecule sharing the same structure id', () => {
    const selection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:atpD:2',
      source: {
        kind: 'translation-track',
        id: '/fixtures/mg1655.gb',
        surface: 'sequence-cds',
        label: 'atpD',
      },
      target: {
        moleculeId: atpDLink.residueMolecule.moleculeId,
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'atpD',
      },
      mappings: [
        {
          kind: 'structure',
          structureId: sharedStructureId,
          chain: 'H',
          position: 2,
          residueStart: 2,
          residueEnd: 2,
          labelAsymId: 'H',
          authAsymId: 'D',
          entityId: '6',
        },
      ],
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: sharedStructureId,
        link: atpDLink,
        selections: [selection],
      })
    ).toEqual([
      {
        chain: 'H',
        position: 2,
        labelAsymId: 'H',
        authAsymId: 'D',
        entityId: '6',
      },
    ]);
    expect(
      residueSelectionsToStructureResidues({
        structureId: sharedStructureId,
        link: atpELink,
        selections: [selection],
      })
    ).toEqual([]);
  });
});

describe('residueSelectionOwnedByStructurePanel', () => {
  it('does not treat sequence-origin selections on the same CDS as structure-owned', () => {
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:2',
      source: {
        kind: 'translation-track',
        id: '/fixtures/mg1655.gb',
        surface: 'sequence-cds',
        label: 'thrL',
      },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'thrL',
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'thrL',
          strand: 1,
          intervals: [{ start: 196, end: 198 }],
        },
      ],
    };

    expect(residueSelectionMapsToStructureLink(sequenceSelection, LINK)).toBe(true);
    expect(
      residueSelectionOwnedByStructurePanel(sequenceSelection, 'structure:uniprot:P0AD86', LINK)
    ).toBe(false);
  });

  it('recognizes this structure panel producer without claiming other structure panels', () => {
    const [selection] = buildResidueSelectionsForStructureLink({
      structureId: 'structure:uniprot:P0AD86',
      link: LINK,
      selectedResidues: [{ chain: 'A', position: 5 }],
    });

    expect(residueSelectionOwnedByStructurePanel(selection, 'structure:uniprot:P0AD86', LINK)).toBe(
      true
    );
    expect(residueSelectionOwnedByStructurePanel(selection, 'structure:uniprot:OTHER', LINK)).toBe(
      false
    );
  });

  it('does not claim an overlapping coding-DNA projection from a different residue molecule', () => {
    const otherCdsSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:otherCds:2',
      source: {
        kind: 'translation-track',
        id: '/fixtures/mg1655.gb',
        surface: 'sequence-cds',
        label: 'otherCds',
      },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:otherCds:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'otherCds',
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'otherCds',
          strand: 1,
          intervals: [{ start: 196, end: 198 }],
        },
      ],
    };

    expect(residueSelectionMapsToStructureLink(otherCdsSelection, LINK)).toBe(false);
    expect(
      residueSelectionOwnedByStructurePanel(otherCdsSelection, 'structure:uniprot:P0AD86', LINK)
    ).toBe(false);
  });

  it('does not let a matching coding-DNA mapping override an explicit foreign residue molecule', () => {
    const foreignTargetSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:foreignAlias:2',
      source: {
        kind: 'translation-track',
        id: '/fixtures/mg1655.gb',
        surface: 'sequence-cds',
        label: 'foreignAlias',
      },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:foreignAlias:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'foreignAlias',
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'thrL',
          strand: 1,
          intervals: [{ start: 196, end: 198 }],
        },
      ],
    };

    expect(residueSelectionMapsToStructureLink(foreignTargetSelection, LINK)).toBe(false);
    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        selections: [foreignTargetSelection],
      })
    ).toEqual([]);
  });

  it('maps sequence-origin selections when the drawer gene hint and rendered CDS label produce translated-CDS aliases', () => {
    expect(
      residueSelectionMapsToStructureLink(VPS8_SEQUENCE_COMMAND_CLICK_SELECTION, VPS8_ALIAS_LINK)
    ).toBe(true);

    expect(
      residueSelectionOwnedByStructurePanel(
        VPS8_SEQUENCE_COMMAND_CLICK_SELECTION,
        'structure:alphafold:AF:P39702:F1:V6:MODEL:AF-P39702-F1-model_v6:all',
        VPS8_ALIAS_LINK
      )
    ).toBe(false);
  });
});

describe('residueSelectionsToStructureResidues', () => {
  it('maps sequence-origin coding-DNA residue selections into the linked structure target', () => {
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:2',
      source: {
        kind: 'translation-track',
        id: '/fixtures/mg1655.gb',
        surface: 'sequence-cds',
        label: 'thrL',
      },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'thrL',
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'thrL',
          strand: 1,
          intervals: [{ start: 196, end: 198 }],
        },
      ],
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        selections: [sequenceSelection],
      })
    ).toEqual([{ chain: 'A', position: 3 }]);
  });

  it('uses explicit residue maps instead of assuming auth_seq_id equals protein index', () => {
    const offsetLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        residues: [
          { residueIndex: 0, position: 101 },
          { residueIndex: 1, position: 102 },
          { residueIndex: 2, position: 103 },
        ],
      },
      residueTargets: [
        {
          chain: 'A',
          residues: [
            { residueIndex: 0, position: 101 },
            { residueIndex: 1, position: 102 },
            { residueIndex: 2, position: 103 },
          ],
        },
      ],
    };
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:2',
      source: { kind: 'translation-track', id: '/fixtures/mg1655.gb' },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'thrL',
      },
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: offsetLink,
        selections: [sequenceSelection],
      })
    ).toEqual([{ chain: 'A', position: 103 }]);

    expect(
      buildResidueSelectionsForStructureLink({
        structureId: 'structure:uniprot:P0AD86',
        link: offsetLink,
        selectedResidues: [{ chain: 'A', position: 103 }],
      })[0].target.intervals
    ).toEqual([{ start: 2, end: 2 }]);
  });

  it('fails loudly if hover and selection project a shifted structure residue to different codon registers', () => {
    const offsetLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        residues: [
          { residueIndex: 0, position: 101 },
          { residueIndex: 1, position: 102 },
          { residueIndex: 2, position: 103 },
        ],
      },
      residueTargets: [
        {
          chain: 'A',
          residues: [
            { residueIndex: 0, position: 101 },
            { residueIndex: 1, position: 102 },
            { residueIndex: 2, position: 103 },
          ],
        },
      ],
    };
    const residue = { chain: 'A', position: 103 };
    const hoverCodingRange = codingDnaRangeForStructureResidue(offsetLink, residue);
    const selectionCodingRange = buildResidueSelectionsForStructureLink({
      structureId: 'structure:uniprot:P0AD86',
      link: offsetLink,
      selectedResidues: [residue],
    })[0]?.mappings?.find((mapping) => mapping.kind === 'coding-dna');

    expect(hoverCodingRange, 'hover projection did not produce a coding-DNA range').toEqual({
      start: 196,
      end: 198,
      strand: 1,
      residueIndex: 2,
    });
    expect(
      selectionCodingRange,
      'selection projection did not produce a coding-DNA mapping'
    ).toEqual({
      kind: 'coding-dna',
      referenceId: '/fixtures/mg1655.gb',
      featureId: 'thrL',
      strand: 1,
      intervals: [{ start: 196, end: 198 }],
    });
    expect(
      selectionCodingRange?.intervals[0],
      `Selection register diverged from hover for shifted residue ${JSON.stringify(residue)}. ` +
        `hover=${JSON.stringify(hoverCodingRange)} selection=${JSON.stringify(selectionCodingRange)}`
    ).toEqual({
      start: hoverCodingRange?.start,
      end: hoverCodingRange?.end,
    });
  });

  it('keeps reverse-strand hover and selection codon registers identical for shifted structure numbering', () => {
    const reverseOffsetLink = {
      ...LINK,
      strand: -1 as const,
      residueTarget: {
        chain: 'A',
        residues: [
          { residueIndex: 0, position: 301 },
          { residueIndex: 1, position: 302 },
          { residueIndex: 2, position: 303 },
        ],
      },
      residueTargets: [
        {
          chain: 'A',
          residues: [
            { residueIndex: 0, position: 301 },
            { residueIndex: 1, position: 302 },
            { residueIndex: 2, position: 303 },
          ],
        },
      ],
    };
    const residue = { chain: 'A', position: 303 };
    const hoverCodingRange = codingDnaRangeForStructureResidue(reverseOffsetLink, residue);
    const selectionCodingRange = buildResidueSelectionsForStructureLink({
      structureId: 'structure:uniprot:P0AD86',
      link: reverseOffsetLink,
      selectedResidues: [residue],
    })[0]?.mappings?.find((mapping) => mapping.kind === 'coding-dna');

    expect(hoverCodingRange, 'reverse-strand hover projection used the wrong register').toEqual({
      start: 247,
      end: 249,
      strand: -1,
      residueIndex: 2,
    });
    expect(
      selectionCodingRange?.intervals[0],
      `Reverse-strand selection register diverged from hover for shifted residue ${JSON.stringify(
        residue
      )}. hover=${JSON.stringify(hoverCodingRange)} selection=${JSON.stringify(
        selectionCodingRange
      )}`
    ).toEqual({
      start: hoverCodingRange?.start,
      end: hoverCodingRange?.end,
    });
  });

  it('does not synthesize residueIndex + 1 when an explicit residue map omits the selected residue', () => {
    const mappedSubsetLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'F',
        entityId: '1',
        operator: 'ASM_1',
        residues: [
          { residueIndex: 66, position: 67 },
          { residueIndex: 67, position: 68 },
        ],
      },
      residueTargets: [
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'F',
          entityId: '1',
          operator: 'ASM_1',
          residues: [
            { residueIndex: 66, position: 67 },
            { residueIndex: 67, position: 68 },
          ],
        },
      ],
    };
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:0',
      source: { kind: 'translation-track', id: '/fixtures/mg1655.gb' },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 0, end: 0 }],
        label: 'thrL',
      },
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:rcsb:8QX8',
        link: mappedSubsetLink,
        selections: [sequenceSelection],
      })
    ).toEqual([]);
  });

  it('does not synthesize residueIndex + 1 when an explicit residue map is present but empty', () => {
    const provisionalLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        residues: [],
      },
      residueTargets: [
        {
          chain: 'A',
          residues: [],
        },
      ],
    };
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:0',
      source: { kind: 'translation-track', id: '/fixtures/mg1655.gb' },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 0, end: 0 }],
        label: 'thrL',
      },
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:rcsb:8QX8',
        link: provisionalLink,
        selections: [sequenceSelection],
      })
    ).toEqual([]);
  });

  it('maps legacy selected-codon compatibility selections by coding-DNA projection, not fake molecule id', () => {
    const [compatSelection] = selectedCodonsToResidueSelections('/fixtures/mg1655.gb', [
      { start: 196, end: 198, strand: 1 },
    ]);

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        selections: [compatSelection],
      })
    ).toEqual([{ chain: 'A', position: 3 }]);
  });

  it('maps one sequence-origin residue to every linked structure chain target', () => {
    const multimerLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residueMappingKind: 'identity' as const,
      },
      residueTargets: [
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          residueMappingKind: 'identity' as const,
        },
        {
          chain: 'C',
          labelAsymId: 'C',
          authAsymId: 'C',
          residueMappingKind: 'identity' as const,
        },
      ],
    };
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:4',
      source: { kind: 'translation-track', id: '/fixtures/mg1655.gb' },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 4, end: 4 }],
        label: 'thrL',
      },
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: multimerLink,
        selections: [sequenceSelection],
      })
    ).toEqual([
      { chain: 'A', position: 5, labelAsymId: 'A', authAsymId: 'A' },
      { chain: 'C', position: 5, labelAsymId: 'C', authAsymId: 'C' },
    ]);
  });

  it('canonicalizes multimer structure-origin selections to one residue target', () => {
    const multimerLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [{ residueIndex: 4, position: 105 }],
      },
      residueTargets: [
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          residues: [{ residueIndex: 4, position: 105 }],
        },
        {
          chain: 'C',
          labelAsymId: 'C',
          authAsymId: 'C',
          residues: [{ residueIndex: 4, position: 205 }],
        },
      ],
    };

    const selections = buildResidueSelectionsForStructureLink({
      structureId: 'structure:rcsb:6OQR',
      link: multimerLink,
      selectedResidues: [
        { chain: 'A', position: 105, labelAsymId: 'A', authAsymId: 'A' },
        { chain: 'C', position: 205, labelAsymId: 'C', authAsymId: 'C' },
      ],
    });

    expect(selections).toHaveLength(1);
    expect(selections[0].target.intervals).toEqual([{ start: 4, end: 4 }]);
    expect(selections[0].mappings?.filter((mapping) => mapping.kind === 'structure')).toHaveLength(
      2
    );
    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:rcsb:6OQR',
        link: multimerLink,
        selections,
      })
    ).toEqual([
      { chain: 'A', position: 105, labelAsymId: 'A', authAsymId: 'A' },
      { chain: 'C', position: 205, labelAsymId: 'C', authAsymId: 'C' },
    ]);
  });

  it('expands a linked residue target even when a structure-origin mapping names one protomer', () => {
    const multimerLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [{ residueIndex: 4, position: 105 }],
      },
      residueTargets: [
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          residues: [{ residueIndex: 4, position: 105 }],
        },
        {
          chain: 'C',
          labelAsymId: 'C',
          authAsymId: 'C',
          residues: [{ residueIndex: 4, position: 205 }],
        },
      ],
    };
    const [selection] = buildResidueSelectionsForStructureLink({
      structureId: 'structure:rcsb:6OQR',
      link: multimerLink,
      selectedResidues: [{ chain: 'A', position: 105, labelAsymId: 'A', authAsymId: 'A' }],
    });

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:rcsb:6OQR',
        link: multimerLink,
        selections: [selection],
      })
    ).toEqual([
      { chain: 'A', position: 105, labelAsymId: 'A', authAsymId: 'A' },
      { chain: 'C', position: 205, labelAsymId: 'C', authAsymId: 'C' },
    ]);
  });

  it('maps direct protein residue selections without requiring a coding-DNA mapping', () => {
    const proteinLink = {
      ...LINK,
      residueMolecule: {
        moleculeId: 'protein:uniprot:P0AD86',
        moleculeKind: 'protein',
        label: 'thrL protein',
      },
    };
    const proteinSelection: ResidueSelection = {
      selectionId: 'protein-sequence:/fixtures/thrL.faa:2',
      source: {
        kind: 'protein-sequence-viewer',
        id: '/fixtures/thrL.faa',
        surface: 'protein-sequence',
      },
      target: {
        moleculeId: 'protein:uniprot:P0AD86',
        moleculeKind: 'protein',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 3 }],
        label: 'thrL protein',
      },
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: proteinLink,
        selections: [proteinSelection],
      })
    ).toEqual([
      { chain: 'A', position: 3 },
      { chain: 'A', position: 4 },
    ]);
  });

  it('projects an allele protein without fabricated coding bounds or a DNA mapping', () => {
    const proteinLink = {
      ...LINK,
      cdsStart: undefined,
      cdsEnd: undefined,
      strand: undefined,
      residueMolecule: { moleculeId: 'protein:allele', moleculeKind: 'protein', label: 'Allele' },
    };
    const selections = buildResidueSelectionsForStructureLink({
      structureId: 'allele-model',
      link: proteinLink,
      selectedResidues: [{ chain: 'A', position: 3 }],
    });
    expect(selections).toHaveLength(1);
    expect(selections[0].target).toMatchObject({
      moleculeId: 'protein:allele',
      intervals: [{ start: 2, end: 2 }],
    });
    expect(selections[0].mappings?.some((mapping) => mapping.kind === 'coding-dna')).toBe(false);
    expect(
      residueSelectionsToStructureResidues({
        structureId: 'allele-model',
        link: proteinLink,
        selections,
      })
    ).toEqual([{ chain: 'A', position: 3 }]);
  });

  it('treats protein and protein-sequence molecule kinds as the same direct protein domain', () => {
    const proteinLink = {
      ...LINK,
      residueMolecule: {
        moleculeId: 'protein:uniprot:P0AD86',
        moleculeKind: 'protein',
        label: 'thrL protein',
      },
    };
    const proteinSelection: ResidueSelection = {
      selectionId: 'protein-sequence:/fixtures/thrL.faa:2',
      source: {
        kind: 'protein-sequence-viewer',
        id: '/fixtures/thrL.faa',
        surface: 'protein-sequence',
      },
      target: {
        moleculeId: 'protein:uniprot:P0AD86',
        moleculeKind: 'protein-sequence',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'thrL protein',
      },
    };

    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:uniprot:P0AD86',
        link: proteinLink,
        selections: [proteinSelection],
      })
    ).toEqual([{ chain: 'A', position: 3 }]);
  });

  it('maps real sequence-editor Command-click selections to structure residues when translated-CDS IDs differ by alias', () => {
    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:alphafold:AF:P39702:F1:V6:MODEL:AF-P39702-F1-model_v6:all',
        link: VPS8_ALIAS_LINK,
        selections: [VPS8_SEQUENCE_COMMAND_CLICK_SELECTION],
      })
    ).toEqual([
      {
        chain: 'A',
        position: 26,
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        operator: '1_555',
      },
    ]);
  });

  it('maps command-click selections keyed by CDS feature id when the drawer display label is longer', () => {
    expect(
      residueSelectionsToStructureResidues({
        structureId: 'structure:alphafold:AF:P39702:F1:V6:MODEL:AF-P39702-F1-model_v6:all',
        link: VPS8_ALIAS_LINK,
        selections: [VPS8_FEATURE_ID_COMMAND_CLICK_SELECTION],
      })
    ).toEqual([
      {
        chain: 'A',
        position: 26,
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        operator: '1_555',
      },
    ]);
  });
});

describe('canonicalResidueLocationForStructureLink', () => {
  it('preserves the physical chain and native source identity across a shared residue index', () => {
    const firstTarget = {
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
      operator: 'ASM_1',
      residues: [{ residueIndex: 305, position: 306, labelSeqId: 9 }],
    };
    const secondTarget = {
      ...firstTarget,
      chain: 'B',
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'B',
    };
    const link = {
      ...LINK,
      cdsStart: 336,
      cdsEnd: 2798,
      residueTarget: firstTarget,
      residueTargets: [firstTarget, secondTarget],
    };
    const residue = {
      chain: 'B',
      position: 306,
      labelSeqId: 9,
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'B',
      entityId: '1',
      operator: 'ASM_1',
      structureRef: 'primary-structure',
      instanceId: 'primary-structure:B:ASM_1',
      isPrimarySource: true,
    };

    expect(canonicalResidueLocationForStructureLink(link, residue)).toEqual(residue);
    expect(
      canonicalResidueLocationForStructureLink(link, { ...residue, isPrimarySource: false })
    ).toBeNull();
    const selectedResidues = [
      canonicalResidueLocationForStructureLink(link, {
        ...residue,
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        instanceId: 'primary-structure:A:ASM_1',
      })!,
      canonicalResidueLocationForStructureLink(link, residue)!,
    ];
    const currentSelections = buildResidueSelectionsForStructureLink({
      structureId: 'linked-multimer',
      link,
      selectedResidues,
    });
    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'linked-multimer',
        link,
        currentSelections,
        selectedResidues,
      })
    ).toEqual(currentSelections);
  });

  it('upgrades a bare clicked residue to the mapped concrete structure identity', () => {
    const link = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        residues: [{ residueIndex: 2, position: 103 }],
      },
      residueTargets: [
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          residues: [{ residueIndex: 2, position: 103 }],
        },
      ],
    };

    expect(canonicalResidueLocationForStructureLink(link, { chain: 'A', position: 103 })).toEqual({
      chain: 'A',
      position: 103,
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
    });
  });
});

describe('applyStructureSelectionIntentToResidueSelections', () => {
  const sequenceSelection: ResidueSelection = {
    selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:2',
    source: {
      kind: 'translation-track',
      id: '/fixtures/mg1655.gb',
      surface: 'sequence-cds',
      label: 'thrL',
    },
    target: {
      moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: 2, end: 2 }],
      label: 'thrL',
    },
    mappings: [
      {
        kind: 'coding-dna',
        referenceId: '/fixtures/mg1655.gb',
        featureId: 'thrL',
        strand: 1,
        intervals: [{ start: 196, end: 198 }],
      },
    ],
  };

  const unrelatedProteinSelection: ResidueSelection = {
    selectionId: 'protein-sequence:/fixtures/other.faa:2',
    source: { kind: 'protein-sequence-viewer', id: '/fixtures/other.faa' },
    target: {
      moleculeId: 'protein:other',
      moleculeKind: 'protein',
      coordinateSystem: 'residue',
      intervals: [{ start: 2, end: 2 }],
    },
  };

  it('clears sequence-origin selections in this linked residue domain when MolStar clears', () => {
    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        currentSelections: [sequenceSelection, unrelatedProteinSelection],
        selectedResidues: [],
      })
    ).toEqual([unrelatedProteinSelection]);
  });

  it('preserves still-visible sequence-origin selections and writes only new structure residues', () => {
    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        currentSelections: [sequenceSelection],
        selectedResidues: [
          { chain: 'A', position: 3 },
          { chain: 'A', position: 5 },
        ],
      })
    ).toEqual([
      sequenceSelection,
      expect.objectContaining({
        source: { kind: 'structure', id: 'structure:uniprot:P0AD86', surface: 'molstar' },
        target: expect.objectContaining({ intervals: [{ start: 4, end: 4 }] }),
        mappings: expect.arrayContaining([
          expect.objectContaining({
            kind: 'structure',
            structureId: 'structure:uniprot:P0AD86',
            chain: 'A',
            position: 5,
          }),
        ]),
      }),
    ]);
  });

  it('retains native identity across a sequence projection before toggling a structure residue off', () => {
    const structureId = 'structure:rcsb:RCSB:1FS0:ENTRY:AUTH_ASYM:G';
    const target = {
      chain: 'B',
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'G',
      entityId: '2',
      operator: 'ASM_1',
      residues: [
        { residueIndex: 18, position: 19, labelSeqId: 1 },
        { residueIndex: 30, position: 31, labelSeqId: 13 },
      ],
    };
    const link = {
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsStart: 0,
      cdsEnd: 863,
      strand: -1 as const,
      cdsLabel: 'atpG',
      cdsFeatureId: 'b3733',
      residueTarget: target,
      residueTargets: [target],
    };
    const residueInventory: ResidueLocation[] = target.residues.map((residue) => ({
      chain: 'B',
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'G',
      entityId: '2',
      operator: 'ASM_1',
      position: residue.position,
      labelSeqId: residue.labelSeqId,
      structureRef: 'native-primary-model',
      instanceId: 'native-chain-B-ASM_1',
      isPrimarySource: true,
    }));
    const sequenceSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:b3733:30',
      source: { kind: 'translation-track', id: '/fixtures/mg1655.gb', surface: 'sequence-cds' },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:b3733:1-864:-1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 30, end: 30 }],
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'b3733',
          strand: -1,
          intervals: [{ start: 771, end: 773 }],
        },
      ],
    };
    const clicked = canonicalResidueLocationForStructureLink(link, residueInventory[0]);
    if (!clicked)
      throw new Error('Expected the primary atpG residue to map into the linked structure');
    const state = useStructure3dStore.getState();
    state.resetInteractionState(structureId);
    try {
      state.selectResidue(structureId, clicked, 'replace');
      const currentSelections = [
        ...buildResidueSelectionsForStructureLink({
          structureId,
          link,
          selectedResidues: useStructure3dStore.getState().interactionState[structureId].selected,
        }),
        sequenceSelection,
      ];
      state.setSelected(
        structureId,
        residueSelectionsToStructureResidues({
          structureId,
          link,
          selections: currentSelections,
          residueInventory,
        })
      );
      state.selectResidue(structureId, clicked, 'toggle');
      expect(
        applyStructureSelectionIntentToResidueSelections({
          structureId,
          link,
          currentSelections,
          selectedResidues: useStructure3dStore.getState().interactionState[structureId].selected,
        })
      ).toEqual([sequenceSelection]);
    } finally {
      state.resetInteractionState(structureId);
    }
  });

  it('removes a sequence-origin selection when the structure surface toggles that residue off', () => {
    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        currentSelections: [sequenceSelection],
        selectedResidues: [{ chain: 'A', position: 5 }],
      })
    ).toEqual([
      expect.objectContaining({
        source: { kind: 'structure', id: 'structure:uniprot:P0AD86', surface: 'molstar' },
        target: expect.objectContaining({ intervals: [{ start: 4, end: 4 }] }),
      }),
    ]);
  });

  it('treats partial multimer deselection as clearing the biological residue target', () => {
    const multimerLink = {
      ...LINK,
      residueTarget: {
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [{ residueIndex: 2, position: 103 }],
      },
      residueTargets: [
        {
          chain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          residues: [{ residueIndex: 2, position: 103 }],
        },
        {
          chain: 'C',
          labelAsymId: 'C',
          authAsymId: 'C',
          residues: [{ residueIndex: 2, position: 203 }],
        },
      ],
    };

    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'structure:rcsb:6OQR',
        link: multimerLink,
        currentSelections: [sequenceSelection],
        selectedResidues: [{ chain: 'A', position: 103, labelAsymId: 'A', authAsymId: 'A' }],
      })
    ).toEqual([]);
  });

  it('does not clear overlapping selections that belong to a different residue molecule', () => {
    const overlappingOtherCdsSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:otherCds:2',
      source: {
        kind: 'translation-track',
        id: '/fixtures/mg1655.gb',
        surface: 'sequence-cds',
        label: 'otherCds',
      },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:otherCds:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
        label: 'otherCds',
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'otherCds',
          strand: 1,
          intervals: [{ start: 196, end: 198 }],
        },
      ],
    };

    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'structure:uniprot:P0AD86',
        link: LINK,
        currentSelections: [sequenceSelection, overlappingOtherCdsSelection],
        selectedResidues: [],
      })
    ).toEqual([overlappingOtherCdsSelection]);
  });

  it('clears sequence-origin alias selections when the structure surface clears the linked residue domain', () => {
    expect(
      applyStructureSelectionIntentToResidueSelections({
        structureId: 'structure:alphafold:AF:P39702:F1:V6:MODEL:AF-P39702-F1-model_v6:all',
        link: VPS8_ALIAS_LINK,
        currentSelections: [VPS8_SEQUENCE_COMMAND_CLICK_SELECTION, unrelatedProteinSelection],
        selectedResidues: [],
      })
    ).toEqual([unrelatedProteinSelection]);
  });
});
