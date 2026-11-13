import {
  encodeHostedTelemetryActorContext,
  HOSTED_TELEMETRY_ACTOR_HEADER,
} from '@waypoint/hosted-ai-contract';
import type { PublicTelemetryActorRequestContext } from './telemetry-runtime';
import {
  createHostedSseDecoder,
  HostedGenerateRequestSchema,
  HostedResponsesRequestSchema,
  HOSTED_SSE_MAX_RESPONSE_BYTES,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import type {
  HostedAiStreamEventEnvelope,
  HostedAiStreamStartRequest,
  HostedAiStreamStartResult,
} from '../shared/hosted-ai-gateway-ipc';
import type { StoredSession } from './auth/session-store';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ActiveStream {
  readonly ownerId: number;
  readonly turnBindingToken: string;
  readonly controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

interface HostedAiStreamManagerDependencies {
  readonly resolveUrl?: () => URL | null;
  readonly resolveTelemetryActor?: () => PublicTelemetryActorRequestContext;
  readonly authorizeTurn?: (
    ownerId: number,
    turnBindingToken: string,
    identity: { readonly workflowId: string; readonly runId: string; readonly turnId: string }
  ) => Promise<StoredSession>;
  readonly fetch?: FetchLike;
  readonly emit: (ownerId: number, envelope: HostedAiStreamEventEnvelope) => void;

  readonly qualificationFaultProfile?: string | null;
}

const QUALIFICATION_FAULT_ARG = '--dnaforge-hosted-qualification-fault-profile=';

export function packagedQualificationFaultProfile(argv: readonly string[]): string | null {
  const values = argv
    .filter((argument) => argument.startsWith(QUALIFICATION_FAULT_ARG))
    .map((argument) => argument.slice(QUALIFICATION_FAULT_ARG.length));
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^[a-z][a-z_]{0,63}$/.test(values[0] ?? '')) {
    throw new Error('invalid_hosted_qualification_fault_profile_argument');
  }
  return values[0] ?? null;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 256 && OPAQUE_ID.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStartRequest(value: unknown): HostedAiStreamStartRequest | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  const allowedKeys = new Set([
    'clientRequestId',
    'idempotencyKey',
    'turnBindingToken',
    'route',
    'request',
  ]);
  if (keys.some((key) => !allowedKeys.has(key))) return null;
  if (value.route === undefined ? keys.length !== 4 : keys.length !== 5) return null;
  if (
    !validOpaqueId(value.clientRequestId) ||
    !validOpaqueId(value.idempotencyKey) ||
    !validOpaqueId(value.turnBindingToken)
  )
    return null;
  const route = value.route === undefined ? 'generate' : value.route;
  if (route !== 'generate' && route !== 'responses') return null;
  const request =
    route === 'responses'
      ? HostedResponsesRequestSchema.safeParse(value.request)
      : HostedGenerateRequestSchema.safeParse(value.request);
  if (!request.success) return null;
  const base = {
    clientRequestId: value.clientRequestId,
    idempotencyKey: value.idempotencyKey,
    turnBindingToken: value.turnBindingToken,
  };
  return route === 'responses'
    ? { ...base, route, request: HostedResponsesRequestSchema.parse(request.data) }
    : {
        ...base,
        ...(value.route === 'generate' ? { route } : {}),
        request: HostedGenerateRequestSchema.parse(request.data),
      };
}

function failure(
  code: Extract<HostedAiStreamStartResult, { ok: false }>['code'],
  message: string,
  retryAfterSeconds?: number
): HostedAiStreamStartResult {
  return {
    ok: false,
    code,
    message,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function gatewayErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.error === 'string') return payload.error;
  return isRecord(payload.error) && typeof payload.error.code === 'string'
    ? payload.error.code
    : null;
}

const START_RETRY_DELAYS_MS = [250, 750] as const;
const TRANSIENT_START_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function transientStartResponse(response: Response): Promise<boolean> {
  if (!TRANSIENT_START_STATUS.has(response.status)) return false;
  if (response.status !== 503) return true;
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  return gatewayErrorCode(payload) !== 'gateway_paused';
}

async function waitForStartRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
  return !signal.aborted;
}

async function safeGatewayFailure(response: Response): Promise<HostedAiStreamStartResult> {
  if (response.status === 401) return failure('signed_out', 'Sign in to use DNAForge AI.');
  const payload = await response.json().catch(() => null);
  const code = gatewayErrorCode(payload);
  if (response.status === 413) {
    return failure(
      'request_too_large',
      'This response accumulated more context than DNAForge AI can send safely.'
    );
  }
  if (response.status === 400) {
    return failure('invalid_request', 'The AI workflow request was invalid. Please try again.');
  }
  if (response.status === 409) {
    if (code === 'unresolved_provider_exposure_pending') {
      return failure(
        'provider_exposure_reconciliation_required',
        'Earlier AI provider charges are still being reconciled. Contact DNAForge support before retrying.'
      );
    }
    if (code === 'allowance_exhausted') {
      return failure(
        'allowance_exhausted',
        'Your DNAForge AI allowance is exhausted. Choose a local or Bring Your Own Key route to continue.'
      );
    }
    if (code === 'hosted_request_rate_limited') {
      const parsed = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const retry = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 300) : 60;
      return failure(
        'rate_limited',
        `DNAForge AI is rate limited right now. Try again in about ${retry} second${retry === 1 ? '' : 's'}.`,
        retry
      );
    }
    return failure(
      'allowance_or_policy_rejected',
      'DNAForge AI cannot run this workflow right now.'
    );
  }
  if (response.status === 503 && code === 'gateway_paused') {
    return failure('gateway_paused', 'DNAForge AI is not enabled in this environment.');
  }
  return failure('gateway_unavailable', 'DNAForge AI is temporarily unavailable.');
}

function validateNextEvent(
  event: HostedStreamEvent,
  request: HostedAiStreamStartRequest,
  accepted: Extract<HostedStreamEvent, { event: 'accepted' }> | null,
  expectedSequence: number,
  terminal: boolean
): Extract<HostedStreamEvent, { event: 'accepted' }> | null {
  if (terminal) throw new Error('event_after_terminal');
  if (event.seq !== expectedSequence) throw new Error('sequence_mismatch');
  if (
    event.requestId !== request.clientRequestId ||
    event.runId !== request.request.runId ||
    event.turnId !== request.request.turnId ||
    event.stepSequence !== request.request.stepSequence
  ) {
    throw new Error('correlation_mismatch');
  }
  if (!accepted) {
    if (event.event !== 'accepted' || event.seq !== 0 || event.tier !== request.request.tier) {
      throw new Error('accepted_event_required');
    }
    return event;
  }
  if (event.event === 'accepted') throw new Error('duplicate_accepted_event');
  if (
    (event.event === 'finish' || event.event === 'error') &&
    event.reservationId !== accepted.reservationId
  ) {
    throw new Error('reservation_mismatch');
  }
  return accepted;
}

export class HostedAiStreamManager {
  private readonly active = new Map<string, ActiveStream>();

  constructor(private readonly deps: HostedAiStreamManagerDependencies) {}

  async start(ownerId: number, rawRequest: unknown): Promise<HostedAiStreamStartResult> {
    const request = parseStartRequest(rawRequest);
    if (!request || !Number.isSafeInteger(ownerId) || ownerId < 1) {
      return failure('invalid_request', 'The AI workflow request was invalid. Please try again.');
    }
    const controller = new AbortController();
    const active: ActiveStream = {
      ownerId,
      turnBindingToken: request.turnBindingToken,
      controller,
    };
    if (this.active.has(request.clientRequestId)) {
      return failure('invalid_request', 'The AI workflow request was invalid. Please try again.');
    }

    this.active.set(request.clientRequestId, active);

    let gateway: URL | null;
    try {
      gateway = this.deps.resolveUrl
        ? this.deps.resolveUrl()
        : (await import('./hosted-ai-gateway')).resolveHostedAiGatewayUrl();
    } catch {
      this.clearActive(request.clientRequestId, active);
      return failure('gateway_unavailable', 'DNAForge AI is temporarily unavailable.');
    }
    if (!this.isCurrent(request.clientRequestId, active)) {
      this.clearActive(request.clientRequestId, active);
      return failure('gateway_unavailable', 'DNAForge AI is temporarily unavailable.');
    }
    if (!gateway) {
      this.clearActive(request.clientRequestId, active);
      return failure('not_configured', 'DNAForge AI is not configured in this build.');
    }

    let session: StoredSession;
    try {
      if (!this.deps.authorizeTurn) throw new Error('turn_authority_unavailable');
      session = await this.deps.authorizeTurn(ownerId, request.turnBindingToken, {
        workflowId: request.request.workflowId,
        runId: request.request.runId,
        turnId: request.request.turnId,
      });
    } catch {
      this.clearActive(request.clientRequestId, active);
      return failure('signed_out', 'The signed-in account changed during this DNAForge AI turn.');
    }
    if (!this.isCurrent(request.clientRequestId, active)) {
      this.clearActive(request.clientRequestId, active);
      return failure('gateway_unavailable', 'DNAForge AI is temporarily unavailable.');
    }
    const gatewayUrl = new URL(
      request.route === 'responses' ? '/v1/hosted/responses' : '/v1/hosted/generate',
      gateway
    );
    let actorHeader: string | null = null;
    try {
      const actor = this.deps.resolveTelemetryActor?.();
      if (actor && !actor.telemetrySuppressed) {
        actorHeader = encodeHostedTelemetryActorContext({
          actor: actor.telemetryActor,
          appVersion: actor.appVersion,
          releaseChannel: actor.releaseChannel,
          ...(actor.buildTag ? { buildTag: actor.buildTag } : {}),
          ...(actor.actorAssertion ? { assertion: actor.actorAssertion } : {}),
          ...(actor.ciRunId ? { ciRunId: actor.ciRunId } : {}),
        });
      }
    } catch {
      actorHeader = null;
    }
    const fetchOptions: RequestInit = {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
        'x-request-id': request.clientRequestId,
        ...(actorHeader ? { [HOSTED_TELEMETRY_ACTOR_HEADER]: actorHeader } : {}),
        ...(request.route === 'responses' && this.deps.qualificationFaultProfile
          ? {
              'x-dnaforge-hosted-qualification-fault-profile': this.deps.qualificationFaultProfile,
            }
          : {}),
      },
      body: JSON.stringify(request.request),
      signal: controller.signal,
    };
    let response: Response | null = null;
    for (let attempt = 0; attempt <= START_RETRY_DELAYS_MS.length; attempt += 1) {
      response = null;
      let retryable = false;
      try {
        response = await (this.deps.fetch ?? globalThis.fetch)(gatewayUrl, fetchOptions);
        retryable = !response.ok && (await transientStartResponse(response));
      } catch {
        retryable = true;
      }
      if (!retryable || attempt === START_RETRY_DELAYS_MS.length) break;

      await response?.body?.cancel().catch(() => undefined);
      response = null;
      if (!this.isCurrent(request.clientRequestId, active)) break;
      if (!(await waitForStartRetry(active.controller.signal, START_RETRY_DELAYS_MS[attempt]!))) {
        break;
      }
    }
    if (!response) {
      this.clearActive(request.clientRequestId, active);
      return failure('gateway_unavailable', 'DNAForge AI is temporarily unavailable.');
    }
    if (!this.isCurrent(request.clientRequestId, active)) {
      this.clearActive(request.clientRequestId, active);
      await response.body?.cancel().catch(() => undefined);
      return failure('gateway_unavailable', 'DNAForge AI is temporarily unavailable.');
    }
    if (!response.ok) {
      this.clearActive(request.clientRequestId, active);
      return safeGatewayFailure(response);
    }
    if (
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
      !response.body
    ) {
      this.clearActive(request.clientRequestId, active);
      controller.abort();
      return failure('gateway_unavailable', 'DNAForge AI returned an invalid event stream.');
    }

    void this.pump(ownerId, request, response.body, active);
    return { ok: true };
  }

  cancel(ownerId: number, clientRequestId: string): { readonly ok: boolean } {
    const active = this.active.get(clientRequestId);
    if (!active || active.ownerId !== ownerId) return { ok: false };
    active.controller.abort(new DOMException('Stop requested.', 'AbortError'));
    void active.reader?.cancel().catch(() => undefined);
    if (!active.reader) this.clearActive(clientRequestId, active);
    return { ok: true };
  }

  cancelOwner(ownerId: number): void {
    for (const [requestId, active] of this.active) {
      if (active.ownerId !== ownerId) continue;
      active.controller.abort(new DOMException('Renderer closed.', 'AbortError'));
      void active.reader?.cancel().catch(() => undefined);
      this.clearActive(requestId, active);
    }
  }

  cancelTurnBinding(turnBindingToken: string, message: string): void {
    for (const [requestId, active] of this.active) {
      if (active.turnBindingToken !== turnBindingToken) continue;
      active.controller.abort(new DOMException(message, 'AbortError'));
      void active.reader?.cancel().catch(() => undefined);
      this.deps.emit(active.ownerId, {
        clientRequestId: requestId,
        kind: 'transport_error',
        message,
      });
      this.clearActive(requestId, active);
    }
  }

  private isCurrent(requestId: string, active: ActiveStream): boolean {
    return this.active.get(requestId) === active && !active.controller.signal.aborted;
  }

  private clearActive(requestId: string, active: ActiveStream): void {
    if (this.active.get(requestId) === active) this.active.delete(requestId);
  }

  private async pump(
    ownerId: number,
    request: HostedAiStreamStartRequest,
    body: ReadableStream<Uint8Array>,
    active: ActiveStream
  ): Promise<void> {
    const decoder = createHostedSseDecoder();
    const textDecoder = new TextDecoder('utf-8', { fatal: true });
    const reader = body.getReader();
    active.reader = reader;
    let responseBytes = 0;
    let accepted: Extract<HostedStreamEvent, { event: 'accepted' }> | null = null;
    let expectedSequence = 0;
    let terminal = false;
    let pendingTerminal: Extract<HostedStreamEvent, { event: 'finish' | 'error' }> | null = null;
    const quarantinedSuffix: HostedStreamEvent[] = [];
    let suffixQuarantined = false;
    const acceptEvent = (event: HostedStreamEvent): void => {
      accepted = validateNextEvent(event, request, accepted, expectedSequence, terminal);
      expectedSequence += 1;
      if (event.event === 'finish' || event.event === 'error') {
        terminal = true;
        pendingTerminal = event;
        return;
      }
      if (event.event === 'tool_call' || event.event === 'child_tool_call') {
        suffixQuarantined = true;
      }
      if (suffixQuarantined) {
        quarantinedSuffix.push(event);
        return;
      }
      this.deps.emit(ownerId, {
        clientRequestId: request.clientRequestId,
        kind: 'event',
        event,
      });
    };
    const finishCurrentFrame = (): void => {
      const finalText = textDecoder.decode();
      if (finalText.length > 0) {
        const finalTextEvents = decoder.push(finalText);
        for (const event of finalTextEvents) acceptEvent(event);
      }
      const trailing = decoder.finish();
      for (const event of trailing) acceptEvent(event);
    };
    const commitTerminal = (): void => {
      const terminalEvent = pendingTerminal as Extract<
        HostedStreamEvent,
        { event: 'finish' | 'error' }
      > | null;
      if (!accepted || !terminal || !terminalEvent) throw new Error('terminal_event_required');
      if (terminalEvent.event === 'finish' && terminalEvent.outcome === 'reconciliation_required') {
        throw new Error('completed_settlement_required');
      }
      if (terminalEvent.event === 'finish') {
        for (const event of quarantinedSuffix) {
          this.deps.emit(ownerId, {
            clientRequestId: request.clientRequestId,
            kind: 'event',
            event,
          });
        }
      }
      this.deps.emit(ownerId, {
        clientRequestId: request.clientRequestId,
        kind: 'event',
        event: terminalEvent,
      });
    };
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        responseBytes += next.value.byteLength;
        if (responseBytes > HOSTED_SSE_MAX_RESPONSE_BYTES) {
          throw new Error('response_size_limit_exceeded');
        }
        const events = decoder.push(textDecoder.decode(next.value, { stream: true }));
        for (const event of events) acceptEvent(event);
        if (terminal) {
          finishCurrentFrame();
          commitTerminal();
          return;
        }
      }
      finishCurrentFrame();
      commitTerminal();
    } catch (error) {
      if (!active.controller.signal.aborted) {
        console.warn(
          JSON.stringify({
            event: 'hosted_ai_invalid_event_stream',
            reason: error instanceof Error ? error.message : 'unknown_stream_failure',
          })
        );
        this.deps.emit(ownerId, {
          clientRequestId: request.clientRequestId,
          kind: 'transport_error',
          message: 'DNAForge AI returned an invalid event stream.',
        });
      }
    } finally {
      this.clearActive(request.clientRequestId, active);
      await reader.cancel().catch(() => undefined);
    }
  }
}
