import {
  HOSTED_GENERATION_WIRE_VERSION,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HostedAiStreamStartRequest,
  HostedAiToolClaim,
} from '../../shared/hosted-ai-gateway-ipc';
import type { HostedCodexTool } from './dynamic-tool-catalog';
import {
  createHostedCodexGatewayWorkflow,
  setHostedCodexApprovalObserverForTest,
  didHostedCodexApprovalObservationFailForTest,
  type HostedCodexApprovalObservation,
} from './hosted-gateway-workflow';
import type { AcceptedResponsesRequest } from './responses-wire';

const READ_TOOL: HostedCodexTool = {
  name: 'get_workspace',
  description: 'Read the workspace.',
  inputSchema: { type: 'object' },
  effects: ['read-only'],
  requiresWorkspace: true,
};

const WRITE_TOOL: HostedCodexTool = {
  name: 'create_design',
  description: 'Create a design.',
  inputSchema: { type: 'object' },
  effects: ['mutating'],
  requiresWorkspace: true,
};

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';
afterEach(() => setHostedCodexApprovalObserverForTest(undefined));
const TOOL_TICKET_ID = '22222222-2222-4222-8222-222222222222';

function ticket(
  tool: HostedCodexTool,
  callId: string,
  requiresUserApproval = false
): Extract<HostedStreamEvent, { event: 'tool_call' }>['ticket'] {
  const payload = Buffer.from(JSON.stringify({ id: TOOL_TICKET_ID }), 'utf8').toString('base64url');
  return {
    token: `${payload}.signature`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    providerCallId: callId,
    toolName: tool.name,
    requiresUserApproval,
  };
}

type HostedEventFixture = HostedStreamEvent extends infer Event
  ? Event extends HostedStreamEvent
    ? Omit<Event, 'v' | 'requestId' | 'runId' | 'turnId' | 'stepSequence' | 'seq'> & {
        seq: number;
      }
    : never
  : never;

function event(value: HostedEventFixture): HostedStreamEvent {
  return {
    v: HOSTED_GENERATION_WIRE_VERSION,
    requestId: 'request-1',
    runId: 'run-1',
    turnId: 'turn-1',
    stepSequence: 0,
    ...value,
  } as HostedStreamEvent;
}

function toolCallFinish(seq = 1): HostedStreamEvent {
  return event({
    seq,
    event: 'finish',
    reservationId: '55555555-5555-4555-8555-555555555555',
    usageEventId: '66666666-6666-4666-8666-666666666666',
    outcome: 'completed',
    usage: {
      status: 'reported',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    workflowTrace: {
      workflowRunId: '33333333-3333-4333-8333-333333333333',
      workflowStepId: '44444444-4444-4444-8444-444444444444',
    },
    researchContributionNotice: null,
  });
}

function acceptedRequest(
  content: string,
  toolName: string,
  requestDigest: string
): AcceptedResponsesRequest {
  return {
    model: 'gpt-5-codex',
    input: [{ type: 'message', role: 'user', content }],
    toolNames: [toolName],
    maxOutputTokens: 512,
    instructions: undefined,
    promptCacheKey: undefined,
    parallelToolCalls: undefined,
    reasoning: undefined,
    include: undefined,
    forwarded: {
      model: 'gpt-5-codex',
      input: [{ type: 'message', role: 'user', content }],
      tools: [
        {
          type: 'function',
          name: toolName,
          description: 'Child-owned exact schema.',
          strict: false,
          parameters: { type: 'object' },
        },
      ],
      tool_choice: 'auto',
      max_output_tokens: 512,
      store: false,
      stream: true,
    },
    requestDigest,
  };
}

function claim(overrides: Partial<HostedAiToolClaim> = {}): HostedAiToolClaim {
  return {
    claimId: CLAIM_ID,
    status: 'claimed',
    toolTicketId: TOOL_TICKET_ID,
    toolName: WRITE_TOOL.name,
    expiresAt: '2099-01-01T00:00:00.000Z',
    version: 1,
    alreadyApplied: false,
    ...overrides,
  };
}

describe('createHostedCodexGatewayWorkflow', () => {
  it('checks the final projected Hosted request size before gateway egress', async () => {
    const stream = vi.fn(async function* () {
      yield toolCallFinish();
    });
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'auto',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream,
      callLocalTool: vi.fn(),
      requestUserApproval: vi.fn(),
      recordObservation: vi.fn(),
      claimTool: vi.fn(),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    const accepted = acceptedRequest('x'.repeat(2_097_152), 'get_workspace', 'digest');
    await expect(
      (async () => {
        for await (const _event of workflow.step(accepted)) {
        }
      })()
    ).rejects.toThrow(/size limit/i);
    expect(stream).not.toHaveBeenCalled();
  });
  it('forwards a child-owned call without registering DNAForge execution authority', async () => {
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'auto',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'child_tool_call',
          toolCallId: 'call-child',
          name: 'exec_command',
          input: { cmd: 'pwd' },
        });
      },
      callLocalTool: vi.fn(),
      requestUserApproval: vi.fn(),
      recordObservation: vi.fn(),
      claimTool: vi.fn(),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });

    const forwarded: HostedStreamEvent[] = [];
    for await (const gatewayEvent of workflow.step(
      acceptedRequest('Inspect.', READ_TOOL.name, 'a'.repeat(64))
    )) {
      forwarded.push(gatewayEvent);
    }
    expect(forwarded).toMatchObject([{ event: 'child_tool_call', name: 'exec_command' }]);
    await expect(
      workflow.execute(READ_TOOL, { callId: 'call-child', name: READ_TOOL.name, input: {} })
    ).rejects.toThrow(/No signed gateway ticket/u);
  });

  it('streams a signed read tool, executes it through the shared bridge, and records observation', async () => {
    const streamedRequests: HostedAiStreamStartRequest[] = [];
    const runtimeIdentity = {
      workflowId: 'workflow-1',
      runId: 'run-1',
      turnId: 'turn-1',
      prompt: 'must not cross the identity boundary',
    };
    const recordObservation = vi.fn().mockResolvedValue({
      ok: true,
      receipt: {
        ticketId: '22222222-2222-4222-8222-222222222222',
        workflowRunId: '33333333-3333-4333-8333-333333333333',
        workflowStepId: '44444444-4444-4444-8444-444444444444',
        providerCallId: 'call-read',
        toolName: READ_TOOL.name,
      },
    });
    const callLocalTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { files: ['pUC19.gb'] },
      effectReceiptRef: 'audit-read',
    });
    const workflow = createHostedCodexGatewayWorkflow({
      identity: runtimeIdentity,
      tier: 'auto',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* (request) {
        streamedRequests.push(request);
        yield event({
          seq: 0,
          event: 'accepted',
          reservationId: '55555555-5555-4555-8555-555555555555',
          tier: 'auto',
          catalogVersion: 'catalog-1',
          rateCardVersion: 'rates-1',
        });
        yield event({
          seq: 1,
          event: 'tool_call',
          toolCallId: 'call-read',
          name: READ_TOOL.name,
          input: {},
          ticket: ticket(READ_TOOL, 'call-read'),
        });
        yield event({
          seq: 2,
          event: 'finish',
          reservationId: '55555555-5555-4555-8555-555555555555',
          usageEventId: '66666666-6666-4666-8666-666666666666',
          outcome: 'completed',
          usage: {
            status: 'reported',
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          workflowTrace: {
            workflowRunId: '33333333-3333-4333-8333-333333333333',
            workflowStepId: '44444444-4444-4444-8444-444444444444',
          },
          researchContributionNotice: null,
        });
      },
      callLocalTool,
      requestUserApproval: vi.fn(),
      recordObservation,
      claimTool: vi.fn(),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });

    const streamed: HostedStreamEvent[] = [];
    for await (const item of workflow.step(
      acceptedRequest('Inspect.', READ_TOOL.name, 'a'.repeat(64))
    )) {
      streamed.push(item);
    }
    expect(streamed.map((item) => item.event)).toEqual(['accepted', 'tool_call', 'finish']);
    expect(streamedRequests).toHaveLength(1);
    expect(streamedRequests[0]).toMatchObject({
      route: 'responses',
      request: {
        input: [{ type: 'message', role: 'user', content: 'Inspect.' }],
        tools: [expect.objectContaining({ type: 'function', name: READ_TOOL.name })],
        toolChoice: { type: 'auto' },
      },
    });
    expect(streamedRequests[0].request).not.toHaveProperty('prompt');
    expect(streamedRequests[0].request).not.toHaveProperty('model');

    const executed = await workflow.execute(READ_TOOL, {
      callId: 'call-read',
      name: READ_TOOL.name,
      input: {},
    });
    expect(executed).toEqual({ outcome: 'no_effect', output: { files: ['pUC19.gb'] } });
    expect(callLocalTool).toHaveBeenCalledWith({
      turnId: 'turn-1',
      toolName: READ_TOOL.name,
      input: {},
      actionId: 'call-read',
      effects: ['read-only'],
    });
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: ticket(READ_TOOL, 'call-read').token,
        argumentsPayload: {},
        observationPayload: { ok: true, result: { files: ['pUC19.gb'] } },
      })
    );
    expect(workflow.provenance()).toEqual({
      gatewayOrigin: 'https://hosted.dnaforge.com',
      catalogVersion: 'catalog-1',
      rateCardVersion: 'rates-1',
      reservationIds: ['55555555-5555-4555-8555-555555555555'],
      usageEventIds: ['66666666-6666-4666-8666-666666666666'],
      workflowRunId: '33333333-3333-4333-8333-333333333333',
      workflowStepId: '44444444-4444-4444-8444-444444444444',
      completedToolCallIds: ['call-read'],
      providerAttempts: 0,
      terminalError: null,
    });
  });

  it.each([
    ['tool ticket id', { ticketId: '99999999-9999-4999-8999-999999999999' }],
    ['workflow run id', { workflowRunId: '99999999-9999-4999-8999-999999999999' }],
    ['workflow step id', { workflowStepId: '99999999-9999-4999-8999-999999999999' }],
  ])('rejects an observation receipt with the wrong %s', async (_label, mismatch) => {
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'auto',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-read',
          name: READ_TOOL.name,
          input: {},
          ticket: ticket(READ_TOOL, 'call-read'),
        });
        yield toolCallFinish();
      },
      callLocalTool: vi.fn().mockResolvedValue({
        ok: true,
        result: { files: ['pUC19.gb'] },
        effectReceiptRef: 'audit-read',
      }),
      requestUserApproval: vi.fn(),
      recordObservation: vi.fn().mockResolvedValue({
        ok: true,
        receipt: {
          ticketId: TOOL_TICKET_ID,
          workflowRunId: '33333333-3333-4333-8333-333333333333',
          workflowStepId: '44444444-4444-4444-8444-444444444444',
          providerCallId: 'call-read',
          toolName: READ_TOOL.name,
          ...mismatch,
        },
      }),
      claimTool: vi.fn(),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Inspect.', READ_TOOL.name, 'a'.repeat(64))
    )) {
      continue;
    }

    await expect(
      workflow.execute(READ_TOOL, { callId: 'call-read', name: READ_TOOL.name, input: {} })
    ).rejects.toMatchObject({ code: 'tool_observation_mismatch' });
  });

  it.each(['provider_stream_failed', 'cancelled'])(
    'preserves authoritative workflow provenance for %s terminal events',
    async (code) => {
      const workflowTrace = {
        workflowRunId: '33333333-3333-4333-8333-333333333333',
        workflowStepId: '44444444-4444-4444-8444-444444444444',
      };
      const workflow = createHostedCodexGatewayWorkflow({
        identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
        tier: 'auto',
        gatewayOrigin: 'https://hosted.dnaforge.com',
        turnBindingToken: 'binding-1',
        workspaceOpen: true,
        stagedReferenceIds: [],
        stream: async function* () {
          yield event({
            seq: 0,
            event: 'accepted',
            reservationId: '55555555-5555-4555-8555-555555555555',
            tier: 'auto',
            catalogVersion: 'catalog-1',
            rateCardVersion: 'rates-1',
            workflowTrace,
          });
          yield event({
            seq: 1,
            event: 'error',
            reservationId: '55555555-5555-4555-8555-555555555555',
            usageEventId: '66666666-6666-4666-8666-666666666666',
            code,
            message: 'Safe fixed message.',
            retryable: false,
            reservationDisposition: 'settled',
            providerAttempts: 1,
            workflowTrace,
          });
        },
        callLocalTool: vi.fn(),
        requestUserApproval: vi.fn(),
        recordObservation: vi.fn(),
        claimTool: vi.fn(),
        completeToolClaim: vi.fn(),
        cancelToolClaim: vi.fn(),
        idGenerator: () => 'request-1',
      });
      for await (const observed of workflow.step(
        acceptedRequest('Run the bounded fault.', READ_TOOL.name, 'a'.repeat(64))
      )) {
        if (observed.event === 'accepted') {
          expect(workflow.provenance()).toMatchObject(workflowTrace);
        }
      }
      expect(workflow.provenance()).toMatchObject({
        ...workflowTrace,
        usageEventIds: ['66666666-6666-4666-8666-666666666666'],
        providerAttempts: 1,
        terminalError: { code, httpStatusCode: null, retryable: false },
      });
    }
  );

  it('retains only the safe terminal gateway diagnostic for the desktop banner', async () => {
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'auto',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'error',
          reservationId: '55555555-5555-4555-8555-555555555555',
          code: 'provider_service_unavailable',
          message: 'Safe fixed message.',
          httpStatusCode: 503,
          retryable: true,
          reservationDisposition: 'settled',
        });
      },
      callLocalTool: vi.fn(),
      requestUserApproval: vi.fn(),
      recordObservation: vi.fn(),
      claimTool: vi.fn(),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });

    for await (const _event of workflow.step(
      acceptedRequest('Continue.', READ_TOOL.name, 'a'.repeat(64))
    )) {
      continue;
    }
    expect(workflow.provenance().terminalError).toEqual({
      code: 'provider_service_unavailable',
      httpStatusCode: 503,
      retryable: true,
    });
  });

  it('clears a recovered gateway error when a later step succeeds', async () => {
    let responseSequence = 0;
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'auto',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        responseSequence += 1;
        yield event({
          seq: 0,
          event: 'accepted',
          reservationId: `${responseSequence}5555555-5555-4555-8555-555555555555`,
          tier: 'auto',
          catalogVersion: 'catalog-1',
          rateCardVersion: 'rates-1',
        });
        if (responseSequence === 1) {
          yield event({
            seq: 1,
            event: 'error',
            reservationId: '15555555-5555-4555-8555-555555555555',
            code: 'provider_service_unavailable',
            message: 'Safe fixed message.',
            httpStatusCode: 503,
            retryable: true,
            reservationDisposition: 'settled',
          });
          return;
        }
        yield event({
          seq: 1,
          event: 'finish',
          reservationId: '25555555-5555-4555-8555-555555555555',
          usageEventId: null,
          outcome: 'completed',
          usage: {
            status: 'reported',
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          finishReason: { unified: 'stop', raw: 'stop' },
          workflowTrace: null,
          researchContributionNotice: null,
        });
      },
      callLocalTool: vi.fn(),
      requestUserApproval: vi.fn(),
      recordObservation: vi.fn(),
      claimTool: vi.fn(),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => `request-${responseSequence + 1}`,
    });

    for await (const _event of workflow.step(
      acceptedRequest('First attempt.', READ_TOOL.name, 'a'.repeat(64))
    )) {
      continue;
    }
    expect(workflow.provenance().terminalError?.code).toBe('provider_service_unavailable');

    for await (const _event of workflow.step(
      acceptedRequest('Recovered attempt.', READ_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }
    expect(workflow.provenance().terminalError).toBeNull();
  });

  it('claims a mutation before the renderer effect and completes it with the renderer audit receipt', async () => {
    const approvals: HostedCodexApprovalObservation[] = [];
    setHostedCodexApprovalObserverForTest((observation) => {
      approvals.push(structuredClone(observation));
      Object.assign(observation.request, { actionId: 'observer-changed-call' });
      throw new Error('diagnostic observer failure');
    });
    const order: string[] = [];
    const requestUserApproval = vi.fn(async () => {
      order.push('approve');
      return true;
    });
    const claimTool = vi.fn(async () => {
      order.push('claim');
      return { ok: true as const, claim: claim() };
    });
    const completeToolClaim = vi.fn(async () => {
      order.push('complete');
      return { ok: true as const, claim: claim({ status: 'completed' }) };
    });
    const recordObservation = vi.fn(async () => {
      order.push('observe');
      return {
        ok: true as const,
        receipt: {
          ticketId: '22222222-2222-4222-8222-222222222222',
          workflowRunId: '33333333-3333-4333-8333-333333333333',
          workflowStepId: '44444444-4444-4444-8444-444444444444',
          providerCallId: 'call-write',
          toolName: WRITE_TOOL.name,
        },
      };
    });
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', true),
        });
        yield toolCallFinish();
      },
      callLocalTool: async () => {
        order.push('effect');
        return { ok: true, result: { designId: 'design-1' }, effectReceiptRef: 'audit-write' };
      },
      requestUserApproval,
      recordObservation,
      claimTool,
      completeToolClaim,
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }

    expect(
      await workflow.approve(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).toBe('approved');
    const result = await workflow.execute(WRITE_TOOL, {
      callId: 'call-write',
      name: WRITE_TOOL.name,
      input: { name: 'design-1' },
    });

    expect(result).toEqual({ outcome: 'applied', output: { designId: 'design-1' } });
    expect(order).toEqual(['approve', 'claim', 'effect', 'complete', 'observe']);
    const expectedApproval = {
      turnId: 'turn-1',
      toolName: WRITE_TOOL.name,
      input: { name: 'design-1' },
      actionId: 'call-write',
      effects: ['mutating'],
    };
    expect(approvals).toEqual([
      { kind: 'requested', request: expectedApproval },
      { kind: 'resolved', request: expectedApproval, approved: true },
    ]);
    expect(didHostedCodexApprovalObservationFailForTest()).toBe(true);
    expect(requestUserApproval).toHaveBeenCalledWith({
      turnId: 'turn-1',
      toolName: WRITE_TOOL.name,
      input: { name: 'design-1' },
      actionId: 'call-write',
      effects: ['mutating'],
    });
    expect(claimTool).toHaveBeenCalledWith(
      expect.objectContaining({ approvalReceiptRef: expect.stringMatching(/^user-approved:/u) })
    );
    expect(completeToolClaim).toHaveBeenCalledWith(
      expect.objectContaining({ effectReceiptRef: 'audit-write' })
    );
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: claim().claimId })
    );
  });

  it('rejects a claim response for a different signed tool ticket before local execution', async () => {
    const callLocalTool = vi.fn();
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', true),
        });
        yield toolCallFinish();
      },
      callLocalTool,
      requestUserApproval: vi.fn().mockResolvedValue(true),
      recordObservation: vi.fn(),
      claimTool: vi.fn().mockResolvedValue({
        ok: true,
        claim: claim({ toolTicketId: '33333333-3333-4333-8333-333333333333' }),
      }),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }

    await expect(
      workflow.approve(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).rejects.toMatchObject({ code: 'mutation_claim_mismatch' });
    expect(callLocalTool).not.toHaveBeenCalled();
  });

  it.each([
    ['claim id', { claimId: '33333333-3333-4333-8333-333333333333' }],
    ['tool ticket id', { toolTicketId: '33333333-3333-4333-8333-333333333333' }],
  ])('rejects a completion response with the wrong %s', async (_label, mismatch) => {
    const recordObservation = vi.fn();
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', true),
        });
      },
      callLocalTool: vi.fn().mockResolvedValue({
        ok: true,
        result: { designId: 'design-1' },
        effectReceiptRef: 'audit-write',
      }),
      requestUserApproval: vi.fn().mockResolvedValue(true),
      recordObservation,
      claimTool: vi.fn().mockResolvedValue({ ok: true, claim: claim() }),
      completeToolClaim: vi.fn().mockResolvedValue({
        ok: true,
        claim: claim({ status: 'completed', ...mismatch }),
      }),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }
    await workflow.approve(WRITE_TOOL, {
      callId: 'call-write',
      name: WRITE_TOOL.name,
      input: { name: 'design-1' },
    });

    await expect(
      workflow.execute(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).rejects.toMatchObject({ code: 'mutation_completion_mismatch' });
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it.each([
    ['claim id', { claimId: '33333333-3333-4333-8333-333333333333' }],
    ['tool ticket id', { toolTicketId: '33333333-3333-4333-8333-333333333333' }],
  ])('rejects a cancellation response with the wrong %s', async (_label, mismatch) => {
    const recordObservation = vi.fn();
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', true),
        });
      },
      callLocalTool: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'TOOL_FAILED', message: 'Failed before effect.', retriable: false },
      }),
      requestUserApproval: vi.fn().mockResolvedValue(true),
      recordObservation,
      claimTool: vi.fn().mockResolvedValue({ ok: true, claim: claim() }),
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn().mockResolvedValue({
        ok: true,
        claim: claim({ status: 'canceled', ...mismatch }),
      }),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }
    await workflow.approve(WRITE_TOOL, {
      callId: 'call-write',
      name: WRITE_TOOL.name,
      input: { name: 'design-1' },
    });

    await expect(
      workflow.execute(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).rejects.toMatchObject({ code: 'mutation_cancellation_mismatch' });
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it.each([
    ['verified no effect', { stateChanged: false, partialEffects: [] }, false],
    ['empty list without a state guarantee', { partialEffects: [] }, true],
    ['reported change', { stateChanged: true, partialEffects: [] }, true],
    ['unknown state', { stateChanged: 'unknown', partialEffects: [] }, true],
    ['reported partial effect', { stateChanged: false, partialEffects: ['published'] }, true],
    [
      'possible change',
      { stateChanged: false, stateMayHaveChanged: true, partialEffects: [] },
      true,
    ],
  ] as const)(
    'preserves the claim boundary for a structured mutation failure: %s',
    async (_label, details, unresolved) => {
      const error = {
        code: 'PREVIEW_STALE',
        message: 'The reviewed preview is stale.',
        retriable: false,
        details,
      };
      const completeToolClaim = vi.fn();
      const cancelToolClaim = vi
        .fn()
        .mockResolvedValue({ ok: true, claim: claim({ status: 'canceled' }) });
      const recordObservation = vi.fn().mockResolvedValue({
        ok: true,
        receipt: {
          ticketId: TOOL_TICKET_ID,
          workflowRunId: '33333333-3333-4333-8333-333333333333',
          workflowStepId: '44444444-4444-4444-8444-444444444444',
          providerCallId: 'call-write',
          toolName: WRITE_TOOL.name,
        },
      });
      const workflow = createHostedCodexGatewayWorkflow({
        identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
        tier: 'deep',
        gatewayOrigin: 'https://hosted.dnaforge.com',
        turnBindingToken: 'binding-1',
        workspaceOpen: true,
        stagedReferenceIds: [],
        stream: async function* () {
          yield event({
            seq: 0,
            event: 'tool_call',
            toolCallId: 'call-write',
            name: WRITE_TOOL.name,
            input: { name: 'design-1' },
            ticket: ticket(WRITE_TOOL, 'call-write', true),
          });
          yield toolCallFinish();
        },
        callLocalTool: vi.fn().mockResolvedValue({ ok: false, error }),
        requestUserApproval: vi.fn().mockResolvedValue(true),
        recordObservation,
        claimTool: vi.fn().mockResolvedValue({ ok: true, claim: claim() }),
        completeToolClaim,
        cancelToolClaim,
        idGenerator: () => 'request-1',
      });
      for await (const _event of workflow.step(
        acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
      )) {
        continue;
      }
      const request = { callId: 'call-write', name: WRITE_TOOL.name, input: { name: 'design-1' } };
      await expect(workflow.approve(WRITE_TOOL, request)).resolves.toBe('approved');
      if (unresolved) {
        await expect(workflow.execute(WRITE_TOOL, request)).rejects.toMatchObject({
          code: 'mutation_outcome_unknown',
        });
        expect(cancelToolClaim).not.toHaveBeenCalled();
        expect(recordObservation).not.toHaveBeenCalled();
      } else {
        await expect(workflow.execute(WRITE_TOOL, request)).resolves.toEqual({
          outcome: 'no_effect',
          output: { error },
        });
        expect(cancelToolClaim).toHaveBeenCalledWith(
          expect.objectContaining({ claimId: CLAIM_ID, reason: 'pre_effect_failure' })
        );
        expect(recordObservation).toHaveBeenCalledWith(
          expect.objectContaining({ observationPayload: { ok: false, error } })
        );
      }
      expect(completeToolClaim).not.toHaveBeenCalled();
    }
  );

  it('leaves a claimed mutation unresolved when local execution cannot prove its outcome', async () => {
    const completeToolClaim = vi.fn();
    const cancelToolClaim = vi.fn();
    const recordObservation = vi.fn();
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', true),
        });
      },
      callLocalTool: vi.fn().mockRejectedValue(new Error('mutation outcome unknown')),
      requestUserApproval: vi.fn().mockResolvedValue(true),
      recordObservation,
      claimTool: vi.fn().mockResolvedValue({ ok: true, claim: claim() }),
      completeToolClaim,
      cancelToolClaim,
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }

    await expect(
      workflow.approve(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).resolves.toBe('approved');
    await expect(
      workflow.execute(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).rejects.toThrow('mutation outcome unknown');
    expect(completeToolClaim).not.toHaveBeenCalled();
    expect(cancelToolClaim).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it('records an explicit decline and never claims or executes the mutation', async () => {
    const decisions: boolean[] = [];
    setHostedCodexApprovalObserverForTest((observation) => {
      if (observation.kind !== 'resolved') return;
      decisions.push(observation.approved);
      Object.assign(observation, { approved: true });
    });
    const claimTool = vi.fn();
    const callLocalTool = vi.fn();
    const recordObservation = vi.fn().mockResolvedValue({
      ok: true,
      receipt: {
        ticketId: '22222222-2222-4222-8222-222222222222',
        workflowRunId: '33333333-3333-4333-8333-333333333333',
        workflowStepId: '44444444-4444-4444-8444-444444444444',
        providerCallId: 'call-write',
        toolName: WRITE_TOOL.name,
      },
    });
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', true),
        });
        yield toolCallFinish();
      },
      callLocalTool,
      requestUserApproval: vi.fn().mockResolvedValue(false),
      recordObservation,
      claimTool,
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }

    await expect(
      workflow.approve(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).resolves.toBe('declined');
    expect(decisions).toEqual([false]);
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observationPayload: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'USER_DECLINED' }),
        }),
      })
    );
    expect(claimTool).not.toHaveBeenCalled();
    expect(callLocalTool).not.toHaveBeenCalled();
    await expect(
      workflow.execute(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).rejects.toMatchObject({ code: 'tool_ticket_replayed' });
  });

  it('fails closed when the renderer approval transport is unavailable', async () => {
    const claimTool = vi.fn();
    const callLocalTool = vi.fn();
    const recordObservation = vi.fn().mockResolvedValue({
      ok: true,
      receipt: {
        ticketId: '22222222-2222-4222-8222-222222222222',
        workflowRunId: '33333333-3333-4333-8333-333333333333',
        workflowStepId: '44444444-4444-4444-8444-444444444444',
        providerCallId: 'call-write',
        toolName: WRITE_TOOL.name,
      },
    });
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      tier: 'deep',
      gatewayOrigin: 'https://hosted.dnaforge.com',
      turnBindingToken: 'binding-1',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: async function* () {
        yield event({
          seq: 0,
          event: 'tool_call',
          toolCallId: 'call-write',
          name: WRITE_TOOL.name,
          input: { name: 'design-1' },
          ticket: ticket(WRITE_TOOL, 'call-write', false),
        });
        yield toolCallFinish();
      },
      callLocalTool,
      requestUserApproval: vi.fn().mockRejectedValue(new Error('renderer unavailable')),
      recordObservation,
      claimTool,
      completeToolClaim: vi.fn(),
      cancelToolClaim: vi.fn(),
      idGenerator: () => 'request-1',
    });
    for await (const _event of workflow.step(
      acceptedRequest('Create it.', WRITE_TOOL.name, 'b'.repeat(64))
    )) {
      continue;
    }

    await expect(
      workflow.approve(WRITE_TOOL, {
        callId: 'call-write',
        name: WRITE_TOOL.name,
        input: { name: 'design-1' },
      })
    ).resolves.toBe('declined');
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observationPayload: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'USER_DECLINED' }),
        }),
      })
    );
    expect(claimTool).not.toHaveBeenCalled();
    expect(callLocalTool).not.toHaveBeenCalled();
  });
});
