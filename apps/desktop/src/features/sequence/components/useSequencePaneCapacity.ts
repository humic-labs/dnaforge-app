import { useLayoutEffect, useMemo, useState } from 'react';
import { roundedSequencePaneExtent } from './pane-resize-display-size';

export function useSequencePaneCapacity(width: number, height: number) {
  const [held, setHeld] = useState(() => ({
    width: roundedSequencePaneExtent(width),
    height: roundedSequencePaneExtent(height),
  }));
  const nextWidth = width > 0 ? roundedSequencePaneExtent(width) : held.width;
  const nextHeight = height > 0 ? roundedSequencePaneExtent(height) : held.height;
  const capacity = useMemo(() => {
    if (nextWidth <= held.width && nextHeight <= held.height) return held;
    return { width: Math.max(held.width, nextWidth), height: Math.max(held.height, nextHeight) };
  }, [held, nextWidth, nextHeight]);

  useLayoutEffect(() => {
    if (held !== capacity) {
      setHeld(capacity);
      return;
    }
    if (held.width === nextWidth && held.height === nextHeight) return;
    const timer = setTimeout(() => setHeld({ width: nextWidth, height: nextHeight }), 250);
    return () => clearTimeout(timer);
  }, [width, height, held, capacity, nextWidth, nextHeight]);
  return capacity;
}
