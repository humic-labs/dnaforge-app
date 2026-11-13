import {
  UnsupportedFunctionalityError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3ToolResultOutput,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from '@ai-sdk/provider';
import {
  HostedGenerateRequestSchema,
  HostedProviderMetadataSchema,
  HostedStreamEventSchema,
  type HostedGenerateRequest,
  type HostedMessage,
  type HostedMessagePart,
  type HostedProviderMetadata,
  type HostedStreamEvent,
  type HostedTier,
  type HostedToolChoice,
  type HostedToolResultOutput,
  type HostedUsage,
} from '@waypoint/hosted-ai-contract';
import type { HostedToolApprovalAuthority } from './tool-approval-authority';

export interface HostedLanguageModelTransportStartInput {
  readonly clientRequestId: string;
  readonly idempotencyKey: string;
  readonly turnBindingToken: string;
  readonly request: HostedGenerateRequest;
}

export interface HostedLanguageModelTransport {
  start(input: HostedLanguageModelTransportStartInput): AsyncIterable<HostedStreamEvent>;
  cancel(clientRequestId: string): void | Promise<void>;
}

export interface HostedLanguageModelOptions {
  readonly tier: HostedTier;
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly workspaceOpen: boolean;
  readonly stagedReferenceIds: readonly string[];
  readonly transport: HostedLanguageModelTransport;
  readonly turnBindingToken: string;
  readonly toolApprovalAuthority: HostedToolApprovalAuthority;
  readonly onInterstepTerminalChange?: (
    trace: { readonly workflowRunId: string; readonly workflowStepId: string } | null
  ) => void;
  readonly idGenerator?: () => string;
}

function jsonStringify(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('not JSON serializable');
    return encoded;
  } catch {
    throw new Error('A Hosted tool call contained non-serializable input.');
  }
}

function toJsonValue(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('not JSON serializable');
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('A Hosted tool result contained non-serializable output.');
  }
}

function hostedProviderOptions(value: unknown): HostedProviderMetadata | undefined {
  const parsed = HostedProviderMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function aiSdkProviderMetadata(
  value: HostedProviderMetadata | undefined
): SharedV3ProviderMetadata | undefined {
  return value as SharedV3ProviderMetadata | undefined;
}

function toHostedToolResult(output: LanguageModelV3ToolResultOutput): HostedToolResultOutput {
  switch (output.type) {
    case 'text':
      return { type: 'text', value: output.value };
    case 'json':
      return { type: 'json', value: toJsonValue(output.value) };
    case 'error-text':
      return { type: 'error-text', value: output.value };
    case 'error-json':
      return { type: 'error-json', value: toJsonValue(output.value) };
    case 'execution-denied':
      return {
        type: 'execution-denied',
        ...(output.reason === undefined ? {} : { reason: output.reason }),
      };
    case 'content':
      throw new UnsupportedFunctionalityError({
        functionality: 'rich tool-result content on DNAForge Hosted',
      });
    default: {
      const exhaustive: never = output;
      return exhaustive;
    }
  }
}

export function toHostedMessages(options: LanguageModelV3CallOptions): HostedMessage[] {
  const messages: HostedMessage[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', parts: [{ type: 'text', text: message.content }] });
      continue;
    }

    const parts: HostedMessagePart[] = [];
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          parts.push({ type: 'text', text: part.text });
          break;
        case 'reasoning': {
          const providerOptions = hostedProviderOptions(part.providerOptions);
          parts.push({
            type: 'reasoning',
            text: part.text,
            ...(providerOptions ? { providerOptions } : {}),
          });
          break;
        }
        case 'tool-call': {
          if (part.providerExecuted) {
            throw new UnsupportedFunctionalityError({
              functionality: 'provider-executed tools on DNAForge Hosted',
            });
          }
          const providerOptions = hostedProviderOptions(part.providerOptions);
          parts.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...(providerOptions ? { providerOptions } : {}),
          });
          break;
        }
        case 'tool-result': {
          const providerOptions = hostedProviderOptions(part.providerOptions);
          parts.push({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toHostedToolResult(part.output),
            ...(providerOptions ? { providerOptions } : {}),
          });
          break;
        }
        default:
          throw new UnsupportedFunctionalityError({
            functionality: 'file or approval content on DNAForge Hosted',
          });
      }
    }
    if (parts.length > 0) messages.push({ role: message.role, parts });
  }
  if (messages.length === 0) throw new Error('DNAForge Hosted requires at least one message.');
  return messages;
}

export function toHostedToolNames(options: LanguageModelV3CallOptions): string[] {
  return (options.tools ?? []).map((tool) => {
    if (tool.type !== 'function') {
      throw new UnsupportedFunctionalityError({
        functionality: 'provider-defined tools on DNAForge Hosted',
      });
    }
    return tool.name;
  });
}

export function toHostedToolChoice(
  options: LanguageModelV3CallOptions
): HostedToolChoice | undefined {
  const choice = options.toolChoice;
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
    case 'none':
    case 'required':
      return { type: choice.type };
    case 'tool':
      return { type: 'tool', toolName: choice.toolName };
  }
}

function ignoredSettingWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const settings: Array<[string, unknown]> = [
    ['temperature', options.temperature],
    ['topP', options.topP],
    ['topK', options.topK],
    ['presencePenalty', options.presencePenalty],
    ['frequencyPenalty', options.frequencyPenalty],
    ['seed', options.seed],
    ['stopSequences', options.stopSequences],
    [
      'responseFormat',
      options.responseFormat?.type === 'json' ? options.responseFormat : undefined,
    ],
  ];
  return settings
    .filter(([, value]) => value !== undefined)
    .map(([feature]) => ({
      type: 'unsupported' as const,
      feature,
      details: 'DNAForge Hosted routing policy controls this setting.',
    }));
}

function usageForAiSdk(usage: HostedUsage) {
  return {
    inputTokens: {
      total: usage.inputTokens ?? undefined,
      noCache:
        usage.inputTokens === null
          ? undefined
          : Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0)),
      cacheRead: usage.cacheReadTokens ?? undefined,
      cacheWrite: usage.cacheWriteTokens ?? undefined,
    },
    outputTokens: {
      total: usage.outputTokens ?? undefined,
      text:
        usage.outputTokens === null
          ? undefined
          : Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0)),
      reasoning: usage.reasoningTokens ?? undefined,
    },
  };
}

function missingUsage() {
  return usageForAiSdk({
    status: 'missing',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });
}

export function createHostedLanguageModel(options: HostedLanguageModelOptions): LanguageModelV3 {
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  let nextStepSequence = 0;
  let workflowRunId: string | undefined;
  const pendingTickets = new Map<string, { readonly toolName: string; readonly token: string }>();

  return {
    specificationVersion: 'v3',
    provider: 'dnaforge-hosted',
    modelId: `hosted:${options.tier}`,
    supportedUrls: {},

    async doGenerate(): Promise<LanguageModelV3GenerateResult> {
      throw new UnsupportedFunctionalityError({
        functionality: 'non-streaming generation on DNAForge Hosted',
      });
    },

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const clientRequestId = idGenerator();
      const stepSequence = nextStepSequence;
      const attachedTicketIds: string[] = [];
      const messages = toHostedMessages(callOptions).map((message) => ({
        ...message,
        parts: message.parts.map((part) => {
          if (part.type !== 'tool-result' || part.ticket) return part;
          const pending = pendingTickets.get(part.toolCallId);
          if (!pending || pending.toolName !== part.toolName) return part;
          attachedTicketIds.push(part.toolCallId);
          const mutationClaimId = options.toolApprovalAuthority.completedMutationClaimId(
            part.toolCallId
          );
          return {
            ...part,
            ticket: pending.token,
            ...(mutationClaimId ? { mutationClaimId } : {}),
          };
        }),
      })) as HostedMessage[];
      const request = HostedGenerateRequestSchema.parse({
        version: 2,
        tier: options.tier,
        workflowId: options.workflowId,
        runId: options.runId,
        turnId: options.turnId,
        stepSequence,
        ...(workflowRunId ? { workflowRunId } : {}),
        messages,
        toolNames: toHostedToolNames(callOptions),
        ...(toHostedToolChoice(callOptions) ? { toolChoice: toHostedToolChoice(callOptions) } : {}),
        ...(callOptions.maxOutputTokens ? { maxOutputTokens: callOptions.maxOutputTokens } : {}),
        traceContext: {
          source: 'desktop_chat',
          workspaceOpen: options.workspaceOpen,
          stagedReferenceIds: [...options.stagedReferenceIds],
        },
      });
      nextStepSequence += 1;
      const warnings = ignoredSettingWarnings(callOptions);
      const cancelTransport = () => {
        try {
          void Promise.resolve(options.transport.cancel(clientRequestId)).catch(() => undefined);
        } catch {}
      };
      let cancelLocalStream = () => {};

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            let textStarted = false;
            let reasoningStarted = false;
            let closed = false;
            let expectedSequence = 0;
            let acceptedReservationId: string | undefined;
            let activeIterator: AsyncIterator<HostedStreamEvent> | null = null;
            const textId = `${clientRequestId}:text`;
            const reasoningId = `${clientRequestId}:reasoning`;

            const finishOpenBlocks = () => {
              if (textStarted) {
                controller.enqueue({ type: 'text-end', id: textId });
                textStarted = false;
              }
              if (reasoningStarted) {
                controller.enqueue({ type: 'reasoning-end', id: reasoningId });
                reasoningStarted = false;
              }
            };
            const cleanup = () => {
              callOptions.abortSignal?.removeEventListener('abort', onAbort);
            };
            const returnActiveIterator = () => {
              const iterator = activeIterator;
              activeIterator = null;
              if (!iterator?.return) return;
              try {
                void Promise.resolve(iterator.return()).catch(() => undefined);
              } catch {}
            };
            const close = () => {
              if (closed) return;
              closed = true;
              cleanup();
              controller.close();
            };
            const fail = (message: string) => {
              if (closed) return;
              closed = true;
              cleanup();
              returnActiveIterator();
              controller.error(new Error(message));
            };
            const onAbort = () => {
              fail('Hosted generation was stopped.');
              cancelTransport();
            };
            cancelLocalStream = () => {
              if (closed) return;
              closed = true;
              cleanup();
              returnActiveIterator();
            };
            const validateEvent = (rawEvent: HostedStreamEvent): HostedStreamEvent => {
              const parsed = HostedStreamEventSchema.safeParse(rawEvent);
              if (!parsed.success) {
                throw new Error('Hosted stream event failed schema validation.');
              }
              const event = parsed.data;
              if (event.seq !== expectedSequence) {
                throw new Error('Hosted stream sequence mismatch.');
              }
              if (
                event.requestId !== clientRequestId ||
                event.runId !== request.runId ||
                event.turnId !== request.turnId ||
                event.stepSequence !== request.stepSequence
              ) {
                throw new Error('Hosted stream correlation mismatch.');
              }
              if (expectedSequence === 0) {
                if (event.event !== 'accepted' || event.tier !== request.tier) {
                  throw new Error('Hosted stream accepted event is required first.');
                }
                acceptedReservationId = event.reservationId;
                options.toolApprovalAuthority.acceptCatalogVersion(event.catalogVersion);
              } else if (event.event === 'accepted') {
                throw new Error('Hosted stream contained a duplicate accepted event.');
              }
              if (
                (event.event === 'finish' || event.event === 'error') &&
                event.reservationId !== acceptedReservationId
              ) {
                throw new Error('Hosted stream reservation mismatch.');
              }
              if (event.event === 'tool_call') {
                if (
                  event.ticket.providerCallId !== event.toolCallId ||
                  event.ticket.toolName !== event.name
                ) {
                  throw new Error(
                    'Hosted signed tool ticket binding does not match its tool call.'
                  );
                }
                if (Date.parse(event.ticket.expiresAt) <= Date.now()) {
                  throw new Error('Hosted signed tool ticket has expired.');
                }
              }
              expectedSequence += 1;
              return event;
            };
            const processEvent = (event: HostedStreamEvent): boolean => {
              if (closed) return false;
              switch (event.event) {
                case 'accepted':
                  attachedTicketIds.forEach((toolCallId) => pendingTickets.delete(toolCallId));
                  options.onInterstepTerminalChange?.(null);
                  controller.enqueue({ type: 'stream-start', warnings });
                  controller.enqueue({
                    type: 'response-metadata',
                    id: event.requestId,
                    modelId: `hosted:${event.tier}`,
                  });
                  break;
                case 'text_delta':
                  if (reasoningStarted) {
                    controller.enqueue({ type: 'reasoning-end', id: reasoningId });
                    reasoningStarted = false;
                  }
                  if (!textStarted) {
                    textStarted = true;
                    controller.enqueue({ type: 'text-start', id: textId });
                  }
                  controller.enqueue({ type: 'text-delta', id: textId, delta: event.delta });
                  break;
                case 'reasoning_delta':
                  if (textStarted) {
                    controller.enqueue({ type: 'text-end', id: textId });
                    textStarted = false;
                  }
                  if (!reasoningStarted) {
                    reasoningStarted = true;
                    controller.enqueue({
                      type: 'reasoning-start',
                      id: reasoningId,
                      ...(event.providerMetadata
                        ? { providerMetadata: aiSdkProviderMetadata(event.providerMetadata) }
                        : {}),
                    });
                  }
                  controller.enqueue({
                    type: 'reasoning-delta',
                    id: reasoningId,
                    delta: event.delta,
                    ...(event.providerMetadata
                      ? { providerMetadata: aiSdkProviderMetadata(event.providerMetadata) }
                      : {}),
                  });
                  break;
                case 'tool_call':
                  finishOpenBlocks();
                  options.toolApprovalAuthority.register({
                    toolCallId: event.toolCallId,
                    toolName: event.name,
                    input: event.input,
                    ticket: event.ticket.token,
                    requiresUserApproval: event.ticket.requiresUserApproval,
                    expiresAt: event.ticket.expiresAt,
                  });
                  pendingTickets.set(event.toolCallId, {
                    toolName: event.name,
                    token: event.ticket.token,
                  });
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: event.toolCallId,
                    toolName: event.name,
                    input: jsonStringify(event.input),
                    providerExecuted: false,
                    ...(event.providerMetadata
                      ? { providerMetadata: aiSdkProviderMetadata(event.providerMetadata) }
                      : {}),
                  });
                  break;
                case 'finish':
                  finishOpenBlocks();
                  if (event.outcome !== 'completed') {
                    throw new Error('Hosted accounting requires reconciliation.');
                  }
                  if (event.finishReason.unified === 'tool-calls') {
                    if (!event.workflowTrace) {
                      throw new Error('Hosted tool step is missing its workflow trace.');
                    }
                    options.onInterstepTerminalChange?.(event.workflowTrace);
                  } else {
                    options.onInterstepTerminalChange?.(null);
                  }
                  if (event.workflowTrace) workflowRunId = event.workflowTrace.workflowRunId;
                  controller.enqueue({
                    type: 'finish',
                    usage: usageForAiSdk(event.usage),
                    finishReason: {
                      unified: event.finishReason.unified,
                      raw: event.finishReason.raw ?? undefined,
                    },
                    providerMetadata: {
                      ...(aiSdkProviderMetadata(event.finishReason.providerMetadata) ?? {}),
                      dnaforge: {
                        reservationId: event.reservationId,
                        usageEventId: event.usageEventId,
                        outcome: event.outcome,
                        workflowTrace: event.workflowTrace,
                        researchContributionNotice: event.researchContributionNotice,
                      },
                    } as SharedV3ProviderMetadata,
                  });
                  close();
                  return true;
                case 'error':
                  finishOpenBlocks();
                  options.onInterstepTerminalChange?.(null);
                  controller.enqueue({ type: 'error', error: new Error(event.message) });
                  controller.enqueue({
                    type: 'finish',
                    usage: missingUsage(),
                    finishReason: { unified: 'error', raw: event.code },
                    providerMetadata: {
                      dnaforge: {
                        reservationId: event.reservationId,
                        retryable: event.retryable,
                        reservationDisposition: event.reservationDisposition,
                      },
                    } as SharedV3ProviderMetadata,
                  });
                  close();
                  return true;
              }
              return false;
            };

            callOptions.abortSignal?.addEventListener('abort', onAbort, { once: true });
            if (callOptions.abortSignal?.aborted) {
              onAbort();
              return;
            }
            void (async () => {
              try {
                const iterable = options.transport.start({
                  clientRequestId,
                  idempotencyKey: clientRequestId,
                  turnBindingToken: options.turnBindingToken,
                  request,
                });
                const iterator = iterable[Symbol.asyncIterator]();
                activeIterator = iterator;
                for (;;) {
                  const next = await iterator.next();
                  if (next.done) break;
                  if (closed || callOptions.abortSignal?.aborted) return;
                  if (processEvent(validateEvent(next.value))) return;
                }
                if (!closed) fail('Hosted generation ended without a terminal event.');
              } catch (error) {
                if (!closed) {
                  cancelTransport();
                  fail(error instanceof Error ? error.message : 'DNAForge Hosted failed.');
                }
              } finally {
                returnActiveIterator();
              }
            })();
          },
          cancel() {
            cancelLocalStream();
            cancelTransport();
          },
        }),
      };
    },
  };
}
