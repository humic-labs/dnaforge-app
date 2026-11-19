import { createContext, useContext, useRef, useMemo, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '../store';
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
import {
  agentStructureRendererHostId,
  rendererSlotTabId,
  retainedInspectionRendererSlot,
  StructureRendererHostProvider,
  useAgentStructureRenderers,
} from '../../page/public/embeds/structure3d/agentStructureRenderers';
import {
  inspectionProteinKey,
  type StructureInspection,
} from '../../structure-drawer/public/structure-inspection';

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

function PaneRendererHostLease({ rendererHostId }: { rendererHostId: string }) {
  useEffect(() => {
    const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
    acquireCachedViewerLease(cacheKey);
    return () => releaseCachedViewerLease(cacheKey);
  }, [rendererHostId]);
  return null;
}

const AGENT_STRUCTURE_STAGE_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  top: 0,
  width: 768,
  height: 768,
  opacity: 0,
  zIndex: -1,
  pointerEvents: 'none',
  overflow: 'hidden',
  contain: 'strict',
};

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

  const agentRendererTabIds = useAgentStructureRenderers((state) => state.tabIds);
  const agentHostedTabIds = useMemo(
    () =>
      new Set(
        allTabs
          .filter(
            ({ tab }) =>
              tab.type === 'structure' &&
              !activeTabIds.has(tab.id) &&
              agentRendererTabIds.includes(tab.id)
          )
          .map(({ tab }) => tab.id)
      ),
    [allTabs, activeTabIds, agentRendererTabIds]
  );
  const retainedInspections = useMemo(
    () =>
      agentRendererTabIds.flatMap((slot) => {
        const entry = allTabs.find(({ tab }) => tab.id === rendererSlotTabId(slot));
        const inspection = entry?.tab.structureInspection;
        if (!entry || !inspection || slot === entry.tab.id) return [];
        const currentKey = inspectionProteinKey(inspection.request);
        const proteinKey = Object.keys(inspection.retainedProteinViews ?? {}).find(
          (key) => key !== currentKey && retainedInspectionRendererSlot(entry.tab.id, key) === slot
        );
        const view = proteinKey ? inspection.retainedProteinViews?.[proteinKey] : undefined;
        if (!view?.request) return [];
        const retained: StructureInspection = {
          ...view,
          request: view.request,
          mutationCamera: 'keep',
          retainedProteinViews: inspection.retainedProteinViews,
        };
        return [
          { slot, panelId: entry.panelId, tab: { ...entry.tab, structureInspection: retained } },
        ];
      }),
    [agentRendererTabIds, allTabs]
  );
  const retainedHostsRef = useRef(new Map<string, HTMLDivElement>());
  for (const { slot } of retainedInspections) {
    if (!retainedHostsRef.current.has(slot)) {
      const el = document.createElement('div');
      el.className = 'h-full w-full';
      retainedHostsRef.current.set(slot, el);
    }
  }
  const agentStageRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stage = agentStageRef.current;
    if (!stage) return;
    for (const [id, host] of hostsRef.current) {
      if (agentHostedTabIds.has(id)) {
        if (host.parentNode !== stage) stage.appendChild(host);
      } else if (host.parentNode === stage) {
        stage.removeChild(host);
      }
    }
    const slots = new Set(retainedInspections.map(({ slot }) => slot));
    for (const [slot, host] of retainedHostsRef.current) {
      if (slots.has(slot)) {
        if (host.parentNode !== stage) stage.appendChild(host);
      } else {
        host.remove();
        retainedHostsRef.current.delete(slot);
      }
    }
  }, [agentHostedTabIds, retainedInspections]);

  return (
    <TabPortalContext.Provider value={hostsRef.current}>
      {Object.keys(panels).map((panelId) => (
        <PaneRendererHostLease key={panelId} rendererHostId={`pane:${panelId}`} />
      ))}
      {[...agentHostedTabIds, ...retainedInspections.map(({ slot }) => slot)].map((slot) => (
        <PaneRendererHostLease key={slot} rendererHostId={agentStructureRendererHostId(slot)} />
      ))}
      {retainedInspections.map(({ slot, panelId, tab }) => {
        const host = retainedHostsRef.current.get(slot);
        if (!host) return null;
        return createPortal(
          <PresentationHost
            id={`tab-${tab.id}-${slot}`}
            parentId={`panel-${panelId}`}
            active={false}
            element={host}
          >
            <ErrorBoundary>
              <StructureRendererHostProvider value={agentStructureRendererHostId(slot)}>
                <PanelContent
                  tab={tab}
                  isActive={false}
                  panelId={panelId}
                  onOpenAssistantSources={onOpenAssistantSources}
                  onConfigureHost={onConfigureHost}
                  onChatHistoryPinnedChange={onChatHistoryPinnedChange}
                />
              </StructureRendererHostProvider>
            </ErrorBoundary>
          </PresentationHost>,
          host,
          slot
        );
      })}
      <div
        ref={agentStageRef}
        aria-hidden="true"
        data-testid="agent-structure-stage"
        style={AGENT_STRUCTURE_STAGE_STYLE}
      />
      {allTabs.map(({ panelId, tab }) => {
        const host = hostsRef.current.get(tab.id);
        if (!host) return null;
        const isActive = activeTabIds.has(tab.id);
        const agentHosted = agentHostedTabIds.has(tab.id);

        if (tab.type === 'structure' && !isActive && !agentHosted) return null;

        const budgeted = isBudgetedSequenceTab(tab);
        if (!isActive && budgeted && !retainedSequenceTabIds.has(tab.id)) return null;
        const panelContent = (
          <PanelContent
            tab={tab}
            isActive={isActive}
            panelId={panelId}
            onOpenAssistantSources={onOpenAssistantSources}
            onConfigureHost={onConfigureHost}
            onChatHistoryPinnedChange={onChatHistoryPinnedChange}
          />
        );
        const content = agentHosted ? (
          <StructureRendererHostProvider value={agentStructureRendererHostId(tab.id)}>
            {panelContent}
          </StructureRendererHostProvider>
        ) : (
          panelContent
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
