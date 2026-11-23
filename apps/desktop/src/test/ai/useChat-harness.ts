import { vi } from 'vitest';

const {
  mockAgentSessionStart,
  mockAgentSessionCancel,
  mockAgentSessionOnEvent,
  mockAgentCapabilitiesResolve,
  mockConversationLedgerAppendEvent,
  mockScanWorkspaceFiles,
  mockReconcileCliWorkspaceChanges,
  mockResolveRegisteredProject,
  mockListRegisteredProjects,
} = vi.hoisted(() => ({
  mockAgentSessionStart: vi.fn(),
  mockAgentSessionCancel: vi.fn(),
  mockAgentSessionOnEvent: vi.fn(),
  mockAgentCapabilitiesResolve: vi.fn(),
  mockConversationLedgerAppendEvent: vi.fn().mockResolvedValue({ ok: true }),
  mockScanWorkspaceFiles: vi.fn(),
  mockReconcileCliWorkspaceChanges: vi.fn(),
  mockResolveRegisteredProject: vi.fn(),
  mockListRegisteredProjects: vi.fn(),
}));

const useChatConversationHarness = {
  mockAgentSessionStart,
  mockAgentSessionCancel,
  mockAgentSessionOnEvent,
  mockAgentCapabilitiesResolve,
  mockConversationLedgerAppendEvent,
  mockScanWorkspaceFiles,
  mockReconcileCliWorkspaceChanges,
  mockResolveRegisteredProject,
  mockListRegisteredProjects,
};

export function getUseChatConversationHarness(): typeof useChatConversationHarness {
  return useChatConversationHarness;
}

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => `stepCountIs(${n})`),
  hasToolCall: vi.fn((name: string) => `hasToolCall(${name})`),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock('../../features/ai/orchestration/conversation-title', () => ({
  generateCliConversationTitle: vi.fn().mockResolvedValue(null),
  generateHostedConversationTitle: vi.fn().mockResolvedValue(null),
  generateProviderConversationTitle: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../db', () => {
  const updateConversation = vi.fn().mockResolvedValue(undefined);
  const toggleConversationPinned = vi.fn().mockResolvedValue(true);
  return {
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
    getConversationHistory: vi.fn().mockResolvedValue([]),
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
    updateConversation,
    updateConversationWithResult: vi.fn(async (id: string, title: string) => {
      await updateConversation(id, title);
      return { status: 'updated' as const };
    }),
    updateConversationTitleIfUnchanged: vi.fn().mockResolvedValue(true),
    toggleConversationPinned,
    toggleConversationPinnedWithResult: vi.fn(async (id: string) => ({
      status: 'updated' as const,
      pinned: await toggleConversationPinned(id),
    })),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    getMessageReferences: vi.fn().mockResolvedValue([]),
    getMessageReferencesForMessages: vi.fn().mockResolvedValue(new Map()),
    setMessageReferences: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../db/entity-references', () => ({
  getEntityReference: vi.fn().mockResolvedValue(null),
  getEntityReferencesByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../features/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/ai/providers')>();
  return {
    ...actual,
    createModel: vi.fn().mockReturnValue({ modelId: 'mock-model' }),
  };
});

vi.mock('../../features/ai/permission-catalog', () => ({
  readPermissionCatalog: vi.fn().mockResolvedValue({
    defaults: { claude: 'default', grok: 'default', codex: ':read-only' },
    options: {
      claude: [{ value: 'default', label: 'default' }],
      grok: [{ value: 'default', label: 'default' }],
      codex: [
        { value: ':read-only', label: 'Read Only' },
        { value: ':workspace', label: 'Default' },
        { value: ':danger-full-access', label: 'Full Access' },
      ],
    },
  }),
}));

vi.mock('../../features/ai/settings', () => ({
  DEFAULT_CLI_REASONING_EFFORTS: {
    'codex-sdk': 'high',
    'claude-agent-sdk': 'high',
    'grok-acp': 'high',
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

vi.mock('../../platform', () => ({
  platform: vi.fn(() => ({
    workspace: {
      resolveRegisteredProject: mockResolveRegisteredProject,
      listRegisteredProjects: mockListRegisteredProjects,
    },
    path: { appDataDir: async () => '/app-data' },
    administration: {
      onChanged: vi.fn(() => () => {}),
      execute: vi.fn(async () => ({
        kind: 'settings',
        stateChanged: false,
        snapshot: {
          ownerId: 'chat-test',
          generation: 0,
          revision: 'chat-test:0',
          values: {
            theme: 'light',
            displayZoom: 1,
            assemblyColorScheme: 'tailwind',
            webglPerformance: 'auto',
            rememberedAgentPreferences: '',
          },
          adopted: [],
          persistence: 'saved',
          unsavedKeys: [],
        },
      })),
    },
    agentSession: {
      start: mockAgentSessionStart,
      cancel: mockAgentSessionCancel,
      onEvent: mockAgentSessionOnEvent,
    },
    agentCapabilities: {
      resolve: mockAgentCapabilitiesResolve,
    },
    conversationLedger: {
      appendEvent: mockConversationLedgerAppendEvent,
      unlinkConversation: vi.fn().mockResolvedValue({ ok: true }),
    },
  })),
}));

vi.mock('../../features/ai/cli-workspace-reconcile', () => ({
  scanWorkspaceFiles: mockScanWorkspaceFiles,
  reconcileCliWorkspaceChanges: mockReconcileCliWorkspaceChanges,
}));

export const { streamText } = await import('ai');
export const db = await import('../../db');
export const { getEntityReferencesByIds } = await import('../../db/entity-references');
export const { createModel } = await import('../../features/ai/providers');
export const { useAISettingsStore } = await import('../../features/ai/settings');
export const { decodeAgentActivityMessage } =
  await import('../../features/ai/agent-activity-message');
export const { useChatStore } = await import('../../features/ai/hooks/useChat');
export const { createEmptyConversationState } =
  await import('../../features/ai/orchestration/chat-store-types');
export const { markChatConversationDeleted, resetDeletedChatConversationsForTests } =
  await import('../../features/ai/orchestration/chat-runtime');
export const { useStructure3dStore } = await import('../../features/page/embeds/structure3d/store');
export const { useWorkspaceStore } = await import('../../stores/workspaceStore');

function decodePromptXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function promptDataFenceRecords(
  text: string,
  prefix: string
): Array<Record<string, unknown>> {
  const pattern = new RegExp(
    `<${prefix}-([A-Za-z0-9]+) trust="untrusted-data">([\\s\\S]*?)<\\/${prefix}-\\1>`,
    'g'
  );
  return Array.from(
    text.matchAll(pattern),
    (match) => JSON.parse(decodePromptXml(match[2])) as Record<string, unknown>
  );
}

export function cliConversationMessages(prompt: string): Array<{ role: string; content: string }> {
  const record = promptDataFenceRecords(prompt, 'wp-conversation')[0];
  if (!record) throw new Error('Expected a wp-conversation prompt fence');
  const current = prompt.match(
    /<wp-current-user-request-([A-Za-z0-9]+) role="user">([\s\S]*?)<\/wp-current-user-request-\1>/
  );
  const activeRequest = current ? JSON.parse(decodePromptXml(current[2])) : null;
  return [
    ...(record.messages as Array<{ role: string; content: string }>),
    ...(activeRequest ? [activeRequest] : []),
  ];
}

export function mockTextStream(text: string) {
  const chunks = text.split(' ').filter(Boolean);
  const fullStreamParts = chunks.map((chunk, index) => ({
    type: 'text-delta',
    id: 'text-1',
    text: index === chunks.length - 1 ? chunk : `${chunk} `,
  }));
  return {
    fullStream: {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          async next() {
            if (index < fullStreamParts.length) {
              return { value: fullStreamParts[index++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
    textStream: {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          async next() {
            if (index < chunks.length) {
              const value = index === chunks.length - 1 ? chunks[index] : `${chunks[index]} `;
              index++;
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

export function mockErrorStream(error: unknown) {
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

export function resetUseChatConversationHarness(): void {
  vi.clearAllMocks();
  resetDeletedChatConversationsForTests();
  let uuidSuffix = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `00000000-0000-0000-0000-${(uuidSuffix++).toString(16).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`
  );

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
    conversationHistoryRead: { status: 'idle', hasLoaded: false },
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
  const registeredProjects = [
    { path: '/workspace', name: 'Registered workspace', addedAt: 1, pinned: false },
  ];
  mockListRegisteredProjects.mockReset().mockResolvedValue(registeredProjects);
  mockResolveRegisteredProject
    .mockReset()
    .mockImplementation(
      async (reference: string) =>
        registeredProjects.find((project) => project.path === reference) ?? null
    );

  vi.mocked(db.getConversation).mockResolvedValue(null);
  vi.mocked(db.getConversations).mockResolvedValue([]);
  vi.mocked(db.getConversationHistory).mockResolvedValue([]);
  vi.mocked(db.getMessages).mockResolvedValue([]);
  vi.mocked(db.getMessageAttachmentsForMessages).mockResolvedValue(new Map());
  vi.mocked(db.getStructuredOutputsForConversation).mockResolvedValue(new Map());
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
  vi.mocked(db.updateConversationWithResult)
    .mockReset()
    .mockImplementation(async (id, title) => {
      await db.updateConversation(id, title);
      return { status: 'updated' };
    });
  vi.mocked(db.toggleConversationPinnedWithResult)
    .mockReset()
    .mockImplementation(async (id) => ({
      status: 'updated',
      pinned: await db.toggleConversationPinned(id),
    }));
  vi.mocked(db.addMessage).mockResolvedValue(undefined);
  vi.mocked(db.updateConversationTitleIfUnchanged).mockResolvedValue(true);
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
  } as never);
  mockAgentSessionStart.mockResolvedValue({
    transport: 'codex-sdk',
    ok: true,
    text: 'CLI response',
    durationMs: 25,
  });
  mockAgentSessionCancel.mockResolvedValue({ ok: true, cancelled: true });
  mockAgentSessionOnEvent.mockReturnValue(() => {});
  mockAgentCapabilitiesResolve.mockReset();
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
}
