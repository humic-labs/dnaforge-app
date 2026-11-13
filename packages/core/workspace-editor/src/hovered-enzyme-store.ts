import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

export interface HoveredEnzymeStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string | null;
  set: (name: string | null) => void;
}

export function createHoveredEnzymeStore(): HoveredEnzymeStore {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return current;
    },
    set(name) {
      if (current === name) return;
      current = name;
      for (const l of listeners) l();
    },
  };
}

const HoveredEnzymeContext = createContext<HoveredEnzymeStore | null>(null);

export const HoveredEnzymeProvider = HoveredEnzymeContext.Provider;

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = (): string | null => null;

export function useMainViewerHoveredEnzyme(): string | null {
  const store = useContext(HoveredEnzymeContext);
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
}

export function useHoveredEnzymeStore(): HoveredEnzymeStore | null {
  return useContext(HoveredEnzymeContext);
}

export function useCreateHoveredEnzymeStore(): HoveredEnzymeStore {
  const ref = useRef<HoveredEnzymeStore | null>(null);
  if (ref.current === null) ref.current = createHoveredEnzymeStore();
  return ref.current;
}

export function useEffectiveHoveredEnzyme(propValue: string | null | undefined): string | null {
  const store = useContext(HoveredEnzymeContext);
  const fromStore = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
  if (store !== null) return fromStore;
  return propValue ?? null;
}
