import { prepareHostedNativeShellLaunch } from '../hosted-native-shell-confinement';
import { withHostedNativeWritablePaths } from '../hosted-native-write-admission';
import { resolvePublicTelemetryActorRequestContext } from '../telemetry-runtime';
import { app, BrowserWindow, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isHostedNativeToolName, type HostedStreamEvent } from '@waypoint/hosted-ai-contract';
import { userMessagePayload, userMessageValue, userToolLabel } from '@waypoint/user-messages';
import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { hostedAllowanceContract } from '../../shared/ipc/hosted-allowance.contract';

import { HostedAiGatewayClient, resolveHostedAiGatewayUrl } from '../hosted-ai-gateway';
import { HostedAiStreamManager, packagedQualificationFaultProfile } from '../hosted-ai-stream';
import { HostedAiContributionGate } from '../hosted-ai-contribution-gate';
import { CONTRIBUTION_REFUSAL_PRESENTATIONS } from '../hosted-contribution-error';
import { getActiveStoredSession } from '../auth/session-store';
import { subscribeAuthState } from '../auth/controller';
import { HostedAiTurnAuthority, type HostedAiTurnIdentity } from '../hosted-ai-turn-authority';
import {
  confirmDestructiveFileWithRenderer,
  requestAgentUserInputWithRenderer,
} from '../agent-confirm';
import { HostedNativeToolBroker } from '../hosted-native-tool-broker';
import { HostedNativeWebClient } from '../hosted-native-web-client';
import { resolveActiveHostedWorkspacePath } from '../hosted-workspace-authority';
import {
  parseHostedAiNativeOperationId,
  parseHostedAiNativeToolRequest,
  toHostedAiNativeToolFailure,
} from '../hosted-native-tool-request';
import { assertSafePath, assertSafeWritablePath } from './path-allowlist';
import { getDb } from './database';
import { trashAcceptedScientificPath } from '../scientific-resource-lifecycle';
import type { AgentToolsBridgeServer } from '../agent-tools-bridge';
import { AgentStateCapsuleStore } from '../hosted-codex/agent-state-capsule';
import {
  resolveCodexAppServerBinaryAsync,
  verifyCodexAppServerVersion,
} from '../hosted-codex/app-server-binary';
import {
  runHostedTurnAfterStartupBarrier,
  startHostedSession,
  type HostedSession,
} from '../hosted-codex/hosted-session';
import {
  createHostedCodexGatewayWorkflow,
  HostedCodexGatewayWorkflowError,
  type HostedCodexGatewayWorkflow,
} from '../hosted-codex/hosted-gateway-workflow';
import { terminalizeStoppedHostedWorkflow } from '../hosted-codex/interstep-stop';
import {
  projectHostedCodexError,
  type HostedCodexDiagnosticStage,
  type HostedCodexVisibleError,
  type HostedCodexVisibleErrorCode,
} from '../hosted-codex/user-visible-projection';
import type { HostedTurnFailure } from '../hosted-codex/turn-loop';
import {
  HostedCodexStreamFailure,
  ResponsesStepFailure,
  type ResponsesRequestSizeTrace,
  type ResponsesTransportTrace,
} from '../hosted-codex/responses-server';
import {
  hostedGatewayTerminalFailurePresentation,
  hostedFailureResultCode,
  hostedRequestSizeFailurePresentation,
  hostedTransportFailurePresentation,
  hostedTurnFailurePresentation,
} from '../hosted-codex/turn-failure-diagnostics';
import { appendHostedCodexTurnJournal } from '../hosted-codex/turn-journal';
import { readHostedToolInventorySummary } from '../hosted-codex/tool-inventory-observation';
import { executeHostedCodexLocalTool } from '../hosted-codex/local-tool-executor';
import {
  validateHostedCodexCompletion,
  type HostedCodexCompletedTool,
} from '../hosted-codex/completion-grounding';
import {
  parseHostedCodexIdentity,
  parseHostedCodexTurnStartRequest,
} from '../hosted-codex/turn-request';
import {
  appendHostedCodexAdmissionJournal,
  appendHostedCodexRouteAvailabilityJournal,
} from '../hosted-codex/admission-journal';
import { PACKAGED_SOURCE_COMMIT } from '../release-stamp';
import {
  HOSTED_AI_GATEWAY_GET_WORKFLOW_AUTHORITY_CHANNEL,
  HOSTED_AI_GATEWAY_GET_ROUTE_AVAILABILITY_CHANNEL,
  HOSTED_AI_GATEWAY_REQUEST_RAW_TRACE_DELETION_CHANNEL,
  HOSTED_AI_GATEWAY_START_STREAM_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_STREAM_CHANNEL,
  HOSTED_AI_GATEWAY_STREAM_EVENT_CHANNEL,
  HOSTED_AI_GATEWAY_PREPARE_CONTRIBUTION_CHANNEL,
  HOSTED_AI_GATEWAY_VALIDATE_TURN_BINDING_CHANNEL,
  HOSTED_AI_GATEWAY_RELEASE_TURN_BINDING_CHANNEL,
  HOSTED_AI_GATEWAY_RECORD_TOOL_OBSERVATION_CHANNEL,
  HOSTED_AI_GATEWAY_CLAIM_TOOL_CHANNEL,
  HOSTED_AI_GATEWAY_COMPLETE_TOOL_CLAIM_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_TOOL_CLAIM_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_WORKFLOW_CHANNEL,
  HOSTED_AI_GATEWAY_EXECUTE_NATIVE_TOOL_CHANNEL,
  HOSTED_AI_GATEWAY_CANCEL_NATIVE_TOOL_CHANNEL,
  type HostedAiTurnBindingRequest,
  type HostedAiToolObservationRequest,
  type HostedAiToolClaimRequest,
  type HostedAiToolClaimCompleteRequest,
  type HostedAiToolClaimCancelRequest,
  type HostedAiWorkflowTerminalRequest,
  type HostedAiStreamStartResult,
} from '../../shared/hosted-ai-gateway-ipc';
import {
  HOSTED_CODEX_TURN_EVENT_CHANNEL,
  type HostedCodexContributionRequest,
  type HostedCodexContributionResult,
  type HostedCodexPreparedTurnCancelResult,
  type HostedCodexTurnEvent,
  type HostedCodexTurnIdentity,
  type HostedCodexTurnResult,
  type HostedCodexTurnStopRequest,
  type HostedCodexTurnStopResult,
} from '../../shared/hosted-codex-ipc';
import { hostedCodexContract } from '../../shared/ipc/hosted-codex.contract';
import { dnaforgeSupervision, launchAgentPermissions } from '../../shared/agent-permissions';
import { readAgentPermissionCatalog } from '../agent-sdk/agent-permission-catalog';
import { approvalChoiceAllows } from '../../shared/agent-approval';

let unsubscribeHostedAuth: (() => void) | null = null;
let shutdownHostedAiGatewayRef: (() => Promise<void>) | null = null;

export async function shutdownHostedAiGatewayHandlers(): Promise<void> {
  const shutdown = shutdownHostedAiGatewayRef;
  shutdownHostedAiGatewayRef = null;
  await shutdown?.();
}

function validString(item: unknown, maximum = 256): item is string {
  return typeof item === 'string' && item.length > 0 && item.length <= maximum;
}

function uuid(item: unknown): item is string {
  return (
    typeof item === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)
  );
}

function turnBindingRequestSubset(value: unknown): HostedAiTurnBindingRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !validString(candidate.turnBindingToken) ||
    !validString(candidate.workflowId) ||
    !validString(candidate.runId) ||
    !validString(candidate.turnId)
  )
    return null;
  return {
    turnBindingToken: candidate.turnBindingToken,
    workflowId: candidate.workflowId,
    runId: candidate.runId,
    turnId: candidate.turnId,
  };
}

function turnBindingRequest(value: unknown): HostedAiTurnBindingRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value as Record<string, unknown>).length !== 4) return null;
  return turnBindingRequestSubset(value);
}

function toolObservationRequest(value: unknown): HostedAiToolObservationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const valid = (item: unknown, maximum = 256): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= maximum;
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  if (
    (Object.keys(candidate).length !== 7 && Object.keys(candidate).length !== 8) ||
    !valid(candidate.turnBindingToken) ||
    !valid(candidate.workflowId) ||
    !valid(candidate.runId) ||
    !valid(candidate.turnId) ||
    !valid(candidate.ticket, 4096) ||
    (candidate.claimId !== undefined && !uuid(candidate.claimId)) ||
    !record(candidate.argumentsPayload) ||
    !record(candidate.observationPayload)
  ) {
    return null;
  }
  return {
    turnBindingToken: candidate.turnBindingToken,
    workflowId: candidate.workflowId,
    runId: candidate.runId,
    turnId: candidate.turnId,
    ticket: candidate.ticket,
    ...(candidate.claimId ? { claimId: candidate.claimId } : {}),
    argumentsPayload: candidate.argumentsPayload,
    observationPayload: candidate.observationPayload,
  };
}

function toolClaimRequest(value: unknown): HostedAiToolClaimRequest | null {
  const binding = turnBindingRequestSubset(value);
  if (!binding || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 7 ||
    !validString(candidate.ticket, 4096) ||
    !validString(candidate.approvalReceiptRef) ||
    !validString(candidate.idempotencyKey)
  )
    return null;
  return {
    ...binding,
    ticket: candidate.ticket,
    approvalReceiptRef: candidate.approvalReceiptRef,
    idempotencyKey: candidate.idempotencyKey,
  };
}

function toolClaimCompleteRequest(value: unknown): HostedAiToolClaimCompleteRequest | null {
  const binding = turnBindingRequestSubset(value);
  if (!binding || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 7 ||
    !uuid(candidate.claimId) ||
    !validString(candidate.idempotencyKey) ||
    !validString(candidate.effectReceiptRef)
  )
    return null;
  return {
    ...binding,
    claimId: candidate.claimId,
    idempotencyKey: candidate.idempotencyKey,
    effectReceiptRef: candidate.effectReceiptRef,
  };
}

function toolClaimCancelRequest(value: unknown): HostedAiToolClaimCancelRequest | null {
  const binding = turnBindingRequestSubset(value);
  if (!binding || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 7 ||
    !uuid(candidate.claimId) ||
    !validString(candidate.idempotencyKey) ||
    (candidate.reason !== 'stopped_before_effect' &&
      candidate.reason !== 'user_declined_before_effect' &&
      candidate.reason !== 'pre_effect_failure')
  )
    return null;
  return {
    ...binding,
    claimId: candidate.claimId,
    idempotencyKey: candidate.idempotencyKey,
    reason: candidate.reason,
  };
}

function workflowTerminalRequest(value: unknown): HostedAiWorkflowTerminalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const valid = (item: unknown): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= 256;
  if (
    Object.keys(candidate).length !== 6 ||
    !valid(candidate.turnBindingToken) ||
    !valid(candidate.workflowId) ||
    !valid(candidate.runId) ||
    !valid(candidate.turnId) ||
    !uuid(candidate.workflowRunId) ||
    !uuid(candidate.workflowStepId)
  ) {
    return null;
  }
  return {
    turnBindingToken: candidate.turnBindingToken,
    workflowId: candidate.workflowId,
    runId: candidate.runId,
    turnId: candidate.turnId,
    workflowRunId: candidate.workflowRunId,
    workflowStepId: candidate.workflowStepId,
  };
}

function hostedCodexIdentity(value: unknown): HostedCodexTurnIdentity | null {
  return parseHostedCodexIdentity(value);
}

function parseHostedCodexContributionRequest(
  value: unknown
): HostedCodexContributionRequest | null {
  const identity = hostedCodexIdentity(value);
  if (!identity || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4 ||
    (candidate.workspacePath !== null &&
      (typeof candidate.workspacePath !== 'string' || candidate.workspacePath.length > 32_768))
  ) {
    return null;
  }
  return { ...identity, workspacePath: candidate.workspacePath as string | null };
}

function parseHostedCodexTurnStopRequest(value: unknown): HostedCodexTurnStopRequest | null {
  const identity = hostedCodexIdentity(value);
  if (!identity || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value as Record<string, unknown>).length === 3 ? identity : null;
}

function hostedCodexTurnKey(ownerId: number, identity: HostedCodexTurnIdentity): string {
  return `${ownerId}:${identity.workflowId}:${identity.runId}:${identity.turnId}`;
}

interface InternalHostedStreamQueue {
  readonly values: HostedStreamEvent[];
  readonly waiters: Array<{
    resolve(value: IteratorResult<HostedStreamEvent>): void;
    reject(reason: unknown): void;
  }>;
  failure: HostedCodexStreamFailure | null;
  terminal: boolean;
}

type HostedCodexTurnEventPayload =
  | { readonly kind: 'text_delta'; readonly delta: string }
  | {
      readonly kind: 'tool_completed';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly output: unknown;
      readonly isError: boolean;
    };

function boundedHostedToolFailureCode(output: unknown): string | undefined {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    !('code' in output) ||
    typeof output.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,79}$/u.test(output.code)
  ) {
    return undefined;
  }
  return output.code;
}

function hostedBiologySearchReturnedMatches(
  toolName: string,
  input: unknown,
  output: unknown
): boolean {
  if (
    toolName !== 'list_files' ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output)
  ) {
    return false;
  }
  const inputRecord = input as Record<string, unknown>;
  const outputRecord = output as Record<string, unknown>;
  if (
    typeof inputRecord.biologyQuery !== 'string' ||
    inputRecord.biologyQuery.trim().length === 0
  ) {
    return false;
  }
  return (
    typeof outputRecord.count === 'number' &&
    outputRecord.count > 0 &&
    Array.isArray(outputRecord.entries) &&
    outputRecord.entries.length > 0
  );
}

function pushInternalHostedEvent(
  queue: InternalHostedStreamQueue,
  envelope: import('../../shared/hosted-ai-gateway-ipc').HostedAiStreamEventEnvelope
): void {
  if (queue.terminal) return;
  if (envelope.kind === 'transport_error') {
    const failure = new HostedCodexStreamFailure('gateway_unavailable', envelope.message);
    queue.failure = failure;
    queue.terminal = true;
    for (const waiter of queue.waiters.splice(0)) {
      waiter.reject(failure);
    }
    return;
  }
  const event = envelope.event;
  const waiter = queue.waiters.shift();
  if (waiter) waiter.resolve({ done: false, value: event });
  else queue.values.push(event);
  if (event.event === 'finish' || event.event === 'error') queue.terminal = true;
}

function failInternalHostedStream(
  queue: InternalHostedStreamQueue,
  code: Extract<HostedCodexTurnResult, { ok: false }>['code'],
  message: string
): void {
  if (queue.terminal) return;
  const failure = new HostedCodexStreamFailure(code, message);
  queue.failure = failure;
  queue.terminal = true;
  for (const waiter of queue.waiters.splice(0)) {
    waiter.reject(failure);
  }
}

const RESPONSES_STEP_FAILURE_BY_START_CODE = {
  not_configured: 'gateway_not_configured',
  signed_out: 'gateway_signed_out',
  invalid_request: 'gateway_invalid_request',
  request_too_large: 'gateway_request_too_large',
  gateway_paused: 'gateway_paused',
  allowance_exhausted: 'gateway_allowance_exhausted',
  rate_limited: 'gateway_rate_limited',
  provider_exposure_reconciliation_required: 'gateway_provider_exposure_reconciliation_required',
  allowance_or_policy_rejected: 'gateway_allowance_or_policy_rejected',
  gateway_unavailable: 'gateway_unavailable',
} as const satisfies Record<
  Extract<HostedAiStreamStartResult, { ok: false }>['code'],
  import('../hosted-codex/responses-server').ResponsesStepFailureCode
>;

type HostedCodexFailedResultCode =
  | Extract<HostedCodexTurnResult, { ok: false }>['code']
  | Extract<HostedCodexContributionResult, { ok: false }>['code'];

function supportReference(source: string = randomUUID()): string {
  return source.replaceAll('-', '').slice(0, 8).toUpperCase();
}

function visibleCodeForResult(code: HostedCodexFailedResultCode): HostedCodexVisibleErrorCode {
  switch (code) {
    case 'legal_acceptance_missing':
    case 'contribution_policy_stale':
    case 'contribution_choice_rejected':
      return CONTRIBUTION_REFUSAL_PRESENTATIONS[code];
    case 'rate_limited':
      return 'HOSTED_RATE_LIMITED';
    case 'allowance_exhausted':
      return 'HOSTED_ALLOWANCE_EXHAUSTED';
    case 'allowance_or_policy_rejected':
      return 'HOSTED_UNAVAILABLE';
    case 'provider_exposure_reconciliation_required':
      return 'HOSTED_PROVIDER_EXPOSURE_RECONCILIATION_REQUIRED';
    case 'app_server_unavailable':
      return 'HOSTED_CODEX_APP_SERVER_CRASH';
    case 'tool_failed':
    case 'sandbox_error':
      return 'HOSTED_LOCAL_TOOL_FAILED';
    case 'invalid_request':
    case 'bad_request':
    case 'active_turn_not_steerable':
      return 'HOSTED_INVALID_REQUEST';
    case 'context_window_exceeded':
      return 'HOSTED_CONTEXT_TOO_LARGE';
    case 'request_too_large':
      return 'HOSTED_REQUEST_TOO_LARGE';
    case 'session_budget_exceeded':
      return 'HOSTED_TURN_BUDGET_EXHAUSTED';
    case 'usage_limit_exceeded':
      return 'HOSTED_ALLOWANCE_EXHAUSTED';
    case 'server_overloaded':
      return 'HOSTED_SERVICE_OVERLOADED';
    case 'policy_blocked':
      return 'HOSTED_POLICY_BLOCKED';
    case 'http_connection_failed':
    case 'response_stream_connection_failed':
    case 'response_stream_disconnected':
    case 'response_too_many_failed_attempts':
      return 'HOSTED_CONNECTION_FAILED';
    case 'unauthorized':
      return 'HOSTED_AUTHENTICATION_FAILED';
    case 'thread_rollback_failed':
      return 'HOSTED_TURN_STATE_FAILED';
    case 'not_prepared':
    case 'not_configured':
    case 'signed_out':
    case 'gateway_paused':
    case 'gateway_unavailable':
    case 'provider_rate_limited':
    case 'provider_authentication_failed':
    case 'provider_request_rejected':
    case 'provider_service_unavailable':
    case 'provider_http_error':
    case 'provider_stream_disconnected':
    case 'provider_stream_failed':
      return 'HOSTED_UNAVAILABLE';
    case 'provider_continuity_missing':
    case 'provider_continuity_mismatch':
      return 'HOSTED_RESPONSE_CONTRACT_FAILED';
    case 'provider_start_budget_exhausted':
    case 'provider_spend_budget_exhausted':
    case 'workflow_lease_lost':
    case 'gateway_processing_failed':
    case 'internal_server_error':
    case 'other':
    case 'turn_failed':
      return 'HOSTED_UNAVAILABLE';
  }
}

function resultIsRetryable(code: HostedCodexFailedResultCode): boolean {
  switch (code) {
    case 'legal_acceptance_missing':
    case 'contribution_policy_stale':
    case 'contribution_choice_rejected':
    case 'allowance_exhausted':
    case 'provider_exposure_reconciliation_required':
    case 'invalid_request':
    case 'context_window_exceeded':
    case 'request_too_large':
    case 'session_budget_exceeded':
    case 'usage_limit_exceeded':
    case 'policy_blocked':
    case 'unauthorized':
    case 'bad_request':
    case 'thread_rollback_failed':
    case 'active_turn_not_steerable':
    case 'other':
    case 'not_configured':
    case 'signed_out':
      return false;
    case 'not_prepared':
    case 'gateway_paused':
    case 'rate_limited':
    case 'allowance_or_policy_rejected':
    case 'gateway_unavailable':
    case 'app_server_unavailable':
    case 'tool_failed':
    case 'server_overloaded':
    case 'http_connection_failed':
    case 'response_stream_connection_failed':
    case 'internal_server_error':
    case 'sandbox_error':
    case 'response_stream_disconnected':
    case 'response_too_many_failed_attempts':
    case 'provider_rate_limited':
    case 'provider_service_unavailable':
    case 'provider_http_error':
    case 'provider_stream_disconnected':
    case 'provider_stream_failed':
    case 'workflow_lease_lost':
    case 'gateway_processing_failed':
    case 'turn_failed':
      return true;
    case 'provider_authentication_failed':
    case 'provider_request_rejected':
    case 'provider_continuity_missing':
    case 'provider_continuity_mismatch':
    case 'provider_start_budget_exhausted':
    case 'provider_spend_budget_exhausted':
      return false;
  }
}

function stageForResult(
  code: HostedCodexFailedResultCode,
  failure: HostedTurnFailure | undefined,
  provenance?: ReturnType<ReturnType<typeof createHostedCodexGatewayWorkflow>['provenance']>
): HostedCodexDiagnosticStage {
  if (failure?.code === 'sandbox_error' || code === 'tool_failed') return 'local_tool';
  if (code === 'app_server_unavailable' || code === 'not_configured') return 'local_runtime';
  if (code === 'not_prepared' || code === 'invalid_request') return 'turn_preparation';
  if (code === 'signed_out' || code === 'legal_acceptance_missing') return 'sign_in';
  if (code === 'contribution_policy_stale' || code === 'contribution_choice_rejected') {
    return 'turn_preparation';
  }
  if (code === 'provider_exposure_reconciliation_required') return 'gateway_request';
  if (
    provenance &&
    (provenance.completedToolCallIds.length > 0 || provenance.reservationIds.length > 1)
  ) {
    return 'final_response_after_local_tools';
  }
  return 'provider_response';
}

function projectTurnFailure(options: {
  readonly code: HostedCodexFailedResultCode;
  readonly turnId?: string;
  readonly failure?: HostedTurnFailure;
  readonly provenance?: ReturnType<
    ReturnType<typeof createHostedCodexGatewayWorkflow>['provenance']
  >;
  readonly transportTraces?: readonly ResponsesTransportTrace[];
  readonly requestSizeTraces?: readonly ResponsesRequestSizeTrace[];
}): Pick<HostedCodexVisibleError, 'message' | 'userMessageKey'> {
  const childFailure = options.failure;
  const hasSpecificChildFailure =
    childFailure !== undefined &&
    (childFailure.code !== 'other' || childFailure.httpStatusCode === 413);
  const gatewayFailure = options.provenance?.terminalError ?? null;
  const gatewayPresentation = gatewayFailure
    ? hostedGatewayTerminalFailurePresentation(gatewayFailure.code)
    : undefined;
  const childPresentation =
    !gatewayFailure && hasSpecificChildFailure
      ? hostedTurnFailurePresentation(childFailure.code, childFailure.httpStatusCode)
      : undefined;
  const requestSizePresentation = gatewayFailure
    ? undefined
    : hostedRequestSizeFailurePresentation(options.requestSizeTraces ?? []);
  const transportPresentation = gatewayFailure
    ? undefined
    : hostedTransportFailurePresentation(options.transportTraces ?? []);
  const visibleCode =
    gatewayPresentation?.visibleCode ??
    requestSizePresentation?.visibleCode ??
    transportPresentation?.visibleCode ??
    childPresentation?.visibleCode ??
    visibleCodeForResult(options.code);
  const technicalCode =
    gatewayPresentation?.technicalCode ??
    (gatewayFailure ? 'TURN_FAILED' : undefined) ??
    requestSizePresentation?.technicalCode ??
    transportPresentation?.technicalCode ??
    (hasSpecificChildFailure
      ? childFailure.code.toUpperCase()
      : childFailure
        ? 'TURN_FAILED'
        : options.code.toUpperCase());
  return visibleFailure(
    projectHostedCodexError(visibleCode, {
      technicalCode,
      stage:
        requestSizePresentation?.stage ??
        transportPresentation?.stage ??
        stageForResult(options.code, options.failure, options.provenance),
      retryable:
        (gatewayPresentation ? gatewayFailure?.retryable : undefined) ??
        requestSizePresentation?.retryable ??
        transportPresentation?.retryable ??
        childPresentation?.retryable ??
        resultIsRetryable(options.code),
      referenceId: supportReference(options.turnId),
      httpStatusCode:
        (gatewayPresentation ? gatewayFailure?.httpStatusCode : undefined) ??
        childFailure?.httpStatusCode,
    })
  );
}

function visibleFailure(
  visible: HostedCodexVisibleError
): Pick<HostedCodexVisibleError, 'message' | 'userMessageKey'> {
  return { message: visible.message, userMessageKey: visible.userMessageKey };
}

export function registerHostedAiGatewayHandlers(
  deps: {
    readonly getAgentToolsBridge?: () => AgentToolsBridgeServer | null;
  } = {}
): void {
  const client = new HostedAiGatewayClient();
  const nativeWebClient = new HostedNativeWebClient();
  const owners = new Map<number, Electron.WebContents>();
  const internalStreams = new Map<string, InternalHostedStreamQueue>();
  const pendingCodexBindings = new Map<string, string>();
  let verifiedAppServerBinary: Promise<
    Awaited<ReturnType<typeof resolveCodexAppServerBinaryAsync>>
  > | null = null;
  const getVerifiedAppServerBinary = (): Promise<
    Awaited<ReturnType<typeof resolveCodexAppServerBinaryAsync>>
  > => {
    if (!verifiedAppServerBinary) {
      verifiedAppServerBinary = resolveCodexAppServerBinaryAsync({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      })
        .then(async (binary) => {
          await verifyCodexAppServerVersion(binary);
          return binary;
        })
        .catch((cause: unknown) => {
          verifiedAppServerBinary = null;
          throw cause;
        });
    }
    return verifiedAppServerBinary;
  };
  const activeCodexTurns = new Map<
    string,
    {
      session: HostedSession | null;
      workflow: HostedCodexGatewayWorkflow | null;
      readonly turnBindingToken: string;
      readonly requestIds: Set<string>;
      readonly approvalController: AbortController;
      stopping: boolean;
    }
  >();
  const turnAuthority = new HostedAiTurnAuthority({ getSession: getActiveStoredSession });
  const nativeToolBroker = new HostedNativeToolBroker({
    prepareShellProcess: (request) =>
      prepareHostedNativeShellLaunch({
        db: getDb(),
        request,
        privateRoot: join(app.getPath('userData'), 'hosted-native-shell'),
        resolveBinary: getVerifiedAppServerBinary,
      }),
    authorizeTurn: async (ownerId, request) => {
      const scope = await turnAuthority.authorizeScope(ownerId, request.turnBindingToken, request);
      return { workspacePath: scope.workspacePath };
    },
    confirmDestructiveFile: (ownerId, request, signal) => {
      const owner = owners.get(ownerId);
      const window = owner && !owner.isDestroyed() ? BrowserWindow.fromWebContents(owner) : null;
      return confirmDestructiveFileWithRenderer(window, request, undefined, signal);
    },
    resolveSafePath: assertSafePath,
    resolveSafeWritablePath: assertSafeWritablePath,
    withSafeWritablePaths: (paths, operation) =>
      withHostedNativeWritablePaths(getDb(), paths, operation),
    trashPath: async (path) => {
      if (!(await trashAcceptedScientificPath({ db: getDb(), path }))) await shell.trashItem(path);
    },
    fetchWeb: (url, signal) => nativeWebClient.fetch(url, signal),
    scratchBase: join(app.getPath('userData'), 'hosted-ai-scratch'),
  });
  const drainTurnBinding = async (
    ownerId: number,
    token: string,
    identity: HostedAiTurnIdentity
  ): Promise<void> => {
    await turnAuthority.beginDrain(ownerId, token, identity);
    try {
      await nativeToolBroker.cancelTurnBinding(token);
      turnAuthority.release(ownerId, token);
    } catch (error) {
      void nativeToolBroker.waitForTurnBindingCleanup(token).then(() => {
        turnAuthority.release(ownerId, token);
      });
      throw error;
    }
  };
  const streamManager = new HostedAiStreamManager({
    resolveTelemetryActor: resolvePublicTelemetryActorRequestContext,
    qualificationFaultProfile: packagedQualificationFaultProfile(process.argv),
    authorizeTurn: (ownerId, token, identity) => turnAuthority.authorize(ownerId, token, identity),
    emit: (ownerId, envelope) => {
      const internal = internalStreams.get(envelope.clientRequestId);
      if (internal) {
        pushInternalHostedEvent(internal, envelope);
        return;
      }
      const owner = owners.get(ownerId);
      if (owner && !owner.isDestroyed()) {
        sendRendererIpc(owner, HOSTED_AI_GATEWAY_STREAM_EVENT_CHANNEL, envelope);
      }
    },
  });
  const revokeTokens = (tokens: readonly string[], message: string) => {
    for (const token of tokens) {
      streamManager.cancelTurnBinding(token, message);
      void nativeToolBroker.cancelTurnBinding(token).catch((error: unknown) => {
        console.error('[hosted-native] turn cleanup did not confirm process termination', error);
      });
    }
  };
  const contributionGate = new HostedAiContributionGate({
    getSession: getActiveStoredSession,
    getPolicy: (session) => client.getContributionPolicy(session),
    recordChoice: (session, choice, idempotencyKey, challenge) =>
      client.recordContributionChoice(session, choice, idempotencyKey, challenge),
    issueTurnBinding: async (ownerId, session, identity, workspacePath) => {
      const authorizedWorkspacePath = workspacePath
        ? await resolveActiveHostedWorkspacePath(getDb(), workspacePath, assertSafePath)
        : null;
      return turnAuthority.issue(ownerId, session, identity, authorizedWorkspacePath);
    },
    revokeTurnBindings: (session) =>
      revokeTokens(
        turnAuthority.revokeSession(session),
        'Research Contribution was withdrawn during this DNAForge AI turn.'
      ),
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_PREPARE_CONTRIBUTION_CHANNEL, (event, request: unknown) =>
    contributionGate.prepare(event.sender.id, request)
  );
  const registerOwner = (owner: Electron.WebContents) => {
    if (owners.has(owner.id)) return;
    owners.set(owner.id, owner);
    owner.once('destroyed', () => {
      for (const [key, active] of activeCodexTurns) {
        if (!key.startsWith(`${owner.id}:`)) continue;
        active.stopping = true;
        active.approvalController.abort();
        for (const requestId of active.requestIds) {
          streamManager.cancel(owner.id, requestId);
          const queue = internalStreams.get(requestId);
          if (queue) {
            failInternalHostedStream(
              queue,
              'gateway_unavailable',
              'The DNAForge AI window closed before the turn finished.'
            );
          }
        }
        void active.session?.stop().catch(() => undefined);
        activeCodexTurns.delete(key);
      }
      for (const key of pendingCodexBindings.keys()) {
        if (key.startsWith(`${owner.id}:`)) pendingCodexBindings.delete(key);
      }
      turnAuthority.cancelOwner(owner.id);
      streamManager.cancelOwner(owner.id);
      void nativeToolBroker.cancelOwner(owner.id).catch((error: unknown) => {
        console.error('[hosted-native] owner cleanup did not confirm process termination', error);
      });
      owners.delete(owner.id);
    });
  };
  handleGroup(hostedCodexContract, {
    prepareContribution: async (event, raw: unknown): Promise<HostedCodexContributionResult> => {
      registerOwner(event.sender);
      const request = parseHostedCodexContributionRequest(raw);
      if (!request) {
        return {
          ok: false,
          code: 'invalid_request',
          message: projectTurnFailure({ code: 'invalid_request' }).message,
        };
      }
      const result = await contributionGate.prepare(event.sender.id, {
        surface: 'first_hosted_attempt',
        ...request,
      });
      if (!result.ok) {
        const projected: HostedCodexContributionResult = {
          ...result,
          message: projectTurnFailure({ code: result.code, turnId: request.turnId }).message,
        };
        await appendHostedCodexAdmissionJournal({
          userDataRoot: app.getPath('userData'),
          identity: request,
          result: projected,
        }).catch(() => console.error('[HostedCodex] Admission journal write failed.'));
        return projected;
      }
      const key = hostedCodexTurnKey(event.sender.id, request);
      const previous = pendingCodexBindings.get(key);
      if (previous) {
        await drainTurnBinding(event.sender.id, previous, request).catch((error: unknown) => {
          console.error('[hosted-native] superseded turn cleanup is still pending', error);
        });
      }
      pendingCodexBindings.delete(key);
      if (result.started) {
        if (!result.turnBindingToken) {
          const failed: HostedCodexContributionResult = {
            ok: false,
            code: 'gateway_unavailable',
            message: projectTurnFailure({
              code: 'gateway_unavailable',
              turnId: request.turnId,
            }).message,
          };
          await appendHostedCodexAdmissionJournal({
            userDataRoot: app.getPath('userData'),
            identity: request,
            result: failed,
          }).catch(() => console.error('[HostedCodex] Admission journal write failed.'));
          return failed;
        }
        pendingCodexBindings.set(key, result.turnBindingToken);
      }
      const prepared: HostedCodexContributionResult = {
        ok: true,
        started: result.started,
        policy: result.policy,
        receipt: result.receipt,
      };
      await appendHostedCodexAdmissionJournal({
        userDataRoot: app.getPath('userData'),
        identity: request,
        result: prepared,
      }).catch(() => console.error('[HostedCodex] Admission journal write failed.'));
      return prepared;
    },
    cancelPreparedTurn: async (
      event,
      raw: unknown
    ): Promise<HostedCodexPreparedTurnCancelResult> => {
      const request = parseHostedCodexTurnStopRequest(raw);
      if (!request) return { ok: false };
      const key = hostedCodexTurnKey(event.sender.id, request);
      const turnBindingToken = pendingCodexBindings.get(key);
      pendingCodexBindings.delete(key);
      if (turnBindingToken) {
        await drainTurnBinding(event.sender.id, turnBindingToken, request).catch(
          (error: unknown) => {
            console.error('[hosted-native] prepared turn cleanup is still pending', error);
          }
        );
      }
      return { ok: true };
    },
    startTurn: async (event, raw: unknown): Promise<HostedCodexTurnResult> => {
      registerOwner(event.sender);
      const request = parseHostedCodexTurnStartRequest(raw);
      if (!request) {
        return {
          ok: false,
          code: 'invalid_request',
          message: 'The DNAForge AI turn request was invalid.',
        };
      }
      const permissions = launchAgentPermissions(
        await readAgentPermissionCatalog(),
        request.permissions
      );
      const supervision = dnaforgeSupervision('codex', permissions);
      const key = hostedCodexTurnKey(event.sender.id, request);
      const turnBindingToken = pendingCodexBindings.get(key);
      if (!turnBindingToken) {
        return {
          ok: false,
          code: 'not_prepared',
          ...projectTurnFailure({ code: 'not_prepared', turnId: request.turnId }),
        };
      }
      if (activeCodexTurns.has(key)) {
        return {
          ok: false,
          code: 'invalid_request',
          ...projectTurnFailure({ code: 'invalid_request', turnId: request.turnId }),
        };
      }
      pendingCodexBindings.delete(key);
      const active = {
        session: null as HostedSession | null,
        workflow: null as HostedCodexGatewayWorkflow | null,
        turnBindingToken,
        requestIds: new Set<string>(),
        approvalController: new AbortController(),
        stopping: false,
      };
      activeCodexTurns.set(key, active);
      const emit = (payload: HostedCodexTurnEventPayload): void => {
        if (!event.sender.isDestroyed()) {
          sendRendererIpc(event.sender, HOSTED_CODEX_TURN_EVENT_CHANNEL, {
            workflowId: request.workflowId,
            runId: request.runId,
            turnId: request.turnId,
            ...payload,
          } as HostedCodexTurnEvent);
        }
      };
      let session: HostedSession | null = null;
      const transportTraces: ResponsesTransportTrace[] = [];
      const requestSizeTraces: ResponsesRequestSizeTrace[] = [];
      const completedTools: HostedCodexCompletedTool[] = [];
      try {
        await turnAuthority.authorize(event.sender.id, turnBindingToken, request);
        const bridge = deps.getAgentToolsBridge?.() ?? null;
        if (!bridge) {
          throw new HostedCodexStreamFailure(
            'app_server_unavailable',
            'DNAForge AI local tools are unavailable.'
          );
        }

        const binary = await getVerifiedAppServerBinary();
        const gatewayUrl = resolveHostedAiGatewayUrl();
        if (!gatewayUrl) {
          throw new HostedCodexStreamFailure(
            'not_configured',
            'DNAForge AI is not configured in this build.'
          );
        }

        const stream = async function* (
          streamRequest: import('../../shared/hosted-ai-gateway-ipc').HostedAiStreamStartRequest
        ): AsyncIterable<HostedStreamEvent> {
          const queue: InternalHostedStreamQueue = {
            values: [],
            waiters: [],
            failure: null,
            terminal: false,
          };
          internalStreams.set(streamRequest.clientRequestId, queue);
          active.requestIds.add(streamRequest.clientRequestId);
          const started = await streamManager.start(event.sender.id, streamRequest);
          if (!started.ok) {
            internalStreams.delete(streamRequest.clientRequestId);
            active.requestIds.delete(streamRequest.clientRequestId);
            throw new ResponsesStepFailure(RESPONSES_STEP_FAILURE_BY_START_CODE[started.code]);
          }
          try {
            for (;;) {
              const buffered = queue.values.shift();
              if (buffered) {
                yield buffered;
                continue;
              }
              if (queue.failure) throw queue.failure;
              if (queue.terminal) return;
              const next = await new Promise<IteratorResult<HostedStreamEvent>>((resolve, reject) =>
                queue.waiters.push({ resolve, reject })
              );
              if (next.done) return;
              yield next.value;
            }
          } finally {
            streamManager.cancel(event.sender.id, streamRequest.clientRequestId);
            internalStreams.delete(streamRequest.clientRequestId);
            active.requestIds.delete(streamRequest.clientRequestId);
          }
        };

        const workflow = createHostedCodexGatewayWorkflow({
          identity: {
            workflowId: request.workflowId,
            runId: request.runId,
            turnId: request.turnId,
          },
          tier: request.tier,
          gatewayOrigin: gatewayUrl.origin,
          turnBindingToken,
          workspaceOpen: request.workspaceOpen,
          stagedReferenceIds: request.stagedReferenceIds,
          stream,
          callLocalTool: (localRequest) =>
            executeHostedCodexLocalTool(localRequest, {
              callNativeTool: async ({ toolName, input, actionId }) => {
                if (!input || typeof input !== 'object' || Array.isArray(input)) {
                  return {
                    ok: false,
                    code: 'invalid_request',
                    message: 'DNAForge AI returned invalid local tool arguments.',
                  };
                }
                try {
                  const result = await nativeToolBroker.execute(event.sender.id, {
                    turnBindingToken,
                    workflowId: request.workflowId,
                    runId: request.runId,
                    turnId: request.turnId,
                    operationId: actionId,
                    toolName,
                    input: input as Record<string, unknown>,
                    shellSupervision: 'destructive-only',
                    permissions,
                  });
                  return { ok: true, ...result };
                } catch (cause) {
                  return toHostedAiNativeToolFailure(cause);
                }
              },
              callRendererTool: ({ turnId, toolName, input, actionId }) =>
                bridge.callTool({ turnId, toolName, args: input, actionId }),
            }),
          requestUserApproval: async ({ toolName, effects, input, actionId }) => {
            const scope = await turnAuthority.authorizeScope(
              event.sender.id,
              turnBindingToken,
              request
            );
            if (supervision.skipConfirmations) return true;
            const owner = event.sender.isDestroyed()
              ? null
              : BrowserWindow.fromWebContents(event.sender);
            if (isHostedNativeToolName(toolName)) {
              if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
              const confirmationRequest = await nativeToolBroker.describeApproval(event.sender.id, {
                turnBindingToken,
                workflowId: request.workflowId,
                runId: request.runId,
                turnId: request.turnId,
                operationId: actionId,
                toolName,
                input: input as Record<string, unknown>,
                shellSupervision: 'destructive-only',
                permissions,
              });
              return approvalChoiceAllows(
                await confirmDestructiveFileWithRenderer(
                  owner,
                  confirmationRequest,
                  undefined,
                  active.approvalController.signal
                )
              );
            }
            const choice = await confirmDestructiveFileWithRenderer(
              owner,
              {
                conversationId: request.workflowId,
                toolName,
                operation: `Allow DNAForge AI to run ${toolName}`,
                operationMessage: userMessagePayload('approval.runTool', {
                  tool: userMessageValue(userToolLabel(toolName)),
                }),
                resolvedPath: scope.workspacePath ?? app.getPath('userData'),
                risk: effects.includes('mutating') ? 'mutating' : 'unknown',
                riskSummary: effects.includes('mutating')
                  ? 'This tool can change your DNAForge workspace.'
                  : 'This tool needs your approval before it can run.',
              },
              undefined,
              active.approvalController.signal
            );
            return approvalChoiceAllows(choice);
          },
          recordObservation: async (observation) => {
            const storedSession = await turnAuthority.authorize(
              event.sender.id,
              turnBindingToken,
              request
            );
            return client.recordToolObservation(observation, storedSession);
          },
          claimTool: async (claimRequest) => {
            const storedSession = await turnAuthority.authorize(
              event.sender.id,
              turnBindingToken,
              request
            );
            return client.claimTool(claimRequest, storedSession);
          },
          completeToolClaim: async (completion) => {
            const storedSession = await turnAuthority.authorize(
              event.sender.id,
              turnBindingToken,
              request
            );
            return client.completeToolClaim(completion, storedSession);
          },
          cancelToolClaim: async (cancellation) => {
            const storedSession = await turnAuthority.authorize(
              event.sender.id,
              turnBindingToken,
              request
            );
            return client.cancelToolClaim(cancellation, storedSession);
          },
        });
        active.workflow = workflow;
        const startedSession = await startHostedSession({
          binary,
          rootDir: app.getPath('userData'),
          runId: request.runId,
          model: 'gpt-5-codex',
          store: new AgentStateCapsuleStore(getDb()),
          step: workflow.step,
          developerInstructions: request.developerInstructions,
          priorConversationContext: request.priorConversationContext,
          allowEffects: ['read-only', 'ui-bound', 'mutating'],
          onTransportTrace: (trace) => transportTraces.push(trace),
          onRequestSizeTrace: (trace) => requestSizeTraces.push(trace),
        });
        session = startedSession;
        active.session = startedSession;
        const result = await runHostedTurnAfterStartupBarrier(
          startedSession,
          () => active.stopping,
          () =>
            startedSession.runTurn({
              message: request.userMessage,
              conversationId: request.workflowId,
              signal: active.approvalController.signal,
              requestUserInput: (question, signal) => {
                const owner = event.sender.isDestroyed()
                  ? null
                  : BrowserWindow.fromWebContents(event.sender);
                return requestAgentUserInputWithRenderer(owner, question, undefined, signal);
              },
              approve: workflow.approve,
              execute: async (tool, toolRequest) => {
                try {
                  const executed = await workflow.execute(tool, toolRequest);
                  const error = Boolean(
                    executed.output &&
                    typeof executed.output === 'object' &&
                    !Array.isArray(executed.output) &&
                    'error' in executed.output
                  );
                  completedTools.push({
                    toolName: tool.name,
                    effects: tool.effects,
                    isError: error,
                    failureCode: error ? boundedHostedToolFailureCode(executed.output) : undefined,
                    biologyMatchesFound:
                      !error &&
                      hostedBiologySearchReturnedMatches(
                        tool.name,
                        toolRequest.input,
                        executed.output
                      ),
                  });
                  emit({
                    kind: 'tool_completed',
                    toolCallId: toolRequest.callId,
                    toolName: tool.name,
                    input: toolRequest.input,
                    output: executed.output,
                    isError: error,
                  });
                  return executed;
                } catch (cause) {
                  completedTools.push({
                    toolName: tool.name,
                    effects: tool.effects,
                    isError: true,
                  });
                  emit({
                    kind: 'tool_completed',
                    toolCallId: toolRequest.callId,
                    toolName: tool.name,
                    input: toolRequest.input,
                    output: {
                      error:
                        cause instanceof Error
                          ? cause.message
                          : 'The DNAForge tool did not complete.',
                    },
                    isError: true,
                  });
                  throw cause;
                }
              },
              onTextDelta: (delta) => emit({ kind: 'text_delta', delta }),
            })
        );
        const provenance = workflow.provenance();
        const completionValidation =
          result.outcome === 'completed'
            ? validateHostedCodexCompletion({
                userMessage: request.userMessage,
                answer: result.text,
                tools: completedTools,
              })
            : ({ ok: true } as const);
        if (result.outcome === 'stopped') {
          const terminalization = await terminalizeStoppedHostedWorkflow({
            identity: {
              turnBindingToken,
              workflowId: request.workflowId,
              runId: request.runId,
              turnId: request.turnId,
            },
            provenance,
            cancel: async (terminalRequest) => {
              try {
                const storedSession = await turnAuthority.authorize(
                  event.sender.id,
                  turnBindingToken,
                  request
                );
                return client.cancelWorkflow(terminalRequest, storedSession);
              } catch {
                return {
                  ok: false,
                  code: 'signed_out',
                  message: 'The signed-in account changed before the stopped workflow closed.',
                };
              }
            },
          });
          if (terminalization.attempted && terminalization.result?.ok === false) {
            console.error(
              `[HostedCodex] Stopped workflow terminalization failed (${terminalization.result.code}).`
            );
          }
        }
        const artifact = {
          desktopSourceCommit: PACKAGED_SOURCE_COMMIT,
          appServerVersion: binary.version,
          appServerSha256: binary.sha256,
          appServerTarget: binary.triple,
        };
        const toolInventorySummary = readHostedToolInventorySummary(() =>
          startedSession.getToolInventorySummary?.()
        );
        await appendHostedCodexTurnJournal({
          userDataRoot: app.getPath('userData'),
          identity: {
            workflowId: request.workflowId,
            runId: request.runId,
            turnId: request.turnId,
          },
          gateway: provenance,
          artifact,
          transport: {
            responseStreams: transportTraces,
            requestSizes: requestSizeTraces,
            toolInventorySummary,
            childFailure: result.failure ?? null,
          },
          outcome: completionValidation.ok ? result.outcome : 'failed',
          answer: result.text,
        }).catch(() => {
          console.error('[HostedCodex] Turn journal write failed.');
        });
        if (!completionValidation.ok) {
          console.error('[HostedCodex] Completion grounding failed:', {
            code: completionValidation.code,
            missingToolNames: completionValidation.missingToolNames,
          });
          return {
            ok: false,
            code: 'turn_failed',
            ...visibleFailure(
              projectHostedCodexError('HOSTED_COMPLETION_UNGROUNDED', {
                technicalCode: completionValidation.code.toUpperCase(),
                stage: 'turn_finalization',
                retryable: true,
                referenceId: supportReference(request.turnId),
              })
            ),
          };
        }
        if (result.outcome !== 'completed' && result.outcome !== 'stopped') {
          if (result.outcome === 'outcome_unknown') {
            return {
              ok: false,
              code: 'turn_failed',
              ...visibleFailure(
                projectHostedCodexError('HOSTED_RECONCILIATION_REQUIRED', {
                  technicalCode: 'RECONCILIATION_REQUIRED',
                  stage: 'reconciliation',
                  retryable: false,
                  referenceId: supportReference(request.turnId),
                })
              ),
            };
          }
          const resultCode = hostedFailureResultCode(
            provenance.terminalError?.code ?? null,
            transportTraces,
            result.failure?.code ?? null,
            result.failure?.httpStatusCode ?? null,
            requestSizeTraces
          );
          return {
            ok: false,
            code: resultCode,
            ...projectTurnFailure({
              code: resultCode,
              turnId: request.turnId,
              failure: result.failure,
              provenance,
              transportTraces,
              requestSizeTraces,
            }),
          };
        }
        return {
          ok: true,
          outcome: result.outcome,
          text: result.text,
          gateway: provenance,
          artifact,
        };
      } catch (cause) {
        if (cause instanceof HostedCodexStreamFailure) {
          return {
            ok: false,
            code: cause.code,
            ...projectTurnFailure({ code: cause.code, turnId: request.turnId }),
          };
        }
        if (cause instanceof HostedCodexGatewayWorkflowError) {
          return {
            ok: false,
            code: 'tool_failed',
            ...projectTurnFailure({ code: 'tool_failed', turnId: request.turnId }),
          };
        }
        console.error('[HostedCodex] Fixed turn failed:', cause);
        return {
          ok: false,
          code: 'app_server_unavailable',
          ...projectTurnFailure({
            code: 'app_server_unavailable',
            turnId: request.turnId,
          }),
        };
      } finally {
        active.approvalController.abort();
        for (const requestId of active.requestIds) {
          const queue = internalStreams.get(requestId);
          if (queue) {
            failInternalHostedStream(
              queue,
              'gateway_unavailable',
              'The DNAForge AI turn ended before its gateway stream finished.'
            );
          }
          streamManager.cancel(event.sender.id, requestId);
          internalStreams.delete(requestId);
        }
        await session?.close().catch(() => undefined);
        await drainTurnBinding(event.sender.id, turnBindingToken, request).catch(
          (error: unknown) => {
            console.error('[hosted-native] completed turn cleanup is still pending', error);
          }
        );
        activeCodexTurns.delete(key);
      }
    },
    stopTurn: async (event, raw: unknown): Promise<HostedCodexTurnStopResult> => {
      const request = parseHostedCodexTurnStopRequest(raw);
      if (!request) return { ok: false };
      const active = activeCodexTurns.get(hostedCodexTurnKey(event.sender.id, request));
      if (!active) return { ok: false };
      active.stopping = true;
      active.approvalController.abort();

      active.session?.turn.stop();
      const provenance = active.workflow?.provenance();
      if (provenance?.workflowRunId && provenance.workflowStepId) {
        try {
          const storedSession = await turnAuthority.authorize(
            event.sender.id,
            active.turnBindingToken,
            request
          );
          const intent = await client.recordWorkflowStopIntent(
            {
              turnBindingToken: active.turnBindingToken,
              workflowId: request.workflowId,
              runId: request.runId,
              turnId: request.turnId,
              workflowRunId: provenance.workflowRunId,
              workflowStepId: provenance.workflowStepId,
            },
            storedSession
          );
          if (!intent.ok) {
            console.error(`[HostedCodex] Stop intent was not recorded (${intent.code}).`);
          }
        } catch {
          console.error('[HostedCodex] Stop intent authorization was unavailable.');
        }
      }
      for (const requestId of active.requestIds) {
        streamManager.cancel(event.sender.id, requestId);
        const queue = internalStreams.get(requestId);
        if (queue) {
          failInternalHostedStream(queue, 'gateway_unavailable', 'The user stopped this turn.');
        }
      }
      await active.session?.stop();
      return { ok: true };
    },
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_START_STREAM_CHANNEL, (event, request: unknown) => {
    registerOwner(event.sender);
    return streamManager.start(event.sender.id, request);
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_CANCEL_STREAM_CHANNEL, (event, clientRequestId: string) =>
    streamManager.cancel(event.sender.id, clientRequestId)
  );
  mainIpc.handle(HOSTED_AI_GATEWAY_EXECUTE_NATIVE_TOOL_CHANNEL, async (event, raw: unknown) => {
    registerOwner(event.sender);
    const request = parseHostedAiNativeToolRequest(raw);
    if (!request) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted local tool request was invalid.',
      };
    }
    try {
      const result = await nativeToolBroker.execute(event.sender.id, request);
      return { ok: true, ...result };
    } catch (error) {
      return toHostedAiNativeToolFailure(error);
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_CANCEL_NATIVE_TOOL_CHANNEL, (event, raw: unknown) => {
    const operationId = parseHostedAiNativeOperationId(raw);
    if (!operationId) return { ok: false };
    return nativeToolBroker.cancel(event.sender.id, operationId).then((ok) => ({ ok }));
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_VALIDATE_TURN_BINDING_CHANNEL, async (event, raw: unknown) => {
    const request = turnBindingRequest(raw);
    if (!request) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted turn binding was invalid.',
      };
    }
    try {
      await turnAuthority.authorize(event.sender.id, request.turnBindingToken, request);
      return { ok: true };
    } catch {
      return {
        ok: false,
        code: 'signed_out',
        message: 'The signed-in account changed during this DNAForge AI turn.',
      };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_RELEASE_TURN_BINDING_CHANNEL, async (event, raw: unknown) => {
    const request = turnBindingRequest(raw);
    if (!request) return { ok: false };
    try {
      await drainTurnBinding(event.sender.id, request.turnBindingToken, request);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_RECORD_TOOL_OBSERVATION_CHANNEL, async (event, raw: unknown) => {
    const request = toolObservationRequest(raw);
    if (!request) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted tool observation was invalid.',
      };
    }
    try {
      const session = await turnAuthority.authorize(
        event.sender.id,
        request.turnBindingToken,
        request
      );
      return client.recordToolObservation(request, session);
    } catch {
      return {
        ok: false,
        code: 'signed_out',
        message: 'The signed-in account changed during this DNAForge AI turn.',
      };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_CLAIM_TOOL_CHANNEL, async (event, raw: unknown) => {
    const request = toolClaimRequest(raw);
    if (!request)
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted mutation claim was invalid.',
      };
    try {
      const session = await turnAuthority.authorize(
        event.sender.id,
        request.turnBindingToken,
        request
      );
      return client.claimTool(request, session);
    } catch {
      return {
        ok: false,
        code: 'signed_out',
        message: 'The signed-in account changed during this DNAForge AI turn.',
      };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_COMPLETE_TOOL_CLAIM_CHANNEL, async (event, raw: unknown) => {
    const request = toolClaimCompleteRequest(raw);
    if (!request)
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted mutation completion was invalid.',
      };
    try {
      const session = await turnAuthority.authorize(
        event.sender.id,
        request.turnBindingToken,
        request
      );
      return client.completeToolClaim(request, session);
    } catch {
      return {
        ok: false,
        code: 'signed_out',
        message: 'The signed-in account changed during this DNAForge AI turn.',
      };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_CANCEL_TOOL_CLAIM_CHANNEL, async (event, raw: unknown) => {
    const request = toolClaimCancelRequest(raw);
    if (!request)
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted mutation cancellation was invalid.',
      };
    try {
      const session = await turnAuthority.authorize(
        event.sender.id,
        request.turnBindingToken,
        request
      );
      return client.cancelToolClaim(request, session);
    } catch {
      return {
        ok: false,
        code: 'signed_out',
        message: 'The signed-in account changed during this DNAForge AI turn.',
      };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_CANCEL_WORKFLOW_CHANNEL, async (event, raw: unknown) => {
    const request = workflowTerminalRequest(raw);
    if (!request) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted workflow terminal request was invalid.',
      };
    }
    try {
      const session = await turnAuthority.authorize(
        event.sender.id,
        request.turnBindingToken,
        request
      );
      return client.cancelWorkflow(request, session);
    } catch {
      return {
        ok: false,
        code: 'signed_out',
        message: 'The signed-in account changed during this DNAForge AI turn.',
      };
    }
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_GET_WORKFLOW_AUTHORITY_CHANNEL, () =>
    client.getWorkflowAuthority()
  );
  handleGroup(hostedAllowanceContract, {
    readIncludedAllowance: () => client.readIncludedAllowance(),
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_GET_ROUTE_AVAILABILITY_CHANNEL, async () => {
    const result = await client.getRouteAvailability();
    await appendHostedCodexRouteAvailabilityJournal({
      userDataRoot: app.getPath('userData'),
      result,
    }).catch(() => console.error('[HostedCodex] Route availability journal write failed.'));
    return result;
  });
  mainIpc.handle(HOSTED_AI_GATEWAY_REQUEST_RAW_TRACE_DELETION_CHANNEL, () =>
    client.requestRawTraceDeletion()
  );

  unsubscribeHostedAuth?.();
  unsubscribeHostedAuth = subscribeAuthState((state) => {
    const session = state.status === 'signed-in' ? state.session : null;
    revokeTokens(
      turnAuthority.revokeExcept(session),
      'The signed-in account changed during this DNAForge AI turn.'
    );
  });
  shutdownHostedAiGatewayRef = async () => {
    unsubscribeHostedAuth?.();
    unsubscribeHostedAuth = null;
    for (const token of turnAuthority.revokeExcept(null)) {
      streamManager.cancelTurnBinding(token, 'DNAForge is closing this Hosted AI turn.');
    }
    for (const active of activeCodexTurns.values()) {
      active.stopping = true;
      await active.session?.stop().catch(() => undefined);
    }
    await nativeToolBroker.shutdown();
    activeCodexTurns.clear();
    pendingCodexBindings.clear();
    owners.clear();
  };
}
