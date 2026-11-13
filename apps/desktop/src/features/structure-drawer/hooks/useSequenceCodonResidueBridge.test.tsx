/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createHoveredCodonStore } from '@waypoint/workspace-editor';
import { createHoveredResidueStore } from '../state/hovered-residue-store';
import {
  useStructureLinkRegistry,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import { useSequenceCodonResidueBridge } from './useSequenceCodonResidueBridge';

const FILE_PATH = '/fixtures/mg1655.gb';
const STRUCTURE_ID = 'structure:rcsb:4XXU:all';

const LINK: StructureLinkEntry = {
  structureId: STRUCTURE_ID,
  sequenceDocumentId: FILE_PATH,
  cdsLabel: 'modA',
  translation: 'M'.repeat(20),
  cdsStart: 100,
  cdsEnd: 159,
  strand: 1,
  residueTarget: {
    chain: 'H',
    labelAsymId: 'B',
    authAsymId: 'H',
    entityId: '1',
    residueMappingKind: 'identity',
  },
};

function resetRegistry() {
  useStructureLinkRegistry.setState({ links: {} });
}

afterEach(resetRegistry);

describe('useSequenceCodonResidueBridge', () => {
  it('bridges any sequence-sourced codon store write into the structure residue store', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink(LINK);

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
    });

    expect(hoveredResidueStore.getSnapshot()).toEqual({
      structureId: STRUCTURE_ID,
      chain: 'H',
      position: 5,
      labelAsymId: 'B',
      authAsymId: 'H',
      entityId: '1',
    });
  });

  it('bridges sequence codon hover through explicit structure residue maps', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink({
      ...LINK,
      residueTarget: {
        chain: 'H',
        labelAsymId: 'B',
        authAsymId: 'H',
        entityId: '1',
        residues: [{ residueIndex: 4, position: 19 }],
      },
    });

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
    });

    expect(hoveredResidueStore.getSnapshot()).toEqual({
      structureId: STRUCTURE_ID,
      chain: 'H',
      position: 19,
      labelAsymId: 'B',
      authAsymId: 'H',
      entityId: '1',
    });
  });

  it('does not bridge sequence codon hover when an explicit structure map has no residue', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink({
      ...LINK,
      residueTarget: {
        chain: 'H',
        labelAsymId: 'B',
        authAsymId: 'H',
        entityId: '1',
        residues: [],
      },
    });

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
    });

    expect(hoveredResidueStore.getSnapshot()).toBeNull();
  });

  it('does not rerender the host component for high-frequency codon hover ticks', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink(LINK);
    let renders = 0;

    renderHook(() => {
      renders++;
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      });
    });

    expect(renders).toBe(1);

    act(() => {
      hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
      hoveredCodonStore.set({ start: 115, end: 117, strand: 1, source: 'sequence' });
      hoveredCodonStore.set({ start: 118, end: 120, strand: 1, source: 'sequence' });
    });

    expect(renders).toBe(1);
    expect(hoveredResidueStore.getSnapshot()?.position).toBe(7);
  });

  it('ignores structure-sourced codon echoes because Molstar already owns the residue write', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink(LINK);

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredResidueStore.set({ structureId: STRUCTURE_ID, chain: 'H', position: 8 });
      hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'structure' });
    });

    expect(hoveredResidueStore.getSnapshot()).toEqual({
      structureId: STRUCTURE_ID,
      chain: 'H',
      position: 8,
    });
  });

  it('clears only this sequence file owned residue hover when sequence codon hover leaves', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink(LINK);

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
    });
    expect(hoveredResidueStore.getSnapshot()?.position).toBe(5);

    act(() => {
      hoveredCodonStore.set(null);
    });

    expect(hoveredResidueStore.getSnapshot()).toBeNull();
  });

  it('does not clear a residue hover owned by another source sequence', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink({
      ...LINK,
      sequenceDocumentId: '/other/file.gb',
    });
    hoveredResidueStore.set({ structureId: STRUCTURE_ID, chain: 'H', position: 5 });

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredCodonStore.set(null);
    });

    expect(hoveredResidueStore.getSnapshot()).toEqual({
      structureId: STRUCTURE_ID,
      chain: 'H',
      position: 5,
    });
  });

  it('does not clear a same-sequence residue hover that this bridge did not last write', () => {
    const hoveredCodonStore = createHoveredCodonStore();
    const hoveredResidueStore = createHoveredResidueStore();
    useStructureLinkRegistry.getState().registerLink(LINK);
    hoveredResidueStore.set({ structureId: STRUCTURE_ID, chain: 'H', position: 9 });

    renderHook(() =>
      useSequenceCodonResidueBridge({
        entityId: FILE_PATH,
        hoveredCodonStore,
        hoveredResidueStore,
      })
    );

    act(() => {
      hoveredCodonStore.set(null);
    });

    expect(hoveredResidueStore.getSnapshot()).toEqual({
      structureId: STRUCTURE_ID,
      chain: 'H',
      position: 9,
    });
  });
});
