import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ActivityView } from './ActivityBar';
import { isRendererFeatureView, rendererFeatureScreenCategory } from '../feature-registry';
import { useCanvasStore } from '../features/canvas/store';
import type { Tab, TabType } from '../features/canvas/types';
import { observeCommittedScreen, type ScreenCategory } from '../lib/screen-telemetry';
import {
  isAnalyticsCaptureReady,
  setAnalyticsScreenCategory,
  subscribeAnalyticsCaptureReady,
} from '../lib/analytics';

interface ScreenViewTelemetryObserverProps {
  activeView: ActivityView;
  hasActiveWorkspace: boolean;
  projectHomeVisible: boolean;
  ready: boolean;
}

export function ScreenViewTelemetryObserver({
  activeView,
  hasActiveWorkspace,
  projectHomeVisible,
  ready,
}: ScreenViewTelemetryObserverProps) {
  const analyticsReady = useSyncExternalStore(
    subscribeAnalyticsCaptureReady,
    isAnalyticsCaptureReady,
    () => false
  );
  const panels = useCanvasStore((state) => state.panels);
  const focusedPanelId = useCanvasStore((state) => state.focusedPanelId);
  const destination = useMemo(() => {
    if (activeView === 'settings') {
      return {
        targetKey: 'view:settings',
        screenCategory: 'settings' as const,
        source: 'menu' as const,
      };
    }
    if (activeView === 'search') {
      return {
        targetKey: 'view:search',
        screenCategory: 'search' as const,
        source: 'sidebar' as const,
      };
    }
    if (projectHomeVisible || activeView === 'home') {
      return {
        targetKey: 'view:home',
        screenCategory: 'home' as const,
        source: 'sidebar' as const,
      };
    }
    if (activeView !== 'files') {
      const activity = activityDestination(activeView);
      return {
        targetKey: `view:${activeView}`,
        screenCategory: activity.screenCategory,
        source: activity.source,
      };
    }

    const focusedPanel = focusedPanelId ? panels[focusedPanelId] : undefined;
    const activeTab = focusedPanel?.tabs.find((tab) => tab.id === focusedPanel.activeTabId);
    if (activeTab) return tabDestination(activeTab);
    return {
      targetKey: hasActiveWorkspace ? 'view:files' : 'view:home',
      screenCategory: hasActiveWorkspace ? ('files' as const) : ('home' as const),
      source: 'sidebar' as const,
    };
  }, [activeView, focusedPanelId, hasActiveWorkspace, panels, projectHomeVisible]);

  useEffect(() => {
    if (!ready) return;
    setAnalyticsScreenCategory(destination.screenCategory);
  }, [destination.screenCategory, ready]);

  useEffect(() => {
    if (!ready || !analyticsReady) return;
    observeCommittedScreen({
      targetKey: destination.targetKey,
      screenCategory: destination.screenCategory,
      sourceSurface: destination.source,
    });
  }, [analyticsReady, destination, ready]);

  return null;
}

function tabDestination(tab: Tab): {
  targetKey: string;
  screenCategory: ScreenCategory;
  source: 'tab';
} {
  return {
    targetKey: `tab:${tab.id}`,
    screenCategory: screenCategoryForTab(tab.type),
    source: 'tab',
  };
}

function activityDestination(
  activeView: Exclude<ActivityView, 'files' | 'settings' | 'search' | 'home'>
): {
  screenCategory: ScreenCategory;
  source: 'sidebar';
} {
  if (isRendererFeatureView(activeView)) {
    return { screenCategory: rendererFeatureScreenCategory(activeView), source: 'sidebar' };
  }
  switch (activeView) {
    case 'jobs':
      return { screenCategory: 'jobs', source: 'sidebar' };
    case 'source-control':
      return { screenCategory: 'source_control', source: 'sidebar' };
    case 'lims':
      return { screenCategory: 'lims', source: 'sidebar' };
    case 'references':
      return { screenCategory: 'references', source: 'sidebar' };
    case 'toolbox':
      return { screenCategory: 'toolbox', source: 'sidebar' };
    default: {
      const exhaustive: never = activeView;
      return exhaustive;
    }
  }
}

function screenCategoryForTab(type: TabType): ScreenCategory {
  switch (type) {
    case 'sequence':
      return 'sequence';
    case 'design':
    case 'assembly-panel':
    case 'adjacency-graph':
    case 'assembly-browser':
      return 'assembly';
    case 'structure':
      return 'structure';
    case 'page':
      return 'page';
    case 'chat':
      return 'chat';
    case 'primer':
      return 'primers';
    case 'protein':
      return 'protein';
    case 'record':
      return 'lims';
    case 'scientific-document':
      return 'document';
    case 'file':
    case 'text':
    case 'image':
    case 'html':
    case 'table':
    case 'pdf':
      return 'files';
    case 'terminal':
      return 'toolbox';
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
