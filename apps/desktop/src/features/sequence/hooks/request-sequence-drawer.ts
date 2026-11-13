import { useEffect } from 'react';
import type { DrawerType } from './useDrawerState';

export const DEV_OPEN_SEQUENCE_DRAWER_EVENT = 'waypoint:open-sequence-drawer';

let pendingDrawer: DrawerType | null = null;

export function requestSequenceDrawer(drawer: DrawerType): void {
  pendingDrawer = drawer;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(DEV_OPEN_SEQUENCE_DRAWER_EVENT, {
      detail: { drawer },
    })
  );
}

export function takeRequestedSequenceDrawer(): DrawerType | null {
  const next = pendingDrawer;
  pendingDrawer = null;
  return next;
}

export function clearRequestedSequenceDrawer(): void {
  pendingDrawer = null;
}

export function useRequestedSequenceDrawer(openDrawer: (drawer: DrawerType) => void): void {
  useEffect(() => {
    const pending = takeRequestedSequenceDrawer();
    if (pending) openDrawer(pending);

    const onRequest = (event: Event): void => {
      const drawer = (event as CustomEvent<{ drawer?: DrawerType }>).detail?.drawer;
      if (drawer) openDrawer(drawer);
    };
    window.addEventListener(DEV_OPEN_SEQUENCE_DRAWER_EVENT, onRequest);
    return () => window.removeEventListener(DEV_OPEN_SEQUENCE_DRAWER_EVENT, onRequest);
  }, [openDrawer]);
}
