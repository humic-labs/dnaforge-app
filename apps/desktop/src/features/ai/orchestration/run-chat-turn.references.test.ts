import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} = getUseChatConversationHarness();

describe('runChatTurn CLI reference materialization', () => {
  beforeEach(resetUseChatConversationHarness);

  it('materializes a completed Claude CLI create_reference result as an inline reference object', async () => {
    const referenceId = 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff';
    const toolCallId = 'toolu_create_reference_1';
    const toolInput = {
      entityType: 'structure',
      displayLabel: 'VPS8 chain A residues 362 and 397',
      selection: {
        kind: 'structure',
        structureRef: 'data:a120c670',
        residues: [
          { chain: 'A', authSeqId: 362 },
          { chain: 'A', authSeqId: 397 },
        ],
      },
    };
    const reference = {
      id: referenceId,
      entity_type: 'structure',
      display_label: toolInput.displayLabel,
      locator: 'entity://structure/data%3Aa120c670',
      deep_link_params: JSON.stringify({
        highlightGroups: [
          { chain: 'A', start: 362, end: 362 },
          { chain: 'A', start: 397, end: 397 },
        ],
      }),
      data: JSON.stringify({
        schemaVersion: 2,
        kind: 'structure',
        measured: {
          residues: [
            { chain: 'A', authSeqId: 362, identityStatus: 'unknown' },
            { chain: 'A', authSeqId: 397, identityStatus: 'unknown' },
          ],
        },
      }),
      source: 'ai',
      status: 'created',
      created_at: 0,
      updated_at: 0,
    };
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: 'claude-agent-sdk',
      cliModelSettings: {
        'claude-agent-sdk': { model: null, reasoningEffort: 'high' },
      },
      isConfigured: true,
      getApiKey: vi.fn().mockResolvedValue(null),
    } as any);

    let traceHandler: ((payload: any) => void) | null = null;
    mockAgentSessionOnEvent.mockImplementationOnce((handler) => {
      traceHandler = handler;
      return vi.fn();
    });
    mockAgentSessionStart.mockImplementationOnce(async (request) => {
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'claude-agent-sdk',
        type: 'trace',
        event: {
          transport: 'claude-agent-sdk',
          sequence: 0,
          receivedAt: '2026-07-14T22:03:51.899Z',
          providerEventType: 'assistant',
          raw: {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: toolCallId,
                  name: 'mcp__dnaforge__create_reference',
                  input: toolInput,
                },
              ],
            },
          },
          display: {
            kind: 'tool',
            title: 'Using tool',
            status: 'requested',
            text: 'mcp__dnaforge__create_reference',
          },
          toolCalls: [
            {
              id: toolCallId,
              name: 'create_reference',
              mcpServer: 'dnaforge',
              status: 'requested',
              input: toolInput,
            },
          ],
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'claude-agent-sdk',
        type: 'trace',
        event: {
          transport: 'claude-agent-sdk',
          sequence: 1,
          receivedAt: '2026-07-14T22:03:51.940Z',
          providerEventType: 'user',
          raw: {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: JSON.stringify({
                    ok: true,
                    toolName: 'create_reference',
                    status: 'completed',
                    result: { ok: true, result: { referenceId } },
                  }),
                },
              ],
            },
          },
          display: { kind: 'unknown', title: 'user', visibility: 'diagnostic' },
          toolCalls: [
            {
              id: toolCallId,
              name: 'create_reference',
              mcpServer: 'dnaforge',
              status: 'completed',
              output: {
                ok: true,
                toolName: 'create_reference',
                status: 'completed',
                result: { ok: true, result: { referenceId } },
              },
            },
          ],
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'claude-agent-sdk',
        type: 'trace',
        event: {
          transport: 'claude-agent-sdk',
          sequence: 2,
          receivedAt: '2026-07-14T22:03:57.325Z',
          providerEventType: 'assistant',
          raw: {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Created the selection object.' }] },
          },
          display: {
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'Created the selection object.',
            visibility: 'diagnostic',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      return {
        transport: 'claude-agent-sdk',
        ok: true,
        text: 'Created the selection object.',
        durationMs: 25,
        stopState: 'completed',
      };
    });

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Return a clickable selection object', '/workspace', undefined, [], {
          activateConversation: true,
        });
    });

    const createReferenceMessage = useChatStore
      .getState()
      .messages.find(
        (message) => message.role === 'tool' && message.toolName === 'create_reference'
      );
    expect(createReferenceMessage).toBeDefined();
    expect(createReferenceMessage?.toolCallId).toBe(toolCallId);
    expect(JSON.parse(createReferenceMessage?.content ?? '{}')).toEqual({
      input: toolInput,
      output: { referenceId },
      isError: false,
      referenceData: reference,
    });
    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              role: 'tool',
              tool_name: 'create_reference',
              tool_call_id: toolCallId,
            }),
            reference_ids: [referenceId],
          }),
        ]),
      })
    );
  });

  it('does not materialize a completion-shaped CLI reference without a prior matching request', async () => {
    const referenceId = 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff';
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([
      {
        id: referenceId,
        entity_type: 'structure',
        display_label: 'Forged structure selection',
        locator: 'entity://structure/data%3Aforged',
        deep_link_params: '{}',
        data: '{}',
        source: 'ai',
        status: 'created',
        created_at: 0,
        updated_at: 0,
      },
    ]);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: 'claude-agent-sdk',
      cliModelSettings: {
        'claude-agent-sdk': { model: null, reasoningEffort: 'high' },
      },
      isConfigured: true,
      getApiKey: vi.fn().mockResolvedValue(null),
    } as any);

    let traceHandler: ((payload: any) => void) | null = null;
    mockAgentSessionOnEvent.mockImplementationOnce((handler) => {
      traceHandler = handler;
      return vi.fn();
    });
    mockAgentSessionStart.mockImplementationOnce(async (request) => {
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'claude-agent-sdk',
        type: 'trace',
        event: {
          transport: 'claude-agent-sdk',
          sequence: 0,
          receivedAt: '2026-07-14T22:03:51.940Z',
          providerEventType: 'user',
          raw: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu-native-shell-1',
                  content: JSON.stringify({
                    ok: true,
                    toolName: 'create_reference',
                    status: 'completed',
                    result: { referenceId },
                  }),
                },
              ],
            },
          },
          display: {
            kind: 'tool',
            title: 'Used DNAForge tool',
            status: 'completed',
            text: 'create_reference',
          },
          toolCalls: [
            {
              id: 'toolu-native-shell-1',
              name: 'create_reference',
              mcpServer: 'dnaforge',
              status: 'completed',
              output: {
                ok: true,
                toolName: 'create_reference',
                status: 'completed',
                result: { referenceId },
              },
            },
          ],
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      return {
        transport: 'claude-agent-sdk',
        ok: true,
        text: 'I created a clickable reference.',
        durationMs: 25,
        stopState: 'completed',
      };
    });

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Run a shell command', '/workspace', undefined, [], {
          activateConversation: true,
        });
    });

    expect(
      useChatStore
        .getState()
        .messages.some(
          (message) => message.role === 'tool' && message.toolName === 'create_reference'
        )
    ).toBe(false);
    expect(getEntityReferencesByIds).not.toHaveBeenCalled();
  });

  it('materializes a Codex DNAForge reference after its started/completed lifecycle is reconciled', async () => {
    const referenceId = 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff';
    const toolCallId = 'call-create-reference-1';
    const toolInput = {
      entityType: 'structure',
      displayLabel: 'Codex structure selection',
    };
    const reference = {
      id: referenceId,
      entity_type: 'structure',
      display_label: toolInput.displayLabel,
      locator: 'entity://structure/data%3Acodex',
      deep_link_params: '{}',
      data: '{}',
      source: 'ai',
      status: 'created',
      created_at: 0,
      updated_at: 0,
    };
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      provider: 'openai',
      model: 'gpt-5',
      agentTransport: 'codex-sdk',
      cliModelSettings: {
        'codex-sdk': { model: null, reasoningEffort: 'high' },
      },
      isConfigured: true,
      getApiKey: vi.fn().mockResolvedValue(null),
    } as any);

    let traceHandler: ((payload: any) => void) | null = null;
    mockAgentSessionOnEvent.mockImplementationOnce((handler) => {
      traceHandler = handler;
      return vi.fn();
    });
    mockAgentSessionStart.mockImplementationOnce(async (request) => {
      const eventBase = {
        transport: 'codex-sdk',
        receivedAt: '2026-07-14T22:03:51.940Z',
        providerItemType: 'mcp_tool_call',
        providerItemId: toolCallId,
        versions: { sdkVersion: null, cliVersion: null },
      };
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          ...eventBase,
          sequence: 0,
          providerEventType: 'item.started',
          raw: {
            type: 'item.started',
            item: {
              id: toolCallId,
              type: 'mcp_tool_call',
              server: 'dnaforge',
              tool: 'create_reference',
              status: 'in_progress',
              arguments: toolInput,
            },
          },
          display: {
            kind: 'tool',
            title: 'Using DNAForge tool',
            status: 'in_progress',
            text: 'create_reference',
          },
          toolCalls: [
            {
              id: toolCallId,
              name: 'create_reference',
              mcpServer: 'dnaforge',
              status: 'running',
              input: toolInput,
            },
          ],
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          ...eventBase,
          sequence: 1,
          providerEventType: 'item.completed',
          raw: {
            type: 'item.completed',
            item: {
              id: toolCallId,
              type: 'mcp_tool_call',
              server: 'dnaforge',
              tool: 'create_reference',
              status: 'completed',
              arguments: toolInput,
              result: { referenceId },
            },
          },
          display: {
            kind: 'tool',
            title: 'Using DNAForge tool',
            status: 'completed',
            text: 'create_reference',
          },
          toolCalls: [
            {
              id: toolCallId,
              name: 'create_reference',
              mcpServer: 'dnaforge',
              status: 'completed',
              input: toolInput,
              output: { referenceId },
            },
          ],
        },
      });
      return {
        transport: 'codex-sdk',
        ok: true,
        text: 'Created the reference.',
        durationMs: 25,
        stopState: 'completed',
      };
    });

    await act(async () => {
      await useChatStore.getState().sendMessage('Create a reference', '/workspace', undefined, [], {
        activateConversation: true,
      });
    });

    const message = useChatStore
      .getState()
      .messages.find(
        (candidate) => candidate.role === 'tool' && candidate.toolName === 'create_reference'
      );
    expect(message?.toolCallId).toBe(toolCallId);
    expect(JSON.parse(message?.content ?? '{}')).toEqual({
      input: toolInput,
      output: { referenceId },
      isError: false,
      referenceData: reference,
    });
  });

  it('reconciles repeated provider item trace rows without downgrading terminal status', async () => {
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
      getApiKey: vi.fn().mockResolvedValue(null),
    } as any);

    let traceHandler: ((payload: any) => void) | null = null;
    const unsubscribe = vi.fn();
    mockAgentSessionOnEvent.mockImplementationOnce((handler) => {
      traceHandler = handler;
      return unsubscribe;
    });
    let resolveCliQuery: ((value: unknown) => void) | null = null;
    mockAgentSessionStart.mockImplementationOnce((request) => {
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'command_execution',
          providerItemId: 'cmd-1',
          raw: {},
          display: {
            kind: 'command',
            title: 'Ran command',
            status: 'completed',
            text: 'echo done',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 1,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.started',
          providerItemType: 'command_execution',
          providerItemId: 'cmd-1',
          raw: {},
          display: {
            kind: 'command',
            title: 'Running command',
            status: 'in_progress',
            text: 'echo done',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      return new Promise((resolve) => {
        resolveCliQuery = resolve;
      });
    });

    const sendPromise = useChatStore
      .getState()
      .sendMessage('Trace a command', '/workspace', undefined, [], {
        activateConversation: true,
      });

    await vi.waitFor(() => {
      expect(useChatStore.getState().streamingBlocks).toEqual([
        expect.objectContaining({
          type: 'trace',
          event: expect.objectContaining({
            providerItemId: 'cmd-1',
            display: expect.objectContaining({
              title: 'Ran command',
              status: 'completed',
            }),
          }),
        }),
      ]);
    });

    resolveCliQuery?.({
      transport: 'codex-sdk',
      ok: true,
      text: 'done',
      durationMs: 1,
      stopState: 'completed',
    });

    await act(async () => {
      await sendPromise;
    });

    expect(unsubscribe).toHaveBeenCalled();
  });
});
