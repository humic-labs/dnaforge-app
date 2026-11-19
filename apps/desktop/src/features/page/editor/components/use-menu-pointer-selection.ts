import { useRef, type MouseEvent } from 'react';

export function useMenuPointerSelection(select: (key: string) => void) {
  const previous = useRef<{ x: number; y: number } | null>(null);

  return (event: MouseEvent<HTMLElement>, key: string) => {
    const { clientX: x, clientY: y } = event;
    if (previous.current?.x === x && previous.current.y === y) return;
    previous.current = { x, y };
    select(key);
  };
}
