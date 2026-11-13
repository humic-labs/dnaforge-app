import { useCallback } from 'react';
import { useCanvasStore } from '../store';
import type { TabViewState } from '../types';

export function useTabViewState(
  entityId: string
): [TabViewState | undefined, (updates: Partial<TabViewState>) => void] {
  const viewState = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((t) => t.entityId === entityId);
      if (tab) {
        return tab.viewState;
      }
    }
    return undefined;
  });

  const setViewState = useCallback(
    (updates: Partial<TabViewState>) => {
      const state = useCanvasStore.getState();
      for (const [panelId, panel] of Object.entries(state.panels)) {
        const tab = panel.tabs.find((t) => t.entityId === entityId);
        if (tab) {
          state.setTabViewState(panelId, tab.id, updates);
          return;
        }
      }
      console.warn(`[useTabViewState] Tab not found for entityId: ${entityId}`);
    },
    [entityId]
  );

  return [viewState, setViewState];
}
