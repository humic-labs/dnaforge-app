import { createContext, useContext, useRef, useSyncExternalStore } from 'react';
import type { CdsExtensionArrowId } from './cds-extension-affordance';

function sameArrow(a: CdsExtensionArrowId | null, b: CdsExtensionArrowId | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.cdsKey === b.cdsKey && a.direction === b.direction;
}

export interface CdsExtensionHoverStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CdsExtensionArrowId | null;
  setHovered: (next: CdsExtensionArrowId | null) => void;
  requestDraft: (next: CdsExtensionArrowId) => void;
  takeDraftRequest: () => CdsExtensionArrowId | null;
  clear: () => void;
}

export function createCdsExtensionHoverStore(): CdsExtensionHoverStore {
  let hovered: CdsExtensionArrowId | null = null;
  let requested: CdsExtensionArrowId | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const l of listeners) l();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return hovered;
    },
    setHovered(next) {
      if (sameArrow(hovered, next)) return;
      hovered = next;
      publish();
    },
    requestDraft(next) {
      requested = next;
      publish();
    },
    takeDraftRequest() {
      const taken = requested;
      requested = null;
      return taken;
    },
    clear() {
      if (hovered === null && requested === null) return;
      hovered = null;
      requested = null;
      publish();
    },
  };
}

const CdsExtensionHoverContext = createContext<CdsExtensionHoverStore | null>(null);

export const CdsExtensionHoverProvider = CdsExtensionHoverContext.Provider;

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = (): CdsExtensionArrowId | null => null;

export function useCdsExtensionHover(): CdsExtensionArrowId | null {
  const store = useContext(CdsExtensionHoverContext);
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
}

export function useCdsExtensionHoverStore(): CdsExtensionHoverStore | null {
  return useContext(CdsExtensionHoverContext);
}

export function useCreateCdsExtensionHoverStore(): CdsExtensionHoverStore {
  const ref = useRef<CdsExtensionHoverStore | null>(null);
  if (ref.current === null) ref.current = createCdsExtensionHoverStore();
  return ref.current;
}
