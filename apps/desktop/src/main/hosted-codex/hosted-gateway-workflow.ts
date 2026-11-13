import { randomUUID } from 'node:crypto';
import {
  HostedResponsesRequestSchema,
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  type HostedToolChoice,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';

import type { RendererToolCallErrorShape } from '../../shared/agent-tools-ipc';
import type {
  HostedAiStreamStartRequest,
  HostedAiToolClaimCancelRequest,
  HostedAiToolClaimCompleteRequest,
  HostedAiToolClaimRequest,
  HostedAiToolClaimResult,
  HostedAiToolObservationRequest,
  HostedAiToolObservationResult,
  HostedAiTurnBindingRequest,
  HostedAiTier,
} from '../../shared/hosted-ai-gateway-ipc';
import type { AcceptedResponsesRequest } from './responses-wire';
import type { HostedCodexTool } from './dynamic-tool-catalog';
import type {
  ToolApprover,
  ToolCallRequest,
  ToolExecutionResult,
  ToolExecutor,
} from './tool-dispatch';

interface RegisteredGatewayToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly ticket: Extract<HostedStreamEvent, { event: 'tool_call' }>['ticket'];
  readonly toolTicketId: string;
  claimId?: string;
  consumed?: boolean;
}

export interface HostedCodexLocalToolCall {
  readonly turnId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly actionId: string;
  readonly effects: readonly HostedCodexTool['effects'][number][];
}

export type HostedCodexLocalToolResponse =
  | { readonly ok: true; readonly result: unknown; readonly effectReceiptRef: string }
  | { readonly ok: false; readonly error: RendererToolCallErrorShape };

export type HostedCodexUserApprovalRequest = HostedCodexLocalToolCall;

export type HostedCodexApprovalObservation =
  | { readonly kind: 'requested'; readonly request: HostedCodexUserApprovalRequest }
  | {
      readonly kind: 'resolved';
      readonly request: HostedCodexUserApprovalRequest;
      readonly approved: boolean;
    };

let approvalObserverForTest: ((observation: HostedCodexApprovalObservation) => void) | undefined;
let approvalObservationFailedForTest = false;

export function setHostedCodexApprovalObserverForTest(
  observer: ((observation: HostedCodexApprovalObservation) => void) | undefined
): void {
  approvalObserverForTest = observer;
  approvalObservationFailedForTest = false;
}

export function didHostedCodexApprovalObservationFailForTest(): boolean {
  return approvalObservationFailedForTest;
}

function observeApprovalForTest(observation: HostedCodexApprovalObservation): void {
  if (!approvalObserverForTest) return;
  try {
    approvalObserverForTest(structuredClone(observation));
  } catch {
    approvalObservationFailedForTest = true;
    return;
  }
}

export interface HostedCodexGatewayWorkflow {
  readonly step: (request: AcceptedResponsesRequest) => AsyncIterable<HostedStreamEvent>;
  readonly approve: ToolApprover;
  readonly execute: ToolExecutor;
  provenance(): HostedCodexGatewayProvenance;
}

export interface HostedCodexGatewayProvenance {
  readonly gatewayOrigin: string;
  readonly catalogVersion: string | null;
  readonly rateCardVersion: string | null;
  readonly reservationIds: readonly string[];
  readonly usageEventIds: readonly string[];
  readonly workflowRunId: string | null;
  readonly workflowStepId: string | null;
  readonly completedToolCallIds: readonly string[];
  readonly providerAttempts: number;
  readonly terminalError: {
    readonly code: string;
    readonly httpStatusCode: number | null;
    readonly retryable: boolean;
  } | null;
}

export interface HostedCodexGatewayWorkflowOptions {
  readonly identity: {
    readonly workflowId: string;
    readonly runId: string;
    readonly turnId: string;
  };
  readonly tier: HostedAiTier;
  readonly gatewayOrigin: string;
  readonly turnBindingToken: string;
  readonly workspaceOpen: boolean;
  readonly stagedReferenceIds: readonly string[];
  readonly stream: (request: HostedAiStreamStartRequest) => AsyncIterable<HostedStreamEvent>;
  readonly callLocalTool: (
    request: HostedCodexLocalToolCall
  ) => Promise<HostedCodexLocalToolResponse>;
  readonly requestUserApproval: (request: HostedCodexUserApprovalRequest) => Promise<boolean>;
  readonly recordObservation: (
    request: HostedAiToolObservationRequest
  ) => Promise<HostedAiToolObservationResult>;
  readonly claimTool: (request: HostedAiToolClaimRequest) => Promise<HostedAiToolClaimResult>;
  readonly completeToolClaim: (
    request: HostedAiToolClaimCompleteRequest
  ) => Promise<HostedAiToolClaimResult>;
  readonly cancelToolClaim: (
    request: HostedAiToolClaimCancelRequest
  ) => Promise<HostedAiToolClaimResult>;
  readonly idGenerator?: () => string;
  readonly now?: () => number;
  readonly onGatewayEvent?: (event: HostedStreamEvent) => void;
}

export class HostedCodexGatewayWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedCodexGatewayWorkflowError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function toolTicketIdFromToken(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HostedCodexGatewayWorkflowError(
      'invalid_tool_ticket',
      'The signed gateway tool ticket has an invalid identity.'
    );
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(payload) ||
      typeof payload.id !== 'string' ||
      payload.id.length === 0 ||
      payload.id.length > 256
    ) {
      throw new Error('invalid ticket id');
    }
    return payload.id;
  } catch {
    throw new HostedCodexGatewayWorkflowError(
      'invalid_tool_ticket',
      'The signed gateway tool ticket has an invalid identity.'
    );
  }
}

function responsesToolChoice(value: unknown): HostedToolChoice | undefined {
  if (value === 'auto' || value === 'none' || value === 'required') return { type: value };
  if (!isRecord(value)) return undefined;
  if (value.type === 'function' && typeof value.name === 'string') {
    return { type: 'tool', toolName: value.name };
  }
  return undefined;
}

function assertSameToolCall(
  registered: RegisteredGatewayToolCall | undefined,
  request: ToolCallRequest,
  now: number
): RegisteredGatewayToolCall {
  if (!registered) {
    throw new HostedCodexGatewayWorkflowError(
      'missing_tool_ticket',
      `No signed gateway ticket exists for tool call ${request.callId}.`
    );
  }
  if (
    registered.name !== request.name ||
    canonicalJson(registered.input) !== canonicalJson(request.input)
  ) {
    throw new HostedCodexGatewayWorkflowError(
      'tool_ticket_mismatch',
      `The signed gateway ticket does not match tool call ${request.callId}.`
    );
  }
  if (Date.parse(registered.ticket.expiresAt) <= now) {
    throw new HostedCodexGatewayWorkflowError(
      'tool_ticket_expired',
      `The signed gateway ticket expired before tool call ${request.callId}.`
    );
  }
  return registered;
}

function terminalError(result: HostedAiToolClaimResult | HostedAiToolObservationResult): Error {
  return new HostedCodexGatewayWorkflowError(
    result.ok ? 'invalid_gateway_receipt' : result.code,
    result.ok ? 'DNAForge AI returned an invalid gateway receipt.' : result.message
  );
}

function observationPayload(response: HostedCodexLocalToolResponse): Record<string, unknown> {
  return response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error };
}

function mayHaveChanged(response: Extract<HostedCodexLocalToolResponse, { ok: false }>): boolean {
  return (
    response.error.details?.stateChanged === true ||
    response.error.details?.stateMayHaveChanged === true ||
    (Array.isArray(response.error.details?.partialEffects) &&
      (response.error.details.partialEffects.length > 0 ||
        response.error.details.stateChanged !== false))
  );
}

export function createHostedCodexGatewayWorkflow(
  options: HostedCodexGatewayWorkflowOptions
): HostedCodexGatewayWorkflow {
  const idGenerator = options.idGenerator ?? randomUUID;
  const now = options.now ?? Date.now;
  const tickets = new Map<string, RegisteredGatewayToolCall>();
  const completedToolCallIds: string[] = [];
  const reservationIds: string[] = [];
  const usageEventIds: string[] = [];
  let stepSequence = 0;
  let workflowRunId: string | undefined;
  let workflowStepId: string | undefined;
  let catalogVersion: string | null = null;
  let rateCardVersion: string | null = null;
  let terminalGatewayError: HostedCodexGatewayProvenance['terminalError'] = null;
  let providerAttempts = 0;

  const binding = (): HostedAiTurnBindingRequest => ({
    turnBindingToken: options.turnBindingToken,
    ...options.identity,
  });

  const record = async (
    registered: RegisteredGatewayToolCall,
    response: HostedCodexLocalToolResponse
  ): Promise<void> => {
    const result = await options.recordObservation({
      ...binding(),
      ticket: registered.ticket.token,
      ...(registered.claimId ? { claimId: registered.claimId } : {}),
      argumentsPayload: registered.input as Record<string, unknown>,
      observationPayload: observationPayload(response),
    });
    if (!result.ok) throw terminalError(result);
    if (
      !workflowRunId ||
      !workflowStepId ||
      result.receipt.ticketId !== registered.toolTicketId ||
      result.receipt.workflowRunId !== workflowRunId ||
      result.receipt.workflowStepId !== workflowStepId ||
      result.receipt.providerCallId !== registered.ticket.providerCallId ||
      result.receipt.toolName !== registered.name
    ) {
      throw new HostedCodexGatewayWorkflowError(
        'tool_observation_mismatch',
        'The gateway tool observation receipt did not match the executed tool.'
      );
    }
  };

  const approve: ToolApprover = async (tool, request) => {
    const registered = assertSameToolCall(tickets.get(request.callId), request, now());
    const mutating = tool.effects.includes('mutating');
    const approvalRequired = registered.ticket.requiresUserApproval || mutating;
    let approvalReceiptRef: string | null = null;
    if (approvalRequired) {
      let approved = false;
      const approvalRequest: HostedCodexUserApprovalRequest = {
        turnId: options.identity.turnId,
        toolName: tool.name,
        input: request.input,
        actionId: request.callId,
        effects: tool.effects,
      };
      observeApprovalForTest({ kind: 'requested', request: approvalRequest });
      try {
        approved = await options.requestUserApproval(approvalRequest);
      } catch {
        approved = false;
      }
      observeApprovalForTest({ kind: 'resolved', request: approvalRequest, approved });
      if (approved) {
        approvalReceiptRef = `user-approved:${idGenerator()}`;
      } else {
        registered.consumed = true;
        await record(registered, {
          ok: false,
          error: {
            code: 'USER_DECLINED',
            message: 'The user did not approve this local operation.',
            retriable: false,
          },
        });
        return 'declined';
      }
    }
    if (!mutating) return 'approved';
    if (!approvalReceiptRef) {
      await record(registered, {
        ok: false,
        error: {
          code: 'USER_DECLINED',
          message: 'The local mutation did not have an explicit approval receipt.',
          retriable: false,
        },
      });
      registered.consumed = true;
      return 'declined';
    }
    const result = await options.claimTool({
      ...binding(),
      ticket: registered.ticket.token,
      approvalReceiptRef,
      idempotencyKey: `hosted-codex-claim:${request.callId}`,
    });
    if (!result.ok) throw terminalError(result);
    if (
      result.claim.toolName !== tool.name ||
      result.claim.toolTicketId !== registered.toolTicketId ||
      result.claim.status !== 'claimed' ||
      result.claim.alreadyApplied
    ) {
      throw new HostedCodexGatewayWorkflowError(
        'mutation_claim_mismatch',
        'The gateway mutation claim did not authorize this tool execution.'
      );
    }
    registered.claimId = result.claim.claimId;
    return 'approved';
  };

  const execute: ToolExecutor = async (
    tool: HostedCodexTool,
    request: ToolCallRequest
  ): Promise<ToolExecutionResult> => {
    const registered = assertSameToolCall(tickets.get(request.callId), request, now());
    if (registered.consumed) {
      throw new HostedCodexGatewayWorkflowError(
        'tool_ticket_replayed',
        `The signed gateway ticket was already consumed for ${request.callId}.`
      );
    }
    const mutating = tool.effects.includes('mutating');
    if (mutating && !registered.claimId) {
      throw new HostedCodexGatewayWorkflowError(
        'mutation_claim_missing',
        `The mutation claim is missing for ${request.callId}.`
      );
    }
    const response = await options.callLocalTool({
      turnId: options.identity.turnId,
      toolName: tool.name,
      input: request.input,
      actionId: request.callId,
      effects: tool.effects,
    });

    if (mutating && response.ok) {
      const completion = await options.completeToolClaim({
        ...binding(),
        claimId: registered.claimId!,
        idempotencyKey: `hosted-codex-claim:${request.callId}`,
        effectReceiptRef: response.effectReceiptRef,
      });
      if (!completion.ok) throw terminalError(completion);
      if (
        completion.claim.claimId !== registered.claimId ||
        completion.claim.toolTicketId !== registered.toolTicketId ||
        completion.claim.status !== 'completed' ||
        completion.claim.toolName !== tool.name
      ) {
        throw new HostedCodexGatewayWorkflowError(
          'mutation_completion_mismatch',
          'The gateway did not confirm the exact mutation completion.'
        );
      }
    } else if (mutating && !response.ok) {
      if (mayHaveChanged(response)) {
        throw new HostedCodexGatewayWorkflowError(
          'mutation_outcome_unknown',
          'The renderer could not prove whether the claimed mutation changed state.'
        );
      }
      const cancellation = await options.cancelToolClaim({
        ...binding(),
        claimId: registered.claimId!,
        idempotencyKey: `hosted-codex-claim:${request.callId}`,
        reason: 'pre_effect_failure',
      });
      if (!cancellation.ok) throw terminalError(cancellation);
      if (
        cancellation.claim.claimId !== registered.claimId ||
        cancellation.claim.toolTicketId !== registered.toolTicketId ||
        cancellation.claim.status !== 'canceled' ||
        cancellation.claim.toolName !== tool.name
      ) {
        throw new HostedCodexGatewayWorkflowError(
          'mutation_cancellation_mismatch',
          'The gateway did not confirm the exact mutation cancellation.'
        );
      }
      registered.claimId = undefined;
    }

    await record(registered, response);
    registered.consumed = true;
    completedToolCallIds.push(request.callId);
    return response.ok
      ? { outcome: mutating ? 'applied' : 'no_effect', output: response.result }
      : { outcome: 'no_effect', output: { error: response.error } };
  };

  const step = async function* (
    accepted: AcceptedResponsesRequest
  ): AsyncIterable<HostedStreamEvent> {
    terminalGatewayError = null;
    const clientRequestId = idGenerator();
    const currentSequence = stepSequence;
    const forwarded = accepted.forwarded;
    const request = {
      version: 2,
      tier: options.tier,
      workflowId: options.identity.workflowId,
      runId: options.identity.runId,
      turnId: options.identity.turnId,
      stepSequence: currentSequence,
      ...(workflowRunId ? { workflowRunId } : {}),
      input: forwarded.input,
      ...(typeof forwarded.instructions === 'string'
        ? { instructions: forwarded.instructions }
        : {}),
      tools: Array.isArray(forwarded.tools) ? forwarded.tools : [],
      ...(responsesToolChoice(forwarded.tool_choice)
        ? { toolChoice: responsesToolChoice(forwarded.tool_choice) }
        : {}),
      ...(accepted.maxOutputTokens ? { maxOutputTokens: accepted.maxOutputTokens } : {}),
      ...(accepted.promptCacheKey ? { promptCacheKey: accepted.promptCacheKey } : {}),
      ...(accepted.parallelToolCalls === undefined
        ? {}
        : { parallelToolCalls: accepted.parallelToolCalls }),
      ...(accepted.reasoning === undefined ? {} : { reasoning: accepted.reasoning }),
      ...(forwarded.text === undefined ? {} : { text: forwarded.text }),
      ...(Array.isArray(accepted.include) ? { include: accepted.include } : {}),
      traceContext: {
        source: 'desktop_chat',
        workspaceOpen: options.workspaceOpen,
        stagedReferenceIds: [...options.stagedReferenceIds],
      },
    };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_HOSTED_WHOLE_REQUEST_BYTES) {
      throw new HostedCodexGatewayWorkflowError(
        'invalid_gateway_request',
        'The projected Hosted request exceeds its size limit.'
      );
    }
    const parsedRequest = HostedResponsesRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
        console.error(
          '[HostedCodex] Generated Hosted request contract errors:',
          parsedRequest.error.issues.map(({ code, message, path }) => ({ code, message, path }))
        );
      }
      throw new HostedCodexGatewayWorkflowError(
        'invalid_gateway_request',
        'The App Server request could not be represented by the Hosted Responses contract.'
      );
    }
    stepSequence += 1;
    for await (const gatewayEvent of options.stream({
      clientRequestId,
      idempotencyKey: `hosted-codex-step:${options.identity.runId}:${currentSequence}`,
      turnBindingToken: options.turnBindingToken,
      route: 'responses',
      request: parsedRequest.data,
    })) {
      options.onGatewayEvent?.(gatewayEvent);
      if (gatewayEvent.event === 'accepted') {
        terminalGatewayError = null;
        catalogVersion = gatewayEvent.catalogVersion;
        rateCardVersion = gatewayEvent.rateCardVersion;
        reservationIds.push(gatewayEvent.reservationId);
        workflowRunId = gatewayEvent.workflowTrace?.workflowRunId;
        workflowStepId = gatewayEvent.workflowTrace?.workflowStepId;
      } else if (gatewayEvent.event === 'tool_call') {
        if (tickets.has(gatewayEvent.toolCallId)) {
          throw new HostedCodexGatewayWorkflowError(
            'duplicate_tool_ticket',
            `The gateway repeated tool call ${gatewayEvent.toolCallId}.`
          );
        }
        tickets.set(gatewayEvent.toolCallId, {
          name: gatewayEvent.name,
          input: gatewayEvent.input,
          ticket: gatewayEvent.ticket,
          toolTicketId: toolTicketIdFromToken(gatewayEvent.ticket.token),
        });
      } else if (gatewayEvent.event === 'finish') {
        terminalGatewayError = null;
        providerAttempts += gatewayEvent.providerAttempts ?? 0;
        if (gatewayEvent.usageEventId) usageEventIds.push(gatewayEvent.usageEventId);
        if (gatewayEvent.workflowTrace) {
          workflowRunId = gatewayEvent.workflowTrace.workflowRunId;
          workflowStepId = gatewayEvent.workflowTrace.workflowStepId;
        }
      } else if (gatewayEvent.event === 'error') {
        providerAttempts += gatewayEvent.providerAttempts ?? 0;
        if (gatewayEvent.usageEventId) usageEventIds.push(gatewayEvent.usageEventId);
        workflowRunId = gatewayEvent.workflowTrace?.workflowRunId;
        workflowStepId = gatewayEvent.workflowTrace?.workflowStepId;
        terminalGatewayError = {
          code: gatewayEvent.code,
          httpStatusCode: gatewayEvent.httpStatusCode ?? null,
          retryable: gatewayEvent.retryable,
        };
      }
      yield gatewayEvent;
    }
  };

  return {
    step,
    approve,
    execute,
    provenance: () => ({
      gatewayOrigin: options.gatewayOrigin,
      catalogVersion,
      rateCardVersion,
      reservationIds: [...reservationIds],
      usageEventIds: [...usageEventIds],
      workflowRunId: workflowRunId ?? null,
      workflowStepId: workflowStepId ?? null,
      completedToolCallIds: [...completedToolCallIds],
      providerAttempts,
      terminalError: terminalGatewayError,
    }),
  };
}
