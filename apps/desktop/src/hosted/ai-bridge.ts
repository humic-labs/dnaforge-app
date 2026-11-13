import { userMessage } from '@waypoint/user-messages';
import {
  encodeHostedTelemetryActorContext,
  HOSTED_TELEMETRY_ACTOR_HEADER,
} from '@waypoint/hosted-ai-contract';
import {
  createHostedSseDecoder,
  parseContributionPolicy,
  parseContributionReceipt,
  type HostedResponsesRequest,
  type HostedStreamEvent,
  type ContributionPolicy,
  type ContributionReceipt,
} from '@waypoint/hosted-ai-contract';
import type { HostedAiBridge, HostedCodexBridge } from '../shared/hosted-ai-bridge';
import type {
  HostedAiContributionGateRequest,
  HostedAiContributionGateResult,
  HostedAiRouteAvailabilityResult,
  HostedAiStreamEventEnvelope,
} from '../shared/hosted-ai-gateway-ipc';
import type {
  HostedCodexContributionRequest,
  HostedCodexArtifactIdentityShape,
  HostedCodexGatewayProvenanceShape,
  HostedCodexTurnEvent,
  HostedCodexTurnResult,
  HostedCodexTurnStartRequest,
} from '../shared/hosted-codex-ipc';

const STREAM_LISTENERS = new Set<(envelope: HostedAiStreamEventEnvelope) => void>();
const TURN_LISTENERS = new Set<(event: HostedCodexTurnEvent) => void>();
const BROWSER_TURN_STATUS_POLL_DELAYS_MS = [0, 250, 750, 1_500] as const;

function unavailable(
  code: 'not_configured' | 'signed_out' | 'gateway_unavailable',
  message: string
) {
  return { ok: false as const, code, message };
}

type HostedUnavailable = ReturnType<typeof unavailable>;

type BrowserTurnFailureCode = Extract<HostedCodexTurnResult, { ok: false }>['code'];
type BrowserAcceptedEvent = Extract<HostedStreamEvent, { event: 'accepted' }>;
type BrowserFinishEvent = Extract<HostedStreamEvent, { event: 'finish' }>;

interface ActiveBrowserTurn {
  readonly controller: AbortController;
  readonly text: string[];
  accepted: BrowserAcceptedEvent | null;
  finish: BrowserFinishEvent | null;
  stopRequested: boolean;
}

const ACTIVE_BROWSER_TURNS = new Map<string, ActiveBrowserTurn>();

function browserTurnKey(identity: {
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
}): string {
  return `${identity.workflowId}\u0000${identity.runId}\u0000${identity.turnId}`;
}

function browserErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function browserFailureCode(code: string | null): BrowserTurnFailureCode {
  switch (code) {
    case 'gateway_paused':
      return 'gateway_paused';
    case 'allowance_exhausted':
      return 'allowance_exhausted';
    case 'hosted_request_rate_limited':
      return 'rate_limited';
    case 'unresolved_provider_exposure_pending':
      return 'provider_exposure_reconciliation_required';
    case 'qualification_account_required':
      return 'allowance_or_policy_rejected';
    case 'provider_rate_limited':
      return 'provider_rate_limited';
    case 'provider_authentication_failed':
      return 'provider_authentication_failed';
    case 'provider_request_rejected':
      return 'provider_request_rejected';
    case 'provider_service_unavailable':
      return 'provider_service_unavailable';
    case 'provider_http_error':
      return 'provider_http_error';
    case 'provider_stream_disconnected':
      return 'provider_stream_disconnected';
    case 'response_stream_disconnected':
      return 'response_stream_disconnected';
    case 'response_stream_connection_failed':
      return 'response_stream_connection_failed';
    case 'provider_stream_failed':
      return 'provider_stream_failed';
    case 'provider_continuity_missing':
      return 'provider_continuity_missing';
    case 'provider_continuity_mismatch':
      return 'provider_continuity_mismatch';
    case 'provider_start_budget_exhausted':
      return 'provider_start_budget_exhausted';
    case 'provider_spend_budget_exhausted':
      return 'provider_spend_budget_exhausted';
    case 'workflow_lease_lost':
      return 'workflow_lease_lost';
    case 'gateway_processing_failed':
      return 'gateway_processing_failed';
    case 'request_too_large':
      return 'request_too_large';
    case 'invalid_request':
      return 'invalid_request';
    case 'unauthorized':
      return 'signed_out';
    default:
      return 'gateway_unavailable';
  }
}

function browserResponsesRequest(request: HostedCodexTurnStartRequest): HostedResponsesRequest {
  const prior = request.priorConversationContext?.trim();
  const input = prior
    ? `Earlier conversation context:\n${prior}\n\nCurrent user request:\n${request.userMessage}`
    : request.userMessage;
  return {
    version: 2,
    tier: request.tier,
    workflowId: request.workflowId,
    runId: request.runId,
    turnId: request.turnId,
    stepSequence: 0,
    input,
    instructions: request.developerInstructions,
    tools: [],
    maxOutputTokens: request.tier === 'deep' ? 4_096 : 2_048,
    traceContext: {
      source: 'browser_chat',
      workspaceOpen: false,
      stagedReferenceIds: [],
    },
  };
}

function browserGatewayProvenance(
  accepted: BrowserAcceptedEvent,
  finish: BrowserFinishEvent | null
): HostedCodexGatewayProvenanceShape {
  return {
    gatewayOrigin: window.location.origin,
    catalogVersion: accepted.catalogVersion,
    rateCardVersion: accepted.rateCardVersion,
    reservationIds: [accepted.reservationId],
    usageEventIds: finish?.usageEventId ? [finish.usageEventId] : [],
    workflowRunId: accepted.workflowTrace?.workflowRunId ?? null,
    workflowStepId: accepted.workflowTrace?.workflowStepId ?? null,
    completedToolCallIds: [],
    terminalError: null,
  };
}

function browserArtifact(): HostedCodexArtifactIdentityShape {
  return {
    desktopSourceCommit: null,
    appServerVersion: 'hosted-browser',
    appServerSha256: 'browser',
    appServerTarget: 'browser',
  };
}

type BrowserTurnStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'provider_error'
  | 'reconciliation_required'
  | 'expired';

interface BrowserTurnStatusProjection {
  readonly status: BrowserTurnStatus;
  readonly terminal_output: string | null;
}

async function loadBrowserTurnStatus(
  workflowRunId: string,
  signal?: AbortSignal
): Promise<BrowserTurnStatusProjection | null> {
  try {
    const { status, body } = await fetchJson(
      `/v1/hosted/browser/turn-status?workflow_run_id=${encodeURIComponent(workflowRunId)}`,
      signal ? { signal } : undefined
    );
    if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    if (
      (value.status !== 'running' &&
        value.status !== 'completed' &&
        value.status !== 'cancelled' &&
        value.status !== 'provider_error' &&
        value.status !== 'reconciliation_required' &&
        value.status !== 'expired') ||
      (value.terminal_output !== null &&
        (typeof value.terminal_output !== 'string' || value.terminal_output.length > 64 * 1024))
    ) {
      return null;
    }
    return {
      status: value.status,
      terminal_output: value.terminal_output,
    };
  } catch {
    return null;
  }
}

function waitForBrowserTurnStatusPoll(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs === 0) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(ready);
    };
    const abort = (): void => settle(false);
    const timer = globalThis.setTimeout(() => settle(true), delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function recoverBrowserTurnAfterDisconnect(
  request: HostedCodexTurnStartRequest,
  active: ActiveBrowserTurn
): Promise<HostedCodexTurnResult | null> {
  const accepted = active.accepted;
  const workflowRunId = accepted?.workflowTrace?.workflowRunId;
  if (!workflowRunId) return null;
  let sawRunning = false;
  for (const delayMs of BROWSER_TURN_STATUS_POLL_DELAYS_MS) {
    const ready = await waitForBrowserTurnStatusPoll(delayMs, active.controller.signal);
    if (!ready) return null;
    const status = await loadBrowserTurnStatus(workflowRunId, active.controller.signal);
    if (!status) continue;
    if (status.status === 'running') {
      sawRunning = true;
      continue;
    }
    if (status.status === 'completed') {
      if (status.terminal_output === null) {
        return {
          ok: false,
          code: 'provider_exposure_reconciliation_required',
          message: 'DNAForge AI completed this browser turn without a recoverable answer.',
        };
      }
      const streamedText = active.text.join('');
      if (!status.terminal_output.startsWith(streamedText)) {
        return {
          ok: false,
          code: 'provider_exposure_reconciliation_required',
          message: 'DNAForge AI completed this browser turn with an unreconcilable answer.',
        };
      }
      const remaining = status.terminal_output.slice(streamedText.length);
      if (remaining) {
        active.text.push(remaining);
        emitBrowserTurnEvent({
          workflowId: request.workflowId,
          runId: request.runId,
          turnId: request.turnId,
          kind: 'text_delta',
          delta: remaining,
        });
      }
      return {
        ok: true,
        outcome: 'completed',
        text: status.terminal_output,
        gateway: browserGatewayProvenance(accepted, null),
        artifact: browserArtifact(),
      };
    }
    if (status.status === 'reconciliation_required') {
      return {
        ok: false,
        code: 'provider_exposure_reconciliation_required',
        message: 'DNAForge AI requires provider reconciliation before this turn can continue.',
      };
    }
    if (status.status === 'provider_error') {
      return {
        ok: false,
        code: 'provider_stream_failed',
        message: 'DNAForge AI recorded a provider failure for this browser turn.',
      };
    }
    if (status.status === 'cancelled') {
      return {
        ok: false,
        code: 'response_stream_disconnected',
        message: 'DNAForge AI recorded this browser turn as cancelled; it was not retried.',
      };
    }
    if (status.status === 'expired') {
      return {
        ok: false,
        code: 'response_stream_disconnected',
        message: 'DNAForge AI expired this browser turn before it completed; it was not retried.',
      };
    }
  }
  if (sawRunning) {
    return {
      ok: false,
      code: 'response_stream_disconnected',
      message:
        'DNAForge AI is still processing this browser turn. It was not retried; wait for the current turn to settle before sending it again.',
    };
  }
  return null;
}

function emitBrowserTurnEvent(event: HostedCodexTurnEvent): void {
  for (const listener of TURN_LISTENERS) {
    try {
      listener(event);
    } catch {}
  }
}

async function fetchJson(
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 8_000);
  const abortFromCaller = (): void => controller.abort();
  if (init?.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  try {
    const response = await fetch(path, {
      credentials: 'include',
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    globalThis.clearTimeout(timeoutId);
    init?.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function loadPolicy(): Promise<{ ok: true; policy: ContributionPolicy } | HostedUnavailable> {
  try {
    const { status, body } = await fetchJson('/v1/hosted/browser/contribution-policy');
    if (status === 401) {
      return unavailable('signed_out', 'Sign in to use DNAForge AI in the browser.');
    }
    const policy = parseContributionPolicy(body);
    if (!policy) {
      return unavailable(
        'gateway_unavailable',
        'DNAForge AI could not load the current contribution policy.'
      );
    }
    return { ok: true, policy };
  } catch {
    return unavailable(
      'gateway_unavailable',
      'DNAForge AI could not load the current contribution policy.'
    );
  }
}

async function recordChoice(
  policy: ContributionPolicy,
  choice: 'joined' | 'withdrawn'
): Promise<{ ok: true; receipt: ContributionReceipt } | HostedUnavailable> {
  try {
    const { status, body } = await fetchJson('/v1/hosted/browser/contribution-policy', {
      method: 'POST',
      body: JSON.stringify({
        choice,
        idempotency_key: crypto.randomUUID(),
        expected_account_setting_id: policy.account_setting_id,
        challenge: {
          terms_version_id: policy.legal_challenge.terms_version_id,
          terms_content_sha256: policy.legal_challenge.terms_content_sha256,
          privacy_version_id: policy.legal_challenge.privacy_version_id,
          privacy_content_sha256: policy.legal_challenge.privacy_content_sha256,
          contribution_policy_generation: policy.contribution_policy_generation,
        },
      }),
    });
    if (status === 401) {
      return unavailable('signed_out', 'Sign in to use DNAForge AI in the browser.');
    }
    const receipt = parseContributionReceipt(body);
    if (!receipt) {
      return unavailable(
        'gateway_unavailable',
        'DNAForge AI could not record the contribution choice.'
      );
    }
    return { ok: true, receipt };
  } catch {
    return unavailable(
      'gateway_unavailable',
      'DNAForge AI could not record the contribution choice.'
    );
  }
}

async function presentContribution(
  request: HostedAiContributionGateRequest | HostedCodexContributionRequest
): Promise<HostedAiContributionGateResult> {
  const loaded = await loadPolicy();
  if (!('policy' in loaded)) return loaded;
  const policy = loaded.policy;
  if ('surface' in request && request.surface === 'settings') {
    if (!request.choice)
      return { ok: true, started: false, policy, receipt: null, turnBindingToken: null };
    if (!policy.choice_offered)
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Your account plan manages this setting.',
      };
    const recorded = await recordChoice(policy, request.choice);
    if (!recorded.ok) return recorded;
    if (
      recorded.receipt.receipt_choice !== request.choice ||
      recorded.receipt.current_contribution_choice !== request.choice ||
      recorded.receipt.contribution_policy_generation !== policy.contribution_policy_generation
    ) {
      return unavailable(
        'gateway_unavailable',
        'Your contribution setting changed. Reload Settings.'
      );
    }
    const current = await loadPolicy();
    if (!('policy' in current)) return current;
    if (current.policy.contribution_choice !== request.choice) {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'Your contribution setting changed. Reload Settings.',
      };
    }
    return {
      ok: true,
      started: false,
      policy: current.policy,
      receipt: recorded.receipt,
      turnBindingToken: null,
    };
  }
  if (!policy.hosted_authorized)
    return {
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge agent is unavailable for this account. Try again or choose another host.',
    };
  return { ok: true, started: true, policy, receipt: null, turnBindingToken: crypto.randomUUID() };
}

export const hostedBrowserAiBridge: HostedAiBridge = {
  prepareContribution: presentContribution,
  validateTurnBinding: async () => ({ ok: true }),
  releaseTurnBinding: async () => ({ ok: true }),
  startStream: async () =>
    unavailable(
      'gateway_unavailable',
      'DNAForge AI streaming is not available without the hosted gateway.'
    ),
  cancelStream: async () => ({ ok: true }),
  onStreamEvent: (callback) => {
    STREAM_LISTENERS.add(callback);
    return () => {
      STREAM_LISTENERS.delete(callback);
    };
  },
  recordToolObservation: async () =>
    unavailable('gateway_unavailable', 'DNAForge AI tool receipts require the hosted gateway.'),
  claimTool: async () =>
    unavailable('gateway_unavailable', 'DNAForge AI tool claims require the hosted gateway.'),
  completeToolClaim: async () =>
    unavailable('gateway_unavailable', 'DNAForge AI tool claims require the hosted gateway.'),
  cancelToolClaim: async () =>
    unavailable('gateway_unavailable', 'DNAForge AI tool claims require the hosted gateway.'),
  cancelWorkflow: async () =>
    unavailable('gateway_unavailable', 'No hosted workflow is running in this browser session.'),
  executeNativeTool: async () => ({
    ok: false,
    code: 'tool_failed',
    message: userMessage('hosted.agentUnavailable'),
  }),
  cancelNativeTool: async () => ({ ok: true }),
  getWorkflowAuthority: async () =>
    unavailable(
      'gateway_unavailable',
      'DNAForge AI authority is not available without the hosted gateway.'
    ),
  getRouteAvailability: async (): Promise<HostedAiRouteAvailabilityResult> => {
    try {
      const { status, body } = await fetchJson('/v1/hosted/route-availability');
      if (status === 401) {
        return {
          ok: false,
          code: 'signed_out',
          message: 'Sign in to use DNAForge AI in the browser.',
          gatewayOrigin: window.location.origin,
        };
      }
      if (status < 200 || status >= 300) {
        return {
          ok: false,
          code: 'gateway_unavailable',
          message: 'DNAForge AI is not reachable from this browser session.',
          gatewayOrigin: window.location.origin,
        };
      }
      if (
        body &&
        typeof body === 'object' &&
        'available' in body &&
        (body as { available?: unknown }).available === true
      ) {
        return { ok: true, available: true, gatewayOrigin: window.location.origin };
      }
      if (
        body &&
        typeof body === 'object' &&
        'available' in body &&
        body.available === false &&
        'reason' in body &&
        typeof body.reason === 'string' &&
        [
          'gateway_paused',
          'account_not_enabled',
          'sign_in_required',
          'workflow_unavailable',
          'provider_unavailable',
          'gateway_not_ready',
          'browser_agent_unavailable',
        ].includes(body.reason)
      ) {
        return {
          ok: true,
          available: false,
          reason:
            body.reason as import('../shared/hosted-ai-gateway-ipc').HostedAiRouteUnavailableReason,
          gatewayOrigin: window.location.origin,
        };
      }
      return {
        ok: false,
        code: 'invalid_response',
        message: 'DNAForge AI returned an invalid availability response.',
        gatewayOrigin: window.location.origin,
      };
    } catch {
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is not reachable from this browser session.',
        gatewayOrigin: window.location.origin,
      };
    }
  },
};

export const hostedBrowserCodexBridge: HostedCodexBridge = {
  prepareContribution: async (request: HostedCodexContributionRequest) => {
    const result = await presentContribution(request);
    if (!result.ok) return result;
    return {
      ok: true,
      started: result.started,
      policy: result.policy,
      receipt: result.receipt,
    };
  },
  cancelPreparedTurn: async () => ({ ok: true }),
  startTurn: async (request: HostedCodexTurnStartRequest): Promise<HostedCodexTurnResult> => {
    const key = browserTurnKey(request);
    if (ACTIVE_BROWSER_TURNS.has(key)) {
      return {
        ok: false,
        code: 'gateway_processing_failed',
        message: 'A DNAForge AI turn is already running for this conversation.',
      };
    }
    const active: ActiveBrowserTurn = {
      controller: new AbortController(),
      text: [],
      accepted: null,
      finish: null,
      stopRequested: false,
    };
    ACTIVE_BROWSER_TURNS.set(key, active);
    try {
      const requestId = crypto.randomUUID();
      const actorHeader = encodeHostedTelemetryActorContext({
        actor: import.meta.env.VITE_DNAFORGE_TELEMETRY_ACTOR ?? '',
      });
      const response = await fetch('/v1/hosted/browser/responses', {
        method: 'POST',
        credentials: 'include',
        signal: active.controller.signal,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'X-Request-Id': requestId,
          ...(actorHeader ? { [HOSTED_TELEMETRY_ACTOR_HEADER]: actorHeader } : {}),
        },
        body: JSON.stringify(browserResponsesRequest(request)),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (active.stopRequested) {
          return {
            ok: false,
            code: 'gateway_unavailable',
            message: 'DNAForge AI stopped before the browser gateway accepted this turn.',
          };
        }
        if (response.status === 401) {
          return { ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' };
        }
        return {
          ok: false,
          code: browserFailureCode(browserErrorCode(payload)),
          message: 'DNAForge AI is temporarily unavailable in this browser session.',
        };
      }
      if (!response.body) {
        return {
          ok: false,
          code: 'gateway_unavailable',
          message: 'DNAForge AI returned no browser event stream.',
        };
      }

      const reader = response.body.getReader();
      const decoder = createHostedSseDecoder();
      const textDecoder = new TextDecoder('utf-8', { fatal: true });
      let expectedSequence = 0;
      let terminal = false;
      const consume = (event: HostedStreamEvent): void => {
        if (terminal || event.seq !== expectedSequence) throw new Error('browser_event_sequence');
        if (
          event.requestId !== requestId ||
          event.runId !== request.runId ||
          event.turnId !== request.turnId ||
          event.stepSequence !== 0
        ) {
          throw new Error('browser_event_correlation');
        }
        expectedSequence += 1;
        if (event.event === 'accepted') {
          if (event.seq !== 0 || active.accepted) throw new Error('browser_acceptance_invalid');
          active.accepted = event;
          return;
        }
        if (!active.accepted) throw new Error('browser_acceptance_required');
        if (event.event === 'text_delta') {
          active.text.push(event.delta);
          emitBrowserTurnEvent({
            workflowId: request.workflowId,
            runId: request.runId,
            turnId: request.turnId,
            kind: 'text_delta',
            delta: event.delta,
          });
          return;
        }
        if (event.event === 'finish') {
          terminal = true;
          active.finish = event;
          return;
        }
        if (event.event === 'error') {
          terminal = true;
          throw Object.assign(new Error(event.message), {
            browserCode: event.code,
            retryable: event.retryable,
          });
        }
        if (event.event === 'reasoning_delta' || event.event === 'reasoning_continuation') return;
        throw new Error('browser_tool_event_not_supported');
      };
      try {
        for (;;) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await reader.read();
          } catch (error) {
            if (active.stopRequested) throw error;
            throw Object.assign(new Error('The browser response stream disconnected.'), {
              browserCode: 'response_stream_disconnected',
              cause: error,
            });
          }
          if (next.done) break;
          const events = decoder.push(textDecoder.decode(next.value, { stream: true }));
          for (const event of events) consume(event);
          if (terminal) break;
        }
        const tail = textDecoder.decode();
        for (const event of decoder.push(tail)) consume(event);
        for (const event of decoder.finish()) consume(event);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (!active.accepted || !active.finish) {
        if (active.accepted && !active.finish) {
          const recovered = await recoverBrowserTurnAfterDisconnect(request, active);
          if (recovered) return recovered;
        }
        return {
          ok: false,
          code: active.accepted ? 'response_stream_disconnected' : 'gateway_processing_failed',
          message: active.accepted
            ? 'DNAForge AI disconnected before the browser turn reached a terminal state.'
            : 'DNAForge AI ended without a complete browser result.',
        };
      }
      if (active.finish.outcome === 'reconciliation_required') {
        return {
          ok: false,
          code: 'provider_exposure_reconciliation_required',
          message: 'DNAForge AI requires provider reconciliation before this turn can continue.',
        };
      }
      return {
        ok: true,
        outcome: active.stopRequested ? 'stopped' : 'completed',
        text: active.text.join(''),
        gateway: browserGatewayProvenance(active.accepted, active.finish),
        artifact: browserArtifact(),
      };
    } catch (error) {
      if (active.stopRequested && active.accepted) {
        return {
          ok: true,
          outcome: 'stopped',
          text: active.text.join(''),
          gateway: browserGatewayProvenance(active.accepted, active.finish),
          artifact: browserArtifact(),
        };
      }
      if (error instanceof Error && 'browserCode' in error) {
        const code = (error as Error & { browserCode?: unknown }).browserCode;
        if (code === 'response_stream_disconnected') {
          const recovered = await recoverBrowserTurnAfterDisconnect(request, active);
          if (recovered) return recovered;
        }
        return {
          ok: false,
          code: browserFailureCode(typeof code === 'string' ? code : null),
          message: error.message,
        };
      }
      return {
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI could not complete the browser event stream.',
      };
    } finally {
      ACTIVE_BROWSER_TURNS.delete(key);
    }
  },
  stopTurn: async (request) => {
    const active = ACTIVE_BROWSER_TURNS.get(browserTurnKey(request));
    if (!active) return { ok: true };
    active.stopRequested = true;
    active.controller.abort();
    return { ok: true };
  },
  onTurnEvent: (callback) => {
    TURN_LISTENERS.add(callback);
    return () => {
      TURN_LISTENERS.delete(callback);
    };
  },
};
