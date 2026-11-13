// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStructure3dStore } from '../store';
import { AGENT_HIGHLIGHT_GROUP_ID_PREFIX, type ResidueLocation } from '../types';
import { useSelectionActions } from './useSelectionActions';
import { useResetSelectionOnViewChange } from './useResetSelectionOnViewChange';

const STRUCTURE_ID = 'structure:test';
const RESIDUE: ResidueLocation = {
  chain: 'A',
  position: 42,
  labelAsymId: 'A',
  authAsymId: 'A',
};

function resetStructureStore() {
  useStructure3dStore.setState({
    expandedStructures: {},
    interactionState: {},
    selectionAnchor: {},
    selectionRangeBase: {},
  });
}

function createPlugin() {
  return {
    managers: {
      interactivity: { lociSelects: { deselectAll: vi.fn() } },
      structure: {
        focus: {
          clear: vi.fn(),
        },
      },
    },
    canvas3d: {
      requestCameraReset: vi.fn(),
    },
  };
}

describe('useSelectionActions', () => {
  it('clears selection when the first scene belongs to a different source', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ scene, source }) => useResetSelectionOnViewChange(scene, 0, null, source, clear),
      { initialProps: { scene: undefined as string | undefined, source: STRUCTURE_ID } }
    );
    rerender({ scene: 'initial-scene', source: 'structure:other' });
    expect(clear).toHaveBeenCalledOnce();
  });
  it('preserves selection when the first authored scene attaches, then clears it for a replacement view', () => {
    resetStructureStore();
    const plugin = createPlugin();
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    const { rerender } = renderHook(
      ({ scene, index, recipe }) => {
        const actions = useSelectionActions({
          plugin,
          structureId: STRUCTURE_ID,
          selectedResidues: [RESIDUE],
          highlightGroups: [],
        });
        useResetSelectionOnViewChange(
          scene,
          index,
          recipe,
          STRUCTURE_ID,
          actions.handleClearSelection
        );
      },
      {
        initialProps: {
          scene: undefined as string | undefined,
          index: undefined as number | undefined,
          recipe: 'query-in-complex' as string | null,
        },
      }
    );
    rerender({ scene: 'initial-scene', index: 0, recipe: null });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
      RESIDUE,
    ]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).not.toHaveBeenCalled();
    rerender({ scene: 'replacement-scene', index: 0, recipe: null });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledOnce();
  });
  it('preserves the incoming selection through initial view registration and authoring', () => {
    resetStructureStore();
    const plugin = createPlugin();
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    const { rerender } = renderHook(
      ({
        scene,
        recipe,
        ready,
      }: {
        scene: string | undefined;
        recipe: string | null;
        ready: boolean;
      }) => {
        const actions = useSelectionActions({
          plugin,
          structureId: STRUCTURE_ID,
          selectedResidues: [RESIDUE],
          highlightGroups: [],
        });
        useResetSelectionOnViewChange(
          scene,
          0,
          recipe,
          STRUCTURE_ID,
          actions.handleClearSelection,
          ready
        );
      },
      { initialProps: { scene: undefined, recipe: null, ready: false } }
    );
    rerender({ scene: undefined, recipe: 'cartoon', ready: false });
    rerender({ scene: 'initial authored scene', recipe: null, ready: true });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
      RESIDUE,
    ]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).not.toHaveBeenCalled();
    rerender({ scene: 'another view', recipe: null, ready: true });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledOnce();
  });

  it('clears both app and native selection when the named view changes, preserving the initial attachment', () => {
    resetStructureStore();
    const plugin = createPlugin();
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    const { rerender } = renderHook(
      ({ index }) => {
        const actions = useSelectionActions({
          plugin,
          structureId: STRUCTURE_ID,
          selectedResidues: [RESIDUE],
          highlightGroups: [],
        });
        useResetSelectionOnViewChange(
          'saved-story',
          index,
          null,
          STRUCTURE_ID,
          actions.handleClearSelection
        );
      },
      { initialProps: { index: 0 } }
    );
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
      RESIDUE,
    ]);
    rerender({ index: 1 });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledOnce();
    expect(plugin.canvas3d.requestCameraReset).not.toHaveBeenCalled();
  });
  afterEach(() => {
    resetStructureStore();
    vi.restoreAllMocks();
  });

  it('keeps the selection while the native scene is captured or cleared, and clears it for a different scene ', () => {
    resetStructureStore();
    const plugin = createPlugin();
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    const { rerender } = renderHook(
      ({ scene, index }: { scene?: string; index?: number }) => {
        const actions = useSelectionActions({
          plugin,
          structureId: STRUCTURE_ID,
          selectedResidues: [RESIDUE],
          highlightGroups: [],
        });
        useResetSelectionOnViewChange(
          scene,
          index,
          'cartoon',
          STRUCTURE_ID,
          actions.handleClearUserSelection
        );
      },
      { initialProps: {} }
    );
    const selected = () => useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected;
    rerender({ scene: 'captured-scene', index: 0 });
    rerender({});
    rerender({ scene: 'captured-scene', index: 0 });
    expect(selected()).toEqual([RESIDUE]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).not.toHaveBeenCalled();
    rerender({ scene: 'different-scene', index: 0 });
    expect(selected()).toEqual([]);
  });

  it('keeps the agent highlight when a view change clears the user selection ', () => {
    resetStructureStore();
    const plugin = createPlugin();
    const agentHighlight = {
      id: `${AGENT_HIGHLIGHT_GROUP_ID_PREFIX}${STRUCTURE_ID}`,
      label: 'Agent highlight',
      color: '#ff6699',
      visible: true,
      selections: [{ chain: 'A', ranges: [[57, 57] as [number, number]] }],
    };
    useStructure3dStore.getState().registerStructure(
      STRUCTURE_ID,
      {
        structureId: STRUCTURE_ID,
        source: 'alphafold',
        sourceId: 'P0AD86',
        label: 'thrL',
        highlightGroups: [agentHighlight],
      },
      'thrL'
    );
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
      ...useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data,
      highlightGroups: [agentHighlight],
    });
    const { rerender } = renderHook(
      ({ recipe }) => {
        const actions = useSelectionActions({
          plugin,
          structureId: STRUCTURE_ID,
          selectedResidues: [RESIDUE],
          highlightGroups: [],
        });
        useResetSelectionOnViewChange(
          undefined,
          undefined,
          recipe,
          STRUCTURE_ID,
          actions.handleClearUserSelection
        );
      },
      { initialProps: { recipe: 'cartoon' } }
    );
    rerender({ recipe: 'surface' });
    const state = useStructure3dStore.getState();
    expect(state.interactionState[STRUCTURE_ID]?.selected).toEqual([]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).not.toHaveBeenCalled();
    expect(state.expandedStructures[STRUCTURE_ID].data.highlightGroups).toEqual([agentHighlight]);
  });

  it('clears selection without resetting camera or clearing focus representation', () => {
    resetStructureStore();
    const plugin = createPlugin();
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    const { result } = renderHook(() =>
      useSelectionActions({
        plugin,
        structureId: STRUCTURE_ID,
        selectedResidues: [RESIDUE],
        highlightGroups: [],
      })
    );

    act(() => {
      result.current.handleClearSelection();
    });

    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([]);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledOnce();
    expect(plugin.managers.structure.focus.clear).not.toHaveBeenCalled();
    expect(plugin.canvas3d.requestCameraReset).not.toHaveBeenCalled();
  });

  it('resets camera and clears transient focus representation without clearing selection', () => {
    resetStructureStore();
    const plugin = createPlugin();
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [RESIDUE], RESIDUE);
    const { result } = renderHook(() =>
      useSelectionActions({
        plugin,
        structureId: STRUCTURE_ID,
        selectedResidues: [RESIDUE],
        highlightGroups: [],
      })
    );

    act(() => {
      result.current.handleResetCamera();
    });

    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
      RESIDUE,
    ]);
    expect(plugin.managers.structure.focus.clear).toHaveBeenCalledTimes(1);
    expect(plugin.canvas3d.requestCameraReset).toHaveBeenCalledWith({ durationMs: 250 });
  });
});
