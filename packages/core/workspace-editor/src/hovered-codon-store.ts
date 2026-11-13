import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

export interface HoveredCodonKey {
  start: number;
  end: number;
  strand: 1 | -1;
  source?: 'sequence' | 'structure';
}

function sameKey(a: HoveredCodonKey | null, b: HoveredCodonKey | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.start === b.start && a.end === b.end && a.strand === b.strand && a.source === b.source;
}

export interface HoveredCodonStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HoveredCodonKey | null;
  set: (next: HoveredCodonKey | null) => void;
}

export function createHoveredCodonStore(): HoveredCodonStore {
  let current: HoveredCodonKey | null = null;
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

const HoveredCodonContext = createContext<HoveredCodonStore | null>(null);

export const HoveredCodonProvider = HoveredCodonContext.Provider;

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = (): HoveredCodonKey | null => null;

export function useHoveredCodon(): HoveredCodonKey | null {
  const store = useContext(HoveredCodonContext);
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
}

export function useHoveredCodonStore(): HoveredCodonStore | null {
  return useContext(HoveredCodonContext);
}

export function useCreateHoveredCodonStore(): HoveredCodonStore {
  const ref = useRef<HoveredCodonStore | null>(null);
  if (ref.current === null) ref.current = createHoveredCodonStore();
  return ref.current;
}

export function useEffectiveHoveredCodon(
  localValue: HoveredCodonKey | null | undefined
): HoveredCodonKey | null {
  const store = useContext(HoveredCodonContext);
  const fromStore = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
  if (fromStore !== null) return fromStore;
  return localValue ?? null;
}
