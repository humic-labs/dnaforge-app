import type { PixiPresentedFrame } from './types';
import type { Genome } from '../types';
import type { Application } from 'pixi.js';
import {
  isWebGLTraceActive,
  perfLog as plog,
  perfTime as ptime,
  recordWebGLTrace,
} from '@waypoint/genome-renderer';
import type {
  InteractionHandle,
  PixiLinearRenderer,
  PixiStadiumRenderer,
  RenderState,
} from '@waypoint/genome-renderer';
import { maybeRecordWebGLFrameProbe } from './webgl-frame-probe';
import {
  minimumFrameIntervalForWebGLState,
  slowFrameCooldownMs,
  webglRenderStateSignature,
} from './webgl-render-policy';

type MutableRef<T> = { current: T };

const POST_PRESENT_WORK_DEADLINE_MS = 6;
const POST_PRESENT_WAKE_WATCHDOG_MS = 100;

function submitPixiFrameCommands(app: Application): void {
  const renderer = app.renderer as
    | { readonly gl?: Pick<WebGLRenderingContext, 'flush'> }
    | undefined;
  renderer?.gl?.flush();
}

export interface WebGLRenderLoop {
  renderNow: () => void;

  wake: () => void;
  resume: () => void;
  stop: () => void;
}

export interface WebGLFatalFrameError {
  readonly instance: string;
  readonly phase: string;
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly consecutiveFrameErrors: number;
  readonly frameCount: number;
  readonly renderRevision: number;
  readonly zoom: number;
  readonly viewOffset: number;
  readonly width: number;
  readonly height: number;
}

export function startWebGLRenderLoop(params: {
  instanceId: string;
  minimumFrameIntervalMs?: () => number;
  app: Application;
  renderer: PixiStadiumRenderer | PixiLinearRenderer;
  interaction: InteractionHandle;
  stateRef: MutableRef<RenderState>;
  renderRevisionRef: MutableRef<number>;
  visibleRef: MutableRef<boolean>;
  rafRef: MutableRef<number | null>;
  frameCountRef: MutableRef<number>;
  lastFrameTRef: MutableRef<number>;
  presentedFrameListenersRef: MutableRef<Set<(receipt: PixiPresentedFrame) => void>>;
  getPresentedGenome?: () => Genome | null;
  criticalPostPresentWorkRef?: MutableRef<Set<(deadlineMs: number) => void>>;
  postPresentWorkRef: MutableRef<Set<(deadlineMs: number) => void>>;
  isDestroyed: () => boolean;
  onFatalFrameError: (failure: WebGLFatalFrameError) => void;
}): WebGLRenderLoop {
  let lastFrameT = performance.now();
  let consecutiveFrameErrors = 0;
  let frameCircuitOpen = false;
  let lastTraceFrameT = 0;
  let lastTraceZoom = params.stateRef.current.zoom;
  let lastTraceViewOffset = params.stateRef.current.viewOffset;
  let lastRenderedSignature: string | null = null;
  let nextRenderAllowedAt = 0;
  let renderDeferredSince: number | null = null;
  let tickExecuting = false;
  let explicitlyStopped = false;
  let pendingWorkWakeWatchdog: ReturnType<typeof setTimeout> | null = null;
  let regularPostPresentWorkHasPriorityDebt = false;

  let renderDemandPending = true;

  let rendererFrameWorkPending = false;

  const clearPendingWorkWakeWatchdog = () => {
    if (pendingWorkWakeWatchdog === null) return;
    clearTimeout(pendingWorkWakeWatchdog);
    pendingWorkWakeWatchdog = null;
  };

  const notifyPresentedFrame = () => {
    const genome = params.getPresentedGenome?.();
    const receipt: PixiPresentedFrame = {
      frameEpoch: params.frameCountRef.current + 1,
      presentedAtMs: performance.now(),
      ...(genome ? { content: { genome, orfsDrawn: params.renderer.hasDrawnOrfs() } } : {}),
    };
    for (const listener of Array.from(params.presentedFrameListenersRef.current)) {
      try {
        listener(receipt);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        plog('presented-frame-listener-error', {
          instance: params.instanceId,
          message: error.message,
        });
      }
    }
  };

  const runPostPresentQueue = (
    queue: Set<(deadlineMs: number) => void>,
    deadlineMs: number
  ): number => {
    if (performance.now() >= deadlineMs) return 0;

    let remainingProducerVisits = queue.size;
    let completedProducerVisits = 0;
    while (remainingProducerVisits > 0) {
      const next = queue.values().next();
      if (next.done) return completedProducerVisits;
      const work = next.value;
      queue.delete(work);
      work(deadlineMs);
      remainingProducerVisits -= 1;
      completedProducerVisits += 1;
      if (performance.now() >= deadlineMs) return completedProducerVisits;
    }
    return completedProducerVisits;
  };

  const hasPendingPostPresentWork = (): boolean =>
    (params.criticalPostPresentWorkRef?.current.size ?? 0) > 0 ||
    params.postPresentWorkRef.current.size > 0;

  const hasPendingContinuationWork = (): boolean =>
    renderDemandPending || rendererFrameWorkPending || hasPendingPostPresentWork();

  const runPostPresentWork = (frameT0: number): void => {
    const deadlineMs = frameT0 + POST_PRESENT_WORK_DEADLINE_MS;
    const criticalQueue = params.criticalPostPresentWorkRef?.current;
    const regularQueue = params.postPresentWorkRef.current;
    const hadCriticalWork = (criticalQueue?.size ?? 0) > 0;
    const hadRegularWork = regularQueue.size > 0;
    if (regularPostPresentWorkHasPriorityDebt && hadRegularWork) {
      runPostPresentQueue(regularQueue, deadlineMs);
      if (criticalQueue) runPostPresentQueue(criticalQueue, deadlineMs);
      regularPostPresentWorkHasPriorityDebt = false;
      return;
    }
    if (criticalQueue) runPostPresentQueue(criticalQueue, deadlineMs);
    const regularVisits = runPostPresentQueue(regularQueue, deadlineMs);

    regularPostPresentWorkHasPriorityDebt =
      hadCriticalWork &&
      hadRegularWork &&
      regularVisits === 0 &&
      (criticalQueue?.size ?? 0) > 0 &&
      regularQueue.size > 0;
  };

  const handleFrameError = (err: unknown, phase: string) => {
    if (frameCircuitOpen) return true;
    consecutiveFrameErrors += 1;
    const error = err instanceof Error ? err : new Error(String(err));
    const detail = {
      instance: params.instanceId,
      phase,
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      consecutiveFrameErrors,
      frameCount: params.frameCountRef.current,
      renderRevision: params.renderRevisionRef.current,
      zoom: params.stateRef.current.zoom,
      viewOffset: params.stateRef.current.viewOffset,
      width: params.stateRef.current.width,
      height: params.stateRef.current.height,
    };
    plog('frame-error', detail);
    recordWebGLTrace('frame-error', detail);

    if (consecutiveFrameErrors >= 3) {
      frameCircuitOpen = true;
      clearPendingWorkWakeWatchdog();
      if (params.rafRef.current !== null) {
        cancelAnimationFrame(params.rafRef.current);
        params.rafRef.current = null;
      }
      recordWebGLTrace('frame-circuit-open', detail, { snapshot: true });
      params.onFatalFrameError(detail);
      return true;
    }

    return false;
  };

  const maybeTraceFrame = (frameDt: number, sinceLast: number) => {
    if (!isWebGLTraceActive()) return;
    const now = performance.now();
    const s = params.stateRef.current;
    const zoomChanged = Math.abs(s.zoom - lastTraceZoom) > 0.0001;
    const offsetChanged = Math.abs(s.viewOffset - lastTraceViewOffset) > 0.000001;
    const periodic = now - lastTraceFrameT >= 500;
    const interactionDriven = (zoomChanged || offsetChanged) && now - lastTraceFrameT >= 100;
    if (!periodic && !interactionDriven && frameDt <= 32 && sinceLast <= 50) return;

    recordWebGLTrace(
      interactionDriven ? 'frame-state-change' : 'frame-sample',
      {
        instance: params.instanceId,
        frame: params.frameCountRef.current,
        frameDt: +frameDt.toFixed(1),
        sinceLast: +sinceLast.toFixed(1),
        zoom: s.zoom,
        viewOffset: s.viewOffset,
        width: s.width,
        height: s.height,
        geometryHeight: s.geometryHeight ?? s.height,
      },
      { snapshot: true }
    );
    lastTraceFrameT = now;
    lastTraceZoom = s.zoom;
    lastTraceViewOffset = s.viewOffset;
  };

  const renderNow = () => {
    if (frameCircuitOpen || params.isDestroyed() || !params.visibleRef.current) return;
    const frameT0 = performance.now();
    const sinceLast = frameT0 - lastFrameT;
    let phase = 'flushInteraction';
    try {
      ptime('frame.flushInteraction', () => params.interaction.flushInteraction());
      const signature = webglRenderStateSignature(
        params.stateRef.current,
        params.renderRevisionRef.current
      );
      phase = 'render';
      let rendererHasPendingFrameWork = false;
      renderDemandPending = false;
      ptime('frame.render', () => {
        rendererHasPendingFrameWork = params.renderer.render(params.stateRef.current) === true;
      });
      rendererFrameWorkPending = rendererHasPendingFrameWork;
      if (
        (
          params.renderer as { isCurrentPresentationComplete?: () => boolean }
        ).isCurrentPresentationComplete?.() === false
      ) {
        renderDemandPending = true;
        rendererFrameWorkPending = true;
        lastRenderedSignature = null;
        return;
      }
      phase = 'pixi';
      ptime('frame.pixi', () => params.app.render());
      phase = 'gpu-submit';
      ptime('frame.gpu-submit', () => submitPixiFrameCommands(params.app));
      params.interaction.commitPresentedCamera?.();
      phase = 'post-pixi-resource-release';
      ptime('frame.resource-release', () =>
        (params.renderer as { completePresentedFrame?: () => void }).completePresentedFrame?.()
      );
      phase = 'presented-frame-sync';
      ptime('frame.presented-listeners', () => notifyPresentedFrame());
      phase = 'post-present';
      ptime('frame.post-present', () => runPostPresentWork(frameT0));
      lastFrameT = frameT0;
      lastRenderedSignature = rendererHasPendingFrameWork ? null : signature;
      nextRenderAllowedAt = 0;
      renderDeferredSince = null;
      consecutiveFrameErrors = 0;
      params.frameCountRef.current += 1;
      params.lastFrameTRef.current = performance.now();
      maybeRecordWebGLFrameProbe({
        instanceId: params.instanceId,
        frame: params.frameCountRef.current,
        sinceLast,
        frameDt: params.lastFrameTRef.current - frameT0,
        state: params.stateRef.current,
        renderer: params.renderer,
        app: params.app,
      });
    } catch (err) {
      renderDemandPending = true;
      handleFrameError(err, phase);
    } finally {
      scheduleTick();
    }
  };

  const scheduleTick = (replacePendingTicket = false) => {
    if (
      explicitlyStopped ||
      frameCircuitOpen ||
      params.isDestroyed() ||
      !params.visibleRef.current ||
      tickExecuting
    ) {
      return;
    }
    if (replacePendingTicket && params.rafRef.current !== null) {
      cancelAnimationFrame(params.rafRef.current);
      params.rafRef.current = null;
    }
    if (params.rafRef.current === null) {
      params.rafRef.current = requestAnimationFrame(tick);
    }
    if (hasPendingContinuationWork() && pendingWorkWakeWatchdog === null) {
      pendingWorkWakeWatchdog = setTimeout(() => {
        pendingWorkWakeWatchdog = null;
        if (!hasPendingContinuationWork()) return;

        scheduleTick(true);
      }, POST_PRESENT_WAKE_WATCHDOG_MS);
    }
  };

  const tick = () => {
    clearPendingWorkWakeWatchdog();
    params.rafRef.current = null;
    if (explicitlyStopped || frameCircuitOpen || params.isDestroyed()) return;
    if (!params.visibleRef.current) return;

    scheduleTick();
    tickExecuting = true;

    const frameT0 = performance.now();
    const sinceLast = frameT0 - lastFrameT;
    let phase = 'flushInteraction';
    try {
      ptime('frame.flushInteraction', () =>
        params.interaction.flushInteraction({ advanceCamera: frameT0 >= nextRenderAllowedAt })
      );
      const signature = webglRenderStateSignature(
        params.stateRef.current,
        params.renderRevisionRef.current
      );
      if (signature === lastRenderedSignature) {
        renderDemandPending = false;
        renderDeferredSince = null;
        phase = 'post-present-idle';
        runPostPresentWork(frameT0);
        return;
      }

      if (frameT0 < nextRenderAllowedAt) {
        renderDeferredSince ??= frameT0;
        return;
      }

      phase = 'render';
      let rendererHasPendingFrameWork = false;
      renderDemandPending = false;
      ptime('frame.render', () => {
        rendererHasPendingFrameWork = params.renderer.render(params.stateRef.current) === true;
      });
      rendererFrameWorkPending = rendererHasPendingFrameWork;
      if (
        (
          params.renderer as { isCurrentPresentationComplete?: () => boolean }
        ).isCurrentPresentationComplete?.() === false
      ) {
        renderDemandPending = true;
        rendererFrameWorkPending = true;
        lastRenderedSignature = null;
        return;
      }
      phase = 'pixi';
      ptime('frame.pixi', () => params.app.render());
      phase = 'gpu-submit';
      ptime('frame.gpu-submit', () => submitPixiFrameCommands(params.app));
      params.interaction.commitPresentedCamera?.();
      phase = 'post-pixi-resource-release';
      ptime('frame.resource-release', () =>
        (params.renderer as { completePresentedFrame?: () => void }).completePresentedFrame?.()
      );
      phase = 'presented-frame-sync';
      ptime('frame.presented-listeners', () => notifyPresentedFrame());
      phase = 'post-present';
      ptime('frame.post-present', () => runPostPresentWork(frameT0));
      lastFrameT = frameT0;
      lastRenderedSignature = rendererHasPendingFrameWork ? null : signature;
      const deferredMs = renderDeferredSince === null ? 0 : frameT0 - renderDeferredSince;
      renderDeferredSince = null;
      consecutiveFrameErrors = 0;
      params.frameCountRef.current += 1;
      params.lastFrameTRef.current = performance.now();
      const frameDt = params.lastFrameTRef.current - frameT0;
      const requestedFrameInterval = params.minimumFrameIntervalMs?.() ?? 0;
      const minFrameInterval = Math.max(
        minimumFrameIntervalForWebGLState(params.stateRef.current),
        Number.isFinite(requestedFrameInterval) ? Math.max(0, requestedFrameInterval) : 0
      );
      const cooldown = slowFrameCooldownMs(params.stateRef.current, frameDt);
      nextRenderAllowedAt = Math.max(
        frameT0 + minFrameInterval,
        cooldown > 0 ? params.lastFrameTRef.current + cooldown : 0
      );
      maybeRecordWebGLFrameProbe({
        instanceId: params.instanceId,
        frame: params.frameCountRef.current,
        sinceLast,
        frameDt,
        state: params.stateRef.current,
        renderer: params.renderer,
        app: params.app,
      });
      if (frameDt > 32) plog('slow-frame', { renderMs: +frameDt.toFixed(1) });
      if (sinceLast > 50) plog('slow-gap', { msSinceLastFrame: +sinceLast.toFixed(1) });
      if (cooldown > 0 || deferredMs > 0) {
        plog('frame-budget', {
          mode: params.stateRef.current.performanceMode ?? 'default',
          minFrameInterval,
          cooldown: +cooldown.toFixed(1),
          deferredMs: +deferredMs.toFixed(1),
        });
      }
      maybeTraceFrame(frameDt, sinceLast);
    } catch (err) {
      renderDemandPending = true;
      handleFrameError(err, phase);
    } finally {
      tickExecuting = false;
      scheduleTick();
    }
  };

  const loop: WebGLRenderLoop = {
    renderNow,
    wake: () => {
      renderDemandPending = true;
      scheduleTick(true);
    },
    resume: () => {
      if (frameCircuitOpen) return;
      explicitlyStopped = false;
      lastFrameT = performance.now();
      lastRenderedSignature = null;
      nextRenderAllowedAt = 0;
      renderDeferredSince = null;
      renderDemandPending = true;
      scheduleTick(true);
    },
    stop: () => {
      explicitlyStopped = true;
      clearPendingWorkWakeWatchdog();
      if (params.rafRef.current !== null) {
        cancelAnimationFrame(params.rafRef.current);
        params.rafRef.current = null;
      }
    },
  };

  scheduleTick();
  return loop;
}
