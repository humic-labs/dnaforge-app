import { useCallback, useState } from 'react';

interface UseResizableDrawerOptions {
  persistKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  defaultOpen?: boolean;
}

const DEFAULT_WIDTH = 800;
const MIN_WIDTH = 480;
const MAX_WIDTH = 1100;

function storageKey(persistKey: string): string {
  return `resizable-drawer:${persistKey}`;
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.max(minWidth, Math.min(maxWidth, width));
}

function loadWidth(
  persistKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number
): number {
  try {
    const stored = localStorage.getItem(storageKey(persistKey));
    if (!stored) return defaultWidth;
    const parsed = parseInt(stored, 10);
    return Number.isNaN(parsed) ? defaultWidth : clampWidth(parsed, minWidth, maxWidth);
  } catch {
    return defaultWidth;
  }
}

export function useResizableDrawer({
  persistKey,
  defaultWidth = DEFAULT_WIDTH,
  minWidth = MIN_WIDTH,
  maxWidth = MAX_WIDTH,
  defaultOpen = false,
}: UseResizableDrawerOptions) {
  const [open, setOpen] = useState(defaultOpen);
  const [width, setWidthState] = useState(() =>
    loadWidth(persistKey, defaultWidth, minWidth, maxWidth)
  );

  const setWidth = useCallback(
    (nextWidth: number) => {
      const clamped = clampWidth(nextWidth, minWidth, maxWidth);
      setWidthState(clamped);
      try {
        localStorage.setItem(storageKey(persistKey), String(clamped));
      } catch {}
    },
    [maxWidth, minWidth, persistKey]
  );

  const toggleOpen = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  return {
    open,
    setOpen,
    toggleOpen,
    close,
    width,
    setWidth,
  };
}
