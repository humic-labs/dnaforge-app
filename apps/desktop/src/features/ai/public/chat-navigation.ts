import { useCanvasStore } from '../../canvas/public/store';

let navigationGeneration = 0;

export function beginAIChatNavigation(): { isCurrent: () => boolean } {
  const generation = ++navigationGeneration;
  return { isCurrent: () => generation === navigationGeneration };
}

export interface ResumeAIConversationRequest {
  readonly conversationId: string;
  readonly workspacePath: string | null;
  readonly isCurrent: () => boolean;
}

export async function resumeAIConversation({
  conversationId,
  workspacePath,
  isCurrent,
}: ResumeAIConversationRequest): Promise<'opened' | 'stale' | 'superseded'> {
  const navigation = beginAIChatNavigation();
  const source = useCanvasStore.getState();
  const sourcePanelId = source.focusedPanelId;
  const sourcePanel = sourcePanelId ? source.panels[sourcePanelId] : undefined;
  const sourceTabId = sourcePanel?.activeTabId;
  const sourceTab = sourcePanel?.tabs.find((tab) => tab.id === sourceTabId);
  const sourceEntityId = sourceTab?.entityId;
  const sourceConversationId = sourceTab?.type === 'chat' ? sourceTab.entityId : null;
  const ownsSourceTab = () => {
    const current = useCanvasStore.getState();
    const currentPanel = current.focusedPanelId
      ? current.panels[current.focusedPanelId]
      : undefined;
    const currentTab = currentPanel?.tabs.find((tab) => tab.id === currentPanel.activeTabId);
    return (
      current.focusedPanelId === sourcePanelId &&
      currentPanel?.activeTabId === sourceTabId &&
      currentTab?.entityId === sourceEntityId
    );
  };
  const { useChatStore } = await import('../hooks/useChat');
  if (!navigation.isCurrent() || !isCurrent() || !ownsSourceTab()) return 'superseded';
  let disposition: 'applied' | 'available' | 'stale';
  try {
    disposition = await useChatStore.getState().switchConversation(conversationId, {
      sourceConversationId,
      workspacePath,
    });
  } catch (error) {
    if (!navigation.isCurrent() || !isCurrent()) return 'superseded';
    throw error;
  }
  if (disposition === 'stale') return 'stale';

  if (
    !navigation.isCurrent() ||
    !isCurrent() ||
    useChatStore.getState().currentConversationId !== conversationId ||
    !ownsSourceTab()
  ) {
    return 'superseded';
  }
  useCanvasStore.getState().retargetChatTab(conversationId);
  return 'opened';
}
