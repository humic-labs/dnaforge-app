import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
} from './FullChatView.test-harness';

const { mockAISettingsState, mockChatState } = getFullChatViewHarness();

describe('FullChatView — SCOPED mode  #49 inline chat foundation)', () => {
  beforeEach(resetFullChatViewHarness);

  it('renders the scoped conversation from _convStates and NEVER claims the global active pointer', () => {
    mockChatState.currentConversationId = 'active-A';
    mockChatState.messages = [
      { id: 'm-a', role: 'assistant', content: 'ACTIVE-A-ANSWER', createdAt: 1 },
    ] as typeof mockChatState.messages;
    (mockChatState._convStates as Map<string, unknown>).set('scoped-B', {
      messages: [{ id: 'm-b', role: 'user', content: 'SCOPED-B-QUESTION', createdAt: 2 }],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
    });

    render(<FullChatView workspacePath="/workspace" conversationId="scoped-B" scoped />);

    expect(screen.getByText('SCOPED-B-QUESTION')).toBeInTheDocument();
    expect(screen.queryByText('ACTIVE-A-ANSWER')).not.toBeInTheDocument();
    expect(mockChatState.switchConversation).not.toHaveBeenCalled();
    expect(mockChatState.hydrateConversation).toHaveBeenCalledWith('scoped-B');
  });

  it('CONTRAST — an UNSCOPED view still switches to its conversation (pane behaviour intact)', () => {
    mockChatState.currentConversationId = 'active-A';
    mockChatState.conversations = [
      { id: 'other-conv' },
    ] as unknown as typeof mockChatState.conversations;

    render(<FullChatView workspacePath="/workspace" conversationId="other-conv" />);

    expect(mockChatState.switchConversation).toHaveBeenCalledWith('other-conv');
  });

  it('does not let a mounted inactive chat tab claim the global conversation', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.conversations = [
      { id: 'visible-conv' },
      { id: 'inactive-conv' },
    ] as unknown as typeof mockChatState.conversations;

    render(
      <FullChatView workspacePath="/workspace" conversationId="inactive-conv" isOpen={false} />
    );

    expect(mockChatState.switchConversation).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();
  });

  it('submits from an inactive mounted pane without claiming an empty global owner', () => {
    mockChatState.currentConversationId = null;
    (mockChatState._convStates as Map<string, unknown>).set('inactive-conv', {
      messages: [],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
      queuedMessages: [],
    });

    render(
      <FullChatView workspacePath="/workspace" conversationId="inactive-conv" isOpen={false} />
    );
    fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'Inactive question' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      'Inactive question',
      '/workspace',
      'inactive-conv',
      [],
      {
        claimIfUnowned: false,
        activateConversation: false,
        attachments: [],
        onNotStarted: expect.any(Function),
      }
    );
  });

  it('opens the Connect-AI modal from the SCOPED inline chat', () => {
    mockAISettingsState.isConfigured = false;
    mockAISettingsState.provider = 'openai';
    mockAISettingsState.model = 'gpt-4o';
    mockAISettingsState.assistantRoute = { kind: 'provider', provider: 'openai', model: 'gpt-4o' };
    mockAISettingsState.providerStatuses = {
      anthropic: { isConfigured: false },
      openai: { isConfigured: false },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    };
    (mockChatState._convStates as Map<string, unknown>).set('scoped-connect', {
      messages: [{ id: 's1', role: 'user', content: 'scoped question', createdAt: 1 }],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
    });

    render(<FullChatView workspacePath="/workspace" conversationId="scoped-connect" scoped />);
    fireEvent.click(screen.getByTestId('chat-direct-api-key-warning'));

    expect(screen.getByTestId('connect-ai-modal')).toBeInTheDocument();
    expect(mockChatState.switchConversation).not.toHaveBeenCalled();
  });

  it('clears and submits only the scoped conversation without claiming an empty global owner', () => {
    (mockChatState._convStates as Map<string, unknown>).set('scoped-send', {
      messages: [],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: 'Old scoped error',
      queuedMessages: [],
    });

    render(<FullChatView workspacePath="/workspace" conversationId="scoped-send" scoped />);
    fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'Scoped question' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    expect(mockChatState.setError).toHaveBeenCalledWith(null, 'scoped-send');
    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      'Scoped question',
      '/workspace',
      'scoped-send',
      [],
      {
        claimIfUnowned: false,
        activateConversation: false,
        attachments: [],
        onNotStarted: expect.any(Function),
      }
    );
  });
});
