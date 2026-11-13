import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';

const {
  mockAgentSessionStart,
  mockAgentSessionCancel,
  mockAgentSessionOnEvent,
  mockConversationLedgerAppendEvent,
  mockScanWorkspaceFiles,
  mockReconcileCliWorkspaceChanges,
} = vi.hoisted(() => ({
  mockAgentSessionStart: vi.fn(),
  mockAgentSessionCancel: vi.fn(),
  mockAgentSessionOnEvent: vi.fn(),
  mockConversationLedgerAppendEvent: vi.fn().mockResolvedValue({ ok: true }),
  mockScanWorkspaceFiles: vi.fn(),
  mockReconcileCliWorkspaceChanges: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => `stepCountIs(${n})`),
  hasToolCall: vi.fn(() => vi.fn()),
  tool: vi.fn((def: any) => def),
}));

vi.mock('./conversation-title', () => ({
  generateCliConversationTitle: vi.fn().mockResolvedValue(null),
  generateHostedConversationTitle: vi.fn().mockResolvedValue(null),
  generateProviderConversationTitle: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../db', () => ({
  createConversation: vi.fn(
    (
      id: string,
      title: string,
      workspacePath: string | null,
      provider: string | null,
      model: string | null
    ) =>
      Promise.resolve({
        id,
        title,
        workspace_path: workspacePath,
        pinned: 0,
        provider,
        model,
        created_at: 0,
        updated_at: 0,
      })
  ),
  getConversation: vi.fn().mockResolvedValue(null),
  getConversations: vi.fn().mockResolvedValue([]),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessageAttachmentsForMessages: vi.fn().mockResolvedValue(new Map()),
  getStructuredOutputsForConversation: vi.fn().mockResolvedValue(new Map()),
  getChatTurns: vi.fn().mockResolvedValue([]),
  createChatTurnWithUserMessage: vi.fn().mockResolvedValue(undefined),
  commitChatTurnTerminalState: vi.fn().mockResolvedValue({ committed: true }),
  updateChatTurnStatus: vi.fn().mockResolvedValue(undefined),
  addMessage: vi.fn().mockResolvedValue(undefined),
  updateConversationRoute: vi.fn().mockResolvedValue(undefined),
  deleteConversation: vi.fn().mockResolvedValue(undefined),
  updateConversation: vi.fn().mockResolvedValue(undefined),
  toggleConversationPinned: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  getMessageReferences: vi.fn().mockResolvedValue([]),
  getMessageReferencesForMessages: vi.fn().mockResolvedValue(new Map()),
  setMessageReferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../db/entity-references', () => ({
  getEntityReference: vi.fn().mockResolvedValue(null),
  getEntityReferencesByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../providers', () => {
  const PROVIDERS = [
    { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-6' },
    { name: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o' },
  ];
  return {
    createModel: vi.fn().mockReturnValue({ modelId: 'mock-model' }),
    PROVIDERS,
    getAllProviderMetas: () => PROVIDERS,
    getProviderMeta: (name: string) => PROVIDERS.find((provider) => provider.name === name),
  };
});

vi.mock('../settings', () => ({
  DEFAULT_CLI_REASONING_EFFORTS: {
    'codex-sdk': 'high',
    'claude-agent-sdk': 'high',
  },
  useAISettingsStore: {
    getState: vi.fn().mockReturnValue({
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
      getApiKey: vi.fn().mockResolvedValue('sk-test-key'),
    }),
  },
}));

vi.mock('../../../platform', async () => {
  const { createRegisteredProjectPlatformFixture } =
    await import('../../../test/ai/registered-project-platform-fixture');
  return {
    platform: vi.fn(() => ({
      workspace: createRegisteredProjectPlatformFixture(),
      agentSession: {
        start: mockAgentSessionStart,
        cancel: mockAgentSessionCancel,
        onEvent: mockAgentSessionOnEvent,
      },
      conversationLedger: {
        appendEvent: mockConversationLedgerAppendEvent,
        unlinkConversation: vi.fn().mockResolvedValue({ ok: true }),
      },
    })),
  };
});

vi.mock('../cli-workspace-reconcile', () => ({
  scanWorkspaceFiles: mockScanWorkspaceFiles,
  reconcileCliWorkspaceChanges: mockReconcileCliWorkspaceChanges,
}));

import { streamText } from 'ai';
import * as db from '../../../db';
import { getEntityReferencesByIds } from '../../../db/entity-references';
import { createModel } from '../providers';
import { useAISettingsStore } from '../settings';
import { decodeAgentActivityMessage, encodeAgentActivityMessage } from '../agent-activity-message';
import {
  useChatStore,
  expandReferences,
  expandReferencesFromIds,
  serializeReferenceCoords,
  serializeReferenceDescriptorFence,
  serializeSelectionHandle,
  inferInitialDirectToolStep,
  type ContentBlock,
} from '../hooks/useChat';
import type { DBEntityReference } from '../../../db/entity-references';
import { resolveReference } from '../references/resolver';
import { useStructure3dStore } from '../../../test/ai/structure3d-test-store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { createEmptyConversationState } from './chat-store-types';

function resetUUID() {
  let uuidSuffix = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `00000000-0000-0000-0000-${(uuidSuffix++).toString(16).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`
  );
}

function decodePromptXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function promptDataFenceRecords(text: string, prefix: string): Array<Record<string, unknown>> {
  const pattern = new RegExp(
    `<${prefix}-([A-Za-z0-9]+) trust="untrusted-data">([\\s\\S]*?)<\\/${prefix}-\\1>`,
    'g'
  );
  return Array.from(
    text.matchAll(pattern),
    (match) => JSON.parse(decodePromptXml(match[2])) as Record<string, unknown>
  );
}

function selectionFenceRecords(text: string): Array<Record<string, unknown>> {
  return promptDataFenceRecords(text, 'wp-sel');
}

function cliConversationMessages(prompt: string): Array<{ role: string; content: string }> {
  const record = promptDataFenceRecords(prompt, 'wp-conversation')[0];
  expect(record).toBeDefined();
  return record.messages as Array<{ role: string; content: string }>;
}

function mockTextStream(text: string) {
  const chunks = text.split(' ').filter(Boolean);
  const fullStreamParts = chunks.map((chunk, index) => ({
    type: 'text-delta',
    id: 'text-1',
    text: index === chunks.length - 1 ? chunk : `${chunk} `,
  }));
  return {
    fullStream: {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i < fullStreamParts.length) {
              return { value: fullStreamParts[i++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
    textStream: {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i < chunks.length) {
              const value = i === chunks.length - 1 ? chunks[i] : chunks[i] + ' ';
              i++;
              return { value, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
    steps: Promise.resolve([
      {
        text,
        toolCalls: [],
        toolResults: [],
        finishReason: 'stop',
        response: { messages: [{ role: 'assistant', content: text }] },
      },
    ]),
    finishReason: Promise.resolve('stop' as const),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
    response: Promise.resolve({
      messages: [{ role: 'assistant' as const, content: text }],
    }),
  };
}

function mockFullStream(parts: Array<Record<string, unknown>>, text = '') {
  return {
    fullStream: {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i < parts.length) {
              return { value: parts[i++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
    textStream: {
      [Symbol.asyncIterator]: () => ({
        async next() {
          return { value: undefined, done: true };
        },
      }),
    },
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
    steps: Promise.resolve([]),
    finishReason: Promise.resolve('stop' as const),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    response: Promise.resolve({ messages: [] }),
  };
}

function mockErrorStream(error: Error) {
  return {
    fullStream: {
      [Symbol.asyncIterator]: () => ({
        async next() {
          throw error;
        },
      }),
    },
    textStream: {
      [Symbol.asyncIterator]: () => ({
        async next() {
          throw error;
        },
      }),
    },
    text: Promise.resolve(''),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
    steps: Promise.resolve([]),
    finishReason: Promise.resolve('error' as const),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    response: Promise.resolve({ messages: [] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUUID();

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 0)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  useChatStore.setState({
    messages: [],
    turns: {},
    activeTurnId: null,
    conversations: [],
    currentConversationId: null,
    isLoading: false,
    isStreaming: false,
    streamingBlocks: [],
    error: null,
    queuedMessages: [],
    pendingMessage: null,
    _convStates: new Map(),
  });
  useWorkspaceStore.setState({
    folders: [],
    lastRemovedFolderPath: null,
    expandedPaths: new Set(),
  });

  vi.mocked(db.getConversation).mockResolvedValue(null);
  vi.mocked(db.getConversations).mockResolvedValue([]);
  vi.mocked(db.getMessages).mockResolvedValue([]);
  vi.mocked(db.getChatTurns).mockResolvedValue([]);
  vi.mocked(db.createChatTurnWithUserMessage).mockResolvedValue(undefined);
  vi.mocked(db.commitChatTurnTerminalState).mockResolvedValue({ committed: true });
  vi.mocked(db.updateChatTurnStatus).mockResolvedValue(undefined);
  vi.mocked(db.createConversation).mockImplementation(
    async (
      id: string,
      title: string,
      workspacePath: string | null,
      provider?: string | null,
      model?: string | null
    ) => ({
      id,
      title,
      workspace_path: workspacePath,
      pinned: 0,
      provider: provider ?? null,
      model: model ?? null,
      created_at: 0,
      updated_at: 0,
    })
  );
  vi.mocked(db.addMessage).mockResolvedValue(undefined);
  vi.mocked(db.getMessageReferences).mockResolvedValue([]);
  vi.mocked(db.getMessageReferencesForMessages).mockResolvedValue(new Map());
  vi.mocked(db.setMessageReferences).mockResolvedValue(undefined);
  vi.mocked(getEntityReferencesByIds).mockResolvedValue([]);

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
    getApiKey: vi.fn().mockResolvedValue('sk-test-key'),
  } as any);
  mockAgentSessionStart.mockResolvedValue({
    transport: 'codex-sdk',
    ok: true,
    text: 'CLI response',
    durationMs: 25,
  });
  mockAgentSessionCancel.mockResolvedValue({ ok: true, cancelled: true });
  mockAgentSessionOnEvent.mockReturnValue(() => {});
  mockConversationLedgerAppendEvent.mockResolvedValue({ ok: true });
  mockScanWorkspaceFiles.mockResolvedValue({
    rootPath: '/workspace',
    files: new Map(),
    truncated: false,
    errors: [],
  });
  mockReconcileCliWorkspaceChanges.mockResolvedValue({
    workspaceRoot: '/workspace',
    beforeAvailable: true,
    after: {
      rootPath: '/workspace',
      files: new Map(),
      truncated: false,
      errors: [],
    },
    changes: { created: [], modified: [], deleted: [] },
    representativePath: null,
    openedPath: null,
  });
});

describe('useChatStore', () => {
  describe('sendMessage', () => {
    it('returns a live provider keychain miss to the submitting surface without leaking it', async () => {
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
        getApiKey: vi.fn().mockResolvedValue(null),
      } as any);
      const onNotStarted = vi.fn();

      await expect(
        useChatStore
          .getState()
          .sendMessage('Start from Home', '/workspace', 'home-conv', [], { onNotStarted })
      ).resolves.toBe('rejected');

      expect(onNotStarted).toHaveBeenCalledOnce();
      expect(onNotStarted).toHaveBeenCalledWith(
        userMessageWithValues('assistant.keyMissing', { provider: userMessageValue('Anthropic') })
      );
      expect(useChatStore.getState().error).toBeNull();
      expect(useChatStore.getState()._convStates.get('home-conv')?.error).toBeNull();
      expect(db.createConversation).not.toHaveBeenCalled();
      expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
    });

    it('returns a thrown pre-start keychain error to the submitting surface', async () => {
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
        getApiKey: vi.fn().mockRejectedValue(new Error('Keychain unavailable')),
      } as any);
      const onNotStarted = vi.fn();

      await expect(
        useChatStore
          .getState()
          .sendMessage('Start from Home', '/workspace', 'home-conv', [], { onNotStarted })
      ).resolves.toBe('rejected');

      expect(onNotStarted).toHaveBeenCalledOnce();
      expect(onNotStarted).toHaveBeenCalledWith(userMessage('assistant.failed'));
      expect(useChatStore.getState().error).toBeNull();
      expect(useChatStore.getState()._convStates.get('home-conv')?.error).toBeNull();
      expect(db.createConversation).not.toHaveBeenCalled();
      expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
    });

    it('does not clear the focused conversation when a background send fails before start', async () => {
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
        getApiKey: vi.fn().mockResolvedValue(null),
      } as any);
      const focusedState = { ...createEmptyConversationState(), isLoading: true };
      useChatStore.setState({
        currentConversationId: 'focused-conversation',
        isLoading: true,
        _convStates: new Map([['focused-conversation', focusedState]]),
      });

      await expect(
        useChatStore
          .getState()
          .sendMessage('Background attempt', '/workspace', 'background-conversation', [], {
            claimIfUnowned: false,
            onNotStarted: vi.fn(),
          })
      ).resolves.toBe('rejected');

      const state = useChatStore.getState();
      expect(state.currentConversationId).toBe('focused-conversation');
      expect(state.isLoading).toBe(true);
      expect(state._convStates.get('focused-conversation')?.isLoading).toBe(true);
      expect(state._convStates.get('background-conversation')?.isLoading).toBe(false);
    });

    it('queues same-conversation sends and drains them in FIFO order', async () => {
      const convStates = new Map();
      convStates.set('existing-conv', {
        messages: [],
        turns: {},
        activeTurnId: null,
        streamingBlocks: [],
        isLoading: false,
        isStreaming: false,
        error: null,
        queuedMessages: [],
      });
      useChatStore.setState({
        currentConversationId: 'existing-conv',
        conversations: [
          {
            id: 'existing-conv',
            title: 'Test',
            workspacePath: '/workspace',
            pinned: false,
            provider: null,
            model: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        _convStates: convStates,
      });

      let resolveStream: () => void;
      const blockingStream = new Promise<void>((r) => {
        resolveStream = r;
      });

      const slowResult = {
        fullStream: {
          [Symbol.asyncIterator]: () => ({
            async next() {
              await blockingStream;
              return { value: undefined, done: true };
            },
          }),
        },
        textStream: {
          [Symbol.asyncIterator]: () => ({
            async next() {
              await blockingStream;
              return { value: undefined, done: true };
            },
          }),
        },
        text: blockingStream.then(() => 'done'),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
        steps: blockingStream.then(() => [
          {
            text: 'done',
            toolCalls: [],
            toolResults: [],
            finishReason: 'stop',
            response: { messages: [] },
          },
        ]),
        finishReason: blockingStream.then(() => 'stop' as const),
        usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
        response: blockingStream.then(() => ({ messages: [] })),
      };
      vi.mocked(streamText).mockReturnValue(slowResult as any);

      const firstSend = useChatStore.getState().sendMessage('First', '/workspace');

      await vi.waitFor(() => {
        const conv = useChatStore.getState()._convStates.get('existing-conv');
        expect(conv?.isLoading).toBe(true);
      });

      await act(async () => {
        await useChatStore.getState().sendMessage('Second', '/workspace');
      });

      expect(
        useChatStore
          .getState()
          ._convStates.get('existing-conv')
          ?.queuedMessages.map((item) => item.content)
      ).toEqual(['Second']);
      expect(
        useChatStore
          .getState()
          ._convStates.get('existing-conv')
          ?.messages.some((message) => message.role === 'user' && message.content === 'First')
      ).toBe(true);
      const promotionSnapshots: Array<{ queued: boolean; accepted: boolean }> = [];
      const unsubscribePromotionSnapshots = useChatStore.subscribe((state) => {
        const conversation = state._convStates.get('existing-conv');
        promotionSnapshots.push({
          queued: conversation?.queuedMessages.some((item) => item.content === 'Second') ?? false,
          accepted:
            conversation?.messages.some(
              (message) => message.role === 'user' && message.content === 'Second'
            ) ?? false,
        });
      });
      expect(streamText).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      resolveStream!();
      await act(async () => {
        await firstSend;
      });
      unsubscribePromotionSnapshots();

      expect(streamText).toHaveBeenCalledTimes(2);
      expect(promotionSnapshots.length).toBeGreaterThan(0);
      expect(promotionSnapshots.every(({ queued, accepted }) => queued || accepted)).toBe(true);
      expect(useChatStore.getState()._convStates.get('existing-conv')?.queuedMessages).toEqual([]);
      expect(
        useChatStore
          .getState()
          ._convStates.get('existing-conv')
          ?.messages.map((msg) => msg.role)
      ).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(
        useChatStore
          .getState()
          ._convStates.get('existing-conv')
          ?.messages.filter((message) => message.role === 'user')
          .map((message) => message.content)
      ).toEqual(['First', 'Second']);
    });

    it('executes a queued message through the Direct API route captured when it was submitted', async () => {
      let releaseFirst: () => void = () => undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstEmitted = false;
      const firstResult = {
        ...mockTextStream('First answer'),
        fullStream: {
          [Symbol.asyncIterator]: () => ({
            async next() {
              await firstGate;
              if (!firstEmitted) {
                firstEmitted = true;
                return {
                  value: { type: 'text-delta', id: 'text-1', text: 'First answer' },
                  done: false,
                };
              }
              return { value: undefined, done: true };
            },
          }),
        },
      };
      vi.mocked(streamText)
        .mockReturnValueOnce(firstResult as any)
        .mockReturnValueOnce(mockTextStream('Second answer') as any);

      const first = useChatStore
        .getState()
        .sendMessage('First', '/workspace', 'route-capture-conversation');
      await vi.waitFor(() => {
        expect(
          useChatStore.getState()._convStates.get('route-capture-conversation')?.isLoading
        ).toBe(true);
      });
      await useChatStore
        .getState()
        .sendMessage('Sensitive follow-up', '/workspace', 'route-capture-conversation');

      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
        provider: 'openai',
        model: 'gpt-4o',
        agentTransport: null,
        isConfigured: true,
        providerStatuses: {
          anthropic: { isConfigured: true },
          openai: { isConfigured: true },
        },
        getApiKey: vi.fn(async (providerName: string) =>
          providerName === 'anthropic' ? 'sk-ant-test-key' : 'sk-openai-test-key'
        ),
      } as any);

      releaseFirst();
      await act(async () => {
        await first;
      });
      await vi.waitFor(() => expect(streamText).toHaveBeenCalledTimes(2));

      expect(vi.mocked(createModel).mock.calls.slice(0, 2)).toEqual([
        ['anthropic', 'sk-test-key', 'claude-sonnet-4-6'],
        ['anthropic', 'sk-ant-test-key', 'claude-sonnet-4-6'],
      ]);
    });

    it('keeps Enter submissions queued when durable state is active without a local drain owner', async () => {
      const convStates = new Map();
      convStates.set('hmr-active-conv', {
        messages: [{ id: 'active-user', role: 'user', content: 'Active', createdAt: 1 }],
        turns: {},
        activeTurnId: null,
        streamingBlocks: [],
        isLoading: true,
        isStreaming: false,
        error: null,
        queuedMessages: [],
      });
      useChatStore.setState({
        currentConversationId: 'hmr-active-conv',
        _convStates: convStates,
      });

      const send = useChatStore
        .getState()
        .sendMessage('Queued immediately', '/workspace', 'hmr-active-conv');

      expect(
        useChatStore
          .getState()
          ._convStates.get('hmr-active-conv')
          ?.queuedMessages.map((item) => item.content)
      ).toEqual(['Queued immediately']);
      expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
      await send;
    });

    it('queues a same-conversation send before the first await and later drains it', async () => {
      let releaseApiKey: (value: string) => void = () => {};
      const apiKeyGate = new Promise<string>((resolve) => {
        releaseApiKey = resolve;
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
      vi.mocked(streamText).mockReturnValue(mockTextStream('Only once') as any);

      const first = useChatStore.getState().sendMessage('First', '/workspace', 'same-conversation');
      const second = useChatStore
        .getState()
        .sendMessage('Second', '/workspace', 'same-conversation');

      expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
      expect(
        useChatStore
          .getState()
          ._convStates.get('same-conversation')
          ?.queuedMessages.map((item) => item.content)
      ).toEqual(['First', 'Second']);

      await vi.waitFor(() => expect(getApiKey).toHaveBeenCalledTimes(1));
      expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();

      releaseApiKey('sk-test-key');
      await act(async () => {
        await Promise.all([first, second]);
      });

      expect(db.createChatTurnWithUserMessage).toHaveBeenCalledTimes(2);
      expect(streamText).toHaveBeenCalledTimes(2);
      expect(useChatStore.getState()._convStates.get('same-conversation')?.queuedMessages).toEqual(
        []
      );
    });

    it('does not lose a follow-up queued while existing history hydrates', async () => {
      let releaseMessages!: (messages: Awaited<ReturnType<typeof db.getMessages>>) => void;
      vi.mocked(db.getConversation).mockResolvedValueOnce({
        id: 'hydrating-conversation',
        title: 'Hydrating',
        workspace_path: '/workspace',
        pinned: 0,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        created_at: 1,
        updated_at: 1,
      });
      vi.mocked(db.getMessages).mockImplementationOnce(
        () =>
          new Promise<Awaited<ReturnType<typeof db.getMessages>>>((resolve) => {
            releaseMessages = resolve;
          })
      );
      vi.mocked(streamText).mockReturnValue(mockTextStream('Answer') as any);

      const first = useChatStore
        .getState()
        .sendMessage('First', '/workspace', 'hydrating-conversation');
      await vi.waitFor(() => expect(db.getMessages).toHaveBeenCalledWith('hydrating-conversation'));
      const second = useChatStore
        .getState()
        .sendMessage('Second', '/workspace', 'hydrating-conversation');
      expect(
        useChatStore
          .getState()
          ._convStates.get('hydrating-conversation')
          ?.queuedMessages.map((message) => message.content)
      ).toEqual(['First', 'Second']);

      releaseMessages([]);
      await act(async () => {
        await Promise.all([first, second]);
      });

      expect(
        useChatStore
          .getState()
          ._convStates.get('hydrating-conversation')
          ?.messages.filter((message) => message.role === 'user')
          .map((message) => message.content)
      ).toEqual(['First', 'Second']);
      expect(
        useChatStore.getState()._convStates.get('hydrating-conversation')?.queuedMessages
      ).toEqual([]);
    });

    it('keeps a failed promotion and its error scoped to the queued conversation', async () => {
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstResult = {
        ...mockTextStream('First answer'),
        fullStream: {
          [Symbol.asyncIterator]: () => {
            let emitted = false;
            return {
              async next() {
                await firstGate;
                if (!emitted) {
                  emitted = true;
                  return {
                    value: { type: 'text-delta', id: 'text-1', text: 'First answer' },
                    done: false,
                  };
                }
                return { value: undefined, done: true };
              },
            };
          },
        },
      };
      vi.mocked(streamText).mockReturnValue(firstResult as any);

      const firstSend = useChatStore
        .getState()
        .sendMessage('First', '/workspace', 'precondition-conversation');
      await vi.waitFor(() => {
        expect(
          useChatStore.getState()._convStates.get('precondition-conversation')?.isLoading
        ).toBe(true);
      });
      await useChatStore
        .getState()
        .sendMessage('Keep me queued', '/workspace', 'precondition-conversation');

      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'provider',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: null,
        isConfigured: false,
        providerStatuses: { anthropic: { isConfigured: false } },
        getApiKey: vi.fn().mockResolvedValue(null),
      } as any);
      useChatStore.setState((state) => {
        const states = new Map(state._convStates);
        states.set('focused-conversation', createEmptyConversationState());
        return {
          currentConversationId: 'focused-conversation',
          error: null,
          _convStates: states,
        };
      });
      releaseFirst();
      await act(async () => {
        await firstSend;
      });

      expect(streamText).toHaveBeenCalledTimes(1);
      expect(
        useChatStore
          .getState()
          ._convStates.get('precondition-conversation')
          ?.queuedMessages.map((item) => item.content)
      ).toEqual(['Keep me queued']);
      expect(useChatStore.getState().error).toBeNull();
      expect(useChatStore.getState()._convStates.get('precondition-conversation')?.error).toBe(
        userMessageWithValues('assistant.keyMissing', { provider: userMessageValue('Anthropic') })
      );
    });

    it('allows concurrent message sends in different conversations', async () => {
      const uuidSequence = [
        '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-0000000000a2',
        '00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000b2',
        '00000000-0000-0000-0000-0000000000a3',
        '00000000-0000-0000-0000-0000000000b3',
      ];
      vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () =>
          (uuidSequence.shift() ??
            '00000000-0000-0000-0000-000000000999') as `${string}-${string}-${string}-${string}-${string}`
      );

      const makeBlockedStream = (text: string) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let emitted = false;
        return {
          release,
          result: {
            fullStream: {
              [Symbol.asyncIterator]: () => ({
                async next() {
                  await gate;
                  if (!emitted) {
                    emitted = true;
                    return { value: { type: 'text-delta', id: 'text-1', text }, done: false };
                  }
                  return { value: undefined, done: true };
                },
              }),
            },
            textStream: {
              [Symbol.asyncIterator]: () => ({
                async next() {
                  await gate;
                  if (!emitted) {
                    emitted = true;
                    return { value: text, done: false };
                  }
                  return { value: undefined, done: true };
                },
              }),
            },
            text: gate.then(() => text),
            toolCalls: Promise.resolve([]),
            toolResults: Promise.resolve([]),
            steps: gate.then(() => [
              {
                text,
                toolCalls: [],
                toolResults: [],
                finishReason: 'stop',
                response: { messages: [] },
              },
            ]),
            finishReason: gate.then(() => 'stop' as const),
            usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
            response: gate.then(() => ({ messages: [] })),
          },
        };
      };

      const firstStream = makeBlockedStream('First done');
      const secondStream = makeBlockedStream('Second done');
      vi.mocked(streamText)
        .mockReturnValueOnce(firstStream.result as any)
        .mockReturnValueOnce(secondStream.result as any);

      const firstSend = useChatStore
        .getState()
        .sendMessage('First question', '/workspace', 'conv-a');

      await vi.waitFor(() => {
        expect(useChatStore.getState()._convStates.get('conv-a')?.isLoading).toBe(true);
      });
      useChatStore.setState({ currentConversationId: 'conv-b' });

      const secondSend = useChatStore
        .getState()
        .sendMessage('Second question', '/workspace', 'conv-b');

      await vi.waitFor(() => {
        expect(streamText).toHaveBeenCalledTimes(2);
        expect(useChatStore.getState()._convStates.get('conv-a')?.isLoading).toBe(true);
        expect(useChatStore.getState()._convStates.get('conv-b')?.isLoading).toBe(true);
      });

      expect(db.createChatTurnWithUserMessage).toHaveBeenCalledTimes(2);
      expect(db.createChatTurnWithUserMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          turn: expect.objectContaining({ conversation_id: 'conv-a' }),
          message: expect.objectContaining({
            conversation_id: 'conv-a',
            content: 'First question',
          }),
        })
      );
      expect(db.createChatTurnWithUserMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          turn: expect.objectContaining({ conversation_id: 'conv-b' }),
          message: expect.objectContaining({
            conversation_id: 'conv-b',
            content: 'Second question',
          }),
        })
      );

      firstStream.release();
      secondStream.release();
      await act(async () => {
        await Promise.all([firstSend, secondSend]);
      });

      const state = useChatStore.getState();
      expect(state.currentConversationId).toBe('conv-b');
      expect(state._convStates.get('conv-a')?.messages.map((msg) => msg.content)).toEqual([
        'First question',
        'First done',
      ]);
      expect(state._convStates.get('conv-b')?.messages.map((msg) => msg.content)).toEqual([
        'Second question',
        'Second done',
      ]);
    });
  });
});
