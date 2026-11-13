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

vi.mock('../../../platform', async () => {
  const { createRegisteredProjectPlatformFixture } =
    await import('../../../test/ai/registered-project-platform-fixture');
  return {
    platform: vi.fn(() => ({
      workspace: createRegisteredProjectPlatformFixture(),
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

describe('sendMessage — structured references ', () => {
  const STRUCT_REF_ID = 'a0000000-0000-0000-0000-000000000050';
  const structRef: DBEntityReference = {
    id: STRUCT_REF_ID,
    entity_type: 'sequence_region',
    display_label: 'pUC19.gb 100–500',
    locator: 'git://workspace/plasmids/pUC19.gb',
    deep_link_params: JSON.stringify({ start: 100, end: 500 }),
    data: JSON.stringify({
      schemaVersion: 2,
      kind: 'sequence_region',
      label: 'pUC19.gb 100–500',
      locator: { path: 'plasmids/pUC19.gb' },
      measured: { start: 100, end: 500, strand: '+' },
      bases: 'not_included',
      fetch: {
        tools: ['selection_translate'],
        rawFallback: { tool: 'get_selection_bases', start: 100, end: 500 },
      },
    }),
    source: 'user',
    status: 'created',
    created_at: 0,
    updated_at: 0,
  };

  const identityCompleteStructureRef: DBEntityReference = {
    ...structRef,
    entity_type: 'structure',
    display_label: '3OAA chain A residues 57, 102, and 195',
    locator: 'entity://structure/data:3oaa',
    data: JSON.stringify({
      schemaVersion: 2,
      kind: 'structure',
      measured: {
        structureRef: 'data:3oaa',
        residueCount: 3,
        residueOmittedCount: 0,
        residueIdentityKnownCount: 3,
        residueIdentityUnknownCount: 0,
        residueIdentityOmittedCount: 0,
        residues: [
          { chain: 'A', authSeqId: 57, labelCompId: 'GLY', identityStatus: 'known' },
          { chain: 'A', authSeqId: 102, labelCompId: 'GLY', identityStatus: 'known' },
          { chain: 'A', authSeqId: 195, labelCompId: 'TYR', identityStatus: 'known' },
        ],
      },
    }),
  };

  it('Direct-API: persists join rows, keeps content pure prose, feeds the model the descriptor fence', async () => {
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([structRef]);
    vi.mocked(db.getMessageReferences).mockResolvedValue([STRUCT_REF_ID]);
    vi.mocked(streamText).mockReturnValue(mockTextStream('Analyzing…') as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('What is this region?', '/workspace', undefined, [STRUCT_REF_ID], {
          activateConversation: true,
        });
    });

    const state = useChatStore.getState();
    const userMsg = state.messages[0];

    expect(userMsg.content).toBe('What is this region?');
    expect(userMsg.content).not.toContain('[[ref:');

    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: userMsg.id }),
        reference_ids: [STRUCT_REF_ID],
      })
    );

    const streamCall = vi.mocked(streamText).mock.calls[0][0] as any;
    const userMessage = streamCall.messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('What is this region?');
    expect(userMessage.content).toContain('<wp-sel-');
    expect(selectionFenceRecords(userMessage.content)[0]).toMatchObject({
      reference: { refId: STRUCT_REF_ID, source: 'user' },
      descriptor: { kind: 'sequence_region' },
    });
    expect(userMessage.content).not.toContain('[[ref:');
  });

  it('does not write a join row when no references are staged', async () => {
    vi.mocked(streamText).mockReturnValue(mockTextStream('Hi') as any);
    await act(async () => {
      await useChatStore.getState().sendMessage('Plain message', '/workspace', undefined, [], {
        activateConversation: true,
      });
    });
    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reference_ids: [] })
    );
  });

  it('Direct-API: reuses an attached complete selection without forcing a tool round trip', async () => {
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([identityCompleteStructureRef]);
    vi.mocked(db.getMessageReferences).mockResolvedValue([STRUCT_REF_ID]);
    vi.mocked(streamText).mockReturnValue(mockTextStream('Created it.') as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage(
          'Return this as a clickable selection object.',
          '/workspace',
          undefined,
          [STRUCT_REF_ID],
          {
            activateConversation: true,
          }
        );
    });

    const streamCall = vi.mocked(streamText).mock.calls[0][0] as any;
    expect(streamCall.prepareStep).toBeUndefined();
    expect(streamCall.system).toContain('dnaforge-chat://reference/<reference.refId>');
    expect(streamCall.messages[0].content).toContain(STRUCT_REF_ID);
  });

  it('CLI: staged handle + descriptor blob come from the structured ids param (no token in content)', async () => {
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([structRef]);
    vi.mocked(db.getMessageReferences).mockResolvedValue([STRUCT_REF_ID]);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: { kind: 'cli', transport: 'codex-sdk', permissionMode: 'native-cli' },
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
        .sendMessage('What is this region?', '/workspace', undefined, [STRUCT_REF_ID], {
          activateConversation: true,
        });
    });

    const state = useChatStore.getState();
    expect(state.messages[0].content).toBe('What is this region?');
    expect(state.messages[0].content).not.toContain('[[ref:');
    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: state.messages[0].id }),
        reference_ids: [STRUCT_REF_ID],
      })
    );

    const prompt = mockAgentSessionStart.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('**Staged selections (resolvable handles):**');
    expect(prompt).toContain(`refId=${STRUCT_REF_ID}`);
    expect(prompt).toContain('<wp-sel-');
  });

  it('Claude Code: passes every persisted structure residue identity in the descriptor fence', async () => {
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([identityCompleteStructureRef]);
    vi.mocked(db.getMessageReferences).mockResolvedValue([STRUCT_REF_ID]);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: 'claude-agent-sdk',
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
        .sendMessage('What is this selection?', '/workspace', undefined, [STRUCT_REF_ID], {
          activateConversation: true,
        });
    });

    const prompt = mockAgentSessionStart.mock.calls[0][0].prompt as string;
    const transcriptContent = cliConversationMessages(prompt).at(-1)?.content ?? '';
    const [record] = selectionFenceRecords(transcriptContent);
    const descriptor = record.descriptor as {
      measured: {
        residueIdentityKnownCount: number;
        residueIdentityUnknownCount: number;
        residues: Array<{ labelCompId: string; identityStatus: string }>;
      };
    };
    expect(descriptor.measured.residueIdentityKnownCount).toBe(3);
    expect(descriptor.measured.residueIdentityUnknownCount).toBe(0);
    expect(descriptor.measured.residues.map((residue) => residue.labelCompId)).toEqual([
      'GLY',
      'GLY',
      'TYR',
    ]);
    expect(descriptor.measured.residues).not.toContainEqual(
      expect.objectContaining({ identityStatus: 'unknown' })
    );
  });
});
