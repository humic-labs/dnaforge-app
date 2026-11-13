import type { PixiPresentedFrame } from './types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Genome, RenderState } from '@waypoint/genome-renderer';
import { startWebGLRenderLoop } from './webgl-render-loop';
import {
  minimumFrameIntervalForWebGLState,
  slowFrameCooldownMs,
  webglRenderStateSignature,
} from './webgl-render-policy';

function state(overrides: Partial<RenderState> = {}): RenderState {
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
    ...overrides,
  };
}

describe('WebGL render loop policy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps identical state signatures stable until invalidated', () => {
    const s = state();

    expect(webglRenderStateSignature(s, 1)).toBe(webglRenderStateSignature(s, 1));
    expect(webglRenderStateSignature(s, 2)).not.toBe(webglRenderStateSignature(s, 1));
  });

  it('invalidates when viewport brackets are hidden without changing the tracked range', () => {
    const visible = state({ viewportRange: [20, 100], viewportIndicatorVisible: true });
    expect(webglRenderStateSignature({ ...visible, viewportIndicatorVisible: false }, 1)).not.toBe(
      webglRenderStateSignature(visible, 1)
    );
  });

  it('detects a small read-level pan on the full human assembly', () => {
    const fullAssemblyBp = 3_088_269_832;
    const visibleBp = 2_567;
    const zoom = fullAssemblyBp / visibleBp;
    const base = state({ zoom, viewOffset: 0.25 });
    const thirtyBpPan = state({
      zoom,
      viewOffset: base.viewOffset + 30 / fullAssemblyBp,
    });

    expect(webglRenderStateSignature(thirtyBpPan, 1)).not.toBe(webglRenderStateSignature(base, 1));
  });

  it('treats hover, selection, and codon overlays as render-visible changes', () => {
    const base = webglRenderStateSignature(state(), 1);

    expect(webglRenderStateSignature(state({ hoverPosition: 123 }), 1)).not.toBe(base);
    expect(webglRenderStateSignature(state({ selectedIds: new Set([7]) }), 1)).not.toBe(base);
    expect(
      webglRenderStateSignature(state({ hoveredCodon: { start: 300, end: 302, strand: -1 } }), 1)
    ).not.toBe(base);
  });

  it('treats annotation search focus changes as render-visible without broad invalidation', () => {
    const base = webglRenderStateSignature(state(), 1);
    const focused = webglRenderStateSignature(
      state({
        annotationSearchFocus: {
          trackId: 'mRNA',
          canonicalIdentity: 'canonical-TX1',
        },
      }),
      1
    );

    expect(focused).not.toBe(base);
    expect(
      webglRenderStateSignature(
        state({
          annotationSearchFocus: {
            trackId: 'mRNA',
            canonicalIdentity: 'canonical-TX2',
          },
        }),
        1
      )
    ).not.toBe(focused);
    expect(
      webglRenderStateSignature(
        state({
          annotationSearchFocus: {
            trackId: 'lnc_RNA',
            canonicalIdentity: 'canonical-TX1',
          },
        }),
        1
      )
    ).not.toBe(focused);
    expect(
      webglRenderStateSignature(
        state({
          annotationSearchFocus: {
            trackId: 'mRNA',
            canonicalIdentity: 'canonical-TX1',
            presentation: 'temporary-additional-lane',
          },
        }),
        1
      )
    ).not.toBe(focused);
  });

  it('keys a transient annotation focus carrier by exact track, identity, and span', () => {
    const feature = {
      id: 17,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      start: 100,
      end: 200,
      direction: 'forward' as const,
      displayName: 'TX1',
      color: 0x8b5cf6,
      lane: 0,
      canonicalIdentity: 'canonical-TX1',
    };
    const base = webglRenderStateSignature(state(), 1);
    const carried = webglRenderStateSignature(state({ annotationSearchFocusFeature: feature }), 1);

    expect(carried).not.toBe(base);
    expect(
      webglRenderStateSignature(
        state({
          annotationSearchFocusFeature: {
            ...feature,
            canonicalIdentity: 'canonical-TX2',
          },
        }),
        1
      )
    ).not.toBe(carried);
    expect(
      webglRenderStateSignature(
        state({
          annotationSearchFocusFeature: {
            ...feature,
            annotationTrackId: 'lnc_RNA',
          },
        }),
        1
      )
    ).not.toBe(carried);
    expect(
      webglRenderStateSignature(
        state({
          annotationSearchFocusFeature: {
            ...feature,
            end: 201,
          },
        }),
        1
      )
    ).not.toBe(carried);
  });

  it('caps redraw cadence in stability mode only', () => {
    expect(minimumFrameIntervalForWebGLState(state())).toBe(0);
    expect(minimumFrameIntervalForWebGLState(state({ performanceMode: 'stability' }))).toBe(100);
  });

  it('flushes every 120 Hz input callback but draws the latest indexed camera at 60 Hz', () => {
    let clockMs = 0;
    let nextRafId = 0;
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
    const currentState = state();
    const drawnZooms: number[] = [];
    const flushInteraction = vi.fn();
    const loop = startWebGLRenderLoop({
      instanceId: 'indexed-frame-pacing-fixture',
      minimumFrameIntervalMs: () => 13,
      app: { render: vi.fn() },
      renderer: {
        render: () => {
          drawnZooms.push(currentState.zoom);
          return false;
        },
      },
      interaction: { flushInteraction },
      stateRef: { current: currentState },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef: { current: new Set() },
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);
    const tickAt = (time: number, zoom: number) => {
      clockMs = time;
      currentState.zoom = zoom;
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id);
      callback(time);
    };

    tickAt(0, 1);
    tickAt(8.333, 2);
    tickAt(15.2, 3);

    expect(flushInteraction).toHaveBeenCalledTimes(3);
    expect(drawnZooms).toEqual([1, 3]);
    loop.stop();
  });

  it('adds bounded cooldown after expensive frames in stability mode only', () => {
    expect(slowFrameCooldownMs(state(), 120)).toBe(0);
    expect(slowFrameCooldownMs(state({ performanceMode: 'stability' }), 40)).toBe(0);
    expect(slowFrameCooldownMs(state({ performanceMode: 'stability' }), 120)).toBeGreaterThan(0);
    expect(slowFrameCooldownMs(state({ performanceMode: 'stability' }), 10_000)).toBe(250);
  });

  it.each([true, false])(
    'runs one scheduled post-present unit only after Pixi presents the frame with committed content %s',
    (committed) => {
      const genome: Genome = {
        name: 'presented-model',
        length: 123,
        circular: false,
        features: [],
        sequence: 'ATG'.repeat(40) + 'TAA',
      };
      const order: string[] = [];
      let nextRafId = 0;
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn(() => ++nextRafId)
      );
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
      let clockMs = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clockMs++);
      const postPresentWorkRef = {
        current: new Set<(deadlineMs: number) => void>(),
      };
      const presentedFrameListenersRef = {
        current: new Set<(receipt: PixiPresentedFrame) => void>(),
      };
      presentedFrameListenersRef.current.add((receipt) => {
        expect(receipt.frameEpoch).toBe(1);
        expect(receipt.presentedAtMs).toBeGreaterThan(0);
        if (committed) {
          expect(receipt.content?.genome).toBe(genome);
          expect(receipt.content?.orfsDrawn).toBe(true);
        } else expect(receipt.content).toBeUndefined();
        order.push('presented-frame-sync');
      });
      postPresentWorkRef.current.add((deadlineMs: number) => {
        expect(postPresentWorkRef.current.size).toBe(0);
        expect(deadlineMs).toBeGreaterThan(clockMs);
        order.push('post-present');
      });
      const rafRef = { current: null as number | null };
      const loop = startWebGLRenderLoop({
        instanceId: 'fixture',
        app: {
          render: () => order.push('pixi-present'),
          renderer: { gl: { flush: () => order.push('gpu-submit') } },
        },
        renderer: { render: () => order.push('renderer'), hasDrawnOrfs: () => true },
        getPresentedGenome: () => (committed ? genome : null),
        interaction: { flushInteraction: () => order.push('interaction') },
        stateRef: { current: state() },
        renderRevisionRef: { current: 1 },
        visibleRef: { current: true },
        rafRef,
        frameCountRef: { current: 0 },
        lastFrameTRef: { current: 0 },
        presentedFrameListenersRef,
        postPresentWorkRef,
        isDestroyed: () => false,
        onFatalFrameError: vi.fn(),
      } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

      loop.renderNow();

      expect(order).toEqual([
        'interaction',
        'renderer',
        'pixi-present',
        'gpu-submit',
        'presented-frame-sync',
        'post-present',
      ]);
      expect(postPresentWorkRef.current.size).toBe(0);
      loop.stop();
    }
  );

  it('drains distinct cheap post-present producers within the same frame budget', () => {
    let nextRafId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => ++nextRafId)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let clockMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs++);
    const first = vi.fn();
    const second = vi.fn();
    const postPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([first, second]),
    };
    const loop = startWebGLRenderLoop({
      instanceId: 'work-conserving-post-present-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef,
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    loop.renderNow();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(postPresentWorkRef.current.size).toBe(0);
    loop.stop();
  });

  it('runs replacement-critical work before queued background loaders', () => {
    let nextRafId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => ++nextRafId)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let clockMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs++);
    const order: string[] = [];
    const postPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([
        () => order.push('background-first'),
        () => order.push('background-second'),
      ]),
    };
    const criticalPostPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([() => order.push('replacement-critical')]),
    };
    const loop = startWebGLRenderLoop({
      instanceId: 'critical-post-present-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      criticalPostPresentWorkRef,
      postPresentWorkRef,
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    loop.renderNow();

    expect(order).toEqual(['replacement-critical', 'background-first', 'background-second']);
    expect(criticalPostPresentWorkRef.current.size).toBe(0);
    expect(postPresentWorkRef.current.size).toBe(0);
    loop.stop();
  });

  it('leaves compositor headroom after post-present work at 120 Hz', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const frameStartedAtMs = 100;
    vi.spyOn(performance, 'now').mockReturnValue(frameStartedAtMs);
    let producerDeadlineMs: number | null = null;
    const loop = startWebGLRenderLoop({
      instanceId: '120hz-post-present-budget-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef: {
        current: new Set<(deadlineMs: number) => void>([
          (deadlineMs) => {
            producerDeadlineMs = deadlineMs;
          },
        ]),
      },
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    loop.renderNow();

    expect(producerDeadlineMs).toBe(frameStartedAtMs + 6);
    loop.stop();
  });

  it('repays regular work after a self-requeued critical slice consumes the frame', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let clockMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    const order: string[] = [];
    const criticalPostPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>(),
    };
    const criticalWork = (): void => {
      order.push('critical');
      clockMs += 100;
      criticalPostPresentWorkRef.current.add(criticalWork);
    };
    criticalPostPresentWorkRef.current.add(criticalWork);
    const postPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([() => order.push('regular')]),
    };
    const loop = startWebGLRenderLoop({
      instanceId: 'critical-fairness-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      criticalPostPresentWorkRef,
      postPresentWorkRef,
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    loop.renderNow();
    expect(order).toEqual(['critical']);
    expect(postPresentWorkRef.current.size).toBe(1);

    loop.renderNow();
    expect(order).toEqual(['critical', 'regular', 'critical']);
    expect(postPresentWorkRef.current.size).toBe(0);
    expect(criticalPostPresentWorkRef.current.size).toBe(1);
    loop.stop();
  });

  it('retains hidden critical work and drains it on visibility resume', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const order: string[] = [];
    let nextRafId = 0;
    const pendingRaf = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextRafId;
        pendingRaf.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => pendingRaf.delete(id))
    );
    const visibleRef = { current: false };
    const criticalPostPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([() => order.push('replacement-critical')]),
    };
    const loop = startWebGLRenderLoop({
      instanceId: 'hidden-critical-post-present-fixture',
      app: {
        render: () => order.push('pixi-present'),
        renderer: { gl: { flush: () => order.push('gpu-submit') } },
      },
      renderer: { render: () => order.push('renderer') },
      interaction: { flushInteraction: () => order.push('interaction') },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef,
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      criticalPostPresentWorkRef,
      postPresentWorkRef: { current: new Set() },
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    expect(pendingRaf.size).toBe(0);
    expect(criticalPostPresentWorkRef.current.size).toBe(1);
    visibleRef.current = true;
    loop.resume();
    const resumed = pendingRaf.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(resumed).toBeDefined();
    pendingRaf.delete(resumed![0]);
    resumed![1](performance.now());

    expect(order).toEqual([
      'interaction',
      'renderer',
      'pixi-present',
      'gpu-submit',
      'replacement-critical',
    ]);
    expect(criticalPostPresentWorkRef.current.size).toBe(0);
    loop.stop();
  });

  it('reserves the next animation frame before running post-present work', () => {
    const order: string[] = [];
    let nextRafId = 0;
    const pendingRaf = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        order.push('raf-request');
        const id = ++nextRafId;
        pendingRaf.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => pendingRaf.delete(id))
    );
    const postPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([() => order.push('post-present-work')]),
    };
    const loop = startWebGLRenderLoop({
      instanceId: 'next-frame-reservation-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef,
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    const current = pendingRaf.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(current).toBeDefined();
    pendingRaf.delete(current![0]);
    current![1](performance.now());

    expect(order).toEqual(['raf-request', 'raf-request', 'post-present-work']);
    loop.stop();
  });

  it('replaces a stale rAF ticket and drains work that reschedules itself', () => {
    let nextRafId = 0;
    const pendingRaf = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextRafId;
        pendingRaf.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        pendingRaf.delete(id);
      })
    );
    const renderRevisionRef = { current: 1 };
    const postPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>(),
    };
    const rafRef = { current: null as number | null };
    let runCount = 0;
    const work = () => {
      runCount += 1;
      if (runCount < 2) {
        postPresentWorkRef.current.add(work);
        renderRevisionRef.current += 1;
        loop.wake();
      }
    };
    postPresentWorkRef.current.add(work);
    const loop = startWebGLRenderLoop({
      instanceId: 'stale-raf-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef,
      visibleRef: { current: true },
      rafRef,
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef,
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    const staleRafId = rafRef.current!;
    pendingRaf.delete(staleRafId);
    expect(rafRef.current).toBe(staleRafId);

    loop.wake();
    expect(rafRef.current).not.toBe(staleRafId);
    expect(pendingRaf.size).toBe(1);

    const runNextFrame = () => {
      const next = pendingRaf.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      pendingRaf.delete(next![0]);
      next![1](performance.now());
    };
    runNextFrame();
    expect(runCount).toBe(1);
    expect(postPresentWorkRef.current.size).toBe(1);
    expect(pendingRaf.size).toBe(1);

    runNextFrame();
    expect(runCount).toBe(2);
    expect(postPresentWorkRef.current.size).toBe(0);
    loop.stop();
  });

  it('recovers a discarded rAF autonomously while authoritative post-present work remains', () => {
    vi.useFakeTimers();
    let nextRafId = 0;
    const pendingRaf = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextRafId;
        pendingRaf.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        pendingRaf.delete(id);
      })
    );
    const work = vi.fn();
    const postPresentWorkRef = {
      current: new Set<(deadlineMs: number) => void>([work]),
    };
    const rafRef = { current: null as number | null };
    const loop = startWebGLRenderLoop({
      instanceId: 'autonomous-stale-raf-fixture',
      app: { render: vi.fn() },
      renderer: { render: vi.fn() },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef,
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef,
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    const discardedRafId = rafRef.current!;
    pendingRaf.delete(discardedRafId);
    vi.advanceTimersByTime(101);

    expect(rafRef.current).not.toBe(discardedRafId);
    const recovered = pendingRaf.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(recovered).toBeDefined();
    pendingRaf.delete(recovered![0]);
    recovered![1](performance.now());
    expect(work).toHaveBeenCalledTimes(1);
    expect(postPresentWorkRef.current.size).toBe(0);
    loop.stop();
  });

  it('finishes a multi-frame pileup handoff when Chromium repeatedly discards continuation frames', () => {
    vi.useFakeTimers();
    let nextRafId = 0;
    const pendingRaf = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextRafId;
        pendingRaf.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        pendingRaf.delete(id);
      })
    );

    const stages = [
      'assign-1',
      'assign-2',
      'assign-3',
      'mesh-1',
      'mesh-2',
      'mesh-3',
      'morph-1',
      'morph-2',
      'reads',
    ];
    const completed: string[] = [];
    const render = vi.fn(() => {
      completed.push(stages[completed.length]!);
      return completed.length < stages.length;
    });
    const rafRef = { current: null as number | null };
    const loop = startWebGLRenderLoop({
      instanceId: 'pileup-handoff-discarded-continuation-fixture',
      app: { render: vi.fn() },
      renderer: { render },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef,
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef: { current: new Set() },
      isDestroyed: () => false,
      onFatalFrameError: vi.fn(),
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    const runNextFrame = () => {
      const next = pendingRaf.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      pendingRaf.delete(next![0]);
      next![1](performance.now());
    };

    runNextFrame();
    while (completed.length < stages.length) {
      const discardedRafId = rafRef.current!;
      pendingRaf.delete(discardedRafId);
      vi.advanceTimersByTime(101);
      expect(rafRef.current).not.toBe(discardedRafId);
      runNextFrame();
    }

    expect(completed).toEqual(stages);
    expect(render).toHaveBeenCalledTimes(stages.length);
    loop.stop();
  });

  it('opens one terminal circuit after three frame errors and cannot be resumed blindly', () => {
    let nextRafId = 0;
    const pendingRaf = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextRafId;
        pendingRaf.set(id, callback);
        return id;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        pendingRaf.delete(id);
      })
    );
    const fatal = vi.fn();
    const render = vi.fn(() => {
      throw new Error('deterministic annotation frame failure');
    });
    const loop = startWebGLRenderLoop({
      instanceId: 'failing-fixture',
      app: { render: vi.fn() },
      renderer: { render },
      interaction: { flushInteraction: vi.fn() },
      stateRef: { current: state() },
      renderRevisionRef: { current: 9 },
      visibleRef: { current: true },
      rafRef: { current: null as number | null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef: { current: new Set() },
      isDestroyed: () => false,
      onFatalFrameError: fatal,
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

    const runNextFrame = () => {
      const next = pendingRaf.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(next).toBeDefined();
      pendingRaf.delete(next![0]);
      next![1](performance.now());
    };
    runNextFrame();
    runNextFrame();
    runNextFrame();

    expect(render).toHaveBeenCalledTimes(3);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'render',
        message: 'deterministic annotation frame failure',
        consecutiveFrameErrors: 3,
      })
    );
    expect(pendingRaf.size).toBe(0);

    loop.renderNow();
    loop.resume();
    loop.renderNow();
    loop.resume();

    expect(render).toHaveBeenCalledTimes(3);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(pendingRaf.size).toBe(0);
  });
});
