import { withUserMessage } from '@waypoint/user-messages';
import { app } from 'electron';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import { classifyReleaseBHostedAuthority } from './release-stamp';
import { contributionRefusalFromBody } from './hosted-contribution-error';
import { readHostedIncludedAllowance } from './hosted-included-allowance';
import type { IncludedAllowanceReadResult } from '@waypoint/hosted-ai-contract/included-allowance';
import {
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  parseContributionPolicy,
  parseContributionReceipt,
  type ContributionPolicy,
  type ContributionReceipt,
} from '@waypoint/hosted-ai-contract';
import type {
  HostedAiAgentModelStepRequest,
  HostedAiAgentModelStepResult,
  HostedAiAgentToolObservationRequest,
  HostedAiAgentToolObservationResult,
  HostedAiAgentToolTicket,
  HostedAiAgentWorkflowFinalizationRequest,
  HostedAiAgentWorkflowFinalizationResult,
  HostedAiGenerationRequest,
  HostedAiGenerationResult,
  HostedAiRawTraceDeletionReceipt,
  HostedAiRawTraceDeletionResult,
  HostedAiRouteAvailabilityResult,
  HostedAiRouteUnavailableReason,
  HostedAiWorkflowAuthority,
  HostedAiWorkflowAuthorityResult,
  HostedAiWorkflowTraceStep,
  HostedAiToolObservationRequest,
  HostedAiToolObservationResult,
  HostedAiToolClaimRequest,
  HostedAiToolClaimCompleteRequest,
  HostedAiToolClaimCancelRequest,
  HostedAiToolClaimResult,
  HostedAiWorkflowTerminalRequest,
  HostedAiWorkflowTerminalResult,
  HostedAiWorkflowStopIntentResult,
  ResearchContributionNotice,
} from '../shared/hosted-ai-gateway-ipc';

export const HOSTED_AI_GATEWAY_URL_ENV = 'DNAFORGE_HOSTED_AI_GATEWAY_URL';
const STOP_INTENT_TIMEOUT_MS = 2_000;
const NOTICE_TEXT =
  'DNAForge AI is offered in accordance with our Terms of Service and Privacy Policy.' as const;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function fetchWithoutRedirect(
  fetchImpl: FetchLike,
  input: string | URL | Request,
  init: RequestInit
): Promise<Response> {
  return fetchImpl(input, { ...init, redirect: 'manual' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function boundedToolTicket(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

function validPendingTicketCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function validRequest(value: unknown): value is HostedAiGenerationRequest {
  if (!isRecord(value)) return false;
  return (
    boundedIdentifier(value.workflowId) &&
    boundedIdentifier(value.runId) &&
    boundedIdentifier(value.turnId) &&
    boundedIdentifier(value.requestId) &&
    boundedIdentifier(value.idempotencyKey) &&
    (value.tier === 'auto' || value.tier === 'deep') &&
    typeof value.input === 'string' &&
    value.input.trim().length > 0 &&
    Buffer.byteLength(value.input, 'utf8') <= MAX_HOSTED_WHOLE_REQUEST_BYTES &&
    typeof value.maxOutputTokens === 'number' &&
    Number.isInteger(value.maxOutputTokens) &&
    isRecord(value.tracePayload) &&
    (value.routePinScope === undefined ||
      value.routePinScope === 'turn' ||
      value.routePinScope === 'workflow')
  );
}

function validAgentModelStepRequest(value: unknown): value is HostedAiAgentModelStepRequest {
  if (!isRecord(value)) return false;
  const candidate: Record<string, unknown> = value;
  if (!validRequest(value)) return false;
  const stepSequence = candidate.agentStepSequence;
  return (
    typeof stepSequence === 'number' &&
    Number.isSafeInteger(stepSequence) &&
    stepSequence >= 0 &&
    stepSequence <= 1_024 &&
    (candidate.agentWorkflowRunId === undefined || uuid(candidate.agentWorkflowRunId))
  );
}

function validAgentWorkflowFinalizationRequest(
  value: unknown
): value is HostedAiAgentWorkflowFinalizationRequest {
  if (!isRecord(value)) return false;
  return (
    uuid(value.workflowRunId) &&
    uuid(value.workflowStepId) &&
    typeof value.terminalOutput === 'string' &&
    value.terminalOutput.trim().length > 0 &&
    Buffer.byteLength(value.terminalOutput, 'utf8') <= MAX_HOSTED_WHOLE_REQUEST_BYTES
  );
}

function validAgentToolObservationRequest(
  value: unknown
): value is HostedAiAgentToolObservationRequest {
  if (!isRecord(value)) return false;
  return (
    boundedIdentifier(value.ticket) &&
    value.ticket.length <= 4096 &&
    isRecord(value.argumentsPayload) &&
    isRecord(value.observationPayload)
  );
}

function validToolObservationRequest(value: unknown): value is HostedAiToolObservationRequest {
  if (!isRecord(value)) return false;
  return (
    boundedToolTicket(value.ticket) &&
    (value.claimId === undefined || uuid(value.claimId)) &&
    isRecord(value.argumentsPayload) &&
    isRecord(value.observationPayload)
  );
}

function validToolClaimRequest(value: unknown): value is HostedAiToolClaimRequest {
  return (
    isRecord(value) &&
    boundedToolTicket(value.ticket) &&
    boundedIdentifier(value.approvalReceiptRef) &&
    boundedIdentifier(value.idempotencyKey)
  );
}

function validToolClaimCompleteRequest(value: unknown): value is HostedAiToolClaimCompleteRequest {
  return (
    isRecord(value) &&
    uuid(value.claimId) &&
    boundedIdentifier(value.idempotencyKey) &&
    boundedIdentifier(value.effectReceiptRef)
  );
}

function validToolClaimCancelRequest(value: unknown): value is HostedAiToolClaimCancelRequest {
  return (
    isRecord(value) &&
    uuid(value.claimId) &&
    boundedIdentifier(value.idempotencyKey) &&
    (value.reason === 'stopped_before_effect' ||
      value.reason === 'user_declined_before_effect' ||
      value.reason === 'pre_effect_failure')
  );
}

function parseToolClaim(payload: unknown): HostedAiToolClaimResult {
  if (
    !isRecord(payload) ||
    !uuid(payload.claim_id) ||
    (payload.status !== 'claimed' &&
      payload.status !== 'completed' &&
      payload.status !== 'canceled' &&
      payload.status !== 'expired') ||
    !uuid(payload.tool_ticket_id) ||
    !boundedIdentifier(payload.tool_name) ||
    typeof payload.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(payload.expires_at)) ||
    typeof payload.version !== 'number' ||
    !Number.isSafeInteger(payload.version) ||
    typeof payload.already_applied !== 'boolean'
  ) {
    return {
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI returned an invalid mutation claim.',
    };
  }
  return {
    ok: true,
    claim: {
      claimId: payload.claim_id,
      status: payload.status,
      toolTicketId: payload.tool_ticket_id,
      toolName: payload.tool_name,
      expiresAt: payload.expires_at,
      version: payload.version,
      alreadyApplied: payload.already_applied,
    },
  };
}

function validWorkflowTerminalRequest(value: unknown): value is HostedAiWorkflowTerminalRequest {
  if (!isRecord(value)) return false;
  return (
    boundedIdentifier(value.turnBindingToken) &&
    boundedIdentifier(value.workflowId) &&
    boundedIdentifier(value.runId) &&
    boundedIdentifier(value.turnId) &&
    uuid(value.workflowRunId) &&
    uuid(value.workflowStepId)
  );
}

function safeToolTickets(value: unknown): readonly HostedAiAgentToolTicket[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const tickets: HostedAiAgentToolTicket[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !boundedToolTicket(item.token) ||
      !boundedIdentifier(item.providerCallId ?? item.provider_call_id) ||
      !boundedIdentifier(item.toolName ?? item.tool_name) ||
      !isRecord(item.argumentsPayload ?? item.arguments_payload) ||
      (typeof item.requiresUserApproval !== 'boolean' &&
        typeof item.requires_user_approval !== 'boolean') ||
      (typeof item.expiresAt !== 'string' && typeof item.expires_at !== 'string')
    )
      return null;
    const expiresAt = item.expiresAt ?? item.expires_at;
    if (typeof expiresAt !== 'string' || !Number.isFinite(new Date(expiresAt).valueOf()))
      return null;
    tickets.push({
      token: item.token,
      expiresAt: new Date(expiresAt).toISOString(),
      providerCallId: (item.providerCallId ?? item.provider_call_id) as string,
      toolName: (item.toolName ?? item.tool_name) as string,
      argumentsPayload: (item.argumentsPayload ?? item.arguments_payload) as Record<
        string,
        unknown
      >,
      requiresUserApproval: (item.requiresUserApproval ?? item.requires_user_approval) as boolean,
    });
  }
  return tickets;
}

function bakedHostedAiGatewayUrl(): string {
  return typeof __DNAFORGE_HOSTED_AI_GATEWAY_URL__ === 'string'
    ? __DNAFORGE_HOSTED_AI_GATEWAY_URL__.trim()
    : '';
}

function bakedReleaseBHostedStamp(): string {
  return typeof __DNAFORGE_RELEASE_B_HOSTED__ === 'string' ? __DNAFORGE_RELEASE_B_HOSTED__ : '';
}

function hostedAiGatewayBuildMarker(): string {
  return typeof __DNAFORGE_HOSTED_AI_GATEWAY_MARKER__ === 'string'
    ? __DNAFORGE_HOSTED_AI_GATEWAY_MARKER__
    : '';
}

function hostedAiReleaseABuildMarker(): string {
  return typeof __DNAFORGE_HOSTED_AI_RELEASE_A_MARKER__ === 'string'
    ? __DNAFORGE_HOSTED_AI_RELEASE_A_MARKER__
    : '';
}

export function resolveHostedAiGatewayUrl(env: NodeJS.ProcessEnv = process.env): URL | null {
  const bakedGatewayUrl = bakedHostedAiGatewayUrl();
  const gatewayMarker = hostedAiGatewayBuildMarker();
  const releaseMarker = hostedAiReleaseABuildMarker();
  const baked = classifyReleaseBHostedAuthority(bakedReleaseBHostedStamp(), bakedGatewayUrl);
  if (app.isPackaged) {
    if (
      !baked.enabled ||
      !releaseMarker.endsWith(':enabled') ||
      !gatewayMarker.endsWith(':configured')
    ) {
      return null;
    }
    return new URL(baked.gatewayOrigin);
  }
  if (releaseMarker.endsWith(':disabled')) return null;
  if (gatewayMarker && gatewayMarker.endsWith(bakedGatewayUrl ? ':empty' : ':configured')) {
    return null;
  }
  const raw =
    env[HOSTED_AI_GATEWAY_URL_ENV]?.trim() ||
    (baked.enabled ? baked.gatewayOrigin : bakedGatewayUrl);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isLoopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && env.WAYPOINT_TEST === '1' && isLoopback)
  ) {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  return url;
}

function safeNotice(value: unknown): ResearchContributionNotice | null {
  if (!isRecord(value) || value.show_notice !== true || value.notice_text !== NOTICE_TEXT)
    return null;
  if (typeof value.terms_url !== 'string' || typeof value.privacy_url !== 'string') return null;
  try {
    const terms = new URL(value.terms_url);
    const privacy = new URL(value.privacy_url);
    if (terms.protocol !== 'https:' || privacy.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return {
    showNotice: true,
    noticeText: NOTICE_TEXT,
    termsUrl: value.terms_url,
    privacyUrl: value.privacy_url,
  };
}

function gatewayErrorCode(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.error === 'string' ? payload.error : null;
}

function hostedRouteUnavailableReason(value: unknown): value is HostedAiRouteUnavailableReason {
  return (
    value === 'gateway_paused' ||
    value === 'account_not_enabled' ||
    value === 'sign_in_required' ||
    value === 'workflow_unavailable' ||
    value === 'provider_unavailable' ||
    value === 'gateway_not_ready'
  );
}

async function safeRouteAvailabilityError(
  response: Response,
  gatewayOrigin: string
): Promise<HostedAiRouteAvailabilityResult> {
  if (response.status === 401) {
    return {
      ok: false,
      code: 'signed_out',
      message: 'Sign in to use DNAForge AI.',
      gatewayOrigin,
    };
  }
  return {
    ok: false,
    code: 'gateway_unavailable',
    message: `The Hosted AI gateway rejected the availability check with HTTP ${response.status}.`,
    gatewayOrigin,
  };
}

function retryAfterSeconds(response: Response): number {
  const DEFAULT_SECONDS = 60;
  const raw = response.headers.get('retry-after');
  if (!raw) return DEFAULT_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SECONDS;
  return Math.min(parsed, 300);
}

async function safeGatewayError(
  response: Response
): Promise<Extract<HostedAiGenerationResult, { ok: false }>> {
  const status = response.status;
  if (status === 401)
    return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
  if (status === 400)
    return {
      ok: false,
      code: 'invalid_request',
      message: 'The AI workflow request was invalid. Please try again.',
    };
  if (status === 409) {
    const code = gatewayErrorCode(await response.json().catch(() => null));
    if (code === 'allowance_exhausted') {
      return {
        ok: false,
        code: 'allowance_exhausted',
        message:
          'Your DNAForge AI allowance is exhausted. Choose a local or Bring Your Own Key route to continue.',
      };
    }
    if (code === 'hosted_request_rate_limited') {
      const retry = retryAfterSeconds(response);
      return {
        ok: false,
        code: 'rate_limited',
        message: `DNAForge AI is rate limited right now. Try again in about ${retry} second${retry === 1 ? '' : 's'}.`,
        retryAfterSeconds: retry,
      };
    }
    return {
      ok: false,
      code: 'allowance_or_policy_rejected',
      message: 'DNAForge AI cannot run this workflow right now.',
    };
  }
  if (status === 503) {
    const code = gatewayErrorCode(await response.json().catch(() => null));
    if (code === 'gateway_paused') {
      return {
        ok: false,
        code: 'gateway_paused',
        message: 'DNAForge AI is not enabled in this environment.',
      };
    }
    return {
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI is temporarily unavailable.',
    };
  }
  return {
    ok: false,
    code: 'gateway_unavailable',
    message: 'DNAForge AI is temporarily unavailable.',
  };
}

function safeWorkflowTrace(value: unknown): HostedAiWorkflowTraceStep | null {
  if (!isRecord(value) || !uuid(value.workflow_run_id) || !uuid(value.workflow_step_id))
    return null;
  return { workflowRunId: value.workflow_run_id, workflowStepId: value.workflow_step_id };
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function safeWorkflowAuthority(value: unknown): HostedAiWorkflowAuthority | null {
  if (!isRecord(value)) return null;
  const setting = value.account_plan_setting;
  if (
    (setting !== 'never_corpus' &&
      setting !== 'private_ai' &&
      setting !== 'research_contribution') ||
    typeof value.research_contribution_eligible !== 'boolean' ||
    typeof value.show_research_contribution_notice !== 'boolean' ||
    !httpsUrl(value.terms_url) ||
    !httpsUrl(value.privacy_url)
  ) {
    return null;
  }
  return {
    accountPlanSetting: setting,
    researchContributionEligible: value.research_contribution_eligible,
    showResearchContributionNotice: value.show_research_contribution_notice,
    termsUrl: value.terms_url,
    privacyUrl: value.privacy_url,
  };
}

function safeDeletionReceipt(
  value: unknown,
  expectedDesktopSessionId: string
): HostedAiRawTraceDeletionReceipt | null {
  if (
    !isRecord(value) ||
    !uuid(value.deletion_request_id) ||
    !uuid(value.verified_desktop_session_id) ||
    typeof value.requested_at !== 'string' ||
    typeof value.delete_by !== 'string' ||
    typeof value.idempotent !== 'boolean'
  )
    return null;
  if (!value.idempotent && value.verified_desktop_session_id !== expectedDesktopSessionId)
    return null;
  const requestedAt = new Date(value.requested_at);
  const deleteBy = new Date(value.delete_by);
  if (!Number.isFinite(requestedAt.valueOf()) || !Number.isFinite(deleteBy.valueOf())) return null;
  return {
    deletionRequestId: value.deletion_request_id,
    desktopSessionId: value.verified_desktop_session_id,
    requestedAt: requestedAt.toISOString(),
    deleteBy: deleteBy.toISOString(),
    idempotent: value.idempotent,
  };
}

export class HostedAiGatewayClient {
  constructor(
    private readonly deps: {
      readonly resolveUrl?: () => URL | null;
      readonly getSession?: () => Promise<StoredSession | null>;
      readonly fetch?: FetchLike;
    } = {}
  ) {}

  async getContributionPolicy(expectedSession?: {
    readonly accountId: string;
    readonly desktopSessionId: string;
  }): Promise<ContributionPolicy> {
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) throw new Error('DNAForge AI is not configured in this build.');
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) throw new Error('Sign in to use DNAForge AI.');
    if (
      expectedSession &&
      (session.accountId !== expectedSession.accountId ||
        session.desktopSessionId !== expectedSession.desktopSessionId)
    ) {
      throw new Error('The signed-in account changed before the contribution request.');
    }
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/contribution-policy', gateway),
        { headers: { authorization: `Bearer ${session.accessToken}` } }
      );
    } catch {
      throw withUserMessage(
        new Error('DNAForge AI could not load the current contribution policy.'),
        'guidance.dnaforge-ai-could-not-load-the-current-contribution-policy'
      );
    }
    if (!response.ok) {
      const failure = await safeGatewayError(response);
      throw new Error(failure.message);
    }
    const policy = parseContributionPolicy(await response.json().catch(() => null));
    if (!policy) throw new Error('DNAForge AI returned an invalid contribution policy.');
    return policy;
  }

  async recordContributionChoice(
    expectedSession: { readonly accountId: string; readonly desktopSessionId: string } | undefined,
    choice: 'joined' | 'withdrawn',
    idempotencyKey: string,
    challenge: {
      readonly terms_version_id: string;
      readonly terms_content_sha256: string;
      readonly privacy_version_id: string;
      readonly privacy_content_sha256: string;
      readonly contribution_policy_generation: string;
    }
  ): Promise<ContributionReceipt> {
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) throw new Error('DNAForge AI is not configured in this build.');
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) throw new Error('Sign in to use DNAForge AI.');
    if (
      expectedSession &&
      (session.accountId !== expectedSession.accountId ||
        session.desktopSessionId !== expectedSession.desktopSessionId)
    ) {
      throw new Error('The signed-in account changed before the contribution request.');
    }
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/contribution-policy', gateway),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ choice, idempotency_key: idempotencyKey, challenge }),
        }
      );
    } catch {
      throw new Error('DNAForge AI could not record the current contribution choice.');
    }
    if (response.status === 409) {
      throw contributionRefusalFromBody(await response.json().catch(() => null));
    }
    if (!response.ok) {
      const failure = await safeGatewayError(response);
      throw new Error(failure.message);
    }
    const receipt = parseContributionReceipt(await response.json().catch(() => null));
    if (!receipt || receipt.receipt_choice !== choice) {
      throw new Error('DNAForge AI returned an invalid contribution receipt.');
    }
    return receipt;
  }

  async agentModelStep(rawRequest: unknown): Promise<HostedAiAgentModelStepResult> {
    if (!validAgentModelStepRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The AI workflow request was invalid. Please try again.',
      };
    }
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) {
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    }
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };

    const body = JSON.stringify({
      workflow_id: rawRequest.workflowId,
      run_id: rawRequest.runId,
      turn_id: rawRequest.turnId,
      request_id: rawRequest.requestId,
      idempotency_key: rawRequest.idempotencyKey,
      tier: rawRequest.tier,
      input: rawRequest.input,
      max_output_tokens: rawRequest.maxOutputTokens,
      trace_payload: rawRequest.tracePayload,
      agent_step_sequence: rawRequest.agentStepSequence,
      ...(rawRequest.agentWorkflowRunId
        ? { agent_workflow_run_id: rawRequest.agentWorkflowRunId }
        : {}),
      ...(rawRequest.routePinScope ? { route_pin_scope: rawRequest.routePinScope } : {}),
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_HOSTED_WHOLE_REQUEST_BYTES) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The AI workflow request was too large.',
      };
    }

    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/agent/model-step', gateway),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body,
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !('providerResponse' in payload)) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid response.',
      };
    }
    const rawTrace =
      payload.workflowTrace !== undefined ? payload.workflowTrace : payload.workflow_trace;
    const trace = rawTrace === null ? null : safeWorkflowTrace(rawTrace);
    if (rawTrace !== null && !trace) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid workflow trace.',
      };
    }
    const toolTickets = safeToolTickets(payload.toolTickets ?? payload.tool_tickets);
    if (!toolTickets) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned invalid tool authorization.',
      };
    }
    return {
      ok: true,
      providerResponse: payload.providerResponse,
      workflowTrace: trace,
      toolTickets,
      researchContributionNotice: safeNotice(payload.researchContributionNotice),
    };
  }

  async submitAgentToolObservation(
    rawRequest: unknown
  ): Promise<HostedAiAgentToolObservationResult> {
    if (!validAgentToolObservationRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The AI tool result was invalid. Please try again.',
      };
    }
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway)
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
    const body = JSON.stringify({
      tool_ticket: rawRequest.ticket,
      arguments: rawRequest.argumentsPayload,
      observation: rawRequest.observationPayload,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_HOSTED_WHOLE_REQUEST_BYTES) {
      return { ok: false, code: 'invalid_request', message: 'The AI tool result was too large.' };
    }
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/agent/tool-observation', gateway),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body,
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload)) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid response.',
      };
    }
    if (payload.pendingToolObservations === true || payload.pending_tool_observations === true) {
      const trace = safeWorkflowTrace({
        workflow_run_id: payload.workflowRunId ?? payload.workflow_run_id,
        workflow_step_id: payload.workflowStepId ?? payload.workflow_step_id,
      });
      const pendingTicketCount = payload.pendingTicketCount ?? payload.pending_ticket_count;
      if (!trace || !validPendingTicketCount(pendingTicketCount)) {
        return {
          ok: false,
          code: 'gateway_unavailable',
          message: 'DNAForge AI returned invalid pending tool state.',
        };
      }
      return { ok: true, pendingToolObservations: true, workflowTrace: trace, pendingTicketCount };
    }
    if (!('providerResponse' in payload)) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid response.',
      };
    }
    const rawTrace =
      payload.workflowTrace !== undefined ? payload.workflowTrace : payload.workflow_trace;
    const trace = rawTrace === null ? null : safeWorkflowTrace(rawTrace);
    if (rawTrace !== null && !trace) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid workflow trace.',
      };
    }
    const toolTickets = safeToolTickets(payload.toolTickets ?? payload.tool_tickets);
    if (!toolTickets)
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned invalid tool authorization.',
      };
    return {
      ok: true,
      providerResponse: payload.providerResponse,
      workflowTrace: trace,
      toolTickets,
      researchContributionNotice: safeNotice(payload.researchContributionNotice),
    };
  }

  async recordToolObservation(
    rawRequest: unknown,
    session: StoredSession
  ): Promise<HostedAiToolObservationResult> {
    if (!validToolObservationRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The AI tool result was invalid. Please try again.',
      };
    }
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) {
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    }
    const body = JSON.stringify({
      tool_ticket: rawRequest.ticket,
      ...(rawRequest.claimId ? { claim_id: rawRequest.claimId } : {}),
      arguments: rawRequest.argumentsPayload,
      observation: rawRequest.observationPayload,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_HOSTED_WHOLE_REQUEST_BYTES) {
      return { ok: false, code: 'invalid_request', message: 'The AI tool result was too large.' };
    }
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchWithoutRedirect(
          this.deps.fetch ?? globalThis.fetch,
          new URL('/v1/hosted/tool-observation', gateway),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${session.accessToken}`,
              'content-type': 'application/json',
            },
            body,
          }
        );
        break;
      } catch {}
    }
    if (!response) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    const payload: unknown = await response.json().catch(() => null);
    if (
      !isRecord(payload) ||
      !uuid(payload.ticket_id) ||
      !uuid(payload.workflow_run_id) ||
      !uuid(payload.workflow_step_id) ||
      !boundedIdentifier(payload.provider_call_id) ||
      !boundedIdentifier(payload.tool_name)
    ) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid tool receipt.',
      };
    }
    return {
      ok: true,
      receipt: {
        ticketId: payload.ticket_id,
        workflowRunId: payload.workflow_run_id,
        workflowStepId: payload.workflow_step_id,
        providerCallId: payload.provider_call_id,
        toolName: payload.tool_name,
      },
    };
  }

  async claimTool(rawRequest: unknown, session: StoredSession): Promise<HostedAiToolClaimResult> {
    if (!validToolClaimRequest(rawRequest)) {
      return { ok: false, code: 'invalid_request', message: 'The mutation claim was invalid.' };
    }
    return this.sendToolClaim(
      '/v1/hosted/tool-claim',
      {
        tool_ticket: rawRequest.ticket,
        approval_receipt_ref: rawRequest.approvalReceiptRef,
        idempotency_key: rawRequest.idempotencyKey,
      },
      session
    );
  }

  async completeToolClaim(
    rawRequest: unknown,
    session: StoredSession
  ): Promise<HostedAiToolClaimResult> {
    if (!validToolClaimCompleteRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The mutation completion was invalid.',
      };
    }
    return this.sendToolClaim(
      '/v1/hosted/tool-claim/complete',
      {
        claim_id: rawRequest.claimId,
        idempotency_key: rawRequest.idempotencyKey,
        effect_receipt_ref: rawRequest.effectReceiptRef,
      },
      session
    );
  }

  async cancelToolClaim(
    rawRequest: unknown,
    session: StoredSession
  ): Promise<HostedAiToolClaimResult> {
    if (!validToolClaimCancelRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The mutation cancellation was invalid.',
      };
    }
    return this.sendToolClaim(
      '/v1/hosted/tool-claim/cancel',
      {
        claim_id: rawRequest.claimId,
        idempotency_key: rawRequest.idempotencyKey,
        reason: rawRequest.reason,
      },
      session
    );
  }

  private async sendToolClaim(
    path: string,
    payload: Record<string, unknown>,
    session: StoredSession
  ): Promise<HostedAiToolClaimResult> {
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) {
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    }
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL(path, gateway),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body,
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI mutation authority is temporarily unavailable.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    return parseToolClaim(await response.json().catch(() => null));
  }

  async recordWorkflowStopIntent(
    rawRequest: unknown,
    session: StoredSession
  ): Promise<HostedAiWorkflowStopIntentResult> {
    if (!validWorkflowTerminalRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted workflow Stop intent was invalid.',
      };
    }
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) {
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    }
    const body = JSON.stringify({
      workflow_run_id: rawRequest.workflowRunId,
      workflow_step_id: rawRequest.workflowStepId,
      client_workflow_id: rawRequest.workflowId,
      client_run_id: rawRequest.runId,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STOP_INTENT_TIMEOUT_MS);
    try {
      const response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/workflow-stop-intent', gateway),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        }
      );
      if (!response.ok) return await safeGatewayError(response);
      const payload: unknown = await response.json().catch(() => null);
      if (
        !isRecord(payload) ||
        payload.workflow_run_id !== rawRequest.workflowRunId ||
        payload.workflow_step_id !== rawRequest.workflowStepId ||
        typeof payload.idempotent !== 'boolean'
      ) {
        return {
          ok: false,
          code: 'gateway_unavailable',
          message: 'DNAForge AI returned an invalid Stop intent receipt.',
        };
      }
      return {
        ok: true,
        receipt: {
          workflowRunId: payload.workflow_run_id,
          workflowStepId: payload.workflow_step_id,
          idempotent: payload.idempotent,
        },
      };
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI could not record the Stop intent.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async cancelWorkflow(
    rawRequest: unknown,
    session: StoredSession
  ): Promise<HostedAiWorkflowTerminalResult> {
    if (!validWorkflowTerminalRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The Hosted workflow terminal request was invalid.',
      };
    }
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway) {
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    }
    const body = JSON.stringify({
      workflow_run_id: rawRequest.workflowRunId,
      workflow_step_id: rawRequest.workflowStepId,
      client_workflow_id: rawRequest.workflowId,
      client_run_id: rawRequest.runId,
    });
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchWithoutRedirect(
          this.deps.fetch ?? globalThis.fetch,
          new URL('/v1/hosted/workflow-terminal', gateway),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${session.accessToken}`,
              'content-type': 'application/json',
            },
            body,
          }
        );
        break;
      } catch {}
    }
    if (!response) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI could not close the stopped workflow.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    const payload: unknown = await response.json().catch(() => null);
    if (
      !isRecord(payload) ||
      payload.workflow_run_id !== rawRequest.workflowRunId ||
      payload.workflow_step_id !== rawRequest.workflowStepId ||
      !uuid(payload.canary_lease_id) ||
      payload.final_status !== 'cancelled' ||
      typeof payload.idempotent !== 'boolean'
    ) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid workflow terminal receipt.',
      };
    }
    return {
      ok: true,
      receipt: {
        workflowRunId: payload.workflow_run_id,
        workflowStepId: payload.workflow_step_id,
        canaryLeaseId: payload.canary_lease_id,
        finalStatus: 'cancelled',
        idempotent: payload.idempotent,
      },
    };
  }

  async finalizeAgentWorkflow(
    rawRequest: unknown
  ): Promise<HostedAiAgentWorkflowFinalizationResult> {
    if (!validAgentWorkflowFinalizationRequest(rawRequest)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'The AI workflow request was invalid. Please try again.',
      };
    }
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway)
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/agent/finalize', gateway),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            agent_workflow_run_id: rawRequest.workflowRunId,
            agent_workflow_step_id: rawRequest.workflowStepId,
            terminal_output: rawRequest.terminalOutput,
          }),
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    return { ok: true };
  }

  async getWorkflowAuthority(): Promise<HostedAiWorkflowAuthorityResult> {
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway)
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/workflow-authority', gateway),
        {
          headers: { authorization: `Bearer ${session.accessToken}` },
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
      };
    }
    if (!response.ok) return safeGatewayError(response);
    const authority = safeWorkflowAuthority(await response.json().catch(() => null));
    if (!authority) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned invalid account authority.',
      };
    }
    return { ok: true, authority };
  }

  async getRouteAvailability(): Promise<HostedAiRouteAvailabilityResult> {
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway)
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
        gatewayOrigin: null,
      };
    const gatewayOrigin = gateway.origin;
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session)
      return {
        ok: false,
        code: 'signed_out',
        message: 'Sign in to use DNAForge AI.',
        gatewayOrigin,
      };
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/route-availability', gateway),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${session.accessToken}` },
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: `The Hosted AI gateway at ${gatewayOrigin} could not be reached.`,
        gatewayOrigin,
      };
    }
    if (!response.ok) return safeRouteAvailabilityError(response, gatewayOrigin);
    const payload: unknown = await response.json().catch(() => null);
    if (isRecord(payload)) {
      if (payload.available === true) return { ok: true, available: true, gatewayOrigin };
      if (payload.available === false && payload.reason === undefined) {
        return { ok: true, available: false, reason: 'gateway_not_ready', gatewayOrigin };
      }
      if (payload.available === false && hostedRouteUnavailableReason(payload.reason)) {
        return { ok: true, available: false, reason: payload.reason, gatewayOrigin };
      }
    }
    return {
      ok: false,
      code: 'invalid_response',
      message: 'The Hosted AI gateway returned an invalid availability response.',
      gatewayOrigin,
    };
  }

  readIncludedAllowance(): Promise<IncludedAllowanceReadResult> {
    return readHostedIncludedAllowance({
      gateway: (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)(),
      getSession: this.deps.getSession ?? getActiveStoredSession,
      fetch: this.deps.fetch ?? globalThis.fetch,
    });
  }

  async requestRawTraceDeletion(): Promise<HostedAiRawTraceDeletionResult> {
    const gateway = (this.deps.resolveUrl ?? resolveHostedAiGatewayUrl)();
    if (!gateway)
      return {
        ok: false,
        code: 'not_configured',
        message: 'DNAForge AI is not configured in this build.',
      };
    const session = await (this.deps.getSession ?? getActiveStoredSession)();
    if (!session) return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
    let response: Response;
    try {
      response = await fetchWithoutRedirect(
        this.deps.fetch ?? globalThis.fetch,
        new URL('/v1/hosted/raw-trace-deletion', gateway),
        {
          method: 'POST',
          headers: { authorization: `Bearer ${session.accessToken}` },
        }
      );
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
        requestMayHaveBeenAccepted: true,
      };
    }
    if (!response.ok && (response.status === 408 || response.status >= 500)) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
        requestMayHaveBeenAccepted: true,
      };
    }
    if (!response.ok) return safeGatewayError(response);
    if (response.status !== 202) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid deletion response.',
      };
    }
    const receipt = safeDeletionReceipt(
      await response.json().catch(() => null),
      session.desktopSessionId
    );
    if (!receipt) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI returned an invalid deletion receipt.',
        requestMayHaveBeenAccepted: true,
      };
    }
    return { ok: true, httpStatus: 202, receipt };
  }
}
