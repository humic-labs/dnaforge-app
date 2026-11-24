import type { NativeTurnFailure, NativeTurnReason } from '../../shared/native-turn-failure';
import { createHash } from 'node:crypto';
import type { AgentProvider, AgentSessionTerminalStatus } from './types';
import {
  aiTurnCountBucket,
  aiTurnDurationBucket,
  hasQualifyingAssistantContent,
  type AiTurnFailureClass,
  type AiTurnFinishedProperties,
  type AiTurnInitiator,
  type AiTurnReasonCode,
  type AiTurnStage,
} from '../../shared/ai-turn-telemetry';

export function localAiTurnFinishedEventId(sessionId: string): string {
  const hex = createHash('sha256')
    .update(`dnaforge:ai-turn-finished:v1:local:${sessionId}`, 'utf8')
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface LocalAiTurnTerminalInput {
  sessionId: string;
  actionId?: string | null;
  provider: AgentProvider;
  status: AgentSessionTerminalStatus;
  durationMs: number;
  visibleAssistantText: string;
  toolCallCount: number | 'unknown';
  completedWorkspaceToolCount: number | 'unknown';
  hadWorkspaceContext: boolean;
  continuation: boolean;
  failure?: NativeTurnFailure;
  recovered?: boolean;
}

function routeForProvider(provider: AgentProvider): 'local_codex' | 'local_claude' | 'local_grok' {
  if (provider === 'codex-sdk') return 'local_codex';
  if (provider === 'grok-acp') return 'local_grok';
  return 'local_claude';
}

const failureClasses = {
  executable_unavailable: 'admission',
  authentication_required: 'authentication',
  admission_rejected: 'admission',
  dns_resolution_failed: 'transport',
  transport_lost: 'transport',
  provider_capacity: 'provider',
  provider_rejected: 'provider',
  provider_error: 'provider',
  provider_timeout: 'timeout',
  process_exit: 'interruption',
  no_response: 'provider',
  provider_cancelled: 'none',
  user_stop_acknowledged: 'none',
  stop_unconfirmed: 'interruption',
  tool_failed: 'tool',
  unknown: 'unknown',
} as const satisfies Record<NativeTurnReason, AiTurnFailureClass>;

function terminalDimensions(input: LocalAiTurnTerminalInput): {
  outcome: AiTurnFinishedProperties['outcome'];
  initiatedBy: AiTurnInitiator;
  reason: AiTurnReasonCode;
  failureClass: AiTurnFailureClass;
  stage: AiTurnStage;
} {
  if (input.status === 'completed') {
    return {
      outcome: 'completed',
      initiatedBy: 'provider',
      reason: 'completed',
      failureClass: 'none',
      stage: 'finalization',
    };
  }
  if (input.status === 'stop_unconfirmed') {
    return {
      outcome: 'interrupted',
      initiatedBy: 'user',
      reason: 'stop_unconfirmed',
      failureClass: 'interruption',
      stage: input.failure?.stage ?? (input.recovered ? 'recovery' : 'provider_stream'),
    };
  }
  if (input.status === 'cancelled') {
    const userStopped = input.failure?.reason === 'user_stop_acknowledged';
    return {
      outcome: userStopped ? 'stopped' : 'cancelled',
      initiatedBy: userStopped ? 'user' : 'provider',
      reason: userStopped ? 'user_stop_acknowledged' : 'provider_cancelled',
      failureClass: 'none',
      stage: input.failure?.stage ?? 'provider_stream',
    };
  }
  if (input.status === 'interrupted') {
    return {
      outcome: 'interrupted',
      initiatedBy: 'desktop',
      reason: 'app_restarted',
      failureClass: 'interruption',
      stage: 'recovery',
    };
  }
  const failure = input.failure ?? {
    reason: input.provider === 'grok-acp' ? 'provider_error' : 'unknown',
    stage: 'provider_stream',
  };
  const failureClass = failureClasses[failure.reason];
  return {
    outcome: 'failed',
    initiatedBy:
      failureClass === 'timeout'
        ? 'timeout'
        : failureClass === 'admission'
          ? 'desktop'
          : failureClass === 'unknown'
            ? 'unknown'
            : 'provider',
    reason: failure.reason,
    failureClass,
    stage: failure.stage,
  };
}

export function buildLocalAiTurnFinished(
  input: LocalAiTurnTerminalInput
): AiTurnFinishedProperties {
  const terminal = terminalDimensions(input);
  const valueDelivered =
    terminal.outcome === 'completed' && hasQualifyingAssistantContent(input.visibleAssistantText);
  const qualificationBasis = valueDelivered ? 'completed_response' : 'none';
  return {
    ...(input.actionId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.actionId
    )
      ? { action_id: input.actionId }
      : {}),
    route: routeForProvider(input.provider),
    outcome: terminal.outcome,
    value_delivered: valueDelivered,
    qualification_basis: qualificationBasis,
    initiated_by: terminal.initiatedBy,
    stage: terminal.stage,
    reason_code: terminal.reason,
    failure_class: terminal.failureClass,
    effect_state:
      input.completedWorkspaceToolCount === 'unknown'
        ? 'unknown'
        : input.completedWorkspaceToolCount > 0
          ? 'unknown'
          : 'none',
    trace_state: 'not_applicable',
    settlement_state: 'not_applicable',
    duration_bucket: aiTurnDurationBucket(input.durationMs),
    provider_attempt_count_bucket: 'not_applicable',
    tool_call_count_bucket:
      input.toolCallCount === 'unknown' ? 'unknown' : aiTurnCountBucket(input.toolCallCount),
    workspace_tool_count_bucket:
      input.completedWorkspaceToolCount === 'unknown'
        ? 'unknown'
        : aiTurnCountBucket(input.completedWorkspaceToolCount),
    had_workspace_context: input.hadWorkspaceContext,
    continuation: input.continuation,
    $insert_id: localAiTurnFinishedEventId(input.sessionId),
  };
}
