import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurnSummary } from '../features/ai/orchestration/chat-store-types';
import type { ChatMessage } from '../features/ai/orchestration/chat-types';

const chatStore = vi.hoisted(() => {
  type Listener = (state: {
    _convStates: Map<string, { turns: Record<string, ChatTurnSummary>; messages: ChatMessage[] }>;
  }) => void;
  let state = {
    _convStates: new Map<
      string,
      { turns: Record<string, ChatTurnSummary>; messages: ChatMessage[] }
    >(),
  };
  const listeners = new Set<Listener>();
  return {
    store: {
      getState: () => state,
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(turns: ChatTurnSummary[], messages: ChatMessage[] = []) {
      state = {
        _convStates: new Map([
          [
            'conversation-1',
            { turns: Object.fromEntries(turns.map((turn) => [turn.id, turn])), messages },
          ],
        ]),
      };
      for (const listener of listeners) listener(state);
    },
    reset() {
      state = { _convStates: new Map() };
      listeners.clear();
    },
  };
});

const telemetry = vi.hoisted(() => ({ beginWorkflowAction: vi.fn() }));

vi.mock('../features/ai/hooks/useChat', () => ({ useChatStore: chatStore.store }));
vi.mock('./workflow-telemetry', () => ({ beginWorkflowAction: telemetry.beginWorkflowAction }));
const toolCalls = vi.hoisted(() => ({ install: vi.fn(), uninstall: vi.fn() }));
toolCalls.install.mockImplementation(() => toolCalls.uninstall);
vi.mock('../features/ai/orchestration/agent-tool-call-telemetry', () => ({
  installAgentToolCallTelemetry: toolCalls.install,
}));
const genomeViews = vi.hoisted(() => ({ install: vi.fn(), uninstall: vi.fn() }));
genomeViews.install.mockImplementation(() => genomeViews.uninstall);
vi.mock('../features/sequence/genome-view-telemetry', () => ({
  installGenomeViewTelemetry: genomeViews.install,
}));
const backgroundJobs = vi.hoisted(() => ({ install: vi.fn(), uninstall: vi.fn() }));
backgroundJobs.install.mockImplementation(() => backgroundJobs.uninstall);
vi.mock('./background-job-telemetry', () => ({
  installBackgroundJobTelemetry: backgroundJobs.install,
}));

import { installWorkflowTelemetryObservers } from './workflow-telemetry-observers';

describe('workflow telemetry observers', () => {
  beforeEach(() => {
    chatStore.reset();
    telemetry.beginWorkflowAction.mockReset();
  });

  it('starts and stops tool-call and genome-view telemetry with the turn observers', () => {
    for (const mock of [toolCalls, genomeViews, backgroundJobs]) {
      mock.install.mockClear();
      mock.uninstall.mockClear();
    }
    const uninstall = installWorkflowTelemetryObservers();
    expect(toolCalls.install).toHaveBeenCalledOnce();
    expect(genomeViews.install).toHaveBeenCalledOnce();
    expect(backgroundJobs.install).toHaveBeenCalledOnce();
    uninstall();
    expect(toolCalls.uninstall).toHaveBeenCalledOnce();
    expect(genomeViews.uninstall).toHaveBeenCalledOnce();
    expect(backgroundJobs.uninstall).toHaveBeenCalledOnce();
  });

  it('completes a Hosted operation only after the authoritative terminal state', () => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'hosted', status: 'running' })]);
    expect(telemetry.beginWorkflowAction).toHaveBeenCalledWith({
      workflow: 'hosted_ai',
      action: 'complete',
      actionId: 'turn-1',
    });
    expect(operation.complete).not.toHaveBeenCalled();

    chatStore.publish(
      [turn({ routeKind: 'hosted', status: 'completed' })],
      [assistantMessage('Persisted answer')]
    );
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledWith({
      status: 'completed',
      valueDelivered: true,
    });
    expect(operation.fail).not.toHaveBeenCalled();
    expect(operation.cancel).not.toHaveBeenCalled();
    uninstall();
  });

  it.each([
    ['failed', 'fail'],
    ['cancelled', 'cancel'],
    ['stopped', 'cancel'],
  ] as const)('does not complete a Hosted turn that becomes %s', (status, terminalMethod) => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'hosted', status: 'running' })]);
    chatStore.publish([turn({ routeKind: 'hosted', status })]);

    expect(operation.complete).not.toHaveBeenCalled();
    expect(operation[terminalMethod]).toHaveBeenCalledOnce();
    uninstall();
  });

  it('uses the bounded Hosted terminal reason instead of the visible diagnostic', () => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'hosted', status: 'running' })]);
    chatStore.publish([
      turn({
        routeKind: 'hosted',
        status: 'failed',
        terminalReason: 'hosted:allowance_or_policy_rejected',
        error: 'PRIVATE visible diagnostic with a support reference',
      }),
    ]);

    expect(operation.fail).toHaveBeenCalledWith('hosted:allowance_or_policy_rejected', {
      status: 'failed',
    });
    uninstall();
  });

  it('emits the final child class after an earlier Hosted response attempt recovered', () => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'hosted', status: 'running' })]);
    chatStore.publish([
      turn({
        routeKind: 'hosted',
        status: 'failed',
        terminalReason: 'hosted:thread_rollback_failed',
        error: 'DNAForge could not confirm the final turn state.',
      }),
    ]);

    expect(operation.fail).toHaveBeenCalledWith('hosted:thread_rollback_failed', {
      status: 'failed',
    });
    uninstall();
  });

  it.each([
    ['PRIVATE sk-proj-terminal-secret', 'ordinary visible diagnostic'],
    [null, 'PRIVATE sk-proj-error-secret'],
  ] as const)(
    'fails closed when a Hosted failure has terminal reason %s',
    (terminalReason, error) => {
      const operation = workflowOperation();
      telemetry.beginWorkflowAction.mockReturnValue(operation);
      const uninstall = installWorkflowTelemetryObservers();

      chatStore.publish([turn({ routeKind: 'hosted', status: 'running' })]);
      chatStore.publish([
        turn({
          routeKind: 'hosted',
          status: 'failed',
          terminalReason,
          error,
        }),
      ]);

      expect(operation.fail).toHaveBeenCalledWith('hosted:turn_failed', {
        status: 'failed',
      });
      expect(JSON.stringify(operation.fail.mock.calls)).not.toContain('sk-proj');
      uninstall();
    }
  );

  it.each(['provider_capacity', 'unknown'])(
    'uses the persisted native reason %s once',
    (reason) => {
      const operation = workflowOperation();
      telemetry.beginWorkflowAction.mockReturnValue(operation);
      const uninstall = installWorkflowTelemetryObservers();
      const route = { routeKind: 'cli', transport: 'codex-sdk' } as const;
      chatStore.publish([turn({ ...route, status: 'running' })]);
      const failed = turn({
        ...route,
        status: 'failed',
        terminalReason: `native:provider_stream:${reason}`,
        error: 'misleading display text: network',
      });
      chatStore.publish([failed]);
      chatStore.publish([failed]);
      expect(operation.fail).toHaveBeenCalledTimes(1);
      expect(operation.fail).toHaveBeenCalledWith(`local:${reason}`, { status: 'failed' });
      uninstall();
    }
  );

  it.each([
    ['Could not read /Users/ada/secret-pUC19.gb', 'local:turn_failed'],
    ['spawn codex ENOENT', 'local:cli_unavailable'],
    ['Request timed out after 120s', 'local:timeout'],
    ['429 Too Many Requests', 'local:rate_limited'],
    ['Not logged in. Run claude login', 'local:auth_failed'],
    ['Process exited with code 1', 'local:process_exit'],
    ['getaddrinfo ENOTFOUND api.example.com', 'local:network'],
    ['prompt is too long: 250000 tokens', 'local:context_exceeded'],
    ['codex-sdk returned no response', 'local:no_response'],
    ['the model refused the sequence ATGCATGC', 'local:turn_failed'],
  ] as const)('maps the local CLI failure %j to a fixed class', (error, expected) => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'cli', status: 'running', transport: 'codex-sdk' })]);
    chatStore.publish([
      turn({
        routeKind: 'cli',
        status: 'failed',
        transport: 'codex-sdk',
        terminalReason: error,
        error,
      }),
    ]);

    expect(operation.fail).toHaveBeenCalledWith(expected, { status: 'failed' });
    const sent = JSON.stringify(operation.fail.mock.calls);
    expect(sent).not.toContain('ada');
    expect(sent).not.toContain('ATGC');
    uninstall();
  });

  it.each([
    ['codex-sdk', 'local_codex'],
    ['claude-agent-sdk', 'local_claude'],
    ['grok-acp', 'local_grok'],
  ] as const)('classifies the %s CLI route separately', (transport, workflow) => {
    telemetry.beginWorkflowAction.mockReturnValue(workflowOperation());
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'cli', status: 'running', transport })]);

    expect(telemetry.beginWorkflowAction).toHaveBeenCalledWith({
      workflow,
      action: 'complete',
      actionId: 'turn-1',
    });
    uninstall();
  });

  it('marks an acknowledged stopped turn as value-delivering only with persisted assistant text', () => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'cli', status: 'running', transport: 'codex-sdk' })]);
    chatStore.publish(
      [turn({ routeKind: 'cli', status: 'stopped', transport: 'codex-sdk' })],
      [assistantMessage('Partial but useful')]
    );

    expect(operation.cancel).toHaveBeenCalledWith({
      status: 'stopped',
      valueDelivered: true,
    });
    uninstall();
  });

  it('does not qualify a persisted Pause status marker as assistant value', () => {
    const operation = workflowOperation();
    telemetry.beginWorkflowAction.mockReturnValue(operation);
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'cli', status: 'running', transport: 'codex-sdk' })]);
    chatStore.publish(
      [turn({ routeKind: 'cli', status: 'stopped', transport: 'codex-sdk' })],
      [assistantMessage('*[Paused]*')]
    );

    expect(operation.cancel).toHaveBeenCalledWith({ status: 'stopped', valueDelivered: false });
    uninstall();
  });

  it('keeps direct-provider routes on the non-qualifying Ask AI diagnostic pair', () => {
    telemetry.beginWorkflowAction.mockReturnValue(workflowOperation());
    const uninstall = installWorkflowTelemetryObservers();

    chatStore.publish([turn({ routeKind: 'provider', status: 'running' })]);

    expect(telemetry.beginWorkflowAction).toHaveBeenCalledWith({
      workflow: 'ask_ai',
      action: 'send',
      actionId: 'turn-1',
    });
    uninstall();
  });
});

function workflowOperation() {
  return {
    actionId: 'turn-1',
    consumed: false,
    complete: vi.fn(() => true),
    fail: vi.fn(() => true),
    cancel: vi.fn(() => true),
  };
}

function turn(
  overrides: Pick<ChatTurnSummary, 'routeKind' | 'status'> & {
    transport?: ChatTurnSummary['transport'];
    terminalReason?: string | null;
    error?: string | null;
  }
): ChatTurnSummary {
  return {
    id: 'turn-1',
    conversationId: 'conversation-1',
    routeKind: overrides.routeKind,
    hostId: 'local',
    provider: overrides.routeKind === 'hosted' ? 'dnaforge-hosted' : null,
    model: null,
    transport: overrides.transport ?? null,
    authorityProfileId: null,
    permissionMode: null,
    routeSnapshotJson: '{}',
    status: overrides.status,
    terminalReason:
      'terminalReason' in overrides
        ? (overrides.terminalReason ?? null)
        : overrides.status === 'completed'
          ? 'completed'
          : null,
    error: overrides.error ?? (overrides.status === 'failed' ? 'provider_error' : null),
    startedAt: 1,
    completedAt: overrides.status === 'running' ? null : 2,
  };
}

function assistantMessage(content: string): ChatMessage {
  return {
    id: 'assistant-1',
    turnId: 'turn-1',
    role: 'assistant',
    content,
    createdAt: 2,
  };
}
