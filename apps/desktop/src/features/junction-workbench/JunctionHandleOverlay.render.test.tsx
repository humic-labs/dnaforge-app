/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JunctionHandleOverlay, type JunctionFieldHandle } from './JunctionHandleOverlay';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('JunctionHandleOverlay', () => {
  it('keeps drag local and commits the final field value', async () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();
    const handle = fieldHandle({ value: 20, dragScale: 1 });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={preview}
        onCommit={commit}
        onLivePreview={livePreview}
        onLivePreviewEnd={livePreviewEnd}
      />
    );

    const button = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    fireEvent.mouseDown(button, { button: 0, clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 35 });
    fireEvent.mouseUp(window, { clientX: 35 });

    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).toHaveBeenCalledWith(handle, 24);
    expect(commit).toHaveBeenCalledWith(handle, 24);
    await flushDeferredPreviewEnd();
    expect(livePreviewEnd).toHaveBeenCalledOnce();
  });

  it('does not commit a click release when the snapped value never changed', () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const cancel = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();
    const handle = fieldHandle({ value: 20, dragScale: 1 });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={preview}
        onCommit={commit}
        onCancel={cancel}
        onLivePreview={livePreview}
        onLivePreviewEnd={livePreviewEnd}
      />
    );

    const button = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    fireEvent.mouseDown(button, { button: 0, clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 100 });

    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).not.toHaveBeenCalled();
    expect(livePreviewEnd).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('moves the active handle continuously and live-previews primer length on snapped changes', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const preview = vi.fn();
    const commit = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();
    const handle = fieldHandle({
      value: 20,
      dragScale: 1,
      previewSegments: [{ x: 80, y: 10, width: 40, height: 12 }],
    });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={preview}
        onCommit={commit}
        onLivePreview={livePreview}
        onLivePreviewEnd={livePreviewEnd}
      />
    );

    const overlay = screen.getByTestId('junction-handle-overlay');
    const button = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    expect(screen.queryByTestId('junction-primer-preview-primerPbs-pbs-end')).toBeNull();
    const renderCountBefore = overlay.getAttribute('data-overlay-render-count');
    fireEvent.mouseDown(button, { button: 0, clientX: 100 });

    fireEvent.mouseMove(window, { clientX: 104 });

    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).not.toHaveBeenCalled();
    expect(overlay).toHaveAttribute('data-overlay-render-count', renderCountBefore);
    expect(button).toHaveAttribute('data-drag-offset-px', '4');
    expect(button).toHaveStyle({ transform: 'translateX(calc(-50% + 4px))' });

    fireEvent.mouseMove(window, { clientX: 106 });
    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).toHaveBeenCalledWith(handle, 21);
    expect(button).toHaveAttribute('data-field-value', '21');

    fireEvent.mouseUp(window, { clientX: 106 });
    expect(livePreviewEnd).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(handle, 21);
  });

  it('live-sync-previews overlap handle drags on snapped value changes', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const preview = vi.fn();
    const commit = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();
    const handle = homologyHandle({ value: 20, dragScale: 1 });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={preview}
        onCommit={commit}
        onLivePreview={livePreview}
        onLivePreviewEnd={livePreviewEnd}
      />
    );

    const button = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    fireEvent.mouseDown(button, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 104 });

    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).not.toHaveBeenCalled();

    fireEvent.mouseMove(window, { clientX: 106 });
    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).toHaveBeenCalledWith(handle, 21);

    fireEvent.mouseUp(window, { clientX: 106 });
    expect(livePreviewEnd).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(handle, 21);
  });

  it('samples the release coordinate before committing a handle drag', async () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();
    const handle = homologyHandle({ value: 20, dragScale: 1 });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={preview}
        onCommit={commit}
        onLivePreview={livePreview}
        onLivePreviewEnd={livePreviewEnd}
      />
    );

    const button = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    fireEvent.mouseDown(button, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 104 });
    expect(livePreview).not.toHaveBeenCalled();

    fireEvent.mouseUp(window, { clientX: 106 });

    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).toHaveBeenCalledWith(handle, 21);
    expect(commit).toHaveBeenCalledWith(handle, 21);
    await flushDeferredPreviewEnd();
    expect(livePreviewEnd).toHaveBeenCalledOnce();
  });

  it('hard-fails animated handles without live-sync wiring', () => {
    const handle = homologyHandle({ value: 20, dragScale: 1 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() =>
        render(
          <JunctionHandleOverlay
            handles={[handle]}
            pxPerBase={10}
            scrollLeft={0}
            height={100}
            onPreview={vi.fn()}
            onCommit={vi.fn()}
          />
        )
      ).toThrow(/requires live-sync preview wiring/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('exposes slider semantics and keyboard editing', () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const handle = fieldHandle({ value: 20, largeStep: 5 });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={preview}
        onCommit={commit}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    const button = screen.getByRole('slider', { name: 'Primer PBS' });
    expect(button).toHaveAttribute('aria-valuemin', '10');
    expect(button).toHaveAttribute('aria-valuemax', '60');
    expect(button).toHaveAttribute('aria-valuenow', '20');

    fireEvent.keyDown(button, { key: 'ArrowRight', shiftKey: true });
    expect(preview).toHaveBeenCalledWith(handle, 25);
    expect(commit).toHaveBeenCalledWith(handle, 25);
  });

  it('renders primer handles as a docked grip with a hairline dotted guide', () => {
    const handle = fieldHandle({
      color: '#38bdf8',
      y: 24,
      height: 12,
    });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    const button = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    const line = screen.getByTestId('junction-field-handle-line-primerPbs-pbs-end');
    const grip = screen.getByTestId('junction-field-handle-grip-primerPbs-pbs-end');
    expect(button).toHaveAttribute('data-handle-variant', 'primer');
    expect(button).toHaveAttribute('data-handle-visual-contract', 'assembly-primer-handle-v1');
    expect(button).toHaveAttribute('data-handle-dock', 'bottom');
    expect(button).toHaveStyle({ top: '78px', width: '28px', height: '22px' });
    expect(button).toHaveClass('opacity-0');
    expect(button).toHaveClass('pointer-events-none');
    expect(button).toHaveClass('group-hover/junction-card:opacity-100');
    expect(button).toHaveClass('group-hover/junction-card:pointer-events-auto');
    expect(button.style.color).toBe('rgb(104, 102, 99)');
    expect(button.style.backgroundColor).toBe('transparent');
    expect(button.style.boxShadow).toBe('none');
    expect(line).toHaveStyle({
      top: '-54px',
      width: '1px',
      height: '64px',
      boxShadow: 'none',
    });
    expect(line.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(line.style.borderLeftStyle).toBe('');
    expect(grip).toHaveStyle({ top: '10px', width: '16px', height: '7px', boxShadow: 'none' });
    expect(grip).toHaveStyle({
      backgroundColor: 'rgb(196, 195, 194)',
      borderColor: 'rgb(117, 116, 113)',
      borderRadius: '5px',
    });
    expect(screen.queryByTestId('junction-field-handle-dot-primerPbs-pbs-end')).toBeNull();
  });

  it('keeps edge primer handle hit targets inside while preserving the boundary indicator', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          this.callback([{ target } as ResizeObserverEntry], this);
        }
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const el = this as HTMLElement;
      if (el.dataset.testid === 'junction-handle-overlay') {
        return rect({ width: 200, height: 100 });
      }
      return rect({ width: 0, height: 0 });
    });
    const handle = fieldHandle({ x: 0, y: 24, height: 12 });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    const button = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    const line = screen.getByTestId('junction-field-handle-line-primerPbs-pbs-end');
    const dot = screen.queryByTestId('junction-field-handle-dot-primerPbs-pbs-end');

    expect(button).toHaveAttribute('data-handle-raw-center-x', '0');
    expect(button).toHaveAttribute('data-handle-center-x', '14');
    expect(button).toHaveAttribute('data-handle-indicator-x', '0');
    expect(button).toHaveStyle({ left: '14px', width: '28px' });
    expect(line).toHaveStyle({ left: '0px' });
    expect(dot).toBeNull();
    expect(screen.getByTestId('junction-field-handle-grip-primerPbs-pbs-end')).toHaveStyle({
      left: '0px',
    });
  });

  it('renders overlap handles with the same docked guide pattern', () => {
    const handle = homologyHandle({
      kind: 'homologyArm',
      role: 'tail-start',
      color: '#34d399',
      y: 48,
      height: 52,
      guideStartY: 48,
    });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    const button = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    const line = screen.getByTestId('junction-field-handle-line-homologyArm-tail-start');
    const grip = screen.getByTestId('junction-field-handle-grip-homologyArm-tail-start');
    expect(button).toHaveAttribute('data-handle-variant', 'overlap');
    expect(button).toHaveAttribute('data-handle-dock', 'bottom');
    expect(button.style.width).toBe('28px');
    expect(button.style.top).toBe('78px');
    expect(button.style.color).toBe(
      'color-mix(in srgb, hsl(var(--color-fg)) 80%, hsl(var(--color-fg-muted)) 20%)'
    );
    expect(button.style.backgroundColor).toBe('transparent');
    expect(button.style.boxShadow).toBe('none');
    expect(line).toHaveStyle({
      width: '1px',
      top: '-30px',
      height: '40px',
      boxShadow: 'none',
    });
    expect(line.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(line.style.borderLeftStyle).toBe('');
    expect(grip).toHaveStyle({ top: '10px', width: '16px', height: '7px' });
  });

  it('renders disabled homology overlap handles as non-control gray markers', () => {
    const handle = homologyHandle({
      kind: 'homologyArm',
      role: 'tail-start',
      disabled: true,
    });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    const marker = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    const line = screen.getByTestId('junction-field-handle-line-homologyArm-tail-start');
    expect(marker.tagName).toBe('DIV');
    expect(marker).not.toHaveAttribute('role', 'slider');
    expect(marker).not.toHaveAttribute('data-linked-pan-exclude');
    expect(marker).toHaveClass('pointer-events-none');
    expect(marker).toHaveAttribute('data-handle-disabled', 'true');
    expect(marker).toHaveAttribute('data-handle-variant', 'overlap');
    expect(marker).toHaveAttribute('data-handle-dock', 'bottom');
    expect(marker.style.color).toBe(
      'color-mix(in srgb, hsl(var(--color-fg-muted)) 54%, hsl(var(--color-bg)) 46%)'
    );
    expect(line.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(line.style.borderLeftStyle).toBe('');
  });

  it('keeps the editable overlap handle draggable when its paired constrained marker is present', async () => {
    const commit = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();
    const lockedMarker = homologyHandle({
      id: 'locked-left',
      role: 'tail-start',
      disabled: true,
      x: 80,
    });
    const editableHandle = homologyHandle({
      id: 'editable-right',
      role: 'tail-end',
      value: 12,
      x: 120,
      dragScale: 1,
      field: {
        ...homologyHandle().field,
        id: 'right-homology-field',
        label: 'Right homology',
        target: { junctionIndex: 0, side: 'right' },
        value: 12,
        command: {
          type: 'setHomologyEncoding',
          payload: { junctionIndex: 0, encoding: { onLeft: 0, onRight: 12 } },
          valueKey: 'encoding.onRight',
        },
      },
    });

    render(
      <JunctionHandleOverlay
        handles={[lockedMarker, editableHandle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={commit}
        onLivePreview={livePreview}
        onLivePreviewEnd={livePreviewEnd}
      />
    );

    const editable = screen.getByTestId('junction-field-handle-homologyArm-tail-end');
    fireEvent.mouseDown(editable, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 116 });
    fireEvent.mouseUp(window, { button: 0, clientX: 116 });

    expect(livePreview).toHaveBeenCalledWith(editableHandle, 14);
    expect(commit).toHaveBeenCalledWith(editableHandle, 14);
    await flushDeferredPreviewEnd();
    expect(livePreviewEnd).toHaveBeenCalledOnce();
  });

  it('stacks a product overlap handle above a primer handle at the same position', () => {
    render(
      <JunctionHandleOverlay
        handles={[
          homologyHandle({ id: 'homology-field:product:overlap-left', x: 100 }),
          fieldHandle({ id: 'field:product:pbs-start', role: 'pbs-start', x: 100 }),
        ]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    expect(screen.getByTestId('junction-field-handle-homologyArm-tail-start').style.zIndex).toBe(
      '20'
    );
    expect(screen.getByTestId('junction-field-handle-primerPbs-pbs-start').style.zIndex).toBe('');
  });

  it('parks handles whose boundaries are beyond the same edge on separate targets', () => {
    measureOverlayAs(466);
    render(
      <JunctionHandleOverlay
        handles={[
          homologyHandle({ id: 'homology-field:product:overlap-left', x: -326 }),
          homologyHandle({
            id: 'right-homology-field:product:overlap-right',
            label: 'Right homology',
            role: 'tail-end',
            x: -86,
          }),
          fieldHandle({ id: 'field:product:pbs-end', x: 595 }),
          fieldHandle({ id: 'field:product:pbs-start', role: 'pbs-start', x: 211 }),
        ]}
        pxPerBase={8}
        scrollLeft={0}
        height={132}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
        onPanRequest={vi.fn()}
      />
    );

    const overlapStart = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    const overlapEnd = screen.getByTestId('junction-field-handle-homologyArm-tail-end');
    const bindingEnd = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    const bindingStart = screen.getByTestId('junction-field-handle-primerPbs-pbs-start');

    expect(overlapStart).toHaveAttribute('data-handle-placement', 'offscreen-left');
    expect(overlapEnd).toHaveAttribute('data-handle-placement', 'offscreen-left');
    expect(bindingEnd).toHaveAttribute('data-handle-placement', 'offscreen-right');
    expect(bindingStart).toHaveAttribute('data-handle-placement', 'boundary');
    expect(overlapStart).toHaveStyle({ left: '14px', top: '110px', width: '28px', height: '22px' });
    expect(overlapEnd).toHaveStyle({ left: '42px', top: '110px', width: '28px', height: '22px' });
    expect(bindingEnd).toHaveStyle({ left: '452px', top: '110px', width: '28px' });
    expect(bindingStart).toHaveStyle({ left: '211px', top: '110px' });
    expect(overlapStart).toHaveAttribute('data-handle-raw-center-x', '-326');
    expect(overlapStart).not.toHaveAttribute('data-handle-indicator-x');
    expect(
      screen.getByTestId('junction-field-handle-parked-hint-homologyArm-tail-start')
    ).toHaveAttribute(
      'title',
      'Left homology is 41 bp off screen to the left. Click to bring it into view.'
    );
    expect(overlapStart.style.cursor).toBe('pointer');
    expect(bindingStart.style.cursor).toBe('');
    expect(screen.queryByTestId('junction-field-handle-line-homologyArm-tail-start')).toBeNull();
    expect(screen.queryByTestId('junction-field-handle-line-homologyArm-tail-end')).toBeNull();
    expect(screen.queryByTestId('junction-field-handle-line-primerPbs-pbs-end')).toBeNull();
    expect(screen.getByTestId('junction-field-handle-line-primerPbs-pbs-start')).toHaveStyle({
      left: '14px',
    });
    expect(
      screen.getByTestId('junction-field-handle-parked-chevron-homologyArm-tail-start')
    ).toBeInTheDocument();
    expect(screen.getByTestId('junction-field-handle-grip-homologyArm-tail-start')).toHaveStyle({
      left: '17.5px',
      top: '10px',
      width: '16px',
    });
    expect(screen.getByTestId('junction-field-handle-grip-primerPbs-pbs-end')).toHaveStyle({
      left: '10.5px',
    });
  });

  it('pans to a parked handle on click without starting a drag', () => {
    measureOverlayAs(466);
    const commit = vi.fn();
    const livePreview = vi.fn();
    const panRequest = vi.fn();
    render(
      <JunctionHandleOverlay
        handles={[homologyHandle({ x: 100 })]}
        pxPerBase={8}
        scrollLeft={426}
        height={132}
        onPreview={vi.fn()}
        onCommit={commit}
        onLivePreview={livePreview}
        onLivePreviewEnd={vi.fn()}
        onPanRequest={panRequest}
      />
    );

    const parked = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    fireEvent.pointerDown(parked, { button: 0, pointerId: 7, clientX: 14 });
    fireEvent.mouseDown(parked, { button: 0, clientX: 14 });
    fireEvent.mouseMove(window, { clientX: 54 });
    fireEvent.mouseUp(window, { clientX: 54 });
    fireEvent.click(parked);

    expect(parked).toHaveAttribute('data-dragging', 'false');
    expect(livePreview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(panRequest).toHaveBeenCalledOnce();
    expect(panRequest).toHaveBeenCalledWith(-422);
  });

  it('pans to a parked handle when the keyboard focuses it and still steps its value', () => {
    measureOverlayAs(466);
    const preview = vi.fn();
    const commit = vi.fn();
    const panRequest = vi.fn();
    const handle = fieldHandle({ x: 1061 });
    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={8}
        scrollLeft={0}
        height={132}
        onPreview={preview}
        onCommit={commit}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
        onPanRequest={panRequest}
      />
    );

    const parked = screen.getByRole('slider', { name: 'Primer PBS' });
    act(() => parked.focus());
    expect(panRequest).toHaveBeenLastCalledWith(691);

    fireEvent.keyDown(parked, { key: 'ArrowRight' });
    expect(panRequest).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledWith(handle, 21);
    expect(commit).toHaveBeenCalledWith(handle, 21);
  });

  it('draws nothing for an off-screen boundary when the strip cannot pan', () => {
    measureOverlayAs(466);
    render(
      <JunctionHandleOverlay
        handles={[homologyHandle({ x: -86 }), fieldHandle({ x: 120 })]}
        pxPerBase={8}
        scrollLeft={0}
        height={132}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    expect(screen.queryByTestId('junction-field-handle-homologyArm-tail-start')).toBeNull();
    expect(screen.getByTestId('junction-field-handle-primerPbs-pbs-end')).toHaveAttribute(
      'data-handle-placement',
      'boundary'
    );
  });

  it('hides an off-screen locked marker and an in-view primer handle whose primer is not drawn yet', () => {
    measureOverlayAs(466);
    render(
      <JunctionHandleOverlay
        handles={[
          homologyHandle({ id: 'locked', disabled: true, x: -86 }),
          fieldHandle({ id: 'unresolved-in-view', x: 120, geometryPending: true }),
          fieldHandle({
            id: 'unresolved-off-screen',
            role: 'pbs-start',
            x: -159,
            geometryPending: true,
          }),
        ]}
        pxPerBase={8}
        scrollLeft={0}
        height={132}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
        onPanRequest={vi.fn()}
      />
    );

    expect(screen.queryByTestId('junction-field-handle-homologyArm-tail-start')).toBeNull();
    expect(screen.queryByTestId('junction-field-handle-primerPbs-pbs-end')).toBeNull();
    expect(screen.getByTestId('junction-field-handle-primerPbs-pbs-start')).toHaveAttribute(
      'data-handle-placement',
      'offscreen-left'
    );
  });

  it('keeps keyboard focus on a parked primer handle while it is brought into view', () => {
    measureOverlayAs(466);
    const props = {
      pxPerBase: 8,
      height: 132,
      onPreview: vi.fn(),
      onCommit: vi.fn(),
      onLivePreview: vi.fn(),
      onLivePreviewEnd: vi.fn(),
      onPanRequest: vi.fn(),
    };
    const parkedHandle = fieldHandle({ x: 728, geometryPending: true });
    const { rerender } = render(
      <JunctionHandleOverlay handles={[parkedHandle]} scrollLeft={0} {...props} />
    );
    const parked = screen.getByRole('slider', { name: 'Primer PBS' });
    act(() => parked.focus());

    rerender(<JunctionHandleOverlay handles={[parkedHandle]} scrollLeft={358} {...props} />);
    expect(screen.getByRole('slider', { name: 'Primer PBS' })).toBe(parked);
    expect(parked).toHaveFocus();
    expect(parked).toHaveAttribute('data-handle-placement', 'boundary');
    expect(screen.queryByTestId('junction-field-handle-line-primerPbs-pbs-end')).toBeNull();

    rerender(
      <JunctionHandleOverlay
        handles={[fieldHandle({ x: 728, y: 24, height: 12 })]}
        scrollLeft={358}
        {...props}
      />
    );
    expect(parked).toHaveFocus();
    expect(screen.getByTestId('junction-field-handle-line-primerPbs-pbs-end')).toBeInTheDocument();
  });

  it('lifts parked handles above the grip row when a visible grip needs that corner', () => {
    measureOverlayAs(466);
    render(
      <JunctionHandleOverlay
        handles={[
          homologyHandle({ id: 'homology-field:product:overlap-left', x: -86 }),
          fieldHandle({ id: 'field:product:pbs-start', role: 'pbs-start', x: 6 }),
        ]}
        pxPerBase={8}
        scrollLeft={0}
        height={132}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
        onPanRequest={vi.fn()}
      />
    );

    expect(screen.getByTestId('junction-field-handle-homologyArm-tail-start')).toHaveStyle({
      left: '14px',
      top: '88px',
    });
    expect(screen.getByTestId('junction-field-handle-primerPbs-pbs-start')).toHaveStyle({
      left: '14px',
      top: '110px',
    });
    expect(screen.getByTestId('junction-field-handle-line-primerPbs-pbs-start')).toHaveStyle({
      left: '6px',
    });
  });

  it('renders Golden Gate product overhang handles as one unified span', () => {
    const handle = goldenGateOverhangHandle({
      x: 100,
      y: 48,
      height: 52,
      guideStartY: 48,
      visualSpan: { startX: 80, endX: 120 },
    });

    render(
      <JunctionHandleOverlay
        handles={[handle]}
        pxPerBase={10}
        scrollLeft={0}
        height={100}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onLivePreview={vi.fn()}
        onLivePreviewEnd={vi.fn()}
      />
    );

    const button = screen.getByTestId('junction-field-handle-goldenGateOverhang-boundary');
    const span = screen.getByTestId('junction-field-handle-span-goldenGateOverhang-boundary');
    const line = screen.getByTestId('junction-field-handle-line-goldenGateOverhang-boundary');
    expect(button).toHaveAttribute('data-handle-variant', 'goldenGateOverhang');
    expect(button).toHaveAttribute('data-handle-dock', 'bottom');
    expect(button).toHaveStyle({ top: '78px', width: '50px', height: '22px' });
    expect(span).toHaveStyle({
      left: '5px',
      top: '10px',
      width: '40px',
      height: '7px',
    });
    expect(span.style.borderLeft).toBe('1px solid currentcolor');
    expect(span.style.borderRight).toBe('1px solid currentcolor');
    expect(span.style.borderBottom).toBe('1px solid currentcolor');
    expect(span.style.borderTop).toBe('1px solid currentcolor');
    expect(span.style.boxShadow).toBe('none');
    expect(line).toHaveStyle({
      width: '1px',
      top: '-30px',
      height: '40px',
    });
    expect(line.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(line.style.borderLeftStyle).toBe('');
    expect(
      screen.queryByTestId('junction-field-handle-dot-goldenGateOverhang-boundary')
    ).toBeNull();
  });
});

function fieldHandle(overrides: Partial<JunctionFieldHandle> = {}): JunctionFieldHandle {
  const field = {
    id: 'field',
    kind: 'primerPbs' as const,
    label: 'Primer PBS',
    target: { primerId: 'p1', junctionIndex: 0 },
    value: 20,
    units: 'bp' as const,
    range: { min: 10, max: 60, step: 1, largeStep: 5 },
    anchors: [
      { rowId: 'row', rowKind: 'right-source' as const, bioCol: 20, role: 'pbs-end' as const },
    ],
    command: {
      type: 'setPrimerPbsLength' as const,
      payload: { primerId: 'p1', length: 20 },
      valueKey: 'length',
    },
    constraints: [],
  };
  return {
    id: 'handle',
    label: 'Primer PBS',
    field,
    rowId: 'row',
    kind: 'primerPbs',
    role: 'pbs-end',
    value: 20,
    min: 10,
    max: 60,
    step: 1,
    largeStep: 5,
    x: 100,
    y: 0,
    height: 100,
    dragScale: 1,
    ...overrides,
  };
}

function homologyHandle(overrides: Partial<JunctionFieldHandle> = {}): JunctionFieldHandle {
  const field = {
    ...fieldHandle().field,
    id: 'homology-field',
    kind: 'homologyArm' as const,
    label: 'Left homology',
    target: { junctionIndex: 0, side: 'left' as const },
    value: 20,
    command: {
      type: 'setHomologyEncoding' as const,
      payload: { junctionIndex: 0, encoding: { onLeft: 20, onRight: 20 } },
      valueKey: 'encoding.onLeft',
    },
  };
  return fieldHandle({
    id: 'homology-handle',
    label: 'Left homology',
    field,
    kind: 'homologyArm',
    role: 'tail-start',
    ...overrides,
  });
}

function goldenGateOverhangHandle(
  overrides: Partial<JunctionFieldHandle> = {}
): JunctionFieldHandle {
  const field = {
    ...fieldHandle().field,
    id: 'goldengate-field',
    kind: 'goldenGateOverhang' as const,
    label: 'Golden Gate offset',
    target: { junctionIndex: 0 },
    value: 0,
    command: {
      type: 'setGoldenGateOffset' as const,
      payload: {
        junctionIndex: 0,
        offset: 0,
        previewRange: { startBioCol: 1, endBioCol: 5, spacerLength: 0 },
      },
      valueKey: 'offset',
    },
  };
  return fieldHandle({
    id: 'goldengate-handle',
    label: 'Golden Gate offset',
    field,
    kind: 'goldenGateOverhang',
    role: 'boundary',
    ...overrides,
  });
}

function measureOverlayAs(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const el = this as HTMLElement;
    if (el.dataset.testid === 'junction-handle-overlay') return rect({ width, height: 132 });
    return rect({ width: 0, height: 0 });
  });
}

async function flushDeferredPreviewEnd() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: overrides.width ?? 0,
    bottom: overrides.height ?? 0,
    left: 0,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}
