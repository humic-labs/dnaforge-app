import { userMessage } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../hooks/useChat';
import {
  claimChatSend,
  markChatConversationDeleted,
  registerChatAbortController,
  releaseChatAbortController,
  resetDeletedChatConversationsForTests,
  setConversationState,
  type ChatStore,
  type ChatStoreGet,
  type ChatStoreSet,
} from './chat-runtime';
import { createEmptyConversationState, type QueuedChatMessage } from './chat-store-types';
import { advanceChatQueueThrough, stopChatGeneration, submitChatMessage } from './chat-queue';
import { useToastStore } from '../../../stores/toast-store';

const { mockRunChatTurn, mockAISettingsState } = vi.hoisted(() => ({
  mockRunChatTurn: vi.fn(),
  mockAISettingsState: {
    assistantRoute: {
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    } as unknown,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    agentTransport: null,
    agentDetection: null as unknown,
    providerStatuses: {
      anthropic: { isConfigured: true },
      openai: { isConfigured: true },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    hostedRouteReadiness: 'gateway-unavailable' as const,
  },
}));

vi.mock('./run-chat-turn', () => ({ runChatTurn: mockRunChatTurn }));
vi.mock('../settings', () => ({
  useAISettingsStore: { getState: vi.fn(() => mockAISettingsState) },
}));

function createHarness(conversationId: string | null = 'conv-1'): {
  get: ChatStoreGet;
  set: ChatStoreSet;
} {
  let state: ChatStore = {
    ...useChatStore.getInitialState(),
    currentConversationId: conversationId,
    _convStates: conversationId
      ? new Map([[conversationId, createEmptyConversationState()]])
      : new Map(),
  };
  const get = () => state;
  const set: ChatStoreSet = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  return { get, set };
}

function acceptQueuedTurn(
  set: ChatStoreSet,
  conversationId: string,
  content: string,
  messageId: string,
  removeVisibleQueueRow: boolean
): void {
  setConversationState(set, conversationId, (state) => ({
    messages: [...state.messages, { id: messageId, role: 'user', content, createdAt: Date.now() }],
    queuedMessages: removeVisibleQueueRow
      ? state.queuedMessages.filter((message) => message.id !== messageId)
      : state.queuedMessages,
  }));
}

function queued(id: string, content: string): QueuedChatMessage {
  return {
    id,
    content,
    workspacePath: '/workspace',
    referenceIds: [],
    routeSelection: { kind: 'provider', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    routeSnapshot: {
      routeKind: 'provider',
      hostId: 'direct-api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify({
        kind: 'provider',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
    },
    createdAt: Date.now(),
  };
}

function detectionWithCodex(codexAuth: 'authenticated' | null) {
  const missing = { cli: 'missing', path: null, auth: 'unknown', defaultModel: null };
  return {
    codex: codexAuth
      ? { cli: 'installed', path: '/usr/local/bin/codex', auth: codexAuth, defaultModel: null }
      : missing,
    claudeCode: missing,
    grok: missing,
  };
}

describe('provider-neutral chat queue coordination', () => {
  beforeEach(() => {
    resetDeletedChatConversationsForTests();
    mockAISettingsState.agentDetection = detectionWithCodex(null);
    mockAISettingsState.assistantRoute = {
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    };
    mockAISettingsState.provider = 'anthropic';
    mockAISettingsState.model = 'claude-sonnet-4-6';
    mockAISettingsState.agentTransport = null;
    mockAISettingsState.providerStatuses.anthropic.isConfigured = true;
    mockAISettingsState.providerStatuses.openai.isConfigured = true;
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockRunChatTurn.mockReset();
    mockRunChatTurn.mockImplementation(
      async (
        set: ChatStoreSet,
        _get: ChatStoreGet,
        content: string,
        _workspacePath: string | null,
        conversationId: string,
        _referenceIds: string[] | undefined,
        options: {
          userMessageId: string;
          removeVisibleQueueRowOnAccept: boolean;
          onUserMessageAccepted?: () => void;
        }
      ) => {
        acceptQueuedTurn(
          set,
          conversationId,
          content,
          options.userMessageId,
          options.removeVisibleQueueRowOnAccept
        );
        options.onUserMessageAccepted?.();
      }
    );
  });

  it('assigns a FIFO owner synchronously before route selection can await', async () => {
    const { get, set } = createHarness(null);
    let releaseTurn: () => void = () => undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    mockRunChatTurn.mockImplementationOnce(
      async (turnSet, _get, content, _path, conversationId, _refs, options) => {
        await turnGate;
        acceptQueuedTurn(
          turnSet,
          conversationId,
          content,
          options.userMessageId,
          options.removeVisibleQueueRowOnAccept
        );
        options.onUserMessageAccepted?.();
      }
    );
    const send = submitChatMessage(set, get, 'first', '/workspace', undefined, [], {
      activateConversation: true,
    });
    const owner = get().currentConversationId;

    expect(owner).toBeTruthy();
    expect(get()._convStates.has(owner!)).toBe(true);
    expect(get()._convStates.get(owner!)?.queuedMessages[0]?.displayInThreadWhilePending).toBe(
      true
    );
    releaseTurn();
    await expect(send).resolves.toBe('accepted');
    expect(mockRunChatTurn).toHaveBeenCalledWith(
      set,
      get,
      'first',
      '/workspace',
      owner,
      [],
      expect.objectContaining({
        userMessageId: expect.any(String),
        removeVisibleQueueRowOnAccept: true,
      })
    );
  });

  it('fires the submission start callback only after that queued row becomes durable', async () => {
    const { get, set } = createHarness('conv-1');
    const onStarted = vi.fn();

    await submitChatMessage(set, get, 'open this chat', '/workspace', 'conv-1', [], {
      onStarted,
    });

    expect(onStarted).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledWith('conv-1');
    expect(get()._convStates.get('conv-1')?.messages[0]?.content).toBe('open this chat');
  });

  it('sends through the best READY route when the stored one is signed out, and says so', async () => {
    const { get, set } = createHarness('conv-1');
    useToastStore.getState().clearToasts();
    const storedRoute = {
      kind: 'cli' as const,
      transport: 'claude-agent-sdk' as const,
      permissionMode: 'native-cli' as const,
    };
    mockAISettingsState.assistantRoute = storedRoute;
    mockAISettingsState.providerStatuses.anthropic.isConfigured = false;
    mockAISettingsState.providerStatuses.openai.isConfigured = false;
    mockAISettingsState.agentDetection = {
      ...detectionWithCodex('authenticated'),
      claudeCode: {
        cli: 'installed',
        path: '/usr/local/bin/claude',
        auth: 'unauthenticated',
        defaultModel: null,
      },
    };

    await expect(submitChatMessage(set, get, 'route me', '/workspace', 'conv-1')).resolves.toBe(
      'accepted'
    );

    expect(mockRunChatTurn.mock.calls[0]?.[6]).toEqual(
      expect.objectContaining({
        routeSelection: { kind: 'cli', transport: 'codex-sdk', permissionMode: 'native-cli' },
        routeSnapshot: expect.objectContaining({ transport: 'codex-sdk', hostId: 'codex-cli' }),
      })
    );
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Claude Code is signed out — sent with Codex CLI (OpenAI)',
    ]);
    expect(mockAISettingsState.assistantRoute).toEqual(storedRoute);
  });

  it('reports the exact Hosted readiness reason when send admission is blocked', async () => {
    const { get, set } = createHarness('conv-1');
    mockAISettingsState.assistantRoute = { kind: 'hosted', tier: 'auto' };
    mockAISettingsState.hostedRouteReadiness = 'provider-unavailable';
    mockAISettingsState.providerStatuses.anthropic.isConfigured = false;
    mockAISettingsState.providerStatuses.openai.isConfigured = false;
    const onNotStarted = vi.fn();

    await expect(
      submitChatMessage(set, get, 'try hosted', '/workspace', 'conv-1', [], { onNotStarted })
    ).resolves.toBe('rejected');

    expect(onNotStarted).toHaveBeenCalledWith(
      'DNAForge AI cannot send because: AI provider unavailable.'
    );
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });

  it('captures a Hosted route for browser dispatch even when desktop route memory is stale', async () => {
    const previousRuntime = document.documentElement.dataset.dnaforgeRuntime;
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.hostedRouteReadiness = 'ready';

    try {
      const { get, set } = createHarness('conv-1');

      await expect(submitChatMessage(set, get, 'browser turn', '/workspace')).resolves.toBe(
        'accepted'
      );

      expect(mockRunChatTurn.mock.calls[0]?.[6]).toEqual(
        expect.objectContaining({
          routeSelection: { kind: 'hosted', tier: 'auto' },
          routeSnapshot: expect.objectContaining({
            routeKind: 'hosted',
            hostId: 'dnaforge-hosted-auto',
          }),
        })
      );
    } finally {
      if (previousRuntime === undefined) {
        delete document.documentElement.dataset.dnaforgeRuntime;
      } else {
        document.documentElement.dataset.dnaforgeRuntime = previousRuntime;
      }
    }
  });

  it('promotes a queued submission through the route captured at its user gesture', async () => {
    const { get, set } = createHarness('conv-1');
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentDetection = detectionWithCodex('authenticated');
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockRunChatTurn.mockImplementation(
      async (
        turnSet: ChatStoreSet,
        _get: ChatStoreGet,
        content: string,
        _workspacePath: string | null,
        conversationId: string,
        _referenceIds: string[] | undefined,
        options: {
          userMessageId: string;
          removeVisibleQueueRowOnAccept: boolean;
          onUserMessageAccepted?: () => void;
        }
      ) => {
        if (content === 'first') await firstGate;
        acceptQueuedTurn(
          turnSet,
          conversationId,
          content,
          options.userMessageId,
          options.removeVisibleQueueRowOnAccept
        );
        options.onUserMessageAccepted?.();
      }
    );

    const first = submitChatMessage(set, get, 'first', '/workspace');
    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(1));
    const second = submitChatMessage(set, get, 'sensitive follow-up', '/workspace');
    expect(get()._convStates.get('conv-1')?.queuedMessages[1]?.displayInThreadWhilePending).toBe(
      false
    );
    mockAISettingsState.assistantRoute = {
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    };
    mockAISettingsState.provider = 'openai';
    mockAISettingsState.model = 'gpt-4o';

    releaseFirst();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(2));

    expect(mockRunChatTurn.mock.calls[1]?.[6]).toEqual(
      expect.objectContaining({
        routeSelection: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
        routeSnapshot: expect.objectContaining({
          routeKind: 'cli',
          hostId: 'codex-cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        }),
      })
    );
  });

  it('rejects a known-unready route before it can enter an active-turn FIFO', async () => {
    const { get, set } = createHarness('conv-1');
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockRunChatTurn.mockImplementation(
      async (
        turnSet: ChatStoreSet,
        _get: ChatStoreGet,
        content: string,
        _workspacePath: string | null,
        conversationId: string,
        _referenceIds: string[] | undefined,
        options: {
          userMessageId: string;
          removeVisibleQueueRowOnAccept: boolean;
          onUserMessageAccepted?: () => void;
        }
      ) => {
        await firstGate;
        acceptQueuedTurn(
          turnSet,
          conversationId,
          content,
          options.userMessageId,
          options.removeVisibleQueueRowOnAccept
        );
        options.onUserMessageAccepted?.();
      }
    );

    const first = submitChatMessage(set, get, 'active turn', '/workspace');
    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(1));

    mockAISettingsState.assistantRoute = {
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    };
    mockAISettingsState.providerStatuses.openai.isConfigured = false;
    mockAISettingsState.providerStatuses.anthropic.isConfigured = false;
    const onNotStarted = vi.fn();

    await expect(
      submitChatMessage(set, get, 'must stay in the composer', '/workspace', undefined, [], {
        onNotStarted,
      })
    ).resolves.toBe('rejected');
    expect(onNotStarted).toHaveBeenCalledWith(userMessage('assistant.routeNotReady'));
    expect(get()._convStates.get('conv-1')?.queuedMessages).toHaveLength(1);
    expect(mockRunChatTurn).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
  });

  it('rejects a send owned by a conversation being deleted', async () => {
    const { get, set } = createHarness('conv-1');
    markChatConversationDeleted('conv-1');

    await expect(submitChatMessage(set, get, 'do not resurrect', '/workspace')).resolves.toBe(
      'rejected'
    );
    expect(get()._convStates.get('conv-1')?.queuedMessages).toEqual([]);
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });

  it('claims an unowned visible tab identity but leaves a scoped identity background-only', async () => {
    const visible = createHarness(null);
    const visibleSend = submitChatMessage(
      visible.set,
      visible.get,
      'visible',
      '/workspace',
      'visible-conversation',
      [],
      { activateConversation: true }
    );
    expect(visible.get().currentConversationId).toBe('visible-conversation');
    await visibleSend;

    const scoped = createHarness(null);
    const scopedSend = submitChatMessage(
      scoped.set,
      scoped.get,
      'scoped',
      '/workspace',
      'scoped-conversation',
      [],
      { claimIfUnowned: false, activateConversation: false }
    );
    expect(scoped.get().currentConversationId).toBeNull();
    await scopedSend;
    expect(scoped.get().currentConversationId).toBeNull();
  });

  it('keeps a successful background send isolated from the visible projection', async () => {
    const { get, set } = createHarness('visible-conversation');
    const visibleState = {
      ...createEmptyConversationState(),
      messages: [
        { id: 'visible-message', role: 'assistant' as const, content: 'Visible', createdAt: 1 },
      ],
    };
    setConversationState(set, 'visible-conversation', () => visibleState);

    await submitChatMessage(set, get, 'background', '/workspace', 'background-conversation', [], {
      activateConversation: false,
    });

    expect(get().currentConversationId).toBe('visible-conversation');
    expect(get().messages.map((message) => message.id)).toEqual(['visible-message']);
    expect(get()._convStates.get('background-conversation')?.messages[0]?.content).toBe(
      'background'
    );
    expect(mockRunChatTurn).toHaveBeenCalledWith(
      set,
      get,
      'background',
      '/workspace',
      'background-conversation',
      [],
      expect.objectContaining({ activateConversation: false })
    );
  });

  it('queues repeated Enter in order without interrupting the active turn', async () => {
    const { get, set } = createHarness();
    const firstLease = claimChatSend('conv-1');
    expect(firstLease).not.toBeNull();
    const firstController = new AbortController();
    registerChatAbortController('conv-1', firstController);

    setConversationState(set, 'conv-1', () => ({ isLoading: true }));
    await submitChatMessage(set, get, 'second', '/workspace');
    await submitChatMessage(set, get, 'third', '/workspace');
    expect(
      get()
        ._convStates.get('conv-1')
        ?.queuedMessages.map((item) => item.content)
    ).toEqual(['second', 'third']);
    expect(firstController.signal.aborted).toBe(false);

    setConversationState(set, 'conv-1', () => ({ isLoading: false }));
    releaseChatAbortController('conv-1');
    firstLease?.release();
    stopChatGeneration(set, get, 'conv-1');

    await vi.waitFor(() => {
      expect(get()._convStates.get('conv-1')?.queuedMessages).toHaveLength(0);
    });
    expect(mockRunChatTurn.mock.calls.map((call) => call[2])).toEqual(['second', 'third']);
  });

  it('cancels each older turn and runs the clicked queued target without skipping FIFO', async () => {
    const { get, set } = createHarness();
    let releaseTarget = () => {};
    const targetGate = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    const controllers = new Map<string, AbortController>();

    mockRunChatTurn.mockImplementation(
      async (
        queueSet: ChatStoreSet,
        _queueGet: ChatStoreGet,
        content: string,
        _workspacePath: string | null,
        conversationId: string,
        _referenceIds: string[] | undefined,
        options: {
          userMessageId: string;
          removeVisibleQueueRowOnAccept: boolean;
          onUserMessageAccepted?: () => void;
        }
      ) => {
        const lease = claimChatSend(conversationId);
        expect(lease).not.toBeNull();
        acceptQueuedTurn(
          queueSet,
          conversationId,
          content,
          options.userMessageId,
          options.removeVisibleQueueRowOnAccept
        );
        options.onUserMessageAccepted?.();

        const controller = new AbortController();
        controllers.set(content, controller);
        registerChatAbortController(conversationId, controller);
        if (content === 'active turn') {
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        } else if (content === 'clicked target') {
          await targetGate;
        }
        releaseChatAbortController(conversationId);
        lease?.release();
      }
    );

    const initialSubmission = submitChatMessage(set, get, 'active turn', '/workspace');
    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(1));
    await submitChatMessage(set, get, 'older queued', '/workspace');
    await submitChatMessage(set, get, 'clicked target', '/workspace');
    await submitChatMessage(set, get, 'later queued', '/workspace');

    const targetId = get()._convStates.get('conv-1')?.queuedMessages[1]?.id;
    expect(targetId).toBeTruthy();
    advanceChatQueueThrough(set, get, targetId!, 'conv-1');

    await vi.waitFor(() => {
      expect(mockRunChatTurn.mock.calls.map((call) => call[2])).toEqual([
        'active turn',
        'older queued',
        'clicked target',
      ]);
    });
    expect(controllers.get('active turn')?.signal.aborted).toBe(true);
    expect(controllers.get('older queued')?.signal.aborted).toBe(true);
    expect(controllers.get('clicked target')?.signal.aborted).toBe(false);
    expect(
      get()
        ._convStates.get('conv-1')
        ?.queuedMessages.map((message) => message.content)
    ).toEqual(['later queued']);

    releaseTarget();
    await initialSubmission;
    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(4));
    expect(mockRunChatTurn.mock.calls.map((call) => call[2])).toEqual([
      'active turn',
      'older queued',
      'clicked target',
      'later queued',
    ]);
  });

  it('promotes the next queued message when Escape finds no active turn', async () => {
    const { get, set } = createHarness();
    setConversationState(set, 'conv-1', () => ({ queuedMessages: [queued('q-1', 'next')] }));

    stopChatGeneration(set, get, 'conv-1');

    await vi.waitFor(() => {
      expect(get()._convStates.get('conv-1')?.queuedMessages).toHaveLength(0);
    });
    expect(mockRunChatTurn).toHaveBeenCalledWith(
      set,
      get,
      'next',
      '/workspace',
      'conv-1',
      [],
      expect.objectContaining({
        userMessageId: 'q-1',
        removeVisibleQueueRowOnAccept: true,
      })
    );
  });

  it('recovers a queued message when persisted loading state has no live runtime owner', async () => {
    const { get, set } = createHarness();
    setConversationState(set, 'conv-1', () => ({
      isLoading: true,
      isStreaming: true,
      queuedMessages: [queued('q-stale', 'recover me')],
    }));

    stopChatGeneration(set, get, 'conv-1');

    await vi.waitFor(() => {
      expect(mockRunChatTurn).toHaveBeenCalledWith(
        set,
        get,
        'recover me',
        '/workspace',
        'conv-1',
        [],
        expect.objectContaining({ userMessageId: 'q-stale' })
      );
    });
    expect(get()._convStates.get('conv-1')).toMatchObject({
      isLoading: false,
      isStreaming: false,
      queuedMessages: [],
    });
  });

  it('keeps a visible queued row when promotion fails before acceptance', async () => {
    const { get, set } = createHarness();
    const item = queued('q-1', 'next');
    setConversationState(set, 'conv-1', () => ({ queuedMessages: [item] }));
    mockRunChatTurn.mockResolvedValueOnce(undefined);

    stopChatGeneration(set, get, 'conv-1');

    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(1));
    expect(get()._convStates.get('conv-1')?.queuedMessages).toEqual([item]);
  });

  it('accepts a new FIFO row independently of an older stranded head', async () => {
    const { get, set } = createHarness();
    const older = queued('q-old', 'older');
    setConversationState(set, 'conv-1', () => ({ queuedMessages: [older] }));
    mockRunChatTurn.mockResolvedValueOnce(undefined);

    const disposition = await submitChatMessage(set, get, 'newer', '/workspace', 'conv-1');

    expect(disposition).toBe('accepted');
    await vi.waitFor(() => expect(mockRunChatTurn).toHaveBeenCalledTimes(1));
    expect(
      get()
        ._convStates.get('conv-1')
        ?.queuedMessages.map((item) => item.content)
    ).toEqual(['older', 'newer']);
  });
});
