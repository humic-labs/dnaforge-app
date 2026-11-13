import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadedViewer } from './LoadedViewer';
import { useStructure3dStore } from '../store';
import type { ResidueLocation, Structure3dAttrs, StructureSelectionGesture } from '../types';
import { STRUCTURE_CONTEXT_COLOR } from '../utils/structureRenderModel';

const hookMocks = vi.hoisted(() => {
  const defaultChains = [
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
      ],
    },
    {
      chainId: 'H',
      chainLabel: 'Chain H',
      baseChain: 'H',
      labelAsymId: 'H',
      authAsymId: 'B',
      entityId: '2',
      sequence: 'GA',
      residues: [
        { position: 1, name: 'G', name3: 'GLY', value: 90 },
        { position: 2, name: 'A', name3: 'ALA', value: 88 },
      ],
    },
  ];

  return {
    latestMolstarOptions: null as null | {
      onHover?: (residue: ResidueLocation | null) => void;
      onClick?: (residue: ResidueLocation, gesture: StructureSelectionGesture) => void;
      onBlankPrimaryClick?: () => void;
    },
    latestMolstarProps: null as null | {
      chainColoring?: {
        colorByChainId: ReadonlyMap<string, string>;
        molstarPalette: readonly number[];
      };
      renderModel?: {
        detailMemberIds?: string[];
        detailChainInstanceIds?: string[];
        molstarPalette: readonly number[];
        chainRows: Array<{
          chain: { chainId: string };
          detailState: 'detail' | 'context';
          displayColor: string;
        }>;
      };
    },
    latestMolstarError: null as null | ((message: string) => void),
    autoLoad: true,
    handleResidueSelect: vi.fn(),
    handleResiduesSelect: vi.fn(),
    useResidueHighlight: vi.fn(),
    useSelectionSideChainOverlay: vi.fn(),
    useMolstarInteraction: vi.fn(),
    molstarMounts: 0,
    molstarUnmounts: 0,
    defaultChains,
    sequenceData: {
      chains: [...defaultChains],
      ligands: [] as Array<{
        name: string;
        chainId: string;
        position: number;
        atomCount: number;
        baseChain?: string;
        labelAsymId?: string;
        authAsymId?: string;
        entityId?: string;
        operator?: string;
      }>,
    },
  };
});

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
  const plugin = { id: 'loaded-viewer-molstar-plugin-stub' };

  return {
    MolstarViewer: ({
      onPluginReady,
      onLoad,
      onError,
      ...props
    }: {
      onPluginReady?: (plugin: unknown) => void;
      onLoad?: () => void;
      onError?: (message: string) => void;
      chainColoring?: {
        colorByChainId: ReadonlyMap<string, string>;
        molstarPalette: readonly number[];
      };
      renderModel?: {
        detailMemberIds?: string[];
        detailChainInstanceIds?: string[];
        molstarPalette: readonly number[];
        chainRows: Array<{
          chain: { chainId: string };
          detailState: 'detail' | 'context';
          displayColor: string;
        }>;
      };
    }) => {
      hookMocks.latestMolstarProps = props;
      hookMocks.latestMolstarError = onError ?? null;
      React.useEffect(() => {
        hookMocks.molstarMounts += 1;
        return () => {
          hookMocks.molstarUnmounts += 1;
        };
      }, []);
      React.useEffect(() => {
        onPluginReady?.(plugin);
        if (hookMocks.autoLoad) onLoad?.();
      }, [onLoad, onPluginReady]);
      return React.createElement('div', { 'data-testid': 'molstar-viewer-stub' });
    },
  };
});

vi.mock('../hooks', () => ({
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
  useClickDetection: vi.fn(() => ({})),
  useHoveredResidueName: vi.fn(() => undefined),
  useHighlightActions: vi.fn(() => ({
    handleSaveSelection: vi.fn(),
    handleActivateHighlight: vi.fn(),
    handleDeleteHighlight: vi.fn(),
    handleRenameHighlight: vi.fn(),
  })),
  useSavedSelectionProjections: vi.fn(() => ({ groups: [], errors: [] })),
  useViewerSettings: vi.fn(
    ({
      attrs,
      updateAttrs,
    }: {
      attrs?: Structure3dAttrs;
      updateAttrs: (updates: Partial<Structure3dAttrs>) => void;
    }) => ({
      handleSelectRecipe: vi.fn(),
      handleColorModeChange: vi.fn(),
      handleShowWaterChange: vi.fn(),
      handleSpinChange: vi.fn(),
      handleAdvancedSettingsChange: vi.fn(),
      handleToggleDetailMember: (memberId: string, visible: boolean) => {
        const view = attrs?.view ?? {
          schemaVersion: 1 as const,
          activeRecipeId: 'query-in-complex',
          recipe: {
            schemaVersion: 1 as const,
            id: 'query-in-complex',
            name: 'Query in Complex',
            origin: 'builtin' as const,
            layers: [],
          },
          showWater: false,
          spin: false,
        };
        const detailIds = new Set(
          view.detailMemberIds ?? (attrs?.scene ? [attrs.scene.queryAnchor.memberId] : [])
        );
        if (visible) detailIds.add(memberId);
        else detailIds.delete(memberId);
        updateAttrs({ view: { ...view, detailMemberIds: [...detailIds] } });
      },
      handleToggleDetailChain: (
        chainInstanceId: string,
        visible: boolean,
        currentVisibleChainInstanceIds: readonly string[]
      ) => {
        const view = attrs?.view ?? {
          schemaVersion: 1 as const,
          activeRecipeId: 'query-in-complex',
          recipe: {
            schemaVersion: 1 as const,
            id: 'query-in-complex',
            name: 'Query in Complex',
            origin: 'builtin' as const,
            layers: [],
          },
          showWater: false,
          spin: false,
        };
        const detailIds = new Set(view.detailChainInstanceIds ?? currentVisibleChainInstanceIds);
        if (visible) detailIds.add(chainInstanceId);
        else detailIds.delete(chainInstanceId);
        updateAttrs({ view: { ...view, detailChainInstanceIds: [...detailIds] } });
      },
      handleToggleLayerVisibility: vi.fn(),
      handleLayerRepresentationChange: vi.fn(),
      handleLayerTargetChange: vi.fn(),
      handleLayerColorChange: vi.fn(),
      handleLayerAlphaChange: vi.fn(),
      handleResetLayerOverrides: vi.fn(),
    })
  ),
  useSavedSelectionEdit: vi.fn(() => ({
    handleResidueSelect: hookMocks.handleResidueSelect,
    handleResiduesSelect: hookMocks.handleResiduesSelect,
  })),
  useFocusClick: vi.fn(() => vi.fn()),
  useSelectionActions: vi.fn(() => ({
    handleClearSelection: vi.fn(),
    handleClearUserSelection: vi.fn(),
    handleResetCamera: vi.fn(),
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

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.clearAllMocks();
  hookMocks.latestMolstarOptions = null;
  hookMocks.latestMolstarProps = null;
  hookMocks.latestMolstarError = null;
  hookMocks.autoLoad = true;
  hookMocks.handleResidueSelect.mockReset();
  hookMocks.handleResiduesSelect.mockReset();
  hookMocks.molstarMounts = 0;
  hookMocks.molstarUnmounts = 0;
  hookMocks.sequenceData.chains = hookMocks.defaultChains.map((chain) => ({
    ...chain,
    residues: [...chain.residues],
  }));
  hookMocks.sequenceData.ligands = [];
  resetStructureStore();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

describe('LoadedViewer scoped RCSB regression', () => {
  it('retains the actual sequence and its mounted region after a 3D rendering failure', async () => {
    render(
      <LoadedViewer
        attrs={{ source: 'alphafold', sourceId: 'P0AD86' }}
        onUpdateAttrs={vi.fn()}
        structureId="inline-sequence-rendering-failure"
      />
    );
    const residue = await screen.findByTestId('residue-A-1');
    const sequence = screen.getByRole('region', { name: 'Structure sequence' });
    expect(hookMocks.latestMolstarError).toBeTypeOf('function');
    act(() => hookMocks.latestMolstarError!('Could not load structure.'));
    expect(await screen.findByRole('button', { name: 'Try different ID' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Structure sequence' })).toBe(sequence);
    expect(screen.getByTestId('residue-A-1')).toBe(residue);
    expect(residue).toBeVisible();
  });

  it('keeps its sequence region from initial loading through a failed first load', async () => {
    hookMocks.autoLoad = false;
    render(
      <LoadedViewer
        attrs={{ source: 'alphafold', sourceId: 'P0AD86' }}
        onUpdateAttrs={vi.fn()}
        structureId="inline-sequence-first-load-failure"
      />
    );
    const sequence = screen.getByRole('region', { name: 'Structure sequence' });
    expect(within(sequence).getByText('Loading sequence…')).toBeVisible();
    await waitFor(() => expect(hookMocks.latestMolstarError).toBeTypeOf('function'));
    act(() => hookMocks.latestMolstarError!('Could not load structure.'));
    expect(await screen.findByRole('button', { name: 'Try different ID' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Structure sequence' })).toBe(sequence);
    expect(within(sequence).getByRole('alert')).toHaveTextContent(
      'The sequence could not be read from this structure.'
    );
    expect(screen.queryByTestId('residue-A-1')).toBeNull();
  });

  it.each([undefined, false])(
    'always presents inline sequence with legacy visibility %s',
    async (showSequenceViewer) => {
      localStorage.setItem(
        'dnaforge:structure-viewer-preferences',
        JSON.stringify({ state: { showSequenceByDefault: false }, version: 0 })
      );
      render(
        <LoadedViewer
          attrs={{ source: 'alphafold', sourceId: 'P0AD86', showSequenceViewer }}
          onUpdateAttrs={vi.fn()}
          structureId="inline-sequence-presence"
        />
      );
      expect(await screen.findByTestId('residue-A-1')).toBeVisible();
      expect(screen.getByTestId('structure-sequence-viewer')).toBeVisible();
      expect(screen.queryByRole('button', { name: /^(Show|Hide) sequence$/ })).toBeNull();
    }
  );

  it('keeps authored-scene recoloring available and saves its scene and camera in the page embed', async () => {
    const original = JSON.stringify({ root: { kind: 'root' }, metadata: { title: 'Original' } });
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      sourceId: 'P0AD86',
      label: 'retained-label',
      molViewSpec: original,
      molViewSpecSnapshotIndex: 2,
      cameraSnapshot: 'old-camera',
    };
    const update = vi.fn();
    render(<LoadedViewer attrs={attrs} onUpdateAttrs={update} structureId="inline-colors" />);
    await screen.findByTestId('molstar-viewer-stub');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings', exact: true }));
    const color = screen.getByRole('button', { name: 'Color structure', exact: true });
    expect(color).toBeEnabled();
    expect(color).toHaveAttribute('data-scene', original);
    expect(color).toHaveAttribute('data-index', '2');
    fireEvent.click(color);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        molViewSpec: 'changed-scene',
        molViewSpecSnapshotIndex: 2,
        cameraSnapshot: 'retained-camera',
        source: attrs.source,
        sourceId: attrs.sourceId,
        label: attrs.label,
      })
    );
  });

  it('forwards page-embed Shift-chain ranges and Command toggles through the shared handler', async () => {
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      sourceId: 'P0AD86',
      label: 'thrL',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-thrl" />);

    fireEvent.click(await screen.findByTestId('chain-selection-toggle-A'));
    fireEvent.click(screen.getByTestId('chain-selection-toggle-H'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('chain-selection-toggle-H'), { metaKey: true });
    expect(hookMocks.handleResiduesSelect).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        expect.objectContaining({ chain: 'A', position: 1, authAsymId: 'H' }),
        expect.objectContaining({ chain: 'H', position: 2, authAsymId: 'B' }),
      ]),
      'range'
    );
    expect(hookMocks.handleResiduesSelect).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining([
        expect.objectContaining({ chain: 'H', position: 1, authAsymId: 'B' }),
      ]),
      'toggle'
    );
  });

  it('forwards plain then Shift-clicked amino-acid letters from a page embed', async () => {
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      sourceId: 'P0AD86',
      label: 'thrL',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-thrl" />);

    fireEvent.click(await screen.findByTestId('residue-A-1'));
    fireEvent.click(screen.getByTestId('residue-A-2'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('residue-A-2'), { metaKey: true });

    const orderedInventory = [1, 2].map((position) =>
      expect.objectContaining({ chain: 'A', position, authAsymId: 'H' })
    );

    expect(hookMocks.handleResidueSelect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chain: 'A',
        position: 1,
        labelCompId: 'MET',
        authAsymId: 'H',
      }),
      'replace',
      orderedInventory
    );
    expect(hookMocks.handleResidueSelect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chain: 'A',
        position: 2,
        labelCompId: 'LYS',
        authAsymId: 'H',
      }),
      'range',
      orderedInventory
    );
    expect(hookMocks.handleResidueSelect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ chain: 'A', position: 2, authAsymId: 'H' }),
      'toggle',
      orderedInventory
    );
  });

  it('upgrades a stale scoped 6OQT single-query scene into a focusable complex after full-entry chain discovery', async () => {
    hookMocks.sequenceData.chains = [
      chainSequence({ chainId: 'A', entityId: '1', label: 'ATP synthase subunit alpha' }),
      chainSequence({ chainId: 'B', entityId: '2', label: 'ATP synthase subunit beta' }),
      chainSequence({ chainId: 'G', entityId: '7', label: 'ATP synthase gamma chain' }),
      chainSequence({ chainId: 'Q', entityId: '7', label: 'ATP synthase gamma chain copy' }),
      chainSequence({ chainId: 'H', entityId: '8', label: 'ATP synthase epsilon chain' }),
      chainSequence({ chainId: 'L', entityId: '9', label: 'ATP synthase c-ring chain' }),
    ];
    const initialAttrs = scoped6oqtSingleQueryAttrs();
    const updates: Structure3dAttrs[] = [];

    function StatefulHarness() {
      const [attrs, setAttrs] = useState(initialAttrs);
      return (
        <LoadedViewer
          attrs={attrs}
          onUpdateAttrs={(nextAttrs) => {
            updates.push(nextAttrs);
            setAttrs(nextAttrs);
          }}
          structureId="inline-6oqt"
        />
      );
    }

    render(<StatefulHarness />);

    await screen.findByTestId('structure-chain-table');
    expect(screen.queryByTestId('structure-member-focus-strip')).not.toBeInTheDocument();
    const gRow = screen.getByTestId('chain-track-G');
    const aRow = screen.getByTestId('chain-track-A');
    const qRow = screen.getByTestId('chain-track-Q');
    expect(within(gRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth G'
    );
    expect(within(aRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth A'
    );
    expect(within(qRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth Q'
    );
    expect(within(gRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'entity 7'
    );
    expect(within(qRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'entity 7'
    );
    expect(within(aRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'entity 1'
    );
    expect(gRow).not.toHaveTextContent('auth G');
    expect(gRow).not.toHaveTextContent('entity 7');
    expect(aRow).not.toHaveTextContent('auth A');
    expect(aRow).not.toHaveTextContent('entity 1');
    expect(qRow).not.toHaveTextContent('auth Q');
    expect(qRow).not.toHaveTextContent('entity 7');
    expect(
      within(screen.getByTestId('structure-chain-table'))
        .getAllByTestId(/^chain-track-/)
        .map((row) => row.getAttribute('data-testid'))[0]
    ).toBe('chain-track-G');
    expect(await screen.findByTestId('residue-A-2')).toBeInTheDocument();
    expect(await screen.findByTestId('residue-G-2')).toBeInTheDocument();

    const promoted = updates.find((update) => update.scene?.sceneKind === 'complex');
    expect(promoted?.scene?.primaryResourceId).toBe('RCSB:6OQT:ENTRY');
    expect(promoted?.scene?.queryAnchor).toBe(initialAttrs.scene?.queryAnchor);
    expect(promoted?.scene?.members.length).toBeGreaterThanOrEqual(5);
    expect(promoted?.view?.activeRecipeId).toBe('query-in-complex');
    expect(screen.queryByTestId('structure-detail-rail')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('chain-track-G')).getByRole('checkbox', {
        name: 'Show ATP synthase gamma chain in detail',
      })
    ).toBeChecked();
    expect(
      within(screen.getByTestId('chain-track-A')).getByRole('checkbox', {
        name: 'Show ATP synthase subunit alpha in detail',
      })
    ).not.toBeChecked();
    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-detail-state', 'detail');
    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-chain-color', '#1f77ff');
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-detail-state', 'context');
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute(
      'data-chain-color',
      STRUCTURE_CONTEXT_COLOR
    );
    expect(screen.getByTestId('chain-track-Q')).toHaveAttribute('data-detail-state', 'context');
    expect(screen.getByTestId('chain-track-Q')).toHaveAttribute(
      'data-chain-color',
      STRUCTURE_CONTEXT_COLOR
    );
    expect(screen.getByTestId('residue-A-2')).toHaveAttribute('data-detail-state', 'context');
    expect(screen.getByTestId('residue-Q-2')).toHaveAttribute('data-detail-state', 'context');
    expect(screen.getByTestId('residue-G-2').style.backgroundColor).toBe('transparent');
    expect(screen.getByTestId('residue-G-2').style.color).toBe('rgb(31, 119, 255)');
    await waitFor(() =>
      expect(hookMocks.latestMolstarProps?.chainColoring?.colorByChainId.get('G')).toBe('#1f77ff')
    );
    expect(hookMocks.latestMolstarProps?.chainColoring?.colorByChainId.get('Q')).toBe('#ff7f0e');
    expect(hookMocks.latestMolstarProps?.chainColoring?.molstarPalette).toEqual([
      0xe6194b, 0x2ca02c, 0x1f77ff, 0xff7f0e, 0x8a2be2, 0x00a6d6,
    ]);
    expect(hookMocks.latestMolstarProps?.renderModel?.detailMemberIds).toEqual(['member:atpG']);
    expect(hookMocks.latestMolstarProps?.renderModel?.detailChainInstanceIds).toEqual(['g-g-7-g']);
    expect(hookMocks.latestMolstarProps?.renderModel?.molstarPalette).toEqual(
      hookMocks.latestMolstarProps?.chainColoring?.molstarPalette
    );
    expect(
      hookMocks.latestMolstarProps?.renderModel?.chainRows.map((row) => [
        row.chain.chainId,
        row.detailState,
        row.displayColor,
      ])
    ).toEqual(
      expect.arrayContaining([
        ['G', 'detail', '#1f77ff'],
        ['A', 'context', STRUCTURE_CONTEXT_COLOR],
        ['Q', 'context', STRUCTURE_CONTEXT_COLOR],
      ])
    );

    fireEvent.click(
      within(screen.getByTestId('chain-track-A')).getByRole('checkbox', {
        name: 'Show ATP synthase subunit alpha in detail',
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-detail-state', 'detail')
    );
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-chain-color', '#e6194b');
    const detailUpdate = updates.at(-1);
    expect(detailUpdate?.scene?.queryAnchor).toBe(initialAttrs.scene?.queryAnchor);
    expect(detailUpdate?.view?.detailChainInstanceIds).toEqual(
      expect.arrayContaining(['g-g-7-g', 'a-a-1-a'])
    );

    fireEvent.click(
      within(screen.getByTestId('chain-track-Q')).getByRole('checkbox', {
        name: 'Show ATP synthase gamma chain copy in detail',
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('chain-track-Q')).toHaveAttribute('data-detail-state', 'detail')
    );
    expect(screen.getByTestId('chain-track-Q')).toHaveAttribute('data-chain-color', '#ff7f0e');
    expect(updates.at(-1)?.view?.detailChainInstanceIds).toEqual(
      expect.arrayContaining(['g-g-7-g', 'a-a-1-a', 'q-q-7-q'])
    );

    expect(hookMocks.molstarMounts).toBe(1);
    expect(hookMocks.molstarUnmounts).toBe(0);
    expect(screen.getByTestId('molstar-viewer-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-focus-select')).not.toBeInTheDocument();
  });

  it('offers narrow recipe controls without showing a dead focus picker', async () => {
    hookMocks.sequenceData.chains = [
      chainSequence({ chainId: 'G', entityId: '2', label: 'ATP synthase gamma chain' }),
      chainSequence({ chainId: 'E', entityId: '3', label: 'ATP synthase epsilon chain' }),
    ];
    const onUpdateAttrs = vi.fn();
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      label: 'atpG complex',
      colorMode: 'chain',
      showSequenceViewer: true,
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpg',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: {
            pdbId: '1FS0',
            entityIds: ['2'],
            authAsymIds: ['G'],
          },
        },
        activeFocus: {
          memberId: 'member:atpG',
          role: 'query_anchor',
          mappingStatus: 'mapped_current_sequence',
          selection: {
            pdbId: '1FS0',
            entityIds: ['2'],
            authAsymIds: ['G'],
          },
        },
        members: [
          {
            memberId: 'member:atpG',
            kind: 'protein',
            displayName: 'ATP synthase gamma chain',
            pdbEntityId: '2',
            authAsymIds: ['G'],
            selection: {
              providerIdentityKey: 'RCSB:1FS0:ENTRY',
              pdbId: '1FS0',
              entityIds: ['2'],
              authAsymIds: ['G'],
            },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
          {
            memberId: 'member:atpC',
            kind: 'protein',
            displayName: 'ATP synthase epsilon chain',
            pdbEntityId: '3',
            authAsymIds: ['E'],
            selection: {
              providerIdentityKey: 'RCSB:1FS0:ENTRY',
              pdbId: '1FS0',
              entityIds: ['3'],
              authAsymIds: ['E'],
            },
            relationToAnchor: 'known_partner',
            mappingStatus: 'mapped_workspace',
          },
        ],
        layers: [],
        provenance: {
          createdBy: 'structure-drawer',
          provider: 'pdb',
        },
      },
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={onUpdateAttrs} structureId="inline-atpg" />);

    fireEvent.click(await screen.findByTestId('structure-advanced-settings-toggle'));
    const recipeTrigger = await screen.findByRole('button', { name: 'Structure view' });
    expect(recipeTrigger).toHaveTextContent(/Cartoon/i);
    fireEvent.click(recipeTrigger);

    expect(await screen.findByText('Cartoon Context')).toBeInTheDocument();
    expect(await screen.findByText('Surface Context')).toBeInTheDocument();
    expect(await screen.findByText('Solid Surface Context')).toBeInTheDocument();
    expect(await screen.findByText('Styled Spacefill')).toBeInTheDocument();
    expect(
      await screen.findByTestId('structure-view-recipe-option-ball-and-stick')
    ).toHaveTextContent('Atomic Detail');
    expect(
      screen.queryByTestId('structure-view-recipe-option-atomic-detail')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('structure-view-recipe-option-surface-detail')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('structure-view-recipe-option-confidence')).not.toBeInTheDocument();
    expect(screen.queryByText('Query in Complex')).not.toBeInTheDocument();
    expect(screen.queryByText('Opaque Context')).not.toBeInTheDocument();
    expect(screen.queryByText('Focus in Context')).not.toBeInTheDocument();

    await screen.findByTestId('structure-chain-table');
    expect(screen.queryByTestId('structure-member-focus-strip')).not.toBeInTheDocument();
    const gRow = screen.getByTestId('chain-track-G');
    const eRow = screen.getByTestId('chain-track-E');
    expect(within(gRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth G'
    );
    expect(within(eRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth E'
    );
    expect(within(gRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'entity 2'
    );
    expect(within(eRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'entity 3'
    );
    expect(gRow).not.toHaveTextContent('auth G');
    expect(gRow).not.toHaveTextContent('entity 2');
    expect(eRow).not.toHaveTextContent('auth E');
    expect(eRow).not.toHaveTextContent('entity 3');

    expect(screen.queryByTestId('structure-focus-select')).not.toBeInTheDocument();
  });

  it('keeps partner chain rows visible for complex scenes with a scoped query anchor', async () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY:ENTITY:1',
      providerIdentityKey: 'RCSB:1FS0:ENTRY:ENTITY:1',
      pdbId: '1FS0',
      pdbEntityId: '1',
      authAsymIds: ['H'],
      label: 'atpG complex',
      colorMode: 'chain',
      showSequenceViewer: true,
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpg',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: {
            pdbId: '1FS0',
            entityIds: ['1'],
            authAsymIds: ['H'],
          },
        },
        activeFocus: {
          memberId: 'member:atpG',
          role: 'query_anchor',
          mappingStatus: 'mapped_current_sequence',
          selection: {
            pdbId: '1FS0',
            entityIds: ['1'],
            authAsymIds: ['H'],
          },
        },
        members: [
          {
            memberId: 'member:atpG',
            kind: 'protein',
            displayName: 'ATP synthase gamma chain',
            pdbEntityId: '1',
            authAsymIds: ['H'],
            selection: {
              providerIdentityKey: 'RCSB:1FS0:ENTRY',
              pdbId: '1FS0',
              entityIds: ['1'],
              authAsymIds: ['H'],
            },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
          {
            memberId: 'member:atpC',
            kind: 'protein',
            displayName: 'ATP synthase epsilon chain',
            pdbEntityId: '2',
            authAsymIds: ['B'],
            selection: {
              providerIdentityKey: 'RCSB:1FS0:ENTRY',
              pdbId: '1FS0',
              entityIds: ['2'],
              authAsymIds: ['B'],
            },
            relationToAnchor: 'known_partner',
            mappingStatus: 'mapped_workspace',
          },
        ],
        layers: [],
        provenance: {
          createdBy: 'structure-drawer',
          provider: 'pdb',
        },
      },
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-atpg" />);

    await screen.findByTestId('structure-chain-table');
    expect(screen.queryByTestId('structure-member-focus-strip')).not.toBeInTheDocument();
    const aRow = screen.getByTestId('chain-track-A');
    const hRow = screen.getByTestId('chain-track-H');
    expect(within(aRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth H'
    );
    expect(within(hRow).getByTestId('chain-header').getAttribute('data-detail-summary')).toContain(
      'auth B'
    );
    expect(aRow).not.toHaveTextContent('auth H');
    expect(hRow).not.toHaveTextContent('auth B');
    expect(await screen.findByTestId('residue-A-2')).toBeInTheDocument();
    expect(await screen.findByTestId('residue-H-2')).toBeInTheDocument();
  });

  it('filters inline viewer rows by auth_asym_id and ignores out-of-scope Molstar click writes', async () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      pdbId: '1RBL',
      authAsymIds: ['H'],
      label: '1RBL author chain H',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-1rbl" />);

    expect(await screen.findByTestId('residue-A-2')).toBeInTheDocument();
    expect(screen.queryByTestId('residue-H-2')).not.toBeInTheDocument();
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onClick).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.(
        {
          chain: 'H',
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
          position: 2,
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
          position: 2,
        },
        'replace'
      );
    });
    expect(hookMocks.handleResidueSelect).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'A', authAsymId: 'H', position: 2 }),
      'replace'
    );
  });

  it('filters inline viewer rows by entity id and ignores out-of-scope entity clicks', async () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:ENTITY:1',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:ENTITY:1',
      pdbId: '1RBL',
      pdbEntityId: '1',
      label: '1RBL entity 1',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-entity-1" />);

    expect(await screen.findByTestId('residue-A-2')).toBeInTheDocument();
    expect(screen.queryByTestId('residue-H-2')).not.toBeInTheDocument();
    await waitFor(() => expect(hookMocks.latestMolstarOptions?.onClick).toBeTypeOf('function'));

    act(() => {
      hookMocks.latestMolstarOptions?.onClick?.(
        {
          chain: 'H',
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
          entityId: '2',
          position: 2,
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
          position: 2,
        },
        'replace'
      );
    });
    expect(hookMocks.handleResidueSelect).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'A', entityId: '1', position: 2 }),
      'replace'
    );
  });

  it('keeps scoped ligand metadata when hovering and selecting sequence ligand rows', async () => {
    hookMocks.sequenceData.ligands = [
      {
        name: 'ATP',
        chainId: 'L1',
        position: 201,
        atomCount: 31,
        baseChain: 'A',
        labelAsymId: 'L',
        authAsymId: 'H',
        entityId: '1',
        operator: '1_555',
      },
      {
        name: 'HEM',
        chainId: 'M1',
        position: 301,
        atomCount: 43,
        baseChain: 'B',
        labelAsymId: 'M',
        authAsymId: 'B',
        entityId: '2',
      },
    ];
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      pdbId: '1RBL',
      authAsymIds: ['H'],
      label: '1RBL author chain H',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };

    render(<LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-ligand" />);

    const ligand = await screen.findByTestId('residue-L1-201');
    expect(screen.queryByTestId('residue-M1-301')).not.toBeInTheDocument();

    fireEvent.mouseEnter(ligand);
    await waitFor(() =>
      expect(
        useStructure3dStore.getState().interactionState['inline-ligand']?.hovered
      ).toMatchObject({
        chain: 'L1',
        compId: 'ATP',
        baseChain: 'A',
        labelAsymId: 'L',
        authAsymId: 'H',
        entityId: '1',
        operator: '1_555',
        position: 201,
      })
    );

    fireEvent.click(ligand);
    expect(hookMocks.handleResidueSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: 'L1',
        compId: 'ATP',
        baseChain: 'A',
        labelAsymId: 'L',
        authAsymId: 'H',
        entityId: '1',
        operator: '1_555',
        position: 201,
      }),
      'replace',
      [expect.objectContaining({ chain: 'L1', position: 201, compId: 'ATP' })]
    );
  });

  it('remounts and resets inline Molstar state when the source identity changes', async () => {
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      sourceId: 'P0AD86',
      providerIdentityKey: 'AF:P0AD86:F1:V6:MODEL:AF-P0AD86-F1-model_v6',
      accession: 'P0AD86',
      fragment: 'F1',
      version: 'V6',
      modelId: 'AF-P0AD86-F1-model_v6',
      label: 'thrL',
      colorMode: 'chain',
      showSequenceViewer: true,
      highlightGroups: [],
    };
    useStructure3dStore.setState({
      interactionState: {
        'inline-afdb': {
          hovered: { chain: 'A', position: 1 },
          selected: [{ chain: 'A', position: 2 }],
        },
      },
      selectionAnchor: {
        'inline-afdb': { chain: 'A', position: 2 },
      },
    });

    const { rerender } = render(
      <LoadedViewer attrs={attrs} onUpdateAttrs={vi.fn()} structureId="inline-afdb" />
    );

    await screen.findByTestId('molstar-viewer-stub');
    await waitFor(() => expect(hookMocks.molstarMounts).toBe(1));
    expect(useStructure3dStore.getState().interactionState['inline-afdb']).toMatchObject({
      hovered: { chain: 'A', position: 1 },
      selected: [{ chain: 'A', position: 2 }],
    });

    rerender(
      <LoadedViewer
        attrs={{
          ...attrs,
          sourceId: 'P0AD87',
          providerIdentityKey: 'AF:P0AD87:F1:V6:MODEL:AF-P0AD87-F1-model_v6',
          accession: 'P0AD87',
          modelId: 'AF-P0AD87-F1-model_v6',
          label: 'thrA',
        }}
        onUpdateAttrs={vi.fn()}
        structureId="inline-afdb"
      />
    );

    await waitFor(() => expect(hookMocks.molstarMounts).toBe(2));
    expect(hookMocks.molstarUnmounts).toBe(1);
    await waitFor(() => {
      expect(useStructure3dStore.getState().interactionState['inline-afdb']).toEqual({
        hovered: null,
        selected: [],
      });
      expect(useStructure3dStore.getState().selectionAnchor['inline-afdb']).toBeNull();
    });
  });
});

function scoped6oqtSingleQueryAttrs(): Structure3dAttrs {
  return {
    source: 'pdb',
    sourceId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
    providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
    pdbId: '6OQT',
    authAsymIds: ['G'],
    label: 'atpG',
    colorMode: 'chain',
    showSequenceViewer: true,
    scene: {
      schemaVersion: 1,
      sceneId: 'scene:live-6oqt',
      sceneKind: 'single_query',
      primaryResourceId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
      queryAnchor: {
        memberId: 'member:atpG',
        label: 'atpG',
        targetSelection: {
          providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
          pdbId: '6OQT',
          authAsymIds: ['G'],
          chainIds: ['G'],
        },
      },
      activeFocus: {
        memberId: 'member:atpG',
        role: 'query_anchor',
        mappingStatus: 'mapped_current_sequence',
        selection: {
          providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
          pdbId: '6OQT',
          authAsymIds: ['G'],
          chainIds: ['G'],
        },
      },
      members: [
        {
          memberId: 'member:atpG',
          kind: 'protein',
          displayName: 'ATP synthase gamma chain',
          authAsymIds: ['G'],
          selection: {
            providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
            pdbId: '6OQT',
            authAsymIds: ['G'],
            chainIds: ['G'],
          },
          relationToAnchor: 'query',
          mappingStatus: 'mapped_current_sequence',
        },
      ],
      layers: [
        {
          id: 'layer:model:RCSB:6OQT:ENTRY:AUTH_ASYM:G',
          kind: 'model',
          role: 'query',
          visible: true,
          source: {
            source: 'pdb',
            sourceId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
            providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
            pdbId: '6OQT',
          },
        },
      ],
      provenance: {
        createdBy: 'structure-drawer',
        provider: 'pdb',
        providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
      },
    },
  };
}

function chainSequence({
  chainId,
  entityId,
  label,
}: {
  chainId: string;
  entityId: string;
  label: string;
}) {
  return {
    chainId,
    chainLabel: label,
    baseChain: chainId,
    labelAsymId: chainId,
    authAsymId: chainId,
    entityId,
    sequence: 'MA',
    residues: [
      { position: 1, name: 'M', name3: 'MET', value: 90 },
      { position: 2, name: 'A', name3: 'ALA', value: 90 },
    ],
  };
}
