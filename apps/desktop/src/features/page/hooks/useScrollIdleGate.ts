import { useEffect, useState, type RefObject } from 'react';
import { findScrollParent } from '../utils/findScrollParent';

export type ScrollIdleGateOptions = {
  idleMs?: number;
  noInteractionFallbackMs?: number;
};

export function useScrollIdleGate(
  elementRef: RefObject<HTMLElement | null>,
  options: ScrollIdleGateOptions = {}
): boolean {
  const idleMs = options.idleMs ?? 150;
  const noInteractionFallbackMs = options.noInteractionFallbackMs ?? 1500;
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let seenInteraction = false;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (!cancelled) setIsIdle(true);
      }, idleMs);
    };

    const markActive = () => {
      if (cancelled) return;
      seenInteraction = true;
      setIsIdle(false);
      armIdleTimer();
    };

    const scrollParent = findScrollParent(el);

    fallbackTimer = setTimeout(() => {
      if (!cancelled && !seenInteraction) setIsIdle(true);
    }, noInteractionFallbackMs);

    if (!scrollParent) {
      return () => {
        cancelled = true;
        clearIdleTimer();
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };
    }

    scrollParent.addEventListener('scroll', markActive, { passive: true });
    scrollParent.addEventListener('wheel', markActive, { passive: true });

    return () => {
      cancelled = true;
      clearIdleTimer();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      scrollParent.removeEventListener('scroll', markActive);
      scrollParent.removeEventListener('wheel', markActive);
    };
  }, [elementRef, idleMs, noInteractionFallbackMs]);

  return isIdle;
}
