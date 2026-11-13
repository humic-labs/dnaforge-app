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

vi.mock('../../../platform', () => ({
  platform: vi.fn(() => ({
    path: { appDataDir: async () => '/app-data' },
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
}));

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
  describe('stopGeneration', () => {
    it('stops generation and resets loading state', async () => {
      useChatStore.setState({
        isLoading: true,
        isStreaming: true,
        streamingBlocks: [{ type: 'text' as const, content: 'Partial response...' }],
      });

      await act(async () => {
        useChatStore.getState().stopGeneration();
      });

      const state = useChatStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.isStreaming).toBe(false);
    });

    it('saves partial response when user stops mid-stream', async () => {
      let abortedResolve: () => void;
      const abortedPromise = new Promise<void>((r) => {
        abortedResolve = r;
      });

      const slowStream = {
        fullStream: {
          [Symbol.asyncIterator]: () => {
            let yielded = false;
            return {
              async next() {
                if (!yielded) {
                  yielded = true;
                  return {
                    value: { type: 'text-delta', id: 'text-1', text: 'Partial content here' },
                    done: false,
                  };
                }
                await abortedPromise;
                throw new DOMException('The operation was aborted.', 'AbortError');
              },
            };
          },
        },
        textStream: {
          [Symbol.asyncIterator]: () => {
            let yielded = false;
            return {
              async next() {
                if (!yielded) {
                  yielded = true;
                  return { value: 'Partial content here', done: false };
                }
                await abortedPromise;
                throw new DOMException('The operation was aborted.', 'AbortError');
              },
            };
          },
        },
        text: Promise.resolve(''),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
        steps: Promise.resolve([]),
        finishReason: Promise.resolve('stop' as const),
        usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
        response: Promise.resolve({ messages: [] }),
      };

      vi.mocked(streamText).mockReturnValue(slowStream as any);

      const sendPromise = useChatStore
        .getState()
        .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });

      await vi.waitFor(() => {
        expect(useChatStore.getState().isStreaming).toBe(true);
      });

      await act(async () => {
        useChatStore.getState().stopGeneration();
        abortedResolve!();
      });

      await act(async () => {
        await sendPromise;
      });

      const state = useChatStore.getState();

      expect(state.error).toBeNull();
      const assistantMsgs = state.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].content).toContain('Partial content here');
      expect(assistantMsgs[0].content).toContain('[Stopped. Send a follow-up to resume.]');
      expect(mockConversationLedgerAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'provider:vercel',
          stream_event_type: 'turn.stopped',
          payload: expect.objectContaining({
            type: 'turn.stopped',
            status: 'stopped',
            terminal_reason: 'Stopped by user.',
            error: null,
          }),
        })
      );

      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'stopped',
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                role: 'assistant',
                content: expect.stringContaining('[Stopped. Send a follow-up to resume.]'),
              }),
            }),
          ]),
        })
      );
    });

    it('propagates stop to an in-flight CLI query and saves a stopped message', async () => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: 'codex-sdk',
        isConfigured: true,
        providerStatuses: {
          anthropic: { isConfigured: true },
          openai: { isConfigured: true },
        },
        getApiKey: vi.fn().mockResolvedValue('sk-test-key'),
      } as any);

      let resolveCliQuery: ((value: unknown) => void) | null = null;
      mockAgentSessionStart.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCliQuery = resolve;
          })
      );

      const sendPromise = useChatStore
        .getState()
        .sendMessage('Import lambda phage', '/workspace', undefined, [], {
          activateConversation: true,
        });

      await vi.waitFor(() => {
        expect(useChatStore.getState().isStreaming).toBe(true);
      });

      const sessionRequest = mockAgentSessionStart.mock.calls[0][0];
      expect(sessionRequest).toMatchObject({
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        cwd: '/workspace',
        sessionId: expect.any(String),
      });

      await act(async () => {
        useChatStore.getState().stopGeneration();
      });

      expect(mockAgentSessionCancel).toHaveBeenCalledWith(sessionRequest.sessionId);

      resolveCliQuery?.({
        transport: 'codex-sdk',
        ok: false,
        text: '',
        error: 'Stop requested.',
        durationMs: 1,
        stopState: 'stop_requested',
      });

      await act(async () => {
        await sendPromise;
      });

      const state = useChatStore.getState();
      expect(state.error).toBeNull();
      const assistantMsgs = state.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].content).toContain('[Stopped. Send a follow-up to resume.]');
      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'stopped',
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                role: 'assistant',
                content: expect.stringContaining('[Stopped. Send a follow-up to resume.]'),
              }),
            }),
          ]),
        })
      );
    });

    it('persists a pre-start CLI pause without launching a session', async () => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: 'codex-sdk',
        isConfigured: true,
        providerStatuses: {
          anthropic: { isConfigured: true },
          openai: { isConfigured: true },
        },
        getApiKey: vi.fn().mockResolvedValue('sk-test-key'),
      } as any);

      let releaseReferenceLookup: () => void = () => {};
      const referenceLookupBlocked = new Promise<void>((resolve) => {
        releaseReferenceLookup = resolve;
      });
      vi.mocked(getEntityReferencesByIds).mockImplementationOnce(async () => {
        await referenceLookupBlocked;
        return [];
      });

      const sendPromise = useChatStore
        .getState()
        .sendMessage('Inspect this selection', '/workspace', 'pre-start-pause', [
          '00000000-0000-0000-0000-000000000099',
        ]);

      await vi.waitFor(() => {
        expect(useChatStore.getState()._convStates.get('pre-start-pause')?.isLoading).toBe(true);
        expect(getEntityReferencesByIds).toHaveBeenCalled();
      });

      act(() => {
        useChatStore.getState().stopGeneration('pre-start-pause');
        releaseReferenceLookup();
      });
      await act(async () => {
        await sendPromise;
      });

      expect(mockAgentSessionStart).not.toHaveBeenCalled();
      expect(mockAgentSessionCancel).not.toHaveBeenCalled();
      const conversation = useChatStore.getState()._convStates.get('pre-start-pause');
      expect(conversation?.isLoading).toBe(false);
      expect(conversation?.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: '*[Stopped. Send a follow-up to resume.]*',
      });
      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'stopped' })
      );
    });

    it('does not carry a pre-start pause into the next send after credential lookup fails', async () => {
      let resolveCredentialLookup: (value: string | null) => void = () => {};
      const credentialLookup = new Promise<string | null>((resolve) => {
        resolveCredentialLookup = resolve;
      });
      const getApiKey = vi
        .fn()
        .mockImplementationOnce(() => credentialLookup)
        .mockResolvedValue('sk-test-key');
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

      const firstSend = useChatStore
        .getState()
        .sendMessage('This attempt cannot start', '/workspace', 'credential-pause-owner');

      await vi.waitFor(() => {
        expect(getApiKey).toHaveBeenCalledTimes(1);
      });

      act(() => {
        useChatStore.getState().stopGeneration('credential-pause-owner');
        resolveCredentialLookup(null);
      });
      await act(async () => {
        await firstSend;
      });

      vi.mocked(streamText).mockReturnValue(mockTextStream('The next send completed') as any);
      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage('Run the next attempt', '/workspace', 'credential-pause-owner');
      });

      expect(streamText).toHaveBeenCalledTimes(1);
      const conversation = useChatStore.getState()._convStates.get('credential-pause-owner');
      expect(conversation?.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'The next send completed',
      });
      expect(conversation?.messages.at(-1)?.content).not.toContain(
        '[Stopped. Send a follow-up to resume.]'
      );
    });
  });
});
