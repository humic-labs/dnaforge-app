import { installAgentToolCallTelemetry } from '../features/ai/orchestration/agent-tool-call-telemetry';
import { useChatStore } from '../features/ai/hooks/useChat';
import { installGenomeViewTelemetry } from '../features/sequence/genome-view-telemetry';
import { installBackgroundJobTelemetry } from './background-job-telemetry';
import type {
  ChatTurnSummary,
  ConversationState,
} from '../features/ai/orchestration/chat-store-types';
import {
  beginWorkflowAction,
  type ScientificWorkflow,
  type WorkflowOperation,
} from './workflow-telemetry';
import { parseNativeTerminalReason } from '../shared/native-turn-failure';
import { hasQualifyingAssistantContent } from '../shared/ai-turn-telemetry';
import type { HostedCodexTurnResult } from '../shared/hosted-codex-ipc';

type HostedFailureCode = Extract<HostedCodexTurnResult, { ok: false }>['code'];

const HOSTED_FAILURE_CODES = Object.freeze({
  not_prepared: true,
  not_configured: true,
  signed_out: true,
  invalid_request: true,
  request_too_large: true,
  gateway_paused: true,
  allowance_exhausted: true,
  rate_limited: true,
  provider_exposure_reconciliation_required: true,
  allowance_or_policy_rejected: true,
  gateway_unavailable: true,
  app_server_unavailable: true,
  tool_failed: true,
  provider_rate_limited: true,
  provider_authentication_failed: true,
  provider_request_rejected: true,
  provider_service_unavailable: true,
  provider_http_error: true,
  provider_stream_disconnected: true,
  provider_stream_failed: true,
  provider_continuity_missing: true,
  provider_continuity_mismatch: true,
  provider_start_budget_exhausted: true,
  provider_spend_budget_exhausted: true,
  workflow_lease_lost: true,
  gateway_processing_failed: true,
  context_window_exceeded: true,
  session_budget_exceeded: true,
  usage_limit_exceeded: true,
  server_overloaded: true,
  policy_blocked: true,
  http_connection_failed: true,
  response_stream_connection_failed: true,
  internal_server_error: true,
  unauthorized: true,
  bad_request: true,
  thread_rollback_failed: true,
  sandbox_error: true,
  response_stream_disconnected: true,
  response_too_many_failed_attempts: true,
  active_turn_not_steerable: true,
  other: true,
  turn_failed: true,
} as const satisfies Record<HostedFailureCode, true>);

const HOSTED_FAILURE_PREFIX = 'hosted:';
const HOSTED_FAILURE_FALLBACK = 'hosted:turn_failed';

function hostedFailureClass(terminalReason: string | null): string {
  if (!terminalReason?.startsWith(HOSTED_FAILURE_PREFIX)) return HOSTED_FAILURE_FALLBACK;
  const code = terminalReason.slice(HOSTED_FAILURE_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(HOSTED_FAILURE_CODES, code)
    ? terminalReason
    : HOSTED_FAILURE_FALLBACK;
}

const LOCAL_FAILURE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/timed?\s?out|etimedout|deadline/, 'local:timeout'],
  [/rate.?limit|\b429\b|too many requests|usage limit|quota/, 'local:rate_limited'],
  [
    /context (window|length)|too many tokens|token limit|prompt is too long/,
    'local:context_exceeded',
  ],
  [
    /unauthori[sz]ed|authenticat|not logged in|log ?in required|\b40[13]\b|api key|credential/,
    'local:auth_failed',
  ],
  [
    /enoent|command not found|not installed|no such file or directory|executable/,
    'local:cli_unavailable',
  ],
  [/econn|enotfound|eai_again|getaddrinfo|network|socket|fetch failed/, 'local:network'],
  [/exit(ed)? (with )?(code|status)|signal|killed|crash/, 'local:process_exit'],
  [/no response|empty response/, 'local:no_response'],
];

function localFailureClass(turn: ChatTurnSummary): string {
  const failure = parseNativeTerminalReason(turn.terminalReason);
  if (failure) return `local:${failure.reason}`;
  const text = `${turn.error ?? ''} ${turn.terminalReason ?? ''}`.toLowerCase();
  return LOCAL_FAILURE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? 'local:turn_failed';
}

export function installWorkflowTelemetryObservers(): () => void {
  const statuses = snapshotTurnStatuses();
  const operations = new Map<string, WorkflowOperation>();

  const uninstallToolCalls = installAgentToolCallTelemetry();
  const uninstallGenomeViews = installGenomeViewTelemetry();
  const uninstallBackgroundJobs = installBackgroundJobTelemetry();
  const unsubscribe = useChatStore.subscribe((state) => {
    const currentTurns = allTurns(state._convStates);
    for (const turn of currentTurns.values()) {
      const previousStatus = statuses.get(turn.id);
      if (previousStatus === turn.status) continue;

      if (turn.status === 'running') {
        operations.get(turn.id)?.cancel();
        const workflow = workflowForTurn(turn);
        operations.set(
          turn.id,
          beginWorkflowAction({
            workflow,
            action: workflow === 'ask_ai' ? 'send' : 'complete',
            actionId: turn.id,
          })
        );
      } else {
        const operation = operations.get(turn.id);
        const valueDelivered = hasPersistedAssistantResponse(
          state._convStates.get(turn.conversationId),
          turn.id
        );
        if (turn.status === 'completed') {
          operation?.complete({ status: 'completed', valueDelivered });
        } else if (turn.status === 'stopped' || turn.status === 'cancelled') {
          operation?.cancel({
            status: turn.status === 'stopped' ? 'stopped' : 'cancelled',
            valueDelivered:
              turn.status === 'stopped' &&
              parseNativeTerminalReason(turn.terminalReason)?.reason !== 'stop_unconfirmed' &&
              valueDelivered,
          });
        } else {
          operation?.fail(
            turn.routeKind === 'hosted'
              ? hostedFailureClass(turn.terminalReason)
              : localFailureClass(turn),
            {
              status: 'failed',
            }
          );
        }
        operations.delete(turn.id);
      }
      statuses.set(turn.id, turn.status);
    }

    for (const turnId of statuses.keys()) {
      if (currentTurns.has(turnId)) continue;
      operations.get(turnId)?.cancel();
      operations.delete(turnId);
      statuses.delete(turnId);
    }
  });
  return () => {
    unsubscribe();
    uninstallToolCalls();
    uninstallGenomeViews();
    uninstallBackgroundJobs();
  };
}

function workflowForTurn(turn: ChatTurnSummary): ScientificWorkflow {
  if (turn.routeKind === 'hosted') return 'hosted_ai';
  if (turn.routeKind === 'cli' && turn.transport === 'codex-sdk') return 'local_codex';
  if (turn.routeKind === 'cli' && turn.transport === 'claude-agent-sdk') return 'local_claude';
  if (turn.routeKind === 'cli' && turn.transport === 'grok-acp') return 'local_grok';
  return 'ask_ai';
}

function hasPersistedAssistantResponse(
  conversation: ConversationState | undefined,
  turnId: string
): boolean {
  return (
    conversation?.messages?.some(
      (message) =>
        message.turnId === turnId &&
        message.role === 'assistant' &&
        hasQualifyingAssistantContent(message.content)
    ) ?? false
  );
}

function snapshotTurnStatuses(): Map<string, ChatTurnSummary['status']> {
  return new Map(
    [...allTurns(useChatStore.getState()._convStates).values()].map((turn) => [
      turn.id,
      turn.status,
    ])
  );
}

function allTurns(
  conversationStates: Map<string, { turns: Record<string, ChatTurnSummary> }>
): Map<string, ChatTurnSummary> {
  const result = new Map<string, ChatTurnSummary>();
  for (const conversation of conversationStates.values()) {
    for (const turn of Object.values(conversation.turns)) result.set(turn.id, turn);
  }
  return result;
}
