import { useEffect, useState, type RefObject } from 'react';
import { findScrollParent } from '../utils/findScrollParent';

export type ScrollIdleGateOptions = {
  idleMs?: number;
  noInteractionFallbackMs?: number;
  waitUntilVisible?: boolean;
};

export function useScrollIdleGate(
  elementRef: RefObject<HTMLElement | null>,
  options: ScrollIdleGateOptions = {}
): boolean {
  const idleMs = options.idleMs ?? 150;
  const noInteractionFallbackMs = options.noInteractionFallbackMs ?? 1500;
  const waitUntilVisible = options.waitUntilVisible ?? false;
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let seenInteraction = false;
    let quiet = false;
    let visible = !waitUntilVisible || typeof IntersectionObserver === 'undefined';
    let observer: IntersectionObserver | undefined;

    const grantIfReady = () => {
      if (cancelled || !quiet || !visible) return;
      observer?.disconnect();
      observer = undefined;
      setIsIdle(true);
    };

    if (!visible) {
      observer = new IntersectionObserver(([entry]) => {
        if (!observer || !entry) return;
        visible = entry.isIntersecting;
        grantIfReady();
      });
      observer.observe(el);
    }

    const markIdle = () => {
      quiet = true;
      grantIfReady();
    };

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(markIdle, idleMs);
    };

    const markActive = () => {
      if (cancelled) return;
      seenInteraction = true;
      quiet = false;
      setIsIdle(false);
      armIdleTimer();
    };

    const scrollParent = findScrollParent(el);

    fallbackTimer = setTimeout(() => {
      if (!seenInteraction) markIdle();
    }, noInteractionFallbackMs);

    scrollParent?.addEventListener('scroll', markActive, { passive: true });
    scrollParent?.addEventListener('wheel', markActive, { passive: true });

    return () => {
      cancelled = true;
      observer?.disconnect();
      clearIdleTimer();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      scrollParent?.removeEventListener('scroll', markActive);
      scrollParent?.removeEventListener('wheel', markActive);
    };
  }, [elementRef, idleMs, noInteractionFallbackMs, waitUntilVisible]);

  return isIdle;
}
