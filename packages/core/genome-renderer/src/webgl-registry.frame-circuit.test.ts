// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';
import type { RenderState } from './types';
import {
  registerWebGLInstance,
  scheduleWebGLPostPresentWorkForRenderer,
  snapshotWebGLState,
  unregisterWebGLInstance,
  type WebGLFatalFrameCircuitSnapshot,
} from './webgl-registry';

const INSTANCE_ID = 'fatal-frame-circuit-fixture';

afterEach(() => {
  unregisterWebGLInstance(INSTANCE_ID);
  document.body.textContent = '';
});

describe('WebGL post-present work scheduling', () => {
  it('schedules on the one healthy visible mount that owns the exact renderer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const renderer = {};
    const work = vi.fn();
    const schedulePostPresentWork = vi.fn();
    registerWebGLInstance({
      instanceId: INSTANCE_ID,
      createdAt: 100,
      containerRef: { current: container },
      appRef: { current: { destroyed: false } as unknown as Application },
      rendererRef: { current: renderer },
      stateRef: { current: {} as RenderState },
      visibleRef: { current: true },
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 100 },
      fatalFrameCircuitRef: { current: null },
      schedulePostPresentWork,
    });

    const onDropped = vi.fn();
    expect(scheduleWebGLPostPresentWorkForRenderer(renderer, work, onDropped)).toBe('scheduled');
    expect(schedulePostPresentWork).toHaveBeenCalledOnce();
    expect(schedulePostPresentWork).toHaveBeenCalledWith(work, onDropped);
  });

  it('queues work on a connected hidden owner for its visibility-resume frame', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const renderer = {};
    const schedulePostPresentWork = vi.fn();
    registerWebGLInstance({
      instanceId: INSTANCE_ID,
      createdAt: 100,
      containerRef: { current: container },
      appRef: { current: { destroyed: false } as unknown as Application },
      rendererRef: { current: renderer },
      stateRef: { current: {} as RenderState },
      visibleRef: { current: false },
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 100 },
      fatalFrameCircuitRef: { current: null },
      schedulePostPresentWork,
    });

    const work = vi.fn();
    const onDropped = vi.fn();
    expect(scheduleWebGLPostPresentWorkForRenderer(renderer, work, onDropped)).toBe('scheduled');
    expect(schedulePostPresentWork).toHaveBeenCalledWith(work, onDropped);
    expect(scheduleWebGLPostPresentWorkForRenderer({}, vi.fn(), vi.fn())).toBe('not-found');
  });

  it('fails closed when the exact renderer owner is disconnected', () => {
    const container = document.createElement('div');
    const renderer = {};
    const schedulePostPresentWork = vi.fn();
    registerWebGLInstance({
      instanceId: INSTANCE_ID,
      createdAt: 100,
      containerRef: { current: container },
      appRef: { current: { destroyed: false } as unknown as Application },
      rendererRef: { current: renderer },
      stateRef: { current: {} as RenderState },
      visibleRef: { current: false },
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 100 },
      fatalFrameCircuitRef: { current: null },
      schedulePostPresentWork,
    });

    expect(scheduleWebGLPostPresentWorkForRenderer(renderer, vi.fn(), vi.fn())).toBe('inactive');
    expect(schedulePostPresentWork).not.toHaveBeenCalled();
  });

  it('fails closed when more than one healthy mount claims the renderer', () => {
    const firstContainer = document.createElement('div');
    const secondContainer = document.createElement('div');
    document.body.append(firstContainer, secondContainer);
    const renderer = {};
    const firstSchedule = vi.fn();
    const secondSchedule = vi.fn();
    const base = {
      createdAt: 100,
      appRef: { current: { destroyed: false } as unknown as Application },
      rendererRef: { current: renderer },
      stateRef: { current: {} as RenderState },
      visibleRef: { current: true },
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 100 },
      fatalFrameCircuitRef: { current: null },
    };
    registerWebGLInstance({
      ...base,
      instanceId: INSTANCE_ID,
      containerRef: { current: firstContainer },
      schedulePostPresentWork: firstSchedule,
    });
    registerWebGLInstance({
      ...base,
      instanceId: `${INSTANCE_ID}-peer`,
      containerRef: { current: secondContainer },
      schedulePostPresentWork: secondSchedule,
    });

    expect(scheduleWebGLPostPresentWorkForRenderer(renderer, vi.fn(), vi.fn())).toBe('ambiguous');
    expect(firstSchedule).not.toHaveBeenCalled();
    expect(secondSchedule).not.toHaveBeenCalled();
    unregisterWebGLInstance(`${INSTANCE_ID}-peer`);
  });
});

describe('WebGL fatal frame circuit diagnostics', () => {
  it('reports the exact failure-time state while the last-good canvas remains alive', () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 500;
    container.appendChild(canvas);
    document.body.appendChild(container);
    const frameCircuit = Object.freeze<WebGLFatalFrameCircuitSnapshot>({
      status: 'open',
      instance: INSTANCE_ID,
      phase: 'render',
      name: 'Error',
      message: 'deterministic annotation frame failure',
      stack: 'fixture-stack',
      consecutiveFrameErrors: 3,
      frameCount: 41,
      renderRevision: 17,
      zoom: 12,
      viewOffset: 0.25,
      width: 800,
      height: 500,
      openedAt: 123.5,
    });
    registerWebGLInstance({
      instanceId: INSTANCE_ID,
      createdAt: 100,
      containerRef: { current: container },
      appRef: {
        current: {
          canvas,
          destroyed: false,
          ticker: { started: false },
          renderer: { resolution: 1 },
          stage: { children: [] },
        } as unknown as Application,
      },
      rendererRef: { current: null },
      stateRef: {
        current: {
          zoom: 99,
          viewOffset: 0.9,
          width: 1,
          height: 1,
          morph: 0,
          hoveredId: null,
          selectedIds: new Set(),
          proteinSearchHighlightRanges: [
            [1_813_907_980, 1_813_908_000],
            [1_813_907_834, 1_813_907_850],
          ],
        } as unknown as RenderState,
      },
      visibleRef: { current: true },
      genomeRef: { current: null },
      frameCountRef: { current: 41 },
      lastFrameTRef: { current: 120 },
      fatalFrameCircuitRef: { current: frameCircuit },
    });

    const snapshot = snapshotWebGLState();

    expect(snapshot.instanceCount).toBe(1);
    expect(snapshot.instances[0]).toMatchObject({
      instanceId: INSTANCE_ID,
      frameCircuit,
      container: { connected: true, childCanvases: 1 },
      app: {
        alive: true,
        destroyed: false,
        canvasEl: { widthAttr: 800, heightAttr: 500 },
      },
      state: {
        proteinSearchHighlightRanges: [
          [1_813_907_980, 1_813_908_000],
          [1_813_907_834, 1_813_907_850],
        ],
      },
    });
    expect(snapshot.instances[0]?.frameCircuit).toMatchObject({
      zoom: 12,
      viewOffset: 0.25,
      width: 800,
      height: 500,
    });
  });
});
