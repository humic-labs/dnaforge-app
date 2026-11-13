// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inline: null as {
    conversationId: string;
    workspacePath: string | null;
    anchor?: { x: number; y: number };
    sourcePanelId?: string;
  } | null,
  setAskAiInlineChat: vi.fn(),
  switchConversation: vi.fn(),
  retargetChatTabOpposite: vi.fn(),
}));

vi.mock('../../features/ai/hooks/useChat', () => {
  const snapshot = () => ({
    askAiInlineChat: h.inline,
    setAskAiInlineChat: h.setAskAiInlineChat,
    switchConversation: h.switchConversation,
  });
  const useChatStore = (selector: (s: unknown) => unknown) => selector(snapshot());
  useChatStore.getState = snapshot;
  return { useChatStore };
});

vi.mock('../../features/canvas/store', () => ({
  useCanvasStore: {
    getState: () => ({ retargetChatTabOpposite: h.retargetChatTabOpposite }),
  },
}));

vi.mock('../FullChatView', () => ({
  FullChatView: (props: {
    scoped?: boolean;
    conversationId?: string;
    workspacePath: string | null;
    hideHeader?: boolean;
  }) => (
    <div
      data-testid="mock-full-chat"
      data-scoped={String(props.scoped)}
      data-conversation-id={props.conversationId}
      data-workspace={String(props.workspacePath)}
      data-hide-header={String(props.hideHeader)}
    />
  ),
}));

import { AskAiInlineChatHost } from './AskAiInlineChatHost';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  h.inline = null;
  h.setAskAiInlineChat.mockClear();
  h.switchConversation.mockClear();
  h.retargetChatTabOpposite.mockClear();
});

describe('AskAiInlineChatHost  #49 inline chat)', () => {
  it.each([undefined, { x: 970, y: 90 }])(
    'opens wide enough for the composer toolbar with anchor %j',
    (anchor) => {
      vi.stubGlobal('innerWidth', 1200);
      h.inline = { conversationId: 'conv-inline', workspacePath: null, anchor };
      render(<AskAiInlineChatHost />);

      const panel = screen.getByTestId('ask-ai-inline-chat');
      expect(parseFloat(panel.style.width)).toBeGreaterThanOrEqual(720);
      expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(
        1188
      );
    }
  );

  it('preserves the toolbar width floor when the app window shrinks', () => {
    vi.stubGlobal('innerWidth', 1200);
    h.inline = { conversationId: 'conv-inline', workspacePath: null };
    render(<AskAiInlineChatHost />);

    vi.stubGlobal('innerWidth', 800);
    fireEvent(window, new Event('resize'));

    const panel = screen.getByTestId('ask-ai-inline-chat');
    expect(parseFloat(panel.style.width)).toBeGreaterThanOrEqual(720);
    expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(788);
  });

  it('renders NOTHING when no inline chat is staged', () => {
    h.inline = null;
    render(<AskAiInlineChatHost />);
    expect(screen.queryByTestId('ask-ai-inline-chat')).toBeNull();
  });

  it('mounts a SCOPED FullChatView for the staged conversation', () => {
    h.inline = {
      conversationId: 'conv-inline',
      workspacePath: '/ws/proj',
      anchor: { x: 120, y: 90 },
    };
    render(<AskAiInlineChatHost />);

    const panel = screen.getByTestId('ask-ai-inline-chat');
    expect(panel).toHaveAttribute('data-conversation-id', 'conv-inline');

    const chat = screen.getByTestId('mock-full-chat');

    expect(chat).toHaveAttribute('data-scoped', 'true');
    expect(chat).toHaveAttribute('data-conversation-id', 'conv-inline');
    expect(chat).toHaveAttribute('data-workspace', '/ws/proj');
    expect(chat).toHaveAttribute('data-hide-header', 'true');
  });

  it('"Open in chat pane" hands the same conversation to the pane opposite its source', () => {
    h.inline = {
      conversationId: 'conv-inline',
      workspacePath: '/ws/proj',
      sourcePanelId: 'panel-source',
    };
    render(<AskAiInlineChatHost />);

    fireEvent.click(screen.getByTestId('ask-ai-inline-open-in-pane'));

    expect(h.retargetChatTabOpposite).toHaveBeenCalledWith('panel-source', 'conv-inline');
    expect(h.switchConversation).toHaveBeenCalledWith('conv-inline');
    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(null);
  });

  it('the close button dismisses WITHOUT touching the pane (no retarget)', () => {
    h.inline = { conversationId: 'conv-inline', workspacePath: null };
    render(<AskAiInlineChatHost />);

    fireEvent.click(screen.getByTestId('ask-ai-inline-close'));

    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(null);
    expect(h.retargetChatTabOpposite).not.toHaveBeenCalled();
    expect(h.switchConversation).not.toHaveBeenCalled();
  });

  it('Esc dismisses the popup', () => {
    h.inline = { conversationId: 'conv-inline', workspacePath: null };
    render(<AskAiInlineChatHost />);

    fireEvent.keyDown(screen.getByTestId('ask-ai-inline-chat'), { key: 'Escape' });

    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(null);
  });
});
