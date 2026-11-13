import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
} from './FullChatView.test-harness';

describe('chat navigation controls', () => {
  beforeEach(() => resetFullChatViewHarness());

  it('creates a conversation from the compact plus without opening history', async () => {
    const { mockChatState } = getFullChatViewHarness();
    mockChatState.newConversation.mockResolvedValueOnce('compact-new-chat');
    const onConversationIdChange = vi.fn();
    render(
      <FullChatView workspacePath="/workspace" onConversationIdChange={onConversationIdChange} />
    );
    const button = screen.getByRole('button', { name: 'New conversation', exact: true });
    expect(button).toHaveTextContent('');
    fireEvent.mouseEnter(button);
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(onConversationIdChange).toHaveBeenCalledWith('compact-new-chat'));
    expect(mockChatState.newConversation).toHaveBeenCalledOnce();
    expect(screen.getByTestId('ai-input')).toHaveFocus();
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
  });

  it('keeps history pinned when the visible chat only loses panel focus', () => {
    const view = (isOpen: boolean) => (
      <FullChatView workspacePath="/workspace" isOpen={isOpen} isVisible />
    );
    const rendered = render(view(true));
    fireEvent.click(screen.getByTestId('ai-history-button'));
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'pinned');
    rendered.rerender(view(false));
    rendered.rerender(view(true));
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'pinned');
  });

  it('returns with history collapsed and keeps its toggle and layout synchronized', () => {
    const onHistoryPinnedChange = vi.fn();
    const view = (isOpen: boolean) => (
      <FullChatView
        workspacePath="/workspace"
        isOpen={isOpen}
        onHistoryPinnedChange={onHistoryPinnedChange}
      />
    );
    const rendered = render(view(true));
    fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'Retained draft' } });
    fireEvent.click(screen.getByTestId('ai-history-button'));
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'pinned');
    expect(onHistoryPinnedChange).toHaveBeenLastCalledWith(true);
    rendered.rerender(view(false));
    expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();
    rendered.rerender(view(true));
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-history-button')).toHaveAttribute('aria-expanded', 'false');
    expect(onHistoryPinnedChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId('ai-input')).toHaveValue('Retained draft');
    const toggle = screen.getByTestId('ai-history-button');
    fireEvent.mouseEnter(toggle);
    fireEvent.focus(toggle);
    fireEvent.click(toggle);
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'pinned');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('[data-history-pinned="true"]')).toBeNull();
  });
});
