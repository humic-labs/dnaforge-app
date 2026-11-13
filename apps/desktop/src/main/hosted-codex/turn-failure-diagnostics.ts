import type { HostedTurnFailureCode } from './turn-loop';
import type { ResponsesRequestSizeTrace, ResponsesTransportTrace } from './responses-server';
import type {
  HostedCodexDiagnosticStage,
  HostedCodexVisibleErrorCode,
} from './user-visible-projection';
import type { HostedCodexTurnResult } from '../../shared/hosted-codex-ipc';

type HostedCodexFailureResultCode = Extract<HostedCodexTurnResult, { ok: false }>['code'];

export interface HostedTurnFailurePresentation {
  readonly visibleCode: HostedCodexVisibleErrorCode;
  readonly retryable: boolean;
}

export interface HostedTransportFailurePresentation extends HostedTurnFailurePresentation {
  readonly technicalCode: string;
  readonly resultCode?: HostedCodexFailureResultCode;
  readonly stage?: HostedCodexDiagnosticStage;
}

const TRANSPORT_FAILURE_PRESENTATIONS: Readonly<
  Record<string, HostedTransportFailurePresentation>
> = Object.freeze({
  stream_failed: {
    visibleCode: 'HOSTED_CONNECTION_FAILED',
    technicalCode: 'RESPONSE_STREAM_FAILED',
    retryable: true,
  },
  gateway_not_configured: {
    visibleCode: 'HOSTED_UNAVAILABLE',
    technicalCode: 'GATEWAY_NOT_CONFIGURED',
    resultCode: 'not_configured',
    retryable: false,
    stage: 'local_runtime',
  },
  gateway_signed_out: {
    visibleCode: 'HOSTED_AUTHENTICATION_FAILED',
    technicalCode: 'GATEWAY_SIGNED_OUT',
    resultCode: 'signed_out',
    retryable: false,
    stage: 'sign_in',
  },
  gateway_invalid_request: {
    visibleCode: 'HOSTED_INVALID_REQUEST',
    technicalCode: 'GATEWAY_INVALID_REQUEST',
    resultCode: 'invalid_request',
    retryable: false,
    stage: 'turn_preparation',
  },
  gateway_request_too_large: {
    visibleCode: 'HOSTED_REQUEST_TOO_LARGE',
    technicalCode: 'GATEWAY_REQUEST_TOO_LARGE',
    resultCode: 'request_too_large',
    retryable: false,
    stage: 'gateway_request',
  },
  gateway_paused: {
    visibleCode: 'HOSTED_UNAVAILABLE',
    technicalCode: 'GATEWAY_PAUSED',
    resultCode: 'gateway_paused',
    retryable: true,
    stage: 'gateway_request',
  },
  gateway_allowance_exhausted: {
    visibleCode: 'HOSTED_ALLOWANCE_EXHAUSTED',
    technicalCode: 'ALLOWANCE_EXHAUSTED',
    resultCode: 'allowance_exhausted',
    retryable: false,
    stage: 'gateway_request',
  },
  gateway_rate_limited: {
    visibleCode: 'HOSTED_RATE_LIMITED',
    technicalCode: 'RATE_LIMITED',
    resultCode: 'rate_limited',
    retryable: true,
    stage: 'gateway_request',
  },
  gateway_provider_exposure_reconciliation_required: {
    visibleCode: 'HOSTED_PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED',
    technicalCode: 'PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED',
    resultCode: 'provider_exposure_reconciliation_required',
    retryable: false,
    stage: 'gateway_request',
  },
  gateway_allowance_or_policy_rejected: {
    visibleCode: 'HOSTED_UNAVAILABLE',
    technicalCode: 'ALLOWANCE_OR_POLICY_REJECTED',
    resultCode: 'allowance_or_policy_rejected',
    retryable: true,
    stage: 'gateway_request',
  },
  gateway_unavailable: {
    visibleCode: 'HOSTED_UNAVAILABLE',
    technicalCode: 'GATEWAY_UNAVAILABLE',
    resultCode: 'gateway_unavailable',
    retryable: true,
    stage: 'gateway_request',
  },
  ...Object.fromEntries(
    [
      'stream_event_before_accepted',
      'stream_duplicate_accepted',
      'stream_sequence_not_advancing',
      'stream_event_after_terminal',
      'stream_unterminated_stream',
      'stream_ill_formed_text',
      'stream_provider_continuity_missing',
      'stream_provider_continuity_mismatch',
      'stream_unknown_event',
    ].map((code) => [
      code,
      {
        visibleCode: 'HOSTED_RESPONSE_CONTRACT_FAILED',
        technicalCode: code.toUpperCase(),
        retryable: false,
      },
    ])
  ),
});

export function hostedTransportFailurePresentation(
  traces: readonly ResponsesTransportTrace[]
): HostedTransportFailurePresentation | null {
  const latest = traces.reduce<ResponsesTransportTrace | null>(
    (selected, trace) =>
      selected === null || trace.responseSequence > selected.responseSequence ? trace : selected,
    null
  );
  const code = latest?.errorCode;
  return code ? (TRANSPORT_FAILURE_PRESENTATIONS[code] ?? null) : null;
}

export function hostedRequestSizeFailurePresentation(
  traces: readonly ResponsesRequestSizeTrace[]
): HostedTransportFailurePresentation | null {
  const latest = traces.reduce<ResponsesRequestSizeTrace | null>(
    (selected, trace) =>
      selected === null || trace.requestSequence > selected.requestSequence ? trace : selected,
    null
  );
  if (
    latest?.disposition !== 'rejected' ||
    latest.threshold !== 'maximum' ||
    latest.gatewayAttempted
  ) {
    return null;
  }
  return {
    visibleCode: 'HOSTED_REQUEST_TOO_LARGE',
    technicalCode: 'LOCAL_REQUEST_TOO_LARGE',
    resultCode: 'request_too_large',
    retryable: false,
    stage:
      latest.phase === 'continuation' ? 'final_response_after_local_tools' : 'turn_preparation',
  };
}

interface HostedGatewayTerminalFailurePresentation {
  readonly visibleCode: HostedCodexVisibleErrorCode;
  readonly technicalCode: string;
  readonly resultCode: HostedCodexFailureResultCode;
}

const GATEWAY_TERMINAL_PRESENTATIONS: Readonly<
  Record<string, HostedGatewayTerminalFailurePresentation>
> = Object.freeze({
  provider_rate_limited: {
    visibleCode: 'HOSTED_RATE_LIMITED',
    technicalCode: 'PROVIDER_RATE_LIMITED',
    resultCode: 'provider_rate_limited',
  },
  provider_authentication_failed: {
    visibleCode: 'HOSTED_AUTHENTICATION_FAILED',
    technicalCode: 'PROVIDER_AUTHENTICATION_FAILED',
    resultCode: 'provider_authentication_failed',
  },
  provider_request_rejected: {
    visibleCode: 'HOSTED_INVALID_REQUEST',
    technicalCode: 'PROVIDER_REQUEST_REJECTED',
    resultCode: 'provider_request_rejected',
  },
  provider_service_unavailable: {
    visibleCode: 'HOSTED_SERVICE_OVERLOADED',
    technicalCode: 'PROVIDER_SERVICE_UNAVAILABLE',
    resultCode: 'provider_service_unavailable',
  },
  provider_http_error: {
    visibleCode: 'HOSTED_UNAVAILABLE',
    technicalCode: 'PROVIDER_HTTP_ERROR',
    resultCode: 'provider_http_error',
  },
  provider_stream_disconnected: {
    visibleCode: 'HOSTED_CONNECTION_FAILED',
    technicalCode: 'PROVIDER_STREAM_DISCONNECTED',
    resultCode: 'provider_stream_disconnected',
  },
  provider_stream_failed: {
    visibleCode: 'HOSTED_CONNECTION_FAILED',
    technicalCode: 'PROVIDER_STREAM_FAILED',
    resultCode: 'provider_stream_failed',
  },
  provider_continuity_missing: {
    visibleCode: 'HOSTED_RESPONSE_CONTRACT_FAILED',
    technicalCode: 'PROVIDER_CONTINUITY_MISSING',
    resultCode: 'provider_continuity_missing',
  },
  provider_continuity_mismatch: {
    visibleCode: 'HOSTED_RESPONSE_CONTRACT_FAILED',
    technicalCode: 'PROVIDER_CONTINUITY_MISMATCH',
    resultCode: 'provider_continuity_mismatch',
  },
  provider_start_budget_exhausted: {
    visibleCode: 'HOSTED_TURN_BUDGET_EXHAUSTED',
    technicalCode: 'PROVIDER_START_BUDGET_EXHAUSTED',
    resultCode: 'provider_start_budget_exhausted',
  },
  provider_spend_budget_exhausted: {
    visibleCode: 'HOSTED_TURN_BUDGET_EXHAUSTED',
    technicalCode: 'PROVIDER_SPEND_BUDGET_EXHAUSTED',
    resultCode: 'provider_spend_budget_exhausted',
  },
  workflow_lease_lost: {
    visibleCode: 'HOSTED_CONNECTION_FAILED',
    technicalCode: 'WORKFLOW_LEASE_LOST',
    resultCode: 'workflow_lease_lost',
  },
  gateway_processing_failed: {
    visibleCode: 'HOSTED_UNAVAILABLE',
    technicalCode: 'GATEWAY_PROCESSING_FAILED',
    resultCode: 'gateway_processing_failed',
  },
});

export function hostedGatewayTerminalFailurePresentation(
  code: string
): HostedGatewayTerminalFailurePresentation | null {
  return GATEWAY_TERMINAL_PRESENTATIONS[code] ?? null;
}

export function hostedFailureResultCode(
  gatewayTerminalCode: string | null,
  traces: readonly ResponsesTransportTrace[],
  childFailureCode: HostedTurnFailureCode | null = null,
  childHttpStatusCode: number | null = null,
  requestSizeTraces: readonly ResponsesRequestSizeTrace[] = []
): HostedCodexFailureResultCode {
  const gateway = gatewayTerminalCode
    ? hostedGatewayTerminalFailurePresentation(gatewayTerminalCode)
    : null;
  if (gatewayTerminalCode !== null) return gateway?.resultCode ?? 'turn_failed';
  const requestSize = hostedRequestSizeFailurePresentation(requestSizeTraces);
  if (requestSize) return requestSize.resultCode ?? 'request_too_large';
  const transport = hostedTransportFailurePresentation(traces);
  if (transport) return transport.resultCode ?? 'turn_failed';
  if (childHttpStatusCode === 413) return 'request_too_large';
  return childFailureCode ?? 'turn_failed';
}

export function hostedTurnFailurePresentation(
  code: HostedTurnFailureCode,
  httpStatusCode: number | null = null
): HostedTurnFailurePresentation {
  if (httpStatusCode === 413) {
    return { visibleCode: 'HOSTED_REQUEST_TOO_LARGE', retryable: false };
  }
  switch (code) {
    case 'context_window_exceeded':
      return { visibleCode: 'HOSTED_CONTEXT_TOO_LARGE', retryable: false };
    case 'session_budget_exceeded':
      return { visibleCode: 'HOSTED_TURN_BUDGET_EXHAUSTED', retryable: false };
    case 'usage_limit_exceeded':
      return { visibleCode: 'HOSTED_ALLOWANCE_EXHAUSTED', retryable: false };
    case 'server_overloaded':
      return { visibleCode: 'HOSTED_SERVICE_OVERLOADED', retryable: true };
    case 'policy_blocked':
      return { visibleCode: 'HOSTED_POLICY_BLOCKED', retryable: false };
    case 'http_connection_failed':
    case 'response_stream_connection_failed':
    case 'response_stream_disconnected':
    case 'response_too_many_failed_attempts':
      return { visibleCode: 'HOSTED_CONNECTION_FAILED', retryable: true };
    case 'unauthorized':
      return { visibleCode: 'HOSTED_AUTHENTICATION_FAILED', retryable: false };
    case 'bad_request':
    case 'active_turn_not_steerable':
      return { visibleCode: 'HOSTED_INVALID_REQUEST', retryable: false };
    case 'sandbox_error':
      return { visibleCode: 'HOSTED_LOCAL_TOOL_FAILED', retryable: true };
    case 'thread_rollback_failed':
      return { visibleCode: 'HOSTED_TURN_STATE_FAILED', retryable: false };
    case 'internal_server_error':
      return { visibleCode: 'HOSTED_UNAVAILABLE', retryable: true };
    case 'other':
      return { visibleCode: 'HOSTED_UNAVAILABLE', retryable: false };
  }
}
