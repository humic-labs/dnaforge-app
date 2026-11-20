/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
import type { ViewportChangeSource, ViewportRange, WorkspaceEditorHandle } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const zoomInputs = vi.hoisted(() => ({
  previewTarget: null as ((zoom: number, direction: -1 | 1) => void) | null,
}));
vi.mock('../use-zoom-controller', async (importOriginal) => {
  const original = await importOriginal<typeof import('../use-zoom-controller')>();
  return {
    ...original,
    useZoomController(options: Parameters<typeof original.useZoomController>[0]) {
      zoomInputs.previewTarget = options.onPreviewZoomTarget ?? null;
      return original.useZoomController(options);
    },
  };
});

const sequence = {
  id: 'navigation-template',
  name: 'navigation-template',
  sequence: 'ACGT'.repeat(1000),
  length: 4000,
  circular: false,
  annotations: [],
};

const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  this.scrollTop = options.top ?? 0;
});

beforeEach(() => {
  zoomInputs.previewTarget = null;
  installRecordingCanvas();
  scrollTo.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20000);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

describe('SequenceViewer controlled navigation', () => {
  it('retires the zoom track reservation in the same transaction as instant navigation', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('__enableDiag', true);
    const viewer = createRef<WorkspaceEditorHandle>();
    render(<SequenceViewer ref={viewer} sequence={sequence} zoomLevel={20} />);
    const forecast = () =>
      (window as any).__sequenceViewerDiagnostics.layoutGeometry().config.wrapTrackForecast;
    act(() => zoomInputs.previewTarget!(9.2, -1));
    expect(forecast()).toBe(true);

    act(() => viewer.current!.scrollToBiologicalPosition(2000, { animate: false }));
    await waitFor(() => expect(forecast()).toBe(false));
  });
  it('keeps the navigation center when nearby rows collapse in a long document', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(391);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(686);
    const viewer = createRef<WorkspaceEditorHandle>();
    const onViewportChange = vi.fn<(range: ViewportRange) => void>();
    const base = {
      ...sequence,
      sequence: 'A'.repeat(400_000),
      length: 400_000,
      circular: true,
      annotations: Array.from({ length: 500 }, (_, index) => ({
        name: `row ${index}`,
        type: 'misc_feature',
        start: index * 800 + 1,
        end: index * 800 + 700,
        direction: 1 as const,
      })),
    };
    const expanded = Array.from({ length: 60 }, (_, index) => ({
      name: `overlap ${index}`,
      type: 'misc_feature',
      start: 257_000 + Math.floor(index / 3) * 500 + (index % 3),
      end: 257_480 + Math.floor(index / 3) * 500 + (index % 3),
      direction: 1 as const,
    }));
    const view = (annotations: typeof base.annotations) => (
      <SequenceViewer
        ref={viewer}
        sequence={{ ...base, annotations }}
        zoomLevel={2.6}
        config={{ charWidth: 0.208, rowHeight: 0.52, fontSize: 0.286, lodLevel: 'feature' }}
        onViewportChange={onViewportChange}
      />
    );
    const { rerender } = render(view([...base.annotations, ...expanded]));
    act(() => viewer.current!.scrollToBiologicalPosition(270_255));
    const center = () => onViewportChange.mock.calls.at(-1)?.[0].centerColumn;
    await waitFor(() => expect(center()).toBe(270_254));
    rerender(view(base.annotations));
    expect(center()).toBe(270_254);
  });

  it('prepares the far destination before restoring a large circular viewport after zoom', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('__enableDiag', true);
    const largeSequence = {
      ...sequence,
      id: 'large-circular-navigation',
      sequence: 'ACGT'.repeat(50_000),
      length: 200_000,
      circular: true,
      annotations: Array.from({ length: 200 }, (_, index) => ({
        name: `CDS ${index}`,
        type: 'CDS',
        start: index * 1000 + 1,
        end: index * 1000 + 750,
        direction: 1 as const,
      })),
    };
    const viewer = createRef<WorkspaceEditorHandle>();
    const onViewportChange = vi.fn<(range: ViewportRange) => void>();
    const { rerender, container } = render(
      <SequenceViewer
        ref={viewer}
        sequence={largeSequence}
        zoomLevel={100}
        onViewportChange={onViewportChange}
      />
    );
    rerender(
      <SequenceViewer
        ref={viewer}
        sequence={largeSequence}
        zoomLevel={9.2}
        config={{
          charWidth: 0.736,
          rowHeight: 1.84,
          fontSize: 1.012,
          lodLevel: 'feature',
          showReverseComplement: false,
        }}
        onViewportChange={onViewportChange}
      />
    );
    act(() => viewer.current!.scrollToBiologicalPosition(190_000, { animate: false }));
    await waitFor(() =>
      expect(
        Math.abs((onViewportChange.mock.calls.at(-1)?.[0].centerColumn ?? NaN) - 189_999)
      ).toBeLessThanOrEqual(1)
    );
    const diagnostics = (
      window as unknown as {
        __sequenceViewerDiagnostics: {
          layoutGeometry(): {
            summary: { rowHeights: ArrayLike<number>; rowYOffsets: ArrayLike<number> };
            rows: Array<{ lineIndex: number; startPos: number; endPos: number; y: number }>;
          };
        };
      }
    ).__sequenceViewerDiagnostics;
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="sequence-scroll-container"]'
    )!;
    const geometry = diagnostics.layoutGeometry();
    const destination = geometry.rows.find(
      (row) => row.startPos <= 189_999 && row.endPos > 189_999
    );
    expect(destination, 'the requested biological row must be materialized').toBeDefined();
    expect(destination!.y).toBeLessThan(scrollContainer.scrollTop + scrollContainer.clientHeight);
    expect(destination!.y + geometry.summary.rowHeights[destination!.lineIndex]).toBeGreaterThan(
      scrollContainer.scrollTop
    );
    expect(geometry.rows[0].y).toBeLessThanOrEqual(scrollContainer.scrollTop);
    expect(
      geometry.summary.rowYOffsets[geometry.rows.at(-1)!.lineIndex + 1]
    ).toBeGreaterThanOrEqual(scrollContainer.scrollTop + scrollContainer.clientHeight);
  });

  it('preserves an explicit instant destination through a pending width change instead of reanchoring its highlight', async () => {
    let width = 800;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);

    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const observers: Array<{ callback: ResizeObserverCallback; target: Element }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observers.push({ callback: this.callback, target });
        }
        unobserve() {}
        disconnect() {}
      }
    );
    const viewer = createRef<WorkspaceEditorHandle>();
    const onViewportChange = vi.fn<(range: ViewportRange) => void>();
    const { container } = render(
      <SequenceViewer
        ref={viewer}
        sequence={sequence}
        highlightedRange={{ start: 1900, end: 1910 }}
        onViewportChange={onViewportChange}
      />
    );
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="sequence-scroll-container"]'
    )!;
    await waitFor(() => expect(viewer.current).not.toBeNull());
    const observer = observers.find(({ target }) => target === scrollContainer)!;
    expect(observer).toBeDefined();

    width = 400;
    act(() => viewer.current!.scrollToBiologicalPosition(2000, { animate: false }));
    act(() =>
      observer.callback(
        [
          {
            target: scrollContainer,
            contentRect: { width, height: 600 },
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver
      )
    );

    await waitFor(() =>
      expect(
        Math.abs((onViewportChange.mock.calls.at(-1)?.[0].centerColumn ?? NaN) - 1999)
      ).toBeLessThanOrEqual(1)
    );
    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
  });

  it('keeps an animated destination pending until the viewport has measurable dimensions', async () => {
    let height = 0;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
    vi.useFakeTimers();
    try {
      const onComplete = vi.fn();
      const onViewportChange = vi.fn<(range: ViewportRange) => void>();
      const { container } = render(
        <SequenceViewer
          sequence={sequence}
          scrollToPosition={3000}
          scrollCommandId={1}
          onScrollToPositionComplete={onComplete}
          onViewportChange={onViewportChange}
        />
      );
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sequence-scroll-container"]'
      )!;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(onComplete).not.toHaveBeenCalled();
      expect(viewport.scrollTop).toBe(0);

      height = 96;
      act(() => window.dispatchEvent(new Event('resize')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(
        Math.abs((onViewportChange.mock.calls.at(-1)?.[0].centerColumn ?? NaN) - 2999)
      ).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges an instant jump once and does not replay it on a layout change', async () => {
    const onComplete = vi.fn();
    const { rerender, container } = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollAnimate={false}
        onScrollToPositionComplete={onComplete}
      />
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="sequence-scroll-container"]'
    );
    expect(scrollContainer?.scrollTop).toBeGreaterThan(0);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    scrollTo.mockClear();
    rerender(
      <SequenceViewer
        sequence={{
          ...sequence,
          annotations: [
            { name: 'binding', type: 'misc_feature', start: 1980, end: 2020, direction: 1 },
          ],
        }}
        scrollToPosition={2000}
        scrollAnimate={false}
        onScrollToPositionComplete={onComplete}
      />
    );
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);

    rerender(<SequenceViewer sequence={sequence} scrollToPosition={null} />);
    rerender(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollAnimate={false}
        onScrollToPositionComplete={onComplete}
      />
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(scrollTo).toHaveBeenCalled();
  });

  it('finishes an animated jump in the new layout when row geometry changes', async () => {
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    const onComplete = vi.fn();
    const { container } = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        onScrollToPositionComplete={onComplete}
      />
    );
    await waitFor(() => expect(frames.size).toBeGreaterThan(0));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(cancelFrame).toHaveBeenCalled();
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="sequence-scroll-container"]'
    );
    expect(scrollContainer?.scrollTop).toBeGreaterThan(0);
  });

  it('consumes a new command ID when a batched navigation returns to the rendered position', async () => {
    const firstComplete = vi.fn();
    const intermediateComplete = vi.fn();
    const latestComplete = vi.fn();
    let replaceCommand!: (command: { position: number; id: number }) => void;
    function NavigationOwner() {
      const [command, setCommand] = useState({ position: 2000, id: 1 });
      replaceCommand = setCommand;
      return (
        <SequenceViewer
          sequence={sequence}
          scrollToPosition={command.position}
          scrollCommandId={command.id}
          scrollAnimate={false}
          onScrollToPositionComplete={
            command.id === 1
              ? firstComplete
              : command.id === 2
                ? intermediateComplete
                : latestComplete
          }
        />
      );
    }
    render(<NavigationOwner />);
    await waitFor(() => expect(firstComplete).toHaveBeenCalledTimes(1));

    act(() => {
      replaceCommand({ position: 3000, id: 2 });
      replaceCommand({ position: 2000, id: 3 });
    });
    await waitFor(() => expect(latestComplete).toHaveBeenCalledTimes(1));
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(intermediateComplete).not.toHaveBeenCalled();
  });
  it('settles an animated jump within 350 ms when the deadline falls between frames', async () => {
    vi.useFakeTimers({
      toFake: [
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      const viewer = createRef<WorkspaceEditorHandle>();
      const longSequence = {
        ...sequence,
        id: 'long-navigation-deadline',
        sequence: 'ACGT'.repeat(7500),
        length: 30000,
      };
      const { container } = render(<SequenceViewer ref={viewer} sequence={longSequence} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(65);
      });
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sequence-scroll-container"]'
      );
      if (!viewport || !viewer.current) throw new Error('Sequence viewport is unavailable');
      viewport.scrollTop = 10392;
      act(() => viewer.current!.scrollToBiologicalPosition(1001, { animate: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(viewport.scrollTop).toBeLessThan(10392);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(318);
      });
      const atDeadline = viewport.scrollTop;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(80);
      });
      expect(Math.abs(viewport.scrollTop - atDeadline)).toBeLessThanOrEqual(0.5);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not move a detached viewport when the animation deadline expires', async () => {
    vi.useFakeTimers({
      toFake: [
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      const viewer = createRef<WorkspaceEditorHandle>();
      const { container, unmount } = render(<SequenceViewer ref={viewer} sequence={sequence} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(65);
      });
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sequence-scroll-container"]'
      );
      if (!viewport || !viewer.current) throw new Error('Sequence viewport is unavailable');
      act(() => viewer.current!.scrollToBiologicalPosition(3000, { animate: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(32);
      });
      const beforeClose = viewport.scrollTop;
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(viewport.scrollTop).toBe(beforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
  it('publishes the moving viewport during animation without a native scroll event', async () => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
    try {
      const viewer = createRef<WorkspaceEditorHandle>();
      const onViewportChange = vi.fn<(range: ViewportRange) => void>();
      const { container } = render(
        <SequenceViewer ref={viewer} sequence={sequence} onViewportChange={onViewportChange} />
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(64);
      });
      const scrollContainer = container.querySelector<HTMLElement>(
        '[data-testid="sequence-scroll-container"]'
      );
      const navigation = viewer.current;
      if (!scrollContainer || !navigation) throw new Error('Sequence viewport is unavailable');
      act(() => navigation.scrollToBiologicalPosition(1000, { animate: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(64);
      });
      const initialScrollTop = scrollContainer.scrollTop;
      onViewportChange.mockClear();
      act(() => navigation.scrollToBiologicalPosition(3000, { animate: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(32);
      });
      expect(scrollContainer.scrollTop).toBeGreaterThan(initialScrollTop);
      expect(onViewportChange).toHaveBeenCalledWith(
        expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
        'scroll'
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not resume a controlled animation replaced by its viewport callback', async () => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
    try {
      const viewer = createRef<WorkspaceEditorHandle>();
      const onComplete = vi.fn();
      let replaceOnScroll = false;
      let replacementRequests = 0;
      const onViewportChange = (_range: ViewportRange, source?: ViewportChangeSource) => {
        if (!replaceOnScroll || source !== 'scroll') return;
        replaceOnScroll = false;
        replacementRequests += 1;
        viewer.current?.scrollToBiologicalPosition(3000, { animate: true });
      };
      const view = render(
        <SequenceViewer ref={viewer} sequence={sequence} onViewportChange={onViewportChange} />
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(64);
      });
      act(() => viewer.current?.scrollToBiologicalPosition(1000, { animate: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(64);
      });
      replaceOnScroll = true;
      view.rerender(
        <SequenceViewer
          ref={viewer}
          sequence={sequence}
          onViewportChange={onViewportChange}
          scrollToPosition={2000}
          scrollCommandId={1}
          onScrollToPositionComplete={onComplete}
        />
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(replacementRequests).toBe(1);
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    'revokes only its controlled animation with newer imperative motion %s',
    async (newer) => {
      vi.useFakeTimers({
        toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
      });
      try {
        const onComplete = vi.fn();
        const viewer = createRef<WorkspaceEditorHandle>();
        const view = render(<SequenceViewer ref={viewer} sequence={sequence} />);
        const scrollContainer = view.container.querySelector<HTMLElement>(
          '[data-testid="sequence-scroll-container"]'
        )!;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(64);
        });
        view.rerender(
          <SequenceViewer
            ref={viewer}
            sequence={sequence}
            scrollToPosition={2000}
            scrollCommandId={1}
            onScrollToPositionComplete={onComplete}
          />
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(64);
        });
        const moving = scrollContainer.scrollTop;
        expect(moving).toBeGreaterThan(0);
        expect(onComplete).not.toHaveBeenCalled();
        if (newer) act(() => viewer.current!.scrollToBiologicalPosition(3000, { animate: true }));
        view.rerender(<SequenceViewer ref={viewer} sequence={sequence} scrollToPosition={null} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        if (newer) expect(scrollContainer.scrollTop).toBeGreaterThan(moving);
        else expect(scrollContainer.scrollTop).toBe(moving);
        expect(onComplete).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
