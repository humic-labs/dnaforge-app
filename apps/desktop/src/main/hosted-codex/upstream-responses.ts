import { createHash, randomUUID } from 'node:crypto';

import {
  HostedStreamEventSchema,
  readResponsesFrames,
  readUsage,
  ResponsesStreamError,
  ToolCallAssembler,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';

import type { AcceptedResponsesRequest } from './responses-wire';
import { createToolTicketMinter, type ToolTicketMinter } from './tool-ticket';

export const DEFAULT_UPSTREAM_BASE_URL = 'https://api.openai.com/v1';

export interface UpstreamStepOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly runId: string;
  readonly providerModel: string;
  readonly fetchImpl?: typeof fetch;
  readonly ticketMinter?: ToolTicketMinter;
  readonly stepSequence?: number;
  readonly authScheme?: 'bearer' | 'azure-api-key';
}

export class UpstreamResponsesError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'UpstreamResponsesError';
  }
}

export function createUpstreamStep(
  options: UpstreamStepOptions
): (accepted: AcceptedResponsesRequest) => AsyncIterable<HostedStreamEvent> {
  const baseUrl = (options.baseUrl ?? DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? fetch;
  const tickets = options.ticketMinter ?? createToolTicketMinter();

  return (accepted) =>
    (async function* (): AsyncGenerator<HostedStreamEvent> {
      const emit = (event: unknown): HostedStreamEvent => {
        const checked = HostedStreamEventSchema.safeParse(event);
        if (!checked.success) {
          const where = checked.error.issues[0]?.path.join('.') ?? '<unknown>';
          throw new UpstreamResponsesError(
            502,
            `the gateway built an event the contract rejects at "${where}"`
          );
        }
        return checked.data;
      };

      const reservationId = randomUUID();
      const turnId = randomUUID();
      const requestId = createHash('sha256')
        .update(accepted.requestDigest)
        .digest('hex')
        .slice(0, 32);
      let seq = 0;
      const base = (): {
        v: 2;
        seq: number;
        requestId: string;
        runId: string;
        turnId: string;
        stepSequence: number;
      } => ({
        v: 2,
        seq: (seq += 1),
        requestId,
        runId: options.runId,
        turnId,
        stepSequence: options.stepSequence ?? 1,
      });

      const response = await doFetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.authScheme === 'azure-api-key'
            ? { 'api-key': options.apiKey }
            : { authorization: `Bearer ${options.apiKey}` }),
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          ...accepted.forwarded,
          model: options.providerModel,
        }),
      });

      if (!response.ok || response.body === null) {
        throw new UpstreamResponsesError(
          response.status,
          `the provider refused the request with status ${response.status}`
        );
      }

      yield emit({
        ...base(),
        event: 'accepted',
        reservationId,
        tier: 'auto',
        catalogVersion: '1.0.0',
        rateCardVersion: '1.0.0',
      });

      const toolCalls = new ToolCallAssembler();
      let finished = false;
      let usage = readUsage(null);
      let finishReason = 'stop';
      let sawToolCall = false;

      for await (const frame of readResponsesFrames(response.body)) {
        const data = frame.data as Record<string, unknown>;
        if (frame.type === 'response.output_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (delta !== '') yield emit({ ...base(), event: 'text_delta', delta });
          continue;
        }
        if (frame.type === 'response.reasoning_summary_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (delta !== '')
            yield emit({ ...base(), event: 'reasoning_delta', summary: true, delta });
          continue;
        }
        if (frame.type === 'response.output_item.added') {
          toolCalls.opened(data);
          continue;
        }
        if (frame.type === 'response.function_call_arguments.delta') {
          toolCalls.delta(data);
          continue;
        }
        if (frame.type === 'response.output_item.done') {
          let call;
          try {
            call = toolCalls.closed(data);
          } catch (cause) {
            throw new UpstreamResponsesError(
              502,
              cause instanceof ResponsesStreamError
                ? cause.message
                : 'the provider sent an unusable tool call'
            );
          }
          if (call === null) continue;
          sawToolCall = true;
          yield emit({
            ...base(),
            event: 'tool_call',
            toolCallId: call.callId,
            name: call.name,
            input: call.input,
            ticket: tickets.mint({
              providerCallId: call.callId,
              toolName: call.name,
              requiresUserApproval: true,
            }),
          });
          continue;
        }
        if (frame.type === 'response.completed') {
          usage = readUsage(data.response);
          finished = true;
          if (sawToolCall) finishReason = 'tool-calls';
          break;
        }
        if (frame.type === 'response.incomplete') {
          usage = readUsage(data.response);
          const reason = (
            (data.response as { incomplete_details?: { reason?: unknown } } | null)
              ?.incomplete_details ?? {}
          ).reason;
          finishReason = reason === 'max_output_tokens' ? 'length' : 'other';
          finished = true;
          break;
        }
        if (frame.type === 'response.failed' || frame.type === 'error') {
          throw new UpstreamResponsesError(502, 'the provider reported the response failed');
        }
      }

      if (!finished) {
        throw new UpstreamResponsesError(502, 'the provider stream ended before it completed');
      }

      yield emit({
        ...base(),
        event: 'finish',
        reservationId,
        usageEventId: null,
        outcome: 'completed',
        usage: {
          status: usage.status,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: null,
          reasoningTokens: usage.reasoningTokens,
        },
        finishReason: { unified: finishReason, raw: finishReason },
        workflowTrace: null,
        researchContributionNotice: null,
      });
    })();
}
