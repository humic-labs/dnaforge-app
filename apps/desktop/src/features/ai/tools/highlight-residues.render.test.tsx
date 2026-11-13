// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('molstar/lib/mol-script/script', async (importOriginal) => {
  const actual = await importOriginal<typeof import('molstar/lib/mol-script/script')>();
  return {
    ...actual,
    Script: {
      ...actual.Script,
      getStructureSelection: vi.fn(() => ({ kind: 'selection' })),
    },
  };
});
vi.mock('molstar/lib/mol-model/structure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('molstar/lib/mol-model/structure')>();
  return {
    ...actual,
    StructureSelection: {
      ...actual.StructureSelection,
      toLociWithSourceUnits: vi.fn(() => ({ kind: 'element-loci' })),
    },
  };
});
vi.mock('molstar/lib/mol-model/loci', async (importOriginal) => {
  const actual = await importOriginal<typeof import('molstar/lib/mol-model/loci')>();
  return {
    ...actual,
    Loci: {
      ...actual.Loci,
      isEmpty: vi.fn(() => false),
    },
  };
});

import { Script } from 'molstar/lib/mol-script/script';
import { useStructure3dStore } from '../../page/embeds/structure3d/store';
import { useResidueHighlight } from '../../page/embeds/structure3d/hooks/useResidueHighlight';
import { createHighlightResiduesTool } from './highlight-residues';
import { execTool } from './test-helpers';

describe('highlight_residues → Mol* paint (L1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStructure3dStore.setState({
      expandedStructures: {},
      interactionState: {},
      selectionAnchor: {},
      selectionRangeBase: {},
    });
    useStructure3dStore.getState().registerStructure(
      'structure:1FS0',
      { source: 'file', sourceId: '1FS0', label: '1FS0' },
      '1FS0'
    );
  });

  it('executes the real tool, updates attrs, and makes the existing highlight hook select loci', async () => {
    const plugin = {
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ cell: { obj: { data: { kind: 'structure-data' } } } }],
            },
          },
          selection: {
            elementCount: vi.fn(() => 15),
            stats: { label: '15 elements' },
          },
        },
        interactivity: {
          lociHighlights: { clearHighlights: vi.fn(), highlight: vi.fn() },
          lociSelects: { deselectAll: vi.fn(), select: vi.fn() },
        },
      },
    };
    renderHook(() => {
      const groups = useStructure3dStore(
        (state) => state.expandedStructures['structure:1FS0']?.data.highlightGroups
      );
      useResidueHighlight(plugin, { hovered: null, selected: [] }, true, groups);
    });

    const tool = createHighlightResiduesTool({
      getStructureState: async () => ({
        ok: true,
        structures: [
          {
            structureId: 'structure:1FS0',
            viewerId: 'viewer:1FS0',
            viewerStatus: 'active',
            chains: [
              {
                chainId: 'G',
                baseChain: 'G',
                operator: null,
                residueRanges: [{ start: 19, end: 248 }],
              },
            ],
          },
        ],
      }),
    });
    await act(async () => {
      await execTool(tool, {
        structureRef: 'structure:1FS0',
        chain: 'G',
        regions: [
          { start: 57, end: 57 },
          { start: 102, end: 102 },
          { start: 195, end: 195 },
        ],
      });
    });

    await waitFor(() => {
      expect(Script.getStructureSelection).toHaveBeenCalled();
      expect(plugin.managers.interactivity.lociSelects.select).toHaveBeenCalledTimes(1);
      expect(
        (window as typeof window & { __WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__?: any })
          .__WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__?.last
      ).toMatchObject({
        savedGroupCount: 1,
        applied: { saved: true, selected: false },
        readback: { elementCount: 15, statsLabel: '15 elements' },
      });
    });
  });

  it('carries compId into the saved MolScript expression for an exact ligand match', async () => {
    const plugin = {
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ cell: { obj: { data: { kind: 'structure-data' } } } }],
            },
          },
          selection: { elementCount: vi.fn(() => 1), stats: { label: '1 element' } },
        },
        interactivity: {
          lociHighlights: { clearHighlights: vi.fn(), highlight: vi.fn() },
          lociSelects: { deselectAll: vi.fn(), select: vi.fn() },
        },
      },
    };
    renderHook(() => {
      const groups = useStructure3dStore(
        (state) => state.expandedStructures['structure:1FS0']?.data.highlightGroups
      );
      useResidueHighlight(plugin, { hovered: null, selected: [] }, true, groups);
    });
    const tool = createHighlightResiduesTool({
      getStructureState: async () => ({
        ok: true,
        structures: [
          {
            structureId: 'structure:1FS0',
            viewerId: 'viewer:1FS0',
            viewerStatus: 'active',
            chains: [],
            ligands: [
              { name: 'ATP', chainId: 'A', position: 601, atomCount: 31 },
            ],
          },
        ],
      }),
    });

    await act(async () => {
      await execTool(tool, {
        structureRef: 'structure:1FS0',
        chain: 'A',
        compId: 'ATP',
        regions: [{ start: 601, end: 601 }],
      });
    });

    await waitFor(() => expect(Script.getStructureSelection).toHaveBeenCalled());
    const expression = vi.mocked(Script.getStructureSelection).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(expression)).toContain('label_comp_id');
    expect(JSON.stringify(expression)).toContain('ATP');
  });
});
