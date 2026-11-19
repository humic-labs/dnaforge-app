import { highlightResiduesOutputSchema } from './protein-output-schemas';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { beforeEach, describe, expect, it } from 'vitest';

import { useStructure3dStore } from '../../page/embeds/structure3d/store';
import type { Structure3dAttrs } from '../../page/embeds/structure3d/types';
import { createHighlightResiduesTool } from './highlight-residues';
import { execTool as executeTool } from './test-helpers';

type RuntimeState = {
  ok: true;
  structures: Array<{
    registrationId?: string;
    structureId: string;
    structureViewId?: string;
    bindingId?: string | null;
    viewerId: string;
    viewerStatus: 'active' | 'inactive' | 'loading' | 'error';
    chains: Array<{
      chainId: string;
      baseChain: string | null;
      labelAsymId?: string | null;
      authAsymId?: string | null;
      entityId?: string | null;
      operator: string | null;
      residueRanges: Array<{ start: number; end: number }>;
    }>;
    ligands?: Array<{
      name: string;
      chainId: string;
      position: number;
      atomCount: number;
      baseChain?: string;
      labelAsymId?: string;
      authAsymId?: string;
      entityId?: string;
      operator?: string;
    }>;
  }>;
};

const ACTIVE_STATE: RuntimeState = {
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
          labelAsymId: 'G',
          authAsymId: 'G',
          operator: null,
          residueRanges: [
            { start: 19, end: 58 },
            { start: 63, end: 192 },
            { start: 200, end: 248 },
          ],
        },
      ],
      ligands: [],
    },
  ],
};

type HighlightResiduesResult =
  | {
      ok: true;
      highlighted: true;
      structureRef: string;
      structureId: string;
      structureViewId?: string | null;
      bindingId?: string | null;
      viewerId: string;
      residueCount: number;
      selections: Array<{ chain: string; regions: Array<{ start: number; end: number }> }>;
    }
  | {
      ok: false;
      highlighted: false;
      code: string;
      reason: string;
      retriable: boolean;
    };

function registerStructure(id = 'structure:1FS0'): void {
  const attrs: Structure3dAttrs = {
    source: 'file',
    sourceId: '1FS0',
    label: '1FS0',
  };
  useStructure3dStore.getState().registerStructure(id, attrs, '1FS0');
}

beforeEach(() => {
  useStructure3dStore.setState({
    expandedStructures: {},
    interactionState: {},
    selectionAnchor: {},
    selectionRangeBase: {},
  });
});

describe('highlight_residues tool', () => {
  it('writes three exact disjoint auth_seq_id ranges without min/max collapse', async () => {
    registerStructure();
    const tool = createHighlightResiduesTool({
      getStructureState: async () => ACTIVE_STATE,
    });

    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'structure:1FS0',
      chain: 'G',
      regions: [
        { start: 57, end: 57 },
        { start: 102, end: 102 },
        { start: 190, end: 192 },
      ],
      label: 'Catalytic residues',
      color: '#ff6699',
    });

    expect(result).toMatchObject({
      ok: true,
      highlighted: true,
      structureRef: 'structure:1FS0',
      structureId: 'structure:1FS0',
      viewerId: 'viewer:1FS0',
      residueCount: 5,
    });
    const groups =
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups;
    expect(groups).toEqual([
      {
        id: 'agent-highlight:structure:1FS0',
        label: 'Catalytic residues',
        color: '#ff6699',
        visible: true,
        selections: [
          {
            chain: 'G',
            ranges: [
              [57, 57],
              [102, 102],
              [190, 192],
            ],
          },
        ],
      },
    ]);
    expect(groups?.[0]?.selections[0]?.ranges).not.toContainEqual([57, 192]);
  });

  it('supports multiple scoped chains through one stable top-level object schema', async () => {
    registerStructure();
    const state: RuntimeState = {
      ...ACTIVE_STATE,
      structures: [
        {
          ...ACTIVE_STATE.structures[0],
          chains: [
            ...ACTIVE_STATE.structures[0].chains,
            {
              chainId: 'E',
              baseChain: 'E',
              labelAsymId: 'E',
              authAsymId: 'E',
              operator: null,
              residueRanges: [{ start: 1, end: 134 }],
            },
          ],
        },
      ],
    };
    const tool = createHighlightResiduesTool({ getStructureState: async () => state });

    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'viewer:1FS0',
      selections: [
        { chain: 'G', authAsymId: 'G', regions: [{ start: 57, end: 57 }] },
        { chain: 'E', authAsymId: 'E', regions: [{ start: 10, end: 12 }] },
      ],
    });

    expect(result.ok).toBe(true);
    const selections =
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups?.[0]
        ?.selections;
    expect(selections).toEqual([
      { chain: 'G', authAsymId: 'G', ranges: [[57, 57]] },
      { chain: 'E', authAsymId: 'E', ranges: [[10, 12]] },
    ]);
  });

  it('targets one owner-specific logical view by binding id without mutating its coordinate twin', async () => {
    registerStructure('view:a');
    registerStructure('view:b');
    const state: RuntimeState = {
      ok: true,
      structures: [
        {
          ...ACTIVE_STATE.structures[0],
          registrationId: 'view:b',
          structureViewId: 'view:b',
          bindingId: 'binding:b',
        },
      ],
    };
    const calls: unknown[] = [];
    const tool = createHighlightResiduesTool({
      getStructureState: async (input) => {
        calls.push(input);
        return state;
      },
    });

    const result = await execTool<HighlightResiduesResult>(tool, {
      bindingId: 'binding:b',
      chain: 'G',
      regions: [{ start: 57, end: 57 }],
    });

    expect(calls).toEqual([{ bindingId: 'binding:b', detail: 'full' }]);
    expect(result).toMatchObject({
      ok: true,
      structureRef: 'binding:b',
      structureViewId: 'view:b',
      bindingId: 'binding:b',
    });
    expect(
      useStructure3dStore.getState().expandedStructures['view:a']?.data.highlightGroups
    ).toBeUndefined();
    expect(
      useStructure3dStore.getState().expandedStructures['view:b']?.data.highlightGroups
    ).toEqual([expect.objectContaining({ id: 'agent-highlight:binding:b' })]);
  });

  it('validates and stores an exact ligand-only selection by compId', async () => {
    registerStructure('structure:ligand-only');
    const state: RuntimeState = {
      ok: true,
      structures: [
        {
          structureId: 'structure:ligand-only',
          viewerId: 'viewer:ligand-only',
          viewerStatus: 'active',
          chains: [],
          ligands: [
            {
              name: 'ATP',
              chainId: 'A',
              position: 601,
              atomCount: 31,
              labelAsymId: 'L',
              authAsymId: 'A',
              entityId: '7',
            },
          ],
        },
      ],
    };
    const tool = createHighlightResiduesTool({ getStructureState: async () => state });

    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'viewer:ligand-only',
      chain: 'A',
      compId: 'ATP',
      regions: [{ start: 601, end: 601 }],
    });

    expect(result).toMatchObject({
      ok: true,
      highlighted: true,
      residueCount: 1,
      selections: [{ chain: 'A', compId: 'ATP', regions: [{ start: 601, end: 601 }] }],
    });
    expect(
      useStructure3dStore.getState().expandedStructures['structure:ligand-only']?.data
        .highlightGroups
    ).toEqual([
      expect.objectContaining({
        selections: [{ chain: 'A', compId: 'ATP', ranges: [[601, 601]] }],
      }),
    ]);
  });

  it('rejects a ligand selection when compId does not exist at the requested position', async () => {
    registerStructure('structure:ligand-only');
    const tool = createHighlightResiduesTool({
      getStructureState: async () => ({
        ok: true,
        structures: [
          {
            structureId: 'structure:ligand-only',
            viewerId: 'viewer:ligand-only',
            viewerStatus: 'active',
            chains: [],
            ligands: [{ name: 'ATP', chainId: 'A', position: 601, atomCount: 31 }],
          },
        ],
      }),
    });

    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'structure:ligand-only',
      chain: 'A',
      compId: 'ADP',
      regions: [{ start: 601, end: 601 }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'STALE_SELECTION',
      staleSelections: [{ chain: 'A', compId: 'ADP', regions: [{ start: 601, end: 601 }] }],
    });
  });

  it('returns no-structure instead of a successful no-op', async () => {
    const tool = createHighlightResiduesTool({
      getStructureState: async () => ({ ok: true, structures: [] }),
    });
    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'missing',
      chain: 'G',
      regions: [{ start: 57, end: 57 }],
    });

    expect(result).toEqual({
      ok: false,
      highlighted: false,
      code: 'NO_STRUCTURE',
      error: 'Residue highlighting failed: no-structure.',
      stateChanged: false,
      partialEffects: [],
      reason: 'no-structure',
      retriable: true,
      structureRef: 'missing',
    });
  });

  it('returns structure-not-ready while the live viewer is loading', async () => {
    registerStructure();
    const tool = createHighlightResiduesTool({
      getStructureState: async () => ({
        ...ACTIVE_STATE,
        structures: [{ ...ACTIVE_STATE.structures[0], viewerStatus: 'loading', chains: [] }],
      }),
    });
    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'structure:1FS0',
      chain: 'G',
      regions: [{ start: 57, end: 57 }],
    });

    expect(result).toMatchObject({
      ok: false,
      highlighted: false,
      code: 'STRUCTURE_NOT_READY',
      reason: 'structure-not-ready',
      retriable: true,
    });
  });

  it('returns stale-selection when any requested auth_seq_id is absent from the model', async () => {
    registerStructure();
    const tool = createHighlightResiduesTool({ getStructureState: async () => ACTIVE_STATE });
    const result = await execTool<HighlightResiduesResult>(tool, {
      structureRef: 'structure:1FS0',
      chain: 'G',
      regions: [
        { start: 57, end: 57 },
        { start: 59, end: 62 },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      highlighted: false,
      code: 'STALE_SELECTION',
      reason: 'stale-selection',
      retriable: false,
      staleSelections: [{ chain: 'G', regions: [{ start: 59, end: 62 }] }],
    });
    expect(
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups
    ).toBeUndefined();
  });

  it('clears the one-shot agent group on the next explicit residue-selection gesture', async () => {
    registerStructure();
    const tool = createHighlightResiduesTool({ getStructureState: async () => ACTIVE_STATE });
    await execTool(tool, {
      structureRef: 'structure:1FS0',
      chain: 'G',
      regions: [{ start: 57, end: 57 }],
    });

    useStructure3dStore
      .getState()
      .setSelected('structure:1FS0', [{ chain: 'G', authAsymId: 'G', position: 102 }]);

    expect(
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups
    ).toEqual([]);
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(highlightResiduesOutputSchema, result);
  return result;
}
