import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

export interface HoveredAnnotationKey {
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
}

function sameKey(a: HoveredAnnotationKey | null, b: HoveredAnnotationKey | null): boolean {
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

export interface HoveredAnnotationStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HoveredAnnotationKey | null;
  set: (next: HoveredAnnotationKey | null) => void;
}

export function createHoveredAnnotationStore(): HoveredAnnotationStore {
  let current: HoveredAnnotationKey | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return current;
    },
    set(next) {
      if (sameKey(current, next)) return;
      current = next;
      for (const l of listeners) l();
    },
  };
}

const HoveredAnnotationContext = createContext<HoveredAnnotationStore | null>(null);

export const HoveredAnnotationProvider = HoveredAnnotationContext.Provider;

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = (): HoveredAnnotationKey | null => null;

export function useHoveredAnnotation(): HoveredAnnotationKey | null {
  const store = useContext(HoveredAnnotationContext);
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
}

export function useHoveredAnnotationStore(): HoveredAnnotationStore | null {
  return useContext(HoveredAnnotationContext);
}

export function useCreateHoveredAnnotationStore(): HoveredAnnotationStore {
  const ref = useRef<HoveredAnnotationStore | null>(null);
  if (ref.current === null) ref.current = createHoveredAnnotationStore();
  return ref.current;
}

export function useEffectiveHoveredAnnotation(
  localValue: HoveredAnnotationKey | null | undefined
): HoveredAnnotationKey | null {
  const store = useContext(HoveredAnnotationContext);
  const fromStore = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
  if (fromStore !== null) return fromStore;
  return localValue ?? null;
}
