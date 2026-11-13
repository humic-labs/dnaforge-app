import { useCallback } from 'react';
import { useCanvasStore } from '../../canvas/public/store';

interface HighlightRange {
  start: number;
  end: number;
  wraps?: boolean;
}

interface ReferenceHighlightResult {
  highlightRange: HighlightRange | null;
  scrollPosition: number | null;
  navigationRequestId: number | string | null;
  onHighlightApplied: () => void;
  onScrollApplied: () => void;
}

function findTabByEntityId(documentId: string) {
  const state = useCanvasStore.getState();
  for (const panel of Object.values(state.panels)) {
    const tab = panel.tabs.find((t) => t.entityId === documentId);
    if (tab) {
      return { panelId: panel.id, tabId: tab.id };
    }
  }
  return null;
}

export function useReferenceHighlight(documentId: string): ReferenceHighlightResult {
  const pendingHighlight = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === documentId);
      if (tab?.pendingViewState?.highlightRange) {
        return tab.pendingViewState.highlightRange as HighlightRange;
      }
    }
    return null;
  });

  const pendingScroll = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === documentId);
      if (tab?.pendingViewState?.scrollPosition != null) {
        return tab.pendingViewState.scrollPosition as number;
      }
    }
    return null;
  });

  const viewStateHighlight = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === documentId);
      if (tab?.viewState?.highlightRange) {
        return tab.viewState.highlightRange as HighlightRange;
      }
    }
    return null;
  });

  const viewStateScroll = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === documentId);
      if (tab?.viewState?.scrollPosition != null) {
        return tab.viewState.scrollPosition as number;
      }
    }
    return null;
  });

  const pendingNavigationRequestId = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === documentId);
      const requestId = tab?.pendingViewState?.sequenceNavigationRequestId;
      if (requestId != null) return requestId as number | string;
    }
    return null;
  });

  const viewStateNavigationRequestId = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === documentId);
      const requestId = tab?.viewState?.sequenceNavigationRequestId;
      if (requestId != null) return requestId as number | string;
    }
    return null;
  });

  const highlightRange = pendingHighlight ?? viewStateHighlight;
  const scrollPosition = pendingScroll ?? viewStateScroll;
  const navigationRequestId = pendingNavigationRequestId ?? viewStateNavigationRequestId;

  const onHighlightApplied = useCallback(() => {
    const tabInfo = findTabByEntityId(documentId);
    if (!tabInfo) return;
    const store = useCanvasStore.getState();

    if (pendingHighlight) {
      store.clearPendingViewState(tabInfo.panelId, tabInfo.tabId);
    }
    if (viewStateHighlight) {
      store.setTabViewState(tabInfo.panelId, tabInfo.tabId, {
        highlightRange: undefined,
      });
    }
  }, [documentId, pendingHighlight, viewStateHighlight]);

  const onScrollApplied = useCallback(() => {
    const tabInfo = findTabByEntityId(documentId);
    if (!tabInfo) return;
    const store = useCanvasStore.getState();

    if (pendingScroll != null) {
      store.clearPendingViewState(tabInfo.panelId, tabInfo.tabId);
    }
    if (viewStateScroll != null) {
      store.setTabViewState(tabInfo.panelId, tabInfo.tabId, {
        scrollPosition: undefined,
      });
    }
  }, [documentId, pendingScroll, viewStateScroll]);

  return {
    highlightRange,
    scrollPosition,
    navigationRequestId,
    onHighlightApplied,
    onScrollApplied,
  };
}
