import type { PlasmidFeature } from '@waypoint/plasmid-viewer';
import type { HoveredAnnotationKey } from '@waypoint/workspace-editor';

export const WEBGL_HOVER_SYNC_DELAY_MS = 32;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface HoveredAnnotationStoreLike {
  getSnapshot: () => HoveredAnnotationKey | null;
  set: (next: HoveredAnnotationKey | null) => void;
}

export interface HoverSyncTimerApi {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

export function sameHoveredAnnotationKey(
  a: HoveredAnnotationKey | null,
  b: HoveredAnnotationKey | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.start === b.start &&
    a.end === b.end &&
    a.direction === b.direction
  );
}

export function hoveredAnnotationKeyFromFeature(feature: PlasmidFeature): HoveredAnnotationKey {
  return {
    type: feature.type,
    name: feature.displayName,
    start: feature.start,
    end: feature.end,
    direction: feature.direction === 'forward' ? 1 : feature.direction === 'reverse' ? -1 : 0,
  };
}

function indexKey(key: HoveredAnnotationKey): string {
  return `${key.type}\u0000${key.name}\u0000${key.start}\u0000${key.end}\u0000${key.direction ?? 0}`;
}

export function buildHoveredAnnotationFeatureIndex(
  features: readonly PlasmidFeature[]
): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < features.length; i += 1) {
    const key = hoveredAnnotationKeyFromFeature(features[i]);
    if (!index.has(indexKey(key))) index.set(indexKey(key), i);
  }
  return index;
}

export function resolveHoveredFeatureId(
  index: ReadonlyMap<string, number>,
  key: HoveredAnnotationKey | null
): number | null {
  if (!key) return null;
  return index.get(indexKey(key)) ?? null;
}

export interface DeferredWebGLHoverSync {
  schedule: (next: HoveredAnnotationKey | null) => void;
  dispose: () => void;
}

export function createDeferredWebGLHoverSync(
  store: HoveredAnnotationStoreLike,
  options: {
    delayMs?: number;
    timers?: HoverSyncTimerApi;
  } = {}
): DeferredWebGLHoverSync {
  const delayMs = options.delayMs ?? WEBGL_HOVER_SYNC_DELAY_MS;
  const timers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  let timer: TimerHandle | null = null;
  let queued: HoveredAnnotationKey | null = null;
  let lastApplied: HoveredAnnotationKey | null = null;

  const clearPending = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    timer = null;
    const current = store.getSnapshot();
    if (current !== null && !sameHoveredAnnotationKey(current, lastApplied)) {
      return;
    }
    store.set(queued);
    lastApplied = queued;
  };

  return {
    schedule(next) {
      queued = next;
      clearPending();
      timer = timers.setTimeout(flush, delayMs);
    },
    dispose() {
      clearPending();
    },
  };
}
