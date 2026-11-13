import { createContext, useContext, useRef, useMemo, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '../store';
import { useWorkspaceVisibility } from '../workspace-visibility';
import { PresentationHost } from '../../../presentation/PresentationSurface';
import { debugLog } from '../../../utils/debug-log';
import type { Tab } from '../types';
import { PanelContent } from './PanelContent';
import { ErrorBoundary } from '../../../shared/components/ErrorBoundary';
import type { AssistantHostId } from '../../ai/public/assistant-hosts';
import { HiddenMapIdlePolicyContext } from '@waypoint/genome-renderer/react';
import {
  registerRetentionPool,
  requestMemoryPressureSample,
  useMemoryPressureLevel,
  useMemoryPressureMonitoring,
} from '../../memory-pressure/public';
import {
  acquireCachedViewerLease,
  getPaneRendererHostCacheKey,
  releaseCachedViewerLease,
} from '../../page/public/embeds/structure3d/molstar/cache';

export const SEQUENCE_TAB_RETENTION_BUDGETS = { normal: 8, moderate: 4, critical: 1 } as const;

export const sequenceTabRetention = registerRetentionPool({
  id: 'sequence-tabs',
  budgets: SEQUENCE_TAB_RETENTION_BUDGETS,
});

function isBudgetedSequenceTab(tab: Tab): boolean {
  return tab.type === 'sequence' && !tab.indexedGenome;
}

const TabPortalContext = createContext<Map<string, HTMLDivElement>>(new Map());

export function useTabPortalHost(tabId: string | null): HTMLDivElement | null {
  const hosts = useContext(TabPortalContext);
  return tabId ? (hosts.get(tabId) ?? null) : null;
}

interface TabPortalProviderProps {
  children: React.ReactNode;
  onOpenAssistantSources?: () => void;
  onConfigureHost?: (hostId: AssistantHostId) => void;
  onChatHistoryPinnedChange?: (panelId: string, pinned: boolean) => void;
}

function PaneRendererHostLease({ panelId }: { panelId: string }) {
  useEffect(() => {
    const cacheKey = getPaneRendererHostCacheKey(`pane:${panelId}`);
    acquireCachedViewerLease(cacheKey);
    return () => releaseCachedViewerLease(cacheKey);
  }, [panelId]);
  return null;
}

export function TabPortalProvider({
  children,
  onOpenAssistantSources,
  onConfigureHost,
  onChatHistoryPinnedChange,
}: TabPortalProviderProps) {
  useEffect(() => {
    debugLog('[TabPortalProvider] MOUNTED');
    return () => {
      debugLog('[TabPortalProvider] UNMOUNTING');
    };
  }, []);

  const panels = useCanvasStore((s) => s.panels);
  const workspaceVisible = useWorkspaceVisibility();

  const allTabs = useMemo(() => {
    const tabs: Array<{ panelId: string; tab: Tab }> = [];
    for (const [panelId, panel] of Object.entries(panels)) {
      for (const tab of panel.tabs) {
        tabs.push({ panelId, tab });
      }
    }
    return tabs;
  }, [panels]);

  const activeTabIds = useMemo(() => {
    const ids = new Set<string>();
    for (const panel of Object.values(panels)) {
      if (panel.activeTabId) ids.add(panel.activeTabId);
    }
    return ids;
  }, [panels]);

  useMemoryPressureMonitoring();
  const pressureLevel = useMemoryPressureLevel();
  const budgetedSequenceTabIds = useMemo(
    () => allTabs.filter(({ tab }) => isBudgetedSequenceTab(tab)).map(({ tab }) => tab.id),
    [allTabs]
  );
  const retainedSequenceTabIds = useMemo(() => {
    sequenceTabRetention.prune(new Set(budgetedSequenceTabIds));
    const visible = new Set(budgetedSequenceTabIds.filter((id) => activeTabIds.has(id)));
    for (const id of visible) sequenceTabRetention.touch(id);
    return sequenceTabRetention.retain(pressureLevel, visible);
  }, [budgetedSequenceTabIds, activeTabIds, pressureLevel]);

  const budgetedSequenceTabCountRef = useRef(0);
  useEffect(() => {
    const previous = budgetedSequenceTabCountRef.current;
    budgetedSequenceTabCountRef.current = budgetedSequenceTabIds.length;
    if (budgetedSequenceTabIds.length > previous) void requestMemoryPressureSample();
  }, [budgetedSequenceTabIds.length]);

  const hostsRef = useRef(new Map<string, HTMLDivElement>());

  const currentTabIds = useMemo(() => new Set(allTabs.map(({ tab }) => tab.id)), [allTabs]);

  useLayoutEffect(() => {
    for (const [id, el] of hostsRef.current) {
      if (!currentTabIds.has(id)) {
        debugLog('[TabPortalProvider] Cleaning up host for tab:', id);
        el.remove();
        hostsRef.current.delete(id);
      }
    }
  }, [currentTabIds]);

  for (const { tab } of allTabs) {
    if (!hostsRef.current.has(tab.id)) {
      debugLog('[TabPortalProvider] Creating host for tab:', tab.id, tab.type, tab.entityId);
      const el = document.createElement('div');
      el.className = 'h-full w-full';
      if (tab.type === 'chat') {
        el.dataset.analyticsBlock = 'true';
        el.classList.add('ph-no-capture');
      }
      el.id = `tab-content-${tab.id}`;
      hostsRef.current.set(tab.id, el);
    }
    const host = hostsRef.current.get(tab.id);
    if (host) host.dataset.testid = `tab-content-container-${tab.entityId}`;
  }

  return (
    <TabPortalContext.Provider value={hostsRef.current}>
      {Object.keys(panels).map((panelId) => (
        <PaneRendererHostLease key={panelId} panelId={panelId} />
      ))}
      {}
      {allTabs.map(({ panelId, tab }) => {
        const host = hostsRef.current.get(tab.id);
        if (!host) return null;
        const isActive = activeTabIds.has(tab.id);

        if (tab.type === 'structure' && (!isActive || !workspaceVisible)) return null;

        const budgeted = isBudgetedSequenceTab(tab);
        if (!isActive && budgeted && !retainedSequenceTabIds.has(tab.id)) return null;
        const content = (
          <PanelContent
            tab={tab}
            isActive={isActive}
            panelId={panelId}
            onOpenAssistantSources={onOpenAssistantSources}
            onConfigureHost={onConfigureHost}
            onChatHistoryPinnedChange={onChatHistoryPinnedChange}
          />
        );

        return createPortal(
          <PresentationHost
            id={`tab-${tab.id}`}
            parentId={`panel-${panelId}`}
            active={isActive}
            element={host}
          >
            <ErrorBoundary>
              {budgeted ? (
                <HiddenMapIdlePolicyContext.Provider value="host-retained">
                  {content}
                </HiddenMapIdlePolicyContext.Provider>
              ) : (
                content
              )}
            </ErrorBoundary>
          </PresentationHost>,
          host,
          tab.id
        );
      })}
      {}
      {children}
    </TabPortalContext.Provider>
  );
}
