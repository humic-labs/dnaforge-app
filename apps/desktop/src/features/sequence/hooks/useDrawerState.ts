import { useState, useCallback, useEffect } from 'react';

export type DrawerType =
  | 'metadata'
  | 'annotations'
  | 'alignments'
  | 'git-history'
  | 'primers'
  | 'structure'
  | 'restriction-enzymes';

export function drawerRequiresEditingAccess(
  drawer: DrawerType | null,
  managedHistory = false
): boolean {
  return (
    drawer === 'annotations' ||
    drawer === 'primers' ||
    (drawer === 'git-history' && !managedHistory)
  );
}

const DEFAULT_WIDTH = 350;
const DEFAULT_WIDTH_PRIMERS = 360;

const DEFAULT_WIDTH_STRUCTURE = 480;
const MIN_WIDTH = 250;
const MAX_WIDTH = 800;

function getDefaultWidth(drawer: DrawerType): number {
  if (drawer === 'structure') return DEFAULT_WIDTH_STRUCTURE;
  if (drawer === 'primers') return DEFAULT_WIDTH_PRIMERS;
  return DEFAULT_WIDTH;
}

function getStorageKey(drawer: DrawerType, filePath: string): string {
  return `drawer-width:${drawer}:${filePath}`;
}

function loadWidth(drawer: DrawerType, filePath: string): number {
  try {
    const stored = localStorage.getItem(getStorageKey(drawer, filePath));
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed)) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed));
    }
  } catch {}
  return getDefaultWidth(drawer);
}

export function useDrawerState(filePath: string) {
  const reviewKey = `alignment-review-open:${filePath}`;
  const [activeDrawer, setActiveDrawer] = useState<DrawerType | null>(() => {
    try {
      return localStorage.getItem(reviewKey) === 'true' ? 'alignments' : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(reviewKey, String(activeDrawer === 'alignments'));
    } catch {}
  }, [activeDrawer, reviewKey]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [editTargetIndex, setEditTargetIndex] = useState<number | null>(null);

  const toggleDrawer = useCallback((drawer: DrawerType) => {
    setActiveDrawer((prev) => (prev === drawer ? null : drawer));
    setEditTargetIndex(null);
  }, []);

  const openDrawer = useCallback((drawer: DrawerType) => {
    setActiveDrawer(drawer);
    setEditTargetIndex(null);
  }, []);

  const closeDrawer = useCallback(() => {
    setActiveDrawer(null);
    setEditTargetIndex(null);
  }, []);

  const openToAnnotation = useCallback((index: number) => {
    setActiveDrawer('annotations');
    setEditTargetIndex(index);
  }, []);

  const clearEditTarget = useCallback(() => {
    setEditTargetIndex(null);
  }, []);

  const getDrawerWidth = useCallback(
    (drawer: DrawerType) => widths[getStorageKey(drawer, filePath)] ?? loadWidth(drawer, filePath),
    [filePath, widths]
  );

  const drawerWidth = activeDrawer ? getDrawerWidth(activeDrawer) : DEFAULT_WIDTH;

  const setDrawerWidth = useCallback(
    (width: number) => {
      if (!activeDrawer) return;
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
      const key = getStorageKey(activeDrawer, filePath);
      setWidths((prev) => ({ ...prev, [key]: clamped }));
      try {
        localStorage.setItem(key, String(clamped));
      } catch {}
    },
    [activeDrawer, filePath]
  );

  return {
    activeDrawer,
    isDrawerOpen: activeDrawer !== null,
    drawerWidth,
    toggleDrawer,
    openDrawer,
    closeDrawer,
    getDrawerWidth,
    setDrawerWidth,
    editTargetIndex,
    openToAnnotation,
    clearEditTarget,
  };
}
