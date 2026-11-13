import { useEffect, type RefObject } from 'react';

const EASE = 0.55;

export function useSmoothVerticalScroll(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    let target = el.scrollTop;
    let cur = el.scrollTop;
    let raf = 0;
    let running = false;

    const step = () => {
      raf = 0;
      if (Math.abs(el.scrollTop - cur) > 2) {
        cur = target = el.scrollTop;
        running = false;
        return;
      }
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      target = Math.max(0, Math.min(maxTop, target));
      cur += (target - cur) * EASE;
      if (Math.abs(target - cur) < 0.5) cur = target;
      el.scrollTop = cur;
      if (Math.abs(target - cur) >= 0.5) {
        raf = requestAnimationFrame(step);
      } else {
        running = false;
      }
    };

    const onWheel = (e: WheelEvent) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const insidePane = path.length ? path.includes(el) : el.contains(e.target as Node | null);
      if (!insidePane) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxTop <= 0) return;
      if (
        !running &&
        ((e.deltaY < 0 && el.scrollTop <= 0) || (e.deltaY > 0 && el.scrollTop >= maxTop))
      ) {
        return;
      }
      e.preventDefault();
      if (!running || Math.abs(el.scrollTop - cur) > 2) {
        cur = target = el.scrollTop;
        running = true;
      }
      target = Math.max(0, Math.min(maxTop, target + e.deltaY));
      if (!raf) raf = requestAnimationFrame(step);
    };

    const doc = el.ownerDocument;
    doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      doc.removeEventListener('wheel', onWheel, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, enabled]);
}
