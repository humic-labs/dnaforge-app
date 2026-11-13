import { useLayoutEffect, useState, type RefObject } from 'react';
import { contentOverflowsX } from '../../../utils/content-overflows';

export function useOverflowXWhenNeeded(
  containerRef: RefObject<HTMLElement | null>,
  layoutKey: string | number
): boolean {
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      setOverflows(contentOverflowsX(el));
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) {
      if (child instanceof Element) ro.observe(child);
    }
    return () => ro.disconnect();
  }, [containerRef, layoutKey]);

  return overflows;
}
