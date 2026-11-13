/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  createResidueSelectionsStore,
  hasResidueSelectionForMolecule,
  residueSelectionsToCodingDnaRanges,
  applyResidueSelectionCommand,
  replaceResidueSelectionForMolecule,
  type ResidueSelection,
} from './residue-selection-store';

const PROTEIN_100_SELECTION: ResidueSelection = {
  selectionId: 'protein:P0A000:100',
  source: { kind: 'protein-sequence', id: 'protein.fa', surface: 'protein-sequence' },
  target: {
    moleculeId: 'protein:P0A000',
    moleculeKind: 'protein',
    coordinateSystem: 'residue',
    intervals: [{ start: 100, end: 100 }],
  },
};

const PROTEIN_101_SELECTION: ResidueSelection = {
  selectionId: 'protein:P0A000:101',
  source: { kind: 'variant-track', id: 'variants.vcf', surface: 'vcf-track' },
  target: {
    moleculeId: 'protein:P0A000',
    moleculeKind: 'protein',
    coordinateSystem: 'residue',
    intervals: [{ start: 101, end: 101 }],
  },
};

describe('residueSelectionsStore', () => {
  it('replaces selections for one residue-bearing molecule while preserving unrelated molecules', () => {
    const otherMolecule: ResidueSelection = {
      selectionId: 'protein:P9OTHER:5',
      target: {
        moleculeId: 'protein:P9OTHER',
        moleculeKind: 'protein',
        coordinateSystem: 'residue',
        intervals: [{ start: 5, end: 5 }],
      },
    };
    const replacement: ResidueSelection = {
      ...PROTEIN_100_SELECTION,
      selectionId: 'protein:P0A000:100-103',
      target: {
        ...PROTEIN_100_SELECTION.target,
        intervals: [{ start: 100, end: 103 }],
      },
    };

    expect(
      replaceResidueSelectionForMolecule(
        [PROTEIN_100_SELECTION, PROTEIN_101_SELECTION, otherMolecule],
        replacement
      )
    ).toEqual([otherMolecule, replacement]);
  });

  it('detects whether a residue-bearing molecule still has an active selection', () => {
    expect(
      hasResidueSelectionForMolecule([PROTEIN_100_SELECTION], {
        moleculeId: 'protein:P0A000',
        moleculeKind: 'protein',
      })
    ).toBe(true);
    expect(
      hasResidueSelectionForMolecule([PROTEIN_100_SELECTION], {
        moleculeId: 'protein:P0A000',
        moleculeKind: 'translated-cds',
      })
    ).toBe(false);
    expect(
      hasResidueSelectionForMolecule([], {
        moleculeId: 'protein:P0A000',
        moleculeKind: 'protein',
      })
    ).toBe(false);
  });

  it('round-trips a direct protein-track residue selection without nucleotide or structure mappings', () => {
    const store = createResidueSelectionsStore();

    store.set([
      {
        selectionId: 'protein-msa-row-42',
        source: {
          kind: 'protein-msa-row',
          id: 'alignment.aln:row-42',
          surface: 'protein-msa',
          label: 'Val101',
        },
        target: {
          moleculeId: 'protein:P0A000',
          moleculeKind: 'protein',
          coordinateSystem: 'residue',
          intervals: [{ start: 100, end: 100 }],
          label: 'lacZ protein',
        },
      },
    ]);

    expect(store.getSnapshot()).toEqual([
      {
        selectionId: 'protein-msa-row-42',
        source: {
          kind: 'protein-msa-row',
          id: 'alignment.aln:row-42',
          surface: 'protein-msa',
          label: 'Val101',
        },
        target: {
          moleculeId: 'protein:P0A000',
          moleculeKind: 'protein',
          coordinateSystem: 'residue',
          intervals: [{ start: 100, end: 100 }],
          label: 'lacZ protein',
        },
      },
    ]);
    expect(residueSelectionsToCodingDnaRanges(store.getSnapshot())).toEqual([]);
  });

  it('treats source identity as part of dedup so equal residue targets from different producers notify', () => {
    const store = createResidueSelectionsStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.set([
      {
        source: { kind: 'structure', id: '6OQR', surface: 'molstar' },
        target: {
          moleculeId: 'protein:P0A000',
          moleculeKind: 'protein',
          coordinateSystem: 'residue',
          intervals: [{ start: 100, end: 100 }],
        },
      },
    ]);
    store.set([
      {
        source: { kind: 'vcf-track', id: 'variants.vcf:42', surface: '1d-track' },
        target: {
          moleculeId: 'protein:P0A000',
          moleculeKind: 'protein',
          coordinateSystem: 'residue',
          intervals: [{ start: 100, end: 100 }],
        },
      },
    ]);

    expect(notifications).toBe(2);
    expect(store.getSnapshot()[0].source?.kind).toBe('vcf-track');
  });

  it('still coerces empty writes to one stable singleton', () => {
    const store = createResidueSelectionsStore();
    const initial = store.getSnapshot();
    store.set([]);
    expect(store.getSnapshot()).toBe(initial);
    store.set([
      {
        target: {
          moleculeId: 'protein:P0A000',
          moleculeKind: 'protein',
          coordinateSystem: 'residue',
          intervals: [{ start: 10, end: 10 }],
        },
      },
    ]);
    store.set([]);
    expect(store.getSnapshot()).toBe(initial);
  });

  it('applies reducer commands and revisions as the canonical write path', () => {
    const store = createResidueSelectionsStore();
    expect(store.getRevision()).toBe(0);

    store.dispatch({ type: 'toggle', selection: PROTEIN_100_SELECTION });
    expect(store.getSnapshot()).toEqual([PROTEIN_100_SELECTION]);
    expect(store.getRevision()).toBe(1);

    store.dispatch({ type: 'toggle', selection: PROTEIN_100_SELECTION });
    expect(store.getSnapshot()).toEqual([]);
    expect(store.getRevision()).toBe(2);

    store.dispatch({ type: 'replace', selections: [PROTEIN_100_SELECTION, PROTEIN_101_SELECTION] });
    store.dispatch({
      type: 'clear',
      scope: { kind: 'source', sourceKind: 'variant-track', sourceId: 'variants.vcf' },
    });
    expect(store.getSnapshot()).toEqual([PROTEIN_100_SELECTION]);
    expect(store.getRevision()).toBe(4);
  });

  it('supports molecule and structure-session scoped clears without nucleotide ownership', () => {
    const structureSelection: ResidueSelection = {
      ...PROTEIN_101_SELECTION,
      source: { kind: 'structure', id: 'structure:rcsb:1ABC', surface: 'molstar' },
      mappings: [
        {
          kind: 'structure',
          structureId: 'structure:rcsb:1ABC',
          chain: 'A',
          position: 102,
          residueStart: 102,
          residueEnd: 102,
        },
      ],
    };

    expect(
      applyResidueSelectionCommand([PROTEIN_100_SELECTION, structureSelection], {
        type: 'clear',
        scope: { kind: 'structure-session', structureId: 'structure:rcsb:1ABC' },
      })
    ).toEqual([PROTEIN_100_SELECTION]);

    expect(
      applyResidueSelectionCommand([PROTEIN_100_SELECTION, structureSelection], {
        type: 'clear',
        scope: { kind: 'molecule', moleculeId: 'protein:P0A000', moleculeKind: 'protein' },
      })
    ).toEqual([]);
  });

  it('clears sequence-origin selections for a structure session only when link identity is supplied', () => {
    const sequenceOriginSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:2',
      source: { kind: 'translation-track', id: '/fixtures/mg1655.gb', surface: 'sequence-cds' },
      target: {
        moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 2 }],
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
      applyResidueSelectionCommand([sequenceOriginSelection], {
        type: 'clear',
        scope: { kind: 'structure-session', structureId: 'structure:uniprot:P0AD86' },
      })
    ).toEqual([sequenceOriginSelection]);

    expect(
      applyResidueSelectionCommand([sequenceOriginSelection], {
        type: 'clear',
        scope: {
          kind: 'structure-session',
          structureId: 'structure:uniprot:P0AD86',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'thrL',
        },
      })
    ).toEqual([]);

    expect(
      applyResidueSelectionCommand([sequenceOriginSelection], {
        type: 'clear',
        scope: {
          kind: 'structure-session',
          structureId: 'structure:uniprot:P0AD86',
          moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
          moleculeKind: 'translated-cds',
        },
      })
    ).toEqual([]);
  });
});
