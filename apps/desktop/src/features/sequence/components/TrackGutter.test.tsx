import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GutterRow } from './track-gutter-rows';
import * as trackGutterModule from './TrackGutter';

const {
  GUTTER_COLLAPSED_WIDTH,
  TrackGutter,
  TrackGutterHeader,
  trackReorderPlacementFromPointerY,
} = trackGutterModule;

afterEach(cleanup);

function referenceRow(over: Partial<GutterRow> = {}): GutterRow {
  return {
    id: 'lane:reference',
    kind: 'reference',
    label: 'Reference',
    visible: true,
    removable: false,
    togglable: true,
    band: { topPx: 14, heightPx: 400 },
    ...over,
  };
}

function dataRow(over: Partial<GutterRow> = {}): GutterRow {
  return {
    id: '__legacy__:p1',
    kind: 'data',
    label: 'HG002 pileup',
    visible: true,
    removable: true,
    togglable: true,
    trackId: 'p1',
    bucket: '__legacy__',
    band: { topPx: 440, heightPx: 60 },
    ...over,
  };
}

const noop = () => {};

function dragTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: vi.fn((type: string, value: string) => data.set(type, value)),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
    setDragImage: vi.fn(),
  };
}

function fireDragStartWithPointer(
  target: Element,
  dataTransfer: ReturnType<typeof dragTransfer>,
  clientX: number,
  clientY: number
): void {
  const event = createEvent.dragStart(target, { dataTransfer });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

function fireDragOverWithPointer(
  target: Element,
  dataTransfer: ReturnType<typeof dragTransfer>,
  clientY: number
): void {
  const event = createEvent.dragOver(target, { dataTransfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(target, event);
}

function fireDragLeaveWithPointer(target: Element, clientX: number, clientY: number): void {
  const event = createEvent.dragLeave(target, { relatedTarget: null });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

describe('trackReorderPlacementFromPointerY', () => {
  it('treats the row midpoint as after, not before', () => {
    expect(trackReorderPlacementFromPointerY(119, 100, 40)).toBe('before');
    expect(trackReorderPlacementFromPointerY(120, 100, 40)).toBe('after');
    expect(trackReorderPlacementFromPointerY(121, 100, 40)).toBe('after');
  });
});

function firePointerAt(
  type: 'down' | 'move' | 'up',
  target: Element | Document,
  clientY: number,
  pointerId: number
): void {
  const event =
    type === 'down'
      ? createEvent.pointerDown(target)
      : type === 'move'
        ? createEvent.pointerMove(target)
        : createEvent.pointerUp(target);
  Object.defineProperties(event, {
    button: { value: 0 },
    clientY: { value: clientY },
    pointerId: { value: pointerId },
  });
  fireEvent(target, event);
}

describe('TrackGutter', () => {
  it('shows the empty state + add when there are no lanes', () => {
    render(<TrackGutter rows={[]} onToggleVisible={noop} onRemove={noop} onAddTrack={noop} />);
    expect(screen.getByTestId('track-gutter-empty')).toBeTruthy();
    expect(screen.getByTestId('track-gutter-add')).toBeTruthy();
  });

  it('keeps the mutation navigator reopen action in the persistent track gutter', () => {
    const onOpenMutationNavigator = vi.fn();
    render(
      <TrackGutter
        rows={[referenceRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
        onOpenMutationNavigator={onOpenMutationNavigator}
      />
    );

    fireEvent.click(screen.getByTestId('open-mutation-navigator'));

    expect(onOpenMutationNavigator).toHaveBeenCalledOnce();
    expect(screen.getByTestId('track-gutter-add-row')).toContainElement(
      screen.getByTestId('open-mutation-navigator')
    );
  });

  it('does not render a dead add action when the host has no add workflow', () => {
    render(<TrackGutter rows={[]} onToggleVisible={noop} onRemove={noop} />);
    expect(screen.getByTestId('track-gutter-empty')).toHaveTextContent('No tracks yet.');
    expect(screen.queryByTestId('track-gutter-add')).toBeNull();
  });

  it('leaves its header to the host toolbar and puts Add track after the bottom-most lane', () => {
    render(
      <TrackGutter
        rows={[referenceRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );
    expect(screen.queryByTestId('track-gutter-chrome')).toBeNull();
    expect(screen.queryByTestId('track-gutter-collapse')).toBeNull();
    const addRow = screen.getByTestId('track-gutter-add-row');
    const scrollLayer = screen.getByTestId('track-gutter-scroll-layer');
    expect(scrollLayer.contains(addRow)).toBe(true);
    const ref = screen.getByTestId('track-gutter-row-lane:reference');
    expect(ref.contains(screen.getByTestId('track-gutter-add'))).toBe(false);
    expect(addRow.style.top).toBe('min(414px, calc(var(--track-scroll-top, 0px) + 100% - 32px))');
  });

  it('places Add track after the final data track in renderer order', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );

    expect(screen.getByTestId('track-gutter-add-row').style.top).toBe(
      'min(500px, calc(var(--track-scroll-top, 0px) + 100% - 32px))'
    );
  });

  it('clamps Add track to the visible gutter bottom using the presented scroll receipt', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );

    const scrollViewport = screen.getByTestId('track-gutter-scroll-viewport');
    const scrollLayer = screen.getByTestId('track-gutter-scroll-layer');
    expect(scrollViewport).toContainElement(scrollLayer);
    expect(scrollViewport).toHaveClass('overflow-hidden');
    expect(scrollLayer).not.toHaveClass('overflow-hidden');
    trackGutterModule.applyPresentedTrackScrollReceipt(scrollLayer, {
      completedFrameEpoch: 12,
      trackScrollTop: 72,
    });

    expect(scrollLayer.style.transform).toBe('translate3d(0, -72px, 0)');
    expect(scrollLayer.style.getPropertyValue('--track-scroll-top')).toBe('72px');
    expect(screen.getByTestId('track-gutter-add-row').style.top).toBe(
      'min(500px, calc(var(--track-scroll-top, 0px) + 100% - 32px))'
    );
  });

  it('places Add track after a newly added row that has not received a renderer band yet', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow({ band: undefined })]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );

    expect(screen.getByTestId('track-gutter-row-__legacy__:p1').style.top).toBe('414px');
    expect(screen.getByTestId('track-gutter-add-row').style.top).toBe(
      'min(444px, calc(var(--track-scroll-top, 0px) + 100% - 32px))'
    );
  });

  it('renders one row per lane with its label', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );
    expect(screen.getByTestId('track-gutter-row-lane:reference')).toBeTruthy();
    expect(screen.getByTestId('track-gutter-row-__legacy__:p1')).toBeTruthy();
    expect(screen.getByText('HG002 pileup')).toBeTruthy();
    expect(screen.getByText('Reference')).toBeTruthy();
  });

  it('shows the complete track name immediately on hover only when the rendered name is clipped', async () => {
    const label = 'Pol II pSer5 — alpha-amanitin 4 hpf with a deliberately long suffix';
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow({ label })]}
        onToggleVisible={noop}
        onRemove={noop}
      />
    );

    const name = screen.getByTestId('track-gutter-name-__legacy__:p1');
    Object.defineProperties(name, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 240 },
      clientHeight: { configurable: true, value: 30 },
      scrollHeight: { configurable: true, value: 30 },
    });
    fireEvent.mouseEnter(name);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(label);
    expect(screen.getByRole('tooltip').style.transform).toContain('translateY(-100%)');
  });

  it('does not create a redundant tooltip when the complete name is already visible', () => {
    vi.useFakeTimers();
    const label = 'Complete track name';
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow({ label })]}
        onToggleVisible={noop}
        onRemove={noop}
      />
    );

    const name = screen.getByTestId('track-gutter-name-__legacy__:p1');
    Object.defineProperties(name, {
      clientWidth: { configurable: true, value: 160 },
      scrollWidth: { configurable: true, value: 160 },
      clientHeight: { configurable: true, value: 30 },
      scrollHeight: { configurable: true, value: 30 },
    });
    fireEvent.mouseEnter(name);
    vi.runAllTimers();

    expect(screen.queryByRole('tooltip')).toBeNull();
    vi.useRealTimers();
  });

  it('uses a top management toolbar and gives the name the full row width below it', () => {
    const label = 'Pol II pSer5 — alpha-amanitin 4 hpf with a deliberately long suffix';
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow({ label, band: { topPx: 440, heightPx: 96 } })]}
        onToggleVisible={noop}
        onRemove={noop}
        renderDataControls={() => <div>Settings</div>}
      />
    );

    expect(screen.getByTestId('track-gutter-name-__legacy__:p1')).toHaveAttribute(
      'data-name-layout',
      'wrapped'
    );
    const actions = screen.getByTestId('track-gutter-actions-__legacy__:p1');
    expect(actions).toHaveAttribute('data-control-placement', 'top-toolbar');
    expect(actions.querySelector('[aria-hidden].h-2.w-2.rounded-full')).toBeNull();
    expect(actions).toContainElement(screen.getByLabelText(`Open settings for ${label}`));
    expect(actions).toContainElement(screen.getByLabelText(`Remove ${label}`));
    expect(
      actions.compareDocumentPosition(screen.getByTestId('track-gutter-name-__legacy__:p1')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
  });

  it('resizes one data track from its bottom divider and commits the gesture once', () => {
    const onPreviewDataRowHeight = vi.fn();
    const onCommitDataRowHeight = vi.fn();
    const onCancelDataRowHeight = vi.fn();
    render(
      <TrackGutter
        rows={[dataRow({ requestedHeightPx: 96, band: { topPx: 100, heightPx: 96 } })]}
        onToggleVisible={noop}
        onRemove={noop}
        onPreviewDataRowHeight={onPreviewDataRowHeight}
        onCommitDataRowHeight={onCommitDataRowHeight}
        onCancelDataRowHeight={onCancelDataRowHeight}
      />
    );

    const handle = screen.getByRole('separator', { name: 'Resize HG002 pileup track height' });
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    expect(handle).toHaveAttribute('aria-valuenow', '96');
    const dividerLine = screen.getByTestId('track-gutter-height-resize-line-__legacy__:p1');
    expect(dividerLine).toHaveAttribute('data-line-thickness-px', '1');
    expect(handle).toContainElement(dividerLine);
    firePointerAt('down', handle, 200, 1);
    firePointerAt('move', document, 236, 1);

    expect(onPreviewDataRowHeight).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackId: 'p1' }),
      132
    );
    expect(onCommitDataRowHeight).not.toHaveBeenCalled();

    firePointerAt('up', document, 236, 1);
    expect(onCommitDataRowHeight).toHaveBeenCalledOnce();
    expect(onCommitDataRowHeight).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'p1' }),
      96,
      132
    );
    expect(onCancelDataRowHeight).not.toHaveBeenCalled();
  });

  it('supports precise keyboard resizing and cancels an active pointer resize with Escape', () => {
    const onPreviewDataRowHeight = vi.fn();
    const onCommitDataRowHeight = vi.fn();
    const onCancelDataRowHeight = vi.fn();
    render(
      <TrackGutter
        rows={[dataRow({ requestedHeightPx: 96, band: { topPx: 100, heightPx: 96 } })]}
        onToggleVisible={noop}
        onRemove={noop}
        onPreviewDataRowHeight={onPreviewDataRowHeight}
        onCommitDataRowHeight={onCommitDataRowHeight}
        onCancelDataRowHeight={onCancelDataRowHeight}
      />
    );

    const handle = screen.getByRole('separator', { name: 'Resize HG002 pileup track height' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onCommitDataRowHeight).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'p1' }),
      96,
      104
    );

    firePointerAt('down', handle, 200, 2);
    firePointerAt('move', document, 220, 2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancelDataRowHeight).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'p1' }),
      96
    );
    expect(onCommitDataRowHeight).toHaveBeenCalledTimes(1);
  });

  it('keeps a bandless data track compact until the renderer publishes its height', () => {
    const label = 'New signal waiting for its renderer band';
    render(
      <TrackGutter
        rows={[dataRow({ label, band: undefined })]}
        onToggleVisible={noop}
        onRemove={noop}
        renderDataControls={() => <div>Settings</div>}
      />
    );

    expect(screen.getByTestId('track-gutter-name-__legacy__:p1')).toHaveAttribute(
      'data-name-layout',
      'single-line'
    );
    expect(screen.queryByTestId('track-gutter-actions-__legacy__:p1')).toBeNull();
    expect(screen.getByLabelText(`Open settings for ${label}`)).toBeVisible();
    expect(screen.getByLabelText(`Remove ${label}`)).toBeVisible();
  });

  it('keeps data settings collapsed until explicitly expanded', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        renderDataControls={(_row, expanded) =>
          expanded ? <div data-testid="data-settings-content">Settings content</div> : null
        }
      />
    );

    expect(screen.queryByTestId('data-settings-content')).toBeNull();
    const settingsButton = screen.getByLabelText('Open settings for HG002 pileup');
    expect(settingsButton.querySelector('[data-icon="settings-gear"]')).not.toBeNull();
    fireEvent.click(settingsButton);
    expect(screen.getByTestId('data-settings-content')).toBeVisible();
    expect(screen.getByTestId('track-gutter-settings-__legacy__:p1')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    fireEvent.click(screen.getByLabelText('Close settings for HG002 pileup'));
    expect(screen.queryByTestId('data-settings-content')).toBeNull();
  });

  it('renders expanded settings in a gutter-owned popover instead of the scrolling row layer', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        renderDataControls={(_row, expanded) =>
          expanded ? <div data-testid="data-settings-content">Settings content</div> : null
        }
      />
    );

    fireEvent.click(screen.getByLabelText('Open settings for HG002 pileup'));

    const panel = screen.getByTestId('track-gutter-settings-panel-__legacy__:p1');
    expect(screen.getByTestId('track-gutter').contains(panel)).toBe(true);
    expect(screen.getByTestId('track-gutter-scroll-layer').contains(panel)).toBe(false);
  });

  it('keeps the pinned chromosome row clear when a tall settings panel opens upward', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if (this.dataset.testid === 'track-gutter') return new DOMRect(0, 100, 220, 300);
        if (this.dataset.trackRowKind === 'cytoband') return new DOMRect(0, 100, 220, 26);
        return new DOMRect(0, 350, 24, 24);
      });
    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(415);
    let unmount: (() => void) | undefined;
    try {
      unmount = render(
        <TrackGutter
          rows={[
            {
              id: 'lane:chromosomes',
              kind: 'cytoband',
              label: 'Chromosomes',
              visible: true,
              removable: false,
              togglable: false,
              band: { topPx: 4, heightPx: 18 },
            },
            dataRow(),
          ]}
          onToggleVisible={noop}
          onRemove={noop}
          renderDataControls={(_row, expanded) => (expanded ? <div>Settings content</div> : null)}
        />
      ).unmount;
      fireEvent.click(screen.getByLabelText('Open settings for HG002 pileup'));
      const panel = screen.getByRole('region', { name: 'Settings for HG002 pileup' });
      expect(panel).toHaveAttribute('data-placement', 'up');
      expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(26);
      expect(Number.parseFloat(panel.style.maxHeight)).toBe(220);
    } finally {
      unmount?.();
      rect.mockRestore();
      scrollHeight.mockRestore();
    }
  });

  it('dismisses expanded settings on an outside pointer press and Escape', () => {
    render(
      <div data-testid="outside">
        <TrackGutter
          rows={[referenceRow(), dataRow()]}
          onToggleVisible={noop}
          onRemove={noop}
          renderDataControls={(_row, expanded) =>
            expanded ? <div data-testid="data-settings-content">Settings content</div> : null
          }
        />
      </div>
    );

    const settingsButton = screen.getByLabelText('Open settings for HG002 pileup');
    fireEvent.click(settingsButton);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('data-settings-content')).toBeNull();

    fireEvent.click(screen.getByLabelText('Open settings for HG002 pileup'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('data-settings-content')).toBeNull();
    expect(settingsButton).toHaveFocus();
  });

  it('places settings below when they fit and flips them above a bottom-row trigger', () => {
    expect(
      trackGutterModule.resolveTrackSettingsPopoverPlacement({
        anchorTop: 150,
        anchorBottom: 174,
        boundaryTop: 100,
        boundaryBottom: 700,
        desiredHeight: 300,
        gap: 4,
      })
    ).toEqual({ direction: 'down', top: 178, maxHeight: 522 });

    expect(
      trackGutterModule.resolveTrackSettingsPopoverPlacement({
        anchorTop: 620,
        anchorBottom: 644,
        boundaryTop: 100,
        boundaryBottom: 700,
        desiredHeight: 300,
        gap: 4,
      })
    ).toEqual({ direction: 'up', top: 316, maxHeight: 516 });
  });

  it('uses the larger available side and caps only at the visible gutter boundary', () => {
    expect(
      trackGutterModule.resolveTrackSettingsPopoverPlacement({
        anchorTop: 360,
        anchorBottom: 384,
        boundaryTop: 100,
        boundaryBottom: 700,
        desiredHeight: 500,
        gap: 4,
      })
    ).toEqual({ direction: 'down', top: 388, maxHeight: 312 });
  });

  it('keeps an unbanded Reference row in normal flow below the chrome', () => {
    render(
      <TrackGutter
        rows={[referenceRow({ band: undefined })]}
        onToggleVisible={noop}
        onRemove={noop}
      />
    );
    const ref = screen.getByTestId('track-gutter-row-lane:reference');
    expect(ref.style.position).not.toBe('absolute');
    expect(screen.getByText('Reference')).toBeVisible();
    expect(screen.getByTestId('track-gutter-visible-lane:reference')).toBeVisible();
  });

  it('keeps the annotation picker open when renderer bands arrive', () => {
    const props = {
      onToggleVisible: noop,
      onRemove: noop,
      annotationTrackRegistry: [
        { trackId: 'gene', label: 'gene', order: 0, visible: true },
        { trackId: 'mRNA', label: 'mRNA', order: 1, visible: true },
      ],
      visibleTypes: new Set(['gene']),
      onToggleVisibleType: noop,
      onSetVisibleTypes: noop,
    } satisfies Omit<ComponentProps<typeof TrackGutter>, 'rows'>;
    const { rerender } = render(
      <TrackGutter rows={[referenceRow({ band: undefined })]} {...props} />
    );

    fireEvent.click(screen.getByTestId('annotation-type-picker-summary'));
    expect(screen.getByTestId('annotation-type-picker')).toBeVisible();

    rerender(<TrackGutter rows={[referenceRow()]} {...props} />);

    expect(screen.getByTestId('annotation-type-picker')).toBeVisible();
  });

  it('gives Reference on/off (no delete); data lanes get both', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );
    expect(screen.getByTestId('track-gutter-visible-lane:reference')).toBeTruthy();
    expect(screen.queryByTestId('track-gutter-remove-lane:reference')).toBeNull();
    expect(screen.getByTestId('track-gutter-visible-__legacy__:p1')).toBeTruthy();
    expect(screen.getByTestId('track-gutter-remove-__legacy__:p1')).toBeTruthy();
  });

  it('routes Reference and data on/off toggles to onToggleVisible with the row', () => {
    const onToggleVisible = vi.fn();
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={onToggleVisible}
        onRemove={noop}
        onAddTrack={noop}
      />
    );
    fireEvent.click(screen.getByTestId('track-gutter-visible-lane:reference'));
    fireEvent.click(screen.getByTestId('track-gutter-visible-__legacy__:p1'));
    expect(onToggleVisible).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'lane:reference' })
    );
    expect(onToggleVisible).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: '__legacy__:p1' })
    );
  });

  it('routes remove to onRemove with the row', () => {
    const onRemove = vi.fn();
    render(
      <TrackGutter
        rows={[dataRow()]}
        onToggleVisible={noop}
        onRemove={onRemove}
        onAddTrack={noop}
      />
    );
    fireEvent.click(screen.getByTestId('track-gutter-remove-__legacy__:p1'));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: '__legacy__:p1' }));
  });

  it('moves data tracks from a dedicated drag handle without making the whole row draggable', () => {
    const onMoveDataRow = vi.fn();
    render(
      <TrackGutter
        rows={[
          dataRow({
            id: 'tab:signal',
            trackId: 'signal',
            label: 'Signal',
            reorderable: true,
          }),
          dataRow({
            id: 'tab:interval',
            trackId: 'interval',
            label: 'CpG Islands',
            reorderable: true,
          }),
        ]}
        onToggleVisible={noop}
        onRemove={noop}
        onMoveDataRow={onMoveDataRow}
      />
    );

    const handle = screen.getByRole('button', { name: 'Move CpG Islands' });
    expect(handle).toHaveAttribute('draggable', 'true');
    const grip = screen.getByTestId('track-gutter-drag-grip-tab:interval');
    const dots = [...grip.querySelectorAll('circle')];
    expect(dots).toHaveLength(6);
    expect(dots.map((dot) => [dot.getAttribute('cx'), dot.getAttribute('cy')])).toEqual([
      ['3', '3'],
      ['9', '3'],
      ['3', '9'],
      ['9', '9'],
      ['3', '15'],
      ['9', '15'],
    ]);
    expect(screen.getByTestId('track-gutter-row-tab:interval')).not.toHaveAttribute(
      'draggable',
      'true'
    );

    fireEvent.keyDown(handle, { key: 'ArrowUp' });

    expect(onMoveDataRow).toHaveBeenCalledWith('interval', 'signal', 'before');
  });

  it('omits the redundant healthy status dot but exposes an exceptional track state', () => {
    const row = dataRow({ label: 'Signal with status' });
    const { rerender } = render(
      <TrackGutter
        rows={[row]}
        onToggleVisible={noop}
        onRemove={noop}
        dataRowTone={() => 'default'}
      />
    );

    expect(screen.queryByLabelText('Signal with status status: Ready')).toBeNull();
    expect(
      screen.getByTestId('track-gutter-row-__legacy__:p1').querySelector('.bg-blue-500')
    ).toBeNull();

    rerender(
      <TrackGutter
        rows={[row]}
        onToggleVisible={noop}
        onRemove={noop}
        dataRowTone={() => 'blocked'}
      />
    );

    expect(screen.getByLabelText('Signal with status status: Failed to load')).toBeVisible();
  });

  it('previews the complete unequal-height row order before drop and commits only once', () => {
    const onPreviewDataRowOrder = vi.fn();
    const onCommitDataRowOrder = vi.fn();
    const onCancelDataRowOrder = vi.fn();
    render(
      <TrackGutter
        rows={[
          dataRow({
            id: 'tab:signal',
            trackId: 'signal',
            label: 'Signal',
            reorderable: true,
            band: { topPx: 100, heightPx: 40 },
          }),
          dataRow({
            id: 'tab:interval',
            trackId: 'interval',
            label: 'CpG Islands',
            reorderable: true,
            band: { topPx: 140, heightPx: 80 },
          }),
        ]}
        dataRowOrder={['signal', 'interval']}
        onToggleVisible={noop}
        onRemove={noop}
        onPreviewDataRowOrder={onPreviewDataRowOrder}
        onCommitDataRowOrder={onCommitDataRowOrder}
        onCancelDataRowOrder={onCancelDataRowOrder}
      />
    );
    const signalRow = screen.getByTestId('track-gutter-row-tab:signal');
    const intervalRow = screen.getByTestId('track-gutter-row-tab:interval');
    const rowContainer = screen.getByTestId('track-gutter-row-container');
    vi.spyOn(rowContainer, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 800,
      left: 0,
      right: 220,
      width: 220,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(signalRow, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 0,
      right: 220,
      width: 220,
      height: 40,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(intervalRow, 'getBoundingClientRect').mockReturnValue({
      top: 140,
      bottom: 220,
      left: 0,
      right: 220,
      width: 220,
      height: 80,
      x: 0,
      y: 140,
      toJSON: () => ({}),
    });
    const transfer = dragTransfer();
    const handle = screen.getByRole('button', { name: 'Move CpG Islands' });

    fireDragStartWithPointer(handle, transfer, 12, 150);
    expect(transfer.setDragImage).toHaveBeenCalledWith(intervalRow, 12, 10);
    expect(intervalRow).toHaveAttribute('data-drag-state', 'dragging');

    fireDragOverWithPointer(signalRow, transfer, 120);
    expect(onPreviewDataRowOrder).not.toHaveBeenCalled();

    fireDragOverWithPointer(signalRow, transfer, 110);

    expect(onPreviewDataRowOrder).toHaveBeenCalledWith(['interval', 'signal']);
    expect(onCommitDataRowOrder).not.toHaveBeenCalled();
    expect(intervalRow.style.top).toBe('100px');
    expect(signalRow.style.top).toBe('180px');
    expect(intervalRow.style.height).toBe('80px');
    expect(intervalRow.className).toContain('transition-[top,box-shadow,transform]');
    expect(intervalRow.className).not.toContain('transition-[top,height');

    fireDragLeaveWithPointer(signalRow, 40, 110);
    fireEvent.dragEnd(handle, { dataTransfer: transfer });

    expect(onCommitDataRowOrder).toHaveBeenCalledOnce();
    expect(onCommitDataRowOrder).toHaveBeenCalledWith(['interval', 'signal']);
    expect(onCancelDataRowOrder).not.toHaveBeenCalled();
  });

  it('restores the durable presentation when a native drag ends without a drop', () => {
    const onPreviewDataRowOrder = vi.fn();
    const onCancelDataRowOrder = vi.fn();
    render(
      <TrackGutter
        rows={[
          dataRow({ id: 'tab:signal', trackId: 'signal', reorderable: true }),
          dataRow({
            id: 'tab:interval',
            trackId: 'interval',
            label: 'CpG Islands',
            reorderable: true,
            band: { topPx: 500, heightPx: 60 },
          }),
        ]}
        dataRowOrder={['signal', 'interval']}
        onToggleVisible={noop}
        onRemove={noop}
        onPreviewDataRowOrder={onPreviewDataRowOrder}
        onCommitDataRowOrder={vi.fn()}
        onCancelDataRowOrder={onCancelDataRowOrder}
      />
    );
    const signalRow = screen.getByTestId('track-gutter-row-tab:signal');
    vi.spyOn(signalRow, 'getBoundingClientRect').mockReturnValue({
      top: 440,
      bottom: 500,
      left: 0,
      right: 220,
      width: 220,
      height: 60,
      x: 0,
      y: 440,
      toJSON: () => ({}),
    });
    const transfer = dragTransfer();
    const handle = screen.getByRole('button', { name: 'Move CpG Islands' });
    fireDragStartWithPointer(handle, transfer, 8, 510);
    fireDragOverWithPointer(signalRow, transfer, 450);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.dragEnd(handle, { dataTransfer: transfer });

    expect(onPreviewDataRowOrder).toHaveBeenCalledWith(['interval', 'signal']);
    expect(onCancelDataRowOrder).toHaveBeenCalledOnce();
  });

  it('opens the add flow when + is clicked', () => {
    const onAddTrack = vi.fn();
    render(
      <TrackGutter
        rows={[dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={onAddTrack}
      />
    );
    fireEvent.click(screen.getByTestId('track-gutter-add'));
    expect(onAddTrack).toHaveBeenCalled();
  });

  it('renders as a dedicated in-flow column, not a click-through overlay', () => {
    render(
      <TrackGutter rows={[dataRow()]} onToggleVisible={noop} onRemove={noop} onAddTrack={noop} />
    );
    const cls = screen.getByTestId('track-gutter').className;
    expect(cls).not.toContain('pointer-events-none');
    expect(cls).not.toContain('absolute');
  });

  it('routes wheel motion to vertical track scrolling only from the gutter', () => {
    const onVerticalScroll = vi.fn(() => true);
    const onOuterWheel = vi.fn();
    render(
      <div onWheel={onOuterWheel}>
        <TrackGutter
          rows={[referenceRow()]}
          onToggleVisible={noop}
          onRemove={noop}
          onVerticalScroll={onVerticalScroll}
        />
      </div>
    );

    const browserDefaultAllowed = fireEvent.wheel(screen.getByTestId('track-gutter'), {
      deltaY: 37,
      cancelable: true,
    });

    expect(onVerticalScroll).toHaveBeenCalledOnce();
    expect(onVerticalScroll).toHaveBeenCalledWith(37);
    expect(browserDefaultAllowed).toBe(false);
    expect(onOuterWheel).not.toHaveBeenCalled();
  });

  it('contains gutter wheel motion when the vertical stack is already at a boundary', () => {
    const onVerticalScroll = vi.fn(() => false);
    const onOuterWheel = vi.fn();
    render(
      <div onWheel={onOuterWheel}>
        <TrackGutter
          rows={[referenceRow()]}
          onToggleVisible={noop}
          onRemove={noop}
          onVerticalScroll={onVerticalScroll}
        />
      </div>
    );

    fireEvent.wheel(screen.getByTestId('track-gutter'), { deltaY: -12 });

    expect(onVerticalScroll).toHaveBeenCalledWith(-12);
    expect(onOuterWheel).not.toHaveBeenCalled();
  });

  it('applies one renderer-completed-frame scroll receipt synchronously to the row layer', () => {
    type PresentedTrackScrollReceipt = {
      completedFrameEpoch: number;
      trackScrollTop: number;
    };
    type ApplyPresentedTrackScrollReceipt = (
      target: HTMLElement,
      receipt: PresentedTrackScrollReceipt
    ) => void;
    const applyReceipt = (
      trackGutterModule as typeof trackGutterModule & {
        applyPresentedTrackScrollReceipt?: ApplyPresentedTrackScrollReceipt;
      }
    ).applyPresentedTrackScrollReceipt;

    expect(
      applyReceipt,
      'TrackGutter must expose the direct presented-frame adapter; a 200ms React poll cannot satisfy this contract'
    ).toBeTypeOf('function');
    if (!applyReceipt) return;

    const rowLayer = document.createElement('div');
    applyReceipt(rowLayer, { completedFrameEpoch: 73, trackScrollTop: 44.5 });

    expect(rowLayer.style.transform).toBe('translate3d(0, -44.5px, 0)');
    expect(rowLayer.dataset.presentedFrameEpoch).toBe('73');
    expect(rowLayer.dataset.trackScrollTop).toBe('44.5');
  });

  it('aligns each row to its lane band (grid mode)', () => {
    render(
      <TrackGutter
        rows={[referenceRow(), dataRow()]}
        onToggleVisible={noop}
        onRemove={noop}
        onAddTrack={noop}
      />
    );
    const ref = screen.getByTestId('track-gutter-row-lane:reference');
    expect(ref.style.position).toBe('absolute');
    expect(ref.style.top).toBe('14px');
    expect(ref.style.height).toBe('400px');
  });

  describe('collapsed', () => {
    function gutter(over: Partial<ComponentProps<typeof TrackGutter>> = {}) {
      return (
        <TrackGutter
          rows={[referenceRow(), dataRow()]}
          onToggleVisible={noop}
          onRemove={noop}
          onAddTrack={noop}
          collapsed
          {...over}
        />
      );
    }

    it('collapses to the rail width, ignoring the stored width', () => {
      render(gutter({ width: 300 }));
      expect(screen.getByTestId('track-gutter').style.width).toBe(`${GUTTER_COLLAPSED_WIDTH}px`);
    });

    it('hides the resize handle while collapsed', () => {
      render(gutter({ onResize: noop }));
      expect(screen.queryByTestId('track-gutter-resize')).toBeNull();
    });

    it('hides labels and per-row controls while collapsed', () => {
      render(gutter());
      expect(screen.queryByText('Reference')).toBeNull();
      expect(screen.queryByTestId('track-gutter-visible-lane:reference')).toBeNull();
    });

    it('keeps every lane rail-aligned to its band while collapsed', () => {
      render(gutter());
      expect(screen.getByTestId('track-gutter-row-lane:reference').style.top).toBe('14px');
      expect(screen.getByTestId('track-gutter-row-__legacy__:p1').style.top).toBe('440px');
    });

    it('expands from the header while collapsed', () => {
      const onToggleCollapsed = vi.fn();
      render(<TrackGutterHeader collapsed onToggleCollapsed={onToggleCollapsed} />);
      fireEvent.click(screen.getByTestId('track-gutter-expand'));
      expect(onToggleCollapsed).toHaveBeenCalled();
    });

    it('collapses from the header while expanded', () => {
      const onToggleCollapsed = vi.fn();
      render(<TrackGutterHeader collapsed={false} onToggleCollapsed={onToggleCollapsed} />);
      fireEvent.click(screen.getByTestId('track-gutter-collapse'));
      expect(onToggleCollapsed).toHaveBeenCalled();
    });

    it('gives expand and collapse the same hover target shape', () => {
      const { unmount } = render(<TrackGutterHeader collapsed onToggleCollapsed={noop} />);
      const expand = screen.getByTestId('track-gutter-expand').className;
      unmount();
      render(<TrackGutterHeader collapsed={false} onToggleCollapsed={noop} />);
      const collapse = screen.getByTestId('track-gutter-collapse').className;
      for (const shape of ['h-6', 'w-6', 'rounded']) {
        expect(expand.split(' ')).toContain(shape);
        expect(collapse.split(' ')).toContain(shape);
      }
    });

    it('offers no collapse affordance when onToggleCollapsed is not provided', () => {
      render(<TrackGutterHeader collapsed={false} />);
      expect(screen.queryByTestId('track-gutter-collapse')).toBeNull();
    });

    it('pins the chromosome-strip row outside the scrolling rows', () => {
      render(
        <TrackGutter
          rows={[
            {
              id: 'lane:cytoband',
              kind: 'cytoband',
              label: 'Chromosomes',
              visible: true,
              removable: false,
              togglable: true,
              band: { topPx: 8, heightPx: 32 },
            },
            referenceRow(),
          ]}
          onToggleVisible={noop}
          onRemove={noop}
          collapsed={false}
        />
      );
      const pinned = screen.getByTestId('track-gutter-row-lane:cytoband');
      expect(screen.getByTestId('track-gutter-scroll-layer').contains(pinned)).toBe(false);
      expect(pinned.style.top).toBe('0px');
      expect(pinned.style.height).toBe('48px');
      expect(screen.getByLabelText('Show Chromosomes')).toBeChecked();
    });
  });
});
