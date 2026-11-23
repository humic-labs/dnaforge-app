import { userMessage, type UserMessage, type UserMessageKey } from '@waypoint/user-messages';
import { AI_TURN_STAGES, type AiTurnStage } from './ai-turn-telemetry';

const messages = {
  executable_unavailable: 'assistant.nativeExecutableUnavailable',
  authentication_required: 'failure.cli-authentication-failed',
  dns_resolution_failed: 'assistant.nativeDnsFailure',
  provider_rejected: 'assistant.nativeRequestRejected',
  admission_rejected: 'assistant.nativeAdmissionRejected',
  provider_capacity: 'assistant.nativeCapacity',
  provider_error: 'assistant.nativeProviderError',
  provider_timeout: 'assistant.nativeTimeout',
  process_exit: 'assistant.nativeProcessExit',
  no_response: 'assistant.nativeNoResponse',
  provider_cancelled: 'assistant.nativeCancelled',
  user_stop_acknowledged: 'assistant.nativeStopped',
  stop_unconfirmed: 'assistant.nativeStopUnconfirmed',
  transport_lost: 'assistant.nativeConnectionLost',
  tool_failed: 'assistant.nativeToolFailed',
  unknown: 'assistant.failed',
} as const satisfies Record<string, UserMessageKey>;

export type NativeTurnReason = keyof typeof messages;

export interface NativeTurnFailure {
  reason: NativeTurnReason;
  stage: AiTurnStage;
}

export function nativeFailureMessage(failure: NativeTurnFailure): UserMessage {
  return userMessage(messages[failure.reason]);
}

export function nativeFailureStatus(
  failure: NativeTurnFailure
): 'stopped' | 'cancelled' | 'failed' {
  if (failure.reason === 'stop_unconfirmed' || failure.reason === 'user_stop_acknowledged')
    return 'stopped';
  if (failure.reason === 'provider_cancelled') return 'cancelled';
  return 'failed';
}

export function nativeTerminalReason(failure: NativeTurnFailure): string {
  return `native:${failure.stage}:${failure.reason}`;
}

export function parseNativeTerminalReason(value: string | null): NativeTurnFailure | null {
  const parts = value?.split(':');
  if (!parts || parts.length !== 3 || parts[0] !== 'native') return null;
  const [, stage, reason] = parts;
  if (!AI_TURN_STAGES.includes(stage as AiTurnStage) || !Object.hasOwn(messages, reason))
    return null;
  return { stage: stage as AiTurnStage, reason: reason as NativeTurnReason };
}
