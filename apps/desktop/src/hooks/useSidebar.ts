import { useState, useCallback, useRef, useEffect } from 'react';
import { FULL_SCREEN_ACTIVITY_VIEWS, type ActivityView } from '../components/ActivityBar';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  readSidebarState,
  writeSidebarState,
} from '../shared/ui-persistence';

const WORKSPACE_VIEWS = FULL_SCREEN_ACTIVITY_VIEWS;

interface UseSidebarOptions {
  toolboxBadge: string | null;
}

interface UseSidebarReturn {
  activeView: ActivityView;
  sidebarVisible: boolean;
  sidebarWidth: number;
  handleViewChange: (view: ActivityView) => void;
  toggleSidebar: () => void;
  commitSidebarWidth: (width: number) => void;
  handleOpenSettings: () => void;
}

export function useSidebar({ toolboxBadge }: UseSidebarOptions): UseSidebarReturn {
  const [initialSidebarState] = useState(readSidebarState);
  const [activeView, setActiveView] = useState<ActivityView>(initialSidebarState.activeView);
  const [sidebarVisible, setSidebarVisible] = useState(initialSidebarState.sidebarVisible);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarState.sidebarWidth);

  const latestRef = useRef({
    activeView: initialSidebarState.activeView,
    sidebarVisible: initialSidebarState.sidebarVisible,
    sidebarWidth: initialSidebarState.sidebarWidth,
  });
  const persistSidebar = useCallback((patch: Partial<typeof latestRef.current>) => {
    latestRef.current = { ...latestRef.current, ...patch };
    writeSidebarState(latestRef.current);
  }, []);

  const applyWidth = useCallback(
    (width: number) => {
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
      setSidebarWidth(next);
      persistSidebar({ sidebarWidth: next });
    },
    [persistSidebar]
  );

  const toggleSidebar = useCallback(() => {
    const next = !latestRef.current.sidebarVisible;
    setSidebarVisible(next);
    persistSidebar({ sidebarVisible: next });
  }, [persistSidebar]);

  const handleViewChange = useCallback(
    (view: ActivityView) => {
      setActiveView(view);
      const nextVisible = !WORKSPACE_VIEWS.has(view);
      setSidebarVisible(nextVisible);
      persistSidebar({ activeView: view, sidebarVisible: nextVisible });
    },
    [persistSidebar]
  );

  const hasAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (import.meta.env.DEV && toolboxBadge === 'downloading' && !hasAutoOpenedRef.current) {
      hasAutoOpenedRef.current = true;
      handleViewChange('toolbox');
    }
  }, [toolboxBadge, handleViewChange]);

  const handleOpenSettings = useCallback(() => {
    handleViewChange('settings');
  }, [handleViewChange]);

  return {
    activeView,
    sidebarVisible,
    sidebarWidth,
    handleViewChange,
    toggleSidebar,
    commitSidebarWidth: applyWidth,
    handleOpenSettings,
  };
}
