import { STOPPED_ASSISTANT_NOTICE } from './hosted-codex-stopped-answer';

export const AI_TURN_ROUTES = ['hosted_ai', 'local_codex', 'local_claude', 'local_grok'] as const;
export type AiTurnRoute = (typeof AI_TURN_ROUTES)[number];

export const AI_TURN_OUTCOMES = [
  'completed',
  'failed',
  'stopped',
  'cancelled',
  'interrupted',
  'outcome_unknown',
] as const;
export type AiTurnOutcome = (typeof AI_TURN_OUTCOMES)[number];

export const AI_TURN_INITIATORS = [
  'user',
  'provider',
  'desktop',
  'gateway',
  'policy',
  'timeout',
  'unknown',
] as const;
export type AiTurnInitiator = (typeof AI_TURN_INITIATORS)[number];

export const AI_TURN_STAGES = [
  'admission',
  'provider_start',
  'provider_stream',
  'approval',
  'tool_execution',
  'observation',
  'projection',
  'finalization',
  'recovery',
] as const;
export type AiTurnStage = (typeof AI_TURN_STAGES)[number];

export const AI_TURN_EFFECT_STATES = ['none', 'applied', 'no_effect', 'unknown'] as const;
export type AiTurnEffectState = (typeof AI_TURN_EFFECT_STATES)[number];

export const AI_TURN_TRACE_STATES = ['complete', 'incomplete', 'not_applicable'] as const;
export type AiTurnTraceState = (typeof AI_TURN_TRACE_STATES)[number];

export const AI_TURN_SETTLEMENT_STATES = [
  'settled',
  'reconciliation_required',
  'expired',
  'not_applicable',
] as const;
export type AiTurnSettlementState = (typeof AI_TURN_SETTLEMENT_STATES)[number];

export const AI_TURN_QUALIFICATION_BASES = [
  'completed_response',
  'partial_response_before_stop',
  'none',
] as const;
export type AiTurnQualificationBasis = (typeof AI_TURN_QUALIFICATION_BASES)[number];

export const AI_TURN_FAILURE_CLASSES = [
  'none',
  'admission',
  'authentication',
  'provider',
  'transport',
  'timeout',
  'policy',
  'tool',
  'observation',
  'projection',
  'finalization',
  'interruption',
  'unknown',
] as const;
export type AiTurnFailureClass = (typeof AI_TURN_FAILURE_CLASSES)[number];

export const AI_TURN_REASON_CODES = [
  'completed',
  'user_stop_acknowledged',
  'stop_unconfirmed',
  'provider_cancelled',
  'provider_error',
  'executable_unavailable',
  'dns_resolution_failed',
  'provider_rejected',
  'provider_capacity',
  'process_exit',
  'no_response',
  'provider_timeout',
  'transport_lost',
  'process_interrupted',
  'app_restarted',
  'authentication_required',
  'admission_rejected',
  'policy_denied',
  'workspace_grounding_failed',
  'tool_failed',
  'observation_failed',
  'projection_failed',
  'finalization_failed',
  'settlement_incomplete',
  'unknown',
] as const;
export type AiTurnReasonCode = (typeof AI_TURN_REASON_CODES)[number];

export const AI_TURN_DURATION_BUCKETS = [
  'lt_1s',
  '1_5s',
  '5_30s',
  '30_120s',
  '2_10m',
  '10m_plus',
  'unknown',
] as const;
export type AiTurnDurationBucket = (typeof AI_TURN_DURATION_BUCKETS)[number];

export const AI_TURN_COUNT_BUCKETS = [
  'zero',
  'one',
  'two_to_five',
  'six_to_twenty',
  'twenty_one_plus',
  'unknown',
  'not_applicable',
] as const;
export type AiTurnCountBucket = (typeof AI_TURN_COUNT_BUCKETS)[number];

export interface AiTurnFinishedProperties {
  action_id?: string;
  route: AiTurnRoute;
  outcome: AiTurnOutcome;
  value_delivered: boolean;
  qualification_basis: AiTurnQualificationBasis;
  initiated_by: AiTurnInitiator;
  stage: AiTurnStage;
  reason_code: AiTurnReasonCode;
  failure_class: AiTurnFailureClass;
  effect_state: AiTurnEffectState;
  trace_state: AiTurnTraceState;
  settlement_state: AiTurnSettlementState;
  duration_bucket: AiTurnDurationBucket;
  provider_attempt_count_bucket: AiTurnCountBucket;
  tool_call_count_bucket: AiTurnCountBucket;
  workspace_tool_count_bucket: AiTurnCountBucket;
  had_workspace_context: boolean;
  continuation: boolean;
  $insert_id: string;
}

const NON_VALUE_ASSISTANT_MARKERS: readonly (string | RegExp)[] = [
  /\*\[Paused\]\*/giu,
  STOPPED_ASSISTANT_NOTICE,
];

export function hasQualifyingAssistantContent(content: string): boolean {
  return (
    NON_VALUE_ASSISTANT_MARKERS.reduce<string>(
      (value, marker) => value.replaceAll(marker, ''),
      content
    ).trim().length > 0
  );
}

export function aiTurnDurationBucket(durationMs: number): AiTurnDurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  if (durationMs < 1_000) return 'lt_1s';
  if (durationMs < 5_000) return '1_5s';
  if (durationMs < 30_000) return '5_30s';
  if (durationMs < 120_000) return '30_120s';
  if (durationMs < 600_000) return '2_10m';
  return '10m_plus';
}

export function aiTurnCountBucket(count: number | null): AiTurnCountBucket {
  if (count === null) return 'not_applicable';
  if (!Number.isInteger(count) || count < 0) return 'unknown';
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count <= 5) return 'two_to_five';
  if (count <= 20) return 'six_to_twenty';
  return 'twenty_one_plus';
}
