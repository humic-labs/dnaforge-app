import { setImmediate } from 'node:timers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_AGENT_PERMISSIONS } from '../../../shared/agent-permissions';
import { CodexTraceAdapter } from '../../../main/agent-sdk/trace-adapter';
import { decodeAgentActivityMessage } from '../agent-activity-message';
import { projectTraceItems } from '../trace-view-projection';
import type { ChatMessage } from './chat-types';

const { platform, bridge, listeners, disposeTrace, inlineReferences, setConversationState } =
  vi.hoisted(() => {
    const listeners = new Set<(event: unknown) => void>();
    const disposeTrace = vi.fn();
    const bridge = {
      path: { appDataDir: vi.fn(async () => '/app-data') },
      agentSession: {
        onEvent: vi.fn(),
        start: vi.fn(),
        cancel: vi.fn(async () => ({ ok: true, cancelled: true, state: 'stop_requested' })),
      },
    };
    const inlineReferences = {
      update: vi.fn((_id: string, source: string) => ({ source, renderSource: source, parts: [] })),
      finalize: vi.fn(async () => ({ blocks: new Map(), proposedRows: [], referencedRows: [] })),
      cancel: vi.fn(),
      registerCreatedReference: vi.fn(),
    };
    return {
      platform: vi.fn(() => bridge),
      bridge,
      listeners,
      disposeTrace,
      inlineReferences,
      setConversationState: vi.fn(),
    };
  });

vi.mock('../../../platform', () => ({ platform }));
vi.mock('../../../db/entity-references', () => ({ getEntityReferencesByIds: vi.fn() }));
vi.mock('../assistant-routes', () => ({ getCliAuthorityProfileId: vi.fn(() => 'profile-1') }));
vi.mock('../cli-workspace-reconcile', () => ({
  scanWorkspaceFiles: vi.fn(),
  reconcileCliWorkspaceChanges: vi.fn(),
}));
vi.mock('../prompts/cli-prompt', () => ({
  buildAgentSdkPrompt: vi.fn(() => 'prompt'),
  buildAgentSdkContinuationPrompt: vi.fn(() => 'continuation'),
}));
vi.mock('./chat-runtime', () => ({
  setConversationState,
  chatProviderPhase: vi.fn(),
  chatInterruptionReason: vi.fn(() => 'Stop requested.'),
}));
vi.mock('../references/inline/session', () => ({
  createInlineReferenceSession: vi.fn(() => inlineReferences),
}));

import { executeCliTurn } from './execute-cli-turn';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const nextEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function beginTurn(
  lastTraceSequence: number,
  transport: 'codex-sdk' | 'claude-agent-sdk' = 'codex-sdk'
) {
  const started = deferred<void>();
  const response = deferred<Record<string, unknown>>();
  const controller = new AbortController();
  let sessionId = '';
  bridge.agentSession.start.mockImplementation((request) => {
    sessionId = request.sessionId;
    started.resolve();
    return response.promise;
  });
  const queued: ChatMessage[] = [];
  const finishTurn = vi.fn(async () => undefined);
  const execution = executeCliTurn({
    set: vi.fn(),
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    transport,
    permissionMode: 'app-supervised',
    permissions: BUILT_IN_AGENT_PERMISSIONS,
    folders: [],
    expandedMessages: [],
    content: 'Find skills for pUC19 primer design.',
    stagedReferenceIds: [],
    allowedExistingReferenceIds: [],
    workspaceScope: null,
    isWorkspaceScopeCurrent: () => true,
    workspacePath: null,
    controller,
    queueTerminalMessage: vi.fn((message) => {
      queued.push(message);
    }),
    queueProposedEntityReference: vi.fn(),
    queueMaterializedEntityReference: vi.fn(),
    finishTurn,
  });
  const resolveResponse = () =>
    response.resolve({
      sessionId,
      provider: transport,
      authorityProfileId: 'profile-1',
      ok: true,
      text: 'I found two relevant skills for pUC19 primer design.',
      durationMs: 1,
      stopState: 'completed',
      lastTraceSequence,
      workspaceProvenance: {
        policy: 'not-required',
        grounded: false,
        completedWorkspaceTools: [],
        completedWorkspaceResources: [],
      },
    });
  return {
    started,
    resolveResponse,
    execution,
    queued,
    finishTurn,
    controller,
    sessionId: () => sessionId,
  };
}

describe('native CLI terminal trace fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    bridge.agentSession.onEvent.mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        disposeTrace();
      };
    });
  });

  it('retains delayed canonical completion before persisting and disposing the conversation activity', async () => {
    const run = beginTurn(2);
    await run.started.promise;
    run.resolveResponse();
    await nextEventLoop();
    expect(disposeTrace).not.toHaveBeenCalled();
    expect(inlineReferences.finalize).not.toHaveBeenCalled();
    expect(run.finishTurn).not.toHaveBeenCalled();
    expect(run.queued).toEqual([]);

    const adapter = new CodexTraceAdapter({ sdkVersion: null, cliVersion: null });
    const requested = adapter.adapt(
      {
        type: 'item.started',
        item: {
          id: 'search-1',
          type: 'mcp_tool_call',
          server: 'dnaforge',
          tool: 'search_skills',
          status: 'in_progress',
          arguments: { query: 'pUC19 primer design', provider: 'codex-sdk' },
        },
      },
      0
    );
    const completed = adapter.adapt(
      {
        type: 'item.completed',
        item: {
          id: 'search-1',
          type: 'mcp_tool_call',
          server: 'dnaforge',
          tool: 'search_skills',
          status: 'completed',
          result: { ok: true, count: 2, matches: [] },
        },
      },
      1
    );
    const terminal = adapter.adapt({ type: 'turn.completed' }, 2);
    const deliver = (event: typeof requested, sessionId = run.sessionId()) => {
      for (const listener of listeners)
        listener({ sessionId, provider: 'codex-sdk', type: 'trace', event });
    };
    deliver(terminal, 'other-conversation-session');
    deliver(terminal);
    await nextEventLoop();
    expect(run.finishTurn).not.toHaveBeenCalled();
    deliver(requested);
    await nextEventLoop();
    expect(run.finishTurn).not.toHaveBeenCalled();
    expect(disposeTrace).not.toHaveBeenCalled();
    deliver(completed);

    await expect(run.execution).resolves.toBe('completed');
    const savedEvents = run.queued
      .filter((message) => message.role === 'activity')
      .map((message) => decodeAgentActivityMessage(message.content));
    const projected = projectTraceItems(
      savedEvents,
      (event) => event,
      (_event, index) => String(index)
    );
    expect(projected).toHaveLength(1);
    expect(projected[0].event?.display.title).toBe('Search skills');
    expect(projected[0].event?.display.status).toBe('Completed');
    expect(projected[0].event?.toolCalls?.[0]).toMatchObject({
      name: 'search_skills',
      status: 'completed',
      input: { query: 'pUC19 primer design' },
      output: { count: 2 },
    });
    expect(run.finishTurn).toHaveBeenCalledWith('completed', 'completed');
    expect(disposeTrace).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it.each(['claude-agent-sdk', 'codex-sdk'] as const)(
    'honors Stop during %s setup before starting the provider',
    async (transport) => {
      const lookingUpPath = deferred<void>();
      const appDataPath = deferred<string>();
      bridge.path.appDataDir.mockImplementationOnce(() => {
        lookingUpPath.resolve();
        return appDataPath.promise;
      });
      const run = beginTurn(-1, transport);
      await lookingUpPath.promise;
      run.controller.abort();
      appDataPath.resolve('/app-data');
      run.resolveResponse();
      await expect(run.execution).resolves.toBe('stopped');
      expect(bridge.agentSession.start).not.toHaveBeenCalled();
      expect(run.finishTurn).toHaveBeenCalledTimes(1);
      expect(run.finishTurn).toHaveBeenCalledWith('stopped', 'Stop requested.');
      expect(disposeTrace).toHaveBeenCalledTimes(1);
    }
  );

  it('lets Stop release an outstanding sequence zero fence without claiming completion', async () => {
    const run = beginTurn(0);
    await run.started.promise;
    run.resolveResponse();
    await nextEventLoop();
    expect(disposeTrace).not.toHaveBeenCalled();
    expect(run.finishTurn).not.toHaveBeenCalled();
    run.controller.abort();
    await expect(run.execution).resolves.toBe('stopped');
    expect(bridge.agentSession.cancel).toHaveBeenCalledWith(run.sessionId());
    expect(run.finishTurn).toHaveBeenCalledWith('stopped', 'Stop requested.');
    expect(run.finishTurn).not.toHaveBeenCalledWith('completed', 'completed');
    expect(disposeTrace).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
