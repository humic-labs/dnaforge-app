import { userMessage } from '@waypoint/user-messages';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostedCodexTestBridge = vi.hoisted(() => ({
  prepareHostedCodexContribution: vi.fn().mockResolvedValue({ started: true, error: null }),
  cancelPreparedTurn: vi.fn().mockResolvedValue({ ok: true }),
  startTurn: vi.fn(),
  stopTurn: vi.fn().mockResolvedValue({ ok: true }),
  onTurnEvent: vi.fn().mockReturnValue(() => undefined),
}));

vi.mock('../hosted-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hosted-gateway')>();
  return {
    ...actual,
    prepareHostedCodexContribution: hostedCodexTestBridge.prepareHostedCodexContribution,
    hostedCodexBridge: () => ({
      cancelPreparedTurn: hostedCodexTestBridge.cancelPreparedTurn,
      startTurn: hostedCodexTestBridge.startTurn,
      stopTurn: hostedCodexTestBridge.stopTurn,
      onTurnEvent: hostedCodexTestBridge.onTurnEvent,
    }),
  };
});

vi.mock('../assistant-hosts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assistant-hosts')>();
  return {
    ...actual,
    hostedAiEnabledInThisBuild: () => true,
    DEFAULT_ASSISTANT_HOST_DESCRIPTORS: actual.createDefaultAssistantHostDescriptors(true),
  };
});

import {
  cliConversationMessages,
  createModel,
  db,
  decodeAgentActivityMessage,
  getEntityReferencesByIds,
  getUseChatConversationHarness,
  markChatConversationDeleted,
  mockErrorStream,
  mockTextStream,
  promptDataFenceRecords,
  resetUseChatConversationHarness,
  streamText,
  useAISettingsStore,
  useChatStore,
  useStructure3dStore,
  useWorkspaceStore,
} from '../../../test/ai/useChat-harness';

const {
  mockAgentSessionOnEvent,
  mockAgentSessionStart,
  mockConversationLedgerAppendEvent,
  mockReconcileCliWorkspaceChanges,
  mockScanWorkspaceFiles,
  mockResolveRegisteredProject,
  mockListRegisteredProjects,
} = getUseChatConversationHarness();

describe('runChatTurn direct-provider execution', () => {
  beforeEach(resetUseChatConversationHarness);

  it('persists a bounded Hosted reason when the desktop bridge rejects with secret-bearing text', async () => {
    const secret = 'PRIVATE sk-proj-hosted-bridge-secret';
    hostedCodexTestBridge.startTurn.mockRejectedValueOnce(new Error(secret));
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: { kind: 'hosted', tier: 'auto' },
      hostedRouteReadiness: 'ready',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey: vi.fn().mockResolvedValue(null),
    } as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Use Hosted AI', '/workspace', 'hosted-bridge-rejection');
    });

    const terminalCommit = vi.mocked(db.commitChatTurnTerminalState).mock.calls.at(-1)?.[0];
    expect(terminalCommit).toMatchObject({
      status: 'failed',
      terminal_reason: 'hosted:turn_failed',
      error: 'DNAForge AI is unavailable right now. Please try again shortly.',
    });
    expect(JSON.stringify(terminalCommit)).not.toContain(secret);

    const rendererState = useChatStore.getState();
    const conversationState = rendererState._convStates.get('hosted-bridge-rejection');
    expect(conversationState?.error).toBe(userMessage('assistant.hostedUnavailable'));
    expect(JSON.stringify(conversationState)).not.toContain(secret);
  });

  it('persists a browser response-stream disconnect as a failed terminal turn', async () => {
    hostedCodexTestBridge.startTurn.mockResolvedValueOnce({
      ok: false,
      code: 'response_stream_disconnected',
      message: 'DNAForge AI disconnected before the browser turn reached a terminal state.',
    });
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: { kind: 'hosted', tier: 'auto' },
      hostedRouteReadiness: 'ready',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey: vi.fn().mockResolvedValue(null),
    } as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Continue the browser answer', null, 'hosted-browser-disconnect');
    });

    expect(vi.mocked(db.commitChatTurnTerminalState).mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'failed',
      terminal_reason: 'hosted:response_stream_disconnected',
      error: 'DNAForge AI disconnected before the browser turn reached a terminal state.',
    });
    expect(useChatStore.getState()._convStates.get('hosted-browser-disconnect')?.error).toBe(
      userMessage('assistant.connectionInterrupted')
    );
  });

  it('does not recreate a conversation deleted while credentials are loading', async () => {
    let resolveApiKey!: (key: string) => void;
    const apiKeyGate = new Promise<string>((resolve) => {
      resolveApiKey = resolve;
    });
    const getApiKey = vi.fn(() => apiKeyGate);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'provider',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey,
    } as any);

    const send = useChatStore
      .getState()
      .sendMessage('Do not resurrect this chat', '/workspace', 'deleting-conversation');
    await vi.waitFor(() => expect(getApiKey).toHaveBeenCalledTimes(1));
    markChatConversationDeleted('deleting-conversation');
    resolveApiKey('sk-test-key');
    await send;

    expect(db.getConversation).not.toHaveBeenCalled();
    expect(db.createConversation).not.toHaveBeenCalled();
    expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
  });

  it('authorizes a registered workspace without mounting it before provider tools execute', async () => {
    vi.mocked(streamText).mockImplementation(() => {
      expect(useWorkspaceStore.getState().folders).toEqual([]);
      return mockTextStream('Workspace ready') as any;
    });

    await act(async () => {
      await useChatStore.getState().sendMessage('List the files', '/workspace');
    });
    expect(mockResolveRegisteredProject).toHaveBeenCalledWith('/workspace');
    expect(mockListRegisteredProjects).toHaveBeenCalled();
    expect(streamText).toHaveBeenCalled();
  });

  it('does not remount a workspace removed while a stale chat prop is still rendering', async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.addFolder('/workspace', 'Friendly project name');
    workspace.removeFolder('/workspace');
    vi.mocked(streamText).mockImplementation(() => {
      expect(useWorkspaceStore.getState().folders).toEqual([]);
      return mockTextStream('Workspace-less turn') as any;
    });

    await act(async () => {
      await useChatStore.getState().sendMessage('General question', '/workspace');
    });

    expect(useWorkspaceStore.getState().folders).toEqual([]);
    expect(streamText).toHaveBeenCalled();
    expect(db.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      'New conversation',
      null,
      expect.any(String),
      expect.any(String)
    );
  });

  it('clears one-shot agent structure highlights at the start of the next user turn', async () => {
    useStructure3dStore.setState({
      expandedStructures: {},
      interactionState: {},
      selectionAnchor: {},
      selectionRangeBase: {},
    });
    useStructure3dStore.getState().registerStructure(
      'structure:1FS0',
      {
        source: 'file',
        sourceId: '1FS0',
        highlightGroups: [
          {
            id: 'agent-highlight:structure:1FS0',
            label: 'One shot',
            selections: [{ chain: 'G', ranges: [[57, 57]] }],
          },
        ],
      },
      '1FS0'
    );
    vi.mocked(streamText).mockReturnValue(mockTextStream('Next answer') as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('Next question', '/workspace');
    });

    expect(
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups
    ).toEqual([]);
  });

  it('sends user message and receives text response', async () => {
    const mockResult = mockTextStream('Hello from the AI');
    vi.mocked(streamText).mockReturnValue(mockResult as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hi there', '/workspace', undefined, [], { activateConversation: true });
    });

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[0].content).toBe('Hi there');
    expect(state.messages[1].role).toBe('assistant');
    expect(state.messages[1].content).toBe('Hello from the AI');
    expect(state.isLoading).toBe(false);
    expect(state.isStreaming).toBe(false);
    expect(mockConversationLedgerAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'app:chat',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        stream_event_type: 'user-message',
        payload: expect.objectContaining({
          message: expect.objectContaining({
            role: 'user',
            content: 'Hi there',
          }),
        }),
      })
    );
    expect(mockConversationLedgerAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'provider:vercel',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        stream_event_type: 'text-delta',
        payload: expect.objectContaining({ type: 'text-delta' }),
      })
    );
    expect(mockConversationLedgerAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'provider:vercel',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        stream_event_type: 'turn.completed',
        payload: expect.objectContaining({
          type: 'turn.completed',
          status: 'completed',
          terminal_reason: 'completed',
          error: null,
        }),
      })
    );
  });

  it('waits for provider shadow ledger appends to flush before send resolves', async () => {
    let releaseLedger!: () => void;
    const ledgerBarrier = new Promise<void>((resolve) => {
      releaseLedger = resolve;
    });
    mockConversationLedgerAppendEvent.mockImplementation(async () => {
      await ledgerBarrier;
      return { ok: true };
    });
    vi.mocked(streamText).mockReturnValue(mockTextStream('Ledger flushed response') as any);

    const sendPromise = useChatStore.getState().sendMessage('Wait for the ledger', '/workspace');
    let sendSettled = false;
    void sendPromise.then(() => {
      sendSettled = true;
    });

    await vi.waitFor(() => {
      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          terminal_reason: 'completed',
        })
      );
    });
    await Promise.resolve();
    expect(sendSettled).toBe(false);

    releaseLedger();
    await act(async () => {
      await sendPromise;
    });
    expect(sendSettled).toBe(true);
    expect(mockConversationLedgerAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ stream_event_type: 'turn.completed' })
    );
  });

  it('creates a new conversation when none selected', async () => {
    const mockResult = mockTextStream('Response');
    vi.mocked(streamText).mockReturnValue(mockResult as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
    });

    expect(db.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      'New conversation',
      '/workspace',
      'anthropic',
      'claude-sonnet-4-6'
    );
    expect(useChatStore.getState().currentConversationId).toBeTruthy();
  });

  it('uses a visible chat tab conversation ID when creating a missing conversation', async () => {
    const mockResult = mockTextStream('Response from scoped tab');
    vi.mocked(streamText).mockReturnValue(mockResult as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Route this to the visible tab', '/workspace', 'tab-conv-123', [], {
          activateConversation: true,
        });
    });

    expect(db.getConversation).toHaveBeenCalledWith('tab-conv-123');
    expect(db.createConversation).toHaveBeenCalledWith(
      'tab-conv-123',
      'New conversation',
      '/workspace',
      'anthropic',
      'claude-sonnet-4-6'
    );
    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          conversation_id: 'tab-conv-123',
          role: 'user',
          content: 'Route this to the visible tab',
        }),
      })
    );
    expect(useChatStore.getState().currentConversationId).toBe('tab-conv-123');
  });

  it('uses a canonical provider route instead of a stale legacy CLI transport mirror', async () => {
    const mockResult = mockTextStream('Provider route response');
    const getApiKey = vi.fn().mockResolvedValue('sk-openai-test-key');
    vi.mocked(streamText).mockReturnValue(mockResult as any);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: 'codex-sdk',
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('Use the canonical provider route', '/workspace');
    });

    expect(mockAgentSessionStart).not.toHaveBeenCalled();
    expect(getApiKey).toHaveBeenCalledWith('openai');
    expect(createModel).toHaveBeenCalledWith('openai', 'sk-openai-test-key', 'gpt-4o-mini');
    expect(db.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      'New conversation',
      '/workspace',
      'openai',
      'gpt-4o-mini'
    );
  });

  it('uses the currently selected provider route for the next turn in an existing conversation', async () => {
    const mockResult = mockTextStream('Provider route response');
    const getApiKey = vi.fn().mockResolvedValue('sk-openai-test-key');
    vi.mocked(streamText).mockReturnValue(mockResult as any);
    vi.mocked(db.getConversation).mockResolvedValueOnce({
      id: 'existing-conv',
      title: 'Existing chat',
      workspace_path: '/workspace',
      pinned: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      created_at: 1,
      updated_at: 1,
    });
    vi.mocked(db.getMessages).mockResolvedValueOnce([
      {
        id: 'old-user-msg',
        conversation_id: 'existing-conv',
        role: 'user',
        content: 'Previous question',
        tool_name: null,
        tool_call_id: null,
        created_at: 1,
      },
    ]);
    useChatStore.setState({
      currentConversationId: 'existing-conv',
      conversations: [
        {
          id: 'existing-conv',
          title: 'Existing chat',
          workspacePath: '/workspace',
          pinned: false,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      _convStates: new Map(),
    });
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Continue with the selected model', '/workspace', 'existing-conv');
    });

    expect(getApiKey).toHaveBeenCalledWith('openai');
    expect(createModel).toHaveBeenCalledWith('openai', 'sk-openai-test-key', 'gpt-4o-mini');
    expect(db.updateConversationRoute).toHaveBeenCalledWith(
      'existing-conv',
      'openai',
      'gpt-4o-mini'
    );
    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({
          conversation_id: 'existing-conv',
          route_kind: 'provider',
          host_id: 'direct-api',
          provider: 'openai',
          model: 'gpt-4o-mini',
          transport: null,
          authority_profile_id: null,
          permission_mode: null,
          status: 'running',
        }),
        message: expect.objectContaining({
          conversation_id: 'existing-conv',
          role: 'user',
          content: 'Continue with the selected model',
        }),
      })
    );
    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        turn_id: vi.mocked(db.createChatTurnWithUserMessage).mock.calls[0][0].turn.id,
        status: 'completed',
        terminal_reason: 'completed',
      })
    );
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      id: 'existing-conv',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('does not dispatch to any provider if turn persistence fails', async () => {
    const getApiKey = vi.fn().mockResolvedValue('sk-openai-test-key');
    vi.mocked(db.createChatTurnWithUserMessage).mockRejectedValueOnce(
      new Error('turn insert failed')
    );
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('Do not dispatch', '/workspace', undefined, [], {
        activateConversation: true,
      });
    });

    expect(createModel).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(mockAgentSessionStart).not.toHaveBeenCalled();
    expect(useChatStore.getState().error).toBe(userMessage('assistant.failed'));
    expect(useChatStore.getState().messages).toEqual([]);
    expect(db.updateConversation).not.toHaveBeenCalled();
  });

  it('uses provider route state after CLI is cleared and does not call the CLI transport', async () => {
    const mockResult = mockTextStream('Provider route response');
    const getApiKey = vi.fn().mockResolvedValue('sk-openai-test-key');
    vi.mocked(streamText).mockReturnValue(mockResult as any);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
      provider: 'openai',
      model: 'gpt-4o-mini',
      agentTransport: null,
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('Use the selected provider', '/workspace');
    });

    expect(mockAgentSessionStart).not.toHaveBeenCalled();
    expect(getApiKey).toHaveBeenCalledWith('openai');
    expect(createModel).toHaveBeenCalledWith('openai', 'sk-openai-test-key', 'gpt-4o-mini');
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: 'mock-model' },
      })
    );
    expect(db.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      'New conversation',
      '/workspace',
      'openai',
      'gpt-4o-mini'
    );
  });

  it('persists messages to database', async () => {
    const mockResult = mockTextStream('AI reply');
    vi.mocked(streamText).mockReturnValue(mockResult as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('User msg', '/workspace');
    });

    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          role: 'user',
          content: 'User msg',
        }),
      })
    );
    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        messages: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ role: 'assistant', content: 'AI reply' }),
          }),
        ]),
      })
    );
  });

  it('handles streaming text responses', async () => {
    const mockResult = mockTextStream('Hello world');
    vi.mocked(streamText).mockReturnValue(mockResult as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hi', '/workspace', undefined, [], { activateConversation: true });
    });

    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().streamingBlocks).toEqual([]);
    const state = useChatStore.getState();
    const assistantMsg = state.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Hello world');
  });

  it('handles provider errors gracefully', async () => {
    const mockResult = mockErrorStream(new Error('Rate limit exceeded'));
    vi.mocked(streamText).mockReturnValue(mockResult as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
    });

    const state = useChatStore.getState();
    expect(state.error).toBe(userMessage('assistant.failed'));
    expect(state.isLoading).toBe(false);
    expect(state.isStreaming).toBe(false);
    expect(state.messages[0]?.role).toBe('user');
    expect(mockConversationLedgerAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'provider:vercel',
        stream_event_type: 'turn.failed',
        payload: expect.objectContaining({
          type: 'turn.failed',
          status: 'failed',
          terminal_reason: 'Rate limit exceeded',
          error: 'Rate limit exceeded',
        }),
      })
    );
  });

  it('persists structured provider details when the SDK error message is empty', async () => {
    const providerError = Object.assign(new Error(''), {
      statusCode: 403,
      responseBody: JSON.stringify({
        error: 'The provider account has used all available credits.',
      }),
    });
    vi.mocked(streamText).mockReturnValue(mockErrorStream(providerError) as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
    });

    expect(useChatStore.getState().error).toBe(userMessage('assistant.failed'));
    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        terminal_reason: 'HTTP 403: The provider account has used all available credits.',
        error: 'HTTP 403: The provider account has used all available credits.',
      })
    );
  });

  it('preserves provider messages carried by plain error records', async () => {
    vi.mocked(streamText).mockReturnValue(
      mockErrorStream({ message: 'The provider rejected the follow-up tool step.' }) as any
    );

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
    });

    expect(useChatStore.getState().error).toBe(userMessage('assistant.failed'));
    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        terminal_reason: 'The provider rejected the follow-up tool step.',
        error: 'The provider rejected the follow-up tool step.',
      })
    );
  });

  it('preserves nested provider failure messages instead of reporting a generic error', async () => {
    vi.mocked(streamText).mockReturnValue(
      mockErrorStream({
        error: {
          cause: { message: 'The provider could not continue after the tool result.' },
        },
      }) as any
    );

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
    });

    expect(useChatStore.getState().error).toBe(userMessage('assistant.failed'));
  });
});
