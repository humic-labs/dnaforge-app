import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateConversation = vi.fn();
const mockCreateChatTurnWithUserMessage = vi.fn();
const mockGetConversation = vi.fn().mockResolvedValue(null);
vi.mock('../../../db', () => ({
  createConversation: (...args: unknown[]) => mockCreateConversation(...args),
  createChatTurnWithUserMessage: (...args: unknown[]) => mockCreateChatTurnWithUserMessage(...args),
  getChatTurns: vi.fn().mockResolvedValue([]),
  getConversation: (...args: unknown[]) => mockGetConversation(...args),
  getMessages: vi.fn().mockResolvedValue([]),
  updateConversation: vi.fn(),
  updateConversationRoute: vi.fn(),
}));

const mockPrepareHostedCodexContribution = vi.fn();
const mockCancelPreparedTurn = vi.fn().mockResolvedValue({ ok: true });
const mockExecuteHostedTurn = vi.fn();
vi.mock('../hosted-gateway', () => ({
  prepareHostedCodexContribution: (...args: unknown[]) =>
    mockPrepareHostedCodexContribution(...args),
  hostedCodexBridge: () => ({ cancelPreparedTurn: mockCancelPreparedTurn }),
  hostedAiBridge: () => null,
}));
vi.mock('./execute-hosted-turn', () => ({
  executeHostedTurn: (...args: unknown[]) => mockExecuteHostedTurn(...args),
  HostedStopTerminalError: class extends Error {},
}));

vi.mock('../settings', () => ({
  useAISettingsStore: {
    getState: () => ({
      assistantRoute: { kind: 'hosted', tier: 'auto' },
      agentTransport: null,
      provider: 'openai',
      model: 'gpt-4o',
      getApiKey: vi.fn().mockResolvedValue(null),
    }),
  },
}));

const mockAddFolder = vi.fn();
vi.mock('../../../platform', () => ({
  platform: () => ({
    workspace: {
      resolveRegisteredProject: async (reference: string) =>
        reference === '/workspace'
          ? { path: '/workspace', name: 'Registered workspace', addedAt: 1, pinned: false }
          : null,
      listRegisteredProjects: async () => [
        { path: '/workspace', name: 'Registered workspace', addedAt: 1, pinned: false },
      ],
    },
  }),
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [], addFolder: mockAddFolder }) },
}));
vi.mock('../../page/embeds/structure3d/store', () => ({
  useStructure3dStore: { getState: () => ({ clearAgentHighlightGroups: vi.fn() }) },
}));

import { runChatTurn } from './run-chat-turn';
import { setConversationState, type ChatStoreGet, type ChatStoreSet } from './chat-runtime';

function harness(currentConversationId: string | null = null) {
  const state: Record<string, unknown> = {
    currentConversationId,
    conversations: [],
    error: null,
    _convStates: new Map(),
  };
  const set = ((patch: unknown) => {
    Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  }) as unknown as ChatStoreSet;
  const get = (() => state) as unknown as ChatStoreGet;
  return { state, set, get };
}

describe('runChatTurn Hosted contribution choice', () => {
  beforeEach(() => {
    mockCreateConversation.mockReset();
    mockCreateChatTurnWithUserMessage.mockReset();
    mockExecuteHostedTurn.mockReset();
    mockPrepareHostedCodexContribution.mockReset();
    mockCancelPreparedTurn.mockClear();
    mockGetConversation.mockReset().mockResolvedValue(null);
    mockAddFolder.mockReset();
  });

  it('reports not_started with an actionable message and persists nothing when preparation supplies no binding', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({
      started: false,
      error: null,
    });
    const { state, set, get } = harness();

    const disposition = await runChatTurn(
      set,
      get,
      'Which primers flank this exon?',
      '/workspace',
      null,
      ['ref-1']
    );

    expect(disposition).toBe('not_started');
    expect(state.error).toContain('could not start');
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockCreateChatTurnWithUserMessage).not.toHaveBeenCalled();
    expect(mockExecuteHostedTurn).not.toHaveBeenCalled();
  });

  it('reports not_started when preparation does not start and leaves the send lease reusable', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({
      started: false,
      error: null,
    });
    const { set, get } = harness();

    expect(await runChatTurn(set, get, 'Explain this construct', null, 'conv-1')).toBe(
      'not_started'
    );
    expect(await runChatTurn(set, get, 'Explain this construct', null, 'conv-1')).toBe(
      'not_started'
    );
    expect(mockPrepareHostedCodexContribution).toHaveBeenCalledTimes(2);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it('surfaces the gateway error verbatim when admission itself fails', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({
      started: false,
      error: 'DNAForge AI could not load the current contribution policy.',
    });
    const { state, set, get } = harness();

    expect(await runChatTurn(set, get, 'Read this workspace', null, 'conv-1')).toBe('not_started');
    expect((state._convStates as Map<string, { error: string }>).get('conv-1')?.error).toBe(
      'DNAForge AI could not load the current contribution policy.'
    );
    expect(state.error).toBeNull();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it('keeps a Hosted admission error scoped to the active conversation across later updates', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({
      started: false,
      error: 'DNAForge AI could not load the current contribution policy.',
    });
    const { state, set, get } = harness('conv-1');

    expect(await runChatTurn(set, get, 'Read this workspace', null, 'conv-1')).toBe('not_started');
    expect((state._convStates as Map<string, { error: string }>).get('conv-1')?.error).toBe(
      'DNAForge AI could not load the current contribution policy.'
    );

    setConversationState(set, 'conv-1', () => ({ isLoading: false }));

    expect(state.error).toBe('DNAForge AI could not load the current contribution policy.');
  });

  it('does not copy a scoped Hosted admission error into a different active conversation', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({
      started: false,
      error: 'DNAForge AI could not load the current contribution policy.',
    });
    const { state, set, get } = harness('active-conversation');

    expect(await runChatTurn(set, get, 'Read this workspace', null, 'scoped-conversation')).toBe(
      'not_started'
    );
    expect(
      (state._convStates as Map<string, { error: string }>).get('scoped-conversation')?.error
    ).toBe('DNAForge AI could not load the current contribution policy.');
    expect(state.error).toBeNull();
  });

  it('returns a refused Home send to Home without leaking it into another conversation', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({
      started: false,
      error: null,
    });
    const { state, set, get } = harness('another-active-conversation');
    const onNotStarted = vi.fn();

    expect(
      await runChatTurn(set, get, 'Read this workspace', null, 'new-home-conversation', [], {
        onNotStarted,
      })
    ).toBe('not_started');
    expect(onNotStarted).toHaveBeenCalledWith(expect.stringContaining('could not start'));
    expect(state.error).toBeNull();
    expect((state._convStates as Map<string, { error: string }>).has('new-home-conversation')).toBe(
      false
    );
  });

  it('releases a prepared Hosted binding when renderer setup fails before the turn starts', async () => {
    mockPrepareHostedCodexContribution.mockResolvedValue({ started: true, error: null });
    mockCreateConversation.mockRejectedValueOnce(new Error('database unavailable'));
    const { set, get } = harness('conv-1');

    expect(await runChatTurn(set, get, 'Inspect this workspace', '/workspace', 'conv-1')).toBe(
      'not_started'
    );
    expect(mockCancelPreparedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'conv-1',
      })
    );
    const identity = mockCancelPreparedTurn.mock.calls[0]?.[0] as
      | { runId: string; turnId: string }
      | undefined;
    expect(identity?.runId).toBe(identity?.turnId);
  });
});
