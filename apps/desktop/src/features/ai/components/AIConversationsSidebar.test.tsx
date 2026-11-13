import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../orchestration/chat-store-types';

const state = vi.hoisted(() => ({
  chat: {
    conversations: [] as ConversationSummary[],
    conversationHistoryRead: { status: 'ready', hasLoaded: true },
    loadConversations: vi.fn(async () => undefined),
  },
  activeId: 'active-chat',
  questionId: null as string | null,
  approvalId: null as string | null,
  dispatchCommand: vi.fn(),
  resume: vi.fn(async () => 'opened'),
}));

vi.mock('../../../commands', () => ({
  COMMAND_IDS: { appNewChat: 'app.newChat' },
  useCommandRegistry: () => ({ dispatchCommand: state.dispatchCommand }),
}));
vi.mock('../../../hooks/useWorkspace', () => ({ useWorkspace: () => ({ path: null }) }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (value: { folders: never[] }) => unknown) =>
    selector({ folders: [] }),
}));
vi.mock('../../canvas/store', () => ({
  useCanvasStore: (selector: (value: unknown) => unknown) =>
    selector({
      focusedPanelId: 'main',
      panels: {
        main: {
          activeTabId: 'chat',
          tabs: [{ id: 'chat', type: 'chat', entityId: state.activeId }],
        },
      },
    }),
}));
vi.mock('../hooks/useChat', () => ({
  useChatStore: (selector: (value: typeof state.chat) => unknown) => selector(state.chat),
}));
vi.mock('../agent-confirm/agent-user-input-store', () => ({
  useAgentUserInputStore: (selector: (value: unknown) => unknown) =>
    selector({ request: state.questionId ? { conversationId: state.questionId } : null }),
}));
vi.mock('../agent-confirm/destructive-confirm-store', () => ({
  useDestructiveConfirmStore: (selector: (value: unknown) => unknown) =>
    selector({ request: state.approvalId ? { conversationId: state.approvalId } : null }),
}));
vi.mock('../public/chat-navigation', () => ({ resumeAIConversation: state.resume }));

import { AIConversationsSidebar } from './AIConversationsSidebar';

function conversation(id: string, updatedAt: number, pinned = false): ConversationSummary {
  return {
    id,
    title: id,
    workspacePath: '/project',
    pinned,
    provider: null,
    model: null,
    createdAt: 1,
    updatedAt,
  };
}

describe('AI conversations sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.chat.conversations = [];
    state.chat.conversationHistoryRead = { status: 'ready', hasLoaded: true };
    state.questionId = null;
    state.approvalId = null;
  });

  it('uses the shared compact rows and preserves pinned and recent ordering', () => {
    state.chat.conversations = [
      conversation('older', 1),
      conversation('active-chat', 3),
      conversation('pinned', 0, true),
    ];
    render(<AIConversationsSidebar />);
    const list = screen.getByTestId('ai-conversation-list');
    expect(list).toHaveAttribute('data-ui-navigation-list');
    const rows = within(list).getAllByTestId('ai-conversation-row');
    expect(rows.map((row) => row.dataset.conversationId)).toEqual([
      'pinned',
      'active-chat',
      'older',
    ]);
    expect(rows.every((row) => row.hasAttribute('data-ui-navigation-row'))).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Open recent conversation: active-chat' })
    ).toHaveAttribute('aria-current', 'page');
  });

  it('keeps cached chats visible through refresh failure and provides retry', () => {
    state.chat.conversations = [conversation('saved', 1)];
    state.chat.conversationHistoryRead = { status: 'error', hasLoaded: true };
    render(<AIConversationsSidebar />);
    expect(screen.getByRole('alert')).toHaveTextContent('Your saved chats are still shown');
    expect(screen.getByRole('button', { name: 'Open recent conversation: saved' })).toBeVisible();
    fireEvent.click(screen.getByTestId('ai-sidebar-history-retry'));
    expect(state.chat.loadConversations).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('ai-sidebar-history-empty')).not.toBeInTheDocument();
  });

  it('distinguishes first loading and failed initial history from a loaded empty history', () => {
    state.chat.conversationHistoryRead = { status: 'loading', hasLoaded: false };
    const { rerender } = render(<AIConversationsSidebar />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading chats');
    expect(screen.queryByTestId('ai-sidebar-history-empty')).not.toBeInTheDocument();
    state.chat.conversationHistoryRead = { status: 'error', hasLoaded: false };
    rerender(<AIConversationsSidebar />);
    expect(screen.getByRole('alert')).toHaveTextContent('Some chats may be missing');
    state.chat.conversationHistoryRead = { status: 'ready', hasLoaded: true };
    rerender(<AIConversationsSidebar />);
    expect(screen.getByTestId('ai-sidebar-history-empty')).toHaveTextContent(
      'No conversations yet'
    );
  });

  it('keeps both waiting identities and the oldest active saved chat reachable', () => {
    state.chat.conversations = Array.from({ length: 30 }, (_, index) =>
      conversation(`chat-${index}`, index)
    );
    state.chat.conversations.push(conversation('active-chat', -1));
    state.questionId = 'chat-0';
    state.approvalId = 'missing-waiting-chat';
    render(<AIConversationsSidebar />);
    expect(screen.getAllByTestId('ai-conversation-row')).toHaveLength(32);
    expect(
      screen.getByRole('button', { name: 'Open recent conversation: active-chat' })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Open recent conversation: chat-0' })
    ).toHaveTextContent('Needs your answer');
    expect(
      screen.getByRole('button', { name: 'Open recent conversation: Chat awaiting your answer' })
    ).toBeVisible();
  });

  it('delegates new chat to the existing command and saved-chat resume to the shared lifecycle', async () => {
    state.chat.conversations = [conversation('saved', 1)];
    render(<AIConversationsSidebar />);
    fireEvent.click(screen.getByTestId('ai-sidebar-new-conversation'));
    expect(state.dispatchCommand).toHaveBeenCalledWith('app.newChat', { source: 'ui' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open recent conversation: saved' }));
    });
    expect(state.resume).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'saved', workspacePath: null })
    );
  });
});
