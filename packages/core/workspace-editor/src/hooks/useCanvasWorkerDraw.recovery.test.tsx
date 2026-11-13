/** @vitest-environment jsdom */

import { useLayoutEffect, useRef, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EDITOR_CONFIG, type LayoutSnapshot2D, type Selection } from '../types';
import { useCanvasWorkerDraw } from './useCanvasWorkerDraw';
import type { MainToWorkerMessage } from '../canvas-worker-protocol';

declare global {
  interface Window {
    __canvasWorkerDebug?: {
      ownerId: string | null;
      lifecycle: string;
      readyAt: number | null;
      releasedAt: number | null;
    };
    __canvasWorkerReleaseReceipts?: readonly {
      ownerId: string;
      releasedAt: number;
    }[];
  }
}

const workerInstances = vi.hoisted(
  () =>
    [] as Array<{
      terminate: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
      messages: MainToWorkerMessage[];
    }>
);
const workerControl = vi.hoisted(() => ({ initBehavior: 'throw' as 'throw' | 'ready' }));
const renderSequenceMock = vi.hoisted(() =>
  vi.fn(() => ({
    renderedPrimers: [],
    renderedGGLabels: [],
    renderedCutSites: [],
    lineCodonUpdates: [],
  }))
);

vi.mock('../canvas-render-worker?worker&inline', () => ({
  default: class ThrowingInitWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    messages: MainToWorkerMessage[] = [];

    constructor() {
      workerInstances.push(this);
    }

    postMessage(message: MainToWorkerMessage): void {
      this.messages.push(message);
      if (message.type === 'ping') {
        queueMicrotask(() => this.onmessage?.({ data: { type: 'pong' } } as MessageEvent));
        return;
      }
      if (message.type !== 'init') return;
      if (workerControl.initBehavior === 'throw') {
        throw new Error('injected init post failure');
      }
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } } as MessageEvent));
    }
  },
}));

vi.mock('../canvas-renderer', () => ({ renderSequence: renderSequenceMock }));

vi.mock('../rendering/webgl-drawing-context', () => {
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  return {
    getSequenceWebGLContext: (canvas: HTMLCanvasElement) => {
      let context = contexts.get(canvas);
      if (!context) {
        context = Object.assign(canvas.getContext('2d')!, {
          beginFrame: () => true,
          endFrame: () => undefined,
          setPresentationShiftBounds: () => undefined,
        });
        contexts.set(canvas, context);
      }
      return context;
    },
  };
});

const TEST_LAYOUT: LayoutSnapshot2D = {
  lines: [],
  totalHeight: 40,
  totalWidth: 100,
  sequenceLength: 0,
  isCircular: false,
};
const STABLE_DRAW_INPUTS: Pick<
  Parameters<typeof useCanvasWorkerDraw>[0],
  | 'precomputedLinePositions'
  | 'cutSites'
  | 'scannedCutSites'
  | 'primers'
  | 'mutations'
  | 'insertedRanges'
  | 'deletedRanges'
> = {
  precomputedLinePositions: [],
  cutSites: [],
  scannedCutSites: [],
  primers: [],
  mutations: [],
  insertedRanges: [],
  deletedRanges: [],
};
const originalTransferDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'transferControlToOffscreen'
);
const originalGetContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext'
);

function RecoveryHarness({
  onScrollReady,
  liveRange = null,
  committedRange = null,
  layout = TEST_LAYOUT,
  onOrfsPresented,
  onPaintLayoutPresented,
}: {
  onScrollReady?: (draw: (top: number, height: number, paintNow?: boolean) => void) => void;
  liveRange?: Selection | null;
  committedRange?: Selection | null;
  layout?: LayoutSnapshot2D;
  onOrfsPresented?: Parameters<typeof useCanvasWorkerDraw>[0]['onOrfsPresented'];
  onPaintLayoutPresented?: Parameters<typeof useCanvasWorkerDraw>[0]['onPaintLayoutPresented'];
}): React.JSX.Element {
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef({ scrollTop: 0, height: 40 });
  const drawFnRef = useRef<(() => void) | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const canvasDimensionsRef = useRef({ width: 0, height: 0 });
  const canvasRectRef = useRef<DOMRect | null>(null);
  const drawSelectionAndCursorRef = useRef(() => undefined);
  const hoverCursorRef = useRef<{ x: number; lineIdx: number } | null>(null);
  const isSelectingRef = useRef(false);
  const liveSelectionRef = useRef<Selection | null>(null);
  liveSelectionRef.current = liveRange;
  const selectionRef = useRef(null);
  const cursorRef = useRef<number>();
  const cursorVisibleRef = useRef(false);
  const insertedRangesRef = useRef([]);
  const deletedRangesRef = useRef([]);
  const highlightedRangeRef = useRef<Selection | null>(null);
  highlightedRangeRef.current = committedRange;
  const renderedPrimersRef = useRef([]);
  const renderedGGLabelsRef = useRef([]);
  const renderedCutSitesRef = useRef([]);
  const renderedCdsExtensionArrowsRef = useRef([]);
  const lineCodonsCacheRef = useRef(new Map());
  const mutationCacheRef = useRef({ mutations: [], map: new Map() });
  const alignmentCodonsCacheRef = useRef({
    alignedRef: '',
    alignedQuery: '',
    codonsMap: new Map(),
  });
  const viewCursorRef = useRef<number | null>(null);
  const scrollDrawRef = useRef<((top: number, height: number, paintNow?: boolean) => void) | null>(
    null
  );

  useCanvasWorkerDraw({
    ...STABLE_DRAW_INPUTS,
    canvasRef,
    remountTransferredCanvas: () => setCanvasGeneration((generation) => generation + 1),
    selectionCanvasRef,
    viewportRef,
    scrollDrawRef,
    drawFnRef,
    drawRafRef,
    canvasDimensionsRef,
    canvasRectRef,
    drawSelectionAndCursorRef,
    hoverCursorRef,
    isSelectingRef,
    liveSelectionRef,
    selectionRef,
    cursorRef,
    cursorVisibleRef,
    insertedRangesRef,
    deletedRangesRef,
    highlightedRangeRef,
    renderedPrimersRef,
    renderedGGLabelsRef,
    renderedCdsExtensionArrowsRef,
    renderedCutSitesRef,
    lineCodonsCacheRef,
    mutationCacheRef,
    alignmentCodonsCacheRef,
    layout,
    onOrfsPresented,
    onPaintLayoutPresented,
    config: DEFAULT_EDITOR_CONFIG,
    fullSequence: '',
    sequenceLength: 100_001,
    showCutSites: false,
    hoveredCodon: null,
    viewCursorRef,
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    highlightedRange: committedRange,
    isDark: false,
  });
  useLayoutEffect(() => {
    if (scrollDrawRef.current) onScrollReady?.(scrollDrawRef.current);
  });

  return (
    <>
      <canvas key={canvasGeneration} ref={canvasRef} data-testid="main-canvas" />
      <canvas ref={selectionCanvasRef} />
    </>
  );
}

describe('useCanvasWorkerDraw transferred-canvas recovery', () => {
  beforeEach(() => {
    workerInstances.length = 0;
    workerControl.initBehavior = 'throw';
    renderSequenceMock.mockClear();
    vi.stubGlobal('OffscreenCanvas', class OffscreenCanvas {});
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: vi.fn(() => ({})),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({
        setTransform: vi.fn(),
        fillRect: vi.fn(),
        fillStyle: '',
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.__canvasWorkerDebug;
    delete window.__canvasWorkerReleaseReceipts;
    if (originalTransferDescriptor) {
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        'transferControlToOffscreen',
        originalTransferDescriptor
      );
    } else {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
    }
    if (originalGetContextDescriptor) {
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        'getContext',
        originalGetContextDescriptor
      );
    }
  });

  it('keeps a delayed paint acknowledgement with its submitted callback owner', async () => {
    workerControl.initBehavior = 'ready';
    const first = vi.fn();
    const second = vi.fn();
    const firstLayout = { ...TEST_LAYOUT };
    const secondLayout = { ...TEST_LAYOUT, totalWidth: 120 };
    const view = render(<RecoveryHarness layout={firstLayout} onPaintLayoutPresented={first} />);
    const currentFrame = () =>
      workerInstances[0]?.messages
        .filter((message) => message.type === 'render' || message.type === 'present-rows')
        .at(-1);
    await waitFor(() => expect(currentFrame()?.type).toBe('render'));
    const old = currentFrame();
    if (old?.type !== 'render' && old?.type !== 'present-rows')
      throw new Error('Expected the first worker scene');
    view.rerender(<RecoveryHarness layout={secondLayout} onPaintLayoutPresented={second} />);
    await waitFor(() => expect(currentFrame()?.renderVersion).not.toBe(old.renderVersion));
    first.mockClear();
    second.mockClear();
    act(() =>
      workerInstances[0].onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'present-complete',
            renderVersion: old.renderVersion,
            presentationVersion: old.presentationVersion,
          },
        })
      )
    );
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledExactlyOnceWith(
      firstLayout,
      firstLayout,
      expect.any(Number),
      DEFAULT_EDITOR_CONFIG
    );
  });

  it('captures a distinct paint when only the presentation callback owner changes', async () => {
    workerControl.initBehavior = 'ready';
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<RecoveryHarness onPaintLayoutPresented={first} />);
    const currentFrame = () =>
      workerInstances[0]?.messages
        .filter((message) => message.type === 'render' || message.type === 'present-rows')
        .at(-1);
    await waitFor(() => expect(currentFrame()?.type).toBe('render'));
    const old = currentFrame();
    if (old?.type !== 'render' && old?.type !== 'present-rows')
      throw new Error('Expected the first worker scene');
    const fullScenes = workerInstances[0].messages.filter(
      (message) => message.type === 'render'
    ).length;
    view.rerender(<RecoveryHarness onPaintLayoutPresented={second} />);
    await waitFor(() =>
      expect(currentFrame()?.presentationVersion).not.toBe(old.presentationVersion)
    );
    const current = currentFrame();
    if (current?.type !== 'render' && current?.type !== 'present-rows')
      throw new Error('Expected a distinct captured presentation');
    first.mockClear();
    second.mockClear();
    act(() =>
      workerInstances[0].onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'present-complete',
            renderVersion: old.renderVersion,
            presentationVersion: old.presentationVersion,
          },
        })
      )
    );
    expect(second).not.toHaveBeenCalled();
    act(() =>
      workerInstances[0].onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'present-complete',
            renderVersion: current.renderVersion,
            presentationVersion: current.presentationVersion,
          },
        })
      )
    );
    expect(second).toHaveBeenCalledExactlyOnceWith(
      TEST_LAYOUT,
      TEST_LAYOUT,
      expect.any(Number),
      DEFAULT_EDITOR_CONFIG
    );
    expect(current.type).toBe('present-rows');
    expect(workerInstances[0].messages.filter((message) => message.type === 'render')).toHaveLength(
      fullScenes
    );
  });

  it('recaptures a new empty ORF generation when only its callback changes', async () => {
    workerControl.initBehavior = 'ready';
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<RecoveryHarness onOrfsPresented={first} />);
    const currentFrame = () =>
      workerInstances[0]?.messages
        .filter((message) => message.type === 'render' || message.type === 'present-rows')
        .at(-1);
    await waitFor(() => expect(currentFrame()?.type).toBe('render'));
    const old = currentFrame();
    if (old?.type !== 'render' && old?.type !== 'present-rows')
      throw new Error('Expected the first worker scene');
    const fullScenes = workerInstances[0].messages.filter(
      (message) => message.type === 'render'
    ).length;
    view.rerender(<RecoveryHarness onOrfsPresented={second} />);
    await waitFor(() =>
      expect(currentFrame()?.presentationVersion).not.toBe(old.presentationVersion)
    );
    const current = currentFrame();
    if (current?.type !== 'render' && current?.type !== 'present-rows')
      throw new Error('Expected a new captured worker scene');
    act(() =>
      workerInstances[0].onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'present-complete',
            renderVersion: old.renderVersion,
            presentationVersion: old.presentationVersion,
            orfsDrawn: false,
          },
        })
      )
    );
    expect(second).not.toHaveBeenCalled();
    act(() =>
      workerInstances[0].onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'present-complete',
            renderVersion: current.renderVersion,
            presentationVersion: current.presentationVersion,
            orfsDrawn: false,
          },
        })
      )
    );
    expect(second).toHaveBeenCalledExactlyOnceWith({
      kind: 'empty_model',
      surface: 'sequence_canvas',
    });
    expect(current.type).toBe('present-rows');
    expect(workerInstances[0].messages.filter((message) => message.type === 'render')).toHaveLength(
      fullScenes
    );
  });

  it('acknowledges the callback captured with an older worker scene without borrowing its replacement', async () => {
    workerControl.initBehavior = 'ready';
    const first = vi.fn();
    const second = vi.fn();
    const firstLayout = { ...TEST_LAYOUT };
    const secondLayout = { ...TEST_LAYOUT, totalWidth: 120 };
    const view = render(<RecoveryHarness layout={firstLayout} onOrfsPresented={first} />);
    const currentFrame = () =>
      workerInstances[0]?.messages
        .filter((message) => message.type === 'render' || message.type === 'present-rows')
        .at(-1);
    await waitFor(() => expect(currentFrame()?.type).toBe('render'));
    const old = currentFrame();
    if (old?.type !== 'render' && old?.type !== 'present-rows')
      throw new Error('Expected the first worker scene');
    view.rerender(<RecoveryHarness layout={secondLayout} onOrfsPresented={second} />);
    await waitFor(() => expect(currentFrame()?.renderVersion).not.toBe(old.renderVersion));
    act(() =>
      workerInstances[0].onmessage?.(
        new MessageEvent('message', {
          data: {
            type: 'present-complete',
            renderVersion: old.renderVersion,
            presentationVersion: old.presentationVersion,
            orfsDrawn: false,
          },
        })
      )
    );
    expect(first).toHaveBeenCalledExactlyOnceWith({
      kind: 'empty_model',
      surface: 'sequence_canvas',
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('remounts the transferred canvas and paints through fallback when init post throws', async () => {
    const mounted = render(<RecoveryHarness />);
    const transferredCanvas = mounted.getByTestId('main-canvas');

    await waitFor(() => expect(workerInstances).toHaveLength(1));
    await waitFor(() => expect(workerInstances[0]?.terminate).toHaveBeenCalledOnce());
    await waitFor(() => expect(mounted.getByTestId('main-canvas')).not.toBe(transferredCanvas));
    await waitFor(() => expect(renderSequenceMock).toHaveBeenCalled());
  });

  it('paints an animated viewport in the same callback instead of the next refresh', async () => {
    let scrollDraw: ((top: number, height: number, paintNow?: boolean) => void) | undefined;
    render(
      <RecoveryHarness
        onScrollReady={(draw) => {
          scrollDraw = draw;
        }}
      />
    );
    await waitFor(() => expect(renderSequenceMock).toHaveBeenCalled());
    renderSequenceMock.mockClear();
    act(() => {
      scrollDraw?.(12, 40, true);
    });
    expect(renderSequenceMock).toHaveBeenCalledTimes(1);
    expect(renderSequenceMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ viewport: { scrollTop: 12, height: 40 } })
    );
    act(() => {
      scrollDraw?.(12, 40, true);
    });
    expect(
      renderSequenceMock,
      'an already presented unchanged viewport needs no second base paint'
    ).toHaveBeenCalledTimes(1);
  });

  it('keeps the live readonly drag range through a rerender with a null committed selection', async () => {
    const held = { start: 76, end: 88 };
    const final = { start: 76, end: 100 };
    let scrollDraw: ((top: number, height: number, paintNow?: boolean) => void) | undefined;
    const onScrollReady = (draw: (top: number, height: number, paintNow?: boolean) => void) => {
      scrollDraw = draw;
    };
    const mounted = render(
      <RecoveryHarness liveRange={held} committedRange={held} onScrollReady={onScrollReady} />
    );
    await waitFor(() =>
      expect(renderSequenceMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ highlightedRange: held })
      )
    );
    renderSequenceMock.mockClear();

    mounted.rerender(
      <RecoveryHarness liveRange={held} committedRange={null} onScrollReady={onScrollReady} />
    );
    act(() => scrollDraw?.(0, 40, true));
    expect(renderSequenceMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ highlightedRange: held })
    );

    mounted.rerender(
      <RecoveryHarness liveRange={null} committedRange={final} onScrollReady={onScrollReady} />
    );
    act(() => scrollDraw?.(0, 40, true));
    expect(renderSequenceMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ highlightedRange: final })
    );
  });

  it('remounts the transferred canvas when an already-ready worker fails', async () => {
    workerControl.initBehavior = 'ready';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = render(<RecoveryHarness />);
    const transferredCanvas = mounted.getByTestId('main-canvas');

    await waitFor(() => expect(workerInstances).toHaveLength(1));
    await waitFor(() => expect(workerInstances[0]?.onmessage).not.toBeNull());
    act(() => {
      workerInstances[0]?.onerror?.(
        new ErrorEvent('error', { message: 'injected runtime failure' })
      );
    });

    await waitFor(() => expect(workerInstances[0]?.terminate).toHaveBeenCalledOnce());
    await waitFor(() => expect(mounted.getByTestId('main-canvas')).not.toBe(transferredCanvas));
    await waitFor(() => expect(renderSequenceMock).toHaveBeenCalled());
  });

  it('publishes release of the exact ready worker owner after a real unmount', async () => {
    workerControl.initBehavior = 'ready';
    const mounted = render(<RecoveryHarness />);

    await waitFor(() => expect(window.__canvasWorkerDebug?.lifecycle).toBe('ready'));
    const ownerId = window.__canvasWorkerDebug?.ownerId;
    expect(ownerId).toMatch(/^canvas-worker-/);

    mounted.unmount();

    await waitFor(() => expect(workerInstances[0]?.terminate).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(window.__canvasWorkerDebug).toMatchObject({
        ownerId,
        lifecycle: 'released',
      });
      expect(window.__canvasWorkerDebug?.releasedAt).toEqual(expect.any(Number));
      expect(window.__canvasWorkerReleaseReceipts).toContainEqual({
        ownerId,
        releasedAt: window.__canvasWorkerDebug?.releasedAt,
      });
    });

    window.__canvasWorkerDebug = {
      ownerId: null,
      lifecycle: 'idle',
      readyAt: null,
      releasedAt: null,
    };
    expect(
      window.__canvasWorkerReleaseReceipts?.some((receipt) => receipt.ownerId === ownerId)
    ).toBe(true);
  });
});
