import type { LanguageModelV3 } from '@ai-sdk/provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createModel,
  createHostedPolicyTools,
  inferInitialDirectToolStep,
  toCanonicalHostedToolName,
  toHostedProviderToolName,
  containsIdentityCompleteStructureSelection,
  consumeHostedStream,
  blocksToMessages,
  createInlineReferenceSession,
  inlineReferenceSession,
  streamText,
  stepCountIs,
  hasToolCall,
} = vi.hoisted(() => {
  const inlineReferenceSession = {
    update: vi.fn((_blockId: string, source: string) => ({
      source,
      renderSource: source,
      parts: [],
    })),
    finalize: vi.fn(async () => ({
      blocks: new Map(),
      proposedRows: [],
      referencedRows: [],
    })),
    cancel: vi.fn(),
  };
  return {
    createModel: vi.fn(),
    createHostedPolicyTools: vi.fn(),
    inferInitialDirectToolStep: vi.fn(),
    toCanonicalHostedToolName: vi.fn((name: string) => {
      const canonicalNames: Record<string, string> = {
        assembly_listEditableFields: 'assembly.listEditableFields',
        assembly_setEditableField: 'assembly.setEditableField',
        external_fetch: 'external.fetch',
        external_xref: 'external.xref',
        workspace_gitStatus: 'workspace.gitStatus',
      };
      return canonicalNames[name] ?? name;
    }),
    toHostedProviderToolName: vi.fn((name: string) => name.replaceAll('.', '_')),
    containsIdentityCompleteStructureSelection: vi.fn(),
    consumeHostedStream: vi.fn(),
    blocksToMessages: vi.fn(),
    createInlineReferenceSession: vi.fn(() => inlineReferenceSession),
    inlineReferenceSession,
    streamText: vi.fn(() => ({ fullStream: {} })),
    stepCountIs: vi.fn(() => vi.fn()),
    hasToolCall: vi.fn(() => vi.fn()),
  };
});

vi.mock('ai', () => ({ streamText, stepCountIs, hasToolCall }));
vi.mock('../providers', () => ({
  createModel,
}));
vi.mock('../../../db/entity-references', () => ({ getEntityReferencesByIds: vi.fn() }));
vi.mock('../../../platform', () => ({ platform: vi.fn() }));
vi.mock('../prompts/system-prompt', () => ({ buildSystemPrompt: vi.fn() }));
vi.mock('../transports/hosted', () => ({
  consumeHostedStream,
  hostedStreamEventType: vi.fn(),
  jsonSafeForIpc: vi.fn(),
}));
vi.mock('./chat-projections', () => ({ blocksToMessages, createdAtAfter: vi.fn(() => 1) }));
vi.mock('./chat-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chat-runtime')>()),
  setConversationState: vi.fn(),
}));
vi.mock('./chat-store-types', () => ({ EMPTY_CONV_STATE: {} }));
vi.mock('./reference-context', () => ({
  containsIdentityCompleteStructureSelection,
}));
vi.mock('./tool-policy', () => ({ inferInitialDirectToolStep }));
vi.mock('./hosted-policy-tools', () => ({
  createHostedPolicyTools,
  toCanonicalHostedToolName,
  toHostedProviderToolName,
}));
vi.mock('../references/inline/session', () => ({ createInlineReferenceSession }));

import { createHostedToolApprovalAuthority } from '../hosted/tool-approval-authority';
import {
  executeHostedTurn,
  HostedStopTerminalError,
  projectHostedToolResult,
  prepareHostedAgentStep,
  resolveHostedTurnModel,
} from './execute-hosted-turn';

const injectedModel = {
  specificationVersion: 'v3',
  provider: 'dnaforge-hosted',
  modelId: 'hosted:auto',
  supportedUrls: {},
  doGenerate: vi.fn(),
  doStream: vi.fn(),
} as unknown as LanguageModelV3;

const nativeToolExecutor = vi.fn(async () => ({
  output: { ok: true },
  effectReceiptRef: 'native-effect-1',
}));

describe('executeHostedTurn model injection', () => {
  beforeEach(() => {
    createModel.mockReset();
    createHostedPolicyTools.mockReset().mockReturnValue({});
    inferInitialDirectToolStep.mockReset();
    toCanonicalHostedToolName.mockClear();
    toHostedProviderToolName.mockClear();
    nativeToolExecutor.mockClear();
    containsIdentityCompleteStructureSelection.mockReset();
    consumeHostedStream.mockReset();
    blocksToMessages.mockReset().mockReturnValue([]);
    createInlineReferenceSession.mockClear();
    streamText.mockClear();
    stepCountIs.mockClear();
    hasToolCall.mockClear();
    inlineReferenceSession.update.mockClear();
    inlineReferenceSession.finalize.mockClear();
    inlineReferenceSession.cancel.mockClear();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('uses the Hosted model and required ledger identity without API-key model creation', async () => {
    await expect(
      resolveHostedTurnModel({
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
      })
    ).resolves.toEqual({
      model: injectedModel,
      ledgerIdentity: {
        source: 'hosted:router',
        provider: 'dnaforge-hosted',
        model: 'hosted:auto',
      },
    });
    expect(createModel).not.toHaveBeenCalled();
  });

  it('retains direct-provider creation and ledger identity', async () => {
    const directModel = { provider: 'anthropic' };
    createModel.mockResolvedValue(directModel);

    await expect(
      resolveHostedTurnModel({
        provider: 'anthropic',
        modelName: 'claude-sonnet-4-6',
        apiKey: 'direct-key',
      })
    ).resolves.toEqual({
      model: directModel,
      ledgerIdentity: {
        source: 'provider:vercel',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    });
    expect(createModel).toHaveBeenCalledWith('anthropic', 'direct-key', 'claude-sonnet-4-6');
  });

  it('rejects caller-asserted Hosted ledger provenance that does not match the model', async () => {
    await expect(
      resolveHostedTurnModel({
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:deep',
          },
        },
      })
    ).rejects.toThrow(/ledger identity/i);
    expect(createModel).not.toHaveBeenCalled();
  });

  it('fails closed when neither an injection nor complete direct credentials are supplied', async () => {
    await expect(
      resolveHostedTurnModel({ provider: 'anthropic', modelName: 'claude-sonnet-4-6' })
    ).rejects.toThrow(/API key/i);
    expect(createModel).not.toHaveBeenCalled();
  });

  it('passes the per-turn gateway approval authority only to Hosted policy tools', async () => {
    const approvalAuthority = createHostedToolApprovalAuthority();
    const stopAfterPolicyCreation = new Error('stop after policy creation');
    createHostedPolicyTools.mockImplementationOnce(() => {
      throw stopAfterPolicyCreation;
    });
    const folders = [{ path: '/lab/project', name: 'project', addedAt: 1 }];

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: approvalAuthority,
        nativeToolExecutor,
        folders,
        modelMessages: [{ role: 'user', content: 'Inspect my workspace.' }],
        content: 'Inspect my workspace.',
        allowedExistingReferenceIds: [],
        workspaceScope: 'folders:["/lab/project"]',
        isWorkspaceScopeCurrent: () => true,
        workspacePath: '/lab/project',
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).rejects.toBe(stopAfterPolicyCreation);

    expect(createHostedPolicyTools).toHaveBeenCalledWith(folders, {
      turnId: 'turn-1',
      toolNameFormat: 'canonical',
      serverApprovalAuthority: approvalAuthority,
      nativeToolExecutor,
    });
  });

  it('rejects a Hosted model injection without its server approval authority', async () => {
    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        folders: [],
        modelMessages: [],
        content: 'Inspect my workspace.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).rejects.toThrow(/requires.*approval authority/i);
    expect(createHostedPolicyTools).not.toHaveBeenCalled();
  });

  it('rejects a Hosted model injection without its native tool executor', async () => {
    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: createHostedToolApprovalAuthority(),
        folders: [],
        modelMessages: [],
        content: 'Inspect my workspace.',
        stagedReferenceIds: [],
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        finishTurn: vi.fn(),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).rejects.toThrow(/requires.*native tool executor/i);
    expect(createHostedPolicyTools).not.toHaveBeenCalled();
  });

  it('rejects a native tool executor on a direct-provider turn', async () => {
    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        provider: 'anthropic',
        modelName: 'claude-sonnet-4-6',
        apiKey: 'direct-key',
        nativeToolExecutor,
        folders: [],
        modelMessages: [],
        content: 'Inspect my workspace.',
        stagedReferenceIds: [],
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        finishTurn: vi.fn(),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).rejects.toThrow(/native tool executor.*only valid.*Hosted/i);
    expect(createHostedPolicyTools).not.toHaveBeenCalled();
  });

  it('removes all tools from the final allowed model step', () => {
    const initialToolStep = { toolChoice: { type: 'tool', toolName: 'list_files' } } as const;

    expect(prepareHostedAgentStep(0, initialToolStep)).toEqual(initialToolStep);
    expect(prepareHostedAgentStep(14, initialToolStep)).toBeUndefined();
    expect(prepareHostedAgentStep(15, initialToolStep)).toEqual({
      activeTools: [],
      toolChoice: 'none',
    });
  });

  it('continues molecular prose after reference creation and retains the ordinary Direct shortcut', async () => {
    createModel.mockResolvedValue(injectedModel);
    consumeHostedStream.mockResolvedValue(undefined);

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-1', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        provider: 'anthropic',
        modelName: 'claude-sonnet-4-6',
        apiKey: 'direct-key',
        folders: [],
        modelMessages: [{ role: 'user', content: 'Return a rich typed selection.' }],
        content: 'Return a rich typed selection.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(async () => undefined),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).resolves.toBe('completed');

    const stop = streamText.mock.calls.at(-1)![0].stopWhen[1];
    expect(
      stop({
        steps: [
          { toolCalls: [{ toolName: 'create_reference', input: { entityType: 'structure' } }] },
        ],
      })
    ).toBe(false);
    expect(
      stop({
        steps: [{ toolCalls: [{ toolName: 'create_reference', input: { entityType: 'primer' } }] }],
      })
    ).toBe(true);
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: [expect.any(Function), expect.any(Function)],
      })
    );

    hasToolCall.mockClear();
    consumeHostedStream.mockImplementationOnce(async () => {
      throw new Error('hosted failure');
    });
    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-2', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-2',
        turnId: 'turn-2',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: createHostedToolApprovalAuthority(),
        nativeToolExecutor,
        folders: [],
        modelMessages: [{ role: 'user', content: 'Return a rich typed selection.' }],
        content: 'Return a rich typed selection.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(async () => undefined),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).rejects.toThrow('hosted failure');
    expect(hasToolCall).not.toHaveBeenCalled();
  });

  it('projects dotted canonical tool names to provider-safe Direct API aliases', async () => {
    createModel.mockResolvedValue(injectedModel);
    createHostedPolicyTools.mockReturnValueOnce({ external_fetch: { execute: vi.fn() } });
    inferInitialDirectToolStep.mockReturnValueOnce({
      toolChoice: { type: 'tool', toolName: 'external.fetch' },
      activeTools: ['external.fetch'],
    });
    consumeHostedStream.mockResolvedValueOnce(undefined);
    const content = 'Fetch the external record.';

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-1', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        provider: 'anthropic',
        modelName: 'claude-sonnet-4-6',
        apiKey: 'direct-key',
        folders: [{ path: '/lab/project', name: 'project', addedAt: 1 }],
        modelMessages: [{ role: 'user', content }],
        content,
        allowedExistingReferenceIds: [],
        workspaceScope: 'folders:["/lab/project"]',
        isWorkspaceScopeCurrent: () => true,
        workspacePath: '/lab/project',
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(async () => undefined),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).resolves.toBe('completed');

    expect(createHostedPolicyTools).toHaveBeenCalledWith(expect.any(Array), {
      turnId: 'turn-1',
      toolNameFormat: 'provider-safe',
    });
    expect(inferInitialDirectToolStep).toHaveBeenCalledWith(content, ['external.fetch'], true);
    const directCall = streamText.mock.calls[0]?.[0];
    expect(directCall?.tools).toEqual({ external_fetch: { execute: expect.any(Function) } });
    expect(directCall?.prepareStep({ stepNumber: 0 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'external_fetch' },
      activeTools: ['external_fetch'],
    });
  });

  it('coalesces provider deltas into one final projection without artificial character pacing', async () => {
    consumeHostedStream.mockImplementationOnce(
      async ({ onText }: { onText: (delta: string) => void }) => {
        onText('Open ');
        onText('[pUC19](dnaforge-chat://entity/sequence/Lab/pUC19.gb)');
        onText(' now.');
      }
    );

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-1', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: createHostedToolApprovalAuthority(),
        nativeToolExecutor,
        folders: [],
        modelMessages: [],
        content: 'Open pUC19.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(async () => undefined),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).resolves.toBe('completed');

    expect(inlineReferenceSession.update.mock.calls).toEqual([
      ['turn-1:hosted-text:0', 'Open [pUC19](dnaforge-chat://entity/sequence/Lab/pUC19.gb) now.'],
    ]);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('projects a receipt-recorded Hosted execution failure as a failed tool card', () => {
    expect(
      projectHostedToolResult({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read_file',
        input: { path: '/known/workspace/file.gb' },
        output: {
          __dnaforgeHostedExecutionFailure: true,
          message: 'The file could not be read.',
        },
      })
    ).toEqual({
      input: { path: '/known/workspace/file.gb' },
      output: { error: 'The file could not be read.' },
      isError: true,
    });
  });

  it('projects a declined Hosted execution as a clear failed tool card', () => {
    const projected = projectHostedToolResult({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'create_design',
      input: { name: 'Declined design' },
      output: {
        __dnaforgeHostedExecutionDenied: true,
        code: 'USER_DECLINED',
        reason: 'The user declined this workspace change.',
      },
    });

    expect(projected).toEqual({
      input: { name: 'Declined design' },
      output: { error: 'The user declined this workspace change.' },
      isError: true,
    });
    expect(JSON.stringify(projected)).not.toContain('__dnaforgeHostedExecutionDenied');
  });

  it('projects a tool stopped before execution without calling it a user decline', () => {
    const projected = projectHostedToolResult({
      type: 'tool-result',
      toolCallId: 'call-stopped',
      toolName: 'get_workspace',
      input: {},
      output: {
        __dnaforgeHostedExecutionFailure: true,
        message: 'Stopped before this tool ran.',
      },
    });

    expect(projected).toEqual({
      input: {},
      output: { error: 'Stopped before this tool ran.' },
      isError: true,
    });
    expect(JSON.stringify(projected)).not.toContain('declined');
  });

  it('keeps ordinary tool errors visible instead of serializing Error as an empty object', () => {
    expect(
      projectHostedToolResult({
        type: 'tool-error',
        toolCallId: 'call-1',
        toolName: 'read_file',
        input: { path: 'missing.gb' },
        error: new Error('File not found.'),
      })
    ).toEqual({
      input: { path: 'missing.gb' },
      output: { error: 'File not found.' },
      isError: true,
    });
  });

  it('awaits the server terminal barrier before marking an aborted Hosted turn stopped', async () => {
    const controller = new AbortController();
    consumeHostedStream.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Stop requested.', 'AbortError');
    });
    const order: string[] = [];
    const onStopped = vi.fn(async () => {
      order.push('server-terminal');
    });
    const finishTurn = vi.fn(async () => {
      order.push('local-terminal');
    });

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-1', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: createHostedToolApprovalAuthority(),
        nativeToolExecutor,
        folders: [],
        modelMessages: [],
        content: 'Inspect my workspace.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller,
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn,
        trackShadowLedgerAppend: vi.fn(),
        onStopped,
      })
    ).resolves.toBe('stopped');
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['server-terminal', 'local-terminal']);
  });

  it('cancels inline reference proposals when the Hosted stream fails', async () => {
    const streamFailure = new Error('provider stream failed');
    consumeHostedStream.mockRejectedValueOnce(streamFailure);

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-1', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: createHostedToolApprovalAuthority(),
        nativeToolExecutor,
        folders: [],
        modelMessages: [{ role: 'user', content: 'Inspect my workspace.' }],
        content: 'Inspect my workspace.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(),
        trackShadowLedgerAppend: vi.fn(),
      })
    ).rejects.toBe(streamFailure);

    expect(inlineReferenceSession.cancel).toHaveBeenCalledTimes(1);
    expect(inlineReferenceSession.finalize).toHaveBeenCalledTimes(1);
  });

  it('does not report a clean Stop when the server terminal barrier refuses it', async () => {
    const controller = new AbortController();
    consumeHostedStream.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Stop requested.', 'AbortError');
    });
    const finishTurn = vi.fn();

    await expect(
      executeHostedTurn({
        set: vi.fn(),
        get: vi.fn(() => ({ _convStates: new Map([['conversation-1', { streamingBlocks: [] }]]) })),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        modelInjection: {
          model: injectedModel,
          ledgerIdentity: {
            source: 'hosted:router',
            provider: 'dnaforge-hosted',
            model: 'hosted:auto',
          },
        },
        serverToolApprovalAuthority: createHostedToolApprovalAuthority(),
        nativeToolExecutor,
        folders: [],
        modelMessages: [],
        content: 'Inspect my workspace.',
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller,
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn,
        trackShadowLedgerAppend: vi.fn(),
        onStopped: async () => {
          throw new Error('agent_tool_observations_pending');
        },
      })
    ).rejects.toBeInstanceOf(HostedStopTerminalError);
    expect(finishTurn).not.toHaveBeenCalled();
  });
});
