import { createHash } from 'node:crypto';
import type { AgentProvider, AgentSessionStatus } from './types';
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
  status: Extract<
    AgentSessionStatus,
    'completed' | 'failed' | 'cancelled' | 'stop_requested' | 'interrupted'
  >;
  durationMs: number;
  visibleAssistantText: string;
  toolCallCount: number | 'unknown';
  completedWorkspaceToolCount: number | 'unknown';
  hadWorkspaceContext: boolean;
  continuation: boolean;
  reasonHint?:
    | 'admission_rejected'
    | 'workspace_grounding_failed'
    | 'authentication_required'
    | 'policy_denied'
    | 'provider_timeout'
    | 'transport_lost'
    | 'tool_failed'
    | 'unknown';
  unconfirmedStop?: boolean;
}

function routeForProvider(provider: AgentProvider): 'local_codex' | 'local_claude' | 'local_grok' {
  if (provider === 'codex-sdk') return 'local_codex';
  if (provider === 'grok-acp') return 'local_grok';
  return 'local_claude';
}

function failureDimensions(hint: LocalAiTurnTerminalInput['reasonHint']): {
  reason: AiTurnReasonCode;
  failureClass: AiTurnFailureClass;
  stage: AiTurnStage;
} {
  switch (hint) {
    case 'admission_rejected':
      return { reason: hint, failureClass: 'admission', stage: 'admission' };
    case 'workspace_grounding_failed':
      return { reason: hint, failureClass: 'policy', stage: 'projection' };
    case 'authentication_required':
      return { reason: hint, failureClass: 'authentication', stage: 'admission' };
    case 'policy_denied':
      return { reason: hint, failureClass: 'policy', stage: 'approval' };
    case 'provider_timeout':
      return { reason: hint, failureClass: 'timeout', stage: 'provider_stream' };
    case 'transport_lost':
      return { reason: hint, failureClass: 'transport', stage: 'provider_stream' };
    case 'tool_failed':
      return { reason: hint, failureClass: 'tool', stage: 'tool_execution' };
    default:
      return { reason: 'provider_error', failureClass: 'provider', stage: 'provider_stream' };
  }
}

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
  if (input.status === 'stop_requested') {
    return {
      outcome: 'stopped',
      initiatedBy: 'user',
      reason: 'user_stop_acknowledged',
      failureClass: 'none',
      stage: 'provider_stream',
    };
  }
  if (input.status === 'cancelled') {
    return {
      outcome: 'cancelled',
      initiatedBy: 'provider',
      reason: 'provider_cancelled',
      failureClass: 'none',
      stage: 'provider_stream',
    };
  }
  if (input.status === 'interrupted') {
    return input.unconfirmedStop
      ? {
          outcome: 'interrupted',
          initiatedBy: 'user',
          reason: 'stop_unconfirmed',
          failureClass: 'interruption',
          stage: 'recovery',
        }
      : {
          outcome: 'interrupted',
          initiatedBy: 'desktop',
          reason: 'app_restarted',
          failureClass: 'interruption',
          stage: 'recovery',
        };
  }
  const failure = failureDimensions(input.reasonHint);
  return {
    outcome: 'failed',
    initiatedBy:
      failure.failureClass === 'timeout'
        ? 'timeout'
        : failure.failureClass === 'admission'
          ? 'desktop'
          : 'provider',
    reason: failure.reason,
    failureClass: failure.failureClass,
    stage: failure.stage,
  };
}

export function buildLocalAiTurnFinished(
  input: LocalAiTurnTerminalInput
): AiTurnFinishedProperties {
  const terminal = terminalDimensions(input);
  const valueDelivered =
    (terminal.outcome === 'completed' || terminal.outcome === 'stopped') &&
    hasQualifyingAssistantContent(input.visibleAssistantText);
  const qualificationBasis =
    valueDelivered && terminal.outcome === 'completed'
      ? 'completed_response'
      : valueDelivered && terminal.outcome === 'stopped'
        ? 'partial_response_before_stop'
        : 'none';
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
