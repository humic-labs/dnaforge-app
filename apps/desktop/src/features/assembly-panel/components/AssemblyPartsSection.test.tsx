import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceDocumentRef } from '../../../shared/managed-sequence-document';

const sourceOpen = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn() }));
vi.mock('../../sequence/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sequence/sequence-document-repository')>()),
  resolveSequenceDocumentById: sourceOpen.resolve,
}));
vi.mock('../../document-opening/open-document', () => ({ openDocument: sourceOpen.open }));
import { useDesignStore } from '../../design/store';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/store';
import { useCanvasStore } from '../../canvas/store';
import { useSequenceStore } from '../../sequence/store';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { ASSEMBLY_SEGMENT_RAIL_WIDTH } from '../../design/colors';
import { useAssemblyColorSchemeStore } from '../../design/color-scheme-store';
import { AssemblyPartsSection } from './AssemblyPartsSection';
import { normalizeAssemblySlots } from '../../design/assembly-slots';
import { deriveAssemblyIssues, issuesBlockingGate } from '../../assembly/issues/assembly-issues';

describe('AssemblyPartsSection', () => {
  beforeEach(() => {
    sourceOpen.resolve.mockReset();
    sourceOpen.open.mockReset();
    useAssemblyColorSchemeStore.setState({ assemblyColorScheme: 'tailwind' });
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    useRichSequenceClipboardStore.getState().clear();
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [],
          activeTabId: null,
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    useSequenceStore.getState().clearAll();
  });

  it('renders parts and spacers without deferred inline presentation hosts', () => {
    const design = createDesign();
    design.topology = 'circular';
    design.spacers = [{ id: 'spacer-a', junctionIndex: 0, sequence: 'AAGC' }];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    render(<AssemblyPartsSection design={design} />);

    expect(screen.getAllByTestId('assembly-part-card-item')).toHaveLength(3);
    expect(screen.getByTestId('assembly-spacer-segment-0')).toBeInTheDocument();
    expect(document.querySelector('[data-assembly-inline-story-kind]')).toBeNull();
    expect(document.querySelector('[data-testid^="assembly-inline-"]')).toBeNull();
  });

  it('previews pointer part-card reorder before committing on release', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    expect(partOrder()).toEqual(['A', 'B', 'C']);
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    const items = screen.getAllByTestId('assembly-part-card-item');
    const shells = screen.getAllByTestId('assembly-part-card-shell');
    mockRect(items[0], { top: 0, height: 48 });
    mockRect(items[1], { top: 50, height: 48 });
    mockRect(items[2], { top: 100, height: 48 });
    mockRect(shells[0], { top: 0, height: 40 });
    mockRect(shells[1], { top: 50, height: 40 });
    mockRect(shells[2], { top: 100, height: 40 });

    fireEvent.pointerDown(screen.getByTestId('assembly-part-drag-handle-a'), {
      button: 0,
      pointerId: 7,
      clientY: 20,
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('assembly-part-card')[0]).toHaveAttribute(
        'data-dragging',
        'true'
      )
    );
    expect(
      within(screen.getAllByTestId('assembly-part-card')[0]).queryByTestId(
        'assembly-segment-top-inset'
      )
    ).not.toBeInTheDocument();
    expect(
      within(screen.getAllByTestId('assembly-part-card')[0]).queryByTestId(
        'assembly-segment-bottom-inset'
      )
    ).not.toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 140 }) as PointerEvent
      );
    });

    await waitFor(() => expect(items[0]).toHaveAttribute('data-reorder-shift', 'dragging'));
    expect(items[0]).toHaveAttribute('data-reorder-transform-y', '116');
    expect(items[1]).toHaveAttribute('data-reorder-shift', 'up');
    expect(items[1]).toHaveAttribute('data-reorder-transform-y', '-50');
    expect(items[2]).toHaveAttribute('data-reorder-shift', 'up');
    expect(items[2]).toHaveAttribute('data-reorder-transform-y', '-50');
    expect(
      within(screen.getAllByTestId('assembly-part-card')[1]).queryByTestId(
        'assembly-segment-top-inset'
      )
    ).not.toBeInTheDocument();
    expect(
      within(screen.getAllByTestId('assembly-part-card')[1]).getByTestId(
        'assembly-segment-bottom-inset'
      )
    ).toBeInTheDocument();
    expect(partOrder()).toEqual(['A', 'B', 'C']);
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);
    for (const card of screen.getAllByTestId('assembly-part-card')) {
      expect(card).not.toHaveAttribute('draggable');
    }

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 140 }) as PointerEvent
      );
    });

    expect(storeOrder(design.id)).toEqual(['B', 'C', 'A']);
  });

  it('commits drag reorder for non-first part cards in the initial layout', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    expect(partOrder()).toEqual(['A', 'B', 'C']);
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    const items = screen.getAllByTestId('assembly-part-card-item');
    mockRect(items[0], { top: 0, height: 48 });
    mockRect(items[1], { top: 50, height: 48 });
    mockRect(items[2], { top: 100, height: 48 });

    fireEvent.pointerDown(screen.getByTestId('assembly-part-drag-handle-b'), {
      button: 0,
      pointerId: 8,
      clientY: 74,
    });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 130 }) as PointerEvent
      );
    });

    expect(items[1]).toHaveAttribute('data-reorder-shift', 'dragging');
    expect(items[2]).toHaveAttribute('data-reorder-shift', 'up');
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 130 }) as PointerEvent
      );
    });

    expect(storeOrder(design.id)).toEqual(['A', 'C', 'B']);

    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);

    expect(partOrder()).toEqual(['A', 'C', 'B']);
  });

  it('commits drag reorder for the last part card in the initial layout', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    expect(partOrder()).toEqual(['A', 'B', 'C']);
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    const items = screen.getAllByTestId('assembly-part-card-item');
    mockRect(items[0], { top: 0, height: 48 });
    mockRect(items[1], { top: 50, height: 48 });
    mockRect(items[2], { top: 100, height: 48 });

    fireEvent.pointerDown(screen.getByTestId('assembly-part-drag-handle-c'), {
      button: 0,
      pointerId: 9,
      clientY: 124,
    });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 4 }) as PointerEvent
      );
    });

    expect(items[0]).toHaveAttribute('data-reorder-shift', 'down');
    expect(items[1]).toHaveAttribute('data-reorder-shift', 'down');
    expect(items[2]).toHaveAttribute('data-reorder-shift', 'dragging');
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 4 }) as PointerEvent
      );
    });

    expect(storeOrder(design.id)).toEqual(['C', 'A', 'B']);
  });

  it('commits drag reorder when legacy parts have duplicate region ids', async () => {
    const design = createDesign();
    design.regions = [
      createRegion('legacy-duplicate', 'A'),
      createRegion('legacy-duplicate', 'B'),
      createRegion('legacy-duplicate', 'C'),
    ];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    expect(partOrder()).toEqual(['A', 'B', 'C']);
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    const items = screen.getAllByTestId('assembly-part-card-item');
    mockRect(items[0], { top: 0, height: 48 });
    mockRect(items[1], { top: 50, height: 48 });
    mockRect(items[2], { top: 100, height: 48 });

    fireEvent.pointerDown(
      within(screen.getAllByTestId('assembly-part-card')[1]).getByRole('button', {
        name: 'Reorder B',
      }),
      {
        button: 0,
        pointerId: 10,
        clientY: 74,
      }
    );

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 130 }) as PointerEvent
      );
    });

    expect(items[1]).toHaveAttribute('data-reorder-shift', 'dragging');
    expect(items[2]).toHaveAttribute('data-reorder-shift', 'up');
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 130 }) as PointerEvent
      );
    });

    expect(storeOrder(design.id)).toEqual(['A', 'C', 'B']);
  });

  it('selects a shift range and drags selected part cards as one ordered block', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const cards = screen.getAllByTestId('assembly-part-card');
    fireEvent.click(cards[1]);
    expect(cards.map((card) => card.dataset.selected)).toEqual(['false', 'true', 'false']);

    fireEvent.click(cards[2], { shiftKey: true });
    expect(cards.map((card) => card.dataset.selected)).toEqual(['false', 'true', 'true']);

    const items = screen.getAllByTestId('assembly-part-card-item');
    mockRect(items[0], { top: 0, height: 48 });
    mockRect(items[1], { top: 50, height: 48 });
    mockRect(items[2], { top: 100, height: 48 });

    fireEvent.pointerDown(screen.getByTestId('assembly-part-drag-handle-b'), {
      button: 0,
      pointerId: 11,
      clientY: 74,
    });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 4 }) as PointerEvent
      );
    });

    expect(items[0]).toHaveAttribute('data-reorder-shift', 'down');
    expect(items[1]).toHaveAttribute('data-reorder-shift', 'dragging');
    expect(items[2]).toHaveAttribute('data-reorder-shift', 'dragging');
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'C']);

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 4 }) as PointerEvent
      );
    });

    expect(storeOrder(design.id)).toEqual(['B', 'C', 'A']);
  });

  it('selects spacer cards through the shared product segment selection model', () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-a', junctionIndex: 0, sequence: 'AAGC' }];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const partCards = screen.getAllByTestId('assembly-part-card');
    const spacerCard = screen.getByTestId('assembly-spacer-segment-0');

    fireEvent.click(spacerCard);

    expect(spacerCard).toHaveAttribute('data-selected', 'true');
    expect(partCards.map((card) => card.dataset.selected)).toEqual(['false', 'false', 'false']);

    fireEvent.click(partCards[0]);
    fireEvent.click(partCards[1], { shiftKey: true });

    expect(partCards.map((card) => card.dataset.selected)).toEqual(['true', 'true', 'false']);
    expect(spacerCard).toHaveAttribute('data-selected', 'true');

    fireEvent.click(document.body);

    expect(partCards.map((card) => card.dataset.selected)).toEqual(['false', 'false', 'false']);
    expect(spacerCard).toHaveAttribute('data-selected', 'false');
  });

  it('supports keyboard focus movement, range selection, and clearing across parts and spacers', () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-a', junctionIndex: 0, sequence: 'AAGC' }];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const partCards = screen.getAllByTestId('assembly-part-card');
    const spacerCard = screen.getByTestId('assembly-spacer-segment-0');

    act(() => {
      partCards[0].focus();
    });
    fireEvent.keyDown(partCards[0], { key: 'Enter' });
    expect(partCards[0]).toHaveAttribute('data-selected', 'true');

    fireEvent.keyDown(partCards[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(spacerCard);

    fireEvent.keyDown(spacerCard, { key: ' ', shiftKey: true });
    expect(partCards[0]).toHaveAttribute('data-selected', 'true');
    expect(spacerCard).toHaveAttribute('data-selected', 'true');

    fireEvent.keyDown(spacerCard, { key: 'Escape' });
    expect(partCards[0]).toHaveAttribute('data-selected', 'false');
    expect(spacerCard).toHaveAttribute('data-selected', 'false');
  });

  it('pushes spacer segments when a part reorder crosses their product position', async () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-a', junctionIndex: 0, sequence: 'AAGC' }];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    expect(screen.getByTestId('assembly-spacer-segment-0')).toBeInTheDocument();
    expect(useDesignStore.getState().designs[design.id].spacers[0].junctionIndex).toBe(0);

    const items = screen.getAllByTestId('assembly-part-card-item');
    const spacerShell = screen.getByTestId('assembly-spacer-card-shell');
    mockRect(items[0], { top: 0, height: 48 });
    mockRect(spacerShell, { top: 50, height: 32 });
    mockRect(items[1], { top: 90, height: 48 });
    mockRect(items[2], { top: 140, height: 48 });

    fireEvent.pointerDown(screen.getByTestId('assembly-part-drag-handle-c'), {
      button: 0,
      pointerId: 12,
      clientY: 128,
    });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 4 }) as PointerEvent
      );
    });

    expect(items[0]).toHaveAttribute('data-reorder-shift', 'down');
    expect(spacerShell).toHaveStyle({ transform: 'translateY(40px)' });
    expect(items[1]).toHaveAttribute('data-reorder-shift', 'down');

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 4 }) as PointerEvent
      );
    });

    const updatedDesign = useDesignStore.getState().designs[design.id];
    expect(updatedDesign.regions.map((region) => region.id)).toEqual(['c', 'a', 'b']);
    expect(updatedDesign.spacers).toEqual([
      expect.objectContaining({ id: 'spacer-a', junctionIndex: 1, sequence: 'AAGC' }),
    ]);

    rerender(<AssemblyPartsSection design={updatedDesign} />);

    expect(screen.queryByTestId('assembly-spacer-segment-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('assembly-spacer-segment-1')).toBeInTheDocument();
  });

  it('does not start a part-card drag from the card body', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    fireEvent.pointerDown(screen.getAllByTestId('assembly-part-card')[0], {
      button: 0,
      pointerId: 10,
      clientY: 20,
    });
    fireEvent.pointerMove(document, { pointerId: 10, clientY: 140 });

    expect(screen.getAllByTestId('assembly-part-card')[0]).toHaveAttribute(
      'data-dragging',
      'false'
    );
    expect(screen.getAllByTestId('assembly-part-card-item')[0]).toHaveAttribute(
      'data-reorder-shift',
      'none'
    );
  });

  it('does not start a part-card drag from the source provenance link', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    fireEvent.pointerDown(screen.getByTestId('assembly-part-source-link-a'), {
      button: 0,
      pointerId: 9,
      clientY: 20,
    });
    fireEvent.pointerMove(document, { pointerId: 9, clientY: 140 });

    expect(screen.getAllByTestId('assembly-part-card')[0]).toHaveAttribute(
      'data-dragging',
      'false'
    );
    expect(partOrder()).toEqual(['A', 'B', 'C']);
  });

  it('keeps source colors attached to each part after reorder', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    expect(
      screen.getAllByTestId('assembly-part-card').map((card) => card.dataset.sourceColor)
    ).toEqual(['#3b82f6', '#10b981', '#f59e0b']);
    expect(
      screen
        .getAllByTestId('assembly-part-card')[0]
        .style.getPropertyValue('--segment-outline-color')
    ).toBe('#3b82f6');
    expect(screen.getAllByTestId('assembly-part-card')[0].className).toContain(
      'hover:border-[var(--segment-outline-color)]'
    );
    expect(screen.getAllByTestId('assembly-part-card')[0].className).not.toContain(
      'hover:border-accent'
    );

    useDesignStore
      .getState()
      .reorderRegions(design.id, [
        design.regions[2].id,
        design.regions[0].id,
        design.regions[1].id,
      ]);

    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);

    expect(partOrder()).toEqual(['C', 'A', 'B']);
    expect(
      screen.getAllByTestId('assembly-part-card').map((card) => card.dataset.sourceColor)
    ).toEqual(['#f59e0b', '#3b82f6', '#10b981']);
  });

  it('shows compact source metadata without MoClo role or overhang labels', () => {
    const design = createDesign();
    design.regions[1] = {
      ...design.regions[1],
      sourceType: 'rd',
      ggType: 'insert',
      rdSourceEnzymeName: 'BsaI',
      rdOverhangs: { upstream: 'AATT', downstream: 'GGCC' },
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const cards = screen.getAllByTestId('assembly-part-card');
    expect(cards[0]).toHaveTextContent('PCR amplified');
    expect(cards[0]).toHaveTextContent('12 bp');
    expect(within(cards[0]).queryByText('P')).not.toBeInTheDocument();
    expect(cards[1]).toHaveTextContent('BsaI digest');
    expect(cards[1]).not.toHaveTextContent('Enzyme:');
    expect(cards[1]).not.toHaveTextContent('Overhangs:');
    expect(cards[1]).not.toHaveTextContent('Insert');
    expect(cards[1]).not.toHaveTextContent('Backbone');
    expect(cards[1]).toHaveTextContent('12 bp');
    expect(within(cards[1]).queryByText('R')).not.toBeInTheDocument();
  });

  it('labels a part by its internal cut-site count, not blocker count  #9)', () => {
    const design: SequenceDesign = {
      ...createDesign(),
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      regions: [
        {
          ...createRegion('internal', 'Internal'),
          sequence: 'AAAAGGTCTCAAAAGAGACCAAAA',
          sourceEnd: 24,
        },
      ],
    };
    useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });

    render(<AssemblyPartsSection design={design} />);

    const badge = screen.getByTestId('assembly-part-validation-internal');
    expect(badge).toHaveTextContent('2 internal cut sites');
  });

  it('keeps MoClo role badges out of part cards regardless of assembly method', () => {
    const design = createDesign();
    design.regions[1] = {
      ...design.regions[1],
      sourceType: 'rd',
      ggType: 'insert',
      rdSourceEnzymeName: 'BsaI',
      rdOverhangs: { upstream: 'AATT', downstream: 'GGCC' },
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    let cards = screen.getAllByTestId('assembly-part-card');
    expect(cards[1]).toHaveTextContent('BsaI digest');
    expect(cards[1]).not.toHaveTextContent('Enzyme:');
    expect(within(cards[1]).queryByText('Insert')).not.toBeInTheDocument();

    const goldenGateDesign: SequenceDesign = {
      ...design,
      assemblyMethod: 'goldengate',
    };
    useDesignStore.setState({
      designs: { [design.id]: goldenGateDesign },
      activeDesignId: design.id,
    });
    rerender(<AssemblyPartsSection design={goldenGateDesign} />);

    cards = screen.getAllByTestId('assembly-part-card');
    expect(within(cards[1]).queryByText('Insert')).not.toBeInTheDocument();
  });

  it('reuses the free-form card and boundary geometry for fixed schema positions', () => {
    const design: SequenceDesign = {
      ...createDesign(),
      topology: 'circular',
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateSchema: {
        id: 'kit:recipe:stage',
        name: 'Expression unit',
        revision: 1,
        origin: { type: 'kit', kitId: 'kit', kitName: 'Kit', schemaId: 'recipe:stage' },
        enzyme: 'BsaI',
        slots: [
          {
            id: 'promoter',
            label: 'Promoter',
            outgoingOverhang: 'TACT',
            preferredRoles: [{ label: 'promoter' }],
          },
          {
            id: 'coding',
            label: 'Coding sequence',
            outgoingOverhang: 'GCTT',
            preferredRoles: [{ label: 'coding sequence' }],
          },
          {
            id: 'terminator',
            label: 'Terminator',
            outgoingOverhang: 'GGAG',
            preferredRoles: [{ label: 'terminator' }],
          },
        ],
      },
    };
    Object.assign(design, normalizeAssemblySlots(design));
    useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });

    render(<AssemblyPartsSection design={design} />);

    expect(screen.getByRole('combobox', { name: 'Assembly schema' })).toHaveValue(
      'kit:recipe:stage'
    );
    expect(screen.getByRole('button', { name: 'Choose part for Promoter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose part for Coding sequence' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose part for Terminator' })).toBeVisible();
    expect(screen.queryByLabelText(/Reorder /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create new part' })).not.toBeInTheDocument();
    const junctions = screen.getAllByTestId('moclo-drawer-schema-junction');
    expect(junctions).toHaveLength(3);
    expect(junctions[0]).toHaveTextContent('TACTATGA');
    expect(junctions[2]).toHaveTextContent('GGAGCCTC');
    for (const junction of junctions) {
      const boundary = junction.closest('[data-testid="assembly-product-boundary"]');
      expect(boundary).not.toBeNull();
      expect(boundary).toHaveClass('h-2');
      expect(junction).toHaveClass('absolute');
    }
  });

  it('toggles a portaled part picker from anywhere on an empty schema card', async () => {
    const design: SequenceDesign = {
      ...createDesign(),
      topology: 'circular',
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateSchema: {
        id: 'kit:recipe:stage',
        name: 'Expression unit',
        revision: 1,
        origin: { type: 'kit', kitId: 'kit', kitName: 'Kit', schemaId: 'recipe:stage' },
        enzyme: 'BsaI',
        slots: [
          { id: 'promoter', label: 'Promoter', outgoingOverhang: 'TACT' },
          { id: 'coding', label: 'Coding sequence', outgoingOverhang: 'GCTT' },
          { id: 'terminator', label: 'Terminator', outgoingOverhang: 'GGAG' },
        ],
      },
    };
    design.regions[0] = {
      ...design.regions[0],
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty Promoter',
      sourceStart: 0,
      sourceEnd: 0,
      sequence: '',
      annotations: [],
      isPlaceholder: true,
    };
    Object.assign(design, normalizeAssemblySlots(design));
    useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });

    render(<AssemblyPartsSection design={design} projectRoot="/project" />);

    const emptyCard = screen.getAllByTestId('assembly-part-card')[0];
    expect(emptyCard).not.toHaveAttribute('data-validation-severity');
    expect(emptyCard).toHaveClass('border-border');
    expect(emptyCard).not.toHaveClass('border-error/70');
    fireEvent.click(emptyCard);
    expect(screen.getAllByTestId('assembly-part-card-item')[0]).toHaveAttribute(
      'data-schema-picker-open',
      'true'
    );

    const picker = await screen.findByTestId('moclo-part-picker-popover');
    expect(picker).toBeInTheDocument();
    expect(picker.closest('[data-testid="assembly-part-card-item"]')).toBeNull();

    fireEvent.click(emptyCard);
    await waitFor(() => {
      expect(screen.queryByTestId('moclo-part-picker-popover')).not.toBeInTheDocument();
    });
  });

  it('opens the matching empty schema picker when a viewer scaffold is selected', async () => {
    const design: SequenceDesign = {
      ...createDesign(),
      topology: 'circular',
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateSchema: {
        id: 'kit:recipe:stage',
        name: 'Expression unit',
        revision: 1,
        origin: { type: 'kit', kitId: 'kit', kitName: 'Kit', schemaId: 'recipe:stage' },
        enzyme: 'BsaI',
        slots: [
          { id: 'promoter', label: 'Promoter', outgoingOverhang: 'TACT' },
          { id: 'coding', label: 'Coding sequence', outgoingOverhang: 'GCTT' },
          { id: 'terminator', label: 'Terminator', outgoingOverhang: 'GGAG' },
        ],
      },
    };
    design.regions[1] = {
      ...design.regions[1],
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty Coding sequence',
      sourceStart: 0,
      sourceEnd: 0,
      sequence: '',
      annotations: [],
      isPlaceholder: true,
    };
    Object.assign(design, normalizeAssemblySlots(design));
    useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });

    render(
      <AssemblyPartsSection
        design={design}
        projectRoot="/project"
        schemaPickerRequest={{ regionId: design.regions[1].id, requestId: 1 }}
      />
    );

    expect(screen.getAllByTestId('assembly-part-card-item')[1]).toHaveAttribute(
      'data-schema-picker-open',
      'true'
    );
    expect(await screen.findByTestId('moclo-part-picker-popover')).toBeInTheDocument();
  });

  it('marks incompatible Golden Gate RD fragments as fragment-level errors', () => {
    const design: SequenceDesign = {
      ...createDesign(),
      topology: 'circular',
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
    };
    design.regions[1] = {
      ...design.regions[1],
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'AATT', downstream: 'GGCC' },
      rdSourceEnzyme: 'BsmBI',
      rdSourceEnzymeName: 'BsmBI',
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const cards = screen.getAllByTestId('assembly-part-card');
    expect(cards[1]).toHaveAttribute('data-validation-severity', 'error');
    expect(cards[1]).toHaveClass('border-error/70');
    expect(screen.getByTestId('assembly-part-validation-b')).toHaveTextContent(
      'Incompatible RD enzyme'
    );
    expect(screen.getByTestId('assembly-part-validation-b')).not.toHaveTextContent('blocker');
    expect(screen.queryByTestId('assembly-part-validation-messages-b')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/cannot be used in a BsaI Golden Gate reaction/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-goldengate-validation-summary')).not.toBeInTheDocument();
  });

  it('shows copied sequence once and pastes only into explicit empty parts', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: 'GATTACA',
      sourceId: '/tmp/copied.gb',
      sourceName: 'Copied source',
      start: 12,
      end: 19,
      annotations: [],
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    expect(screen.queryByTestId('assembly-paste-clipboard-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Copied source')).not.toBeInTheDocument();
    expect(
      screen.queryAllByRole('button', { name: /Paste copied sequence at insertion slot/ })
    ).toHaveLength(0);
    expect(screen.queryByTestId('assembly-paste-insert-slot-1')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('assembly-product-boundary')).toHaveLength(design.regions.length);

    fireEvent.click(
      within(screen.getAllByTestId('assembly-product-boundary')[0]).getByRole('button', {
        name: /Create new part/i,
      })
    );
    let updatedDesign = useDesignStore.getState().designs[design.id];
    expect(storeOrder(design.id)).toEqual(['A', 'Empty slot', 'B', 'C']);
    const placeholderId = updatedDesign.regions[1].id;
    rerender(<AssemblyPartsSection design={updatedDesign} />);

    const placeholderPaste = screen.getByTestId(`assembly-placeholder-paste-${placeholderId}`);
    expect(within(placeholderPaste).getByText('Paste', { exact: true })).toBeInTheDocument();
    expect(placeholderPaste).toHaveAccessibleName('Paste Copied source into this empty part');
    expect(placeholderPaste).toHaveAttribute('data-paste-source-name', 'Copied source');
    expect(placeholderPaste).toHaveAttribute('data-paste-sequence-length', '7');
    const pasteContext = screen.getByTestId(`assembly-placeholder-paste-context-${placeholderId}`);
    const pasteLabel = screen.getByTestId(`assembly-placeholder-paste-label-${placeholderId}`);
    expect(pasteContext).toHaveTextContent('PCR · Copied source · 7 bp');
    expect(placeholderPaste).toContainElement(pasteContext);
    expect(placeholderPaste.firstElementChild).toBe(pasteContext);
    expect(placeholderPaste.lastElementChild).toBe(pasteLabel);
    const placeholderCard = pasteContext.closest('[data-testid="assembly-part-card"]');
    expect(placeholderCard).not.toBeNull();
    if (!placeholderCard) throw new Error('Expected placeholder part card.');
    expect(within(placeholderCard).queryByText('0 bp')).not.toBeInTheDocument();

    fireEvent.click(pasteContext);

    expect(storeOrder(design.id)).toEqual(['A', 'Copied source', 'B', 'C']);
    updatedDesign = useDesignStore.getState().designs[design.id];
    const inserted = updatedDesign.regions[1];
    expect(inserted.sourceSequenceId).toBe('/tmp/copied.gb');
    expect(inserted.sourceStart).toBe(12);
    expect(inserted.sourceEnd).toBe(19);
    expect(inserted.sequence).toBe('GATTACA');
    expect(inserted.isPlaceholder).toBe(false);
  });

  it('offers a source-aware Paste action that adds the copied PCR product as the first part', () => {
    const design = createDesign();
    design.regions = [];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: 'GATTACA',
      sourceId: '/tmp/copied.gb',
      sourceName: 'Copied source',
      start: 0,
      end: 7,
      annotations: [],
    });

    render(<AssemblyPartsSection design={design} />);
    expect(screen.queryByTestId('assembly-paste-clipboard-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('assembly-paste-as-part')).toHaveTextContent(/^Paste$/);
    expect(screen.getByTestId('assembly-empty-paste-context')).toHaveTextContent(
      'PCR · Copied source · 7 bp'
    );
    fireEvent.click(screen.getByTestId('assembly-paste-as-part'));

    expect(storeOrder(design.id)).toEqual(['Copied source']);
    const inserted = useDesignStore.getState().designs[design.id].regions[0];
    expect(inserted.sequence).toBe('GATTACA');
    expect(inserted.isPlaceholder).toBe(false);
  });

  it('does NOT show "Paste as a part" once the assembly already has parts ', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: 'GATTACA',
      sourceId: '/tmp/copied.gb',
      sourceName: 'Copied source',
      start: 0,
      end: 7,
      annotations: [],
    });

    render(<AssemblyPartsSection design={design} />);

    expect(screen.queryByTestId('assembly-paste-clipboard-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-paste-as-part')).not.toBeInTheDocument();
  });

  it('disables "Paste as a part" for a non-insert RD fragment in a Golden Gate reaction ', () => {
    const design: SequenceDesign = {
      ...createDesign(),
      regions: [],
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    useRichSequenceClipboardStore.getState().setCopiedRegion({
      sequence: 'AATTCCGG',
      sourceId: '/tmp/rd.gb',
      sourceName: 'Backbone digest',
      start: 0,
      end: 8,
      annotations: [],
      sourceType: 'rd',
      ggType: 'backbone',
      rdOverhangs: { upstream: 'AATT', downstream: 'CCGG' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI',
    });

    render(<AssemblyPartsSection design={design} />);
    expect(screen.getByTestId('assembly-paste-as-part')).toBeDisabled();
    expect(screen.getByTestId('assembly-paste-as-part')).toHaveTextContent(/^Paste$/);
    expect(screen.getByTestId('assembly-paste-as-part')).toHaveAccessibleName(
      'Paste Backbone digest into the assembly as a part'
    );
    expect(screen.getByTestId('assembly-empty-paste-context')).toHaveTextContent(
      'Backbone digest · 8 bp'
    );
  });

  it.each(['gibson', 'nebuilder'] as const)(
    'pastes non-insert RD fragments as physical parts in %s assemblies',
    (assemblyMethod) => {
      const design = { ...createDesign(), assemblyMethod };
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
      });
      useRichSequenceClipboardStore.getState().setCopiedRegion({
        sequence: 'AATTCCGG',
        sourceId: '/tmp/rd-source.gb',
        sourceName: 'EcoRI backbone digest',
        start: 5,
        end: 13,
        annotations: [],
        sourceType: 'rd',
        ggType: 'backbone',
        rdOverhangs: { upstream: 'AATT', downstream: 'AATT' },
        rdSourceEnzymeName: 'EcoRI',
      });

      const { rerender } = render(<AssemblyPartsSection design={design} />);

      fireEvent.click(
        within(screen.getAllByTestId('assembly-product-boundary')[0]).getByRole('button', {
          name: /Create new part/i,
        })
      );
      const updatedWithPlaceholder = useDesignStore.getState().designs[design.id];
      rerender(<AssemblyPartsSection design={updatedWithPlaceholder} />);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Paste EcoRI backbone digest into this empty part',
        })
      );

      const inserted = useDesignStore.getState().designs[design.id].regions[1];
      expect(inserted.sourceType).toBe('rd');
      expect(inserted.ggType).toBe('backbone');
      expect(inserted.rdSourceEnzymeName).toBe('EcoRI');
      expect(inserted.sequence).toBe('AATTCCGG');
      expect(inserted.isPlaceholder).toBe(false);
    }
  );

  it('creates blank placeholder parts without advertising cross-tab drag', () => {
    const design = createDesign();
    design.regions = [];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    expect(screen.getByTestId('assembly-empty-parts-cue')).toHaveTextContent('No parts yet.');
    expect(screen.queryByText('Drag digest fragments here to add')).not.toBeInTheDocument();
    expect(screen.queryByText(/Add parts from a sequence tab/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('assembly-add-blank-part-empty'));

    const updatedDesign = useDesignStore.getState().designs[design.id];
    expect(updatedDesign.regions).toHaveLength(1);
    expect(updatedDesign.regions[0]).toMatchObject({
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty slot',
      sourceStart: 0,
      sourceEnd: 0,
      sequence: '',
      annotations: [],
      isPlaceholder: true,
    });
    expect(updatedDesign.regions[0].sourceType).toBeUndefined();

    rerender(<AssemblyPartsSection design={updatedDesign} />);

    expect(partOrder()).toEqual(['Empty part']);
    const emptyCard = screen.getByTestId('assembly-part-card');
    expect(emptyCard).toHaveAttribute('data-source-color', '#9ca3af');
    expect(emptyCard).not.toHaveAttribute('data-validation-severity');
    expect(emptyCard).toHaveClass('border-border');
    expect(emptyCard).not.toHaveClass('border-error/70');
    expect(issuesBlockingGate(deriveAssemblyIssues({ design: updatedDesign }), 'finalize')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assembly-empty-part',
          scope: expect.objectContaining({ regionId: updatedDesign.regions[0].id }),
        }),
      ])
    );
    expect(
      screen.queryByTestId(`assembly-part-validation-${updatedDesign.regions[0].id}`)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('No sequence assigned')).not.toBeInTheDocument();
  });

  it('adds a blank placeholder at the end from the terminal boundary unit', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    expect(screen.queryByText('Drag digest fragments here to add')).not.toBeInTheDocument();

    const terminalBoundary = screen.getAllByTestId('assembly-product-boundary').at(-1);
    expect(terminalBoundary).toBeDefined();
    expect(terminalBoundary).toHaveAttribute('data-terminal', 'true');
    expect(terminalBoundary).toHaveAttribute('data-right-kind', 'none');
    expect(
      within(terminalBoundary!).queryByRole('button', { name: /Add spacer sequence/i })
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(terminalBoundary!).getByRole('button', {
        name: /Create new part/i,
      })
    );

    const regions = useDesignStore.getState().designs[design.id].regions;
    expect(regions).toHaveLength(4);
    expect(regions[3]).toMatchObject({
      sourceSequenceId: 'placeholder',
      sourceSequenceName: 'Empty slot',
      sequence: '',
      isPlaceholder: true,
    });
  });

  it('adds blank parts from interstitial insertion actions', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    fireEvent.click(
      within(screen.getAllByTestId('assembly-product-boundary')[0]).getByRole('button', {
        name: /Create new part/i,
      })
    );
    expect(storeOrder(design.id)).toEqual(['A', 'Empty slot', 'B', 'C']);

    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    rerender(<AssemblyPartsSection design={design} />);

    fireEvent.click(
      within(screen.getAllByTestId('assembly-product-boundary')[1]).getByRole('button', {
        name: /Create new part/i,
      })
    );
    expect(storeOrder(design.id)).toEqual(['A', 'B', 'Empty slot', 'C']);
  });

  it('renders interstitial add actions as one wide boundary unit', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const boundary = screen.getAllByTestId('assembly-product-boundary')[0];
    expect(boundary).toHaveAttribute('data-left-kind', 'part');
    expect(boundary).toHaveAttribute('data-right-kind', 'part');
    expect(boundary).toHaveAttribute('data-can-add-spacer', 'true');
    expect(boundary).toHaveAttribute('data-terminal', 'false');
    expect(boundary).toHaveClass('rounded-md');
    expect(boundary).toHaveClass('cursor-pointer');
    expect(boundary).toHaveClass('select-none');
    const createButton = within(boundary).getByRole('button', { name: /Create new part/i });
    const spacerButton = within(boundary).getByRole('button', { name: /Add spacer sequence/i });
    expect(createButton).toHaveTextContent('+ Part');
    expect(spacerButton).toHaveTextContent('+ Spacer');
    expect(createButton).toHaveClass('cursor-pointer');
    expect(createButton).not.toHaveClass('hover:bg-bg-muted');
    expect(spacerButton).toHaveClass('cursor-pointer');
    expect(spacerButton).not.toHaveClass('hover:bg-bg-muted');
    expect(createButton).toHaveClass('text-fg-subtle');
    expect(createButton).toHaveClass('wp-interactive');
    expect(spacerButton).toHaveClass('text-fg-subtle');
    expect(spacerButton).toHaveClass('wp-interactive');
    expect(createButton.parentElement).toHaveClass('w-[128px]');

    fireEvent.pointerEnter(screen.getAllByTestId('assembly-part-card-shell')[0]);

    expect(boundary).toHaveAttribute('data-upper-active', 'true');
    expect(boundary).toHaveAttribute('data-lower-active', 'false');

    fireEvent.pointerLeave(screen.getAllByTestId('assembly-part-card-shell')[0]);
    fireEvent.pointerEnter(screen.getAllByTestId('assembly-part-card-shell')[1]);

    expect(boundary).toHaveAttribute('data-upper-active', 'false');
    expect(boundary).toHaveAttribute('data-lower-active', 'true');

    fireEvent.pointerLeave(screen.getAllByTestId('assembly-part-card-shell')[1]);
    fireEvent.pointerEnter(boundary);

    expect(boundary).toHaveAttribute('data-active', 'true');
    expect(boundary).toHaveAttribute('data-upper-active', 'true');
    expect(boundary).toHaveAttribute('data-lower-active', 'true');
  });

  it('renders a circular terminal boundary between the last and first parts', () => {
    const design = { ...createDesign(), topology: 'circular' as const };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const terminalBoundary = screen.getAllByTestId('assembly-product-boundary').at(-1);
    expect(terminalBoundary).toBeDefined();
    expect(terminalBoundary).toHaveAttribute('data-terminal', 'true');
    expect(terminalBoundary).toHaveAttribute('data-left-kind', 'part');
    expect(terminalBoundary).toHaveAttribute('data-right-kind', 'part');
    expect(terminalBoundary).toHaveAttribute('data-can-add-spacer', 'true');
    expect(
      within(terminalBoundary!).getByRole('button', { name: /Create new part/i })
    ).toBeInTheDocument();
    expect(
      within(terminalBoundary!).getByRole('button', { name: /Add spacer sequence/i })
    ).toBeInTheDocument();
  });

  it('adds spacer segments from interstitial insertion actions and commits typed DNA immediately', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    fireEvent.click(
      within(screen.getAllByTestId('assembly-product-boundary')[0]).getByRole('button', {
        name: /Add spacer sequence/i,
      })
    );
    expect(useDesignStore.getState().designs[design.id].selectedJunctionIndex).toBe(0);
    expect(useDesignStore.getState().designs[design.id].spacers).toHaveLength(0);

    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);

    const spacerSegment = screen.getByTestId('assembly-spacer-segment-0');
    expect(spacerSegment).toBeInTheDocument();
    expect(spacerSegment).toHaveClass('rounded-md');
    expect(spacerSegment).toHaveClass('p-1.5');
    expect(spacerSegment.style.borderLeftWidth).toBe(`${ASSEMBLY_SEGMENT_RAIL_WIDTH}px`);
    expect(spacerSegment.style.borderLeftWidth).toBe(
      screen.getAllByTestId('assembly-part-card')[0].style.borderLeftWidth
    );
    expect(spacerSegment).toHaveTextContent('Spacer sequence');
    expect(spacerSegment).not.toHaveTextContent('0 bp');
    expect(spacerSegment).not.toHaveTextContent('User-entered sequence');
    expect(
      screen.getByTestId('assembly-spacer-drag-handle-pending-spacer:assembly-parts-test-design:0')
    ).toHaveClass('self-start');
    expect(screen.getByTestId('assembly-part-drag-handle-a')).toHaveClass('self-start');
    fireEvent.change(screen.getByTestId('assembly-spacer-sequence-0'), {
      target: { value: 'aa gc' },
    });
    expect(screen.getByTestId('assembly-spacer-sequence-0')).toHaveValue('AAGC');
    expect(useDesignStore.getState().designs[design.id].spacers).toHaveLength(1);
    expect(useDesignStore.getState().designs[design.id].spacers[0]).toMatchObject({
      junctionIndex: 0,
      sequence: 'AAGC',
    });

    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);

    const spacerInput = screen.getByTestId('assembly-spacer-sequence-0');
    fireEvent.focus(spacerInput);
    fireEvent.change(spacerInput, { target: { value: 'TTTT' } });
    expect(useDesignStore.getState().designs[design.id].spacers[0].sequence).toBe('TTTT');
    fireEvent.keyDown(spacerInput, { key: 'Escape' });
    expect(useDesignStore.getState().designs[design.id].spacers[0].sequence).toBe('AAGC');
    expect(spacerInput).toHaveValue('AAGC');

    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);

    const spacerAdjacentBoundaries = screen
      .getAllByTestId('assembly-product-boundary')
      .filter((boundary) => boundary.dataset.adjacentToSpacer === 'true');
    expect(spacerAdjacentBoundaries).toHaveLength(2);
    for (const boundary of spacerAdjacentBoundaries) {
      expect(
        within(boundary).queryByRole('button', { name: /Add spacer sequence/i })
      ).not.toBeInTheDocument();
      expect(
        within(boundary).getByRole('button', { name: /Create new part/i })
      ).toBeInTheDocument();
    }
  });

  it('keeps the spacer editor mounted while the field is emptied mid-typing', () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-keep', junctionIndex: 0, sequence: 'AAGC' }];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    const spacerInput = screen.getByTestId('assembly-spacer-sequence-0');
    fireEvent.change(spacerInput, { target: { value: '' } });

    expect(screen.getByTestId('assembly-spacer-sequence-0')).toBeInTheDocument();
    expect(useDesignStore.getState().designs[design.id].spacers).toHaveLength(1);
    expect(useDesignStore.getState().designs[design.id].spacers[0].sequence).toBe('AAGC');
  });

  it('drags a persisted spacer to another legal product boundary', async () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-a', junctionIndex: 0, sequence: 'AAGC' }];
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<AssemblyPartsSection design={design} />);

    expect(useDesignStore.getState().designs[design.id].spacers[0].junctionIndex).toBe(0);
    const partItems = screen.getAllByTestId('assembly-part-card-item');
    const spacerShell = screen.getByTestId('assembly-spacer-card-shell');
    mockRect(partItems[0], { top: 0, height: 48 });
    mockRect(spacerShell, { top: 50, height: 32 });
    mockRect(partItems[1], { top: 100, height: 48 });
    mockRect(partItems[2], { top: 150, height: 48 });

    fireEvent.pointerDown(screen.getByTestId('assembly-spacer-drag-handle-spacer-a'), {
      button: 0,
      pointerId: 11,
      clientY: 55,
    });
    await waitFor(() =>
      expect(screen.getByTestId('assembly-spacer-segment-0')).toHaveAttribute(
        'data-dragging',
        'true'
      )
    );
    expect(
      within(screen.getByTestId('assembly-spacer-segment-0')).queryByTestId(
        'assembly-segment-top-inset'
      )
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('assembly-spacer-segment-0')).queryByTestId(
        'assembly-segment-bottom-inset'
      )
    ).not.toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientY: 124 }) as PointerEvent
      );
    });

    expect(spacerShell).toHaveStyle({ transform: 'translateY(58px)' });
    expect(partItems[1]).toHaveAttribute('data-reorder-shift', 'up');
    expect(partItems[2]).toHaveAttribute('data-reorder-shift', 'none');

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientY: 124 }) as PointerEvent
      );
    });

    expect(useDesignStore.getState().designs[design.id].spacers).toEqual([
      expect.objectContaining({
        id: 'spacer-a',
        junctionIndex: 1,
        sequence: 'AAGC',
      }),
    ]);
  });

  it('can insert a part next to an opened spacer editor before the spacer is committed', () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    fireEvent.click(
      within(screen.getAllByTestId('assembly-product-boundary')[0]).getByRole('button', {
        name: /Add spacer sequence/i,
      })
    );
    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);

    const upperSpacerBoundary = screen
      .getAllByTestId('assembly-product-boundary')
      .find(
        (boundary) =>
          boundary.dataset.leftKind === 'part' && boundary.dataset.rightKind === 'spacer'
      );
    expect(upperSpacerBoundary).toBeDefined();

    fireEvent.click(
      within(upperSpacerBoundary!).getByRole('button', {
        name: /Create new part/i,
      })
    );

    const updatedDesign = useDesignStore.getState().designs[design.id];
    expect(updatedDesign.regions.map((region) => region.sourceSequenceName)).toEqual([
      'A',
      'Empty slot',
      'B',
      'C',
    ]);
    expect(updatedDesign.spacers).toEqual([]);
    expect(updatedDesign.selectedJunctionIndex).toBeNull();
  });

  it('surfaces persisted spacer state in the boundary editor and clears through the shared command path', () => {
    const design = {
      ...createDesign(),
      spacers: [{ id: 'old-spacer', junctionIndex: 0, sequence: 'GGCC' }],
      selectedJunctionIndex: null,
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const { rerender } = render(<AssemblyPartsSection design={design} />);

    expect(screen.getByTestId('assembly-spacer-segment-0')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-spacer-sequence-0')).toHaveValue('GGCC');

    fireEvent.click(screen.getByTestId('assembly-spacer-clear-0'));

    expect(useDesignStore.getState().designs[design.id].spacers).toEqual([]);
    rerender(<AssemblyPartsSection design={useDesignStore.getState().designs[design.id]} />);
    expect(screen.queryByTestId('assembly-spacer-segment-0')).not.toBeInTheDocument();
  });

  it('opens a source part tab and highlights the source provenance range', () => {
    const sourceDocumentId = 'sequence-document-source-a';
    const design = createDesign();
    design.regions[0] = {
      ...design.regions[0],
      sourceSequenceId: sourceDocumentId,
      sourceStart: 8,
      sourceEnd: 21,
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: sourceDocumentId,
      label: 'Source A',
      sequenceDocument: { kind: 'catalog-sequence', entityId: sourceDocumentId },
    });

    render(<AssemblyPartsSection design={design} />);

    fireEvent.click(screen.getByTestId('assembly-part-source-link-a'));

    const panel = useCanvasStore.getState().panels.main;
    const tab = panel.tabs.find((candidate) => candidate.id === tabId);
    expect(panel.activeTabId).toBe(tabId);
    expect(tab?.viewState?.highlightRange).toEqual({ start: 8, end: 20 });
    expect(tab?.viewState?.scrollPosition).toBe(9);
    expect(tab?.viewState?.cutSiteDisplayRequest).toBeUndefined();
  });

  it('opens source provenance through the resolved package even when an inline cache is present', async () => {
    const sourceDocumentId = 'sequence-document-puc19-fixture';
    const sourceSequence = 'ATGC'.repeat(40);
    const design = createDesign();
    design.regions[0] = {
      ...design.regions[0],
      sourceSequenceId: sourceDocumentId,
      sourceSequenceName: 'pUC19 fixture',
      sourceType: 'rd',
      rdSourceEnzymeName: 'EcoRI + BamHI',
      sourceSequence,
      sourceAnnotations: [
        {
          name: 'source feature',
          type: 'misc_feature',
          start: 5,
          end: 15,
          direction: 1,
        },
      ],
      sourceIsCircular: true,
      sourceStart: 8,
      sourceEnd: 21,
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const ref = {
      kind: 'managed-sequence' as const,
      packageId: sourceDocumentId,
      packageRoot: '/project/pUC19',
    };
    sourceOpen.resolve.mockResolvedValue({
      ref,
      documentId: sourceDocumentId,
      sourcePath: '/project/pUC19/product.gb',
    });
    sourceOpen.open.mockImplementation(
      async (request: { target: { document: SequenceDocumentRef } }) => {
        const tabId = useCanvasStore.getState().openTab('main', {
          type: 'sequence',
          entityId: sourceDocumentId,
          label: 'pUC19 fixture',
          sequenceDocument: request.target.document,
        });
        return { status: 'presented', tabId, panelId: 'main' };
      }
    );

    render(<AssemblyPartsSection design={design} />);

    fireEvent.click(screen.getByTestId('assembly-part-source-link-a'));

    await waitFor(() =>
      expect(sourceOpen.open).toHaveBeenCalledWith({
        target: { kind: 'sequence-document', document: ref },
        label: 'pUC19 fixture',
      })
    );
    expect(sourceOpen.resolve).toHaveBeenCalledWith(sourceDocumentId, expect.any(Array));

    const cached = useSequenceStore.getState().getSequence(sourceDocumentId);
    expect(cached).toMatchObject({
      id: sourceDocumentId,
      name: 'pUC19 fixture',
      sequence: sourceSequence,
      length: sourceSequence.length,
      circular: true,
    });
    expect(cached?.annotations).toHaveLength(1);
    expect(useCanvasStore.getState().findTab('sequence', sourceDocumentId)).not.toBeNull();
    const tabLocation = useCanvasStore.getState().findTab('sequence', sourceDocumentId);
    const tab =
      tabLocation &&
      useCanvasStore
        .getState()
        .panels[tabLocation.panelId].tabs.find((candidate) => candidate.id === tabLocation.tabId);
    expect(tab?.viewState?.highlightRange).toEqual({ start: 8, end: 20 });
    expect(tab?.sequenceDocument).toEqual(ref);
    expect(tab?.viewState?.sequenceRendererVisibility).toBe('map');
    expect(tab?.viewState?.cutSiteDisplayRequest?.enzymeNames).toEqual(['EcoRI', 'BamHI']);
  });

  it.each([
    {
      sourceType: 'rd' as const,
      rdSourceEnzymeName: 'EcoRI + BamHI',
      expected: ['EcoRI', 'BamHI'],
    },
    { sourceType: 'rd' as const, rdSourceEnzyme: 'BsaI' as const, expected: ['BsaI'] },
    {
      sourceType: undefined,
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTT' },
      rdSourceEnzymeName: 'BpiI',
      expected: ['BpiI'],
    },
  ])('requests the recorded digest enzymes when reopening its source: $expected', (provenance) => {
    const design = createDesign();
    const { expected, ...fields } = provenance;
    design.regions[0] = {
      ...design.regions[0],
      sourceSequenceId: 'digest-source-package',
      ...fields,
    };
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: design.regions[0].sourceSequenceId,
      label: 'Source A',
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'digest-source-package',
        packageRoot: '/project/digest-source',
      },
      viewState: { sequenceRendererVisibility: 'both' },
    });
    render(<AssemblyPartsSection design={design} />);

    fireEvent.click(screen.getByTestId('assembly-part-source-link-a'));
    const first = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
    expect(first.viewState?.cutSiteDisplayRequest).toEqual({
      id: expect.any(String),
      enzymeNames: expected,
    });
    expect(first.viewState?.sequenceRendererVisibility).toBe('both');

    fireEvent.click(screen.getByTestId('assembly-part-open-source-a'));
    const next = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
    expect(next.viewState?.cutSiteDisplayRequest?.id).not.toBe(
      first.viewState?.cutSiteDisplayRequest?.id
    );
  });
});

function mockRect(element: HTMLElement, rect: { top: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: rect.top,
      top: rect.top,
      bottom: rect.top + rect.height,
      left: 0,
      right: 100,
      width: 100,
      height: rect.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function partOrder(): string[] {
  return screen
    .getAllByTestId('assembly-part-card')
    .map((card) => card.getAttribute('data-source-name') ?? '');
}

function storeOrder(designId: string): string[] {
  return useDesignStore
    .getState()
    .designs[designId].regions.map((region) => region.sourceSequenceName);
}

function createDesign(): SequenceDesign {
  const now = new Date('2026-05-10T00:00:00.000Z');
  return {
    id: 'assembly-parts-test-design',
    name: 'Assembly Parts Test Design',
    topology: 'linear',
    regions: [createRegion('a', 'A'), createRegion('b', 'B'), createRegion('c', 'C')],
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createRegion(id: string, sourceSequenceName: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `/tmp/source-${id}.gb`,
    sourceSequenceName,
    sourceStart: 0,
    sourceEnd: 12,
    sequence: 'ATGCATGCATGC',
    annotations: [],
    sourceType: 'pcr',
  };
}
