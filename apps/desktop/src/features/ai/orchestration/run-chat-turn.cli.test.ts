import { userMessage } from '@waypoint/user-messages';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSdkDetectionShape } from '../../../platform';
import {
  createMolecularPromptTrial,
  readMolecularTrialSentPromptSnapshot,
  writeMolecularPromptTrial,
} from '../molecular-prompt-trials';

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
  mockAgentCapabilitiesResolve,
  mockConversationLedgerAppendEvent,
  mockReconcileCliWorkspaceChanges,
  mockScanWorkspaceFiles,
} = getUseChatConversationHarness();

const selectedCodexSkill = {
  id: 'codex-sdk:skill:tdd',
  provider: 'codex-sdk' as const,
  nativeId: 'tdd',
  kind: 'skill' as const,
  label: 'tdd',
  description: 'Test first.',
  scope: 'workspace' as const,
  effects: ['instructions' as const],
  availability: { state: 'supported' as const },
  stages: {
    advertised: true,
    discoverable: true,
    invocable: true,
    visible: true,
    deterministic: true,
    liveQualified: false,
  },
};

describe('runChatTurn CLI execution and trace lifecycle', () => {
  beforeEach(resetUseChatConversationHarness);
  beforeEach(() => localStorage.clear());

  it.each(['high', 'xhigh'] as const)(
    'sends fresh molecular trial effort %s without changing shared or ordinary-chat settings',
    async (reasoningEffort) => {
      const sharedModelSettings = Object.freeze({
        model: 'gpt-6-astra',
        reasoningEffort: 'high' as const,
        serviceTier: 'priority',
        personality: 'pragmatic',
      });
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        ...useAISettingsStore.getState(),
        assistantRoute: { kind: 'cli', transport: 'codex-sdk', permissionMode: 'native-cli' },
        cliModelSettings: { 'codex-sdk': sharedModelSettings },
        getApiKey: vi.fn(),
      });
      const conversationId = '00000000-0000-4000-8000-000000000060';
      const trial = createMolecularPromptTrial({
        conversationId,
        caseId: 'kcsa',
        profileId: 'camera-v1',
        fixtures: [
          {
            pdbId: '1K4C',
            referenceId: '00000000-0000-4000-8000-000000000061',
            savedViewId: 'saved-view:00000000-0000-4000-8000-000000000062',
            coordinateSha256: 'a'.repeat(64),
            initialSceneSha256: 'b'.repeat(64),
            initialCameraSignature: '[]',
            structureSignature: '["assembly:1"]',
          },
        ],
        execution: {
          kind: 'background-worker',
          jobId: '00000000-0000-4000-8000-000000000063',
          renderProfile: 'default',
          startPolicyVersion: 1,
          reasoningEffort,
        },
      });
      writeMolecularPromptTrial(trial);
      const previousElectronApi = window.electronAPI;
      vi.stubGlobal('electronAPI', { proteinExperimentWorkers: { bind: vi.fn() } });
      try {
        await act(async () => {
          await useChatStore.getState().sendMessage(trial.question, null, conversationId);
        });
        expect(mockAgentSessionStart).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId,
            provider: 'codex-sdk',
            model: sharedModelSettings.model,
            modelReasoningEffort: reasoningEffort,
            modelServiceTier: sharedModelSettings.serviceTier,
            modelPersonality: sharedModelSettings.personality,
          })
        );
        expect(readMolecularTrialSentPromptSnapshot(conversationId)?.agentConfiguration).toEqual({
          transport: 'codex-sdk',
          ...sharedModelSettings,
          reasoningEffort,
        });
        await act(async () => {
          await useChatStore.getState().sendMessage('An ordinary chat', null);
        });
        expect(mockAgentSessionStart).toHaveBeenLastCalledWith(
          expect.objectContaining({ modelReasoningEffort: 'high' })
        );
        expect(useAISettingsStore.getState().cliModelSettings?.['codex-sdk']).toBe(
          sharedModelSettings
        );
        expect(sharedModelSettings.reasoningEffort).toBe('high');
      } finally {
        vi.stubGlobal('electronAPI', previousElectronApi);
      }
    }
  );

  it('rejects a stale account model before accepting a user message or attachments', async () => {
    const previous = useAISettingsStore.getState();
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      ...previous,
      assistantRoute: { kind: 'cli', transport: 'codex-sdk', permissionMode: 'app-supervised' },
      agentTransport: 'codex-sdk',
      agentDetection: {
        codex: {
          cli: 'installed',
          path: '/fixture/codex',
          auth: 'authenticated',
          authMode: 'chatgpt',
          authFilePresent: true,
          defaultModel: 'gpt-future-compatible',
          models: [
            {
              id: 'gpt-future-compatible',
              displayName: 'Current account model',
              reasoningEfforts: [],
              isDefault: true,
            },
          ],
          modelCatalog: {
            status: 'complete',
            source: 'codex-app-server',
            executablePath: '/fixture/codex',
            observedModelCount: 1,
            error: null,
          },
        },
        claudeCode: {
          cli: 'missing',
          path: null,
          auth: 'unauthenticated',
          defaultModel: null,
          keychainEntryPresent: false,
          credentialsFilePresent: false,
        },
      },
      cliModelSettings: { 'codex-sdk': { model: 'gpt-stale-custom', reasoningEffort: null } },
    } as ReturnType<typeof useAISettingsStore.getState>);
    const onNotStarted = vi.fn();
    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Keep my full draft', '/workspace', undefined, [], { onNotStarted });
    });
    expect(onNotStarted).toHaveBeenCalledWith(expect.stringMatching(/Choose an available model/));
    expect(mockAgentSessionStart).not.toHaveBeenCalled();
    expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
  });

  it('dispatches through the settled registry default instead of the provider projection', async () => {
    const getApiKey = vi.fn().mockResolvedValue('sk-should-not-be-used');
    const detection: AgentSdkDetectionShape = {
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: 'gpt-5.5',
        authMode: 'chatgpt',
        authFilePresent: true,
      },
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: false,
        credentialsFilePresent: false,
      },
    };
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      agentDetection: detection,
      agentDetectError: null,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: false },
        google: { isConfigured: false },
        xai: { isConfigured: false },
        deepseek: { isConfigured: false },
      },
      providerModels: {
        anthropic: { models: ['claude-sonnet-4-6'] },
        openai: { models: [] },
        google: { models: [] },
        xai: { models: [] },
        deepseek: { models: [] },
      },
      cliModelSettings: {
        'codex-sdk': { model: null, reasoningEffort: 'high' },
        'claude-agent-sdk': { model: null, reasoningEffort: 'high' },
      },
      hostedRouteReadiness: 'gateway-unavailable',
      agentPermissions: { codex: ':workspace' },
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('Use the settled default', '/workspace');
    });

    expect(getApiKey).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(mockAgentSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex-sdk' })
    );
    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ route_kind: 'cli', host_id: 'codex-cli' }),
      })
    );
  });

  it('fails closed before dispatch while the first-run route is unresolved', async () => {
    const getApiKey = vi.fn().mockResolvedValue('sk-should-not-be-used');
    const onNotStarted = vi.fn();
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: null,
      agentDetection: null,
      agentDetectError: null,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: false },
        google: { isConfigured: false },
        xai: { isConfigured: false },
        deepseek: { isConfigured: false },
      },
      providerModels: {
        anthropic: { models: ['claude-sonnet-4-6'] },
        openai: { models: [] },
        google: { models: [] },
        xai: { models: [] },
        deepseek: { models: [] },
      },
      hostedRouteReadiness: 'gateway-unavailable',
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('Wait for the route', '/workspace', undefined, [], { onNotStarted });
    });

    expect(getApiKey).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(mockAgentSessionStart).not.toHaveBeenCalled();
    expect(onNotStarted).toHaveBeenCalledWith(
      userMessage('failure.still-checking-available-ai-routes-try-again-in-a-moment')
    );
  });

  it.each(['codex-sdk', 'claude-agent-sdk'] as const)(
    'saves the same capacity failure it shows for %s',
    async (transport) => {
      vi.mocked(useAISettingsStore.getState).mockReturnValue({
        ...useAISettingsStore.getState(),
        assistantRoute: { kind: 'cli', transport, permissionMode: 'native-cli' },
      });
      mockAgentSessionStart.mockResolvedValue({
        ok: false,
        text: '',
        error: 'Synthetic provider detail',
        stopState: 'failed',
        failure: { reason: 'provider_capacity', stage: 'provider_stream' },
      });
      await act(async () => {
        await useChatStore.getState().sendMessage('Test this turn', null, undefined, [], {
          activateConversation: true,
        });
      });
      const request = mockAgentSessionStart.mock.calls[0][0];
      const message = userMessage('assistant.nativeCapacity');
      expect(db.commitChatTurnTerminalState).toHaveBeenCalledTimes(1);
      expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
        expect.objectContaining({
          turn_id: request.turnId,
          status: 'failed',
          terminal_reason: 'native:provider_stream:provider_capacity',
          error: message,
        })
      );
      expect(useChatStore.getState().error).toBe(message);
    }
  );

  it('uses selected CLI transport without provider API key streaming', async () => {
    const getApiKey = vi.fn().mockResolvedValue(null);
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'app-supervised',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      agentTransport: 'codex-sdk',
      cliExecutablePathOverrides: { 'codex-sdk': '/opt/lab/bin/codex' },
      cliModelSettings: {
        'codex-sdk': {
          model: 'gpt-5-codex',
          reasoningEffort: 'high',
          serviceTier: 'priority',
          personality: 'pragmatic',
        },
        'claude-agent-sdk': { model: null, reasoningEffort: null },
      },
      agentPermissions: { codex: ':workspace' },
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
        .sendMessage('Use the CLI session', '/workspace', undefined, [], {
          activateConversation: true,
        });
    });

    expect(getApiKey).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(mockAgentSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex-sdk',
        binaryPathOverride: '/opt/lab/bin/codex',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: expect.stringContaining('<wp-conversation-'),
        continuationPrompt: expect.stringContaining('<wp-conversation-delta-'),
        cwd: '/workspace',
        sessionId: expect.any(String),
        conversationId: expect.any(String),
        turnId: expect.any(String),
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
        modelServiceTier: 'priority',
        modelPersonality: 'pragmatic',
        permissions: expect.objectContaining({
          codex: ':workspace',
        }),
      })
    );
    expect(
      promptDataFenceRecords(mockAgentSessionStart.mock.calls[0][0].prompt, 'wp-conversation')[0]
        .messages
    ).toEqual([]);
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain('Use the CLI session');
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain('role="user"');
    expect(
      promptDataFenceRecords(
        mockAgentSessionStart.mock.calls[0][0].continuationPrompt,
        'wp-conversation-delta'
      )[0].messages
    ).toEqual([{ role: 'user', content: 'Use the CLI session' }]);
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'restricted provider-native shell, web, and file-write access'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'standard Local CLI tools route is needed'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'this legacy restricted route is the limitation'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'Do not reveal hidden private chain-of-thought'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'offer explicit open actions instead of opening by default'
    );
    expect(mockScanWorkspaceFiles).not.toHaveBeenCalled();
    expect(mockReconcileCliWorkspaceChanges).not.toHaveBeenCalled();
    expect(db.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      'New conversation',
      '/workspace',
      'codex-sdk',
      'codex-sdk'
    );
    expect(db.createChatTurnWithUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({
          route_kind: 'cli',
          host_id: 'codex-cli',
          transport: 'codex-sdk',
          authority_profile_id: 'codex-sdk:app-supervised',
          permission_mode: 'app-supervised',
          status: 'running',
        }),
        message: expect.objectContaining({
          role: 'user',
          content: 'Use the CLI session',
        }),
      })
    );
    const turnId = vi.mocked(db.createChatTurnWithUserMessage).mock.calls[0][0].turn.id;
    expect(mockAgentSessionStart.mock.calls[0][0]).toMatchObject({
      turnId,
    });

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toEqual(
      expect.objectContaining({ role: 'assistant', content: 'CLI response' })
    );
  });

  it('revalidates and projects a structured skill selection into the provider prompt', async () => {
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      agentTransport: 'codex-sdk',
      cliModelSettings: {
        'codex-sdk': { model: null, reasoningEffort: 'high' },
      },
      agentPermissions: {},
      isConfigured: true,
      providerStatuses: {},
    } as any);
    mockAgentCapabilitiesResolve.mockResolvedValue({ ok: true, control: selectedCodexSkill });

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('implement the parser', '/workspace', undefined, [], {
          capabilitySelection: {
            snapshotId: 'snapshot-1',
            provider: 'codex-sdk',
            capabilityId: selectedCodexSkill.id,
          },
        });
    });

    expect(mockAgentCapabilitiesResolve).toHaveBeenCalledWith({
      snapshotId: 'snapshot-1',
      provider: 'codex-sdk',
      capabilityId: selectedCodexSkill.id,
    });
    expect(mockAgentSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilitySelection: {
          snapshotId: 'snapshot-1',
          provider: 'codex-sdk',
          capabilityId: selectedCodexSkill.id,
        },
      })
    );
    expect(
      promptDataFenceRecords(mockAgentSessionStart.mock.calls[0][0].prompt, 'wp-conversation')[0]
        .messages
    ).toEqual([]);
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain('$tdd implement the parser');
  });

  it('rejects a stale selected action before making the user turn durable', async () => {
    const onNotStarted = vi.fn();
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      agentTransport: 'codex-sdk',
      isConfigured: true,
      providerStatuses: {},
    } as any);
    mockAgentCapabilitiesResolve.mockResolvedValue({ ok: false, reason: 'stale-snapshot' });

    await act(async () => {
      await useChatStore
        .getState()
        .sendMessage('implement the parser', '/workspace', undefined, [], {
          onNotStarted,
          capabilitySelection: {
            snapshotId: 'snapshot-old',
            provider: 'codex-sdk',
            capabilityId: selectedCodexSkill.id,
          },
        });
    });

    expect(onNotStarted).toHaveBeenCalledWith(expect.stringMatching(/action is stale/i));
    expect(db.createConversation).not.toHaveBeenCalled();
    expect(db.createChatTurnWithUserMessage).not.toHaveBeenCalled();
    expect(mockAgentSessionStart).not.toHaveBeenCalled();
  });

  it('passes the visible tab conversation ID into CLI session start', async () => {
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'app-supervised',
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
        .sendMessage('Use the visible tab CLI session', '/workspace', 'tab-cli-conv-123', [], {
          activateConversation: true,
        });
    });

    expect(db.createConversation).toHaveBeenCalledWith(
      'tab-cli-conv-123',
      'New conversation',
      '/workspace',
      'codex-sdk',
      'codex-sdk'
    );
    expect(mockAgentSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'tab-cli-conv-123',
      })
    );
    expect(useChatStore.getState().currentConversationId).toBe('tab-cli-conv-123');
  });

  it('uses the canonical CLI assistant route even when the legacy transport mirror is empty', async () => {
    const getApiKey = vi.fn().mockResolvedValue('sk-should-not-be-used');
    vi.mocked(useAISettingsStore.getState).mockReturnValue({
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      provider: 'openai',
      model: 'gpt-4o',
      agentTransport: null,
      cliModelSettings: {
        'codex-sdk': { model: 'gpt-5-codex', reasoningEffort: 'xhigh' },
        'claude-agent-sdk': { model: null, reasoningEffort: null },
      },
      isConfigured: true,
      providerStatuses: {
        anthropic: { isConfigured: true },
        openai: { isConfigured: true },
      },
      getApiKey,
    } as any);

    await act(async () => {
      await useChatStore.getState().sendMessage('Use the canonical CLI route', '/workspace');
    });

    expect(getApiKey).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(mockAgentSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        prompt: expect.stringContaining('normal local CLI agent turn'),
        cwd: '/workspace',
        sessionId: expect.any(String),
        conversationId: expect.any(String),
        model: 'gpt-5-codex',
        modelReasoningEffort: 'xhigh',
      })
    );
    expect(mockScanWorkspaceFiles).toHaveBeenCalledWith('/workspace');
    expect(mockReconcileCliWorkspaceChanges).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      before: expect.objectContaining({ rootPath: '/workspace' }),
    });
    expect(db.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      'New conversation',
      '/workspace',
      'codex-sdk',
      'codex-sdk'
    );
  });

  it('subscribes to CLI trace events and appends only user-visible CLI activity', async () => {
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

    let traceHandler: ((payload: any) => void) | null = null;
    const unsubscribe = vi.fn();
    mockAgentSessionOnEvent.mockImplementationOnce((handler) => {
      traceHandler = handler;
      return unsubscribe;
    });
    let resolveCliQuery: ((value: unknown) => void) | null = null;
    mockAgentSessionStart.mockImplementationOnce((request) => {
      traceHandler?.({
        sessionId: 'other-turn',
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          raw: {},
          display: { kind: 'assistant_text', title: 'Ignored', text: 'wrong turn' },
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
          providerEventType: 'thread.started',
          raw: {},
          display: { kind: 'lifecycle', title: 'thread.started' },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 2,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'agent_message',
          raw: {},
          display: { kind: 'assistant_text', title: 'Assistant', text: 'I’ll inspect first.' },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 3,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'reasoning',
          raw: {},
          display: { kind: 'reasoning', title: 'Thinking', text: 'trace text' },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      traceHandler?.({
        sessionId: request.sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 4,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'agent_message',
          raw: {},
          display: { kind: 'assistant_text', title: 'Assistant', text: 'Now I can answer.' },
          versions: { sdkVersion: null, cliVersion: null },
        },
      });
      return new Promise((resolve) => {
        resolveCliQuery = resolve;
      });
    });

    const sendPromise = useChatStore
      .getState()
      .sendMessage('Trace this', '/workspace', undefined, [], { activateConversation: true });

    await vi.waitFor(() => {
      expect(useChatStore.getState().streamingBlocks).toEqual([
        expect.objectContaining({
          type: 'assistant_text',
          content: 'I’ll inspect first.',
          event: expect.objectContaining({
            providerEventType: 'item.completed',
            providerItemType: 'agent_message',
          }),
        }),
        expect.objectContaining({
          type: 'trace',
          event: expect.objectContaining({
            providerEventType: 'item.completed',
            providerItemType: 'reasoning',
            display: expect.objectContaining({ text: 'trace text' }),
          }),
        }),
        expect.objectContaining({
          type: 'assistant_text',
          content: 'Now I can answer.',
          event: expect.objectContaining({
            providerEventType: 'item.completed',
            providerItemType: 'agent_message',
          }),
        }),
      ]);
    });

    expect(mockAgentSessionStart.mock.calls[0][0]).toMatchObject({
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:native-workspace-write-dev',
      cwd: '/workspace',
    });
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain('normal local CLI agent turn');
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'you MUST use the DNAForge tools'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'Do not hand-parse app documents'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).toContain(
      'For analysis no DNAForge tool covers, such as BLAST, multiple sequence alignment'
    );
    expect(mockAgentSessionStart.mock.calls[0][0].prompt).not.toContain('Do NOT shell out');

    resolveCliQuery?.({
      transport: 'codex-sdk',
      ok: true,
      text: 'Final from trace',
      durationMs: 1,
      stopState: 'completed',
    });

    await act(async () => {
      await sendPromise;
    });

    expect(unsubscribe).toHaveBeenCalled();
    const stateMessages = useChatStore.getState().messages;
    expect(stateMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'activity',
      'assistant',
      'assistant',
    ]);
    expect(stateMessages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Final from trace',
    });
    expect(stateMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'I’ll inspect first.' }),
      ])
    );
    const activityMessage = stateMessages.find((message) => message.role === 'activity');
    expect(decodeAgentActivityMessage(activityMessage?.content ?? '')).toMatchObject({
      providerEventType: 'item.completed',
      providerItemType: 'reasoning',
      display: expect.objectContaining({ text: 'trace text' }),
    });
    expect(JSON.stringify(stateMessages)).not.toContain('thread.started');
    expect(JSON.stringify(stateMessages)).not.toContain('wrong turn');
    expect(JSON.stringify(stateMessages)).toContain('Final from trace');
    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              role: 'assistant',
              content: 'I’ll inspect first.',
            }),
          }),
          expect.objectContaining({
            message: expect.objectContaining({
              role: 'activity',
              content: expect.stringContaining('"type":"agent.activity"'),
            }),
          }),
        ]),
      })
    );
  });

  it('quarantines late CLI trace events after Stop is requested', async () => {
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

    let traceHandler: ((payload: any) => void) | null = null;
    mockAgentSessionOnEvent.mockImplementationOnce((handler) => {
      traceHandler = handler;
      return vi.fn();
    });
    let sessionId = '';
    let resolveCliQuery: ((value: unknown) => void) | null = null;
    mockAgentSessionStart.mockImplementationOnce((request) => {
      sessionId = request.sessionId ?? '';
      traceHandler?.({
        sessionId,
        provider: 'codex-sdk',
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.started',
          providerItemType: 'command_execution',
          providerItemId: 'cmd-slow',
          raw: {},
          display: {
            kind: 'command',
            title: 'Running command',
            status: 'in_progress',
            text: 'sleep 20',
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
      .sendMessage('Run a slow command', '/workspace', undefined, [], {
        activateConversation: true,
      });

    await vi.waitFor(() => {
      expect(useChatStore.getState().streamingBlocks).toHaveLength(1);
    });

    await act(async () => {
      useChatStore.getState().stopGeneration();
    });

    traceHandler?.({
      sessionId,
      provider: 'codex-sdk',
      type: 'trace',
      event: {
        transport: 'codex-sdk',
        sequence: 1,
        receivedAt: '2026-06-02T00:00:00.000Z',
        providerEventType: 'item.completed',
        providerItemType: 'command_execution',
        providerItemId: 'cmd-slow',
        raw: {},
        display: {
          kind: 'command',
          title: 'Ran command',
          status: 'completed',
          text: 'late-event-marker',
        },
        versions: { sdkVersion: null, cliVersion: null },
      },
    });

    expect(useChatStore.getState().streamingBlocks).toHaveLength(1);
    expect(JSON.stringify(useChatStore.getState().streamingBlocks)).not.toContain(
      'late-event-marker'
    );
    expect(JSON.stringify(useChatStore.getState().messages)).not.toContain('late-event-marker');

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

    const stateMessages = useChatStore.getState().messages;
    expect(useChatStore.getState().streamingBlocks).toEqual([]);
    expect(stateMessages.map((message) => message.role)).toEqual(['user', 'activity', 'assistant']);
    const activityMessage = stateMessages.find((message) => message.role === 'activity');
    expect(decodeAgentActivityMessage(activityMessage?.content ?? '')).toMatchObject({
      providerItemId: 'cmd-slow',
      display: expect.objectContaining({
        title: 'Running command',
        text: 'sleep 20',
      }),
    });
    expect(JSON.stringify(stateMessages)).not.toContain('late-event-marker');
  });
});
