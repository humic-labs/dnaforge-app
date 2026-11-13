import { useEffect, useMemo, useRef, useState } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { COMMAND_IDS, useCommandRegistry } from '../../../commands';
import { PlusIcon, RefreshIcon } from '../../../components/icons/glyphs';
import { NavigationAction, NavigationList, NavigationRow } from '../../../components/ui/navigation';
import {
  UI_NAVIGATION_EMPTY_CLASS,
  UI_NAVIGATION_GROUP_CLASS,
  UI_NAVIGATION_HEADER_CLASS,
  UI_NAVIGATION_PANEL_CLASS,
} from '../../../components/ui/styles';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { useToastStore } from '../../../stores/toast-store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import { useAgentUserInputStore } from '../agent-confirm/agent-user-input-store';
import { useDestructiveConfirmStore } from '../agent-confirm/destructive-confirm-store';
import { useChatStore } from '../hooks/useChat';
import { orderConversationSummaries } from '../orchestration/chat-conversation-list';
import { resolveChatWorkspacePath } from '../../canvas/public/components/chat-workspace';
import { resumeAIConversation } from '../public/chat-navigation';

export function AIConversationsSidebar() {
  const { dispatchCommand } = useCommandRegistry();
  const { path: workspacePath } = useWorkspace();
  const folders = useWorkspaceStore((state) => state.folders);
  const conversations = useChatStore((state) => state.conversations);
  const historyRead = useChatStore((state) => state.conversationHistoryRead);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const activeConversationId = useCanvasStore((state) => {
    const panel = state.focusedPanelId ? state.panels[state.focusedPanelId] : undefined;
    const tab = panel?.tabs.find((candidate) => candidate.id === panel.activeTabId);
    return tab?.type === 'chat' ? tab.entityId : null;
  });
  const questionConversationId = useAgentUserInputStore((state) => state.request?.conversationId);
  const approvalConversationId = useDestructiveConfirmStore(
    (state) => state.request?.conversationId
  );
  const [openingConversationId, setOpeningConversationId] = useState<string | null>(null);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const rows = useMemo(() => {
    const waitingIds = new Set([questionConversationId, approvalConversationId].filter(Boolean));
    const ordered = orderConversationSummaries(conversations).map((conversation) => ({
      id: conversation.id,
      title: conversation.title.trim() || 'Untitled chat',
      workspacePath: conversation.workspacePath,
      pinned: conversation.pinned,
      waiting: waitingIds.has(conversation.id),
    }));
    for (const id of waitingIds) {
      if (id && !ordered.some((conversation) => conversation.id === id)) {
        ordered.unshift({
          id,
          title: 'Chat awaiting your answer',
          workspacePath: null,
          pinned: false,
          waiting: true,
        });
      }
    }
    return ordered;
  }, [approvalConversationId, conversations, questionConversationId]);

  useEffect(() => {
    mounted.current = true;
    void loadConversations().catch(() => undefined);
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, [loadConversations]);

  const refreshHistory = () => {
    void loadConversations().catch(() => undefined);
  };
  const resumeConversation = async (conversationId: string) => {
    const request = ++requestGeneration.current;
    setOpeningConversationId(conversationId);
    try {
      const result = await resumeAIConversation({
        conversationId,
        workspacePath: resolveChatWorkspacePath(workspacePath, folders),
        isCurrent: () => mounted.current && request === requestGeneration.current,
      });
      if (result === 'stale') {
        if (mounted.current && request === requestGeneration.current) refreshHistory();
        return;
      }
      if (result !== 'opened') return;
      window.requestAnimationFrame(() => {
        if (!mounted.current || request !== requestGeneration.current) return;
        safeFocus(
          document.querySelector<HTMLTextAreaElement>(
            '[data-panel-focused="true"] [data-testid="ai-input"]:not(:disabled)'
          ),
          { preventScroll: true }
        );
      });
    } catch (error) {
      if (!mounted.current || request !== requestGeneration.current) return;
      console.error('[AIConversationsSidebar] Failed to open a saved chat:', error);
      useToastStore.getState().addToast(toUserMessage("Couldn't open that chat — try again."), {
        definition: 'chat-history-failed',
      });
    } finally {
      if (mounted.current && request === requestGeneration.current) setOpeningConversationId(null);
    }
  };
  const historyMessage =
    historyRead.status === 'idle'
      ? 'Chat history has not loaded.'
      : historyRead.status === 'loading'
        ? historyRead.hasLoaded
          ? 'Refreshing chats…'
          : 'Loading chats…'
        : historyRead.status === 'error'
          ? historyRead.hasLoaded
            ? 'Chat history could not be refreshed. Your saved chats are still shown.'
            : 'Chat history could not be loaded. Some chats may be missing.'
          : null;

  return (
    <section
      className={UI_NAVIGATION_PANEL_CLASS}
      data-testid="ai-conversations-sidebar"
      aria-label="AI Tools"
    >
      <div className={UI_NAVIGATION_HEADER_CLASS}>
        <span>AI Tools</span>
        <NavigationAction
          id="new-conversation"
          label="New conversation"
          icon={<PlusIcon />}
          testId="ai-sidebar-new-conversation"
          onInvoke={() => dispatchCommand(COMMAND_IDS.appNewChat, { source: 'ui' })}
        />
      </div>
      <div className={UI_NAVIGATION_HEADER_CLASS}>
        <span>Recent conversations</span>
        <NavigationAction
          id="refresh-conversations"
          label="Refresh history"
          icon={<RefreshIcon />}
          testId="ai-sidebar-refresh-history"
          disabled={historyRead.status === 'loading'}
          onInvoke={refreshHistory}
        />
      </div>
      <NavigationList
        data-testid="ai-conversation-list"
        data-history-read-status={historyRead.status}
        data-history-has-loaded={historyRead.hasLoaded}
        aria-label="Recent conversations"
        aria-busy={historyRead.status === 'loading'}
      >
        {historyMessage ? (
          <div className={UI_NAVIGATION_GROUP_CLASS}>
            <p
              className={UI_NAVIGATION_EMPTY_CLASS}
              role={historyRead.status === 'error' ? 'alert' : 'status'}
              data-testid="ai-sidebar-history-read-state"
            >
              {historyMessage}
            </p>
            {historyRead.status === 'idle' || historyRead.status === 'error' ? (
              <NavigationAction
                id="retry-history"
                label={historyRead.status === 'idle' ? 'Load history' : 'Retry history'}
                testId="ai-sidebar-history-retry"
                onInvoke={refreshHistory}
              />
            ) : null}
          </div>
        ) : null}
        {historyRead.status === 'ready' && rows.length === 0 ? (
          <p className={UI_NAVIGATION_EMPTY_CLASS} data-testid="ai-sidebar-history-empty">
            No conversations yet. Start a new chat with the plus button.
          </p>
        ) : null}
        {rows.map((conversation) => (
          <NavigationRow
            key={conversation.id}
            data-testid="ai-conversation-row"
            data-conversation-id={conversation.id}
            data-pinned={conversation.pinned || undefined}
            data-waiting={conversation.waiting || undefined}
            title={conversation.title}
            detail={conversation.workspacePath ?? undefined}
            metadata={conversation.pinned ? 'Pinned' : undefined}
            status={
              conversation.waiting
                ? { label: 'Needs your answer', tone: 'warning' }
                : openingConversationId === conversation.id
                  ? { label: 'Opening…', tone: 'neutral' }
                  : undefined
            }
            primaryLabel={`Open recent conversation: ${conversation.title}`}
            selection={{ kind: 'page', selected: conversation.id === activeConversationId }}
            onActivate={() => void resumeConversation(conversation.id)}
          />
        ))}
      </NavigationList>
    </section>
  );
}
