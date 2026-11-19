import { useRef, type MouseEvent } from 'react';

export function useMenuPointerSelection(select: (key: string) => void) {
  const previous = useRef<{ x: number; y: number } | null>(null);

  return (key: string) => {
    const onMove = (event: MouseEvent<HTMLElement>) => {
      const { clientX: x, clientY: y } = event;
      if (previous.current?.x === x && previous.current.y === y) return;
      previous.current = { x, y };
      select(key);
    };
    return { onMouseEnter: onMove, onMouseMove: onMove };
  };
}
