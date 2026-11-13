import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type {
  InlineReferencePart,
  InlineTextDocument,
} from '../features/ai/references/inline/types';
import type { AgentSdkDetectionShape } from '../shared/agent-runtime-ipc';

const {
  mockChatState,
  mockAISettingsState,
  mockSetAssistantRoute,
  mockSetModel,
  mockSetCliModel,
  mockSetCliReasoningEffort,
  mockRefreshAgentDetection,
  mockAgentSdkAuthenticate,
  mockAgentSdkOnAuthEvent,
  mockAgentCapabilitiesDiscover,
  mockAgentCapabilitiesResolve,
  mockAgentCapabilitiesForkConversation,
  mockDispatchCommand,
  mockResolveInlineReferenceTarget,
  mockOpenSequenceFile,
  mockOpenStructureFile,
  mockSetEntityReferenceWorkspaceRootPathIfMissing,
} = vi.hoisted(() => ({
  mockSetAssistantRoute: vi.fn().mockResolvedValue(undefined),
  mockSetModel: vi.fn().mockResolvedValue(undefined),
  mockSetCliModel: vi.fn().mockResolvedValue(undefined),
  mockSetCliReasoningEffort: vi.fn().mockResolvedValue(undefined),
  mockRefreshAgentDetection: vi.fn().mockResolvedValue(null),
  mockAgentSdkAuthenticate: vi.fn().mockResolvedValue({
    authId: 'auth-test',
    transport: 'codex-sdk',
    ok: true,
    status: 'completed',
    command: ['codex', 'login'],
    output: 'ok',
    durationMs: 1,
  }),
  mockAgentSdkOnAuthEvent: vi.fn(() => vi.fn()),
  mockAgentCapabilitiesDiscover: vi.fn(),
  mockAgentCapabilitiesResolve: vi.fn(),
  mockAgentCapabilitiesForkConversation: vi.fn(),
  mockDispatchCommand: vi.fn(),
  mockResolveInlineReferenceTarget: vi.fn(),
  mockOpenSequenceFile: vi.fn(),
  mockOpenStructureFile: vi.fn(),
  mockSetEntityReferenceWorkspaceRootPathIfMissing: vi.fn(),
  mockChatState: {
    messages: [] as Array<{
      id: string;
      turnId?: string | null;
      role: 'user' | 'assistant' | 'tool' | 'activity';
      content: string;
      createdAt: number;
      toolName?: string | null;
      toolCallId?: string | null;
    }>,
    turns: {} as Record<
      string,
      {
        id: string;
        conversationId: string;
        routeKind: string;
        hostId: string;
        provider: string | null;
        model: string | null;
        transport: string | null;
        authorityProfileId: string | null;
        permissionMode: string | null;
        routeSnapshotJson: string;
        status: 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled' | 'interrupted';
        terminalReason: string | null;
        error: string | null;
        startedAt: number;
        completedAt: number | null;
      }
    >,
    activeTurnId: null as string | null,
    conversations: [],
    conversationHistoryRead: {
      status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
      hasLoaded: true,
    },
    currentConversationId: null,
    isLoading: false,
    isStreaming: false,
    error: null,
    queuedMessages: [] as Array<{
      id: string;
      content: string;
      workspacePath: string | null;
      referenceIds: string[];
      createdAt: number;
    }>,
    pendingMessage: null,
    pendingDraft: null as {
      conversationId?: string | null;
      text?: string;
      references: Array<{ id: string }>;
    } | null,
    composerDrafts: new Map(),
    streamingBlocks: [],

    _convStates: new Map<string, unknown>(),
    sendMessage: vi.fn(),
    advanceQueueThrough: vi.fn(),
    newConversation: vi.fn(),
    switchConversation: vi.fn(),
    hydrateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    togglePin: vi.fn(),
    renameConversation: vi.fn(),
    stopGeneration: vi.fn(),
    loadConversations: vi.fn().mockResolvedValue(undefined),
    setPendingMessage: vi.fn(),
    setPendingDraft: vi.fn(),
    setComposerDraft: vi.fn(),
    setError: vi.fn(),
  },
  mockAISettingsState: {
    assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
    isConfigured: true,
    provider: 'openai',
    model: 'gpt-4o',
    agentTransport: null,
    agentDetection: {
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: 'gpt-5.5',
        authMode: 'chatgpt',
        authFilePresent: true,
        models: [
          {
            id: 'gpt-5.5',
            displayName: 'GPT-5.5',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            defaultReasoningEffort: 'high',
            isDefault: true,
          },
          {
            id: 'gpt-5-codex',
            displayName: 'GPT-5 Codex',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'high',
          },
          {
            id: 'gpt-5',
            displayName: 'GPT-5',
            reasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
          },
        ],
        modelCatalog: {
          status: 'complete',
          source: 'codex-app-server',
          executablePath: '/usr/local/bin/codex',
          observedModelCount: 3,
          error: null,
        },
      },
      claudeCode: {
        cli: 'installed',
        path: '/usr/local/bin/claude',
        auth: 'authenticated',
        defaultModel: 'claude-fable-5[1m]',
        keychainEntryPresent: true,
        credentialsFilePresent: null,
        models: [
          {
            id: 'claude-fable-5[1m]',
            displayName: 'Claude Fable 5.1',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultReasoningEffort: 'high',
            isDefault: true,
          },
        ],
        modelCatalog: {
          status: 'complete',
          source: 'claude-sdk-initialization',
          executablePath: '/usr/local/bin/claude',
          observedModelCount: 1,
          error: null,
        },
      },
      grok: {
        cli: 'installed',
        path: '/usr/local/bin/grok',
        auth: 'authenticated',
        defaultModel: 'grok-code-fast-1',
        availableModels: ['grok-code-fast-1'],
        models: [
          {
            id: 'grok-code-fast-1',
            displayName: 'Grok Code Fast 1',
            reasoningEfforts: [],
            isDefault: true,
          },
        ],
        modelCatalog: {
          status: 'complete',
          source: 'grok-acp-initialization',
          executablePath: '/usr/local/bin/grok',
          observedModelCount: 1,
          error: null,
        },
      },
    } as AgentSdkDetectionShape,
    providerStatuses: {
      anthropic: { isConfigured: true },
      openai: { isConfigured: true },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    providerModels: {
      anthropic: { models: ['claude-sonnet-4-6'] },
      openai: { models: ['gpt-4o'] },
      google: { models: [] },
      xai: { models: [] },
      deepseek: { models: [] },
    },
    cliModelSettings: {
      'codex-sdk': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
      'claude-agent-sdk': {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        personality: null,
      },
      'grok-acp': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
    },
    setAssistantRoute: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setCliModel: vi.fn().mockResolvedValue(undefined),
    setCliReasoningEffort: vi.fn().mockResolvedValue(undefined),
    setCliServiceTier: vi.fn().mockResolvedValue(undefined),
    setCliPersonality: vi.fn().mockResolvedValue(undefined),
    refreshProviderStatuses: vi.fn().mockResolvedValue(undefined),
    refreshAgentDetection: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    agentPermissions: {},
    permissionCatalog: {
      defaults: { claude: 'default', grok: 'default', codex: ':read-only' },
      options: {
        claude: [{ value: 'default', label: 'default' }],
        grok: [{ value: 'default', label: 'default' }],
        codex: [{ value: ':read-only', label: 'Read Only' }],
      },
    },
    loadPermissionCatalog: vi.fn().mockResolvedValue(undefined),
    setAgentPermissions: vi.fn().mockResolvedValue(undefined),
  },
}));

mockAISettingsState.refreshAgentDetection = mockRefreshAgentDetection;

const fullChatViewHarness = {
  mockChatState,
  mockAISettingsState,
  mockSetAssistantRoute,
  mockSetModel,
  mockSetCliModel,
  mockSetCliReasoningEffort,
  mockRefreshAgentDetection,
  mockAgentSdkAuthenticate,
  mockAgentSdkOnAuthEvent,
  mockAgentCapabilitiesDiscover,
  mockAgentCapabilitiesResolve,
  mockAgentCapabilitiesForkConversation,
  mockDispatchCommand,
  mockResolveInlineReferenceTarget,
  mockOpenSequenceFile,
  mockOpenStructureFile,
  mockSetEntityReferenceWorkspaceRootPathIfMissing,
};

export function getFullChatViewHarness(): typeof fullChatViewHarness {
  return fullChatViewHarness;
}

vi.mock('../features/ai/hooks/useChat', () => {
  type UseChatStoreMock = {
    (selector?: (state: typeof mockChatState) => unknown): unknown;
    getState: () => typeof mockChatState;
  };
  const useChatStore = vi.fn((selector?: (state: typeof mockChatState) => unknown) =>
    selector ? selector(mockChatState) : mockChatState
  ) as unknown as UseChatStoreMock;
  useChatStore.getState = () => mockChatState;
  return {
    useChatStore,
    EMPTY_CONV_STATE: {
      messages: [],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
      queuedMessages: [],
    },
  };
});

vi.mock('../features/ai/settings', () => ({
  DEFAULT_CLI_REASONING_EFFORTS: {
    'codex-sdk': 'high',
    'claude-agent-sdk': 'high',
    'grok-acp': 'high',
  },
  useAISettingsStore: vi.fn(() => mockAISettingsState),
}));

vi.mock('../platform', () => ({
  platform: vi.fn(() => ({
    dialog: { open: vi.fn() },
    fs: {
      stat: vi.fn(),
      readTextFile: vi.fn(),
      resolveInlineReferenceTarget: mockResolveInlineReferenceTarget,
    },
    agentSdk: {
      authenticate: mockAgentSdkAuthenticate,
      onAuthEvent: mockAgentSdkOnAuthEvent,
    },
    agentCapabilities: {
      discover: mockAgentCapabilitiesDiscover,
      resolve: mockAgentCapabilitiesResolve,
      forkConversation: mockAgentCapabilitiesForkConversation,
    },
  })),
}));

vi.mock('../db/entity-references', () => ({
  createEntityReference: vi.fn(),
  getEntityReferencesByIds: vi.fn().mockResolvedValue([]),
  setEntityReferenceWorkspaceRootPathIfMissing: mockSetEntityReferenceWorkspaceRootPathIfMissing,
}));

vi.mock('../features/document-opening/compat', () => ({
  openSequenceFile: mockOpenSequenceFile,
  openStructureFile: mockOpenStructureFile,
}));

vi.mock('../db', () => ({
  getMessageReferences: vi.fn().mockResolvedValue([]),
  getMessageReferencesForMessages: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../features/ai/references/navigate', () => ({
  navigateToReference: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../commands', () => ({
  COMMAND_IDS: { workspaceRevealPath: 'workspace.revealPath' },
  useCommandRegistry: () => ({ dispatchCommand: mockDispatchCommand }),
}));

vi.mock('./chat', async () => ({
  ChatPermissionPickers: (await import('./chat/ChatPermissionPickers')).ChatPermissionPickers,
  CopyButton: (await import('./chat/CopyButton')).CopyButton,
  CopyThreadButton: (await import('./chat/CopyThreadButton')).CopyThreadButton,
  sanitizeAssistantArtifactMetadata: (
    await import('../features/ai/orchestration/assistant-artifact-prose')
  ).sanitizeAssistantArtifactMetadata,
  ThinkingLabel: () => <span>Thinking</span>,
  StreamingCursor: () => <span data-testid="streaming-cursor" />,
  FilePill: ({ file }: { file: { name: string } }) => <span>{file.name}</span>,
  FormattedMessage: ({
    content,
    references,
    referenceIds,
    referenceResolution,
    referenceQueryState,
    document,
    renderInlineReference,
  }: {
    content: string;
    references?: Map<string, { id: string; display_label: string }>;
    referenceIds?: string[];
    referenceResolution?: Map<string, 'loading' | 'resolved' | 'absent' | 'unavailable'>;
    referenceQueryState?: 'resolved' | 'unavailable';
    document?: InlineTextDocument;
    renderInlineReference?: (part: InlineReferencePart) => ReactNode;
  }) => (
    <span>
      {document?.renderSource ?? content}
      {document?.parts.map((part) => (
        <span key={part.key}>{renderInlineReference?.(part)}</span>
      ))}
      {(referenceIds ?? [])
        .filter(
          (id) =>
            !document?.parts.some(
              (part) =>
                part.state.status === 'resolved' &&
                'referenceId' in part.state &&
                part.state.referenceId === id
            )
        )
        .map((id) => {
          const resolved = references?.get(id);
          if (resolved) {
            return (
              <span key={id} data-testid={`ref-chip-${id}`}>
                {resolved.display_label}
              </span>
            );
          }
          return referenceResolution?.get(id) === 'unavailable' ? (
            <span key={id} data-testid={`ref-chip-unavailable-${id}`}>
              Reference unavailable
            </span>
          ) : referenceResolution?.get(id) === 'absent' ? null : (
            <span key={id} data-testid={`ref-chip-loading-${id}`}>
              Loading reference
            </span>
          );
        })}
      {referenceQueryState === 'unavailable' ? (
        <span data-testid="message-references-unavailable">Reference unavailable</span>
      ) : null}
    </span>
  ),
  formatTimeAgo: () => 'now',
  ToolResultDisplay: ({ toolName }: { toolName: string }) => <div>{toolName}</div>,
}));

vi.mock('./chat/ReferenceChip', () => ({
  ReferenceChip: ({
    reference,
    onClick,
  }: {
    reference: { id: string; display_label: string };
    onClick?: (reference: unknown) => void;
  }) => (
    <button data-testid={`mock-reference-${reference.id}`} onClick={() => onClick?.(reference)}>
      {reference.display_label}
    </button>
  ),
}));

export const {
  beginResolvedReferenceRootActivation,
  completeResolvedReferenceRootActivation,
  FullChatView,
  getFullChatViewReferenceRootCacheDiagnostics,
  holdNextFullChatViewReferenceTargetResolutionForTest,
  rememberResolvedReferenceRoot,
  registerResolvedReferenceRootCacheOwner,
  releaseResolvedReferenceRootCacheOwner,
  resetFullChatViewReferenceRootCacheDiagnosticsForTest,
} = await import('./FullChatView');
export const { encodeAgentActivityMessage } = await import('../features/ai/agent-activity-message');
export const { navigateToReference } = await import('../features/ai/references/navigate');
export const { useToastStore } = await import('../stores/toast-store');
export const { useCanvasStore } = await import('../features/canvas/store');
export const { createEntityReference, getEntityReferencesByIds } =
  await import('../db/entity-references');
export const { getMessageReferences, getMessageReferencesForMessages } = await import('../db');
export const { platform } = await import('../platform');
export const { useWorkspaceStore } = await import('../stores/workspaceStore');
export const { useDestructiveConfirmStore } =
  await import('../features/ai/agent-confirm/destructive-confirm-store');

export function resetFullChatViewHarness(): void {
  resetFullChatViewReferenceRootCacheDiagnosticsForTest();
  localStorage.removeItem('waypoint:ai-history-pinned');
  Element.prototype.scrollIntoView = vi.fn();
  mockSetAssistantRoute.mockClear();
  mockChatState.messages = [];
  mockChatState.turns = {};
  mockChatState.activeTurnId = null;
  mockChatState.conversations = [];
  mockChatState.conversationHistoryRead = { status: 'ready', hasLoaded: true };
  mockChatState.currentConversationId = null;
  mockChatState.isLoading = false;
  mockChatState.isStreaming = false;
  mockChatState.error = null;
  mockChatState.queuedMessages = [];
  mockChatState.pendingMessage = null;
  mockChatState.pendingDraft = null;
  mockChatState.composerDrafts = new Map();
  mockChatState.streamingBlocks = [];
  mockChatState._convStates.clear();
  mockChatState.sendMessage.mockClear();
  mockChatState.sendMessage.mockResolvedValue('accepted');
  mockChatState.advanceQueueThrough.mockClear();
  mockChatState.newConversation.mockClear();
  mockChatState.switchConversation.mockClear();
  mockChatState.hydrateConversation.mockClear();
  mockChatState.deleteConversation.mockClear();
  mockChatState.togglePin.mockClear();
  mockChatState.renameConversation.mockClear();
  mockChatState.stopGeneration.mockClear();
  mockChatState.setPendingMessage.mockClear();
  mockChatState.setPendingDraft.mockClear();
  mockChatState.setComposerDraft.mockClear();
  mockChatState.setError.mockClear();
  mockChatState.loadConversations.mockReset().mockResolvedValue(undefined);
  useDestructiveConfirmStore.getState().clear();
  mockAISettingsState.setAssistantRoute = mockSetAssistantRoute;
  mockAISettingsState.setModel = mockSetModel;
  mockAISettingsState.setCliModel = mockSetCliModel;
  mockAISettingsState.setCliReasoningEffort = mockSetCliReasoningEffort;
  mockSetModel.mockClear();
  mockSetCliModel.mockClear();
  mockSetCliReasoningEffort.mockReset().mockResolvedValue(undefined);
  mockAgentSdkAuthenticate.mockClear();
  mockAgentSdkOnAuthEvent.mockClear();
  mockAgentCapabilitiesDiscover.mockReset();
  mockAgentCapabilitiesResolve.mockReset();
  mockAgentCapabilitiesForkConversation.mockReset();
  mockDispatchCommand.mockClear();
  mockResolveInlineReferenceTarget.mockReset();
  mockResolveInlineReferenceTarget.mockResolvedValue({
    ok: true,
    targetType: 'directory',
  });
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
  mockOpenSequenceFile.mockReset().mockImplementation(async ({ label }: { label: string }) => {
    const documentId = 'full-chat-test-sequence';
    return useCanvasStore
      .getState()
      .openWithSmartPlacement('sequence', documentId, label, undefined, {
        sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
      });
  });
  mockOpenStructureFile
    .mockReset()
    .mockImplementation(async ({ label }: { label: string }) =>
      useCanvasStore
        .getState()
        .openWithSmartPlacement('structure', 'full-chat-test-structure', label)
    );
  mockSetEntityReferenceWorkspaceRootPathIfMissing.mockReset().mockResolvedValue(null);
  vi.mocked(createEntityReference).mockReset();
  useWorkspaceStore.setState({ folders: [] });
  vi.mocked(platform).mockReturnValue({
    dialog: { open: vi.fn() },
    fs: {
      stat: vi.fn(),
      readTextFile: vi.fn(),
      resolveInlineReferenceTarget: mockResolveInlineReferenceTarget,
    },
    agentSdk: {
      authenticate: mockAgentSdkAuthenticate,
      onAuthEvent: mockAgentSdkOnAuthEvent,
    },
    agentCapabilities: {
      discover: mockAgentCapabilitiesDiscover,
      resolve: mockAgentCapabilitiesResolve,
      forkConversation: mockAgentCapabilitiesForkConversation,
    },
  } as unknown as ReturnType<typeof platform>);
  mockAgentSdkAuthenticate.mockResolvedValue({
    authId: 'auth-test',
    transport: 'codex-sdk',
    ok: true,
    status: 'completed',
    command: ['codex', 'login'],
    output: 'ok',
    durationMs: 1,
  });
  mockAISettingsState.provider = 'openai';
  mockAISettingsState.model = 'gpt-4o';
  mockAISettingsState.assistantRoute = {
    kind: 'provider',
    provider: 'openai',
    model: 'gpt-4o',
  };
  mockAISettingsState.agentTransport = null;
  mockAISettingsState.isConfigured = true;
  mockAISettingsState.agentDetection = {
    codex: {
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'authenticated',
      defaultModel: 'gpt-5.5',
      authMode: 'chatgpt',
      authFilePresent: true,
      models: [
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
        {
          id: 'gpt-5-codex',
          displayName: 'GPT-5 Codex',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
        },
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
        },
      ],
      modelCatalog: {
        status: 'complete',
        source: 'codex-app-server',
        executablePath: '/usr/local/bin/codex',
        observedModelCount: 3,
        error: null,
      },
    },
    claudeCode: {
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'authenticated',
      defaultModel: 'claude-fable-5[1m]',
      keychainEntryPresent: true,
      credentialsFilePresent: null,
      models: [
        {
          id: 'claude-fable-5[1m]',
          displayName: 'Claude Fable 5.1',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
      ],
      modelCatalog: {
        status: 'complete',
        source: 'claude-sdk-initialization',
        executablePath: '/usr/local/bin/claude',
        observedModelCount: 1,
        error: null,
      },
    },
    grok: {
      cli: 'installed',
      path: '/usr/local/bin/grok',
      auth: 'authenticated',
      defaultModel: 'grok-code-fast-1',
      availableModels: ['grok-code-fast-1'],
      models: [
        {
          id: 'grok-code-fast-1',
          displayName: 'Grok Code Fast 1',
          reasoningEfforts: [],
          isDefault: true,
        },
      ],
      modelCatalog: {
        status: 'complete',
        source: 'grok-acp-initialization',
        executablePath: '/usr/local/bin/grok',
        observedModelCount: 1,
        error: null,
      },
    },
  } as AgentSdkDetectionShape;
  mockAISettingsState.providerStatuses = {
    anthropic: { isConfigured: true },
    openai: { isConfigured: true },
    google: { isConfigured: false },
    xai: { isConfigured: false },
    deepseek: { isConfigured: false },
  };
  mockAISettingsState.providerModels = {
    anthropic: { models: ['claude-sonnet-4-6'] },
    openai: { models: ['gpt-4o'] },
    google: { models: [] },
    xai: { models: [] },
    deepseek: { models: [] },
  };
  mockAISettingsState.cliModelSettings = {
    'codex-sdk': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
    'claude-agent-sdk': {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      personality: null,
    },
    'grok-acp': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
  };
  mockAISettingsState.refreshProviderStatuses.mockClear();
  mockAISettingsState.setApiKey.mockClear();
  mockAISettingsState.refreshAgentDetection = mockRefreshAgentDetection;
  mockRefreshAgentDetection.mockClear();
  mockRefreshAgentDetection.mockResolvedValue(mockAISettingsState.agentDetection);
  vi.mocked(getMessageReferences).mockReset().mockResolvedValue([]);
  vi.mocked(getMessageReferencesForMessages).mockReset().mockResolvedValue(new Map());
  vi.mocked(getEntityReferencesByIds).mockReset().mockResolvedValue([]);
}
