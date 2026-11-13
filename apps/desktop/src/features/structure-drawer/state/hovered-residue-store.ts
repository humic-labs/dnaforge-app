import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

export interface HoveredResidueKey {
  structureId: string;
  chain: string;
  position: number;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  labelSeqId?: number;
  operator?: string;
}

function sameKey(a: HoveredResidueKey | null, b: HoveredResidueKey | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.structureId === b.structureId &&
    a.chain === b.chain &&
    a.position === b.position &&
    a.baseChain === b.baseChain &&
    a.labelAsymId === b.labelAsymId &&
    a.authAsymId === b.authAsymId &&
    a.entityId === b.entityId &&
    a.labelSeqId === b.labelSeqId &&
    a.operator === b.operator
  );
}

export interface HoveredResidueStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HoveredResidueKey | null;
  set: (next: HoveredResidueKey | null) => void;
}

export function createHoveredResidueStore(): HoveredResidueStore {
  let current: HoveredResidueKey | null = null;
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

const HoveredResidueContext = createContext<HoveredResidueStore | null>(null);

export const HoveredResidueProvider = HoveredResidueContext.Provider;

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = (): HoveredResidueKey | null => null;

export function useHoveredResidue(): HoveredResidueKey | null {
  const store = useContext(HoveredResidueContext);
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
}

export function useHoveredResidueStore(): HoveredResidueStore | null {
  return useContext(HoveredResidueContext);
}

export function useCreateHoveredResidueStore(): HoveredResidueStore {
  const ref = useRef<HoveredResidueStore | null>(null);
  if (ref.current === null) ref.current = createHoveredResidueStore();
  return ref.current;
}
