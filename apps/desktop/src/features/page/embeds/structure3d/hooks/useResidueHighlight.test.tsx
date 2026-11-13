// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setSubtreeVisibility = vi.hoisted(() => vi.fn());

vi.mock('molstar/lib/mol-script/script', () => ({
  Script: {
    getStructureSelection: vi.fn(() => ({ kind: 'selection' })),
  },
}));

vi.mock('molstar/lib/mol-model/structure', () => ({
  StructureSelection: {
    toLociWithSourceUnits: vi.fn(() => ({ kind: 'element-loci' })),
  },
}));

vi.mock('molstar/lib/mol-model/loci', () => ({
  Loci: {
    isEmpty: vi.fn(() => false),
  },
}));

vi.mock('molstar/lib/mol-plugin/behavior/static/state', () => ({
  setSubtreeVisibility,
}));

import { Script } from 'molstar/lib/mol-script/script';
import { StructureSelection } from 'molstar/lib/mol-model/structure';
import type { ResidueInteractionState, ResidueLocation } from '../types';
import { notifyStructureSceneReplaced } from '../molstar/sceneReplacement';
import {
  applySavedHighlightOverlays,
  applySelectionSideChainOverlay,
  useResidueHighlight,
  useSelectionSideChainOverlay,
} from './useResidueHighlight';

function createPlugin() {
  return {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ cell: { obj: { data: { kind: 'structure-data' } } } }],
          },
        },
        selection: {
          elementCount: vi.fn(() => 42),
          has: vi.fn(() => true),
          stats: { label: '42 elements' },
        },
      },
      interactivity: {
        lociHighlights: {
          clearHighlights: vi.fn(),
          highlight: vi.fn(),
        },
        lociSelects: {
          deselectAll: vi.fn(),
          select: vi.fn(),
        },
      },
    },
  };
}

function createSelectionOverlayPlugin() {
  const deleteRef = vi.fn();
  const commit = vi.fn(async () => undefined);
  const component = {
    cell: {
      obj: { label: 'Active Selection Side Chains' },
      transform: { ref: 'selection-sidechains-ref' },
    },
  };
  return {
    __test: {
      deleteRef,
      commit,
      tryCreateComponentFromExpression: vi.fn(async () => component),
      addRepresentation: vi.fn(async () => undefined),
    },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: { kind: 'structure-data' } }, transform: { ref: 'root' } },
                components: [],
              },
            ],
          },
        },
      },
    },
    builders: {
      structure: {
        tryCreateComponentFromExpression: vi.fn(async () => component),
        representation: {
          addRepresentation: vi.fn(async () => undefined),
        },
      },
    },
    state: {
      data: {
        build: vi.fn(() => ({
          delete: deleteRef,
          commit,
        })),
      },
    },
  };
}

function createSelectionOverlayPluginWithRefs() {
  const deleteRef = vi.fn();
  const commit = vi.fn(async () => undefined);
  const addRepresentation = vi.fn(async () => undefined);
  const tryCreateComponentFromExpression = vi.fn(
    async (_structureRef: unknown, _expression: unknown, componentId: string) => ({
      cell: {
        obj: { label: 'Active Selection Side Chains' },
        transform: { ref: componentId },
      },
    })
  );
  return {
    __test: {
      deleteRef,
      commit,
      tryCreateComponentFromExpression,
      addRepresentation,
    },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: { kind: 'structure-data' } }, transform: { ref: 'root' } },
                components: [],
              },
            ],
          },
        },
      },
    },
    builders: {
      structure: {
        tryCreateComponentFromExpression,
        representation: {
          addRepresentation,
        },
      },
    },
    state: {
      data: {
        build: vi.fn(() => ({
          delete: deleteRef,
          commit,
        })),
      },
    },
  };
}

function interaction(hovered: ResidueLocation | null): ResidueInteractionState {
  return {
    hovered,
    selected: [],
  };
}

describe('useResidueHighlight hover scheduling', () => {
  it('reprojects the current selection after the native scene is replaced without another click', () => {
    const plugin = createPlugin();
    const selected = [{ chain: 'A', position: 108, compId: 'SER' }];
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useResidueHighlight(plugin, { selected, hovered: null }, enabled),
      { initialProps: { enabled: true } }
    );
    const select = plugin.managers.interactivity.lociSelects.select;
    select.mockClear();
    act(() => notifyStructureSceneReplaced(plugin));
    expect(select).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    select.mockClear();
    act(() => notifyStructureSceneReplaced(plugin));
    expect(select).not.toHaveBeenCalled();
    unmount();
    act(() => notifyStructureSceneReplaced(plugin));
    expect(select).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    setSubtreeVisibility.mockReset();
    delete (window as typeof window & { __WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__?: unknown })
      .__WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__;
    delete (
      window as typeof window & {
        __WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?: unknown;
      }
    ).__WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__;
  });

  it('coalesces rapid hover changes before doing MolStar loci work', () => {
    const raf = installManualRaf();
    const plugin = createPlugin();
    const residueOne = { chain: 'A', position: 1 };
    const residueTwo = { chain: 'A', position: 2 };

    const { rerender } = renderHook(({ state }) => useResidueHighlight(plugin, state, true), {
      initialProps: { state: interaction(residueOne) },
    });

    rerender({ state: interaction(residueTwo) });

    expect(Script.getStructureSelection).not.toHaveBeenCalled();
    expect(plugin.managers.interactivity.lociHighlights.highlight).not.toHaveBeenCalled();

    act(() => {
      raf.flush();
    });

    expect(Script.getStructureSelection).toHaveBeenCalledTimes(1);
    expect(StructureSelection.toLociWithSourceUnits).toHaveBeenCalledTimes(1);
    expect(plugin.managers.interactivity.lociHighlights.clearHighlights).toHaveBeenCalledTimes(1);
    expect(plugin.managers.interactivity.lociHighlights.highlight).toHaveBeenCalledTimes(1);
  });

  it('cancels pending MolStar hover work on unmount', () => {
    const raf = installManualRaf();
    const plugin = createPlugin();

    const { unmount } = renderHook(() =>
      useResidueHighlight(plugin, interaction({ chain: 'A', position: 1 }), true)
    );

    unmount();

    act(() => {
      raf.flush();
    });

    expect(Script.getStructureSelection).not.toHaveBeenCalled();
    expect(plugin.managers.interactivity.lociHighlights.highlight).not.toHaveBeenCalled();
  });

  it('records when active residue selections are applied to MolStar lociSelects', async () => {
    const plugin = createPlugin();
    const selectedResidue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };

    renderHook(() =>
      useResidueHighlight(
        plugin,
        {
          hovered: null,
          selected: [selectedResidue],
        },
        true
      )
    );

    await waitFor(() => {
      expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalled();
      expect(plugin.managers.interactivity.lociSelects.select).toHaveBeenCalled();
      expect(
        (window as typeof window & { __WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__?: any })
          .__WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__?.last
      ).toMatchObject({
        selectedResidues: [selectedResidue],
        selectedCount: 1,
        savedGroupCount: 0,
        applied: { saved: false, selected: true },
        readback: {
          elementCount: 42,
          statsLabel: '42 elements',
          hasInteractiveSelection: true,
        },
      });
    });
  });

  it('restores a clickable reference group through MolStar native selection', async () => {
    const plugin = createPlugin();

    renderHook(() =>
      useResidueHighlight(plugin, interaction(null), true, [
        {
          id: 'agent-reference-selection',
          label: 'Three exact residues',
          renderMode: 'selection',
          selections: [
            {
              chain: 'A',
              authAsymId: 'A',
              ranges: [
                [57, 57],
                [102, 102],
                [195, 195],
              ],
            },
          ],
        },
      ])
    );

    await waitFor(() => {
      expect(plugin.managers.interactivity.lociSelects.select).toHaveBeenCalledTimes(1);
    });
  });

  it('creates a removable side-chain component for the active selection object', async () => {
    const plugin = createSelectionOverlayPlugin();
    const residue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };

    await applySelectionSideChainOverlay(plugin, [residue], true);

    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringMatching(/^waypoint-active-selection-side-chains-/),
      { label: 'Active Selection Side Chains' }
    );
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      'selection-sidechains-ref',
      expect.objectContaining({
        type: 'ball-and-stick',
        typeParams: expect.objectContaining({ alpha: 1, sizeFactor: 0.14 }),
        color: 'element-symbol',
      }),
      { tag: 'waypoint.structure3d.selection-side-chains.detail' }
    );
    expect(
      (window as typeof window & { __WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?: any })
        .__WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?.last
    ).toMatchObject({
      enabled: true,
      selectedCount: 1,
      created: true,
      reason: 'created',
    });
  });

  it('renders saved groups as colored components without putting them in native lime selection', async () => {
    const plugin = createSelectionOverlayPluginWithRefs();

    await applySavedHighlightOverlays(plugin, [
      {
        id: 'saved-selection-1',
        label: 'Catalytic residues',
        color: '#ef4444',
        visible: true,
        selections: [{ chain: 'A', labelAsymId: 'A', ranges: [[86, 109]] }],
      },
    ]);

    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringMatching(/^waypoint-saved-selection-/),
      { label: expect.stringContaining('Saved Selection:') }
    );
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledWith(
      expect.stringMatching(/^waypoint-saved-selection-/),
      expect.objectContaining({
        type: 'ball-and-stick',
        color: 'uniform',
        colorParams: { value: 0xef4444 },
      }),
      { tag: 'waypoint.structure3d.saved-selection' }
    );
  });

  it('deletes a stale side-chain component when overlay work is cancelled after component creation', async () => {
    const plugin = createSelectionOverlayPlugin();
    const residue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };
    const isCancelled = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    await applySelectionSideChainOverlay(plugin, [residue], true, isCancelled);

    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalled();
    expect(plugin.builders.structure.representation.addRepresentation).not.toHaveBeenCalled();
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('selection-sidechains-ref');
    expect(plugin.__test.commit).toHaveBeenCalled();
    expect(
      (window as typeof window & { __WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?: any })
        .__WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?.last
    ).toMatchObject({
      enabled: true,
      selectedCount: 1,
      created: false,
      reason: 'cancelled-after-component-create',
    });
  });

  it('does not recreate the side-chain overlay when the selected residue identity is unchanged', async () => {
    const plugin = createSelectionOverlayPluginWithRefs();
    const residue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };

    const { rerender } = renderHook(
      ({ selected }) => useSelectionSideChainOverlay(plugin, selected, true),
      {
        initialProps: { selected: [residue] },
      }
    );

    await waitFor(() => {
      expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledTimes(1);
    });

    rerender({ selected: [{ ...residue }] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledTimes(1);
  });

  it('reuses the side-chain overlay when the same exact residue set is reordered', async () => {
    const plugin = createSelectionOverlayPluginWithRefs();
    const first = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };
    const second = { chain: 'A', position: 9, authAsymId: 'A', labelAsymId: 'A' };

    const { rerender } = renderHook(
      ({ selected }) => useSelectionSideChainOverlay(plugin, selected, true),
      {
        initialProps: { selected: [first, second] },
      }
    );
    await waitFor(() => {
      expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledTimes(1);
    });

    rerender({ selected: [second, first] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledTimes(1);
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledTimes(1);
    expect(plugin.__test.deleteRef).not.toHaveBeenCalled();
  });

  it('hides and restores the same side-chain overlay without rebuilding MolStar state', async () => {
    const plugin = createSelectionOverlayPluginWithRefs();
    const residue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };

    await applySelectionSideChainOverlay(plugin, [residue], true);
    const componentRef =
      plugin.builders.structure.representation.addRepresentation.mock.calls[0]?.[0];

    await applySelectionSideChainOverlay(plugin, [residue], false);
    await applySelectionSideChainOverlay(plugin, [residue], true);

    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledTimes(1);
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledTimes(1);
    expect(plugin.__test.deleteRef).not.toHaveBeenCalled();
    expect(setSubtreeVisibility.mock.calls).toEqual([
      [plugin.state.data, componentRef, true],
      [plugin.state.data, componentRef, false],
    ]);
    expect(
      (window as typeof window & { __WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?: any })
        .__WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?.events
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'hide',
          reused: true,
          componentRef,
        }),
        expect.objectContaining({
          operation: 'show',
          reused: true,
          componentRef,
        }),
      ])
    );
  });

  it('builds one replacement for a changed selection and deletes only the superseded component', async () => {
    const plugin = createSelectionOverlayPluginWithRefs();
    const residue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };

    await applySelectionSideChainOverlay(plugin, [residue], true);
    const firstRef = plugin.builders.structure.representation.addRepresentation.mock.calls[0]?.[0];
    await applySelectionSideChainOverlay(plugin, [{ ...residue, position: 4 }], true);
    const secondRef = plugin.builders.structure.representation.addRepresentation.mock.calls[1]?.[0];

    expect(firstRef).toEqual(expect.stringMatching(/^waypoint-active-selection-side-chains-/));
    expect(secondRef).toEqual(expect.stringMatching(/^waypoint-active-selection-side-chains-/));
    expect(secondRef).not.toBe(firstRef);
    expect(plugin.builders.structure.tryCreateComponentFromExpression).toHaveBeenCalledTimes(2);
    expect(plugin.builders.structure.representation.addRepresentation).toHaveBeenCalledTimes(2);
    expect(plugin.__test.deleteRef).toHaveBeenCalledTimes(1);
    expect(plugin.__test.deleteRef).toHaveBeenCalledWith(firstRef);
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith(secondRef);
  });

  it('does not let a cancelled stale side-chain overlay delete the newer overlay ref', async () => {
    const plugin = createSelectionOverlayPluginWithRefs();
    const residue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };
    let resolveFirst:
      | ((component: { cell: { obj: { label: string }; transform: { ref: string } } }) => void)
      | null = null;
    plugin.builders.structure.tryCreateComponentFromExpression.mockImplementationOnce(
      async (_structureRef: unknown, _expression: unknown, componentId: string) =>
        new Promise((resolve) => {
          resolveFirst = resolve;
          void componentId;
        })
    );

    let firstCancelled = false;
    const first = applySelectionSideChainOverlay(plugin, [residue], true, () => firstCancelled);
    await act(async () => {
      await Promise.resolve();
    });

    firstCancelled = true;
    await applySelectionSideChainOverlay(plugin, [{ ...residue, position: 4 }], true);
    const newerRef = plugin.builders.structure.representation.addRepresentation.mock.calls[0]?.[0];
    expect(newerRef).toEqual(expect.stringMatching(/^waypoint-active-selection-side-chains-/));

    resolveFirst?.({
      cell: {
        obj: { label: 'Active Selection Side Chains' },
        transform: { ref: 'stale-sidechain-ref' },
      },
    });
    await first;

    expect(plugin.__test.deleteRef).toHaveBeenCalledWith('stale-sidechain-ref');
    expect(plugin.__test.deleteRef).not.toHaveBeenCalledWith(newerRef);
  });

  it('reapplies the same active selection when the MolStar plugin instance changes', async () => {
    const pluginA = createPlugin();
    const pluginB = createPlugin();
    const selectedResidue = { chain: 'A', position: 3, authAsymId: 'A', labelAsymId: 'A' };

    const { rerender } = renderHook(
      ({ plugin }) =>
        useResidueHighlight(
          plugin,
          {
            hovered: null,
            selected: [selectedResidue],
          },
          true
        ),
      {
        initialProps: { plugin: pluginA },
      }
    );

    await waitFor(() => {
      expect(pluginA.managers.interactivity.lociSelects.select).toHaveBeenCalledTimes(1);
    });

    rerender({ plugin: pluginB });

    await waitFor(() => {
      expect(pluginB.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledTimes(1);
      expect(pluginB.managers.interactivity.lociSelects.select).toHaveBeenCalledTimes(1);
    });
  });

  it('treats mmCIF scope fields as part of residue identity for selected loci', async () => {
    const plugin = createPlugin();
    const firstSelection = {
      chain: 'A',
      position: 3,
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'F',
      entityId: '1',
      operator: 'ASM_1',
    };
    const secondSelection = {
      ...firstSelection,
      authAsymId: 'G',
    };

    const { rerender } = renderHook(
      ({ selected }) =>
        useResidueHighlight(
          plugin,
          {
            hovered: null,
            selected,
          },
          true
        ),
      {
        initialProps: { selected: [firstSelection] },
      }
    );

    await waitFor(() => {
      expect(plugin.managers.interactivity.lociSelects.select).toHaveBeenCalledTimes(1);
    });

    rerender({ selected: [secondSelection] });

    await waitFor(() => {
      expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledTimes(2);
      expect(plugin.managers.interactivity.lociSelects.select).toHaveBeenCalledTimes(2);
    });
  });
});

function installManualRaf() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id);
  });

  return {
    flush() {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, callback] of pending) {
        callback(performance.now());
      }
    },
  };
}
