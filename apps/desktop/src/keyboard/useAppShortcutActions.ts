import { useEffect } from 'react';
import { COMMAND_IDS, useCommandRegistry } from '../commands';
import { useCommandHandler } from '../commands/useCommandHandler';
import { useCanvasStore } from '../features/canvas/store';
import type { Tab } from '../features/canvas/types';
import { matchesAppShortcut } from './shortcutRegistry';

function pathForOpenTab(tab: Tab): string | null {
  const artifact = tab.artifactDocument;
  if (artifact?.artifactPath) return artifact.artifactPath;
  if (artifact?.destinationPath) return artifact.destinationPath;
  if (tab.sequenceDocument?.kind === 'managed-sequence') return tab.sequenceDocument.packageRoot;
  if (tab.entityId.includes('/') || tab.entityId.includes('\\')) return tab.entityId;
  return null;
}

export function useAppShortcutActions(onGoToFile: () => void): void {
  const { dispatchCommand } = useCommandRegistry();
  useCommandHandler(COMMAND_IDS.appGoToFile, onGoToFile);
  useCommandHandler(
    COMMAND_IDS.workspaceRevealActiveFile,
    () => {
      const canvas = useCanvasStore.getState();
      const panel = canvas.focusedPanelId ? canvas.panels[canvas.focusedPanelId] : undefined;
      const tab = panel?.tabs.find((item) => item.id === panel.activeTabId);
      const path = tab ? pathForOpenTab(tab) : null;
      if (!path) return false;
      return dispatchCommand(COMMAND_IDS.workspaceRevealPath, {
        source: 'ui',
        payload: { path },
      }).handled;
    },
    { surfaceId: 'workspace' }
  );
  useCommandHandler(
    COMMAND_IDS.canvasCloseOtherTabs,
    () => {
      const canvas = useCanvasStore.getState();
      const panelId = canvas.focusedPanelId;
      const panel = panelId ? canvas.panels[panelId] : undefined;
      if (!panelId || !panel?.activeTabId) return false;
      canvas.closeOtherTabs(panelId, panel.activeTabId);
      return true;
    },
    { surfaceId: 'workspace' }
  );
  useCommandHandler<{ index: number }>(
    COMMAND_IDS.canvasSelectTab,
    ({ event, payload }) => {
      const canvas = useCanvasStore.getState();
      const panelId = canvas.focusedPanelId;
      const panel = panelId ? canvas.panels[panelId] : undefined;
      if (!panelId || !panel || !panel.tabs.length) return false;
      const index =
        payload?.index ?? (event?.key === '0' ? panel.tabs.length - 1 : Number(event?.key) - 1);
      const tab = panel.tabs[index];
      if (!tab) return false;
      canvas.setActiveTab(panelId, tab.id);
      return true;
    },
    { surfaceId: 'workspace' }
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesAppShortcut(event, 'tabs.go-to')) return;
      if (event.target instanceof Element && event.target.closest('[data-terminal-surface]'))
        return;
      const result = dispatchCommand(COMMAND_IDS.canvasSelectTab, { source: 'keyboard', event });
      if (result.handled || result.blocked) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatchCommand]);
}
