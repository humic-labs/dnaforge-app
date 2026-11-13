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
      getApiKey: vi.fn().mockResolvedValue('sk-test-key'),
    }),
  },
}));

vi.mock('../../../platform', () => ({
  platform: vi.fn(() => ({
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
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    '00000000-0000-0000-0000-000000000000' as `${string}-${string}-${string}-${string}-${string}`
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

import { convertToModelMessages, type ChatMessage } from '../hooks/useChat';

function msg(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
  return { id: `msg-${Math.random()}`, content: '', createdAt: Date.now(), ...overrides };
}

describe('convertToModelMessages', () => {
  it('converts plain user messages', () => {
    const result = convertToModelMessages([msg({ role: 'user', content: 'hello' })]);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('converts plain assistant messages (no tool calls following)', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: 'hello back' }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ role: 'assistant', content: 'hello back' });
  });

  it('skips persisted activity rows when building model context', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'hi' }),
      msg({
        role: 'activity',
        content: encodeAgentActivityMessage({
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'command_execution',
          raw: {},
          display: {
            kind: 'command',
            title: 'Ran command',
            status: 'completed',
            text: 'pwd',
          },
          versions: { sdkVersion: null, cliVersion: null },
        }),
      }),
      msg({ role: 'assistant', content: 'hello back' }),
    ]);

    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('pairs assistant + tool messages into tool-call and tool-result parts', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'list files' }),
      msg({ role: 'assistant', content: 'Let me check.' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-1',
        toolName: 'list_files',
        content: JSON.stringify({ input: { path: '.' }, output: { entries: ['a.gb'] } }),
      }),
    ]);

    expect(result).toHaveLength(3);

    const assistantMsg = result[1] as any;
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(assistantMsg.content[1]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'tc-1',
      toolName: 'list_files',
      input: { path: '.' },
    });

    const toolMsg = result[2] as any;
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content).toHaveLength(1);
    expect(toolMsg.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc-1',
      toolName: 'list_files',
      output: { type: 'json', value: { entries: ['a.gb'] } },
    });
  });

  it('handles assistant with empty content + tool calls (no text part)', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'do it' }),
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-2',
        toolName: 'read_file',
        content: JSON.stringify({ input: { path: 'x.gb' }, output: { data: '...' } }),
      }),
    ]);

    const assistantMsg = result[1] as any;
    expect(assistantMsg.content).toHaveLength(1);
    expect(assistantMsg.content[0].type).toBe('tool-call');
  });

  it('handles orphaned tool messages (no preceding assistant)', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'go' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-3',
        toolName: 'get_workspace',
        content: JSON.stringify({ input: {}, output: { panels: [] } }),
      }),
    ]);

    expect(result).toHaveLength(3);
    const syntheticAssistant = result[1] as any;
    expect(syntheticAssistant.role).toBe('assistant');
    expect(syntheticAssistant.content[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'tc-3',
      toolName: 'get_workspace',
    });

    const toolResult = result[2] as any;
    expect(toolResult.role).toBe('tool');
    expect(toolResult.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc-3',
      output: { type: 'json', value: { panels: [] } },
    });
  });

  it('emits fallback for tool messages with invalid JSON content (M11)', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'go' }),
      msg({ role: 'assistant', content: 'trying' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-4',
        toolName: 'list_files',
        content: 'NOT VALID JSON',
      }),
    ]);

    expect(result).toHaveLength(3);
    const assistantMsg = result[1] as any;
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0]).toEqual({ type: 'text', text: 'trying' });
    expect(assistantMsg.content[1]).toMatchObject({ type: 'tool-call', toolCallId: 'tc-4' });
  });

  it('skips orphaned tool messages with invalid JSON content', () => {
    const result = convertToModelMessages([
      msg({
        role: 'tool',
        toolCallId: 'tc-5',
        toolName: 'list_files',
        content: 'NOT JSON',
      }),
    ]);
    expect(result).toEqual([]);
  });

  it('skips tool messages missing toolCallId or toolName', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: 'check' }),
      msg({ role: 'tool', content: JSON.stringify({ input: {}, output: {} }) }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'check' }] });
  });

  it('handles multiple consecutive tool messages after one assistant', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-a',
        toolName: 'list_files',
        content: JSON.stringify({ input: {}, output: ['a'] }),
      }),
      msg({
        role: 'tool',
        toolCallId: 'tc-b',
        toolName: 'read_file',
        content: JSON.stringify({ input: { path: 'x' }, output: 'data' }),
      }),
    ]);

    const assistantMsg = result[0] as any;
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0].toolName).toBe('list_files');
    expect(assistantMsg.content[1].toolName).toBe('read_file');

    const toolMsg = result[1] as any;
    expect(toolMsg.content).toHaveLength(2);
  });

  it('uses empty object for missing input field', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-x',
        toolName: 'get_workspace',
        content: JSON.stringify({ output: { panels: [] } }),
      }),
    ]);

    const assistantMsg = result[0] as any;
    expect(assistantMsg.content[0].input).toEqual({});
  });

  it('wraps tool output as discriminated union for AI SDK schema compliance', () => {
    const result1 = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-wrap-1',
        toolName: 'create_reference',
        content: JSON.stringify({ input: {}, output: { referenceId: 'ref-123' } }),
      }),
    ]);
    const toolMsg1 = result1[1] as any;
    expect(toolMsg1.content[0].output).toEqual({
      type: 'json',
      value: { referenceId: 'ref-123' },
    });

    const result2 = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-wrap-2',
        toolName: 'read_file',
        content: JSON.stringify({ input: {}, output: 'file contents here' }),
      }),
    ]);
    const toolMsg2 = result2[1] as any;
    expect(toolMsg2.content[0].output).toEqual({
      type: 'text',
      value: 'file contents here',
    });

    const result3 = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-wrap-3',
        toolName: 'run_action',
        content: JSON.stringify({ input: {} }),
      }),
    ]);
    const toolMsg3 = result3[1] as any;
    expect(toolMsg3.content[0].output).toEqual({
      type: 'text',
      value: '',
    });

    const result4 = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-wrap-4',
        toolName: 'do_thing',
        content: JSON.stringify({ input: {}, output: {} }),
      }),
    ]);
    const toolMsg4 = result4[1] as any;
    expect(toolMsg4.content[0].output).toEqual({
      type: 'json',
      value: {},
    });
  });
});

describe('convertToModelMessages — M11 fallback', () => {
  it('produces fallback tool-call/result pair for unparseable tool JSON after assistant', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'go' }),
      msg({ role: 'assistant', content: 'working on it' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-bad',
        toolName: 'list_files',
        content: 'INVALID JSON HERE',
      }),
    ]);

    expect(result.length).toBeGreaterThanOrEqual(3);
    const assistantMsg = result[1] as any;
    expect(assistantMsg.role).toBe('assistant');
    const toolCallPart = assistantMsg.content.find((p: any) => p.type === 'tool-call');
    expect(toolCallPart).toBeTruthy();
    expect(toolCallPart.toolCallId).toBe('tc-bad');

    const toolMsg = result[2] as any;
    expect(toolMsg.role).toBe('tool');
    const toolResultPart = toolMsg.content.find((p: any) => p.type === 'tool-result');
    expect(toolResultPart).toBeTruthy();
    expect(toolResultPart.toolCallId).toBe('tc-bad');
  });
});
