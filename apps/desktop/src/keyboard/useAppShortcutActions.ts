import { useEffect } from 'react';
import { COMMAND_IDS, useCommandRegistry } from '../commands';
import { keyboardCommandBelongsToTarget } from '../commands/commandRegistry';
import { useChatStore } from '../features/ai/hooks/useChat';
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[data-terminal-surface]'))
        return;
      if (matchesAppShortcut(event, 'app.go-to-file')) {
        event.preventDefault();
        event.stopPropagation();
        onGoToFile();
        return;
      }

      if (matchesAppShortcut(event, 'files.show-in-project')) {
        const canvas = useCanvasStore.getState();
        const panelId = canvas.focusedPanelId;
        const panel = panelId ? canvas.panels[panelId] : undefined;
        const tab = panel?.tabs.find((item) => item.id === panel.activeTabId);
        const path = tab ? pathForOpenTab(tab) : null;
        if (!path) return;
        event.preventDefault();
        event.stopPropagation();
        dispatchCommand(COMMAND_IDS.workspaceRevealPath, {
          source: 'keyboard',
          payload: { path },
        });
        return;
      }

      if (matchesAppShortcut(event, 'tabs.close-others')) {
        const canvas = useCanvasStore.getState();
        const panelId = canvas.focusedPanelId;
        const panel = panelId ? canvas.panels[panelId] : undefined;
        if (!panelId || !panel?.activeTabId) return;
        event.preventDefault();
        event.stopPropagation();
        canvas.closeOtherTabs(panelId, panel.activeTabId);
        return;
      }

      if (
        matchesAppShortcut(event, 'pdf.reset-zoom') &&
        !keyboardCommandBelongsToTarget(event, COMMAND_IDS.pdfResetZoom)
      ) {
        const result = dispatchCommand(COMMAND_IDS.pdfResetZoom, { source: 'keyboard', event });
        if (result.handled || result.blocked) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      if (matchesAppShortcut(event, 'tabs.go-to')) {
        const canvas = useCanvasStore.getState();
        const panelId = canvas.focusedPanelId;
        const panel = panelId ? canvas.panels[panelId] : undefined;
        if (!panelId || !panel || panel.tabs.length === 0) return;
        const tab =
          event.key === '0' ? panel.tabs[panel.tabs.length - 1] : panel.tabs[Number(event.key) - 1];
        if (!tab) return;
        event.preventDefault();
        event.stopPropagation();
        canvas.setActiveTab(panelId, tab.id);
        return;
      }

      if (matchesAppShortcut(event, 'chat.previous') || matchesAppShortcut(event, 'chat.next')) {
        const chat = useChatStore.getState();
        const index = chat.conversations.findIndex(
          (conversation) => conversation.id === chat.currentConversationId
        );
        const step = matchesAppShortcut(event, 'chat.next') ? 1 : -1;
        const next = chat.conversations[index + step];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        void chat.switchConversation(next.id);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dispatchCommand, onGoToFile]);
}
