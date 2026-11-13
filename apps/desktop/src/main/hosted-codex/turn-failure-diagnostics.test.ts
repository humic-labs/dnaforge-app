import { describe, expect, it } from 'vitest';

import {
  hostedGatewayTerminalFailurePresentation,
  hostedFailureResultCode,
  hostedRequestSizeFailurePresentation,
  hostedTransportFailurePresentation,
  hostedTurnFailurePresentation,
} from './turn-failure-diagnostics';
import type { ResponsesRequestSizeTrace, ResponsesTransportTrace } from './responses-server';
import { projectHostedCodexError } from './user-visible-projection';

describe('Hosted turn failure diagnostics', () => {
  it('keeps a local oversize rejection typed, non-retryable, and distinct from an outage', () => {
    const trace: ResponsesRequestSizeTrace = {
      requestSequence: 6,
      phase: 'continuation',
      measuredBytes: 2_097_153,
      warningBytes: 1_572_864,
      maximumBytes: 2_097_152,
      threshold: 'maximum',
      disposition: 'rejected',
      gatewayAttempted: false,
    };

    expect(hostedRequestSizeFailurePresentation([trace])).toEqual({
      visibleCode: 'HOSTED_REQUEST_TOO_LARGE',
      technicalCode: 'LOCAL_REQUEST_TOO_LARGE',
      resultCode: 'request_too_large',
      retryable: false,
      stage: 'final_response_after_local_tools',
    });
    expect(hostedFailureResultCode(null, [], 'other', null, [trace])).toBe('request_too_large');
    const projected = projectHostedCodexError('HOSTED_REQUEST_TOO_LARGE');
    expect(projected.message).toContain('accumulated more context');
    expect(projected.message).not.toContain('unavailable');
    expect(projected.retryable).toBe(false);
  });

  it('maps an App Server HTTP 413 to the same typed size failure', () => {
    expect(hostedTurnFailurePresentation('other', 413)).toEqual({
      visibleCode: 'HOSTED_REQUEST_TOO_LARGE',
      retryable: false,
    });
    expect(hostedFailureResultCode(null, [], 'other', 413)).toBe('request_too_large');
  });

  it.each([
    ['response_too_many_failed_attempts', 'HOSTED_CONNECTION_FAILED', true],
    ['sandbox_error', 'HOSTED_LOCAL_TOOL_FAILED', true],
    ['thread_rollback_failed', 'HOSTED_TURN_STATE_FAILED', false],
  ] as const)('keeps %s message and retry behavior consistent', (code, visibleCode, retryable) => {
    const presentation = hostedTurnFailurePresentation(code);
    expect(presentation).toEqual({ visibleCode, retryable });

    const projected = projectHostedCodexError(presentation.visibleCode, {
      technicalCode: code.toUpperCase(),
      stage: code === 'sandbox_error' ? 'local_tool' : 'provider_response',
      retryable: presentation.retryable,
      referenceId: 'A5C9802C',
    });
    expect(projected.message).not.toMatch(/Error code:|Stage:|Retry:|Reference ID:/u);
    expect(projected.retryable).toBe(retryable);
  });

  it('tells the user to leave an uncertain chat before trying again', () => {
    const presentation = hostedTurnFailurePresentation('thread_rollback_failed');
    const projected = projectHostedCodexError(presentation.visibleCode, {
      technicalCode: 'THREAD_ROLLBACK_FAILED',
      stage: 'provider_response',
      retryable: presentation.retryable,
      referenceId: 'A5C9802C',
    });

    expect(projected.message).toContain('Start a new chat before trying again.');
    expect(projected.retryable).toBe(false);
  });

  it('maps only fixed safe gateway codes into user-visible diagnostics', () => {
    expect(hostedGatewayTerminalFailurePresentation('provider_service_unavailable')).toEqual({
      visibleCode: 'HOSTED_SERVICE_OVERLOADED',
      technicalCode: 'PROVIDER_SERVICE_UNAVAILABLE',
      resultCode: 'provider_service_unavailable',
    });
    expect(
      hostedGatewayTerminalFailurePresentation('provider prompt and deployment secret')
    ).toBeNull();
  });

  it('presents provider-start exhaustion as a request limit without naming an environment', () => {
    const presentation = hostedGatewayTerminalFailurePresentation(
      'provider_start_budget_exhausted'
    );
    expect(presentation).toEqual({
      visibleCode: 'HOSTED_TURN_BUDGET_EXHAUSTED',
      technicalCode: 'PROVIDER_START_BUDGET_EXHAUSTED',
      resultCode: 'provider_start_budget_exhausted',
    });
    const projected = projectHostedCodexError(presentation!.visibleCode, {
      technicalCode: presentation!.technicalCode,
      stage: 'final_response_after_local_tools',
      retryable: false,
      referenceId: '6C6905FC',
    });
    expect(projected.message).toContain('safety limit for model steps or tool calls');
    expect(projected.message).not.toMatch(/staging|production|campaign/iu);
    expect(projected.message).not.toMatch(/Error code:|Stage:|Retry:|Reference ID:/u);
    expect(projected.retryable).toBe(false);
  });

  it('presents provider spend exhaustion as a request limit without naming an environment', () => {
    const presentation = hostedGatewayTerminalFailurePresentation(
      'provider_spend_budget_exhausted'
    );
    expect(presentation).toEqual({
      visibleCode: 'HOSTED_TURN_BUDGET_EXHAUSTED',
      technicalCode: 'PROVIDER_SPEND_BUDGET_EXHAUSTED',
      resultCode: 'provider_spend_budget_exhausted',
    });
    const projected = projectHostedCodexError(presentation!.visibleCode, {
      technicalCode: presentation!.technicalCode,
      stage: 'final_response_after_local_tools',
      retryable: false,
      referenceId: '6E3E1EE2',
    });
    expect(projected.message).toContain('safety limit for model steps or tool calls');
    expect(projected.message).not.toMatch(/staging|production|campaign/iu);
    expect(projected.message).not.toMatch(/Error code:|Stage:|Retry:|Reference ID:/u);
    expect(projected.retryable).toBe(false);
  });

  it.each([
    ['provider_continuity_missing', 'PROVIDER_CONTINUITY_MISSING'],
    ['provider_continuity_mismatch', 'PROVIDER_CONTINUITY_MISMATCH'],
  ] as const)('preserves the non-retryable response-contract class %s', (code, technicalCode) => {
    const presentation = hostedGatewayTerminalFailurePresentation(code);
    expect(presentation).toEqual({
      visibleCode: 'HOSTED_RESPONSE_CONTRACT_FAILED',
      technicalCode,
      resultCode: code,
    });
    expect(hostedFailureResultCode(code, [])).toBe(code);
  });

  it('surfaces a fixed translation code without exposing stream content', () => {
    const presentation = hostedTransportFailurePresentation([
      {
        responseSequence: 0,
        gatewayEventTotal: 1,
        gatewayEvents: [],
        responsesEventTotal: 1,
        responsesEvents: [],
        outcome: 'translation_error',
        errorCode: 'stream_provider_continuity_missing',
        responseDigest: 'a'.repeat(64),
      },
    ]);

    expect(presentation).toEqual({
      visibleCode: 'HOSTED_RESPONSE_CONTRACT_FAILED',
      technicalCode: 'STREAM_PROVIDER_CONTINUITY_MISSING',
      retryable: false,
    });
    expect(
      hostedTransportFailurePresentation([
        {
          responseSequence: 0,
          gatewayEventTotal: 0,
          gatewayEvents: [],
          responsesEventTotal: 0,
          responsesEvents: [],
          outcome: 'step_error',
          errorCode: 'provider secret from an untrusted exception',
          responseDigest: 'b'.repeat(64),
        },
      ])
    ).toBeNull();
  });

  it('explains unresolved provider exposure and forbids futile retries', () => {
    const presentation = hostedTransportFailurePresentation([
      {
        responseSequence: 0,
        gatewayEventTotal: 0,
        gatewayEvents: [],
        responsesEventTotal: 1,
        responsesEvents: [{ type: 'error', fields: {} }],
        outcome: 'step_error',
        errorCode: 'gateway_provider_exposure_reconciliation_required',
        responseDigest: 'c'.repeat(64),
      },
    ]);

    expect(presentation).toEqual({
      visibleCode: 'HOSTED_PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED',
      technicalCode: 'PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED',
      resultCode: 'provider_exposure_reconciliation_required',
      retryable: false,
      stage: 'gateway_request',
    });
    if (!presentation?.stage) {
      throw new Error('Expected a diagnostic stage for unresolved provider exposure.');
    }
    const projected = projectHostedCodexError(presentation!.visibleCode, {
      technicalCode: presentation!.technicalCode,
      stage: presentation.stage,
      retryable: presentation!.retryable,
      referenceId: '9391539F',
    });
    expect(projected.message).toContain('earlier provider charges are still being reconciled');
    expect(projected.message).not.toMatch(/Error code:|Stage:|Retry:|Reference ID:/u);
    expect(projected.message).not.toContain('unresolved_provider_exposure_pending');
    expect(projected.retryable).toBe(false);
  });

  it('does not present an ambiguous policy rejection as exhausted allowance', () => {
    const presentation = hostedTransportFailurePresentation([
      {
        responseSequence: 0,
        gatewayEventTotal: 0,
        gatewayEvents: [],
        responsesEventTotal: 1,
        responsesEvents: [{ type: 'error', fields: {} }],
        outcome: 'step_error',
        errorCode: 'gateway_allowance_or_policy_rejected',
        responseDigest: 'd'.repeat(64),
      },
    ]);

    expect(presentation).toMatchObject({
      visibleCode: 'HOSTED_UNAVAILABLE',
      resultCode: 'allowance_or_policy_rejected',
      retryable: true,
    });
    const projected = projectHostedCodexError(presentation!.visibleCode, {
      technicalCode: presentation!.technicalCode,
      stage: presentation!.stage!,
      retryable: presentation!.retryable,
      referenceId: '3F19CE58',
    });
    expect(projected.message).toBe(
      'DNAForge AI is unavailable right now. Please try again shortly.'
    );
    expect(projected.message).not.toMatch(/allowance|ALLOWANCE_OR_POLICY_REJECTED|3F19CE58/u);
  });

  it.each([
    ['gateway_not_configured', 'not_configured'],
    ['gateway_signed_out', 'signed_out'],
    ['gateway_invalid_request', 'invalid_request'],
    ['gateway_request_too_large', 'request_too_large'],
    ['gateway_paused', 'gateway_paused'],
    ['gateway_allowance_exhausted', 'allowance_exhausted'],
    ['gateway_rate_limited', 'rate_limited'],
    [
      'gateway_provider_exposure_reconciliation_required',
      'provider_exposure_reconciliation_required',
    ],
    ['gateway_allowance_or_policy_rejected', 'allowance_or_policy_rejected'],
    ['gateway_unavailable', 'gateway_unavailable'],
  ] as const)('preserves safe pre-stream class %s as %s', (errorCode, resultCode) => {
    const trace: ResponsesTransportTrace = {
      responseSequence: 0,
      gatewayEventTotal: 0,
      gatewayEvents: [],
      responsesEventTotal: 1,
      responsesEvents: [{ type: 'error', fields: {} }],
      outcome: 'step_error',
      errorCode,
      responseDigest: 'd'.repeat(64),
    };
    expect(hostedFailureResultCode(null, [trace])).toBe(resultCode);
  });

  it('prefers a fixed gateway terminal class and rejects unknown diagnostic text', () => {
    expect(hostedFailureResultCode('provider_stream_failed', [])).toBe('provider_stream_failed');
    expect(hostedFailureResultCode('private provider failure detail', [])).toBe('turn_failed');
  });

  it.each([
    'context_window_exceeded',
    'server_overloaded',
    'sandbox_error',
    'unauthorized',
  ] as const)('preserves bounded App Server failure class %s in the result', (code) => {
    expect(hostedFailureResultCode(null, [], code)).toBe(code);
  });

  it('keeps gateway and transport evidence ahead of the child fallback', () => {
    const trace: ResponsesTransportTrace = {
      responseSequence: 0,
      gatewayEventTotal: 0,
      gatewayEvents: [],
      responsesEventTotal: 1,
      responsesEvents: [{ type: 'error', fields: {} }],
      outcome: 'step_error',
      errorCode: 'gateway_unavailable',
      responseDigest: 'e'.repeat(64),
    };

    expect(hostedFailureResultCode(null, [trace], 'sandbox_error')).toBe('gateway_unavailable');
    expect(hostedFailureResultCode('provider_stream_failed', [trace], 'sandbox_error')).toBe(
      'provider_stream_failed'
    );
  });

  it('ignores a recovered historical transport error when the latest response succeeded', () => {
    const recoveredFailure: ResponsesTransportTrace = {
      responseSequence: 0,
      gatewayEventTotal: 0,
      gatewayEvents: [],
      responsesEventTotal: 1,
      responsesEvents: [{ type: 'error', fields: {} }],
      outcome: 'step_error',
      errorCode: 'gateway_rate_limited',
      responseDigest: '1'.repeat(64),
    };
    const laterSuccess: ResponsesTransportTrace = {
      responseSequence: 1,
      gatewayEventTotal: 2,
      gatewayEvents: [
        { type: 'accepted', fields: {} },
        { type: 'finish', fields: {} },
      ],
      responsesEventTotal: 2,
      responsesEvents: [
        { type: 'response.created', fields: {} },
        { type: 'response.completed', fields: {} },
      ],
      outcome: 'completed',
      errorCode: null,
      responseDigest: '2'.repeat(64),
    };

    expect(
      hostedFailureResultCode(null, [laterSuccess, recoveredFailure], 'thread_rollback_failed')
    ).toBe('thread_rollback_failed');
  });

  it('lets an unknown present gateway terminal suppress lower failure classes', () => {
    const trace: ResponsesTransportTrace = {
      responseSequence: 0,
      gatewayEventTotal: 0,
      gatewayEvents: [],
      responsesEventTotal: 1,
      responsesEvents: [{ type: 'error', fields: {} }],
      outcome: 'step_error',
      errorCode: 'gateway_rate_limited',
      responseDigest: '3'.repeat(64),
    };

    expect(
      hostedFailureResultCode('future_private_gateway_code', [trace], 'thread_rollback_failed')
    ).toBe('turn_failed');
  });

  it('uses the generic result for a recognized response-contract failure before a child class', () => {
    const trace: ResponsesTransportTrace = {
      responseSequence: 0,
      gatewayEventTotal: 1,
      gatewayEvents: [{ type: 'accepted', fields: {} }],
      responsesEventTotal: 2,
      responsesEvents: [{ type: 'response.created', fields: {} }],
      outcome: 'translation_error',
      errorCode: 'stream_unterminated_stream',
      responseDigest: 'f'.repeat(64),
    };

    expect(hostedFailureResultCode(null, [trace], 'sandbox_error')).toBe('turn_failed');
  });
});
