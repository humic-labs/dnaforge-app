// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';

const lifecycle = vi.hoisted(() => ({
  globalRelease: vi.fn(),
  clearMeasurementCache: vi.fn(),
}));

vi.mock('pixi.js', () => ({
  CanvasTextMetrics: {
    clearMeasurementCache: lifecycle.clearMeasurementCache,
  },
  GlobalResourceRegistry: {
    release: lifecycle.globalRelease,
  },
}));

import {
  PIXI_APPLICATION_RETENTION_MS,
  acquireRetainedPixiApplication,
  destroyPixiApplication,
  disposeRetainedPixiApplications,
  registerPixiApplication,
  retainPixiApplication,
  type PixiApplicationProfile,
} from './pixi-application-retention';

const DEFAULT_PROFILE: PixiApplicationProfile = {
  antialias: true,
  resolution: 1,
  preserveDrawingBuffer: false,
};

function createApplication(stageChildren: object[] = []) {
  const setTargetElement = vi.fn();
  const destroy = vi.fn();
  const eventPool = new Map<unknown, unknown[]>();
  const rootPointerEvent = {
    nativeEvent: null as object | null,
    srcElement: null as object | null,
  };
  const rootWheelEvent = {
    nativeEvent: null as object | null,
    srcElement: null as object | null,
  };
  const application = {
    canvas: document.createElement('canvas'),
    stage: { children: stageChildren, destroyed: false },
    ticker: { stop: vi.fn() },
    renderer: {
      events: {
        setTargetElement,
        rootBoundary: { eventPool },
        _rootPointerEvent: rootPointerEvent,
        _rootWheelEvent: rootWheelEvent,
      },
    },
    destroy,
  } as unknown as Application;
  return {
    application,
    destroy,
    eventPool,
    rootPointerEvent,
    rootWheelEvent,
    setTargetElement,
  };
}

describe('Pixi application retention', () => {
  beforeEach(() => {
    disposeRetainedPixiApplications();
    lifecycle.globalRelease.mockClear();
    lifecycle.clearMeasurementCache.mockClear();
  });

  afterEach(() => {
    disposeRetainedPixiApplications();
    vi.useRealTimers();
  });

  it('parks and reacquires the same initialized empty-stage application', () => {
    const { application, destroy, eventPool, rootPointerEvent, rootWheelEvent, setTargetElement } =
      createApplication();
    const detachedCanvas = document.createElement('canvas');
    const pooledEvent = { nativeEvent: { target: detachedCanvas } };
    eventPool.set('FederatedPointerEvent', [pooledEvent]);
    rootPointerEvent.nativeEvent = { target: detachedCanvas };
    rootPointerEvent.srcElement = detachedCanvas;
    rootWheelEvent.nativeEvent = { target: detachedCanvas };
    rootWheelEvent.srcElement = detachedCanvas;
    registerPixiApplication(application);

    expect(retainPixiApplication(application, DEFAULT_PROFILE)).toBe(true);
    expect(setTargetElement).toHaveBeenCalledWith(null);
    expect(eventPool.size).toBe(0);
    expect(rootPointerEvent).toMatchObject({ nativeEvent: null, srcElement: null });
    expect(rootWheelEvent).toMatchObject({ nativeEvent: null, srcElement: null });
    expect(lifecycle.clearMeasurementCache).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();

    expect(acquireRetainedPixiApplication(DEFAULT_PROFILE)).toBe(application);
    expect(destroy).not.toHaveBeenCalled();
    destroyPixiApplication(application);
  });

  it('fails closed when renderer teardown leaves a stage owner behind', () => {
    const residualOwner = { destroyed: false, destroy: vi.fn() };
    const { application, destroy } = createApplication([residualOwner]);
    registerPixiApplication(application);

    expect(retainPixiApplication(application, DEFAULT_PROFILE)).toBe(false);
    destroyPixiApplication(application);

    expect(destroy).toHaveBeenCalledOnce();
    expect(residualOwner.destroy).toHaveBeenCalledWith({ children: true });
  });

  it('keeps only the newest spare application', () => {
    const first = createApplication();
    const second = createApplication();
    registerPixiApplication(first.application);
    registerPixiApplication(second.application);

    expect(retainPixiApplication(first.application, DEFAULT_PROFILE)).toBe(true);
    expect(retainPixiApplication(second.application, DEFAULT_PROFILE)).toBe(true);

    expect(first.destroy).toHaveBeenCalledOnce();
    expect(acquireRetainedPixiApplication(DEFAULT_PROFILE)).toBe(second.application);
    destroyPixiApplication(second.application);
  });

  it('discards a WebGL context lost while the application was detached', () => {
    const { application, destroy } = createApplication();
    const gl = { isContextLost: vi.fn().mockReturnValue(false) };
    Object.assign(application.renderer, { gl });
    registerPixiApplication(application);
    expect(retainPixiApplication(application, DEFAULT_PROFILE)).toBe(true);

    gl.isContextLost.mockReturnValue(true);
    expect(acquireRetainedPixiApplication(DEFAULT_PROFILE)).toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys an unused spare after the bounded idle interval', () => {
    vi.useFakeTimers();
    const { application, destroy } = createApplication();
    registerPixiApplication(application);
    expect(retainPixiApplication(application, DEFAULT_PROFILE)).toBe(true);

    vi.advanceTimersByTime(PIXI_APPLICATION_RETENTION_MS);

    expect(destroy).toHaveBeenCalledOnce();
    expect(acquireRetainedPixiApplication(DEFAULT_PROFILE)).toBeNull();
    expect(lifecycle.globalRelease).toHaveBeenCalledOnce();
  });

  it('does not hand an incompatible WebGL profile to a new viewer', () => {
    const { application, destroy } = createApplication();
    registerPixiApplication(application);
    expect(retainPixiApplication(application, DEFAULT_PROFILE)).toBe(true);

    expect(
      acquireRetainedPixiApplication({ ...DEFAULT_PROFILE, preserveDrawingBuffer: true })
    ).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
  });
});
