import { WORKSPACE_FILE_RELOCATED_EVENT } from '../../../shared/workspace-relocate-types';

let generation = 0;
const listeners = new Set<() => void>();

let activeSources = 0;
let detachWindowListeners: (() => void) | null = null;

export function getReferenceGeneration(): number {
  return generation;
}

export function subscribeToReferenceGeneration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpReferenceGeneration(): void {
  generation += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[reference-generation] subscriber threw during invalidation', error);
    }
  }
}

export function startReferenceInvalidationListeners(): () => void {
  activeSources += 1;

  if (!detachWindowListeners) {
    const onInvalidate = (): void => {
      bumpReferenceGeneration();
    };

    window.addEventListener(WORKSPACE_FILE_RELOCATED_EVENT, onInvalidate);
    window.addEventListener('waypoint:workspace-files-changed', onInvalidate);
    window.addEventListener('waypoint:workspace-reconciled', onInvalidate);

    detachWindowListeners = () => {
      window.removeEventListener(WORKSPACE_FILE_RELOCATED_EVENT, onInvalidate);
      window.removeEventListener('waypoint:workspace-files-changed', onInvalidate);
      window.removeEventListener('waypoint:workspace-reconciled', onInvalidate);
    };
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    activeSources -= 1;
    if (activeSources <= 0) {
      activeSources = 0;
      detachWindowListeners?.();
      detachWindowListeners = null;
    }
  };
}

export function __resetReferenceGenerationForTests(): void {
  generation = 0;
  listeners.clear();
  detachWindowListeners?.();
  detachWindowListeners = null;
  activeSources = 0;
}
