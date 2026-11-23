import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';

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
  updateConversationWithResult: vi
    .fn<typeof import('../../../db').updateConversationWithResult>()
    .mockResolvedValue({ status: 'updated' }),
  updateConversationTitleIfUnchanged: vi.fn().mockResolvedValue(true),
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
      workspace: createRegisteredProjectPlatformFixture(['/workspace', '/ws']),
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
  const current = prompt.match(
    /<wp-current-user-request-([A-Za-z0-9]+) role="user">([\s\S]*?)<\/wp-current-user-request-\1>/
  );
  const activeRequest = current ? JSON.parse(decodePromptXml(current[2])) : null;
  return [
    ...(record.messages as Array<{ role: string; content: string }>),
    ...(activeRequest ? [activeRequest] : []),
  ];
}

function mainProviderStreamCall(): any {
  const call = vi
    .mocked(streamText)
    .mock.calls.find(
      ([request]) => !(request as any).system?.startsWith('Name this conversation')
    )?.[0];
  expect(call).toBeDefined();
  return call as any;
}

function mainCliPrompt(): string {
  const request = mockAgentSessionStart.mock.calls.find(
    ([candidate]) => candidate.conversationId
  )?.[0];
  expect(request).toBeDefined();
  return request.prompt as string;
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
    it('proceeds without a workspace — workspace is optional ', async () => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'provider',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        isConfigured: true,
        providerStatuses: {
          anthropic: { isConfigured: true },
          openai: { isConfigured: true },
        },
        getApiKey: vi.fn().mockResolvedValue('sk-test-key'),
      } as any);

      await act(async () => {
        await useChatStore.getState().sendMessage('Hello', null);
      });

      expect(useChatStore.getState().error ?? '').not.toMatch(/workspace/i);
      expect(streamText).toHaveBeenCalled();
    });

    it('rejects when not configured', async () => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'provider',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        isConfigured: false,
        providerStatuses: { anthropic: { isConfigured: false } },
        agentDetectError: 'no local CLI in this test',
        hostedRouteReadiness: 'gateway-unavailable',
        getApiKey: vi.fn().mockResolvedValue(null),
      } as any);

      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
      });

      expect(useChatStore.getState().error).toMatch(/configured|api key/i);
      expect(streamText).not.toHaveBeenCalled();
    });

    it('passes tools and system prompt to streamText', async () => {
      const mockResult = mockTextStream('Response');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore.getState().sendMessage('Hello', '/workspace');
      });

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.anything(),
          system: expect.stringContaining('biology'),
          tools: expect.any(Object),
          messages: expect.any(Array),
          stopWhen: ['stepCountIs(16)', expect.any(Function)],
          abortSignal: expect.any(AbortSignal),
        })
      );
      const call = mainProviderStreamCall();
      expect(call.prepareStep).toBeUndefined();
      expect(call.system).toContain('call the relevant tool(s) before answering');
    });

    it('does not force an explicitly named Direct API tool', async () => {
      const mockResult = mockTextStream('Response');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage('Use list_files to show me my files.', '/workspace');
      });

      const call = mainProviderStreamCall();
      expect(call.toolChoice).toBeUndefined();
      expect(call.prepareStep).toBeUndefined();
    });

    it('leaves implicit file-reading tool choice to the Direct API model', async () => {
      const mockResult = mockTextStream('Response');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore.getState().sendMessage('Read the pUC19 plasmid file', '/workspace');
      });

      const call = mainProviderStreamCall();
      expect(call.toolChoice).toBeUndefined();
      expect(call.prepareStep).toBeUndefined();
    });

    it('exposes app-owned biological import and open tools for download/open workflows', async () => {
      const mockResult = mockTextStream('Imported and opened the requested accession.');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage(
            'Import NCBI accession NC_001416.1, analyze key features, and open it.',
            '/workspace'
          );
      });

      const call = mainProviderStreamCall();
      expect(call.tools).toHaveProperty('import_sequence');
      expect(call.tools).toHaveProperty('open_tab');
      expect(call.tools.import_sequence.description).toContain('GenBank/FASTA');
      expect(call.tools.import_sequence.description).toContain('NCBI nucleotide accession');
      expect(call.system).toContain('Use import_sequence when');
      expect(call.system).toContain('Use open_tab with the stable DOCUMENT ID for sequences');
      expect(call.system).toContain('do not open tabs by');
      expect(call.system).toContain('Describe saved sequence and design artifacts by name');
      expect(call.system).toContain('clickable artifact chips from verified tool results');
      expect(call.system).toContain('Report paths for generic files');
      expect(call.system).toContain(
        'Do not spend the end of the tool budget on optional references'
      );
      expect(call.system).toContain('Always finish with a final answer after tool results');
      expect(call.stopWhen).toEqual(['stepCountIs(16)', expect.any(Function)]);
    });

    it('names a Codex chat before its first answer finishes', async () => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: 'codex-sdk',
        isConfigured: true,
        providerStatuses: { anthropic: { isConfigured: true } },
        getApiKey: vi.fn().mockResolvedValue(null),
      } as any);

      let finishMainTurn!: () => void;
      let finishTitle!: () => void;
      const mainTurn = new Promise<any>((resolve) => {
        finishMainTurn = () => resolve({ transport: 'codex-sdk', ok: true, text: 'Answer' });
      });
      const titleTurn = new Promise<any>((resolve) => {
        finishTitle = () =>
          resolve({ transport: 'codex-sdk', ok: true, text: 'RNA Sequencing vs qPCR' });
      });
      mockAgentSessionStart.mockImplementation((request) =>
        request.conversationId === null ? titleTurn : mainTurn
      );

      const prompt = 'Compare RNA sequencing and qPCR for a pilot study';
      const send = useChatStore.getState().sendMessage(prompt, '/workspace');

      await waitFor(() => expect(mockAgentSessionStart).toHaveBeenCalledTimes(2));
      expect(useChatStore.getState().conversations[0]?.title).toBe('New conversation');
      expect(db.updateConversationTitleIfUnchanged).not.toHaveBeenCalledWith(
        expect.any(String),
        'New conversation',
        prompt
      );

      finishTitle();
      await waitFor(() => {
        expect(useChatStore.getState().conversations[0]?.title).toBe('RNA Sequencing vs qPCR');
      });
      const conversationId = useChatStore.getState().conversations[0]?.id;
      expect(useChatStore.getState()._convStates.get(conversationId as string)?.isLoading).toBe(
        true
      );
      expect(db.commitChatTurnTerminalState).not.toHaveBeenCalled();

      finishMainTurn();
      await send;
    });

    it('uses the first request to replace the neutral placeholder with a descriptive title', async () => {
      vi.mocked(streamText).mockImplementation((request: any) =>
        request.system.startsWith('Name this conversation')
          ? (mockTextStream('RNA Sequencing vs qPCR') as any)
          : (mockTextStream('The two methods measure expression differently.') as any)
      );

      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage(
            'Could you compare RNA sequencing and qPCR for a pilot study?',
            '/workspace'
          );
      });

      await waitFor(() => {
        expect(useChatStore.getState().conversations[0]?.title).toBe('RNA Sequencing vs qPCR');
      });
    });

    it('keeps the completed answer and neutral title when naming fails', async () => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.mocked(streamText).mockImplementation((request: any) => {
        if (request.system.startsWith('Name this conversation')) {
          throw new Error('title provider unavailable');
        }
        return mockTextStream('The methods differ in scope.') as any;
      });

      await act(async () => {
        await useChatStore.getState().sendMessage('Compare RNA sequencing and qPCR', '/workspace');
      });

      await waitFor(() => {
        expect(warning).toHaveBeenCalledWith(
          '[Chat] Automatic conversation title was unavailable.'
        );
      });
      expect(useChatStore.getState().conversations[0]?.title).toBe('New conversation');
      expect(db.updateConversationTitleIfUnchanged).not.toHaveBeenCalled();
      warning.mockRestore();
    });

    it('keeps a manual rename made while title generation is pending', async () => {
      let releaseTitle!: (title: string) => void;
      const generatedText = new Promise<string>((resolve) => {
        releaseTitle = resolve;
      });
      vi.mocked(streamText).mockImplementation((request: any) =>
        request.system.startsWith('Name this conversation')
          ? ({ ...mockTextStream(''), text: generatedText } as any)
          : (mockTextStream('The methods differ in scope.') as any)
      );
      vi.mocked(db.updateConversationTitleIfUnchanged).mockImplementation(
        async (_id, _expected, next) => next !== 'Generated title'
      );

      await act(async () => {
        await useChatStore.getState().sendMessage('Compare RNA sequencing and qPCR', '/workspace');
      });
      const conversationId = useChatStore.getState().conversations[0]?.id;
      expect(conversationId).toBeDefined();
      await act(async () => {
        await useChatStore.getState().renameConversation(conversationId as string, 'My own name');
        expect(db.updateConversationWithResult).toHaveBeenCalledWith(conversationId, 'My own name');
        releaseTitle('Generated title');
      });

      await waitFor(() => {
        expect(db.updateConversationTitleIfUnchanged).toHaveBeenCalledWith(
          conversationId,
          'New conversation',
          'Generated title'
        );
      });
      expect(useChatStore.getState().conversations[0]?.title).toBe('My own name');
    });

    it('strips reference tokens from the title request', async () => {
      vi.mocked(streamText).mockImplementation((request: any) =>
        request.system.startsWith('Name this conversation')
          ? (mockTextStream('Attached Region Question') as any)
          : (mockTextStream('Response') as any)
      );

      const REF_ID = 'a0000000-0000-0000-0000-0000000000aa';
      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage(`What is this?\n\n[[ref:${REF_ID}]]`, '/workspace');
      });

      const titleRequest = vi
        .mocked(streamText)
        .mock.calls.find((call) =>
          (call[0] as any).system.startsWith('Name this conversation')
        )?.[0] as any;
      expect(titleRequest.prompt).toContain('What is this?');
      expect(titleRequest.prompt).not.toContain('[[ref:');
      expect(titleRequest.prompt).not.toContain('Referenced entities:');
    });

    it('does not auto-title on subsequent messages', async () => {
      const existingMessages = [
        { id: 'm1', role: 'user' as const, content: 'First msg', createdAt: 0 },
      ];
      const convStates = new Map();
      convStates.set('existing-conv', {
        messages: existingMessages,
        streamingBlocks: [],
        isLoading: false,
        isStreaming: false,
        error: null,
      });
      useChatStore.setState({
        currentConversationId: 'existing-conv',
        conversations: [
          {
            id: 'existing-conv',
            title: 'Existing',
            workspacePath: '/ws',
            pinned: false,
            provider: null,
            model: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        messages: existingMessages,
        _convStates: convStates,
      });

      const mockResult = mockTextStream('Response');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore.getState().sendMessage('Second msg', '/workspace');
      });

      expect(db.updateConversationTitleIfUnchanged).not.toHaveBeenCalled();
    });

    it('records a failed turn when the first terminal transaction fails', async () => {
      vi.mocked(db.commitChatTurnTerminalState)
        .mockRejectedValueOnce(new Error('DB write failed'))
        .mockResolvedValueOnce({ committed: true });
      const mockResult = mockTextStream('Response');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage('Hello', '/workspace', undefined, [], { activateConversation: true });
      });

      const state = useChatStore.getState();
      expect(state.messages.length).toBeGreaterThan(0);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe(userMessage('assistant.failed'));
      expect(db.commitChatTurnTerminalState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed', error: 'DB write failed' })
      );
    });

    it('persists tool results from the fullStream reducer', async () => {
      vi.mocked(streamText).mockReturnValue(
        mockFullStream([
          { type: 'text-delta', id: 'text-1', text: 'Done with ' },
          {
            type: 'tool-result',
            toolCallId: 'tc-123',
            toolName: 'list_files',
            input: { path: '/workspace' },
            output: { files: ['file1.txt', 'file2.txt'] },
          },
          { type: 'text-delta', id: 'text-2', text: 'tools' },
        ]) as any
      );

      await act(async () => {
        await useChatStore.getState().sendMessage('List files', '/workspace', undefined, [], {
          activateConversation: true,
        });
      });

      expect(mainProviderStreamCall()).not.toHaveProperty('onStepFinish');
      const state = useChatStore.getState();
      const toolMessages = state.messages.filter((message) => message.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      const toolMsg = toolMessages[0];
      expect(toolMsg.toolName).toBe('list_files');
      expect(toolMsg.toolCallId).toBe('tc-123');

      const toolData = JSON.parse(toolMsg.content);
      expect(toolData.input).toEqual({ path: '/workspace' });
      expect(toolData.output).toEqual({ files: ['file1.txt', 'file2.txt'] });
      expect(state.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);

      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                role: 'tool',
                tool_name: 'list_files',
                tool_call_id: 'tc-123',
              }),
            }),
          ]),
        })
      );
    });

    it('emits ref block for create_reference tool results', async () => {
      const REF_ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
      const mockRef = {
        id: REF_ID,
        entity_type: 'sequence',
        display_label: 'pUC19.gb',
        locator: 'git://workspace/plasmids/pUC19.gb',
        deep_link_params: null,
        data: null,
        source: 'ai',
        status: 'created',
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      vi.mocked(getEntityReferencesByIds).mockResolvedValue([mockRef]);

      vi.mocked(streamText).mockReturnValue(
        mockFullStream([
          { type: 'text-delta', id: 'text-1', text: 'Here is your sequence.' },
          {
            type: 'tool-result',
            toolCallId: 'tc-ref-1',
            toolName: 'create_reference',
            input: {
              entityType: 'sequence',
              displayLabel: 'pUC19.gb',
              filePath: 'plasmids/pUC19.gb',
            },
            output: { referenceId: REF_ID },
          },
        ]) as any
      );

      await act(async () => {
        await useChatStore.getState().sendMessage('Show me pUC19', '/workspace', undefined, [], {
          activateConversation: true,
        });
      });

      expect(mainProviderStreamCall()).not.toHaveProperty('onStepFinish');
      const state = useChatStore.getState();

      const createRefMessages = state.messages.filter(
        (message) => message.role === 'tool' && message.toolName === 'create_reference'
      );
      expect(createRefMessages).toHaveLength(1);

      const toolData = JSON.parse(createRefMessages[0].content);
      expect(toolData.referenceData).toEqual(mockRef);
      expect(toolData.output.referenceId).toBe(REF_ID);

      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                role: 'tool',
                tool_name: 'create_reference',
                tool_call_id: 'tc-ref-1',
              }),
              reference_ids: [REF_ID],
            }),
          ]),
        })
      );
    });

    it('acknowledges completed reference chips when the provider emits no final text', async () => {
      const referenceId = 'b1b2c3d4-e5f6-4890-abcd-ef1234567890';
      vi.mocked(getEntityReferencesByIds).mockResolvedValue([
        {
          id: referenceId,
          entity_type: 'sequence',
          display_label: 'pUC19.gb',
          locator: 'git://workspace/plasmids/pUC19.gb',
          deep_link_params: null,
          data: null,
          source: 'ai',
          status: 'created',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ]);
      vi.mocked(streamText).mockReturnValue(
        mockFullStream([
          {
            type: 'tool-result',
            toolCallId: 'tc-ref-no-text',
            toolName: 'create_reference',
            input: {
              entityType: 'sequence',
              displayLabel: 'pUC19.gb',
              filePath: 'plasmids/pUC19.gb',
            },
            output: { referenceId },
          },
          { type: 'text-delta', id: 'short-answer', text: '[ pUC19 ]' },
        ]) as any
      );

      await act(async () => {
        await useChatStore
          .getState()
          .sendMessage('Return pUC19 as a reference', '/workspace', undefined, [], {
            activateConversation: true,
          });
      });

      expect(
        useChatStore
          .getState()
          .messages.filter((message) => message.role === 'assistant')
          .at(-1)?.content
      ).toBe('Created the requested clickable reference.');
    });

    it('embeds a staged-selection handle in the CLI prompt alongside the descriptor blob', async () => {
      const HANDLE_REF_ID = 'a0000000-0000-0000-0000-000000000030';
      const descriptor = {
        schemaVersion: 2,
        kind: 'sequence_region',
        label: 'pUC19.gb 100–500',
        locator: { path: 'plasmids/pUC19.gb' },
        measured: { start: 100, end: 500, strand: '+' },
        fileText: { product: { value: 'beta-lactamase', trust: 'untrusted-data' } },
        bases: 'not_included',
        fetch: {
          tools: ['selection_translate'],
          rawFallback: { tool: 'get_selection_bases', start: 100, end: 500 },
        },
      };
      vi.mocked(getEntityReferencesByIds).mockResolvedValue([
        {
          id: HANDLE_REF_ID,
          entity_type: 'sequence_region',
          display_label: 'pUC19.gb 100–500',
          locator: 'git://workspace/plasmids/pUC19.gb',
          deep_link_params: JSON.stringify({ start: 100, end: 500 }),
          data: JSON.stringify(descriptor),
          source: 'user',
          status: 'created',
          created_at: 0,
          updated_at: 0,
        },
      ]);
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: 'codex-sdk',
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
          .sendMessage(`What is this region? [[ref:${HANDLE_REF_ID}]]`, '/workspace');
      });

      const prompt = mainCliPrompt();

      expect(prompt).toContain('**Staged selections (resolvable handles):**');
      expect(prompt).toContain(`refId=${HANDLE_REF_ID}`);
      expect(prompt).toContain(`resource=waypoint://selection/${HANDLE_REF_ID}`);
      expect(prompt).toContain('401 bp');
      expect(prompt).toContain('strand +');
      expect(prompt).toContain('pass refId to the selection_* tools (both CLIs)');

      const transcriptContent = cliConversationMessages(prompt).at(-1)?.content ?? '';
      const [selectionRecord] = selectionFenceRecords(transcriptContent);
      expect(selectionRecord).toMatchObject({
        reference: { refId: HANDLE_REF_ID, source: 'user' },
        descriptor: { kind: 'sequence_region' },
      });

      expect(prompt).toContain('waypoint://selection/{refId}');
      expect(prompt).toContain('never invent coordinates');
    });

    it('omits the selection handle for a no-descriptor reference on the CLI route', async () => {
      const PLAIN_REF_ID = 'a0000000-0000-0000-0000-000000000031';
      vi.mocked(getEntityReferencesByIds).mockResolvedValue([
        {
          id: PLAIN_REF_ID,
          entity_type: 'sequence',
          display_label: 'pUC19.gb',
          locator: 'git://workspace/plasmids/pUC19.gb',
          deep_link_params: null,
          data: null,
          source: 'user',
          status: 'created',
          created_at: 0,
          updated_at: 0,
        },
      ]);
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: 'codex-sdk',
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
          .sendMessage(`Tell me about [[ref:${PLAIN_REF_ID}]]`, '/workspace');
      });

      const prompt = mainCliPrompt();

      expect(prompt).not.toContain('**Staged selections (resolvable handles):**');
      expect(prompt).not.toContain(`resource=waypoint://selection/${PLAIN_REF_ID}`);
      const transcriptContent = cliConversationMessages(prompt).at(-1)?.content ?? '';
      expect(selectionFenceRecords(transcriptContent)).toEqual([
        expect.objectContaining({
          reference: expect.objectContaining({
            refId: PLAIN_REF_ID,
            displayLabel: 'pUC19.gb',
            path: 'plasmids/pUC19.gb',
          }),
          descriptor: null,
        }),
      ]);
    });

    const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ');

    const assertDescriptorGuidance = (prompt: string): void => {
      const p = normalizeWs(prompt);

      expect(p).toContain('strict TRI-STATE per layer');
      expect(p).toContain(
        'the layer is toggled OFF, so the app did NOT tell you what is there = UNKNOWN, NOT "none"'
      );
      expect(p).toContain('You MUST NOT claim the region has none');
      expect(p).toContain(
        'offer to scan — for cut sites that means calling selection_restriction_sites'
      );
      expect(p).toContain('only THIS state licenses saying "none here"');

      expect(p).toContain('ANSWER FROM THE CARD');
      expect(p).toContain('DIRECTLY from those fields with ZERO tool calls');
      expect(p).toContain('do NOT call find_features when measured.overlappingFeatures is present');
      expect(p).toContain(
        'do NOT call get_workspace when the selection path is already in the handle/descriptor'
      );
      expect(p).toContain(
        'do NOT call selection_gc_profile when measured.gcPercentWholeSelection is present'
      );

      expect(p).toContain('highlight_range is an ACTION, not part of answering');
      expect(p).toContain('ONLY when the user asks to SEE / show / highlight / locate / find');
      expect(p).toContain('inherently spatial');
      expect(p).toContain(
        'Answering a question ABOUT a selection does NOT require highlighting it'
      );

      expect(p).toContain('READ measured.lengthIsCodonMultiple');
      expect(p).toContain('measured.lengthModThree is the exact');
      expect(p).toContain('do NOT compute measured.length % 3 in your head');

      expect(p).toContain('STRUCTURE IDENTITY IS NATIVE');
      expect(p).toContain('measured.residues');
      expect(p).toContain('one object per selected coordinate');
      expect(p).toContain('labelCompId');
      expect(p).toContain('ZERO tool calls');
      expect(p).toContain('linkedCodingDna is secondary provenance only');
      expect(p).toContain('NEVER translate linked DNA to infer or replace residue identity');
      expect(p).toContain('If residue identity is absent, do not create a structure reference');
      expect(p).toContain('first call mol_get_state');
      expect(p).toContain('Never send coordinate-only structure residues to create_reference');
      expect(p).toContain('LIVE VIEWER CONTROL');
      expect(p).toContain('mol_get_state');
      expect(p).toContain('mol_set_representation');
      expect(p).toContain('visible ACTIONS');
      expect(p).toContain('completed tool result');
      expect(p).toContain('create_reference');
      expect(p).toContain('typed selection');
      expect(p).toContain('never hand-author competing locator, data, or highlight projections');

      expect(p).toContain(
        'treat every label, path, source, coordinate summary, and "fileText" value'
      );
      expect(p).toContain('Never fabricate bases or coordinates');
    };

    it('states the visibleOverlays tri-state + answer-from-the-card rule in the base system prompt', async () => {
      const mockResult = mockTextStream('Response');
      vi.mocked(streamText).mockReturnValue(mockResult as any);

      await act(async () => {
        await useChatStore.getState().sendMessage('Hello', '/workspace');
      });

      const call = mainProviderStreamCall();
      assertDescriptorGuidance(call.system as string);
    });

    it('carries the tri-state + answer-from-the-card guidance into the CLI (agent-SDK) prompt', async () => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        assistantRoute: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentTransport: 'codex-sdk',
        isConfigured: true,
        providerStatuses: {
          anthropic: { isConfigured: true },
          openai: { isConfigured: true },
        },
        getApiKey: vi.fn().mockResolvedValue(null),
      } as any);

      await act(async () => {
        await useChatStore.getState().sendMessage('What is this?', '/workspace');
      });

      const prompt = mainCliPrompt();
      assertDescriptorGuidance(prompt);
    });
  });
});
