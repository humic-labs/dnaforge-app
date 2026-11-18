/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Structure3dPanel } from './Structure3dPanel';
import { useStructure3dStore } from '../store';
import type { ResidueLocation, Structure3dAttrs, StructureSelectionGesture } from '../types';
import { useViewerSettings } from '../hooks';
import {
  HoveredCodonProvider,
  createHoveredCodonStore,
  ResidueSelectionsProvider,
  createResidueSelectionsStore,
  residueSelectionsToCodingDnaRanges,
  type ResidueSelection,
} from '@waypoint/workspace-editor';
import { registerWorkspaceResidueSelectionsStore } from '../../../../structure-drawer/state/selected-codon-registry';
import { useStructureLinkRegistry } from '../../../../structure-drawer/state/use-structure-link-registry';
import { useStructureResidueSessionRegistry } from '../../../../structure-drawer/state/structure-residue-session-registry';

import {
  HoveredResidueProvider,
  createHoveredResidueStore,
} from '../../../../structure-drawer/public/state/hovered-residue-store';
import { useSequenceCodonResidueBridge } from '../../../../structure-drawer/public/hooks/useSequenceCodonResidueBridge';
import { isApplePlatform } from '@waypoint/ui-components/keyboard';

const STRUCTURE_ID = 'structure:alphafold:P0AD86:all';

const hookMocks = vi.hoisted(() => ({
  latestMolstarOptions: null as null | {
    onHover?: (
      residue: {
        chain: string;
        position: number;
        baseChain?: string;
        labelAsymId?: string;
        authAsymId?: string;
        entityId?: string;
        compId?: string;
        operator?: string;
      } | null
    ) => void;
    onClick?: (
      residue: {
        chain: string;
        position: number;
        baseChain?: string;
        labelAsymId?: string;
        authAsymId?: string;
        entityId?: string;
        compId?: string;
        operator?: string;
      },
      gesture: StructureSelectionGesture
    ) => void;
    onBlankPrimaryClick?: () => void;
  },
  latestClickDetectionOptions: null as null | {
    onRightClick?: (position: { x: number; y: number; target: EventTarget | null }) => void;
    onBlankPrimaryCanvasClick?: () => void;
    classifyPrimaryCanvasClick?: (event: {
      target: EventTarget | null;
      clientX: number;
      clientY: number;
    }) => 'empty' | 'non-empty' | 'unknown';
  },
  latestCameraChange: null as null | ((snapshot: string) => void),
  molstarMounts: 0,
  molstarUnmounts: 0,
  handleResidueSelect: vi.fn(),
  handleResiduesSelect: vi.fn(),
  handleResetCamera: vi.fn(),
  canvasPointerDown: vi.fn(),
  handleClearSelection: vi.fn(),
  handleClearUserSelection: vi.fn(),
  useResidueHighlight: vi.fn(),
  useSelectionSideChainOverlay: vi.fn(),
  useMolstarInteraction: vi.fn(),
  useSelectionActions: vi.fn(),
  sequenceData: {
    chains: [
      {
        chainId: 'A',
        chainLabel: 'Chain A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        sequence: 'MKRI',
        residues: [
          { position: 1, name: 'M', name3: 'MET', value: 98 },
          { position: 2, name: 'K', name3: 'LYS', value: 96 },
          { position: 3, name: 'R', name3: 'ARG', value: 95 },
          { position: 4, name: 'I', name3: 'ILE', value: 92 },
        ],
      },
      {
        chainId: 'H',
        chainLabel: 'Chain H',
        baseChain: 'H',
        labelAsymId: 'H',
        authAsymId: 'B',
        entityId: '2',
        sequence: 'MKRI',
        residues: [
          { position: 1, name: 'M', name3: 'MET', value: 90 },
          { position: 2, name: 'K', name3: 'LYS', value: 88 },
          { position: 3, name: 'R', name3: 'ARG', value: 86 },
          { position: 4, name: 'I', name3: 'ILE', value: 84 },
        ],
      },
    ],
    ligands: [],
  },
}));

vi.mock('./MolViewSpecColorControls', () => ({
  MolViewSpecColorControls: ({
    plugin,
    scene,
    index,
    getLatestAttrs,
    updateAttrs,
  }: {
    plugin: unknown;
    scene: string;
    index: number;
    getLatestAttrs: () => unknown;
    updateAttrs: (updates: { molViewSpec: string; cameraSnapshot: string }) => void;
  }) => (
    <button
      aria-label="Color structure"
      data-scene={scene}
      data-index={index}
      disabled={!plugin}
      onClick={() => {
        if (getLatestAttrs())
          updateAttrs({ molViewSpec: 'changed-scene', cameraSnapshot: 'retained-camera' });
      }}
    >
      Recolor
    </button>
  ),
}));

vi.mock('../MolstarViewer', async () => {
  const React = await import('react');
  const plugin = { id: 'molstar-plugin-stub' };

  return {
    MolstarViewer: ({
      onPluginReady,
      onLoad,
      onCameraChange,
    }: {
      onPluginReady?: (plugin: unknown) => void;
      onLoad?: () => void;
      onCameraChange?: (snapshot: string) => void;
    }) => {
      hookMocks.latestCameraChange = onCameraChange ?? null;
      React.useEffect(() => {
        hookMocks.molstarMounts += 1;
        return () => {
          hookMocks.molstarUnmounts += 1;
        };
      }, []);

      React.useEffect(() => {
        onPluginReady?.(plugin);
        onLoad?.();
      }, [onLoad, onPluginReady]);

      return React.createElement(
        'div',
        { 'data-testid': 'molstar-viewer-stub' },
        React.createElement('canvas', { 'data-testid': 'test-structure-canvas' })
      );
    },
  };
});

vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks')>()),
  useSequenceData: vi.fn((_plugin: unknown, _colorMode: string, isLoaded: boolean) =>
    isLoaded ? hookMocks.sequenceData : null
  ),
  useResidueHighlight: hookMocks.useResidueHighlight,
  useSelectionSideChainOverlay: hookMocks.useSelectionSideChainOverlay,
  useMolstarInteraction: hookMocks.useMolstarInteraction.mockImplementation(
    (_plugin: unknown, options: unknown, enabled: boolean) => {
      if (enabled) {
        hookMocks.latestMolstarOptions = options as typeof hookMocks.latestMolstarOptions;
      }
    }
  ),
  useClickDetection: vi.fn((options: unknown) => {
    hookMocks.latestClickDetectionOptions = options as typeof hookMocks.latestClickDetectionOptions;
    return { onPointerDownCapture: hookMocks.canvasPointerDown };
  }),
  residueAtMolstarCanvasPoint: vi.fn(() => null),
  useHoveredResidueName: vi.fn(() => undefined),
  useHighlightActions: vi.fn(() => ({
    handleSaveSelection: vi.fn(),
    handleActivateHighlight: vi.fn(),
    handleDeleteHighlight: vi.fn(),
    handleRenameHighlight: vi.fn(),
  })),
  useSavedSelectionProjections: vi.fn(() => ({ groups: [], errors: [] })),
  useViewerSettings: vi.fn(() => ({
    handleColorModeChange: vi.fn(),
    handleShowWaterChange: vi.fn(),
    handleSpinChange: vi.fn(),
    handleAdvancedSettingsChange: vi.fn(),
  })),
  useSavedSelectionEdit: vi.fn(() => ({
    handleResidueSelect: hookMocks.handleResidueSelect,
    handleResiduesSelect: hookMocks.handleResiduesSelect,
  })),
  useFocusClick: vi.fn(() => vi.fn()),
  useSelectionActions: hookMocks.useSelectionActions.mockImplementation(() => ({
    handleClearSelection: hookMocks.handleClearSelection,
    handleClearUserSelection: hookMocks.handleClearUserSelection,
    handleResetCamera: hookMocks.handleResetCamera,
    handleCenterSelection: vi.fn(),
    createContextCenterHandler: vi.fn(() => vi.fn()),
  })),
}));

function resetStructureStore() {
  useStructure3dStore.setState({
    expandedStructures: {},
    interactionState: {},
    selectionAnchor: {},
    selectionRangeBase: {},
  });
}

function registerThrLStructure() {
  const attrs: Structure3dAttrs = {
    source: 'alphafold',
    sourceId: 'P0AD86',
    label: 'thrL',
    title: 'Thr operon leader peptide',
    colorMode: 'chain',
    showSequenceViewer: true,
    highlightGroups: [],
  };
  useStructure3dStore.getState().registerStructure(STRUCTURE_ID, attrs, 'thrL');
}

function registerScopedRcsbStructure(structureId: string) {
  const attrs: Structure3dAttrs = {
    source: 'pdb',
    sourceId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
    providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
    pdbId: '1RBL',
    authAsymIds: ['H'],
    label: '1RBL author chain H',
    title: 'Scoped author chain H',
    colorMode: 'chain',
    showSequenceViewer: true,
    highlightGroups: [],
  };
  useStructure3dStore.getState().registerStructure(structureId, attrs, '1RBL chain A');
}

function registerEntityScopedRcsbStructure(structureId: string) {
  const attrs: Structure3dAttrs = {
    source: 'pdb',
    sourceId: 'RCSB:1RBL:ENTRY:ENTITY:1',
    providerIdentityKey: 'RCSB:1RBL:ENTRY:ENTITY:1',
    pdbId: '1RBL',
    pdbEntityId: '1',
    label: '1RBL entity 1',
    title: 'Scoped entity 1',
    colorMode: 'chain',
    showSequenceViewer: true,
    highlightGroups: [],
  };
  useStructure3dStore.getState().registerStructure(structureId, attrs, '1RBL entity 1');
}

function latestLoadedHighlightState() {
  const calls = hookMocks.useResidueHighlight.mock.calls.filter(
    ([, , isLoaded]) => isLoaded === true
  );
  return calls.at(-1)?.[1] as { hovered: ResidueLocation | null; selected: ResidueLocation[] };
}

function latestViewerSettingsGetLatestAttrs() {
  const latestArgs = vi.mocked(useViewerSettings).mock.calls.at(-1)?.[0] as
    | { getLatestAttrs?: unknown }
    | undefined;
  return latestArgs?.getLatestAttrs;
}

beforeEach(() => {
  vi.clearAllMocks();
  hookMocks.latestMolstarOptions = null;
  hookMocks.latestClickDetectionOptions = null;
  hookMocks.latestCameraChange = null;
  hookMocks.molstarMounts = 0;
  hookMocks.molstarUnmounts = 0;
  hookMocks.handleResidueSelect.mockReset();
  hookMocks.handleResiduesSelect.mockReset();
  hookMocks.handleResetCamera.mockReset();
  hookMocks.useSelectionActions.mockClear();
  resetStructureStore();
  useStructureLinkRegistry.setState({ links: {} });
  useStructureResidueSessionRegistry.setState({ sessions: {} });
  registerThrLStructure();
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  useStructureLinkRegistry.setState({ links: {} });
  useStructureResidueSessionRegistry.setState({ sessions: {} });
  resetStructureStore();
  vi.unstubAllGlobals();
});

describe('Structure3dPanel keyboard focus', () => {
  it('keeps molecular data colors authoritative while preserving the ordinary scene color control', async () => {
    const current = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
    const dataRevision = 'a'.repeat(64);
    const mappingRevision = 'b'.repeat(64);
    const molecularData: NonNullable<Structure3dAttrs['molecularData']> = {
      version: 1,
      activeLayerId: 'python-colors',
      datasets: [
        {
          id: 'python-results',
          name: 'Python results',
          revision: dataRevision,
          source: { label: 'Python' },
          records: [{ chain: 'A', value: 0.5 }],
        },
      ],
      mappings: [
        {
          datasetId: 'python-results',
          dataRevision,
          revision: mappingRevision,
          coordinateSha256: 'c'.repeat(64),
          targets: [{ row: 0, selector: { label_asym_id: 'A' } }],
          unresolved: [],
        },
      ],
      layers: [
        {
          id: 'python-colors',
          name: 'Python colors',
          datasetId: 'python-results',
          dataRevision,
          mappingRevision,
          column: 'value',
          style: {
            kind: 'continuous',
            domain: [0, 1],
            colors: ['#0000ff', '#ff0000'],
            missingColor: '#cccccc',
          },
        },
      ],
    };
    useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
      ...current,
      molViewSpec: JSON.stringify({ root: { kind: 'root' }, metadata: { title: 'Python colors' } }),
      molecularData,
    });
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    await screen.findByTestId('molstar-viewer-stub');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings', exact: true }));
    await waitFor(() => expect(screen.getByLabelText('Data view')).toBeEnabled());
    expect(screen.getByLabelText('Data view')).toHaveValue('python-colors');
    expect(screen.queryByLabelText('Color structure')).toBeNull();
    expect(
      useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data.molecularData
    ).toEqual(molecularData);
    act(() =>
      useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
        ...useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data,
        molecularData: { ...molecularData, activeLayerId: undefined },
      })
    );
    expect(screen.getByRole('button', { name: 'Color structure', exact: true })).toBeEnabled();
    expect(screen.getByLabelText('Data view')).toBeInTheDocument();
  });

  it('keeps authored-scene recoloring available and saves its scene and camera in the panel', async () => {
    const original = JSON.stringify({ root: { kind: 'root' }, metadata: { title: 'Original' } });
    const current = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
    useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
      ...current,
      molViewSpec: original,
      molViewSpecSnapshotIndex: 2,
      cameraSnapshot: 'old-camera',
    });
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    await screen.findByTestId('molstar-viewer-stub');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings', exact: true }));
    const color = screen.getByRole('button', { name: 'Color structure', exact: true });
    expect(color).toBeEnabled();
    expect(color).toHaveAttribute('data-scene', original);
    expect(color).toHaveAttribute('data-index', '2');
    fireEvent.click(color);
    expect(useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data).toMatchObject({
      molViewSpec: 'changed-scene',
      molViewSpecSnapshotIndex: 2,
      cameraSnapshot: 'retained-camera',
      source: current.source,
      sourceId: current.sourceId,
    });
  });

  it('dismisses an opening context menu without clearing the still-focused sequence selection', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    hookMocks.useSelectionActions.mockImplementation(() => ({
      handleClearSelection: () => useStructure3dStore.getState().clearSelection(STRUCTURE_ID),
      handleClearUserSelection: () =>
        useStructure3dStore.getState().clearUserSelection(STRUCTURE_ID),
      handleResetCamera: hookMocks.handleResetCamera,
      handleCenterSelection: vi.fn(),
      createContextCenterHandler: vi.fn(() => vi.fn()),
    }));
    const selected = [
      { chain: 'A', position: 1 },
      { chain: 'A', position: 2 },
      { chain: 'A', position: 3 },
    ];
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, selected);
    render(<Structure3dPanel structureId={STRUCTURE_ID} source="alphafold" />);
    const trigger = await screen.findByTestId('chain-selection-toggle-A');
    trigger.focus();
    fireEvent.contextMenu(trigger, { clientX: 20, clientY: 30 });
    expect(screen.getByRole('menu', { name: 'Structure actions' })).toBeInTheDocument();
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID].selected).toEqual(
      selected
    );
    expect(screen.queryByRole('menu', { name: 'Structure actions' })).not.toBeInTheDocument();
  });

  it('keeps the canvas free of a selection outline for pointer and keyboard focus', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} source="alphafold" />);
    await screen.findByTestId('chain-selection-toggle-A');
    const surface = screen.getByTestId('structure-canvas-focus-surface');
    expect(surface.className).not.toMatch(/ring-(?:1|2|accent|inset)/);
    fireEvent(
      screen.getByTestId('test-structure-canvas'),
      new MouseEvent('pointerdown', { button: 0, bubbles: true })
    );
    expect(document.activeElement).toBe(surface);
    expect(surface).toHaveAttribute('data-pointer-focus', 'true');
    act(() => surface.blur());
    expect(surface).not.toHaveAttribute('data-pointer-focus');
    act(() => surface.focus());
    expect(surface).not.toHaveAttribute('data-pointer-focus');
  });

  for (const target of ['canvas', 'chain-table'] as const) {
    it(`${target} owns select-all, clear and copy without dispatching to DNA`, async () => {
      hookMocks.handleResiduesSelect.mockImplementation((residues: ResidueLocation[]) => {
        useStructure3dStore.getState().setSelected(STRUCTURE_ID, residues);
      });
      hookMocks.useSelectionActions.mockImplementation(() => ({
        handleClearSelection: () => useStructure3dStore.getState().clearSelection(STRUCTURE_ID),
        handleClearUserSelection: () =>
          useStructure3dStore.getState().clearUserSelection(STRUCTURE_ID),
        handleResetCamera: hookMocks.handleResetCamera,
        handleCenterSelection: vi.fn(),
        createContextCenterHandler: vi.fn(() => vi.fn()),
      }));
      render(<Structure3dPanel structureId={STRUCTURE_ID} source="alphafold" />);
      await screen.findByTestId('chain-selection-toggle-A');
      const element =
        target === 'canvas'
          ? screen.getByTestId('test-structure-canvas')
          : screen.getByTestId('chain-selection-toggle-A');
      fireEvent(element, new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      if (target === 'canvas') {
        expect(document.activeElement).toBe(screen.getByTestId('structure-canvas-focus-surface'));
        expect(hookMocks.canvasPointerDown).toHaveBeenCalledOnce();
      } else {
        element.focus();
      }
      const dnaListener = vi.fn();
      document.addEventListener('keydown', dnaListener);
      try {
        const modifier = isApplePlatform() ? { metaKey: true } : { ctrlKey: true };
        const selectAll = new KeyboardEvent('keydown', {
          key: 'a',
          ...modifier,
          bubbles: true,
          cancelable: true,
        });
        act(() => (document.activeElement as HTMLElement).dispatchEvent(selectAll));
        expect(
          useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected ?? []
        ).toHaveLength(8);
        expect(selectAll.defaultPrevented).toBe(true);
        expect(dnaListener).not.toHaveBeenCalled();

        const copy = new KeyboardEvent('keydown', {
          key: 'c',
          ...modifier,
          bubbles: true,
          cancelable: true,
        });
        act(() => (document.activeElement as HTMLElement).dispatchEvent(copy));
        expect(copy.defaultPrevented).toBe(true);
        expect(dnaListener).not.toHaveBeenCalled();

        const escape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        act(() => (document.activeElement as HTMLElement).dispatchEvent(escape));
        expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID].selected).toHaveLength(
          0
        );
        expect(escape.defaultPrevented).toBe(true);
        expect(dnaListener).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('keydown', dnaListener);
      }
    });
  }
});

describe('Structure3dPanel hover sync regression', () => {
  it('keeps the measurement legend outside the native viewport so it cannot cover selected atoms', async () => {
    const structure = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
    useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
      ...structure,
      activeMeasurementId: 'comparison',
      measurements: [
        {
          id: 'comparison',
          name: 'A / B',
          proteinSequenceSha256: 'a'.repeat(64),
          source: { label: 'Sample comparison', analysisId: 'A', revision: '1' },
          units: 'log2 ratio',
          values: [{ residue: 2, value: 1 }],
          scale: {
            transform: 'linear',
            domain: [-2, 2],
            colors: ['#2166ac', '#f7f7f7', '#b2182b'],
            missingColor: '#9ca3af',
          },
        },
      ],
    });
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    const viewer = await screen.findByTestId('molstar-viewer-stub');
    const legend = await screen.findByTestId('measurement-legend');
    expect(viewer.parentElement!.contains(legend)).toBe(false);
    expect(legend).toHaveTextContent('log2 ratio');
    expect(screen.queryByText(/Source and saved inputs/)).not.toBeInTheDocument();
  });
  it('renders its source/title header by default for standalone structure tabs', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const header = await screen.findByTestId('structure-3d-panel-header');
    expect(header).toHaveTextContent('View');
    expect(header).toHaveTextContent('thrL');
    expect(header).toHaveTextContent('Thr operon leader peptide');
  });

  it('can hide its source/title header when embedded in the structure drawer', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} hideStructureHeader />);

    await screen.findByTestId('structure-3d-panel');
    expect(screen.queryByTestId('structure-3d-panel-header')).not.toBeInTheDocument();
  });

  it('forwards drawer-hosted Shift-chain ranges and Command toggles through the shared handler', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} hideStructureHeader />);

    fireEvent.click(await screen.findByTestId('chain-selection-toggle-A'));
    fireEvent.click(screen.getByTestId('chain-selection-toggle-H'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('chain-selection-toggle-H'), { metaKey: true });

    expect(hookMocks.handleResiduesSelect).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        expect.objectContaining({ chain: 'A', position: 1, labelCompId: 'MET' }),
        expect.objectContaining({ chain: 'H', position: 4, labelCompId: 'ILE' }),
      ]),
      'range'
    );
    expect(hookMocks.handleResiduesSelect).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining([
        expect.objectContaining({ chain: 'H', position: 1, labelCompId: 'MET' }),
      ]),
      'toggle'
    );
  });

  it('forwards plain then Shift-clicked amino-acid letters from a drawer-hosted panel', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} hideStructureHeader />);

    fireEvent.click(await screen.findByTestId('residue-A-1'));
    fireEvent.click(screen.getByTestId('residue-A-3'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('residue-A-4'), { metaKey: true });

    const orderedInventory = [1, 2, 3, 4].map((position) =>
      expect.objectContaining({ chain: 'A', position })
    );

    expect(hookMocks.handleResidueSelect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ chain: 'A', position: 1, labelCompId: 'MET' }),
      'replace',
      orderedInventory
    );
    expect(hookMocks.handleResidueSelect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ chain: 'A', position: 3, labelCompId: 'ARG' }),
      'range',
      orderedInventory
    );
    expect(hookMocks.handleResidueSelect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ chain: 'A', position: 4, labelCompId: 'ILE' }),
      'toggle',
      orderedInventory
    );
  });

  it('labels default scoped PDB complex views as Cartoon instead of Custom', async () => {
    const scopedId = 'structure:RCSB:1RBL:ENTRY:AUTH_ASYM:H';
    registerScopedRcsbStructure(scopedId);

    render(<Structure3dPanel structureId={scopedId} />);

    await screen.findByTestId('structure-3d-panel');
    fireEvent.click(screen.getByTestId('structure-advanced-settings-toggle'));
    expect(screen.getByRole('button', { name: 'Structure view' })).toHaveTextContent(/Cartoon/i);
  });

  it.each([undefined, false])(
    'always presents sequence with legacy visibility %s',
    async (showSequenceViewer) => {
      localStorage.setItem(
        'dnaforge:structure-viewer-preferences',
        JSON.stringify({ state: { showSequenceByDefault: false }, version: 0 })
      );
      useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, { showSequenceViewer });
      render(<Structure3dPanel structureId={STRUCTURE_ID} />);
      expect(await screen.findByTestId('residue-A-1')).toBeVisible();
      expect(screen.getByTestId('structure-sequence-viewer')).toBeVisible();
      expect(screen.queryByRole('button', { name: /^(Show|Hide) sequence$/ })).toBeNull();
    }
  );

  it('keeps the settings drawer open when a first save rebuilds the panel ', async () => {
    const rendered = render(
      <Structure3dPanel key="loose-file" structureId={STRUCTURE_ID} viewerInstanceId="tab:1" />
    );
    await screen.findByTestId('structure-3d-panel');
    fireEvent.click(screen.getByTestId('structure-advanced-settings-toggle'));
    expect(screen.getByRole('dialog', { name: 'Advanced structure settings' })).toBeInTheDocument();
    rendered.rerender(
      <Structure3dPanel key="view-file" structureId={STRUCTURE_ID} viewerInstanceId="tab:1" />
    );
    await screen.findByTestId('structure-3d-panel');
    expect(screen.getByRole('dialog', { name: 'Advanced structure settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('structure-advanced-settings-toggle'));
    expect(screen.queryByRole('dialog', { name: 'Advanced structure settings' })).toBeNull();
  });

  it('keeps the actual sequence visible through a settings reset', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    expect(await screen.findByTestId('residue-A-1')).toBeVisible();
    fireEvent.click(screen.getByTestId('structure-advanced-settings-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Defaults' }));
    expect(screen.getByRole('region', { name: 'Structure sequence' })).toBeVisible();
    expect(screen.getByTestId('residue-A-1')).toBeVisible();
    expect(screen.queryByRole('switch', { name: /sequence/i })).toBeNull();
  });

  it('keeps settings above the canvas and selection actions inside the visible legend', async () => {
    useStructure3dStore.setState((state) => ({
      interactionState: {
        ...state.interactionState,
        [STRUCTURE_ID]: {
          hovered: { chain: 'A', position: 2 },
          selected: [{ chain: 'A', position: 2 }],
        },
      },
    }));

    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    expect(await screen.findByTestId('structure-sequence-horizontal-rule')).toBeInTheDocument();
    expect(screen.queryByTestId('selection-count')).not.toBeInTheDocument();

    const overlay = await screen.findByTestId('structure-viewer-overlay-controls');
    expect(within(overlay).queryByTestId('structure-sequence-toggle')).toBeNull();
    expect(within(overlay).getByTestId('structure-advanced-settings-toggle')).toBeInTheDocument();
    expect(within(overlay).queryByTestId('structure-selection-controls')).toBeNull();
    const legend = screen.getByRole('group', { name: 'Structure color key' });
    expect(within(legend).getByTestId('structure-selection-count')).toHaveTextContent(
      '1 residue selected'
    );
    expect(within(legend).getByRole('button', { name: 'Target selection' })).toBeInTheDocument();
    expect(within(legend).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(within(legend).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(within(legend).queryByText('Side chains')).toBeNull();
    expect(screen.getByTestId('structure-hover-tooltip')).toHaveAttribute(
      'data-placement',
      'below-controls'
    );
  });

  it('lets the advanced-settings dialog own Escape before structure canvas shortcuts', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    await screen.findByTestId('molstar-viewer-stub');

    const settingsToggle = screen.getByTestId('structure-advanced-settings-toggle');
    fireEvent.click(settingsToggle);
    const closeButton = screen.getByRole('button', { name: 'Close advanced settings' });
    await waitFor(() => expect(closeButton).toHaveFocus());

    fireEvent.keyDown(closeButton, { key: 'Escape' });

    expect(
      screen.queryByRole('dialog', { name: 'Advanced structure settings' })
    ).not.toBeInTheDocument();
    await waitFor(() => expect(settingsToggle).toHaveFocus());
  });

  it('uses the top-right hover tooltip slot when no selection controls are visible', async () => {
    useStructure3dStore.setState((state) => ({
      interactionState: {
        ...state.interactionState,
        [STRUCTURE_ID]: {
          hovered: { chain: 'A', position: 2 },
          selected: [],
        },
      },
    }));

    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    expect(await screen.findByTestId('structure-hover-tooltip')).toHaveAttribute(
      'data-placement',
      'below-controls'
    );
    expect(screen.queryByTestId('structure-selection-controls')).not.toBeInTheDocument();
  });

  it('sequence residue hover lights up Molstar highlighting, then clears it on mouse leave', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const residueTwo = await screen.findByTestId('residue-A-2');
    fireEvent.mouseEnter(residueTwo);

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
        chain: 'A',
        position: 2,
      });
    });
    await waitFor(() => {
      expect(latestLoadedHighlightState()?.hovered).toMatchObject({
        chain: 'A',
        position: 2,
      });
    });

    fireEvent.mouseLeave(residueTwo);

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toBeNull();
    });
    await waitFor(() => {
      expect(latestLoadedHighlightState()?.hovered).toBeNull();
    });
  });

  it('keeps viewer settings latest-attrs callback stable across hover rerenders', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const residueTwo = await screen.findByTestId('residue-A-2');
    await waitFor(() => expect(useViewerSettings).toHaveBeenCalled());
    const firstGetLatestAttrs = latestViewerSettingsGetLatestAttrs();

    fireEvent.mouseEnter(residueTwo);

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
        chain: 'A',
        position: 2,
      });
    });
    expect(latestViewerSettingsGetLatestAttrs()).toBe(firstGetLatestAttrs);
  });

  it('Molstar residue hover lights up the sequence viewer residue, then clears it', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onHover).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onHover?.({ chain: 'A', position: 3 });
    });

    const residueThree = await screen.findByTestId('residue-A-3');
    await waitFor(() => expect(residueThree).toHaveAttribute('data-state', 'hovered'));
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
      chain: 'A',
      position: 3,
    });

    act(() => {
      hookMocks.latestMolstarOptions?.onHover?.(null);
    });

    await waitFor(() => expect(residueThree).not.toHaveAttribute('data-state'));
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toBeNull();
  });

  it('refreshes provider-only AlphaFold structure links with concrete extracted residue targets', async () => {
    const previousSequenceData = hookMocks.sequenceData;
    hookMocks.sequenceData = {
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          entityId: '1',
          sequence: 'MKRI',
          residues: [
            { position: 1, labelSeqId: 1, sequenceIndex: 0, name: 'M', name3: 'MET' },
            { position: 2, labelSeqId: 2, sequenceIndex: 1, name: 'K', name3: 'LYS' },
            { position: 3, labelSeqId: 3, sequenceIndex: 2, name: 'R', name3: 'ARG' },
            { position: 4, labelSeqId: 4, sequenceIndex: 3, name: 'I', name3: 'ILE' },
          ],
        },
      ],
      ligands: [],
    };
    try {
      useStructure3dStore.getState().registerStructure(
        STRUCTURE_ID,
        {
          source: 'alphafold',
          sourceId: 'AF:P0AD86:F1:LATEST',
          providerIdentityKey: 'AF:P0AD86:F1:LATEST',
          uniprotId: 'P0AD86',
          accession: 'P0AD86',
          label: 'thrL',
          title: 'Thr operon leader peptide',
          colorMode: 'plddt',
          showSequenceViewer: true,
          highlightGroups: [],
          scene: {
            schemaVersion: 1,
            sceneId: 'scene:AF:P0AD86:F1:LATEST',
            sceneKind: 'single_query',
            primaryResourceId: 'AF:P0AD86:F1:LATEST',
            queryAnchor: {
              memberId: 'member:thrL',
              targetSelection: {
                providerIdentityKey: 'AF:P0AD86:F1:LATEST',
                accession: 'P0AD86',
              },
            },
            members: [],
            layers: [],
            provenance: { createdBy: 'structure-drawer', provider: 'alphafold' },
          },
        },
        'thrL'
      );
      const provisionalLink = {
        structureId: STRUCTURE_ID,
        sequenceDocumentId: '/fixtures/mg1655.gb',
        cdsLabel: 'thrL',
        translation: 'MKRI',
        cdsStart: 190,
        cdsEnd: 255,
        strand: 1 as const,
        residueMolecule: { moleculeId: 'thrL-protein', moleculeKind: 'translated-cds' as const },
        residueTarget: { chain: 'A', residues: [] },
        residueTargets: [{ chain: 'A', residues: [] }],
      };
      useStructureLinkRegistry.getState().registerLink(provisionalLink);
      useStructureResidueSessionRegistry.getState().upsertSession({
        structureId: STRUCTURE_ID,
        sequenceDocumentId: '/fixtures/mg1655.gb',
        phase: 'viewer-mounting',
        link: provisionalLink,
      });

      const selections = createResidueSelectionsStore();
      const mutationSelection: ResidueSelection = {
        target: {
          moleculeId: 'thrL-protein',
          moleculeKind: 'translated-cds',
          coordinateSystem: 'residue',
          intervals: [{ start: 1, end: 1 }],
        },
      };
      selections.set([mutationSelection]);
      render(
        <ResidueSelectionsProvider value={selections}>
          <Structure3dPanel structureId={STRUCTURE_ID} />
        </ResidueSelectionsProvider>
      );

      await screen.findByTestId('molstar-viewer-stub');
      expect(selections.getSnapshot()).toEqual([mutationSelection]);
      await waitFor(() => {
        expect(useStructureLinkRegistry.getState().getLink(STRUCTURE_ID)?.residueTargets).toEqual([
          {
            chain: 'A',
            baseChain: 'A',
            labelAsymId: 'A',
            authAsymId: 'A',
            entityId: '1',
            residues: [
              { residueIndex: 0, position: 1, labelSeqId: 1 },
              { residueIndex: 1, position: 2, labelSeqId: 2 },
              { residueIndex: 2, position: 3, labelSeqId: 3 },
              { residueIndex: 3, position: 4, labelSeqId: 4 },
            ],
          },
        ]);
      });
      expect(
        useStructureResidueSessionRegistry.getState().sessions[STRUCTURE_ID]?.link?.residueTargets
      ).toEqual([
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          entityId: '1',
          residues: [
            { residueIndex: 0, position: 1, labelSeqId: 1 },
            { residueIndex: 1, position: 2, labelSeqId: 2 },
            { residueIndex: 2, position: 3, labelSeqId: 3 },
            { residueIndex: 3, position: 4, labelSeqId: 4 },
          ],
        },
      ]);
    } finally {
      hookMocks.sequenceData = previousSequenceData;
    }
  });

  it('renders definitive missing coordinates from the linked full polymer without fabricating targets', async () => {
    const previousSequenceData = hookMocks.sequenceData;
    try {
      hookMocks.sequenceData = {
        chains: [
          {
            chainId: 'A',
            chainLabel: 'Chain A',
            baseChain: 'A',
            labelAsymId: 'A',
            authAsymId: 'A',
            entityId: '1',
            sequence: 'MST',
            residues: [
              { position: 19, labelSeqId: 1, name: 'M', name3: 'MET', value: 98 },
              { position: 20, labelSeqId: 2, name: 'S', name3: 'SER', value: 96 },
              { position: 21, labelSeqId: 3, name: 'T', name3: 'THR', value: 95 },
            ],
          },
        ],
        ligands: [],
      };
      useStructureLinkRegistry.getState().registerLink({
        structureId: STRUCTURE_ID,
        sequenceDocumentId: '/fixtures/mg1655.gb',
        cdsLabel: 'thrL',
        translation: 'AMSTQY',
        cdsStart: 190,
        cdsEnd: 255,
        strand: 1,
      });

      render(<Structure3dPanel structureId={STRUCTURE_ID} />);

      expect(await screen.findByTestId('missing-residue-A-1')).toHaveAttribute(
        'data-coordinate-status',
        'missing'
      );
      expect(screen.getByTestId('missing-residue-A-5')).not.toHaveAttribute('data-position');
      expect(screen.getByTestId('missing-residue-A-6')).not.toHaveAttribute('data-label-seq-id');
      expect(screen.getByTestId('residue-A-19')).toHaveAttribute('data-polymer-index', '1');
      expect(screen.getByText('3 / 6 modeled')).toBeInTheDocument();
    } finally {
      hookMocks.sequenceData = previousSequenceData;
    }
  });

  it('Molstar residue click writes residue-native selection and coding-DNA projection', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: { chain: 'A', residueMappingKind: 'identity' },
      residueTargets: [{ chain: 'A', residueMappingKind: 'identity' }],
    });
    hookMocks.handleResidueSelect.mockImplementation((residue, gesture) => {
      useStructure3dStore.getState().selectResidue(STRUCTURE_ID, residue, gesture);
    });

    render(
      <ResidueSelectionsProvider value={residueStore}>
        <Structure3dPanel structureId={STRUCTURE_ID} />
      </ResidueSelectionsProvider>
    );

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onClick).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.({ chain: 'A', position: 3 }, 'replace');
    });

    await waitFor(() => {
      expect(residueStore.getSnapshot()).toMatchObject([
        {
          source: { kind: 'structure', id: STRUCTURE_ID, surface: 'molstar' },
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
            {
              kind: 'structure',
              structureId: STRUCTURE_ID,
              chain: 'A',
              position: 3,
              residueStart: 3,
              residueEnd: 3,
            },
          ],
        },
      ]);
    });
    expect(
      residueSelectionsToCodingDnaRanges(residueStore.getSnapshot(), '/fixtures/mg1655.gb')
    ).toEqual([{ start: 196, end: 198, strand: 1 }]);

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.({ chain: 'A', position: 3 }, 'replace');
    });

    await waitFor(() => {
      expect(residueStore.getSnapshot()).toEqual([]);
    });
  });

  for (const pending of [false, true]) {
    it(`canvas select-all survives a ${pending ? 'pending' : 'settled'} linked sequence selection`, async () => {
      const residueStore = createResidueSelectionsStore();
      useStructureLinkRegistry.getState().registerLink({
        structureId: STRUCTURE_ID,
        sequenceDocumentId: '/fixtures/mg1655.gb',
        cdsLabel: 'thrL',
        translation: 'MKRI',
        cdsStart: 190,
        cdsEnd: 255,
        strand: 1,
        residueTarget: { chain: 'A', residueMappingKind: 'identity' },
        residueTargets: [
          { chain: 'A', residueMappingKind: 'identity' },
          { chain: 'H', residueMappingKind: 'identity' },
        ],
      });
      hookMocks.handleResiduesSelect.mockImplementation((residues, gesture) => {
        useStructure3dStore.getState().selectResidues(STRUCTURE_ID, residues, gesture);
      });
      render(
        <ResidueSelectionsProvider value={residueStore}>
          <Structure3dPanel structureId={STRUCTURE_ID} />
        </ResidueSelectionsProvider>
      );
      await screen.findByTestId('molstar-viewer-stub');
      const selection: ResidueSelection = {
        selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:1',
        source: { kind: 'translation-track', id: '/fixtures/mg1655.gb', surface: 'sequence-cds' },
        target: {
          moleculeId: 'translated-cds:/fixtures/mg1655.gb:thrL:191-256:1',
          moleculeKind: 'translated-cds',
          coordinateSystem: 'residue',
          intervals: [{ start: 0, end: 0 }],
        },
        mappings: [
          {
            kind: 'coding-dna',
            referenceId: '/fixtures/mg1655.gb',
            featureId: 'thrL',
            strand: 1,
            intervals: [{ start: 190, end: 192 }],
          },
        ],
      };
      const selectAll = () =>
        fireEvent.keyDown(screen.getByTestId('structure-canvas-focus-surface'), {
          key: 'a',
          ...(isApplePlatform() ? { metaKey: true } : { ctrlKey: true }),
        });
      if (pending) {
        act(() => {
          residueStore.set([selection]);
          selectAll();
        });
      } else {
        act(() => residueStore.set([selection]));
        act(selectAll);
      }
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID].selected).toHaveLength(
        8
      );
      expect(screen.getByTestId('structure-selection-count')).toHaveTextContent(
        '8 residues selected'
      );
      expect(residueStore.getSnapshot()).toContainEqual(selection);
    });
  }

  it('blank primary canvas click clears select-all and resets camera without selecting residues', async () => {
    hookMocks.handleResiduesSelect.mockImplementation((residues: ResidueLocation[]) => {
      useStructure3dStore.getState().setSelected(STRUCTURE_ID, residues);
    });
    hookMocks.useSelectionActions.mockImplementation(() => ({
      handleClearSelection: () => useStructure3dStore.getState().clearSelection(STRUCTURE_ID),
      handleClearUserSelection: () =>
        useStructure3dStore.getState().clearUserSelection(STRUCTURE_ID),
      handleResetCamera: hookMocks.handleResetCamera,
      handleCenterSelection: vi.fn(),
      createContextCenterHandler: vi.fn(() => vi.fn()),
    }));
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() =>
      expect(hookMocks.latestClickDetectionOptions?.onBlankPrimaryCanvasClick).toBeTypeOf(
        'function'
      )
    );

    fireEvent.keyDown(screen.getByTestId('structure-canvas-focus-surface'), {
      key: 'a',
      ...(isApplePlatform() ? { metaKey: true } : { ctrlKey: true }),
    });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID].selected).toHaveLength(8);

    act(() => {
      hookMocks.latestClickDetectionOptions?.onBlankPrimaryCanvasClick?.();
    });

    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID].selected).toHaveLength(0);
    expect(hookMocks.handleResetCamera).toHaveBeenCalledTimes(1);
    expect(hookMocks.handleResidueSelect).not.toHaveBeenCalled();
  });

  it('modified structure selection updates do not erase sequence-origin residue selections on the same CDS', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: { chain: 'A', residueMappingKind: 'identity' },
      residueTargets: [{ chain: 'A', residueMappingKind: 'identity' }],
    });
    const sequenceOriginSelection: ResidueSelection = {
      selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:4',
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
        intervals: [{ start: 3, end: 3 }],
        label: 'thrL',
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/mg1655.gb',
          featureId: 'thrL',
          strand: 1 as const,
          intervals: [{ start: 199, end: 201 }],
        },
      ],
    };
    hookMocks.handleResidueSelect.mockImplementation((residue, gesture) => {
      useStructure3dStore.getState().selectResidue(STRUCTURE_ID, residue, gesture);
    });

    render(
      <ResidueSelectionsProvider value={residueStore}>
        <Structure3dPanel structureId={STRUCTURE_ID} />
      </ResidueSelectionsProvider>
    );

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onClick).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.({ chain: 'A', position: 3 }, 'replace');
    });
    await waitFor(() => {
      expect(residueStore.getSnapshot().map((selection) => selection.selectionId)).toEqual([
        'structure:structure:alphafold:P0AD86:all:residue:2',
      ]);
    });

    act(() => {
      residueStore.set([...residueStore.getSnapshot(), sequenceOriginSelection]);
    });
    expect(residueStore.getSnapshot().map((selection) => selection.selectionId)).toEqual([
      'structure:structure:alphafold:P0AD86:all:residue:2',
      'translation-track:/fixtures/mg1655.gb:thrL:4',
    ]);

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.({ chain: 'A', position: 3 }, 'toggle');
    });

    await waitFor(() => {
      expect(residueStore.getSnapshot().map((selection) => selection.selectionId)).toEqual([
        'translation-track:/fixtures/mg1655.gb:thrL:4',
      ]);
    });
    expect(
      residueSelectionsToCodingDnaRanges(residueStore.getSnapshot(), '/fixtures/mg1655.gb')
    ).toEqual([{ start: 199, end: 201, strand: 1 }]);
  });

  it('sequence-origin residue selections drive structure selected residues and Molstar highlighting', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
      },
      residueTargets: [
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
      ],
    });

    render(
      <ResidueSelectionsProvider value={residueStore}>
        <Structure3dPanel structureId={STRUCTURE_ID} />
      </ResidueSelectionsProvider>
    );

    await screen.findByTestId('molstar-viewer-stub');
    const sequenceViewer = await screen.findByTestId('structure-sequence-viewer');
    const drawerResidueBeforeSelection = within(sequenceViewer).getByTestId('residue-A-3');
    expect(drawerResidueBeforeSelection).toHaveAttribute('data-chain-id', 'A');
    expect(drawerResidueBeforeSelection).toHaveAttribute('data-position', '3');
    expect(drawerResidueBeforeSelection).toHaveAttribute('data-base-chain', 'A');
    expect(drawerResidueBeforeSelection).toHaveAttribute('data-label-asym-id', 'A');
    expect(drawerResidueBeforeSelection).toHaveAttribute('data-auth-asym-id', 'H');
    expect(drawerResidueBeforeSelection).toHaveAttribute('data-entity-id', '1');
    expect(drawerResidueBeforeSelection).not.toHaveAttribute('data-state', 'selected');
    expect(
      within(drawerResidueBeforeSelection).queryByTestId('residue-A-3-interaction-frame')
    ).not.toBeInTheDocument();

    act(() => {
      residueStore.set([
        {
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
        },
      ]);
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
        {
          chain: 'A',
          position: 3,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
        {
          chain: 'H',
          position: 3,
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
        },
      ]);
    });
    await waitFor(() => {
      expect(latestLoadedHighlightState()?.selected).toEqual([
        {
          chain: 'A',
          position: 3,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
        {
          chain: 'H',
          position: 3,
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
        },
      ]);
    });
    await waitFor(() => {
      const drawerResidue = within(sequenceViewer).getByTestId('residue-A-3');
      expect(drawerResidue).toHaveAttribute('data-state', 'selected');
      expect(
        within(drawerResidue).getByTestId('residue-A-3-interaction-frame')
      ).toBeInTheDocument();
      const secondDrawerResidue = within(sequenceViewer).getByTestId('residue-H-3');
      expect(secondDrawerResidue).toHaveAttribute('data-state', 'selected');
      expect(
        within(secondDrawerResidue).getByTestId('residue-H-3-interaction-frame')
      ).toBeInTheDocument();
    });
  });

  it('does not move the explicit selection anchor when a sequence residue projects to multiple protomers', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
      },
      residueTargets: [
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
      ],
    });

    render(
      <ResidueSelectionsProvider value={residueStore}>
        <Structure3dPanel structureId={STRUCTURE_ID} />
      </ResidueSelectionsProvider>
    );

    await screen.findByTestId('molstar-viewer-stub');

    const explicitAnchor: ResidueLocation = {
      chain: 'A',
      position: 2,
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
    };
    act(() => {
      useStructure3dStore.setState((state) => ({
        selectionAnchor: {
          ...state.selectionAnchor,
          [STRUCTURE_ID]: explicitAnchor,
        },
      }));
      residueStore.set([
        {
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
        },
      ]);
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
        {
          chain: 'A',
          position: 3,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
        {
          chain: 'H',
          position: 3,
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
        },
      ]);
    });
    await waitFor(() => {
      expect(latestLoadedHighlightState()?.selected).toEqual([
        {
          chain: 'A',
          position: 3,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
        {
          chain: 'H',
          position: 3,
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
        },
      ]);
    });
    expect(useStructure3dStore.getState().selectionAnchor[STRUCTURE_ID]).toEqual(explicitAnchor);

    act(() => {
      residueStore.set([]);
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([]);
      expect(useStructure3dStore.getState().selectionAnchor[STRUCTURE_ID]).toBeNull();
    });
  });

  it('uses the owner-scoped structure link when two residue sources share one structureId', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      ownerId: 'owner:thrL',
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      cdsFeatureId: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
      },
      residueTargets: [
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
      ],
    });
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      ownerId: 'owner:other-cds',
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'otherCds',
      cdsFeatureId: 'otherCds',
      translation: 'GAVL',
      cdsStart: 500,
      cdsEnd: 511,
      strand: 1,
      residueTarget: { chain: 'H', residueMappingKind: 'identity' },
      residueTargets: [{ chain: 'H', residueMappingKind: 'identity' }],
    });

    render(
      <ResidueSelectionsProvider value={residueStore}>
        <Structure3dPanel structureId={STRUCTURE_ID} structureLinkOwnerId="owner:thrL" />
      </ResidueSelectionsProvider>
    );

    await screen.findByTestId('molstar-viewer-stub');
    act(() => {
      residueStore.set([
        {
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
        },
      ]);
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
        {
          chain: 'A',
          position: 3,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
        {
          chain: 'H',
          position: 3,
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
        },
      ]);
    });
  });

  it('standalone structure tabs use the workspace residue store and clear it without a provider', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
      },
      residueTargets: [
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
      ],
    });

    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    await screen.findByTestId('molstar-viewer-stub');
    let unregisterStore: (() => void) | null = null;
    act(() => {
      unregisterStore = registerWorkspaceResidueSelectionsStore(
        '/fixtures/mg1655.gb',
        residueStore
      );
      residueStore.set([
        {
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
        },
      ]);
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([
        {
          chain: 'A',
          position: 3,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
        {
          chain: 'H',
          position: 3,
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
        },
      ]);
    });

    act(() => {
      useStructure3dStore.getState().clearSelection(STRUCTURE_ID);
    });

    await waitFor(() => {
      expect(residueStore.getSnapshot()).toEqual([]);
    });
    act(() => {
      unregisterStore?.();
    });
  });

  it('stops selection sync after the structure link is explicitly unregistered', async () => {
    const residueStore = createResidueSelectionsStore();
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
      },
      residueTargets: [
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
      ],
    });

    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    await screen.findByTestId('molstar-viewer-stub');
    act(() => {
      useStructureLinkRegistry.getState().unregisterLink(STRUCTURE_ID);
    });
    expect(useStructureLinkRegistry.getState().links[STRUCTURE_ID]).toBeUndefined();

    let unregisterStore: (() => void) | null = null;
    act(() => {
      unregisterStore = registerWorkspaceResidueSelectionsStore(
        '/fixtures/mg1655.gb',
        residueStore
      );
    });
    act(() => {
      residueStore.set([
        {
          selectionId: 'translation-track:/fixtures/mg1655.gb:thrL:3',
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
            intervals: [{ start: 3, end: 3 }],
            label: 'thrL',
          },
          mappings: [
            {
              kind: 'coding-dna',
              referenceId: '/fixtures/mg1655.gb',
              featureId: 'thrL',
              strand: 1,
              intervals: [{ start: 199, end: 201 }],
            },
          ],
        },
      ]);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected ?? []).toEqual(
      []
    );

    act(() => {
      useStructure3dStore.getState().setSelected(STRUCTURE_ID, [
        {
          chain: 'A',
          position: 4,
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
        },
      ]);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(residueStore.getSnapshot()).toHaveLength(1);
    act(() => {
      unregisterStore?.();
    });
  });

  it('visible saved highlight groups do not write active residue selections', async () => {
    const residueStore = createResidueSelectionsStore();
    const structure = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
    useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
      ...structure,
      highlightGroups: [
        {
          id: 'saved-not-active-selection',
          label: 'Saved highlight',
          selections: [{ chain: 'A', ranges: [[2, 3]] }],
          visible: true,
        },
      ],
    });
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: '/fixtures/mg1655.gb',
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 190,
      cdsEnd: 255,
      strand: 1,
      residueTarget: { chain: 'A', residueMappingKind: 'identity' },
      residueTargets: [{ chain: 'A', residueMappingKind: 'identity' }],
    });

    render(
      <ResidueSelectionsProvider value={residueStore}>
        <Structure3dPanel structureId={STRUCTURE_ID} />
      </ResidueSelectionsProvider>
    );

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() => {
      expect(residueStore.getSnapshot()).toEqual([]);
    });
  });

  it('does not let a late raw camera callback overwrite a newly authored single-view camera', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    await screen.findByTestId('molstar-viewer-stub');
    const staleCameraChange = hookMocks.latestCameraChange;
    expect(staleCameraChange).toBeTypeOf('function');
    act(() => {
      const current = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
      useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
        ...current,
        molViewSpec: JSON.stringify({ root: { kind: 'root' }, metadata: { title: 'View' } }),
        cameraSnapshot: 'authored camera',
      });
    });
    act(() => staleCameraChange?.('exploratory camera'));
    expect(
      useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data.cameraSnapshot
    ).toBe('authored camera');
  });

  it('does not let a late camera callback erase an agent highlight written after render', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    await screen.findByTestId('molstar-viewer-stub');
    const staleCameraChange = hookMocks.latestCameraChange;
    expect(staleCameraChange).toBeTypeOf('function');

    const agentHighlight = {
      id: 'agent-highlight:test-turn',
      label: 'Catalytic residues',
      selections: [{ chain: 'A', ranges: [[2, 3] as [number, number]] }],
      visible: true,
    };
    act(() => {
      const current = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
      useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
        ...current,
        highlightGroups: [agentHighlight],
      });
    });

    act(() => staleCameraChange?.('camera-after-tool-write'));

    const persisted = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
    expect(persisted.cameraSnapshot).toBe('camera-after-tool-write');
    expect(persisted.highlightGroups).toEqual([agentHighlight]);
  });

  it('filters scoped RCSB rows by auth_asym_id and ignores out-of-scope Molstar hover/click writes', async () => {
    const scopedId = 'structure:rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:H';
    registerScopedRcsbStructure(scopedId);
    const scopedData = useStructure3dStore.getState().expandedStructures[scopedId].data;
    useStructure3dStore.getState().updateStructureData(scopedId, {
      ...scopedData,
      highlightGroups: [
        {
          id: 'saved-auth-h',
          label: 'Saved auth H',
          selections: [{ chain: 'H', ranges: [[3, 3]] }],
        },
      ],
    });

    render(<Structure3dPanel structureId={scopedId} />);

    expect(await screen.findByTestId('residue-A-2')).toBeInTheDocument();
    expect(screen.queryByTestId('residue-H-2')).not.toBeInTheDocument();
    await waitFor(() => {
      const matchingCall = hookMocks.useSelectionActions.mock.calls.find(([args]) => {
        const highlightGroups = (args as { highlightGroups?: unknown }).highlightGroups;
        return (
          JSON.stringify(highlightGroups) ===
          JSON.stringify([
            {
              id: 'saved-auth-h',
              label: 'Saved auth H',
              selections: [{ chain: 'A', ranges: [[3, 3]] }],
            },
          ])
        );
      });
      expect(matchingCall).toBeTruthy();
    });
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onHover).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onHover?.({
        chain: 'H',
        baseChain: 'H',
        labelAsymId: 'H',
        authAsymId: 'B',
        entityId: '2',
        position: 3,
      });
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[scopedId]?.hovered ?? null).toBeNull();
    });
    expect(latestLoadedHighlightState()?.hovered).toBeNull();

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.(
        {
          chain: 'H',
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
          position: 3,
        },
        'replace'
      );
    });

    expect(hookMocks.handleResidueSelect).not.toHaveBeenCalled();

    act(() => {
      hookMocks.latestMolstarOptions?.onHover?.({
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        position: 3,
      });
    });

    const residueThree = await screen.findByTestId('residue-A-3');
    await waitFor(() => expect(residueThree).toHaveAttribute('data-state', 'hovered'));

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.(
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          position: 3,
        },
        'replace'
      );
    });

    expect(hookMocks.handleResidueSelect).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'A', authAsymId: 'H', position: 3 }),
      'replace'
    );
  });

  it('preserves scoped chain metadata when sequence hover and click drive Molstar highlighting', async () => {
    const scopedId = 'structure:rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:H';
    registerScopedRcsbStructure(scopedId);

    render(<Structure3dPanel structureId={scopedId} />);

    const residueThree = await screen.findByTestId('residue-A-3');
    fireEvent.mouseEnter(residueThree);

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[scopedId]?.hovered).toMatchObject({
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        position: 3,
      });
    });
    await waitFor(() => {
      expect(latestLoadedHighlightState()?.hovered).toMatchObject({
        chain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        position: 3,
      });
    });

    fireEvent.click(residueThree);
    expect(hookMocks.handleResidueSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        position: 3,
      }),
      'replace',
      expect.any(Array)
    );
  });

  it('filters scoped RCSB rows by entity id and ignores out-of-scope entity Molstar writes', async () => {
    const scopedId = 'structure:rcsb:RCSB:1RBL:ENTRY:ENTITY:1';
    registerEntityScopedRcsbStructure(scopedId);

    render(<Structure3dPanel structureId={scopedId} />);

    expect(await screen.findByTestId('residue-A-2')).toBeInTheDocument();
    expect(screen.queryByTestId('residue-H-2')).not.toBeInTheDocument();
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onHover).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onHover?.({
        chain: 'H',
        baseChain: 'H',
        labelAsymId: 'H',
        authAsymId: 'B',
        entityId: '2',
        position: 3,
      });
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[scopedId]?.hovered ?? null).toBeNull();
    });

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.(
        {
          chain: 'H',
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
          position: 3,
        },
        'replace'
      );
    });

    expect(hookMocks.handleResidueSelect).not.toHaveBeenCalled();

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.(
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          position: 3,
        },
        'replace'
      );
    });

    expect(hookMocks.handleResidueSelect).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'A', entityId: '1', position: 3 }),
      'replace'
    );
  });

  it('keeps hook order stable when a panel renders before its structure is registered', async () => {
    const lateId = 'structure:late-registration';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<Structure3dPanel structureId={lateId} />);

    expect(screen.getByText('Loading structure...')).toBeInTheDocument();
    const sequence = screen.getByRole('region', { name: 'Structure sequence' });
    expect(within(sequence).getByText('Loading sequence…')).toBeVisible();

    act(() => {
      useStructure3dStore.getState().registerStructure(
        lateId,
        {
          source: 'alphafold',
          sourceId: 'P0AD86',
          label: 'late thrL',
          colorMode: 'chain',
          showSequenceViewer: true,
          highlightGroups: [],
        },
        'late thrL'
      );
    });

    await screen.findByTestId('molstar-viewer-stub');
    expect(screen.getByRole('region', { name: 'Structure sequence' })).toBeVisible();
    expect(await screen.findByTestId('residue-A-1')).toBeVisible();
    const consoleOutput = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(consoleOutput).not.toContain('change in the order of Hooks');
    expect(consoleOutput).not.toContain('Rendered more hooks than during the previous render');
    consoleErrorSpy.mockRestore();
  });

  it('retains its sequence region when a structure remains missing after loading', async () => {
    render(<Structure3dPanel structureId="structure:missing-sequence-region" />);
    const sequence = screen.getByRole('region', { name: 'Structure sequence' });
    expect(within(sequence).getByText('Loading sequence…')).toBeVisible();
    expect(await screen.findByText('Structure not found')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Structure sequence' })).toBe(sequence);
    expect(within(sequence).getByRole('alert')).toHaveTextContent(
      'The sequence could not be read from this structure.'
    );
    expect(screen.queryByTestId('residue-A-1')).toBeNull();
  });

  it('retains a mutation selection while the first structure registers', async () => {
    const viewId = 'structure:mutation-before-bootstrap';
    const selected = [{ chain: 'A', position: 2 }];
    useStructure3dStore.getState().setSelected(viewId, selected);

    render(
      <Structure3dPanel
        structureId={viewId}
        initialStructureAttrs={{
          source: 'alphafold',
          sourceId: 'P0AD86',
          label: 'Mutation context',
          colorMode: 'chain',
          showSequenceViewer: true,
        }}
      />
    );

    await screen.findByTestId('molstar-viewer-stub');
    expect(useStructure3dStore.getState().interactionState[viewId]?.selected).toEqual(selected);
    expect(latestLoadedHighlightState().selected).toEqual(selected);
  });

  it('clears the previous mutation selection when a different protein replaces the source', async () => {
    useStructure3dStore.getState().setSelected(STRUCTURE_ID, [{ chain: 'A', position: 2 }]);
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);
    await screen.findByTestId('molstar-viewer-stub');
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toHaveLength(1);

    act(() => {
      const current = useStructure3dStore.getState().expandedStructures[STRUCTURE_ID].data;
      useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
        ...current,
        sourceId: 'P39702',
        label: 'VPS8',
      });
    });

    await waitFor(() =>
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.selected).toEqual([])
    );
  });

  it('uses initial structure attrs only to bootstrap and preserves later store-owned revisions', async () => {
    const viewId = 'structure:inline-bootstrap';
    const initialAttrs: Structure3dAttrs = {
      source: 'file',
      sourceId: 'data:auto:inline-bootstrap',
      structureData: 'ATOM      1  N   MET A   1',
      label: 'Inline structure',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };

    render(
      <Structure3dPanel
        structureId={viewId}
        structureViewId={viewId}
        initialStructureAttrs={initialAttrs}
      />
    );

    await screen.findByTestId('molstar-viewer-stub');

    act(() => {
      const current = useStructure3dStore.getState().expandedStructures[viewId]?.data;
      expect(current).toBeDefined();
      useStructure3dStore.getState().updateStructureData(viewId, {
        ...current!,
        structureArtifactRef: {
          entityId: 'catalog-structure-1',
          revisionId: 'coordinate-revision-1',
          structureId: viewId,
          coordinateDigestSha256: 'abc123',
          artifactPath: 'Structures/inline-bootstrap.pdb',
          format: 'pdb',
        },
        savedSelectionRefs: [
          {
            selectionId: 'selection-1',
            revisionId: 'selection-revision-1',
            artifactPath: 'Selections/selection-1.wpselection.json',
            visible: true,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(useStructure3dStore.getState().expandedStructures[viewId]?.data).toMatchObject({
        structureArtifactRef: { coordinateDigestSha256: 'abc123' },
        savedSelectionRefs: [{ selectionId: 'selection-1' }],
      });
    });
  });

  it('keeps sequence hover ownership through the structure projection and clears on sequence leave', async () => {
    const codons = createHoveredCodonStore();
    const residues = createHoveredResidueStore();
    const documentId = '/fixtures/sequence-hover-owner.gb';
    useStructureLinkRegistry.getState().registerLink({
      structureId: STRUCTURE_ID,
      sequenceDocumentId: documentId,
      cdsLabel: 'thrL',
      translation: 'MKRI',
      cdsStart: 0,
      cdsEnd: 11,
      strand: 1,
      residueTarget: {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        residueMappingKind: 'identity',
      },
    });
    function SequenceBridge() {
      useSequenceCodonResidueBridge({
        entityId: documentId,
        hoveredCodonStore: codons,
        hoveredResidueStore: residues,
      });
      return null;
    }
    render(
      <HoveredCodonProvider value={codons}>
        <HoveredResidueProvider value={residues}>
          <SequenceBridge />
          <Structure3dPanel structureId={STRUCTURE_ID} />
        </HoveredResidueProvider>
      </HoveredCodonProvider>
    );
    await screen.findByTestId('molstar-viewer-stub');
    act(() => codons.set({ start: 3, end: 5, strand: 1, source: 'sequence' }));
    await waitFor(() =>
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
        chain: 'A',
        position: 2,
      })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(codons.getSnapshot()).toMatchObject({ start: 3, end: 5, source: 'sequence' });
    act(() => {
      if (codons.getSnapshot()?.source === 'sequence') codons.set(null);
    });
    await waitFor(() =>
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toBeNull()
    );
    expect(residues.getSnapshot()).toBeNull();
    expect(screen.queryByTestId('structure-hover-tooltip')).not.toBeInTheDocument();
  });

  it.each(['MolStar', 'amino-acid row'] as const)(
    'hands the same residue to a genuine %s pointer and clears when it leaves',
    async (surface) => {
      const codons = createHoveredCodonStore();
      const residues = createHoveredResidueStore();
      const documentId = '/fixtures/same-residue-owner.gb';
      useStructureLinkRegistry.getState().registerLink({
        structureId: STRUCTURE_ID,
        sequenceDocumentId: documentId,
        cdsLabel: 'thrL',
        translation: 'MKRI',
        cdsStart: 0,
        cdsEnd: 11,
        strand: 1,
        residueTarget: {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          residueMappingKind: 'identity',
        },
      });
      function SequenceBridge() {
        useSequenceCodonResidueBridge({
          entityId: documentId,
          hoveredCodonStore: codons,
          hoveredResidueStore: residues,
        });
        return null;
      }
      render(
        <HoveredCodonProvider value={codons}>
          <HoveredResidueProvider value={residues}>
            <SequenceBridge />
            <Structure3dPanel structureId={STRUCTURE_ID} />
          </HoveredResidueProvider>
        </HoveredCodonProvider>
      );
      await screen.findByTestId('molstar-viewer-stub');
      act(() => codons.set({ start: 3, end: 5, strand: 1, source: 'sequence' }));
      await waitFor(() =>
        expect(
          useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered
        ).toMatchObject({ chain: 'A', position: 2 })
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      const residue = useStructure3dStore.getState().interactionState[STRUCTURE_ID]!.hovered!;
      if (surface === 'MolStar') act(() => hookMocks.latestMolstarOptions?.onHover?.(residue));
      else fireEvent.mouseEnter(screen.getByTestId('residue-A-2'));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      expect(codons.getSnapshot()).toMatchObject({ start: 3, end: 5, source: 'structure' });
      act(() => {
        if (codons.getSnapshot()?.source === 'sequence') codons.set(null);
      });
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
        chain: 'A',
        position: 2,
      });
      if (surface === 'MolStar') act(() => hookMocks.latestMolstarOptions?.onHover?.(null));
      else fireEvent.mouseLeave(screen.getByTestId('residue-A-2'));
      await waitFor(() =>
        expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toBeNull()
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      expect(codons.getSnapshot()).toBeNull();
      expect(residues.getSnapshot()).toBeNull();
    }
  );

  it('clears protein cross-hover when the genuine structure pointer enters a ligand', async () => {
    const codons = createHoveredCodonStore();
    const residues = createHoveredResidueStore();
    render(
      <HoveredCodonProvider value={codons}>
        <HoveredResidueProvider value={residues}>
          <Structure3dPanel structureId={STRUCTURE_ID} />
        </HoveredResidueProvider>
      </HoveredCodonProvider>
    );
    await screen.findByTestId('molstar-viewer-stub');
    act(() => {
      codons.set({ start: 3, end: 5, strand: 1, source: 'sequence' });
      residues.set({ structureId: STRUCTURE_ID, chain: 'A', position: 2 });
    });
    await waitFor(() =>
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
        chain: 'A',
        position: 2,
      })
    );
    act(() =>
      hookMocks.latestMolstarOptions?.onHover?.({ chain: 'A', position: 4, compId: 'ATP' })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]?.hovered).toMatchObject({
      compId: 'ATP',
    });
    expect(codons.getSnapshot()).toBeNull();
    expect(residues.getSnapshot()).toBeNull();
  });

  it('remounts Molstar when the structure provider identity changes', async () => {
    useStructure3dStore.setState({
      interactionState: {
        [STRUCTURE_ID]: {
          hovered: { chain: 'A', position: 1 },
          selected: [{ chain: 'A', position: 2 }],
        },
      },
      selectionAnchor: {
        [STRUCTURE_ID]: { chain: 'A', position: 2 },
      },
    });
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() => expect(hookMocks.molstarMounts).toBe(1));
    expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]).toMatchObject({
      hovered: { chain: 'A', position: 1 },
      selected: [{ chain: 'A', position: 2 }],
    });

    act(() => {
      useStructure3dStore.getState().updateStructureData(STRUCTURE_ID, {
        source: 'alphafold',
        sourceId: 'P0AD87',
        providerIdentityKey: 'AF:P0AD87:F1:V6:MODEL:AF-P0AD87-F1-model_v6',
        accession: 'P0AD87',
        fragment: 'F1',
        version: 'V6',
        modelId: 'AF-P0AD87-F1-model_v6',
        label: 'thrA',
        colorMode: 'plddt',
        showSequenceViewer: true,
        highlightGroups: [],
      });
    });

    await waitFor(() => expect(hookMocks.molstarMounts).toBe(2));
    expect(hookMocks.molstarUnmounts).toBe(1);
    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState[STRUCTURE_ID]).toEqual({
        hovered: null,
        selected: [],
      });
      expect(useStructure3dStore.getState().selectionAnchor[STRUCTURE_ID]).toBeNull();
    });
    await waitFor(() => {
      expect(latestLoadedHighlightState()).toEqual({ hovered: null, selected: [] });
    });
  });

  it('dismisses the structure context menu on a primary pointer-down captured above Molstar', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const panel = await screen.findByTestId('structure-3d-panel');
    fireEvent.contextMenu(panel, { clientX: 120, clientY: 160 });
    expect(screen.getByTestId('structure-context-menu')).toBeInTheDocument();

    fireEvent.pointerDown(await screen.findByTestId('molstar-viewer-stub'), { button: 0 });
    expect(screen.queryByTestId('structure-context-menu')).not.toBeInTheDocument();
  });

  it('suppresses canvas contextmenu until the right-button release classifier completes', async () => {
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const panel = await screen.findByTestId('structure-3d-panel');
    const canvas = document.createElement('canvas');
    panel.appendChild(canvas);

    fireEvent.contextMenu(canvas, { clientX: 120, clientY: 160 });
    expect(screen.queryByTestId('structure-context-menu')).not.toBeInTheDocument();

    act(() => {
      hookMocks.latestClickDetectionOptions?.onRightClick?.({
        x: 120,
        y: 160,
        target: canvas,
      });
    });
    expect(screen.getByTestId('structure-context-menu')).toBeInTheDocument();
  });

  it('disables Ask AI when the selected coordinate cannot resolve one residue identity', async () => {
    useStructure3dStore.setState({
      interactionState: {
        [STRUCTURE_ID]: {
          hovered: null,
          selected: [{ chain: 'A', position: 999 }],
        },
      },
    });
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const panel = await screen.findByTestId('structure-3d-panel');
    fireEvent.contextMenu(panel, { clientX: 120, clientY: 160 });

    expect(
      screen.getByRole('menuitem', { name: 'Ask AI about selected residue A:999' })
    ).toBeDisabled();
  });

  it('disables Ask AI when an exact selection exceeds the model-context residue limit', async () => {
    useStructure3dStore.setState({
      interactionState: {
        [STRUCTURE_ID]: {
          hovered: null,
          selected: Array.from({ length: 201 }, (_, index) => ({
            chain: 'A',
            position: index + 1,
            labelCompId: 'GLY',
          })),
        },
      },
    });
    render(<Structure3dPanel structureId={STRUCTURE_ID} />);

    const panel = await screen.findByTestId('structure-3d-panel');
    fireEvent.contextMenu(panel, { clientX: 120, clientY: 160 });

    expect(
      screen.getByRole('menuitem', { name: 'Ask AI about 201 selected residues' })
    ).toBeDisabled();
  });
});
