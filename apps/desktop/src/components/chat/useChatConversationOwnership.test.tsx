import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatConversationOwnership } from './useChatConversationOwnership';

function renderOwnership(
  overrides: Partial<Parameters<typeof useChatConversationOwnership>[0]> = {}
) {
  const switchConversation = vi.fn();
  const hydrateConversation = vi.fn();
  const initial = {
    scoped: false,
    isOpen: true,
    conversationId: 'conversation-a',
    currentConversationId: 'conversation-b',
    conversationIsKnown: true,
    conversationHasState: true,
    switchConversation,
    hydrateConversation,
    ...overrides,
  };
  const result = renderHook((props) => useChatConversationOwnership(props), {
    initialProps: initial,
  });
  return { ...result, switchConversation, hydrateConversation, initial };
}

describe('useChatConversationOwnership', () => {
  it('claims a known conversation when its tab becomes active', () => {
    const { switchConversation } = renderOwnership();

    expect(switchConversation).toHaveBeenCalledOnce();
    expect(switchConversation).toHaveBeenCalledWith('conversation-a');
  });

  it('does not reclaim an unchanged tab binding while a New command retargets it', () => {
    const { rerender, switchConversation, initial } = renderOwnership({
      currentConversationId: 'conversation-a',
    });
    switchConversation.mockClear();

    rerender({ ...initial, currentConversationId: 'new-conversation' });

    expect(switchConversation).not.toHaveBeenCalled();
  });

  it('hydrates the current binding when its persisted transcript slice is still cold', () => {
    const { switchConversation, hydrateConversation } = renderOwnership({
      currentConversationId: 'conversation-a',
      conversationHasState: false,
    });

    expect(switchConversation).not.toHaveBeenCalled();
    expect(hydrateConversation).toHaveBeenCalledOnce();
    expect(hydrateConversation).toHaveBeenCalledWith('conversation-a');
  });

  it('claims its binding again after the pane loses and regains focus', () => {
    const { rerender, switchConversation, initial } = renderOwnership({
      currentConversationId: 'conversation-a',
    });
    rerender({ ...initial, isOpen: false, currentConversationId: 'conversation-b' });
    switchConversation.mockClear();

    rerender({ ...initial, isOpen: true, currentConversationId: 'conversation-b' });

    expect(switchConversation).toHaveBeenCalledOnce();
    expect(switchConversation).toHaveBeenCalledWith('conversation-a');
  });

  it('hydrates an inactive tab without claiming the global conversation', () => {
    const { switchConversation, hydrateConversation } = renderOwnership({ isOpen: false });

    expect(switchConversation).not.toHaveBeenCalled();
    expect(hydrateConversation).toHaveBeenCalledOnce();
    expect(hydrateConversation).toHaveBeenCalledWith('conversation-a');
  });
});
