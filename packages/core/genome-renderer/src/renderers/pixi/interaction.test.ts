// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  dispatchNativeWheel,
  installNativeWheelSource,
} from '../../../../platform/src/wheel-input.test-helper';
import { setupInteraction } from './interaction';
import { startWebGLRenderLoop, type WebGLFatalFrameError } from '../../react/webgl-render-loop';
import type { RenderState } from '../../types';
import { linearEdgeOverscrollOffset } from './shared/linear-viewport';
import { PRIMER_RENDER_ID_OFFSET } from '../../primer-render-conventions';

let nativeOrdinal = 0;
const nativeWheel = (
  packet: Pick<WheelEventInit, 'deltaX' | 'deltaY' | 'metaKey' | 'ctrlKey'> & {
    x: number;
    y: number;
  }
) =>
  dispatchNativeWheel(document, {
    deltaX: 0,
    deltaY: 0,
    ...packet,
    precise: false,
    phase: 0,
    momentumPhase: 0,
    ordinal: ++nativeOrdinal,
  });

let disposeNativeSource: () => void;
beforeEach(() => {
  disposeNativeSource = installNativeWheelSource(document);
});
afterEach(() => {
  disposeNativeSource();
});

it('animates a native mouse tick in the existing camera frame owner and surrenders to precise input', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  Object.defineProperty(document, 'elementFromPoint', { value: () => canvas, configurable: true });
  const state = makeState({ zoom: 4, viewOffset: 0.5 });
  const interaction = setupInteraction(canvas, state);
  interaction.genomeLength = 1000;
  interaction.genomeCircular = false;
  nativeWheel({ x: 400, y: 150, deltaX: 0, deltaY: 120 });
  expect(state.viewOffset).toBe(0.5);
  now = 16.7;
  interaction.flushInteraction();
  expect(state.viewOffset).toBeGreaterThan(0.5);
  expect(state.viewOffset).toBeLessThan(0.53);
  const before = state.viewOffset;
  wheel(canvas, 4);
  now = 25;
  interaction.flushInteraction();
  expect(state.viewOffset).toBeCloseTo(before + 0.001, 10);
  now = 200;
  interaction.flushInteraction();
  expect(state.viewOffset).toBeCloseTo(before + 0.001, 10);
  interaction.cleanup();
  canvas.remove();
});

it('preserves a precise packet when a mouse packet arrives before the next camera frame', () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  Object.defineProperty(document, 'elementFromPoint', { value: () => canvas, configurable: true });
  const state = makeState({ zoom: 4, viewOffset: 0.5 });
  const interaction = setupInteraction(canvas, state);
  interaction.genomeLength = 1000;
  interaction.genomeCircular = false;
  try {
    wheel(canvas, 12);
    nativeWheel({ x: 400, y: 150, deltaX: 0, deltaY: 120 });
    now = 16.7;
    interaction.flushInteraction();

    expect(state.viewOffset).toBeGreaterThan(0.503);
    expect(state.viewOffset).toBeLessThan(0.533);
    now = 200;
    interaction.flushInteraction();
    expect(state.viewOffset).toBeCloseTo(0.533, 10);
  } finally {
    interaction.cleanup();
    canvas.remove();
    clock.mockRestore();
  }
});

it('animates modified native mouse zoom in the camera owner and anchors every intermediate pose', () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  Object.defineProperty(document, 'elementFromPoint', { value: () => canvas, configurable: true });
  const state = makeState({ zoom: 4, viewOffset: 0.5 });
  const interaction = setupInteraction(canvas, state);
  const anchor = vi.fn();
  interaction.onBeforeZoom = anchor;
  try {
    nativeWheel({
      x: 321,
      y: 45,
      deltaX: 0,
      deltaY: -120,
      metaKey: true,
    });
    expect(state.zoom).toBe(4);
    now = 16;
    interaction.flushInteraction();
    expect(state.zoom).toBeGreaterThan(4);
    expect(state.zoom).toBeLessThan(5.2);
    const first = state.zoom;
    now = 32;
    interaction.flushInteraction();
    expect(state.zoom).toBeGreaterThan(first);
    expect(state.zoom).toBeLessThan(5.2);
    now = 200;
    interaction.flushInteraction();
    expect(state.zoom).toBeCloseTo(5.2, 10);
    expect(anchor).toHaveBeenCalledTimes(3);
    for (const call of anchor.mock.calls) expect(call.slice(2)).toEqual([321, 45]);
  } finally {
    interaction.cleanup();
    canvas.remove();
    clock.mockRestore();
  }
});

it('direct precision zoom cancels a mouse zoom tail without changing the precise distance', () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  Object.defineProperty(document, 'elementFromPoint', { value: () => canvas, configurable: true });
  const state = makeState({ zoom: 4 });
  const interaction = setupInteraction(canvas, state);
  try {
    nativeWheel({
      x: 100,
      y: 40,
      deltaX: 0,
      deltaY: -120,
      ctrlKey: true,
    });
    now = 16;
    interaction.flushInteraction();
    const displayed = state.zoom;
    expect(displayed).toBeGreaterThan(4);
    expect(displayed).toBeLessThan(5.2);
    wheel(canvas, -8, { ctrlKey: true });
    now = 24;
    interaction.flushInteraction();
    expect(state.zoom).toBeCloseTo(displayed * Math.exp(0.064), 10);
    const direct = state.zoom;
    now = 250;
    interaction.flushInteraction();
    expect(state.zoom).toBe(direct);
  } finally {
    interaction.cleanup();
    canvas.remove();
    clock.mockRestore();
  }
});

it('explicit camera ownership reset discards queued mouse movement and zoom', () => {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  Object.defineProperty(document, 'elementFromPoint', { value: () => canvas, configurable: true });
  const state = makeState({ zoom: 4, viewOffset: 0.5 });
  const interaction = setupInteraction(canvas, state);
  try {
    nativeWheel({ x: 100, y: 40, deltaX: 0, deltaY: 120 });
    nativeWheel({
      x: 100,
      y: 40,
      deltaX: 0,
      deltaY: -120,
      metaKey: true,
    });
    interaction.cancelMotion();
    state.viewOffset = 0.25;
    state.zoom = 2;
    interaction.flushInteraction();
    expect(state.viewOffset).toBe(0.25);
    expect(state.zoom).toBe(2);
  } finally {
    interaction.cleanup();
    canvas.remove();
  }
});

it.each([false, true])(
  'keeps the camera at its displayed pose when selection interrupts a deferred frame (zoom=%s)',
  (zoom) => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let nextRafId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextRafId;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => canvas,
      configurable: true,
    });
    const state = makeState({ zoom: 4, viewOffset: 0.5 });
    const interaction = setupInteraction(canvas, state);
    interaction.genomeLength = 1000;
    interaction.genomeCircular = false;
    interaction.screenToBp = () => 100;
    const field = zoom ? 'zoom' : 'viewOffset';
    const drawn: number[] = [];
    const loop = startWebGLRenderLoop({
      instanceId: 'selection-during-deferred-wheel-frame',
      minimumFrameIntervalMs: () => 13,
      app: { render: vi.fn() },
      renderer: { render: () => drawn.push(state[field]) },
      interaction,
      stateRef: { current: state },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef: { current: new Set() },
      isDestroyed: () => false,
      onFatalFrameError: (error: WebGLFatalFrameError) => {
        throw new Error(error.message);
      },
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);
    const tickAt = (time: number) => {
      now = time;
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id);
      callback(time);
    };
    try {
      tickAt(0);
      nativeWheel({ x: 100, y: 40, deltaY: zoom ? -120 : 120, metaKey: zoom });
      tickAt(16.7);
      const displayed = drawn.at(-1)!;
      expect(displayed).toBeGreaterThan(drawn[0]);
      tickAt(25);
      expect(drawn).toHaveLength(2);
      expect(state[field]).toBe(displayed);
      tap(canvas, 100, 40);
      tickAt(33.4);
      tickAt(200);
      expect(state.cursorPosition).toBe(100);
      expect(state[field]).toBe(displayed);
      expect(drawn.every((pose, index) => index === 0 || pose === displayed)).toBe(true);
    } finally {
      loop.stop();
      interaction.cleanup();
      canvas.remove();
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  }
);

function makeState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 300,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

function tap(canvas: HTMLCanvasElement, x = 10, y = 10, init: MouseEventInit = {}): void {
  canvas.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, ...init })
  );
  canvas.dispatchEvent(
    new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y, ...init })
  );
}

function doubleClick(canvas: HTMLCanvasElement, x = 10, y = 10): void {
  canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
}

function wheel(canvas: HTMLCanvasElement, deltaY: number, init: WheelEventInit = {}): void {
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ...init,
    })
  );
}

describe('setupInteraction selection clearing', () => {
  it.each([
    [20, 10],
    [10, 20],
  ])('selects only bases between drag boundaries %s → %s', (from, to) => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    interaction.genomeLength = 1000;
    interaction.genomeCircular = false;
    interaction.screenToBp = (x) => x;
    interaction.screenToBoundaryBp = (x) => x;
    const committed = vi.fn();
    interaction.onSelectionChange = committed;
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: from, clientY: 50 }));
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: to, clientY: 50 }));
    interaction.flushInteraction();
    canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: to, clientY: 50 }));
    expect(state.highlightRange).toEqual([10, 19]);
    expect(committed).toHaveBeenLastCalledWith(10, 19);
    interaction.cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('single-clicking a feature focuses it without committing a highlight range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      highlightRange: [300, 350],
    });
    const interaction = setupInteraction(canvas, state);
    const feature = { id: 7, start: 100, end: 200 };
    const onFeatureClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: feature });
    interaction.onFeatureClick = onFeatureClick;

    tap(canvas);

    expect(state.highlightRange).toBeNull();
    expect(state.cursorPosition).toBeNull();
    expect(state.selectedIds.has(7)).toBe(true);
    expect(onFeatureClick).toHaveBeenCalledWith(feature);

    interaction.cleanup();
  });

  it('consumes a whole-read click without changing coordinate or feature selection', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      highlightRange: [300, 350],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onReadClick = vi.fn();
    const onPositionClick = vi.fn();
    const readHit = {
      trackId: 'tumor-bam',
      sourceGenerationKey: 'alignment-generation-7',
      readId: 'paired-qname',
      chrom: 'chr7',
      referenceStart: 100,
      start: 100,
      end: 110,
      flag: 147,
      strand: '-' as const,
      mapq: 42,
      pair: { paired: true as const, readNumber: 2 as const },
      bodyRect: { left: 100, top: 50, width: 80, height: 8 },
      screenX: 140,
      screenY: 54,
    };

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = () => ({ kind: 'read', payload: readHit });
    interaction.onReadClick = onReadClick;
    interaction.onPositionClick = onPositionClick;

    tap(canvas);

    expect(onReadClick).toHaveBeenCalledWith(readHit);
    expect(onPositionClick).not.toHaveBeenCalled();
    expect(state.cursorPosition).toBe(500);
    expect(state.highlightRange).toEqual([300, 350]);
    expect(state.selectedIds).toEqual(new Set([7]));

    interaction.cleanup();
  });

  it('preserves sparse event hover transitions within one whole-read identity', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const interaction = setupInteraction(canvas, makeState());
    const onReadHover = vi.fn();
    const readHit = {
      trackId: 'tumor-bam',
      sourceGenerationKey: 'alignment-generation-7',
      readId: 'read-with-difference',
      chrom: 'chr7',
      referenceStart: 100,
      start: 100,
      end: 110,
      flag: 99,
      strand: '+' as const,
      mapq: 60,
      bodyRect: { left: 10, top: 10, width: 100, height: 8 },
      screenX: 10,
      screenY: 14,
    };
    interaction.hitTestFn = (x) => ({
      kind: 'read',
      payload:
        x < 20
          ? readHit
          : {
              ...readHit,
              event: { pos: 104, kind: 'sub' as const, refBase: 'A', readBase: 'G' },
            },
    });
    interaction.onReadHover = onReadHover;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 14 })
    );
    interaction.flushInteraction();
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 14 })
    );
    interaction.flushInteraction();

    expect(onReadHover).toHaveBeenNthCalledWith(1, readHit);
    expect(onReadHover).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: expect.objectContaining({ pos: 104, kind: 'sub' }) })
    );

    interaction.cleanup();
  });

  it('uses a precision cursor only while an exact read is under the hotspot', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const readHit = {
      trackId: 'tumor-bam',
      sourceGenerationKey: 'alignment-generation-7',
      readId: 'precision-read',
      chrom: 'chr7',
      referenceStart: 100,
      start: 100,
      end: 110,
      flag: 99,
      strand: '+' as const,
      mapq: 60,
      bodyRect: { left: 10, top: 10, width: 100, height: 8 },
      screenX: 10,
      screenY: 14,
    };
    let overRead = true;
    interaction.screenToBp = () => 105;
    interaction.hitTestFn = () => (overRead ? { kind: 'read', payload: readHit } : null);

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 14 })
    );
    interaction.flushInteraction();
    expect(canvas.style.cursor).toBe('crosshair');
    expect(state.hoverPosition).toBe(105);

    overRead = false;
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 20 })
    );
    interaction.flushInteraction();
    expect(canvas.style.cursor).toBe('');

    interaction.cleanup();
  });

  it('updates the hover anchor as the pointer moves within one wide read', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const interaction = setupInteraction(canvas, makeState());
    const onReadHover = vi.fn();
    const readHit = {
      trackId: 'tumor-bam',
      sourceGenerationKey: 'alignment-generation-7',
      readId: 'wide-read',
      chrom: 'chr7',
      referenceStart: 100,
      start: 100,
      end: 110,
      flag: 99,
      strand: '+' as const,
      mapq: 60,
      bodyRect: { left: 10, top: 10, width: 600, height: 8 },
      screenX: 10,
      screenY: 14,
    };
    interaction.hitTestFn = (x, y) => ({
      kind: 'read',
      payload: { ...readHit, screenX: x, screenY: y },
    });
    interaction.onReadHover = onReadHover;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 14 })
    );
    interaction.flushInteraction();
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 420, clientY: 14 })
    );
    interaction.flushInteraction();

    expect(onReadHover).toHaveBeenCalledTimes(2);
    expect(onReadHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ screenX: 420, screenY: 14 })
    );

    interaction.cleanup();
  });

  it('emits camera changes only when user wheel scroll is flushed', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 1, viewOffset: 0 });
    const interaction = setupInteraction(canvas, state);
    const onCameraChange = vi.fn();
    interaction.onCameraChange = onCameraChange;
    interaction.genomeLength = 1000;

    interaction.flushInteraction();
    expect(onCameraChange).not.toHaveBeenCalled();

    wheel(canvas, 100);
    interaction.flushInteraction();

    expect(onCameraChange).toHaveBeenCalledTimes(1);
    expect(onCameraChange).toHaveBeenCalledWith('scroll');
    expect(state.viewOffset).toBeGreaterThan(0);

    interaction.cleanup();
  });

  it.each([
    { edge: 'right', viewOffset: 0.5, deltaY: 100 },
    { edge: 'left', viewOffset: -0.5, deltaY: -100 },
  ])(
    'does not publish a camera change when an outward wheel packet is clamped at the $edge linear edge',
    ({ viewOffset, deltaY }) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const state = makeState({ zoom: 1, viewOffset });
      const interaction = setupInteraction(canvas, state);
      const onCameraChange = vi.fn();
      interaction.onCameraChange = onCameraChange;
      interaction.genomeLength = 1000;
      interaction.genomeCircular = false;

      wheel(canvas, deltaY, { clientX: 700, clientY: 100 });
      interaction.flushInteraction();

      expect(state.viewOffset).toBe(viewOffset);
      expect(onCameraChange).not.toHaveBeenCalled();

      interaction.cleanup();
    }
  );

  it('emits camera changes when user zoom is flushed', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 1, viewOffset: 0 });
    const interaction = setupInteraction(canvas, state);
    const onCameraChange = vi.fn();
    interaction.onCameraChange = onCameraChange;
    interaction.genomeLength = 1000;

    wheel(canvas, -20, { metaKey: true });
    interaction.flushInteraction();

    expect(onCameraChange).toHaveBeenCalledTimes(1);
    expect(onCameraChange).toHaveBeenCalledWith('zoom');
    expect(state.zoom).toBeGreaterThan(1);

    interaction.cleanup();
  });

  it.each([false, true])(
    'keeps the last wheel zoom anchor when the pointer moves before the frame (batched=%s)',
    (batched) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const state = makeState();
      const interaction = setupInteraction(canvas, state);
      const onBeforeZoom = vi.fn();
      const shouldZoomToCursor = vi.fn(() => true);
      interaction.onBeforeZoom = onBeforeZoom;
      interaction.shouldZoomToCursor = shouldZoomToCursor;
      interaction.genomeLength = 1000;
      try {
        if (batched) wheel(canvas, -8, { ctrlKey: true, clientX: 100, clientY: 80 });
        wheel(canvas, -8, { ctrlKey: true, clientX: 400, clientY: 150 });
        canvas.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 8, clientY: 292 })
        );
        interaction.flushInteraction();

        expect(shouldZoomToCursor).toHaveBeenCalledWith(400, 150, state);
        expect(onBeforeZoom).toHaveBeenCalledTimes(1);
        expect(onBeforeZoom).toHaveBeenCalledWith(1, state.zoom, 400, 150);
      } finally {
        interaction.cleanup();
      }
    }
  );

  it('single-clicking a codon chevron focuses its parent feature without committing a range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      selectedIds: new Set([7]),
      highlightRange: [100, 199],
    });
    const interaction = setupInteraction(canvas, state);
    const onSelectionChange = vi.fn();
    const onPositionClick = vi.fn();
    const onFeatureClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = () => ({
      kind: 'codon',
      payload: { start: 300, end: 302, featureId: 8, featureStart: 250, featureEnd: 400 },
    });
    interaction.onSelectionChange = onSelectionChange;
    interaction.onPositionClick = onPositionClick;
    interaction.onFeatureClick = onFeatureClick;

    tap(canvas);

    expect(state.highlightRange).toBeNull();
    expect(state.cursorPosition).toBeNull();
    expect([...state.selectedIds]).toEqual([8]);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onPositionClick).not.toHaveBeenCalled();
    expect(onFeatureClick).toHaveBeenCalledWith({ id: 8, start: 250, end: 400 });

    interaction.cleanup();
  });

  it('selects the parent CDS when a codon chevron is double-clicked', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      highlightRange: [300, 302],
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();
    const onFeatureRangeCommit = vi.fn();
    const onPositionDoubleClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.hitTestFn = () => ({
      kind: 'codon',
      payload: {
        start: 300,
        end: 302,
        featureId: 7,
        featureStart: 100,
        featureEnd: 400,
      },
    });
    interaction.onFeatureClick = onFeatureClick;
    interaction.onFeatureRangeCommit = onFeatureRangeCommit;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    doubleClick(canvas);

    expect(state.highlightRange).toEqual([100, 399]);
    expect(state.cursorPosition).toBeNull();
    expect(state.selectedIds.has(7)).toBe(true);
    expect(onFeatureClick).not.toHaveBeenCalled();
    expect(onPositionDoubleClick).toHaveBeenCalledWith(300);
    expect(onFeatureRangeCommit).toHaveBeenCalledWith({ id: 7, start: 100, end: 400 });
    expect(onPositionDoubleClick.mock.invocationCallOrder[0]).toBeLessThan(
      onFeatureRangeCommit.mock.invocationCallOrder[0]
    );

    interaction.cleanup();
  });

  it('single-clicking an ORF focuses it without committing a highlight range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      selectedIds: new Set([7]),
      highlightRange: [100, 199],
    });
    const interaction = setupInteraction(canvas, state);
    const onOrfClick = vi.fn();
    const onSelectionChange = vi.fn();
    const orf = { start: 20, end: 79, strand: '+' as const, frame: 1, length: 60 };

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 50;
    interaction.hitTestFn = () => ({ kind: 'orf', payload: orf });
    interaction.onOrfClick = onOrfClick;
    interaction.onSelectionChange = onSelectionChange;

    tap(canvas);

    expect(state.highlightRange).toBeNull();
    expect(state.cursorPosition).toBeNull();
    expect([...state.selectedIds]).toEqual([]);
    expect(state.selectedOrf).toEqual({ start: 20, end: 79, strand: '+' });
    expect(onOrfClick).toHaveBeenCalledWith(orf);
    expect(onSelectionChange).not.toHaveBeenCalled();

    interaction.cleanup();
  });

  it('double-clicking an ORF commits the full ORF range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ cursorPosition: 500 });
    const interaction = setupInteraction(canvas, state);
    const onOrfRangeCommit = vi.fn();
    const onPositionDoubleClick = vi.fn();
    const orf = { start: 20, end: 79, strand: '-' as const, frame: -1, length: 60 };

    interaction.genomeLength = 1000;
    interaction.hitTestFn = () => ({ kind: 'orf', payload: orf });
    interaction.onOrfRangeCommit = onOrfRangeCommit;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    doubleClick(canvas);

    expect(state.highlightRange).toEqual([20, 79]);
    expect(state.cursorPosition).toBeNull();
    expect(state.selectedOrf).toEqual({ start: 20, end: 79, strand: '-' });
    expect(onPositionDoubleClick).toHaveBeenCalledWith(20);
    expect(onOrfRangeCommit).toHaveBeenCalledWith(orf);
    expect(onPositionDoubleClick.mock.invocationCallOrder[0]).toBeLessThan(
      onOrfRangeCommit.mock.invocationCallOrder[0]
    );

    interaction.cleanup();
  });

  it('selects a feature range when a feature is double-clicked', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      highlightRange: null,
    });
    const interaction = setupInteraction(canvas, state);
    const feature = { id: 7, start: 100, end: 200 };
    const onFeatureClick = vi.fn();
    const onFeatureRangeCommit = vi.fn();
    const onPositionDoubleClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: feature });
    interaction.onFeatureClick = onFeatureClick;
    interaction.onFeatureRangeCommit = onFeatureRangeCommit;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    doubleClick(canvas);

    expect(state.highlightRange).toEqual([100, 199]);
    expect(state.cursorPosition).toBeNull();
    expect(state.selectedIds.has(7)).toBe(true);
    expect(onFeatureClick).not.toHaveBeenCalled();
    expect(onPositionDoubleClick).toHaveBeenCalledWith(100);
    expect(onFeatureRangeCommit).toHaveBeenCalledWith(feature);
    expect(onPositionDoubleClick.mock.invocationCallOrder[0]).toBeLessThan(
      onFeatureRangeCommit.mock.invocationCallOrder[0]
    );

    interaction.cleanup();
  });

  it('selects exactly one provenance part range when its backbone segment is double-clicked', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      cursorPosition: 500,
      highlightRange: [10, 20],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const part = {
      regionId: 'digest-fragment',
      rangeStart: 100,
      rangeEnd: 200,
    };
    const onBackbonePartSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const onPositionDoubleClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 143;
    interaction.hitTestFn = () => ({ kind: 'backbone-part', payload: part });
    interaction.onBackbonePartSelect = onBackbonePartSelect;
    interaction.onSelectionChange = onSelectionChange;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    doubleClick(canvas);

    expect(state.highlightRange).toEqual([100, 199]);
    expect(state.cursorPosition).toBeNull();
    expect(state.selectedIds).toEqual(new Set());
    expect(onBackbonePartSelect).toHaveBeenCalledOnce();
    expect(onBackbonePartSelect).toHaveBeenCalledWith(part);
    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSelectionChange).toHaveBeenCalledWith(100, 199);
    expect(onPositionDoubleClick).toHaveBeenCalledOnce();
    expect(onPositionDoubleClick).toHaveBeenCalledWith(143);

    interaction.cleanup();
  });

  it('selects a cut-site recognition range when a cut-site target is clicked', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ cursorPosition: 500 });
    const interaction = setupInteraction(canvas, state);
    const onSelectionChange = vi.fn();
    const onPositionClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 125;
    interaction.hitTestFn = () => ({
      kind: 'cut-site',
      payload: {
        id: 'EcoRI:120',
        enzymeName: 'EcoRI',
        position: 120,
        recognitionStart: 120,
        recognitionEnd: 126,
        cutPositionTop: 121,
        cutPositionBottom: 125,
      },
    });
    interaction.onSelectionChange = onSelectionChange;
    interaction.onPositionClick = onPositionClick;

    tap(canvas);

    expect(state.highlightRange).toEqual([120, 125]);
    expect(state.cursorPosition).toBeNull();
    expect(state.hoveredCutSiteId).toBe('EcoRI:120');
    expect(onSelectionChange).toHaveBeenCalledWith(120, 125);
    expect(onPositionClick).not.toHaveBeenCalled();

    interaction.cleanup();
  });

  it('preserves an origin-spanning cut-site recognition range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onSelectionChange = vi.fn();

    interaction.genomeLength = 1000;
    interaction.genomeCircular = true;
    interaction.hitTestFn = () => ({
      kind: 'cut-site',
      payload: {
        id: 'BsaI:996',
        enzymeName: 'BsaI',
        position: 996,
        recognitionStart: 996,
        recognitionEnd: 2,
        cutPositionTop: 3,
        cutPositionBottom: 7,
      },
    });
    interaction.onSelectionChange = onSelectionChange;

    tap(canvas);

    expect(state.highlightRange).toEqual([996, 1]);
    expect(onSelectionChange).toHaveBeenCalledWith(996, 1);

    interaction.cleanup();
  });

  it('shift-clicking a feature resolves selection using the full feature range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onSelectionChange = vi.fn();
    const resolveShiftClickRange = vi.fn(() => [100, 259] as [number, number]);

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 225;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: { id: 7, start: 200, end: 260 } });
    interaction.resolveShiftClickRange = resolveShiftClickRange;
    interaction.onSelectionChange = onSelectionChange;

    tap(canvas, 10, 10, { shiftKey: true });

    expect(resolveShiftClickRange).toHaveBeenCalledWith({
      currentRange: [100, 150],
      rangeStart: 200,
      rangeEnd: 259,
      cursorPosition: null,
      genomeLength: 1000,
      circular: false,
      altKey: false,
    });
    expect(state.highlightRange).toEqual([100, 259]);
    expect(onSelectionChange).toHaveBeenCalledWith(100, 259);

    interaction.cleanup();
  });

  it('shift-clicking a codon resolves selection using the codon range', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150], cursorPosition: 125 });
    const interaction = setupInteraction(canvas, state);
    const resolveShiftClickRange = vi.fn(() => [100, 302] as [number, number]);

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 301;
    interaction.hitTestFn = () => ({
      kind: 'codon',
      payload: { start: 300, end: 302, featureId: 7, featureStart: 250, featureEnd: 400 },
    });
    interaction.resolveShiftClickRange = resolveShiftClickRange;

    tap(canvas, 10, 10, { shiftKey: true });

    expect(resolveShiftClickRange).toHaveBeenCalledWith({
      currentRange: [100, 150],
      rangeStart: 300,
      rangeEnd: 302,
      cursorPosition: 125,
      genomeLength: 1000,
      circular: false,
      altKey: false,
    });
    expect(state.highlightRange).toEqual([100, 302]);

    interaction.cleanup();
  });

  it('keeps a cut-site highlight while double-clicking to navigate the 2D viewer', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onSelectionChange = vi.fn();
    const onPositionDoubleClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.hitTestFn = () => ({
      kind: 'cut-site',
      payload: {
        id: 'EcoRI:120',
        enzymeName: 'EcoRI',
        position: 120,
        recognitionStart: 120,
        recognitionEnd: 126,
        cutPositionTop: 121,
        cutPositionBottom: 125,
      },
    });
    interaction.onSelectionChange = onSelectionChange;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    doubleClick(canvas);

    expect(state.highlightRange).toEqual([120, 125]);
    expect(onSelectionChange).toHaveBeenCalledWith(120, 125);
    expect(onPositionDoubleClick).toHaveBeenCalledWith(120);

    interaction.cleanup();
  });

  it('notifies the host when an empty click clears an existing highlight', () => {
    vi.useFakeTimers();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 199],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();
    const onReadClick = vi.fn();
    const onPositionClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = () => null;
    interaction.onFeatureClick = onFeatureClick;
    interaction.onReadClick = onReadClick;
    interaction.onPositionClick = onPositionClick;

    tap(canvas);

    expect(state.highlightRange).toBeNull();
    expect(state.selectedIds.size).toBe(0);
    expect(onPositionClick).toHaveBeenCalledWith(123);
    expect(onReadClick).toHaveBeenCalledWith(null);
    expect(onFeatureClick).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();

    expect(onFeatureClick).toHaveBeenCalledWith(null);

    interaction.cleanup();
  });

  it('does not let a deferred clear wipe out a newer selection', () => {
    vi.useFakeTimers();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 199],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = () => null;
    interaction.onFeatureClick = onFeatureClick;

    tap(canvas);
    state.highlightRange = [300, 350];

    vi.runOnlyPendingTimers();

    expect(onFeatureClick).not.toHaveBeenCalled();

    interaction.cleanup();
  });

  it('notifies the host when an empty double-click should navigate the 2D viewer', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onPositionDoubleClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 456;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    doubleClick(canvas);

    expect(onPositionDoubleClick).toHaveBeenCalledWith(456);

    interaction.cleanup();
  });

  it('opens context menu without treating right-click as a selection-clearing click', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 199],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();
    const onFeatureRangeCommit = vi.fn();
    const onContextMenu = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: { id: 7, start: 100, end: 200 } });
    interaction.onFeatureClick = onFeatureClick;
    interaction.onFeatureRangeCommit = onFeatureRangeCommit;
    interaction.onContextMenu = onContextMenu;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, button: 2, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );

    expect(state.highlightRange).toEqual([100, 199]);
    expect(state.selectedIds.has(7)).toBe(true);
    expect(onFeatureClick).not.toHaveBeenCalled();
    expect(onFeatureRangeCommit).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toMatchObject({
      position: 123,
      hitResult: { kind: 'feature', payload: { id: 7, start: 100, end: 200 } },
      highlightRange: [100, 199],
    });

    interaction.cleanup();
  });

  it('selects a right-clicked provenance part before opening its context menu', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const part = {
      regionId: 'part-b',
      rangeStart: 300,
      rangeEnd: 450,
    };
    const onBackbonePartSelect = vi.fn();
    const onContextMenu = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 350;
    interaction.hitTestFn = () => ({ kind: 'backbone-part', payload: part });
    interaction.onBackbonePartSelect = onBackbonePartSelect;
    interaction.onContextMenu = onContextMenu;

    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );

    expect(onBackbonePartSelect).toHaveBeenCalledOnce();
    expect(onBackbonePartSelect).toHaveBeenCalledWith(part);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onBackbonePartSelect.mock.invocationCallOrder[0]).toBeLessThan(
      onContextMenu.mock.invocationCallOrder[0]
    );

    interaction.cleanup();
  });

  it('retargets right-click to a feature outside the existing highlight before opening the context menu', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 199],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();
    const onFeatureRangeCommit = vi.fn();
    const onContextMenu = vi.fn();
    const hitFeature = { id: 9, start: 300, end: 350 };

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 310;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: hitFeature });
    interaction.onFeatureClick = onFeatureClick;
    interaction.onFeatureRangeCommit = onFeatureRangeCommit;
    interaction.onContextMenu = onContextMenu;

    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );

    expect(state.highlightRange).toEqual([300, 349]);
    expect([...state.selectedIds]).toEqual([9]);
    expect(onFeatureClick).not.toHaveBeenCalled();
    expect(onFeatureRangeCommit).toHaveBeenCalledWith(hitFeature);
    expect(onContextMenu.mock.calls[0][1]).toMatchObject({
      position: 310,
      highlightRange: [300, 349],
    });

    interaction.cleanup();
  });

  it('retargets right-click to an ORF outside the existing highlight before opening the context menu', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 199],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onOrfRangeCommit = vi.fn();
    const onContextMenu = vi.fn();
    const hitOrf = { start: 300, end: 359, strand: '+' as const, frame: 1, length: 60 };

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 310;
    interaction.hitTestFn = () => ({ kind: 'orf', payload: hitOrf });
    interaction.onOrfRangeCommit = onOrfRangeCommit;
    interaction.onContextMenu = onContextMenu;

    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );

    expect(state.highlightRange).toEqual([300, 359]);
    expect(state.selectedIds.size).toBe(0);
    expect(state.selectedOrf).toEqual({ start: 300, end: 359, strand: '+' });
    expect(onOrfRangeCommit).toHaveBeenCalledWith(hitOrf);
    expect(onContextMenu.mock.calls[0][1]).toMatchObject({
      position: 310,
      hitResult: { kind: 'orf', payload: hitOrf },
      highlightRange: [300, 359],
    });

    interaction.cleanup();
  });

  it('clears stale highlight before opening an empty-space context menu outside the selection', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 199],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();
    const onContextMenu = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 310;
    interaction.hitTestFn = () => null;
    interaction.onFeatureClick = onFeatureClick;
    interaction.onContextMenu = onContextMenu;

    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );

    expect(state.highlightRange).toBeNull();
    expect(state.selectedIds.size).toBe(0);
    expect(onFeatureClick).toHaveBeenCalledWith(null);
    expect(onContextMenu.mock.calls[0][1]).toMatchObject({
      position: 310,
      hitResult: null,
      highlightRange: null,
    });

    interaction.cleanup();
  });

  it('retargets right-click to a cut site outside the existing highlight before opening the context menu', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 110],
      selectedIds: new Set([7]),
    });
    const interaction = setupInteraction(canvas, state);
    const onFeatureClick = vi.fn();
    const onContextMenu = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 122;
    interaction.hitTestFn = () => ({
      kind: 'cut-site',
      payload: {
        id: 'EcoRI:120',
        enzymeName: 'EcoRI',
        position: 120,
        recognitionStart: 120,
        recognitionEnd: 126,
        cutPositionTop: 121,
        cutPositionBottom: 125,
      },
    });
    interaction.onFeatureClick = onFeatureClick;
    interaction.onContextMenu = onContextMenu;

    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      })
    );

    expect(state.highlightRange).toEqual([120, 125]);
    expect(state.selectedIds.size).toBe(0);
    expect(onFeatureClick).toHaveBeenCalledWith(null);
    expect(onContextMenu.mock.calls[0][1]).toMatchObject({
      position: 122,
      hitResult: { kind: 'cut-site' },
      highlightRange: [120, 125],
    });

    interaction.cleanup();
  });

  it('keeps feature focus through the second tap and commits range on feature double-click', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const feature = { id: 7, start: 100, end: 200 };
    const onFeatureClick = vi.fn();
    const onFeatureRangeCommit = vi.fn();
    const onPositionClick = vi.fn();
    const onPositionDoubleClick = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 123;
    interaction.hitTestFn = vi.fn(() => ({ kind: 'feature' as const, payload: feature }));
    interaction.onFeatureClick = onFeatureClick;
    interaction.onFeatureRangeCommit = onFeatureRangeCommit;
    interaction.onPositionClick = onPositionClick;
    interaction.onPositionDoubleClick = onPositionDoubleClick;

    tap(canvas, 20, 20);
    tap(canvas, 20, 20);
    doubleClick(canvas, 20, 20);

    expect(state.highlightRange).toEqual([100, 199]);
    expect(state.selectedIds.has(7)).toBe(true);
    expect(onFeatureClick).toHaveBeenCalledOnce();
    expect(onFeatureClick).toHaveBeenCalledWith(feature);
    expect(onPositionDoubleClick).toHaveBeenCalledWith(123);
    expect(onFeatureRangeCommit).toHaveBeenCalledWith(feature);
    expect(onPositionClick).not.toHaveBeenCalled();
    expect(onPositionDoubleClick.mock.invocationCallOrder[0]).toBeLessThan(
      onFeatureRangeCommit.mock.invocationCallOrder[0]
    );

    interaction.cleanup();
  });

  it.each([
    [false, 102, 10, 50],
    [false, 108, 11, 50],
    [true, 102, 10, 200],
    [true, 108, 11, 200],
  ])(
    'uses the same hover boundary and drag anchor: circular=%s x=%s',
    (circular, x, boundary, endX) => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const state = makeState();
      const interaction = setupInteraction(canvas, state);
      interaction.genomeLength = 1000;
      interaction.genomeCircular = circular;
      interaction.screenToBp = (px) => Math.floor(px / 10);
      interaction.screenToBoundaryBp = (px) => Math.round(px / 10);

      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 50 }));
      interaction.flushInteraction();
      expect(state.hoverPosition).toBe(boundary);

      canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: 50 }));
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: endX, clientY: 50 }));
      interaction.flushInteraction();
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: endX, clientY: 50 }));
      expect(state.highlightRange).toEqual([
        Math.min(boundary, endX / 10),
        Math.max(boundary, endX / 10) - 1,
      ]);
      interaction.cleanup();
    }
  );

  it('updates and clears the transient hover bp guide without host state', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onHoverFeature = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => x;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: { id: 9, start: 70, end: 80 } });
    interaction.onHoverFeature = onHoverFeature;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();

    expect(state.hoverPosition).toBe(75);
    expect(state.hoveredId).toBe(9);

    canvas.dispatchEvent(
      new MouseEvent('pointerleave', { bubbles: true, clientX: 75, clientY: 10 })
    );

    expect(state.hoverPosition).toBeNull();
    expect(state.hoveredId).toBeNull();

    interaction.flushInteraction();

    expect(state.hoveredId).toBeNull();
    expect(onHoverFeature).toHaveBeenLastCalledWith(null, 75, 10);

    interaction.cleanup();
  });

  it('suppresses the position guide on a renderer-owned overview while preserving hover below it', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;
    interaction.screenToBoundaryBp = (x) => x;
    interaction.screenToBp = (x) => x;
    interaction.shouldShowPositionGuide = (_x, y) => y >= 32;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(state.hoverPosition).toBeNull();

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 40 })
    );
    interaction.flushInteraction();
    expect(state.hoverPosition).toBe(75);

    interaction.cleanup();
  });

  it('clears stale annotation hover during the camera gate and reacquires under a stationary pointer', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onHoverFeature = vi.fn();
    const hitTest = vi
      .fn()
      .mockReturnValueOnce({ kind: 'feature', payload: { id: 9, start: 70, end: 80 } })
      .mockReturnValue({ kind: 'feature', payload: { id: 10, start: 90, end: 100 } });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 75;
    interaction.hitTestFn = hitTest;
    interaction.onHoverFeature = onHoverFeature;
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(state.hoveredId).toBe(9);

    now = 10;
    wheel(canvas, 120, { clientX: 75, clientY: 10 });
    interaction.flushInteraction();
    expect(state.hoveredId).toBeNull();
    expect(onHoverFeature).toHaveBeenLastCalledWith(null, 75, 10);
    expect(hitTest).toHaveBeenCalledTimes(1);

    now = 91;
    interaction.flushInteraction();
    expect(state.hoveredId).toBe(10);
    expect(onHoverFeature).toHaveBeenLastCalledWith({ id: 10, start: 90, end: 100 }, 75, 10);
    expect(hitTest).toHaveBeenCalledTimes(2);
    interaction.cleanup();
  });

  it('publishes pointer movement within one feature so exon and intron hover can change', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const interaction = setupInteraction(canvas, makeState());
    const feature = { id: 9, start: 10, end: 90 };
    const onHoverFeature = vi.fn();
    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => x;
    interaction.hitTestFn = () => ({ kind: 'feature', payload: feature });
    interaction.onHoverFeature = onHoverFeature;
    for (const x of [15, 45, 65]) {
      canvas.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 10 })
      );
      interaction.flushInteraction();
    }
    expect(onHoverFeature).toHaveBeenCalledTimes(3);
    expect(onHoverFeature).toHaveBeenLastCalledWith(feature, 65, 10);
    interaction.flushInteraction();
    expect(onHoverFeature).toHaveBeenCalledTimes(3);
    interaction.cleanup();
  });

  it('reconciles a stationary pointer when renderer hit-test authority changes', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onHoverFeature = vi.fn();
    let hitFeature = { id: 9, start: 70, end: 80 };
    const hitTest = vi.fn(() => ({ kind: 'feature' as const, payload: hitFeature }));

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 75;
    interaction.hitTestFn = hitTest;
    interaction.onHoverFeature = onHoverFeature;
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(state.hoveredId).toBe(9);

    hitFeature = { id: 10, start: 90, end: 100 };
    interaction.flushInteraction();
    expect(state.hoveredId).toBe(9);
    expect(hitTest).toHaveBeenCalledTimes(1);

    interaction.invalidateHoverHitTest();
    interaction.flushInteraction();
    expect(state.hoveredId).toBe(10);
    expect(onHoverFeature).toHaveBeenLastCalledWith({ id: 10, start: 90, end: 100 }, 75, 10);
    expect(hitTest).toHaveBeenCalledTimes(2);

    interaction.cleanup();
  });

  it('uses the selectable cursor without drawing the full-height bp guide when hovering a codon hit', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onHoverFeature = vi.fn();
    const onCodonHover = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 300;
    interaction.hitTestFn = () => ({
      kind: 'codon',
      payload: {
        start: 300,
        end: 302,
        featureId: 7,
        featureStart: 100,
        featureEnd: 400,
        strand: -1,
      },
    });
    interaction.onHoverFeature = onHoverFeature;
    interaction.onCodonHover = onCodonHover;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();

    expect(canvas.style.cursor).toBe('pointer');
    expect(state.hoverPosition).toBeNull();
    expect(state.hoveredCodon).toEqual({ start: 300, end: 302, strand: -1 });
    expect(state.hoveredId).toBe(7);
    expect(onHoverFeature).toHaveBeenCalledWith({ id: 7, start: 100, end: 400 }, 75, 10);
    expect(onCodonHover).toHaveBeenCalledWith({ start: 300, end: 302, strand: -1 });

    canvas.dispatchEvent(
      new MouseEvent('pointerleave', { bubbles: true, clientX: 75, clientY: 10 })
    );

    expect(state.hoveredCodon).toBeNull();
    expect(state.hoveredId).toBeNull();
    expect(onHoverFeature).toHaveBeenLastCalledWith(null, 75, 10);
    expect(onCodonHover).toHaveBeenLastCalledWith(null);

    interaction.cleanup();
  });

  it('publishes a new hover when the pointer moves between original and mutant versions of the same codon', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onCodonHover = vi.fn();
    let codingSource: 'reference' | 'query' = 'reference';
    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 300;
    interaction.hitTestFn = () => ({
      kind: 'codon',
      payload: {
        start: 300,
        end: 302,
        strand: 1,
        featureId: codingSource === 'reference' ? 7 : 8,
        featureStart: 100,
        featureEnd: 400,
        codingSource,
      },
    });
    interaction.onCodonHover = onCodonHover;
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 75, clientY: 10 }));
    interaction.flushInteraction();
    codingSource = 'query';
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 75, clientY: 30 }));
    interaction.flushInteraction();
    expect(onCodonHover.mock.calls.map((call) => call[0]?.codingSource)).toEqual([
      'reference',
      'query',
    ]);
    interaction.cleanup();
    canvas.remove();
  });

  it('publishes intron connector hover without changing empty-canvas click behavior', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ hoveredCodon: null });
    const interaction = setupInteraction(canvas, state);
    const feature = { id: 7, start: 450, end: 250 };
    const onHoverFeature = vi.fn();
    const onFeatureClick = vi.fn();
    const onPositionClick = vi.fn();
    interaction.genomeLength = 603;
    interaction.genomeCircular = true;
    interaction.screenToBp = () => 580;
    interaction.hitTestFn = () => null;
    interaction.hitTestHoverFeatureFn = vi.fn(() => feature);
    interaction.onHoverFeature = onHoverFeature;
    interaction.onFeatureClick = onFeatureClick;
    interaction.onPositionClick = onPositionClick;
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 75, clientY: 10 }));
    interaction.flushInteraction();
    expect(onHoverFeature).toHaveBeenCalledWith(feature, 75, 10);
    expect(state.hoveredId).toBe(7);
    expect(state.hoveredCodon).toBeNull();
    tap(canvas, 75, 10);
    expect(onPositionClick).toHaveBeenCalledWith(580);
    expect(onFeatureClick).not.toHaveBeenCalledWith(feature);
    expect(state.selectedIds.size).toBe(0);
    expect(interaction.hitTestHoverFeatureFn).toHaveBeenCalledOnce();
    interaction.cleanup();
  });

  it('refreshes feature hover when the camera moves under a stationary pointer', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const feature = { id: 7, start: 450, end: 250 };
    const onHoverFeature = vi.fn();
    interaction.genomeLength = 603;
    interaction.genomeCircular = true;
    interaction.screenToBp = () => (state.viewOffset === 0 ? 500 : 580);
    interaction.hitTestFn = () => ({ kind: 'feature', payload: feature });
    interaction.onHoverFeature = onHoverFeature;
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 75, clientY: 10 }));
    interaction.flushInteraction();
    expect(onHoverFeature).toHaveBeenCalledTimes(1);
    state.viewOffset = 80 / 603;
    interaction.invalidateHoverHitTest();
    interaction.flushInteraction();
    expect(onHoverFeature).toHaveBeenCalledTimes(2);
    expect(onHoverFeature).toHaveBeenLastCalledWith(feature, 75, 10);
    interaction.flushInteraction();
    expect(onHoverFeature).toHaveBeenCalledTimes(2);
    interaction.cleanup();
  });

  it('uses the text cursor when hovering visible nucleotide text', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 300;
    interaction.hitTestFn = () => null;
    interaction.hitTestNucleotideText = () => true;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();

    expect(canvas.style.cursor).toBe('text');
    expect(state.hoverPosition).toBe(300);

    interaction.cleanup();
  });

  it('skips hover hit testing on idle flushes until input changes', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const hitTestFn = vi.fn(() => null);

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 300;
    interaction.hitTestFn = hitTestFn;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();
    interaction.flushInteraction();

    expect(hitTestFn).toHaveBeenCalledTimes(1);

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 76, clientY: 10 })
    );
    interaction.flushInteraction();

    expect(hitTestFn).toHaveBeenCalledTimes(2);

    interaction.cleanup();
  });

  it('uses the selectable cursor and hoveredCutSiteId when hovering a cut-site target', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ hoveredId: 9 });
    const interaction = setupInteraction(canvas, state);
    const onHoverFeature = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 122;
    interaction.hitTestFn = () => ({
      kind: 'cut-site',
      payload: {
        id: 'EcoRI:120',
        enzymeName: 'EcoRI',
        position: 120,
        recognitionStart: 120,
        recognitionEnd: 126,
        cutPositionTop: 121,
        cutPositionBottom: 125,
      },
    });
    interaction.onHoverFeature = onHoverFeature;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 75, clientY: 10 })
    );
    interaction.flushInteraction();

    expect(canvas.style.cursor).toBe('pointer');
    expect(state.hoverPosition).toBe(122);
    expect(state.hoveredCutSiteId).toBe('EcoRI:120');
    expect(state.hoveredId).toBeNull();
    expect(onHoverFeature).toHaveBeenCalledWith(null, 75, 10);

    canvas.dispatchEvent(
      new MouseEvent('pointerleave', { bubbles: true, clientX: 75, clientY: 10 })
    );

    expect(state.hoveredCutSiteId).toBeNull();

    interaction.cleanup();
  });

  it('prioritizes selection handle hover over the transient bp guide', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      highlightRange: [100, 150],
      hoveredId: 9,
      hoveredCodon: { start: 300, end: 302, strand: 1 },
    });
    const interaction = setupInteraction(canvas, state);
    const onHoverFeature = vi.fn();
    const hitTestFn = vi.fn<NonNullable<typeof interaction.hitTestFn>>(() => ({
      kind: 'feature',
      payload: { id: 9, start: 70, end: 80 },
    }));

    interaction.genomeLength = 1000;
    interaction.screenToBp = vi.fn(() => 125);
    interaction.hitTestFn = hitTestFn;
    interaction.hitTestSelectionHandle = vi.fn<
      (screenX: number, screenY: number, state: RenderState) => 'start' | null
    >(() => 'start');
    interaction.onHoverFeature = onHoverFeature;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 20 })
    );
    interaction.flushInteraction();

    expect(state.hoverPosition).toBeNull();
    expect(state.hoveredCodon).toBeNull();
    expect(state.hoveredId).toBeNull();
    expect(canvas.style.cursor).toBe('ew-resize');
    expect(hitTestFn).not.toHaveBeenCalled();
    expect(onHoverFeature).toHaveBeenCalledWith(null, 100, 20);

    interaction.cleanup();
  });

  it('keeps a short primer inspectable under a selection handle without annotation scans', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 141] });
    const interaction = setupInteraction(canvas, state);
    const primer = { id: PRIMER_RENDER_ID_OFFSET, start: 100, end: 142 };
    const onHoverFeature = vi.fn();
    const hitTestFn = vi.fn(() => null);
    const hitTestPrimerFn = vi.fn().mockReturnValueOnce({ kind: 'feature', payload: primer });
    interaction.hitTestPrimerFn = hitTestPrimerFn;
    interaction.hitTestFn = hitTestFn;
    interaction.hitTestSelectionHandle = () => 'start';
    interaction.onHoverFeature = onHoverFeature;
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 20 }));
    interaction.flushInteraction();
    expect(state.hoveredId).toBe(primer.id);
    expect(onHoverFeature).toHaveBeenLastCalledWith(primer, 100, 20);
    expect(state.highlightRange).toEqual([100, 141]);
    expect(state.hoverPosition).toBeNull();
    expect(canvas.style.cursor).toBe('ew-resize');
    expect(hitTestFn).not.toHaveBeenCalled();
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 110, clientY: 20 }));
    interaction.flushInteraction();
    expect(state.hoveredId).toBeNull();
    expect(onHoverFeature).toHaveBeenLastCalledWith(null, 110, 20);
    interaction.cleanup();
  });

  it('restores the transient bp guide after leaving a selection handle', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const hitTestSelectionHandle = vi
      .fn<(screenX: number, screenY: number, state: RenderState) => 'start' | null>()
      .mockReturnValueOnce('start');

    interaction.genomeLength = 1000;
    interaction.screenToBp = vi.fn(() => 125);
    interaction.hitTestFn = () => null;
    interaction.hitTestSelectionHandle = hitTestSelectionHandle;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 20 })
    );
    interaction.flushInteraction();

    expect(state.hoverPosition).toBeNull();
    expect(canvas.style.cursor).toBe('ew-resize');

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 130, clientY: 20 })
    );
    interaction.flushInteraction();

    expect(state.hoverPosition).toBe(125);
    expect(canvas.style.cursor).toBe('');

    interaction.cleanup();
  });

  it('keeps WebGL drag preview local and commits the final selection on pointerup', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ cursorPosition: 500 });
    const interaction = setupInteraction(canvas, state);
    const onSelectionStart = vi.fn();
    const onSelectionPreview = vi.fn();
    const onSelectionChange = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => (x <= 10 ? 100 : x <= 20 ? 120 : 150);
    interaction.onSelectionStart = onSelectionStart;
    interaction.onSelectionPreview = onSelectionPreview;
    interaction.onSelectionChange = onSelectionChange;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );

    expect(state.cursorPosition).toBeNull();
    expect(state.highlightRange).toEqual([100, 120]);
    expect(onSelectionStart).toHaveBeenCalledOnce();
    expect(onSelectionStart).toHaveBeenCalledWith('new');
    expect(onSelectionPreview).toHaveBeenCalledOnce();
    expect(onSelectionPreview).toHaveBeenCalledWith(100, 120);
    expect(onSelectionChange).not.toHaveBeenCalled();

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })
    );

    expect(state.highlightRange).toEqual([100, 150]);
    expect(onSelectionPreview).toHaveBeenCalledTimes(2);
    expect(onSelectionPreview).toHaveBeenLastCalledWith(100, 150);
    expect(onSelectionChange).not.toHaveBeenCalled();

    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 30, clientY: 10 }));

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSelectionChange).toHaveBeenCalledWith(100, 150);

    interaction.cleanup();
  });

  it('reports the exact selection handle that begins a range resize', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onSelectionStart = vi.fn();

    interaction.genomeLength = 1000;
    interaction.screenToBp = () => 170;
    interaction.hitTestSelectionHandle = () => 'end';
    interaction.onSelectionStart = onSelectionStart;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 10 }));

    expect(onSelectionStart).toHaveBeenCalledOnce();
    expect(onSelectionStart).toHaveBeenCalledWith('end');
    expect(state.highlightRange).toEqual([100, 170]);

    interaction.cleanup();
  });

  it('gives a primer endpoint handle drag priority over generic sequence selection', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const primerHandle = {
      id: 1_000_000_000,
      primerId: 'primer-forward',
      start: 100,
      end: 150,
      direction: 'forward' as const,
      overhangLength: 4,
      anchorBp: 150,
    };

    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => x + 140;
    const screenToBoundaryBp = vi.fn().mockReturnValueOnce(161).mockReturnValue(999);
    interaction.screenToBoundaryBp = screenToBoundaryBp;
    interaction.hitTestFn = () => ({ kind: 'primer-handle', payload: primerHandle });
    interaction.hitTestSelectionHandle = () => 'end';
    interaction.onPrimerHandleDragPreview = onPreview;
    interaction.onPrimerHandleDragCommit = onCommit;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 10 }));

    expect(onPreview).toHaveBeenCalledWith(primerHandle, 161);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(primerHandle, 161);
    expect(screenToBoundaryBp).toHaveBeenCalledOnce();
    expect(state.highlightRange).toEqual([100, 150]);

    interaction.cleanup();
  });

  it('reprojects a held primer endpoint after the camera scrolls beneath the pointer', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ viewOffset: 0 });
    const interaction = setupInteraction(canvas, state);
    const onPreview = vi.fn();
    const primerHandle = {
      id: 1_000_000_000,
      primerId: 'primer-forward',
      start: 100,
      end: 150,
      direction: 'forward' as const,
      overhangLength: 4,
      anchorBp: 150,
    };

    interaction.genomeLength = 1000;
    interaction.genomeCircular = true;
    interaction.screenToBp = () => 150;
    interaction.screenToBoundaryBp = (_x, _y, currentState) =>
      currentState.viewOffset === 0 ? 150 : 175;
    interaction.hitTestFn = () => ({ kind: 'primer-handle', payload: primerHandle });
    interaction.onPrimerHandleDragPreview = onPreview;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );
    expect(onPreview).toHaveBeenLastCalledWith(primerHandle, 150);

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 10,
        deltaY: 120,
      })
    );
    interaction.flushInteraction();

    expect(state.viewOffset).not.toBe(0);
    expect(onPreview).toHaveBeenLastCalledWith(primerHandle, 175);

    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 10 }));
    interaction.cleanup();
  });

  it('gives a provenance boundary handle drag priority over generic sequence selection', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const boundaryHandle = {
      regionId: 'middle-pcr',
      side: 'downstream' as const,
      rangeStart: 100,
      rangeEnd: 150,
      boundaryBp: 150,
    };

    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => x + 140;
    interaction.screenToBoundaryBp = (x) => x + 141;
    interaction.hitTestFn = () => ({ kind: 'backbone-boundary-handle', payload: boundaryHandle });
    interaction.hitTestSelectionHandle = vi
      .fn<NonNullable<typeof interaction.hitTestSelectionHandle>>()
      .mockReturnValueOnce(null)
      .mockReturnValue('end');
    interaction.onBackboneBoundaryHandleDragPreview = onPreview;
    interaction.onBackboneBoundaryHandleDragCommit = onCommit;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(canvas.style.cursor).toBe('ew-resize');

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 10 }));

    expect(onPreview).toHaveBeenCalledWith(boundaryHandle, 161);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(boundaryHandle, 161);
    expect(state.highlightRange).toEqual([100, 150]);

    interaction.cleanup();
  });

  it('treats a click on a provenance boundary handle as a position click', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onPositionClick = vi.fn();
    const onCommit = vi.fn();
    const boundaryHandle = {
      regionId: 'middle-pcr',
      side: 'downstream' as const,
      rangeStart: 100,
      rangeEnd: 150,
      boundaryBp: 150,
    };

    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => x + 140;
    interaction.screenToBoundaryBp = (x) => x + 141;
    interaction.hitTestFn = () => ({ kind: 'backbone-boundary-handle', payload: boundaryHandle });
    interaction.onPositionClick = onPositionClick;
    interaction.onBackboneBoundaryHandleDragCommit = onCommit;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onPositionClick).toHaveBeenCalledOnce();
    expect(onPositionClick).toHaveBeenCalledWith(150);
    expect(state.cursorPosition).toBe(150);

    interaction.cleanup();
  });

  it('drags a provenance part only after the pointer crosses the movement threshold', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const part = {
      regionId: 'middle-pcr',
      rangeStart: 100,
      rangeEnd: 200,
    };

    interaction.genomeLength = 1000;
    interaction.screenToBoundaryBp = (x) => x + 100;
    interaction.hitTestFn = () => ({ kind: 'backbone-part', payload: part });
    interaction.hitTestSelectionHandle = () => 'end';
    interaction.onBackbonePartSelect = onSelect;
    interaction.onBackbonePartDragPreview = onPreview;
    interaction.onBackbonePartDragCommit = onCommit;

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 13, clientY: 10 })
    );
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 24, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 24, clientY: 10 }));

    expect(onPreview).toHaveBeenLastCalledWith(part, 124);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(part, 124);
    expect(state.highlightRange).toEqual([100, 150]);

    interaction.cleanup();
  });

  it('selects a provenance part without starting reorder when drag capability is disabled', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const part = {
      regionId: 'middle-pcr',
      rangeStart: 100,
      rangeEnd: 200,
    };

    interaction.genomeLength = 1000;
    interaction.screenToBoundaryBp = (x) => x + 100;
    interaction.hitTestFn = () => ({ kind: 'backbone-part', payload: part });
    interaction.canDragBackbonePart = () => false;
    interaction.onBackbonePartSelect = onSelect;
    interaction.onBackbonePartDragPreview = onPreview;
    interaction.onBackbonePartDragCommit = onCommit;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(canvas.style.cursor).toBe('pointer');
    expect(canvas.title).toBe('Select part');

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 30, clientY: 10 }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(state.highlightRange).toEqual([100, 150]);

    interaction.cleanup();
  });

  it('navigates a scaffold through the normal map navigation callback without selecting synthetic bases', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ highlightRange: [100, 150] });
    const interaction = setupInteraction(canvas, state);
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onSelectionChange = vi.fn();
    const scaffold = {
      regionId: 'empty-promoter',
      rangeStart: 0.06,
      rangeEnd: 0.94,
      isScaffold: true,
      scaffold: {
        slotId: 'promoter',
        slotIndex: 0,
        label: 'Promoter',
        incomingOverhang: 'GGAG',
        outgoingOverhang: 'TACT',
      },
    };

    interaction.genomeLength = 3;
    const onNavigate = vi.fn();
    interaction.onPositionDoubleClick = onNavigate;
    interaction.screenToBp = () => 0.5;
    interaction.screenToBoundaryBp = (x) => x / 10;
    interaction.hitTestFn = () => ({ kind: 'backbone-part', payload: scaffold });
    interaction.onBackbonePartSelect = onSelect;
    interaction.onBackbonePartDragPreview = onPreview;
    interaction.onBackbonePartDragCommit = onCommit;
    interaction.onSelectionChange = onSelectionChange;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(canvas.title).toBe('Promoter · GGAG → TACT');

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })
    );
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 30, clientY: 10 }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(0.5);
    onSelect.mockClear();
    doubleClick(canvas);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(scaffold);
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(state.highlightRange).toEqual([100, 150]);

    interaction.cleanup();
  });

  it('reports the hovered provenance part once per enter, change, and leave', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState();
    const interaction = setupInteraction(canvas, state);
    const onHover = vi.fn();
    const firstPart = {
      regionId: 'part-a',
      rangeStart: 0,
      rangeEnd: 100,
    };
    const secondPart = {
      regionId: 'part-b',
      rangeStart: 100,
      rangeEnd: 220,
    };
    let hitPart = firstPart;

    interaction.genomeLength = 1000;
    interaction.screenToBp = (x) => x;
    interaction.hitTestFn = () => ({ kind: 'backbone-part', payload: hitPart });
    interaction.onBackbonePartHover = onHover;

    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 })
    );
    interaction.flushInteraction();
    interaction.flushInteraction();
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover).toHaveBeenLastCalledWith(firstPart);
    expect(canvas.style.cursor).toBe('pointer');
    expect(canvas.title).toBe('Select part');

    hitPart = secondPart;
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 })
    );
    interaction.flushInteraction();
    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenLastCalledWith(secondPart);

    canvas.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    expect(onHover).toHaveBeenCalledTimes(3);
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(canvas.style.cursor).toBe('');

    interaction.cleanup();
  });

  it('caps oversized wheel bursts without delayed spin backlog', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ viewOffset: 0, zoom: 20 });
    const interaction = setupInteraction(canvas, state);

    wheel(canvas, 40000);
    interaction.flushInteraction();

    const firstStep = state.viewOffset;
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThanOrEqual(0.060001);

    interaction.flushInteraction();

    expect(state.viewOffset).toBe(firstStep);

    interaction.cleanup();
  });

  it('commits the same pan packet stream when frames batch several physical events', () => {
    const makeInteraction = () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const state = makeState({ viewOffset: 0.2, zoom: 20 });
      const interaction = setupInteraction(canvas, state);
      interaction.genomeCircular = false;
      return { canvas, interaction, state };
    };
    const sequential = makeInteraction();
    const batched = makeInteraction();

    for (let packet = 0; packet < 4; packet += 1) {
      wheel(sequential.canvas, 400);
      sequential.interaction.flushInteraction();
      wheel(batched.canvas, 400);
    }
    batched.interaction.flushInteraction();

    expect(batched.state.viewOffset).toBeCloseTo(sequential.state.viewOffset, 12);
    const committedOffset = batched.state.viewOffset;
    batched.interaction.flushInteraction();
    expect(batched.state.viewOffset).toBe(committedOffset);

    sequential.interaction.cleanup();
    batched.interaction.cleanup();
  });

  it('allows a small linear start gutter instead of wrapping toward the end', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ viewOffset: 0.01, zoom: 20 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeCircular = false;

    wheel(canvas, -1200);
    interaction.flushInteraction();

    expect(state.viewOffset).toBeCloseTo(-linearEdgeOverscrollOffset(state.zoom), 5);

    interaction.cleanup();
  });

  it('keeps circular wheel scrolling wrapped at the sequence origin', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ viewOffset: 0.01, zoom: 20 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeCircular = true;

    wheel(canvas, -1200);
    interaction.flushInteraction();

    expect(state.viewOffset).toBeGreaterThan(0.94);

    interaction.cleanup();
  });

  it('caps one oversized zoom event without leaving a delayed spin backlog', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 1 });
    const interaction = setupInteraction(canvas, state);

    wheel(canvas, -300, { ctrlKey: true });
    interaction.flushInteraction();

    const firstZoom = state.zoom;
    expect(firstZoom).toBeGreaterThan(1);
    expect(firstZoom).toBeLessThanOrEqual(1.3);

    interaction.flushInteraction();

    expect(state.zoom).toBe(firstZoom);

    interaction.cleanup();
  });

  it('commits the same zoom packet stream when frames batch several physical events', () => {
    const makeInteraction = () => {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const state = makeState({ performanceMode: 'stability', zoom: 1 });
      const interaction = setupInteraction(canvas, state);
      interaction.genomeLength = 1000;
      return { canvas, interaction, state };
    };
    const sequential = makeInteraction();
    const batched = makeInteraction();

    for (let packet = 0; packet < 4; packet += 1) {
      wheel(sequential.canvas, -8, { ctrlKey: true });
      sequential.interaction.flushInteraction();
      wheel(batched.canvas, -8, { ctrlKey: true });
    }
    batched.interaction.flushInteraction();

    expect(batched.state.zoom).toBeCloseTo(sequential.state.zoom, 12);
    const committedZoom = batched.state.zoom;
    batched.interaction.flushInteraction();
    expect(batched.state.zoom).toBe(committedZoom);

    sequential.interaction.cleanup();
    batched.interaction.cleanup();
  });

  it('uses a renderer-provided zoom-out floor below the default clamp', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 0.55 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;
    interaction.getMinZoom = () => 0.2;

    wheel(canvas, 300, { ctrlKey: true });
    interaction.flushInteraction();

    expect(state.zoom).toBeLessThan(0.5);
    expect(state.zoom).toBeGreaterThanOrEqual(0.2);

    interaction.cleanup();
  });

  it('uses a renderer-provided zoom-out floor above the default clamp', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 1 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;
    interaction.getMinZoom = () => 0.8;

    wheel(canvas, 4000, { ctrlKey: true });
    interaction.flushInteraction();

    expect(state.zoom).toBe(0.8);

    interaction.cleanup();
  });

  it('keeps a short sequence at its physical zoom floor below the indexed minimum', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({
      zoom: 0.0002,
      sequencePresentation: { minSequencePixelsPerBp: 0.016 },
    });
    const interaction = setupInteraction(canvas, state);
    interaction.genomeLength = 10;
    interaction.getMinZoom = () => 0.0002;
    wheel(canvas, 4000, { ctrlKey: true });
    interaction.flushInteraction();
    expect(state.zoom).toBe(0.0002);
    interaction.cleanup();
  });

  it('uses a renderer-provided zoom-in ceiling', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 9 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;
    interaction.getMaxZoom = () => 10;

    wheel(canvas, -300, { ctrlKey: true });
    interaction.flushInteraction();

    expect(state.zoom).toBe(10);

    interaction.cleanup();
  });

  it('uses smaller zoom increments in stability mode', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ performanceMode: 'stability', zoom: 1 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;

    wheel(canvas, -300, { ctrlKey: true });
    interaction.flushInteraction();

    expect(state.zoom).toBeLessThanOrEqual(1.1);
    expect(state.zoom).toBeGreaterThan(1);

    interaction.cleanup();
  });

  it('corrects an already-invalid zoom when the renderer-provided floor rises', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 0.05 });
    const interaction = setupInteraction(canvas, state);

    interaction.genomeLength = 1000;
    interaction.getMinZoom = () => 0.8;

    wheel(canvas, 4000, { ctrlKey: true });
    interaction.flushInteraction();

    expect(state.zoom).toBe(0.8);

    interaction.cleanup();
  });

  it('passes the current pointer position to zoom anchoring', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 1 });
    const interaction = setupInteraction(canvas, state);
    const onBeforeZoom = vi.fn();

    interaction.genomeLength = 1000;
    interaction.onBeforeZoom = onBeforeZoom;

    wheel(canvas, -80, { ctrlKey: true, clientX: 321, clientY: 45 });
    interaction.flushInteraction();

    expect(onBeforeZoom).toHaveBeenCalledOnce();
    expect(onBeforeZoom.mock.calls[0][2]).toBe(321);
    expect(onBeforeZoom.mock.calls[0][3]).toBe(45);

    interaction.cleanup();
  });

  it('zooms without cursor anchoring when the renderer rejects the pointer hitbox', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const state = makeState({ zoom: 1 });
    const interaction = setupInteraction(canvas, state);
    const onBeforeZoom = vi.fn();

    interaction.genomeLength = 1000;
    interaction.onBeforeZoom = onBeforeZoom;
    interaction.shouldZoomToCursor = () => false;

    wheel(canvas, -80, { ctrlKey: true, clientX: 321, clientY: 45 });
    interaction.flushInteraction();

    expect(state.zoom).toBeGreaterThan(1);
    expect(onBeforeZoom).not.toHaveBeenCalled();

    interaction.cleanup();
  });
});

it('ownership revocation ends a captured primer drag without committing a document edit', async () => {
  const { installInputOwnership } = await import('@waypoint/platform/input-ownership');
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  let valid = true;
  let notify: () => void = () => undefined;
  const dispose = installInputOwnership(document, {
    allows: () => valid,
    capture: () => {
      const captured = valid;
      return () => captured && valid;
    },
    subscribe: (listener) => {
      notify = listener;
      return () => undefined;
    },
  });
  const state = makeState();
  const interaction = setupInteraction(canvas, state);
  const commit = vi.fn();
  const cancel = vi.fn();
  interaction.onPrimerHandleDragCommit = commit;
  interaction.onGestureCancel = cancel;
  interaction.hitTestFn = () =>
    ({ kind: 'primer-handle', payload: { id: 1, boundaryBp: 10 } }) as never;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();
  const down = new MouseEvent('pointerdown', { button: 0, clientX: 20, clientY: 20 });
  Object.defineProperty(down, 'pointerId', { value: 7 });
  canvas.dispatchEvent(down);
  expect(interaction.isDragging).toBe(true);
  valid = false;
  notify();
  expect(interaction.isDragging).toBe(false);
  expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
  valid = true;
  canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 50, clientY: 20 }));
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  interaction.cleanup();
  dispose();
  canvas.remove();
});
