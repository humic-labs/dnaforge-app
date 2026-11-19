/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_CHAIN_TABLE_HEIGHT_PX,
  HIGH_CHAIN_COUNT_COLLAPSE_THRESHOLD,
  MAX_CHAIN_TABLE_HEIGHT_PX,
  MIN_CHAIN_TABLE_HEIGHT_PX,
  SequenceViewer,
} from './SequenceViewer';
import type {
  ChainSequence,
  ResidueInteractionState,
  StructureScene,
  StructureViewState,
} from '../types';

const CHAINS: ChainSequence[] = [
  makeChain('A', 1),
  makeChain('B', 101),
  makeChain('C', 201),
  makeChain('D', 301),
];

const INTERACTION_STATE: ResidueInteractionState = {
  hovered: null,
  selected: [],
};

describe('SequenceViewer chain table resize', () => {
  it('keeps the sequence present when an older caller passes visible=false', () => {
    const legacyLayout = { visible: false };
    render(
      <SequenceViewer
        {...legacyLayout}
        chains={CHAINS}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('structure-sequence-viewer')).toBeVisible();
    expect(screen.getByTestId('residue-A-1')).toBeVisible();
  });

  it('keeps an explicit sequence area for a structure without polymer chains', () => {
    render(
      <SequenceViewer
        chains={[]}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('This structure has no polymer sequence.')).toBeVisible();
  });

  it.each([
    ['loading', 'Loading sequence…', 'status'],
    ['unavailable', 'The sequence could not be read from this structure.', 'alert'],
  ] as const)('keeps the sequence area present while %s', (sequenceStatus, text, role) => {
    render(
      <SequenceViewer
        chains={[]}
        sequenceStatus={sequenceStatus}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('region', { name: 'Structure sequence' })).toBeVisible();
    expect(screen.getByRole(role)).toHaveTextContent(text);
  });

  it('uses its own scroll container only while rows exceed the available height', () => {
    renderViewer();
    const table = screen.getByTestId('structure-chain-table');
    const handle = screen.getByTestId('structure-chain-table-resize-handle');
    const height = vi.spyOn(table, 'clientHeight', 'get').mockReturnValue(100);
    vi.spyOn(table, 'scrollHeight', 'get').mockReturnValue(130);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(table).toHaveClass('overflow-y-auto');
    height.mockReturnValue(130);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(table).toHaveClass('overflow-y-clip');
  });

  it('starts manual resizing from the visible height when the pane constrained the initial table', () => {
    renderViewer();
    const table = screen.getByTestId('structure-chain-table');
    vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({ height: 140 } as DOMRect);
    fireEvent.keyDown(screen.getByTestId('structure-chain-table-resize-handle'), {
      key: 'ArrowUp',
    });
    expect(table.style.maxHeight).toBe('124px');
  });
  it('shows the first chain without mounting every sequence in a GroEL-sized first render', () => {
    const chains = Array.from({ length: 21 }, (_, index) =>
      makeChain(String.fromCharCode(65 + index), index * 500 + 1, {}, 400)
    );
    const html = renderToStaticMarkup(
      <SequenceViewer
        chains={chains}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(html.match(/data-testid="chain-track-/g)).toHaveLength(21);
    expect(html.match(/data-testid="residue-label"/g)).toHaveLength(400);
    expect(html.match(/data-testid="chain-sequence"/g)).toHaveLength(1);
  });

  it(': high chain counts start collapsed so ResidueBox mount stays bounded', () => {
    const chains = Array.from({ length: HIGH_CHAIN_COUNT_COLLAPSE_THRESHOLD }, (_, index) =>
      makeChain(String.fromCharCode(65 + (index % 26)) + index, index * 10 + 1)
    );
    renderViewer(undefined, chains);

    for (const chain of chains) {
      expect(screen.getByTestId(`chain-track-${chain.chainId}`)).toHaveAttribute(
        'data-collapsed',
        'collapsed'
      );
    }
    expect(document.querySelectorAll('[data-testid^="residue-"]').length).toBe(0);
  });

  it(': a manually expanded high-count chain survives a derived chain-model refresh', () => {
    const chains = Array.from({ length: HIGH_CHAIN_COUNT_COLLAPSE_THRESHOLD }, (_, index) =>
      makeChain(String.fromCharCode(65 + (index % 26)) + index, index * 10 + 1)
    );
    const props = {
      colorMode: 'chain' as const,
      interactionState: INTERACTION_STATE,
      onHover: vi.fn(),
      onSelect: vi.fn(),
    };
    const { rerender } = render(<SequenceViewer {...props} chains={chains} />);
    const firstChainId = chains[0].chainId;
    const firstToggle = screen.getByTestId(`chain-collapse-toggle-${firstChainId}`);

    expect(firstToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(firstToggle);
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true');

    rerender(<SequenceViewer {...props} chains={[...chains]} />);

    expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId(`chain-track-${firstChainId}`)).toHaveAttribute(
      'data-collapsed',
      'expanded'
    );
  });

  it('keeps high-chain sequences expanded after a parent rerender', () => {
    const chains = Array.from({ length: HIGH_CHAIN_COUNT_COLLAPSE_THRESHOLD }, (_, index) =>
      makeChain(String.fromCharCode(65 + (index % 26)) + index, index * 10 + 1)
    );
    const { rerender } = renderViewer(undefined, chains);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByTestId('chain-sequence')).toHaveLength(chains.length);

    rerender(
      <SequenceViewer
        chains={chains}
        colorMode="chain"
        interactionState={{ ...INTERACTION_STATE, hovered: null }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getAllByTestId('chain-sequence')).toHaveLength(chains.length);
  });

  it('defaults to a spacious multimer table height and resizes by dragging the handle', () => {
    renderViewer();

    const table = screen.getByTestId('structure-chain-table');
    const handle = screen.getByRole('separator', { name: 'Resize chain sequence table' });

    expect(table).toHaveStyle({ maxHeight: `${DEFAULT_CHAIN_TABLE_HEIGHT_PX}px` });
    expect(DEFAULT_CHAIN_TABLE_HEIGHT_PX).toBeGreaterThan(128);
    expect(table).not.toHaveClass('max-h-32');
    expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_CHAIN_TABLE_HEIGHT_PX));
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_CHAIN_TABLE_HEIGHT_PX));
    expect(handle).toHaveAttribute('aria-valuemax', String(MAX_CHAIN_TABLE_HEIGHT_PX));

    act(() => {
      fireEvent(handle, pointerEvent('pointerdown', DEFAULT_CHAIN_TABLE_HEIGHT_PX));
      fireEvent(window, pointerEvent('pointermove', 188));
    });

    expect(table).toHaveStyle({ maxHeight: '188px' });
    expect(handle).toHaveAttribute('aria-valuenow', '188');

    act(() => {
      fireEvent(window, pointerEvent('pointermove', 80));
      fireEvent(window, pointerEvent('pointerup', 80));
      fireEvent(window, pointerEvent('pointermove', 220));
    });

    expect(table).toHaveStyle({ maxHeight: '80px' });
    expect(handle).toHaveAttribute('aria-valuenow', '80');
  });

  it('supports keyboard resizing and clamps to the min/max table heights', () => {
    renderViewer();

    const table = screen.getByTestId('structure-chain-table');
    const handle = screen.getByRole('separator', { name: 'Resize chain sequence table' });

    fireEvent.keyDown(handle, { key: 'End' });
    expect(table).toHaveStyle({ maxHeight: `${MAX_CHAIN_TABLE_HEIGHT_PX}px` });
    expect(handle).toHaveAttribute('aria-valuenow', String(MAX_CHAIN_TABLE_HEIGHT_PX));

    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(table).toHaveStyle({ maxHeight: `${MAX_CHAIN_TABLE_HEIGHT_PX}px` });

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(table).toHaveStyle({ maxHeight: `${MIN_CHAIN_TABLE_HEIGHT_PX}px` });
    expect(handle).toHaveAttribute('aria-valuenow', String(MIN_CHAIN_TABLE_HEIGHT_PX));

    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(table).toHaveStyle({ maxHeight: `${MIN_CHAIN_TABLE_HEIGHT_PX}px` });
  });

  it('stacks each chain header above a full-width wrapping sequence', () => {
    renderViewer(makeTwoMemberComplexScene(), [
      makeChain('G', 1, { authAsymId: 'G', entityId: '7' }),
      makeChain('A', 101, { authAsymId: 'A', entityId: '1' }),
    ]);

    const row = screen.getByTestId('chain-track-G');
    const header = within(row).getByTestId('chain-header');
    const sequence = within(row).getByTestId('chain-sequence');

    expect(row).toHaveClass('flex', 'flex-col');
    expect(row).not.toHaveClass('grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]');
    expect(header).toHaveClass('px-2.5', 'py-1');
    expect(sequence).toHaveClass('flex-wrap', 'gap-x-0', 'gap-y-2.5', 'px-2.5', 'pt-2.5');
    expect(sequence).not.toHaveClass('overflow-x-auto');
  });

  it('offers a collapse-all toggle for multimers and collapses every chain', () => {
    renderViewer(makeTwoMemberComplexScene(), [
      makeChain('G', 1, { authAsymId: 'G', entityId: '7' }),
      makeChain('A', 101, { authAsymId: 'A', entityId: '1' }),
    ]);

    expect(
      within(screen.getByTestId('chain-track-G')).queryByTestId('chain-sequence')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('chain-track-A')).queryByTestId('chain-sequence')
    ).toBeInTheDocument();

    const firstHeader = within(screen.getByTestId('chain-track-G')).getByTestId('chain-header');
    const collapseAll = within(firstHeader).getByTestId('structure-chain-collapse-all');
    expect(within(firstHeader).getByText('2 chains')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('chain-track-A')).queryByTestId('structure-chain-collapse-all')
    ).toBeNull();
    expect(collapseAll).toHaveTextContent('Collapse all');
    fireEvent.click(collapseAll);

    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-collapsed', 'collapsed');
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-collapsed', 'collapsed');
    expect(screen.queryAllByTestId('chain-sequence')).toHaveLength(0);
    expect(collapseAll).toHaveTextContent('Expand all');

    fireEvent.click(collapseAll);
    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-collapsed', 'expanded');
    expect(screen.queryAllByTestId('chain-sequence')).toHaveLength(2);
  });

  it('collapses a single chain via its row chevron without touching the others', () => {
    renderViewer(makeTwoMemberComplexScene(), [
      makeChain('G', 1, { authAsymId: 'G', entityId: '7' }),
      makeChain('A', 101, { authAsymId: 'A', entityId: '1' }),
    ]);

    fireEvent.click(screen.getByTestId('chain-collapse-toggle-G'));

    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-collapsed', 'collapsed');
    expect(
      within(screen.getByTestId('chain-track-G')).queryByTestId('chain-sequence')
    ).not.toBeInTheDocument();

    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-collapsed', 'expanded');
    expect(
      within(screen.getByTestId('chain-track-A')).queryByTestId('chain-sequence')
    ).toBeInTheDocument();
  });

  it('does not render the collapse-all toolbar for a single-chain structure', () => {
    renderViewer(undefined, [makeChain('A', 1)]);
    expect(screen.queryByTestId('structure-chain-collapse-all')).not.toBeInTheDocument();

    expect(screen.getByTestId('chain-collapse-toggle-A')).toBeInTheDocument();
  });

  it('pins the query-anchor target chain at the top of the table list', () => {
    renderViewer(
      {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpG',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6OQT:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          label: 'atpG',
          targetSelection: {
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
            pdbId: '6OQT',
            authAsymIds: ['G'],
            chainIds: ['G'],
          },
        },
        members: [
          {
            memberId: 'member:atpA',
            kind: 'protein',
            displayName: 'ATP synthase subunit alpha',
            selection: { pdbId: '6OQT', authAsymIds: ['A'], chainIds: ['A'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'mapped_workspace',
          },
          {
            memberId: 'member:atpG',
            kind: 'protein',
            displayName: 'ATP synthase gamma chain',
            selection: { pdbId: '6OQT', authAsymIds: ['G'], chainIds: ['G'] },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
        ],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      [makeChain('A', 1), makeChain('G', 101), makeChain('B', 201), makeChain('C', 301)]
    );

    const table = screen.getByTestId('structure-chain-table');
    const rowIds = within(table)
      .getAllByTestId(/^chain-track-/)
      .map((row) => row.getAttribute('data-testid'));

    expect(rowIds[0]).toBe('chain-track-G');
    expect(rowIds).toEqual(['chain-track-G', 'chain-track-A', 'chain-track-B', 'chain-track-C']);
  });

  it('keeps each repeated-protomer row subtitle scoped to that row chain', () => {
    renderViewer(
      {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpG:repeated',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6OQT:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          label: 'atpG',
          targetSelection: {
            pdbId: '6OQT',
            entityIds: ['7'],
            authAsymIds: ['G'],
            chainIds: ['g1'],
          },
        },
        activeFocus: {
          memberId: 'member:atpG',
          role: 'query_anchor',
          mappingStatus: 'mapped_current_sequence',
          selection: {
            pdbId: '6OQT',
            entityIds: ['7'],
            authAsymIds: ['G'],
            chainIds: ['g1'],
          },
        },
        members: [
          {
            memberId: 'member:atpG',
            kind: 'protein',
            displayName: 'ATP synthase gamma chain',
            pdbEntityId: '7',
            selection: {
              pdbId: '6OQT',
              entityIds: ['7'],
              labelAsymIds: ['g1', 'q1'],
              authAsymIds: ['G', 'Q'],
              chainIds: ['g1', 'q1'],
            },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
          {
            memberId: 'member:atpA',
            kind: 'protein',
            displayName: 'ATP synthase subunit alpha',
            selection: { pdbId: '6OQT', entityIds: ['1'], authAsymIds: ['A'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'mapped_workspace',
          },
        ],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
      [
        makeChain('g1', 1, { authAsymId: 'G', entityId: '7' }),
        makeChain('q1', 101, { authAsymId: 'Q', entityId: '7' }),
        makeChain('A', 201, { authAsymId: 'A', entityId: '1' }),
      ],
      { detailControls: true }
    );

    const gRow = screen.getByTestId('chain-track-g1');
    const qRow = screen.getByTestId('chain-track-q1');
    const gHeader = within(gRow).getByTestId('chain-header');
    const qHeader = within(qRow).getByTestId('chain-header');

    expect(within(gRow).getByTestId('chain-primary-line')).toHaveTextContent('Chain G');
    expect(within(gRow).getByTestId('chain-primary-line')).toHaveTextContent(
      'ATP synthase gamma chain'
    );
    expect(within(gRow).queryByTestId('chain-meta-line')).not.toBeInTheDocument();
    expect(within(gRow).getByText('Chain G')).toBeInTheDocument();
    expect(gHeader.getAttribute('data-detail-summary')).toContain('auth G');
    expect(gHeader.getAttribute('data-detail-summary')).toContain('label g1');
    expect(gRow).not.toHaveTextContent('auth G');
    expect(gRow).not.toHaveTextContent('label g1');
    expect(gRow).not.toHaveTextContent('auth Q');
    expect(gRow).not.toHaveTextContent('label q1');

    expect(within(qRow).getByTestId('chain-primary-line')).toHaveTextContent('Chain Q');
    expect(within(qRow).getByTestId('chain-primary-line')).toHaveTextContent(
      'ATP synthase gamma chain'
    );
    expect(within(qRow).queryByTestId('chain-meta-line')).not.toBeInTheDocument();
    expect(within(qRow).getByText('Chain Q')).toBeInTheDocument();
    expect(qHeader.getAttribute('data-detail-summary')).toContain('auth Q');
    expect(qHeader.getAttribute('data-detail-summary')).toContain('label q1');
    expect(qRow).not.toHaveTextContent('auth Q');
    expect(qRow).not.toHaveTextContent('label q1');
    expect(qRow).not.toHaveTextContent('auth G');
    expect(qRow).not.toHaveTextContent('label g1');
  });

  it('uses chain instance ids, not raw chain ids, for detail visibility overrides', () => {
    const scene = makeTwoMemberComplexScene();
    const chains = [
      makeChain('G', 1, { authAsymId: 'G', entityId: '7' }),
      makeChain('A', 101, { authAsymId: 'A', entityId: '1' }),
    ];
    const { rerender } = renderViewer(scene, chains, {
      detailControls: true,
      view: viewWithDetailChainInstanceIds(['A']),
    });

    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-detail-state', 'context');
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-detail-state', 'context');

    rerender(
      <SequenceViewer
        chains={chains}
        colorMode="chain"
        scene={scene}
        view={viewWithDetailChainInstanceIds(['a-a-1-a'])}
        onToggleDetailChain={vi.fn()}
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('chain-track-G')).toHaveAttribute('data-detail-state', 'context');
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-detail-state', 'detail');
  });

  it('does not rerender unrelated chain rows when hover changes on one chain', () => {
    const scene = makeTwoMemberComplexScene();
    const chains = [
      makeChain('G', 1, { authAsymId: 'G', entityId: '7' }),
      makeChain('A', 101, { authAsymId: 'A', entityId: '1' }),
      makeChain('B', 201, { authAsymId: 'B', entityId: '2' }),
    ];
    const props = {
      chains,
      colorMode: 'chain' as const,
      scene,
      onToggleDetailChain: vi.fn(),
      onHover: vi.fn(),
      onSelect: vi.fn(),
    };
    const diagnosticsWindow = window as typeof window & {
      __WAYPOINT_SEQUENCE_TRACK_RENDER_DIAGNOSTICS__?: {
        total: number;
        byChain: Record<string, number>;
      };
    };

    const { rerender } = render(<SequenceViewer {...props} interactionState={INTERACTION_STATE} />);
    delete diagnosticsWindow.__WAYPOINT_SEQUENCE_TRACK_RENDER_DIAGNOSTICS__;

    rerender(
      <SequenceViewer
        {...props}
        interactionState={{
          hovered: { chain: 'G', position: 1, baseChain: 'G', authAsymId: 'G', entityId: '7' },
          selected: [],
        }}
      />
    );

    const diagnostics = diagnosticsWindow.__WAYPOINT_SEQUENCE_TRACK_RENDER_DIAGNOSTICS__;
    expect(diagnostics?.byChain.G ?? 0).toBeGreaterThan(0);
    expect(diagnostics?.byChain.A ?? 0).toBe(0);
    expect(diagnostics?.byChain.B ?? 0).toBe(0);
  });

  it('does not bubble detail checkbox clicks to parent preview selectors', () => {
    const scene = makeTwoMemberComplexScene();
    const chains = [
      makeChain('G', 1, { authAsymId: 'G', entityId: '7' }),
      makeChain('A', 101, { authAsymId: 'A', entityId: '1' }),
    ];
    const onParentClick = vi.fn();
    const onToggleDetailChain = vi.fn();

    render(
      <div onClick={onParentClick}>
        <SequenceViewer
          chains={chains}
          colorMode="chain"
          scene={scene}
          view={viewWithDetailChainInstanceIds(['g-g-7-g'])}
          onToggleDetailChain={onToggleDetailChain}
          interactionState={INTERACTION_STATE}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </div>
    );

    fireEvent.click(screen.getByTestId('structure-detail-chain-A'));

    expect(onToggleDetailChain).toHaveBeenCalledWith('a-a-1-a', true, expect.any(Array));
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('uses Shift for contiguous chain-row ranges and Command/Control for group toggles', () => {
    const chains = [
      makeChain('A', 1, { authAsymId: 'AUTH_A', entityId: '1' }),
      makeChain('B', 101, { authAsymId: 'AUTH_B', entityId: '2' }),
    ];
    const onSelectChain = vi.fn();

    render(
      <SequenceViewer
        chains={chains}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        onSelectChain={onSelectChain}
      />
    );

    fireEvent.click(screen.getByTestId('chain-selection-toggle-A'));
    expect(onSelectChain).toHaveBeenNthCalledWith(
      1,
      chains[0].residues.map((residue) => ({
        chain: 'A',
        position: residue.position,
        labelCompId: residue.name3,
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'AUTH_A',
        entityId: '1',
      })),
      'replace'
    );

    fireEvent.click(screen.getByTestId('chain-selection-toggle-B'), { shiftKey: true });
    expect(onSelectChain).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        expect.objectContaining({ chain: 'A', position: 1, labelCompId: 'ALA' }),
        expect.objectContaining({
          chain: 'B',
          position: 101,
          labelCompId: 'ALA',
          authAsymId: 'AUTH_B',
        }),
      ]),
      'range'
    );

    fireEvent.click(screen.getByTestId('chain-selection-toggle-B'), { metaKey: true });
    expect(onSelectChain).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining([
        expect.objectContaining({
          chain: 'B',
          position: 101,
          labelCompId: 'ALA',
          authAsymId: 'AUTH_B',
        }),
      ]),
      'toggle'
    );
  });
});

function renderViewer(
  scene?: StructureScene,
  chains: ChainSequence[] = CHAINS,
  options: { detailControls?: boolean; view?: StructureViewState } = {}
) {
  return render(
    <SequenceViewer
      chains={chains}
      colorMode="chain"
      scene={scene}
      view={options.view}
      onToggleDetailChain={options.detailControls ? vi.fn() : undefined}
      interactionState={INTERACTION_STATE}
      onHover={vi.fn()}
      onSelect={vi.fn()}
    />
  );
}

function viewWithDetailChainInstanceIds(
  detailChainInstanceIds: readonly string[]
): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: 'query-in-complex',
    recipe: {
      schemaVersion: 1,
      id: 'query-in-complex',
      name: 'Query in Complex',
      origin: 'builtin',
      layers: [],
    },
    detailMemberIds: ['member:atpG'],
    detailChainInstanceIds: [...detailChainInstanceIds],
    showWater: false,
    spin: false,
  };
}

function makeTwoMemberComplexScene(): StructureScene {
  return {
    schemaVersion: 1,
    sceneId: 'scene:mg1655:atpG:two-member',
    sceneKind: 'complex',
    primaryResourceId: 'RCSB:6OQT:ENTRY',
    queryAnchor: {
      memberId: 'member:atpG',
      label: 'atpG',
      targetSelection: {
        pdbId: '6OQT',
        entityIds: ['7'],
        authAsymIds: ['G'],
        chainIds: ['G'],
      },
    },
    activeFocus: {
      memberId: 'member:atpG',
      role: 'query_anchor',
      mappingStatus: 'mapped_current_sequence',
      selection: {
        pdbId: '6OQT',
        entityIds: ['7'],
        authAsymIds: ['G'],
        chainIds: ['G'],
      },
    },
    members: [
      {
        memberId: 'member:atpG',
        kind: 'protein',
        displayName: 'ATP synthase gamma chain',
        pdbEntityId: '7',
        selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
        relationToAnchor: 'query',
        mappingStatus: 'mapped_current_sequence',
      },
      {
        memberId: 'member:atpA',
        kind: 'protein',
        displayName: 'ATP synthase subunit alpha',
        pdbEntityId: '1',
        selection: { pdbId: '6OQT', entityIds: ['1'], authAsymIds: ['A'], chainIds: ['A'] },
        relationToAnchor: 'known_partner',
        mappingStatus: 'mapped_workspace',
      },
    ],
    layers: [],
    provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
  };
}

function makeChain(
  chainId: string,
  start: number,
  options: { authAsymId?: string; entityId?: string } = {},
  residueCount = 6
): ChainSequence {
  const residues = Array.from({ length: residueCount }, (_, index) => ({
    position: start + index,
    name: 'A',
    name3: 'ALA',
  }));

  return {
    chainId,
    chainLabel: `Chain ${chainId}`,
    baseChain: chainId,
    labelAsymId: chainId,
    authAsymId: options.authAsymId ?? chainId,
    entityId: options.entityId,
    sequence: residues.map((residue) => residue.name).join(''),
    residues,
  };
}

function pointerEvent(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, clientY });
}
