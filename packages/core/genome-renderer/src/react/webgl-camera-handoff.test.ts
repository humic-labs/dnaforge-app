import { afterEach, expect, it, vi } from 'vitest';
import { dispatchNativeWheel, installNativeWheelSource } from '@waypoint/platform/wheel-motion';
import { setupInteraction } from '../renderers/pixi/interaction';
import type { RenderState } from '../types';
import { startWebGLRenderLoop } from './webgl-render-loop';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['scroll', 'zoom'] as const)(
  'a pointer cancels unpresented %s without moving away from the submitted camera',
  (kind) => {
    let clock = 0;
    let nextId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextId;
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
    const disposeNativeSource = installNativeWheelSource(document);
    const state: RenderState = {
      morph: 0,
      viewOffset: 0.5,
      zoom: 4,
      width: 800,
      height: 300,
      selectedIds: new Set(),
      hoveredId: null,
      highlightRange: null,
      cursorPosition: null,
      hoveredCutSiteId: null,
      perfPanelVisible: false,
    };
    const interaction = setupInteraction(canvas, state);
    interaction.genomeLength = 1000;
    interaction.genomeCircular = false;
    let presented = { zoom: state.zoom, viewOffset: state.viewOffset };
    const loop = startWebGLRenderLoop({
      instanceId: `native-${kind}-handoff`,
      minimumFrameIntervalMs: () => 13,
      app: { render: vi.fn() },
      renderer: {
        render: () => {
          presented = { zoom: state.zoom, viewOffset: state.viewOffset };
          return false;
        },
      },
      interaction,
      stateRef: { current: state },
      renderRevisionRef: { current: 1 },
      visibleRef: { current: true },
      rafRef: { current: null },
      frameCountRef: { current: 0 },
      lastFrameTRef: { current: 0 },
      presentedFrameListenersRef: { current: new Set() },
      postPresentWorkRef: { current: new Set() },
      isDestroyed: () => false,
      onFatalFrameError: (failure: { message: string }) => {
        throw new Error(failure.message);
      },
    } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);
    const tickAt = (time: number) => {
      clock = time;
      const next = callbacks.entries().next();
      if (next.done) throw new Error('The camera frame owner did not schedule its next tick.');
      const [id, callback] = next.value;
      callbacks.delete(id);
      callback(time);
    };
    try {
      tickAt(0);
      clock = 1;
      dispatchNativeWheel(document, {
        x: 400,
        y: 150,
        deltaX: 0,
        deltaY: kind === 'scroll' ? 120 : -120,
        metaKey: kind === 'zoom',
        ctrlKey: false,
        precise: false,
        phase: 0,
        momentumPhase: 0,
        ordinal: 1,
      });
      tickAt(16);
      const clickedCamera = { ...presented };
      tickAt(24);
      expect({ zoom: state.zoom, viewOffset: state.viewOffset }).toEqual(clickedCamera);
      clock = 25;
      window.dispatchEvent(new Event('pointerdown'));
      expect({ zoom: state.zoom, viewOffset: state.viewOffset }).toEqual(clickedCamera);
      tickAt(32);
      tickAt(250);
      expect(presented).toEqual(clickedCamera);
    } finally {
      loop.stop();
      interaction.cleanup();
      disposeNativeSource();
      canvas.remove();
    }
  }
);
