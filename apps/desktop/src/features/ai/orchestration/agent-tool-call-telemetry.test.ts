import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurnSummary } from './chat-store-types';
import type { ChatMessage } from './chat-types';

const chatStore = vi.hoisted(() => {
  type Conversation = { turns: Record<string, ChatTurnSummary>; messages: ChatMessage[] };
  type Listener = (state: { _convStates: Map<string, Conversation> }) => void;
  let state = { _convStates: new Map<string, Conversation>() };
  const listeners = new Set<Listener>();
  return {
    store: {
      getState: () => state,
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(turns: ChatTurnSummary[], messages: ChatMessage[]) {
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

const telemetry = vi.hoisted(() => ({ observeWorkflowAction: vi.fn() }));

vi.mock('../hooks/useChat', () => ({ useChatStore: chatStore.store }));
vi.mock('../../../lib/workflow-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/workflow-telemetry')>()),
  observeWorkflowAction: telemetry.observeWorkflowAction,
}));

import { agentToolTelemetryName, installAgentToolCallTelemetry } from './agent-tool-call-telemetry';

const TURN_ID = '550e8400-e29b-41d4-a716-446655440010';

function turn(overrides: Partial<ChatTurnSummary> = {}): ChatTurnSummary {
  return {
    id: TURN_ID,
    conversationId: 'conversation-1',
    routeKind: 'hosted',
    hostId: 'local',
    provider: null,
    model: null,
    transport: null,
    authorityProfileId: null,
    permissionMode: null,
    routeSnapshotJson: '{}',
    status: 'running',
    terminalReason: null,
    error: null,
    startedAt: 1,
    completedAt: null,
    ...overrides,
  };
}

function toolMessage(id: string, toolName: string, isError: boolean): ChatMessage {
  return {
    id,
    turnId: TURN_ID,
    role: 'tool',
    toolName,
    toolCallId: `call-${id}`,
    content: JSON.stringify({
      input: { sequence: 'ATGCSECRET', path: '/Users/ada/private.gb' },
      output: { text: 'PRIVATE RESULT' },
      isError,
    }),
    createdAt: 2,
  };
}

describe('agent tool call telemetry', () => {
  beforeEach(() => {
    chatStore.reset();
    telemetry.observeWorkflowAction.mockReset();
  });

  it('records each new tool call once with a bounded name and no inputs or outputs', () => {
    chatStore.publish([turn()], [toolMessage('old', 'workspace_files', false)]);
    const uninstall = installAgentToolCallTelemetry();

    const messages = [
      toolMessage('old', 'workspace_files', false),
      toolMessage('m1', 'workspace_files', false),
      toolMessage('m2', 'mcp__private_server__exfiltrate_notes', true),
    ];
    chatStore.publish([turn()], messages);
    chatStore.publish([turn({ status: 'completed' })], messages);

    expect(telemetry.observeWorkflowAction).toHaveBeenCalledTimes(2);
    expect(telemetry.observeWorkflowAction).toHaveBeenNthCalledWith(1, {
      workflow: 'hosted_ai',
      action: 'tool_call',
      phase: 'result',
      status: 'completed',
      success: true,
      agentToolName: 'workspace_files',
      parentActionId: TURN_ID,
    });
    expect(telemetry.observeWorkflowAction).toHaveBeenNthCalledWith(2, {
      workflow: 'hosted_ai',
      action: 'tool_call',
      phase: 'result',
      status: 'failed',
      success: false,
      agentToolName: 'external_tool',
      errorClass: 'tool_failed',
      parentActionId: TURN_ID,
    });
    const sent = JSON.stringify(telemetry.observeWorkflowAction.mock.calls);
    expect(sent).not.toContain('SECRET');
    expect(sent).not.toContain('PRIVATE');
    expect(sent).not.toContain('exfiltrate');
    uninstall();
  });

  it('labels local CLI routes and their built-in tools', () => {
    const uninstall = installAgentToolCallTelemetry();
    chatStore.publish(
      [turn({ routeKind: 'cli', transport: 'codex-sdk' })],
      [toolMessage('m1', 'Bash', false)]
    );
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: 'local_codex', agentToolName: 'cli_bash' })
    );
    expect(agentToolTelemetryName(undefined)).toBe('unknown_tool');
    uninstall();
  });
});
