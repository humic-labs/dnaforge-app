import { createRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHoveredCodonStore,
  createResidueSelectionsStore,
  type ResidueSelection,
} from '@waypoint/workspace-editor';
import { createHoveredResidueStore } from '../state/hovered-residue-store';
import {
  useStructureLinkRegistry,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import {
  useProteinSequenceWebGLOverlaySync,
  type ProteinSequenceWebGLOverlayHandle,
} from './useProteinSequenceWebGLOverlaySync';

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

function stores() {
  return {
    hoveredCodonStore: createHoveredCodonStore(),
    residueSelectionsStore: createResidueSelectionsStore(),
    hoveredResidueStore: createHoveredResidueStore(),
  };
}

function target() {
  const ref = createRef<ProteinSequenceWebGLOverlayHandle>();
  ref.current = {
    setResidueLinkRange: vi.fn(),
    setHoveredCodon: vi.fn(),
    setSelectedCodons: vi.fn(),
  };
  return ref;
}

function translatedCdsSelection({
  residueIndex,
  start,
  end,
  sourceKind = 'structure',
}: {
  residueIndex: number;
  start: number;
  end: number;
  sourceKind?: string;
}): ResidueSelection {
  return {
    selectionId: `${sourceKind}:${residueIndex}`,
    source: { kind: sourceKind, id: `${sourceKind}:${residueIndex}` },
    target: {
      moleculeId: `translated-cds:${FILE_PATH}:modA`,
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: residueIndex, end: residueIndex }],
      label: 'modA',
    },
    mappings: [
      {
        kind: 'coding-dna',
        referenceId: FILE_PATH,
        featureId: 'modA',
        strand: 1,
        intervals: [{ start, end }],
      },
    ],
  };
}

function directProteinSelection(residueIndex: number): ResidueSelection {
  return {
    selectionId: `protein:${residueIndex}`,
    source: { kind: 'protein-msa-row', id: `row-a:${residueIndex}` },
    target: {
      moleculeId: 'protein:P0A000',
      moleculeKind: 'protein',
      coordinateSystem: 'residue',
      intervals: [{ start: residueIndex, end: residueIndex }],
      label: 'direct protein',
    },
  };
}

afterEach(resetRegistry);

describe('useProteinSequenceWebGLOverlaySync', () => {
  it('is the single imperative WebGL sink for protein hover, residue-link, and selected-codon overlays', () => {
    const s = stores();
    const targetRef = target();
    useStructureLinkRegistry.getState().registerLink(LINK);

    renderHook(() =>
      useProteinSequenceWebGLOverlaySync({
        entityId: FILE_PATH,
        ...s,
        targetRef,
        enabled: true,
      })
    );

    act(() => {
      s.hoveredResidueStore.set({
        structureId: STRUCTURE_ID,
        chain: 'H',
        labelAsymId: 'B',
        authAsymId: 'H',
        entityId: '1',
        position: 5,
      });
      s.hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
      s.residueSelectionsStore.set([
        translatedCdsSelection({ residueIndex: 5, start: 115, end: 117 }),
      ]);
    });

    expect(targetRef.current!.setResidueLinkRange).toHaveBeenCalledWith([112, 114]);
    expect(targetRef.current!.setResidueLinkRange).toHaveBeenLastCalledWith(null);
    expect(targetRef.current!.setHoveredCodon).toHaveBeenLastCalledWith({
      start: 112,
      end: 114,
      strand: 1,
    });
    expect(targetRef.current!.setSelectedCodons).toHaveBeenLastCalledWith([
      { start: 115, end: 117, strand: 1 },
    ]);
  });

  it('does not rerender the host component for high-frequency hover or selection ticks', () => {
    const s = stores();
    const targetRef = target();
    let renders = 0;

    renderHook(() => {
      renders++;
      useProteinSequenceWebGLOverlaySync({
        entityId: FILE_PATH,
        ...s,
        targetRef,
        enabled: true,
      });
    });

    expect(renders).toBe(1);

    act(() => {
      s.hoveredCodonStore.set({ start: 112, end: 114, strand: 1, source: 'sequence' });
      s.hoveredCodonStore.set({ start: 115, end: 117, strand: 1, source: 'sequence' });
      s.residueSelectionsStore.set([
        translatedCdsSelection({ residueIndex: 5, start: 115, end: 117 }),
      ]);
      s.residueSelectionsStore.set([
        translatedCdsSelection({ residueIndex: 6, start: 118, end: 120 }),
      ]);
    });

    expect(renders).toBe(1);
    expect(targetRef.current!.setHoveredCodon).toHaveBeenLastCalledWith({
      start: 115,
      end: 117,
      strand: 1,
    });
    expect(targetRef.current!.setSelectedCodons).toHaveBeenLastCalledWith([
      { start: 118, end: 120, strand: 1 },
    ]);
  });

  it('projects track-origin residue selections through coding-DNA mappings for the WebGL sink', () => {
    const s = stores();
    const targetRef = target();

    renderHook(() =>
      useProteinSequenceWebGLOverlaySync({
        entityId: FILE_PATH,
        ...s,
        targetRef,
        enabled: true,
      })
    );

    act(() => {
      s.residueSelectionsStore.set([
        {
          selectionId: 'vcf-row-42',
          source: {
            kind: 'vcf-track',
            id: 'variants.vcf:42',
            surface: '1d-track',
            label: 'p.Val101Ala',
          },
          target: {
            moleculeId: `translated-cds:${FILE_PATH}:lacZ`,
            moleculeKind: 'translated-cds',
            coordinateSystem: 'residue',
            intervals: [{ start: 100, end: 100 }],
            label: 'lacZ',
          },
          mappings: [
            {
              kind: 'coding-dna',
              referenceId: FILE_PATH,
              featureId: 'lacZ',
              strand: 1,
              intervals: [{ start: 300, end: 302 }],
            },
          ],
        },
      ]);
    });

    expect(targetRef.current!.setSelectedCodons).toHaveBeenLastCalledWith([
      { start: 300, end: 302, strand: 1 },
    ]);
  });

  it('clears the WebGL codon projection when the next residue selection has no coding-DNA mapping', () => {
    const s = stores();
    const targetRef = target();

    renderHook(() =>
      useProteinSequenceWebGLOverlaySync({
        entityId: FILE_PATH,
        ...s,
        targetRef,
        enabled: true,
      })
    );

    act(() => {
      s.residueSelectionsStore.set([
        translatedCdsSelection({ residueIndex: 100, start: 300, end: 302 }),
      ]);
      s.residueSelectionsStore.set([directProteinSelection(100)]);
    });

    expect(targetRef.current!.setSelectedCodons).toHaveBeenCalledTimes(3);
    expect(targetRef.current!.setSelectedCodons).toHaveBeenLastCalledWith([]);
  });

  it('delivers selections made before the WebGL target mounts when that target becomes ready', () => {
    const s = stores();
    const targetRef = createRef<ProteinSequenceWebGLOverlayHandle>();
    s.residueSelectionsStore.set([
      translatedCdsSelection({ residueIndex: 5, start: 115, end: 117 }),
    ]);

    const { result } = renderHook(() =>
      useProteinSequenceWebGLOverlaySync({
        entityId: FILE_PATH,
        ...s,
        targetRef,
        enabled: true,
      })
    );

    const setSelectedCodons = vi.fn();
    const handle = { setSelectedCodons };
    targetRef.current = handle;
    act(() => result.current(handle));

    expect(setSelectedCodons).toHaveBeenCalledOnce();
    expect(setSelectedCodons).toHaveBeenCalledWith([{ start: 115, end: 117, strand: 1 }]);
  });
});
