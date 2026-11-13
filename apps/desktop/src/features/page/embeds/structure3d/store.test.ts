// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { useStructure3dStore } from './store';
import { useStructureLinkRegistry } from '../../../structure-drawer/state/use-structure-link-registry';
import { useStructureResidueSessionRegistry } from '../../../structure-drawer/state/structure-residue-session-registry';
import type { Structure3dAttrs } from './types';

const STRUCTURE_ATTRS: Structure3dAttrs = {
  structureId: 'structure:uniprot:P0AD86',
  source: 'alphafold',
  sourceId: 'P0AD86',
  label: 'thrL',
};

function reset() {
  useStructure3dStore.setState({
    expandedStructures: {},
    interactionState: {},
    selectionAnchor: {},
    selectionRangeBase: {},
  });
  useStructureLinkRegistry.setState({ links: {} });
  useStructureResidueSessionRegistry.setState({ sessions: {} });
}

describe('useStructure3dStore registration', () => {
  beforeEach(reset);

  it('does not churn subscribers when registering identical structure attrs', () => {
    let notifications = 0;
    const unsubscribe = useStructure3dStore.subscribe(() => {
      notifications += 1;
    });

    useStructure3dStore
      .getState()
      .registerStructure(STRUCTURE_ATTRS.structureId, STRUCTURE_ATTRS, 'thrL');
    useStructure3dStore
      .getState()
      .registerStructure(STRUCTURE_ATTRS.structureId, { ...STRUCTURE_ATTRS }, 'thrL');

    unsubscribe();
    expect(notifications).toBe(1);
  });
});

describe('useStructure3dStore residue selection', () => {
  beforeEach(reset);

  it('expands Shift selection over real ordered residues and keeps the original anchor', () => {
    const structureId = 'structure:3OAA:A';
    const orderedResidues = [
      { chain: 'A', position: 86, labelSeqId: 86, labelCompId: 'MET' },
      { chain: 'A', position: 87, labelSeqId: 87, labelCompId: 'GLY' },
      { chain: 'A', position: 96, labelSeqId: 88, labelCompId: 'GLU' },
      { chain: 'A', position: 109, labelSeqId: 109, labelCompId: 'ASN' },
    ];

    const store = useStructure3dStore.getState();
    store.selectResidue(structureId, orderedResidues[0], 'replace', orderedResidues);
    store.selectResidue(structureId, orderedResidues[3], 'range', orderedResidues);

    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual(
      orderedResidues
    );
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(orderedResidues[0]);

    store.selectResidue(structureId, orderedResidues[2], 'range', orderedResidues);
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual(
      orderedResidues.slice(0, 3)
    );
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(orderedResidues[0]);
  });

  it('uses additive toggle for Command/Control selection and plain click to replace', () => {
    const structureId = 'structure:3OAA:A';
    const gly57 = { chain: 'A', position: 57, labelSeqId: 57, labelCompId: 'GLY' };
    const gly102 = { chain: 'A', position: 102, labelSeqId: 102, labelCompId: 'GLY' };
    const tyr195 = { chain: 'A', position: 195, labelSeqId: 195, labelCompId: 'TYR' };

    const store = useStructure3dStore.getState();
    store.selectResidue(structureId, gly57, 'replace');
    store.selectResidue(structureId, gly102, 'toggle');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      gly57,
      gly102,
    ]);

    store.selectResidue(structureId, gly57, 'toggle');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      gly102,
    ]);

    store.selectResidue(structureId, tyr195, 'replace');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      tyr195,
    ]);
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(tyr195);
  });

  it('treats bridge and amino-acid-list forms of one polymer residue as the same toggle target', () => {
    const structureId = 'structure:cross-surface-toggle';
    const projectedResidue = {
      chain: 'A',
      position: 102,
      labelSeqId: 102,
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
    };
    const identifiedResidue = { ...projectedResidue, labelCompId: 'GLY' };
    const store = useStructure3dStore.getState();

    store.setSelected(structureId, [projectedResidue], projectedResidue);
    store.selectResidue(structureId, identifiedResidue, 'toggle', [identifiedResidue]);

    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([]);
  });

  it('expands from a projected anchor that lacks amino-acid metadata', () => {
    const structureId = 'structure:cross-surface-range';
    const orderedResidues = [100, 101, 102].map((position) => ({
      chain: 'A',
      position,
      labelSeqId: position,
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
      labelCompId: position === 100 ? 'ALA' : position === 101 ? 'GLY' : 'SER',
    }));
    const projectedAnchor = { ...orderedResidues[0], labelCompId: undefined };
    const store = useStructure3dStore.getState();

    store.setSelected(structureId, [projectedAnchor], projectedAnchor);
    store.selectResidue(structureId, orderedResidues[2], 'range', orderedResidues);

    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual(
      orderedResidues
    );
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(projectedAnchor);
  });

  it('preserves prior ranges when an additive anchor starts a new Shift range', () => {
    const structureId = 'structure:multi-range';
    const positions = [
      ...Array.from({ length: 24 }, (_, index) => 86 + index),
      ...Array.from({ length: 16 }, (_, index) => 195 + index),
    ];
    const orderedResidues = positions.map((position, sequenceIndex) => ({
      chain: 'A',
      position,
      labelSeqId: sequenceIndex + 1,
      labelCompId: 'ALA',
    }));
    const residueAt = (position: number) => {
      const residue = orderedResidues.find((candidate) => candidate.position === position);
      if (!residue) throw new Error(`missing test residue ${position}`);
      return residue;
    };

    const store = useStructure3dStore.getState();
    store.selectResidue(structureId, residueAt(86), 'replace', orderedResidues);
    store.selectResidue(structureId, residueAt(109), 'range', orderedResidues);
    store.selectResidue(structureId, residueAt(195), 'toggle', orderedResidues);
    store.selectResidue(structureId, residueAt(210), 'range', orderedResidues);

    expect(
      useStructure3dStore.getState().interactionState[structureId]?.selected.map((r) => r.position)
    ).toEqual(positions);
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(residueAt(195));

    store.selectResidue(structureId, residueAt(205), 'range', orderedResidues);
    expect(
      useStructure3dStore.getState().interactionState[structureId]?.selected.map((r) => r.position)
    ).toEqual(
      positions.filter((position) => position <= 109 || (position >= 195 && position <= 205))
    );
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(residueAt(195));
  });

  it('clears the anchor and preserved range base even when no residue remains painted', () => {
    const structureId = 'structure:stale-range-metadata';
    const staleAnchor = { chain: 'A', position: 195, labelSeqId: 195, labelCompId: 'TYR' };
    const staleBase = [{ chain: 'A', position: 86, labelSeqId: 86, labelCompId: 'GLY' }];
    useStructure3dStore.setState({
      interactionState: { [structureId]: { hovered: null, selected: [] } },
      selectionAnchor: { [structureId]: staleAnchor },
      selectionRangeBase: { [structureId]: staleBase },
    });

    useStructure3dStore.getState().clearSelection(structureId);

    const state = useStructure3dStore.getState();
    expect(state.interactionState[structureId]?.selected).toEqual([]);
    expect(state.selectionAnchor[structureId]).toBeNull();
    expect(state.selectionRangeBase[structureId]).toEqual([]);
  });

  it('clears transient selection-render groups but preserves durable annotations', () => {
    const structureId = 'structure:reference-selection-clear';
    const store = useStructure3dStore.getState();
    store.registerStructure(structureId, { ...STRUCTURE_ATTRS, structureId }, 'selection clear');
    const registered = useStructure3dStore.getState().expandedStructures[structureId].data;
    store.updateStructureData(structureId, {
      ...registered,
      highlightGroups: [
        {
          id: 'agent-reference-selection',
          label: 'Reference selection',
          renderMode: 'selection',
          selections: [{ chain: 'A', ranges: [[57, 57]] }],
        },
        {
          id: 'saved-selection-1',
          label: 'Saved annotation',
          renderMode: 'annotation',
          selections: [{ chain: 'A', ranges: [[102, 102]] }],
        },
      ],
    });

    useStructure3dStore.getState().clearSelection(structureId);

    expect(
      useStructure3dStore.getState().expandedStructures[structureId].data.highlightGroups
    ).toEqual([expect.objectContaining({ id: 'saved-selection-1', renderMode: 'annotation' })]);
  });

  it('adds, removes, and replaces a real chain residue set atomically', () => {
    const structureId = 'structure:3OAA:A+B';
    const existing = { chain: 'A', position: 57, labelSeqId: 57, labelCompId: 'GLY' };
    const chainB = [
      { chain: 'B', position: 26, labelSeqId: 1, labelCompId: 'HIS' },
      { chain: 'B', position: 27, labelSeqId: 2, labelCompId: 'ALA' },
      { chain: 'B', position: 28, labelSeqId: 3, labelCompId: 'GLY' },
    ];

    const store = useStructure3dStore.getState();
    store.selectResidue(structureId, existing, 'replace');
    store.selectResidue(structureId, chainB[0], 'toggle');
    store.selectResidues(structureId, chainB, 'toggle');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      existing,
      ...chainB,
    ]);

    store.selectResidues(structureId, chainB, 'toggle');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      existing,
    ]);

    store.selectResidues(structureId, chainB, 'replace');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual(chainB);
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(chainB.at(-1));
  });

  it('preserves prior chain rows while resizing a new disjoint Shift-chain range', () => {
    const structureId = 'structure:chains:A+B+C';
    const makeChain = (chain: string, start: number) =>
      Array.from({ length: 3 }, (_, index) => ({
        chain,
        position: start + index,
        labelSeqId: index + 1,
        labelCompId: 'ALA',
      }));
    const chainA = makeChain('A', 1);
    const chainB = makeChain('B', 101);
    const chainC = makeChain('C', 201);
    const store = useStructure3dStore.getState();

    store.selectResidues(structureId, chainA, 'replace');
    store.selectResidues(structureId, chainB, 'toggle');
    store.selectResidues(structureId, [...chainB, ...chainC], 'range');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      ...chainA,
      ...chainB,
      ...chainC,
    ]);

    store.selectResidues(structureId, chainB, 'range');
    expect(useStructure3dStore.getState().interactionState[structureId]?.selected).toEqual([
      ...chainA,
      ...chainB,
    ]);
    expect(useStructure3dStore.getState().selectionAnchor[structureId]).toEqual(chainB.at(-1));
  });
});
