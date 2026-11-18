import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderState } from '@waypoint/genome-renderer';
import { startWebGLRenderLoop, type WebGLRenderLoop } from './webgl-render-loop';
import type { PixiPresentedFrame } from './types';
import type { WebGLFrameProbeWindow } from './webgl-frame-probe';

type PresentationPath = 'raf' | 'renderNow';

function state(): RenderState {
  return {
    performanceMode: 'default',
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 220,
    geometryHeight: 220,
    themeMode: 'light',
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    digestFocusRange: null,
    residueLinkRange: null,
    cursorPosition: null,
    hoverPosition: null,
    hoveredCodon: null,
    selectedCodons: [],
    hoveredOrf: null,
    selectedOrf: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    showResidueNumbers: false,
  };
}

const loops: WebGLRenderLoop[] = [];

function harness(options: { withoutReadinessHook?: boolean; continuations?: number } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let clockMs = 0;
  let nextRafId = 0;
  let requestedGeneration = 1;
  let preparedGeneration = 0;
  let renderedGeneration: number | null = null;
  let continuations = options.continuations ?? 0;
  let nextRenderWork: (() => void) | null = null;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextRafId;
      callbacks.set(id, callback);
      return id;
    })
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => callbacks.delete(id))
  );
  const probeWindow = window as WebGLFrameProbeWindow;
  probeWindow.__webglFrameProbeEnabled = true;
  probeWindow.__webglFrameProbe = [];
  const currentState = state();
  const frameCountRef = { current: 0 };
  const lastFrameTRef = { current: 0 };
  const order: string[] = [];
  let presentedZoom: number | null = null;
  const flushInteraction = vi.fn(() => order.push('interaction'));
  const render = vi.fn(() => {
    order.push('renderer');
    renderedGeneration = requestedGeneration;
    const work = nextRenderWork;
    nextRenderWork = null;
    work?.();
    return continuations-- > 0;
  });
  const isCurrentPresentationComplete = vi.fn(() => {
    order.push('readiness');
    return renderedGeneration === preparedGeneration;
  });
  const pixiRender = vi.fn(() => order.push('pixi'));
  const gpuFlush = vi.fn(() => order.push('gpu-submit'));
  const commitPresentedCamera = vi.fn(() => {
    order.push('camera-commit');
    presentedZoom = currentState.zoom;
  });
  const completePresentedFrame = vi.fn(() => order.push('resource-release'));
  const notifyPresentedFrame = vi.fn((_receipt: PixiPresentedFrame) => order.push('receipt'));
  const criticalWork = vi.fn(() => order.push('critical-work'));
  const regularWork = vi.fn(() => order.push('regular-work'));
  const criticalPostPresentWorkRef = { current: new Set<(deadlineMs: number) => void>() };
  const postPresentWorkRef = { current: new Set<(deadlineMs: number) => void>() };
  const onFatalFrameError = vi.fn();
  const loop = startWebGLRenderLoop({
    instanceId: 'presentation-readiness-fixture',
    app: { render: pixiRender, renderer: { gl: { flush: gpuFlush } } },
    renderer: {
      render,
      completePresentedFrame,
      ...(options.withoutReadinessHook ? {} : { isCurrentPresentationComplete }),
    },
    interaction: { flushInteraction, commitPresentedCamera },
    stateRef: { current: currentState },
    renderRevisionRef: { current: 1 },
    visibleRef: { current: true },
    rafRef: { current: null as number | null },
    frameCountRef,
    lastFrameTRef,
    presentedFrameListenersRef: { current: new Set([notifyPresentedFrame]) },
    criticalPostPresentWorkRef,
    postPresentWorkRef,
    isDestroyed: () => false,
    onFatalFrameError,
  } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);
  loops.push(loop);

  function rafAt(time: number) {
    clockMs = time;
    const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(next).toBeDefined();
    callbacks.delete(next![0]);
    next![1](time);
    expect(onFatalFrameError).not.toHaveBeenCalled();
  }

  return {
    loop,
    state: currentState,
    order,
    render,
    isCurrentPresentationComplete,
    pixiRender,
    gpuFlush,
    commitPresentedCamera,
    completePresentedFrame,
    notifyPresentedFrame,
    criticalWork,
    regularWork,
    criticalPostPresentWorkRef,
    postPresentWorkRef,
    frameCountRef,
    lastFrameTRef,
    probes: () => probeWindow.__webglFrameProbe ?? [],
    presentedZoom: () => presentedZoom,
    setPreparedGeneration(value: number) {
      preparedGeneration = value;
    },
    setRequestedGeneration(value: number) {
      requestedGeneration = value;
    },
    onNextRender(work: () => void) {
      nextRenderWork = work;
    },
    rafAt,
    presentAt(path: PresentationPath, time: number) {
      if (path === 'raf') rafAt(time);
      else {
        clockMs = time;
        loop.renderNow();
        expect(onFatalFrameError).not.toHaveBeenCalled();
      }
    },
  };
}

afterEach(() => {
  for (const loop of loops.splice(0)) loop.stop();
  const probeWindow = window as WebGLFrameProbeWindow;
  delete probeWindow.__webglFrameProbeEnabled;
  delete probeWindow.__webglFrameProbe;
  delete probeWindow.__webglFrameProbeClear;
  delete probeWindow.__webglFrameProbeEntries;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebGL presentation readiness', () => {
  it.each(['raf', 'renderNow'] as const)(
    'withholds presentation and all acknowledgements while %s preparation is pending',
    (path) => {
      const h = harness();
      h.criticalPostPresentWorkRef.current.add(h.criticalWork);
      h.postPresentWorkRef.current.add(h.regularWork);
      h.presentAt(path, 20);

      expect(h.render).toHaveBeenCalledOnce();
      expect(h.pixiRender).not.toHaveBeenCalled();
      expect(h.gpuFlush).not.toHaveBeenCalled();
      expect(h.commitPresentedCamera).not.toHaveBeenCalled();
      expect(h.completePresentedFrame).not.toHaveBeenCalled();
      expect(h.notifyPresentedFrame).not.toHaveBeenCalled();
      expect(h.frameCountRef.current).toBe(0);
      expect(h.lastFrameTRef.current).toBe(0);
      expect(h.probes()).toEqual([]);
      expect(h.criticalWork).not.toHaveBeenCalled();
      expect(h.regularWork).not.toHaveBeenCalled();
      expect(h.criticalPostPresentWorkRef.current.size).toBe(1);
      expect(h.postPresentWorkRef.current.size).toBe(1);
      expect(h.isCurrentPresentationComplete).toHaveBeenCalledOnce();
    }
  );

  it.each(['raf', 'renderNow'] as const)(
    'retries the identical %s signature and presents it once its generation is ready',
    (path) => {
      const h = harness();
      h.presentAt(path, 20);
      h.presentAt(path, 30);
      h.setPreparedGeneration(1);
      h.presentAt(path, 40);
      h.rafAt(50);

      expect(h.render).toHaveBeenCalledTimes(3);
      expect(h.pixiRender).toHaveBeenCalledOnce();
      expect(h.gpuFlush).toHaveBeenCalledOnce();
      expect(h.commitPresentedCamera).toHaveBeenCalledOnce();
      expect(h.completePresentedFrame).toHaveBeenCalledOnce();
      expect(h.notifyPresentedFrame).toHaveBeenCalledOnce();
      expect(h.notifyPresentedFrame).toHaveBeenCalledWith({ frameEpoch: 1, presentedAtMs: 40 });
      expect(h.frameCountRef.current).toBe(1);
      expect(h.lastFrameTRef.current).toBe(40);
      expect(h.order.filter((step) => step !== 'interaction').slice(-7)).toEqual([
        'renderer',
        'readiness',
        'pixi',
        'gpu-submit',
        'camera-commit',
        'resource-release',
        'receipt',
      ]);
      expect(h.probes()).toHaveLength(1);
    }
  );

  it('checks completeness after render can invalidate the previously prepared presentation', () => {
    const h = harness();
    h.setPreparedGeneration(1);
    h.onNextRender(() => h.setPreparedGeneration(0));
    h.rafAt(10);
    expect(h.pixiRender).not.toHaveBeenCalled();
    expect(h.order).toEqual(['interaction', 'renderer', 'readiness']);
  });

  it('keeps a replacement pending when preparation belongs to an older generation', () => {
    const h = harness();
    h.setPreparedGeneration(1);
    h.rafAt(10);
    expect(h.presentedZoom()).toBe(1);

    h.state.zoom = 2;
    h.setRequestedGeneration(2);
    h.rafAt(20);
    h.state.zoom = 3;
    h.setRequestedGeneration(3);
    h.setPreparedGeneration(2);
    h.rafAt(30);
    expect(h.frameCountRef.current).toBe(1);
    expect(h.presentedZoom()).toBe(1);
    expect(h.notifyPresentedFrame).toHaveBeenCalledOnce();

    h.setPreparedGeneration(3);
    h.rafAt(40);
    expect(h.frameCountRef.current).toBe(2);
    expect(h.presentedZoom()).toBe(3);
    expect(h.probes().map((sample) => sample.zoom)).toEqual([1, 3]);
  });

  it('includes the entire pending interval in the next real presentation gap after wake', () => {
    const h = harness();
    h.setPreparedGeneration(1);
    h.rafAt(10);
    h.state.zoom = 2;
    h.setRequestedGeneration(2);
    h.rafAt(20);
    h.rafAt(40);
    expect(h.lastFrameTRef.current).toBe(10);

    h.setPreparedGeneration(2);
    h.loop.wake();
    h.rafAt(100);
    expect(h.frameCountRef.current).toBe(2);
    expect(h.probes().map((sample) => [sample.frame, sample.sinceLast])).toEqual([
      [1, 10],
      [2, 90],
    ]);
    expect(h.lastFrameTRef.current).toBe(100);
  });

  it('preserves immediate presentation for renderers without the optional hook', () => {
    const h = harness({ withoutReadinessHook: true });
    h.rafAt(10);
    h.rafAt(20);
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.pixiRender).toHaveBeenCalledOnce();
    expect(h.frameCountRef.current).toBe(1);
    expect(h.notifyPresentedFrame).toHaveBeenCalledOnce();
    expect(h.isCurrentPresentationComplete).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves render-true continuation presentation with the readiness hook absent: %s',
    (withoutReadinessHook) => {
      const h = harness({ withoutReadinessHook, continuations: 2 });
      h.setPreparedGeneration(1);
      h.rafAt(10);
      h.rafAt(20);
      h.rafAt(30);
      h.rafAt(40);
      expect(h.render).toHaveBeenCalledTimes(3);
      expect(h.pixiRender).toHaveBeenCalledTimes(3);
      expect(h.gpuFlush).toHaveBeenCalledTimes(3);
      expect(h.frameCountRef.current).toBe(3);
      expect(h.notifyPresentedFrame.mock.calls.map(([receipt]) => receipt.frameEpoch)).toEqual([
        1, 2, 3,
      ]);
      expect(h.probes()).toHaveLength(3);
    }
  );
});
