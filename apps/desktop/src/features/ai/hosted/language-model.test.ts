import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  HostedGenerateRequestSchema,
  type HostedGenerateRequest,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import { stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createHostedLanguageModel,
  toHostedMessages,
  toHostedToolChoice,
  toHostedToolNames,
  type HostedLanguageModelTransport,
} from './language-model';
import { createHostedToolApprovalAuthority } from './tool-approval-authority';

function callOptions(
  overrides: Partial<LanguageModelV3CallOptions> = {}
): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'You are DNAForge.' },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Inspect [[ref:reference-1]] and the current workspace.',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          {
            type: 'reasoning',
            text: 'Workspace inspection is required.',
            providerOptions: {
              openai: {
                itemId: 'reasoning-1',
                reasoningEncryptedContent: 'encrypted-reasoning',
              },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'get_workspace',
            input: {},
            providerOptions: { openai: { itemId: 'call-item-1' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'get_workspace',
            output: { type: 'json', value: { name: 'pUC19' } },
          },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'get_workspace',
        description: 'Read the workspace.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    toolChoice: { type: 'required' },
    maxOutputTokens: 2_048,
    ...overrides,
  };
}

async function readAll(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function eventBase(stepSequence: number) {
  return {
    v: 2 as const,
    requestId: `client-${stepSequence + 1}`,
    runId: 'turn-run-1',
    turnId: 'turn-1',
    stepSequence,
  };
}

function modelOptions(
  transport: HostedLanguageModelTransport,
  overrides: Record<string, unknown> = {}
) {
  let requestNumber = 0;
  return {
    tier: 'auto' as const,
    workflowId: 'conversation-1',
    runId: 'turn-run-1',
    turnId: 'turn-1',
    workspaceOpen: true,
    stagedReferenceIds: ['reference-1'],
    transport,
    turnBindingToken: 'turn-binding-1',
    toolApprovalAuthority: createHostedToolApprovalAuthority(),
    idGenerator: () => `client-${++requestNumber}`,
    ...overrides,
  };
}

describe('Hosted LanguageModelV3 request conversion', () => {
  it('preserves structured system, history, references, tool calls, and results', () => {
    expect(toHostedMessages(callOptions())).toEqual([
      { role: 'system', parts: [{ type: 'text', text: 'You are DNAForge.' }] },
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Inspect [[ref:reference-1]] and the current workspace.',
          },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'I will inspect it.' },
          {
            type: 'reasoning',
            text: 'Workspace inspection is required.',
            providerOptions: {
              openai: {
                itemId: 'reasoning-1',
                reasoningEncryptedContent: 'encrypted-reasoning',
              },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'get_workspace',
            input: {},
            providerOptions: { openai: { itemId: 'call-item-1' } },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'get_workspace',
            output: { type: 'json', value: { name: 'pUC19' } },
          },
        ],
      },
    ]);
  });

  it('normalizes tool JSON results before the next Hosted request', () => {
    const messages = toHostedMessages(
      callOptions({
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-backtranslate',
                toolName: 'backtranslate',
                output: {
                  type: 'json',
                  value: {
                    refId: undefined,
                    host: 'e_coli_k12',
                    dnaSequence: 'ATG',
                    verified: true,
                  },
                },
              },
            ],
          },
        ],
      })
    );

    expect(messages).toEqual([
      {
        role: 'tool',
        parts: [
          {
            type: 'tool-result',
            toolCallId: 'call-backtranslate',
            toolName: 'backtranslate',
            output: {
              type: 'json',
              value: {
                host: 'e_coli_k12',
                dnaSequence: 'ATG',
                verified: true,
              },
            },
          },
        ],
      },
    ]);
    expect(() =>
      HostedGenerateRequestSchema.parse({
        version: 2,
        tier: 'auto',
        workflowId: 'conversation-1',
        runId: 'turn-run-1',
        turnId: 'turn-1',
        stepSequence: 1,
        messages,
        toolNames: [],
        traceContext: {
          source: 'desktop_chat',
          workspaceOpen: true,
          stagedReferenceIds: [],
        },
      })
    ).not.toThrow();
  });

  it('sends only tool names and the supported tool choice', () => {
    expect(toHostedToolNames(callOptions())).toEqual(['get_workspace', 'read_file']);
    expect(toHostedToolChoice(callOptions())).toEqual({ type: 'required' });
    expect(
      toHostedToolChoice(callOptions({ toolChoice: { type: 'tool', toolName: 'read_file' } }))
    ).toEqual({ type: 'tool', toolName: 'read_file' });
  });

  it('rejects unsupported provider execution and file content at the boundary', () => {
    expect(() =>
      toHostedMessages(
        callOptions({
          prompt: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'get_workspace',
                  input: {},
                  providerExecuted: true,
                },
              ],
            },
          ],
        })
      )
    ).toThrow(/provider-executed/i);

    expect(() =>
      toHostedMessages(
        callOptions({
          prompt: [
            {
              role: 'user',
              content: [{ type: 'file', data: 'ZmFrZQ==', mediaType: 'application/octet-stream' }],
            },
          ],
        })
      )
    ).toThrow(/file/i);
  });
});

describe('createHostedLanguageModel', () => {
  it('preserves the gateway approval requirement with exact ticket binding', async () => {
    const approvalAuthority = createHostedToolApprovalAuthority();
    const transport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(0),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          yield {
            ...eventBase(0),
            seq: 1,
            event: 'tool_call',
            toolCallId: 'call-server-approval',
            name: 'get_workspace',
            input: {},
            ticket: {
              token: 'signed.approval',
              expiresAt: '2099-08-13T23:00:00.000Z',
              providerCallId: 'call-server-approval',
              toolName: 'get_workspace',
              requiresUserApproval: true,
            },
          };
          yield {
            ...eventBase(0),
            seq: 2,
            event: 'finish',
            reservationId: '33333333-3333-4333-8333-333333333333',
            usageEventId: null,
            outcome: 'completed',
            usage: {
              status: 'reported',
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            workflowTrace: {
              workflowRunId: '11111111-1111-4111-8111-111111111111',
              workflowStepId: '22222222-2222-4222-8222-222222222222',
            },
            researchContributionNotice: null,
          };
        })();
      },
      cancel: vi.fn(),
    };

    await readAll(
      (
        await createHostedLanguageModel({
          ...modelOptions(transport),
          toolApprovalAuthority: approvalAuthority,
        }).doStream(callOptions())
      ).stream
    );

    expect(approvalAuthority.consume('call-server-approval', 'get_workspace', {})).toEqual(
      expect.objectContaining({ requiresUserApproval: true, assertUsable: expect.any(Function) })
    );
    expect(() => approvalAuthority.acceptCatalogVersion('catalog-v2')).toThrow(/catalog.*changed/i);
  });

  it('rejects a gateway tool ticket whose signed identity fields do not match the event', async () => {
    const approvalAuthority = createHostedToolApprovalAuthority();
    const cancel = vi.fn();
    const transport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(0),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          yield {
            ...eventBase(0),
            seq: 1,
            event: 'tool_call',
            toolCallId: 'call-outer',
            name: 'get_workspace',
            input: {},
            ticket: {
              token: 'signed.mismatch',
              expiresAt: '2099-08-13T23:00:00.000Z',
              providerCallId: 'call-other',
              toolName: 'list_files',
              requiresUserApproval: false,
            },
          };
        })();
      },
      cancel,
    };

    await expect(
      readAll(
        (
          await createHostedLanguageModel({
            ...modelOptions(transport),
            toolApprovalAuthority: approvalAuthority,
          }).doStream(callOptions())
        ).stream
      )
    ).rejects.toThrow(/schema|ticket.*binding/i);
    expect(cancel).toHaveBeenCalledWith('client-1');
    expect(() => approvalAuthority.consume('call-outer', 'get_workspace', {})).toThrow(/missing/i);
  });

  it('keeps stable turn identity and attaches the completed mutation claim with its ticket once', async () => {
    const requests: HostedGenerateRequest[] = [];
    let startCount = 0;
    const transport: HostedLanguageModelTransport = {
      start(input) {
        requests.push(input.request);
        startCount += 1;
        const current = startCount;
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(current - 1),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          if (current === 1) {
            yield {
              ...eventBase(0),
              seq: 1,
              event: 'tool_call',
              toolCallId: 'call-1',
              name: 'create_design',
              input: { name: 'Hosted Design' },
              ticket: {
                token: 'signed.ticket',
                expiresAt: '2099-08-13T23:00:00.000Z',
                providerCallId: 'call-1',
                toolName: 'create_design',
                requiresUserApproval: true,
              },
            };
            yield {
              ...eventBase(0),
              seq: 2,
              event: 'finish',
              reservationId: '33333333-3333-4333-8333-333333333333',
              usageEventId: '44444444-4444-4444-8444-444444444444',
              outcome: 'completed',
              usage: {
                status: 'reported',
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
              },
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              workflowTrace: {
                workflowRunId: '11111111-1111-4111-8111-111111111111',
                workflowStepId: '22222222-2222-4222-8222-222222222222',
              },
              researchContributionNotice: null,
            };
          } else {
            yield {
              ...eventBase(1),
              seq: 1,
              event: 'text_delta',
              delta: 'Created Hosted Design.',
            };
            yield {
              ...eventBase(1),
              seq: 2,
              event: 'finish',
              reservationId: '33333333-3333-4333-8333-333333333333',
              usageEventId: '44444444-4444-4444-8444-444444444444',
              outcome: 'completed',
              usage: {
                status: 'reported',
                inputTokens: 20,
                outputTokens: 6,
                cacheReadTokens: 1,
                cacheWriteTokens: 0,
                reasoningTokens: 1,
              },
              finishReason: { unified: 'stop', raw: 'stop' },
              workflowTrace: {
                workflowRunId: '11111111-1111-4111-8111-111111111111',
                workflowStepId: '22222222-2222-4222-8222-222222222222',
              },
              researchContributionNotice: null,
            };
          }
        })();
      },
      cancel: vi.fn(),
    };
    const mutationClaimId = '55555555-5555-4555-8555-555555555555';
    const approvalAuthority = {
      acceptCatalogVersion: vi.fn(),
      register: vi.fn(),
      consume: vi.fn(() => {
        throw new Error('The adapter test does not execute the policy wrapper.');
      }),
      completedMutationClaimId: vi.fn((toolCallId: string) =>
        toolCallId === 'call-1' ? mutationClaimId : undefined
      ),
    };
    const model = createHostedLanguageModel(
      modelOptions(transport, { toolApprovalAuthority: approvalAuthority })
    );
    const executeTool = vi.fn(async () => ({ designId: 'design-1' }));
    const result = streamText({
      model,
      system: 'You are DNAForge.',
      messages: [
        {
          role: 'user',
          content: 'Create a design named Hosted Design.',
        },
      ],
      tools: {
        create_design: tool({
          description: 'Create a design.',
          inputSchema: z.object({ name: z.string() }),
          execute: executeTool,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    await expect(result.text).resolves.toBe('Created Hosted Design.');
    expect(executeTool).toHaveBeenCalledTimes(1);

    expect(requests).toHaveLength(2);
    expect(
      requests.map(({ workflowId, runId, turnId, stepSequence, workflowRunId }) => ({
        workflowId,
        runId,
        turnId,
        stepSequence,
        workflowRunId,
      }))
    ).toEqual([
      {
        workflowId: 'conversation-1',
        runId: 'turn-run-1',
        turnId: 'turn-1',
        stepSequence: 0,
        workflowRunId: undefined,
      },
      {
        workflowId: 'conversation-1',
        runId: 'turn-run-1',
        turnId: 'turn-1',
        stepSequence: 1,
        workflowRunId: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'create_design',
          output: { type: 'json', value: { designId: 'design-1' } },
          ticket: 'signed.ticket',
          mutationClaimId,
        },
      ],
    });
    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 20,
      outputTokens: 6,
      reasoningTokens: 1,
      cachedInputTokens: 1,
    });
  });

  it('tracks only the completed tool-step interval and clears it when the next step is accepted', async () => {
    const states: Array<{ workflowRunId: string; workflowStepId: string } | null> = [];
    let call = 0;
    const trace = {
      workflowRunId: '11111111-1111-4111-8111-111111111111',
      workflowStepId: '22222222-2222-4222-8222-222222222222',
    };
    const transport: HostedLanguageModelTransport = {
      start() {
        const step = call++;
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(step),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          yield {
            ...eventBase(step),
            seq: 1,
            event: 'finish',
            reservationId: '33333333-3333-4333-8333-333333333333',
            usageEventId: '44444444-4444-4444-8444-444444444444',
            outcome: 'completed',
            usage: {
              status: 'reported',
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
            finishReason:
              step === 0
                ? { unified: 'tool-calls', raw: 'tool_calls' }
                : { unified: 'stop', raw: 'stop' },
            workflowTrace: trace,
            researchContributionNotice: null,
          };
        })();
      },
      cancel: vi.fn(),
    };
    const model = createHostedLanguageModel(
      modelOptions(transport, {
        onInterstepTerminalChange: (state: unknown) => states.push(state as never),
      })
    );

    await readAll((await model.doStream(callOptions())).stream);
    expect(states).toEqual([null, trace]);
    await readAll((await model.doStream(callOptions())).stream);
    expect(states).toEqual([null, trace, null, null]);
  });

  it('rejects a tool-bearing step whose accounting requires reconciliation', async () => {
    const cancel = vi.fn();
    const transport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(0),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          yield { ...eventBase(0), seq: 1, event: 'text_delta', delta: 'Hello' };
          yield {
            ...eventBase(0),
            seq: 2,
            event: 'reasoning_delta',
            summary: true,
            delta: 'Checking',
            providerMetadata: { openai: { itemId: 'reasoning-1' } },
          };
          yield {
            ...eventBase(0),
            seq: 3,
            event: 'tool_call',
            toolCallId: 'call-1',
            name: 'get_workspace',
            input: {},
            ticket: {
              token: 'signed.ticket',
              expiresAt: '2099-08-13T23:00:00.000Z',
              providerCallId: 'call-1',
              toolName: 'get_workspace',
              requiresUserApproval: false,
            },
          };
          yield {
            ...eventBase(0),
            seq: 4,
            event: 'finish',
            reservationId: '33333333-3333-4333-8333-333333333333',
            usageEventId: null,
            outcome: 'reconciliation_required',
            usage: {
              status: 'estimated',
              inputTokens: 10,
              outputTokens: 3,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              reasoningTokens: 1,
            },
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            workflowTrace: null,
            researchContributionNotice: null,
          };
        })();
      },
      cancel,
    };

    await expect(
      readAll(
        (await createHostedLanguageModel(modelOptions(transport)).doStream(callOptions())).stream
      )
    ).rejects.toThrow(/accounting.*reconciliation/i);
    expect(cancel).toHaveBeenCalledWith('client-1');
  });

  it('maps terminal errors and calls cancel when Stop aborts the turn', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const transport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        })();
      },
      cancel,
    };
    const model = createHostedLanguageModel(modelOptions(transport));
    const streamed = await model.doStream(callOptions({ abortSignal: controller.signal }));
    const reading = readAll(streamed.stream);

    controller.abort();
    release?.();

    await expect(reading).rejects.toThrow(/stopped/i);
    expect(cancel).toHaveBeenCalledWith('client-1');

    const errorTransport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(0),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          yield {
            ...eventBase(0),
            seq: 1,
            event: 'error',
            reservationId: '33333333-3333-4333-8333-333333333333',
            code: 'provider_unavailable',
            message: 'Hosted generation failed.',
            retryable: true,
            reservationDisposition: 'released',
          };
        })();
      },
      cancel: vi.fn(),
    };
    const errorParts = await readAll(
      (await createHostedLanguageModel(modelOptions(errorTransport)).doStream(callOptions())).stream
    );
    expect(errorParts).toHaveLength(4);
    expect(errorParts[2]).toMatchObject({ type: 'error' });
    expect(errorParts[3]).toMatchObject({
      type: 'finish',
      finishReason: { unified: 'error', raw: 'provider_unavailable' },
    });
  });

  it.each([
    {
      name: 'an event before accepted',
      events: [{ ...eventBase(0), seq: 0, event: 'text_delta' as const, delta: 'unsafe' }],
      message: /accepted/i,
    },
    {
      name: 'a sequence gap',
      events: [
        {
          ...eventBase(0),
          seq: 0,
          event: 'accepted' as const,
          reservationId: '33333333-3333-4333-8333-333333333333',
          tier: 'auto' as const,
          catalogVersion: 'catalog-v1',
          rateCardVersion: 'rate-v1',
        },
        { ...eventBase(0), seq: 2, event: 'text_delta' as const, delta: 'unsafe' },
      ],
      message: /sequence/i,
    },
    {
      name: 'a mixed request ID',
      events: [
        {
          ...eventBase(0),
          seq: 0,
          event: 'accepted' as const,
          reservationId: '33333333-3333-4333-8333-333333333333',
          tier: 'auto' as const,
          catalogVersion: 'catalog-v1',
          rateCardVersion: 'rate-v1',
        },
        {
          ...eventBase(0),
          requestId: 'client-other',
          seq: 1,
          event: 'text_delta' as const,
          delta: 'unsafe',
        },
      ],
      message: /correlation/i,
    },
    {
      name: 'a mismatched terminal reservation',
      events: [
        {
          ...eventBase(0),
          seq: 0,
          event: 'accepted' as const,
          reservationId: '33333333-3333-4333-8333-333333333333',
          tier: 'auto' as const,
          catalogVersion: 'catalog-v1',
          rateCardVersion: 'rate-v1',
        },
        {
          ...eventBase(0),
          seq: 1,
          event: 'error' as const,
          reservationId: '55555555-5555-4555-8555-555555555555',
          code: 'provider_error',
          message: 'Failed.',
          retryable: true,
          reservationDisposition: 'released' as const,
        },
      ],
      message: /reservation/i,
    },
  ])('fails closed and cancels transport for $name', async ({ events, message }) => {
    const cancel = vi.fn();
    const transport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield* events as HostedStreamEvent[];
        })();
      },
      cancel,
    };

    await expect(
      readAll(
        (await createHostedLanguageModel(modelOptions(transport)).doStream(callOptions())).stream
      )
    ).rejects.toThrow(message);
    expect(cancel).toHaveBeenCalledWith('client-1');
  });

  it('rejects an expired signed tool ticket before local tool execution', async () => {
    const cancel = vi.fn();
    const transport: HostedLanguageModelTransport = {
      start() {
        return (async function* (): AsyncIterable<HostedStreamEvent> {
          yield {
            ...eventBase(0),
            seq: 0,
            event: 'accepted',
            reservationId: '33333333-3333-4333-8333-333333333333',
            tier: 'auto',
            catalogVersion: 'catalog-v1',
            rateCardVersion: 'rate-v1',
          };
          yield {
            ...eventBase(0),
            seq: 1,
            event: 'tool_call',
            toolCallId: 'call-expired',
            name: 'get_workspace',
            input: {},
            ticket: {
              token: 'signed.expired',
              expiresAt: '2000-01-01T00:00:00.000Z',
              providerCallId: 'call-expired',
              toolName: 'get_workspace',
              requiresUserApproval: false,
            },
          };
        })();
      },
      cancel,
    };

    await expect(
      readAll(
        (await createHostedLanguageModel(modelOptions(transport)).doStream(callOptions())).stream
      )
    ).rejects.toThrow(/ticket.*expired/i);
    expect(cancel).toHaveBeenCalledWith('client-1');
  });

  it('returns the active transport iterator when the stream reader cancels', async () => {
    const cancel = vi.fn();
    const returned = vi.fn();
    let release: (() => void) | undefined;
    const transport: HostedLanguageModelTransport = {
      start() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<HostedStreamEvent>>((resolve) => {
                  release = () => resolve({ done: true, value: undefined });
                }),
              return: async () => {
                returned();
                release?.();
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
      cancel,
    };

    const stream = (
      await createHostedLanguageModel(modelOptions(transport)).doStream(callOptions())
    ).stream;
    await stream.cancel();

    expect(cancel).toHaveBeenCalledWith('client-1');
    expect(returned).toHaveBeenCalledOnce();
  });
});
