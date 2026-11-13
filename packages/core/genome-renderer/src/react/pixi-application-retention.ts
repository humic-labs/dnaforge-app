import { Application, CanvasTextMetrics, GlobalResourceRegistry } from 'pixi.js';

export const MAX_RETAINED_PIXI_APPLICATIONS = 1;
export const PIXI_APPLICATION_RETENTION_MS = 60_000;

export interface PixiApplicationProfile {
  antialias: boolean;
  resolution: number;
  preserveDrawingBuffer: boolean;
}

interface RetainedPixiApplication {
  application: Application;
  profileKey: string;
  releaseTimer: ReturnType<typeof setTimeout>;
}

const livePixiApplications = new Set<Application>();
const destroyedPixiApplications = new WeakSet<Application>();
const retainedPixiApplications = new Map<Application, RetainedPixiApplication>();

function profileKey(profile: PixiApplicationProfile): string {
  return [
    profile.antialias ? 1 : 0,
    profile.resolution,
    profile.preserveDrawingBuffer ? 1 : 0,
  ].join(':');
}

function releasePixiApplicationOwnership(target: Application): void {
  const released = livePixiApplications.delete(target);
  if (released && livePixiApplications.size === 0) {
    GlobalResourceRegistry.release();
  }
}

function removeRetainedEntry(target: Application): void {
  const retained = retainedPixiApplications.get(target);
  if (!retained) return;
  clearTimeout(retained.releaseTimer);
  retainedPixiApplications.delete(target);
}

function detachPixiEventTarget(target: Application): void {
  const targetRenderer = target.renderer;
  if (!targetRenderer) return;
  try {
    Reflect.apply(targetRenderer.events.setTargetElement, targetRenderer.events, [null]);
  } catch {}
  try {
    const events = targetRenderer.events as unknown as {
      _rootPointerEvent?: { nativeEvent?: unknown; srcElement?: unknown };
      _rootWheelEvent?: { nativeEvent?: unknown; srcElement?: unknown };
    };
    for (const rootEvent of [events._rootPointerEvent, events._rootWheelEvent]) {
      if (!rootEvent) continue;
      rootEvent.nativeEvent = null;
      rootEvent.srcElement = null;
    }
  } catch {}
  try {
    const boundary = targetRenderer.events.rootBoundary as unknown as {
      eventPool?: Map<unknown, unknown[]>;
    };
    boundary.eventPool?.clear();
  } catch {}
}

function isReusablePixiApplication(target: Application): boolean {
  const stage = target.stage;
  return (
    !destroyedPixiApplications.has(target) &&
    target.renderer !== null &&
    target.renderer !== undefined &&
    stage !== null &&
    stage !== undefined &&
    !stage.destroyed &&
    Array.isArray(stage.children) &&
    stage.children.length === 0
  );
}

export function registerPixiApplication(target: Application): void {
  livePixiApplications.add(target);
}

export function releaseUninitializedPixiApplication(target: Application): void {
  removeRetainedEntry(target);
  releasePixiApplicationOwnership(target);
}

export function isPixiApplicationDestroyed(target: Application): boolean {
  return destroyedPixiApplications.has(target);
}

export function destroyPixiApplication(target: Application | null): boolean {
  if (!target || destroyedPixiApplications.has(target)) return false;
  if (!target.renderer) return false;

  removeRetainedEntry(target);
  destroyedPixiApplications.add(target);
  detachPixiEventTarget(target);
  try {
    for (const child of Array.from(target.stage?.children ?? [])) {
      try {
        if (!child.destroyed) child.destroy({ children: true });
      } catch {}
    }
    target.destroy(false);
  } catch {
  } finally {
    releasePixiApplicationOwnership(target);
  }
  return true;
}

export function retainPixiApplication(
  target: Application,
  profile: PixiApplicationProfile
): boolean {
  if (!livePixiApplications.has(target) || !isReusablePixiApplication(target)) return false;

  removeRetainedEntry(target);
  detachPixiEventTarget(target);
  target.ticker.stop();
  target.canvas.parentNode?.removeChild(target.canvas);
  CanvasTextMetrics.clearMeasurementCache();

  const releaseTimer = setTimeout(() => {
    retainedPixiApplications.delete(target);
    destroyPixiApplication(target);
  }, PIXI_APPLICATION_RETENTION_MS);
  retainedPixiApplications.set(target, {
    application: target,
    profileKey: profileKey(profile),
    releaseTimer,
  });

  while (retainedPixiApplications.size > MAX_RETAINED_PIXI_APPLICATIONS) {
    const oldest = retainedPixiApplications.values().next().value;
    if (!oldest) break;
    retainedPixiApplications.delete(oldest.application);
    clearTimeout(oldest.releaseTimer);
    destroyPixiApplication(oldest.application);
  }
  return true;
}

export function acquireRetainedPixiApplication(
  profile: PixiApplicationProfile
): Application | null {
  const expectedProfileKey = profileKey(profile);
  for (const retained of retainedPixiApplications.values()) {
    if (retained.profileKey !== expectedProfileKey) continue;
    removeRetainedEntry(retained.application);
    if (isReusablePixiApplication(retained.application)) return retained.application;
    destroyPixiApplication(retained.application);
  }
  return null;
}

export function disposeRetainedPixiApplications(): void {
  for (const retained of Array.from(retainedPixiApplications.values())) {
    retainedPixiApplications.delete(retained.application);
    clearTimeout(retained.releaseTimer);
    destroyPixiApplication(retained.application);
  }
}
