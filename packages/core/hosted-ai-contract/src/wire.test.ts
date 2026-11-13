import { describe, expect, it } from 'vitest';
import {
  HostedGenerateRequestSchema,
  HostedStreamEventSchema,
  MAX_HOSTED_GENERATE_REQUEST_BYTES,
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  type HostedGenerateRequest,
  type HostedStreamEvent,
} from './wire.js';

const WORKFLOW_RUN_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_STEP_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_REF = `ws_h1_${'a'.repeat(64)}`;
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';
const USAGE_EVENT_ID = '44444444-4444-4444-8444-444444444444';

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 2,
    tier: 'auto',
    workflowId: 'conversation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    stepSequence: 1,
    workflowRunId: WORKFLOW_RUN_ID,
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'You are DNAForge.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Inspect the workspace.' }] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'I should inspect it.',
            providerOptions: {
              openai: {
                itemId: 'rs_1',
                reasoningEncryptedContent: 'encrypted-reasoning',
              },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_workspace',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'get_workspace',
            output: { type: 'json', value: { folders: [] } },
            ticket: 'eyJ2IjoxfQ.signature',
          },
        ],
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'The workspace is empty.' }],
      },
    ],
    toolNames: ['get_workspace', 'read_file'],
    toolChoice: { type: 'tool', toolName: 'get_workspace' },
    maxOutputTokens: 2_048,
    traceContext: {
      source: 'desktop_chat',
      workspaceOpen: true,
      stagedReferenceIds: ['reference-1'],
    },
    ...overrides,
  };
}

function streamBase() {
  return {
    v: 2 as const,
    seq: 0,
    requestId: 'request-1',
    runId: 'run-1',
    turnId: 'turn-1',
    stepSequence: 1,
  };
}

describe('HostedGenerateRequestSchema', () => {
  it('uses the authoritative Hosted whole-request byte limit', () => {
    expect(MAX_HOSTED_GENERATE_REQUEST_BYTES).toBe(MAX_HOSTED_WHOLE_REQUEST_BYTES);
    expect(MAX_HOSTED_WHOLE_REQUEST_BYTES).toBe(2 * 1024 * 1024);
  });

  it('accepts the supported structured LanguageModelV3 prompt subset', () => {
    const parsed = HostedGenerateRequestSchema.parse(request()) as HostedGenerateRequest;
    expect(parsed.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(parsed.toolChoice).toEqual({ type: 'tool', toolName: 'get_workspace' });
  });

  it.each([
    ['an unknown root field', { surprise: true }],
    ['an unsupported version', { version: 1 }],
    ['a negative step', { stepSequence: -1 }],
    ['an invalid workflow run id', { workflowRunId: 'run-from-renderer' }],
    ['an empty prompt', { messages: [] }],
    ['duplicate tool names', { toolNames: ['get_workspace', 'get_workspace'] }],
    [
      'a forced tool outside the server-owned subset',
      { toolNames: ['get_workspace'], toolChoice: { type: 'tool', toolName: 'read_file' } },
    ],
    [
      'an arbitrary trace source',
      { traceContext: { source: 'telemetry', workspaceOpen: true, stagedReferenceIds: [] } },
    ],
  ])('rejects %s', (_name, override) => {
    expect(HostedGenerateRequestSchema.safeParse(request(override)).success).toBe(false);
  });

  it('rejects message parts that do not belong to their role', () => {
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_workspace', input: {} },
              ],
            },
          ],
        })
      ).success
    ).toBe(false);

    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'assistant',
              parts: [
                {
                  type: 'tool-result',
                  toolCallId: 'call_1',
                  toolName: 'get_workspace',
                  output: { type: 'execution-denied', reason: 'Provider execution is disabled.' },
                },
              ],
            },
          ],
        })
      ).success
    ).toBe(false);
  });

  it('accepts historical tool results without tickets and current results with signed tickets', () => {
    expect(HostedGenerateRequestSchema.safeParse(request()).success).toBe(true);
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'tool',
              parts: [
                {
                  type: 'tool-result',
                  toolCallId: 'historical-call',
                  toolName: 'get_workspace',
                  output: { type: 'json', value: { folders: [] } },
                },
              ],
            },
          ],
        })
      ).success
    ).toBe(true);
  });

  it('rejects malformed tool-result tickets', () => {
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'tool',
              parts: [
                {
                  type: 'tool-result',
                  toolCallId: 'call_1',
                  toolName: 'get_workspace',
                  output: { type: 'json', value: { folders: [] } },
                  ticket: 'unsigned',
                },
              ],
            },
          ],
        })
      ).success
    ).toBe(false);
  });

  it('requires a signed ticket whenever a completed mutation claim is attached', () => {
    const mutationClaimId = '55555555-5555-4555-8555-555555555555';
    const toolResult = {
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'create_design',
      output: { type: 'json', value: { designId: 'design-1' } },
      mutationClaimId,
    };
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({ messages: [{ role: 'tool', parts: [toolResult] }] })
      ).success
    ).toBe(false);
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'tool',
              parts: [{ ...toolResult, ticket: 'eyJ2IjoyfQ.signature' }],
            },
          ],
        })
      ).success
    ).toBe(true);
  });

  it('rejects unknown fields inside every structured boundary', () => {
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello', extra: 1 }] }],
        })
      ).success
    ).toBe(false);
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'assistant',
              parts: [
                {
                  type: 'reasoning',
                  text: 'thinking',
                  providerOptions: { openai: { itemId: 'rs_1', rawResponse: 'forbidden' } },
                },
              ],
            },
          ],
        })
      ).success
    ).toBe(false);
  });

  it('rejects non-JSON values even when they sit under tool input or output', () => {
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'assistant',
              parts: [
                { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_workspace', input: 1n },
              ],
            },
          ],
        })
      ).success
    ).toBe(false);
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({
          messages: [
            {
              role: 'tool',
              parts: [
                {
                  type: 'tool-result',
                  toolCallId: 'call_1',
                  toolName: 'get_workspace',
                  output: { type: 'json', value: Number.NaN },
                },
              ],
            },
          ],
        })
      ).success
    ).toBe(false);
  });

  it('enforces the aggregate two MiB request cap in UTF-8 bytes', () => {
    const overhead = JSON.stringify(request({ messages: [] })).length;
    const exactlyTooLarge = 'x'.repeat(MAX_HOSTED_GENERATE_REQUEST_BYTES - overhead + 1_024);
    expect(
      HostedGenerateRequestSchema.safeParse(
        request({ messages: [{ role: 'user', parts: [{ type: 'text', text: exactlyTooLarge }] }] })
      ).success
    ).toBe(false);
  });
});

describe('HostedStreamEventSchema', () => {
  it('accepts authoritative, null, and legacy-omitted workflow traces on accepted events', () => {
    const accepted = {
      ...streamBase(),
      event: 'accepted',
      reservationId: RESERVATION_ID,
      tier: 'auto',
      catalogVersion: 'catalog-v1',
      rateCardVersion: 'rate-v1',
    } as const;

    expect(
      HostedStreamEventSchema.parse({
        ...accepted,
        workflowTrace: {
          workflowRunId: WORKFLOW_RUN_ID,
          workflowStepId: WORKFLOW_STEP_ID,
          workspaceRef: WORKSPACE_REF,
        },
      })
    ).toMatchObject({
      event: 'accepted',
      workflowTrace: {
        workflowRunId: WORKFLOW_RUN_ID,
        workflowStepId: WORKFLOW_STEP_ID,
        workspaceRef: WORKSPACE_REF,
      },
    });
    expect(HostedStreamEventSchema.safeParse({ ...accepted, workflowTrace: null }).success).toBe(
      true
    );
    expect(HostedStreamEventSchema.safeParse(accepted).success).toBe(true);
  });

  it('accepts authoritative, null, and legacy-omitted workflow traces on terminal errors', () => {
    const terminalError = {
      ...streamBase(),
      event: 'error',
      reservationId: RESERVATION_ID,
      code: 'provider_error',
      message: 'DNAForge AI could not complete this model step.',
      retryable: true,
      reservationDisposition: 'settled',
    } as const;

    expect(
      HostedStreamEventSchema.parse({
        ...terminalError,
        workflowTrace: {
          workflowRunId: WORKFLOW_RUN_ID,
          workflowStepId: WORKFLOW_STEP_ID,
          workspaceRef: WORKSPACE_REF,
        },
      })
    ).toMatchObject({
      event: 'error',
      workflowTrace: {
        workflowRunId: WORKFLOW_RUN_ID,
        workflowStepId: WORKFLOW_STEP_ID,
        workspaceRef: WORKSPACE_REF,
      },
    });
    expect(
      HostedStreamEventSchema.safeParse({ ...terminalError, workflowTrace: null }).success
    ).toBe(true);
    expect(HostedStreamEventSchema.safeParse(terminalError).success).toBe(true);
  });

  it('accepts the ordered server-owned event vocabulary', () => {
    const events: HostedStreamEvent[] = [
      HostedStreamEventSchema.parse({
        ...streamBase(),
        event: 'accepted',
        reservationId: RESERVATION_ID,
        tier: 'auto',
        catalogVersion: 'catalog-v1',
        rateCardVersion: 'rate-v1',
      }),
      HostedStreamEventSchema.parse({
        ...streamBase(),
        seq: 1,
        event: 'text_delta',
        delta: 'Hello',
      }),
      HostedStreamEventSchema.parse({
        ...streamBase(),
        seq: 2,
        event: 'reasoning_delta',
        summary: true,
        delta: 'Inspecting',
      }),
      HostedStreamEventSchema.parse({
        ...streamBase(),
        seq: 3,
        event: 'reasoning_continuation',
        itemId: 'rs_1',
        encryptedContent: 'encrypted',
      }),
      HostedStreamEventSchema.parse({
        ...streamBase(),
        seq: 4,
        event: 'child_tool_call',
        toolCallId: 'call_child_1',
        name: 'exec_command',
        input: { cmd: 'pwd' },
      }),
      HostedStreamEventSchema.parse({
        ...streamBase(),
        seq: 5,
        event: 'tool_call',
        toolCallId: 'call_1',
        name: 'get_workspace',
        input: {},
        ticket: {
          token: 'eyJ2IjoxfQ.signature',
          expiresAt: '2026-08-13T20:00:00.000Z',
          providerCallId: 'call_1',
          toolName: 'get_workspace',
          requiresUserApproval: false,
        },
      }),
      HostedStreamEventSchema.parse({
        ...streamBase(),
        seq: 6,
        event: 'finish',
        reservationId: RESERVATION_ID,
        usageEventId: USAGE_EVENT_ID,
        outcome: 'completed',
        usage: {
          status: 'reported',
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          reasoningTokens: 3,
        },
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        workflowTrace: {
          workflowRunId: WORKFLOW_RUN_ID,
          workflowStepId: WORKFLOW_STEP_ID,
          workspaceRef: WORKSPACE_REF,
        },
        researchContributionNotice: {
          showNotice: true,
          noticeText:
            'DNAForge AI is offered in accordance with our Terms of Service and Privacy Policy.',
          termsUrl: 'https://www.dnaforge.com/terms',
          privacyUrl: 'https://www.dnaforge.com/privacy',
        },
      }),
    ];
    expect(events.map((event) => event.event)).toEqual([
      'accepted',
      'text_delta',
      'reasoning_delta',
      'reasoning_continuation',
      'child_tool_call',
      'tool_call',
      'finish',
    ]);
  });

  it('requires an atomic non-empty provider reasoning continuation pair', () => {
    const valid = {
      ...streamBase(),
      event: 'reasoning_continuation',
      itemId: 'rs_provider_1',
      encryptedContent: 'encrypted-provider-reasoning',
    };

    expect(HostedStreamEventSchema.safeParse(valid).success).toBe(true);
    expect(HostedStreamEventSchema.safeParse({ ...valid, itemId: undefined }).success).toBe(false);
    expect(
      HostedStreamEventSchema.safeParse({ ...valid, encryptedContent: undefined }).success
    ).toBe(false);
    expect(HostedStreamEventSchema.safeParse({ ...valid, itemId: '' }).success).toBe(false);
    expect(HostedStreamEventSchema.safeParse({ ...valid, encryptedContent: '' }).success).toBe(
      false
    );
    expect(HostedStreamEventSchema.safeParse({ ...valid, encryptedContent: null }).success).toBe(
      false
    );
    expect(HostedStreamEventSchema.safeParse({ ...valid, hidden: true }).success).toBe(false);
  });

  it('accepts only the server-derived opaque workspace scope in workflow traces', () => {
    const result = HostedStreamEventSchema.safeParse({
      ...streamBase(),
      event: 'finish',
      reservationId: RESERVATION_ID,
      usageEventId: USAGE_EVENT_ID,
      outcome: 'completed',
      usage: {
        status: 'reported',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      finishReason: { unified: 'stop', raw: 'stop' },
      workflowTrace: {
        workflowRunId: WORKFLOW_RUN_ID,
        workflowStepId: WORKFLOW_STEP_ID,
        workspaceRef: '/Users/example/private-workspace',
      },
      researchContributionNotice: null,
    });
    expect(result.success).toBe(false);
  });

  it('requires the signed ticket metadata to match the emitted tool call', () => {
    const result = HostedStreamEventSchema.safeParse({
      ...streamBase(),
      event: 'tool_call',
      toolCallId: 'call_1',
      name: 'get_workspace',
      input: {},
      ticket: {
        token: 'payload.signature',
        expiresAt: '2026-08-13T20:00:00.000Z',
        providerCallId: 'call_2',
        toolName: 'get_workspace',
        requiresUserApproval: false,
      },
    });
    expect(result.success).toBe(false);
  });

  it('keeps DNAForge tool authority strict while child-owned calls carry no ticket', () => {
    expect(
      HostedStreamEventSchema.safeParse({
        ...streamBase(),
        event: 'tool_call',
        toolCallId: 'call_1',
        name: 'get_workspace',
        input: {},
      }).success
    ).toBe(false);
    expect(
      HostedStreamEventSchema.safeParse({
        ...streamBase(),
        event: 'child_tool_call',
        toolCallId: 'call_2',
        name: 'exec_command',
        input: { cmd: 'pwd' },
      }).success
    ).toBe(true);
    expect(
      HostedStreamEventSchema.safeParse({
        ...streamBase(),
        event: 'child_tool_call',
        toolCallId: 'call_2',
        name: 'exec_command',
        input: { cmd: 'pwd' },
        ticket: {
          token: 'payload.signature',
          expiresAt: '2026-08-13T20:00:00.000Z',
          providerCallId: 'call_2',
          toolName: 'exec_command',
          requiresUserApproval: false,
        },
      }).success
    ).toBe(false);
  });

  it('accepts a terminal safe error and rejects unknown or raw-provider fields', () => {
    expect(
      HostedStreamEventSchema.safeParse({
        ...streamBase(),
        event: 'error',
        reservationId: RESERVATION_ID,
        code: 'provider_unavailable',
        message: 'The hosted model could not complete this response.',
        httpStatusCode: 503,
        retryable: false,
        reservationDisposition: 'held_for_reconciliation',
      }).success
    ).toBe(true);
    expect(
      HostedStreamEventSchema.safeParse({
        ...streamBase(),
        event: 'error',
        reservationId: RESERVATION_ID,
        code: 'provider_unavailable',
        message: 'safe',
        retryable: false,
        reservationDisposition: 'held_for_reconciliation',
        providerBody: { prompt: 'must not cross the wire' },
      }).success
    ).toBe(false);
    expect(
      HostedStreamEventSchema.safeParse({
        ...streamBase(),
        event: 'error',
        reservationId: RESERVATION_ID,
        code: 'provider_unavailable',
        message: 'safe',
        httpStatusCode: 700,
        retryable: false,
        reservationDisposition: 'held_for_reconciliation',
      }).success
    ).toBe(false);
  });
});
