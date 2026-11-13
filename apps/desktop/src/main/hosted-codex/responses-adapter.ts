import { createHash } from 'node:crypto';

import {
  hostedResponsesFunctionWireName,
  HOSTED_TOOL_DISPATCH_NAME,
  type HostedFinishReason,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';

export type ResponsesTranslationCode =
  | 'event_before_accepted'
  | 'duplicate_accepted'
  | 'sequence_not_advancing'
  | 'event_after_terminal'
  | 'unterminated_stream'
  | 'ill_formed_text'
  | 'provider_continuity_missing'
  | 'provider_continuity_mismatch'
  | 'unknown_event';

export class ResponsesTranslationError extends Error {
  constructor(
    readonly code: ResponsesTranslationCode,
    message: string
  ) {
    super(message);
    this.name = 'ResponsesTranslationError';
  }
}

export interface ResponsesSseEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

type ResponsesTerminalStatus = 'completed' | 'incomplete' | 'failed';

const TERMINAL_BY_FINISH_REASON: Readonly<
  Record<HostedFinishReason['unified'], ResponsesTerminalStatus>
> = {
  stop: 'completed',
  'tool-calls': 'completed',
  other: 'completed',
  length: 'incomplete',
  'content-filter': 'incomplete',
  error: 'failed',
};

const INCOMPLETE_REASON_BY_FINISH_REASON: Readonly<
  Record<HostedFinishReason['unified'], string | null>
> = {
  stop: null,
  'tool-calls': null,
  other: null,
  length: 'max_output_tokens',
  'content-filter': 'content_filter',
  error: null,
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

interface OpenMessage {
  readonly itemId: string;
  readonly index: number;
  text: string;
}

export interface ResponsesTranslatorOptions {
  readonly responseId: string;
  readonly model: string;
  readonly createdAt: number;
  readonly dispatchedToolNames?: readonly string[];
}

export class ResponsesTranslator {
  #sequenceEmitted = 0;
  #lastGatewaySeq: number | null = null;
  #accepted = false;
  #terminal = false;
  #itemIndex = 0;
  #openMessage: OpenMessage | null = null;
  #pendingReasoning = '';
  #reasoningPending = false;
  #sealedReasoningItemIds = new Set<string>();
  #digest = createHash('sha256');

  constructor(private readonly options: ResponsesTranslatorOptions) {}

  get isTerminal(): boolean {
    return this.#terminal;
  }

  responseDigest(): string {
    return this.#digest.copy().digest('hex');
  }

  translate(event: HostedStreamEvent): readonly ResponsesSseEvent[] {
    if (this.#terminal) {
      throw new ResponsesTranslationError(
        'event_after_terminal',
        `the gateway emitted "${event.event}" after the stream had already ended`
      );
    }
    if (event.event === 'accepted') {
      if (this.#accepted) {
        throw new ResponsesTranslationError(
          'duplicate_accepted',
          'the gateway accepted the same step twice'
        );
      }
    } else if (!this.#accepted) {
      throw new ResponsesTranslationError(
        'event_before_accepted',
        `the gateway emitted "${event.event}" before accepting the step`
      );
    }
    if (this.#lastGatewaySeq !== null && event.seq <= this.#lastGatewaySeq) {
      throw new ResponsesTranslationError(
        'sequence_not_advancing',
        `gateway sequence ${event.seq} does not advance past ${this.#lastGatewaySeq}`
      );
    }
    this.#lastGatewaySeq = event.seq;

    const emitted = this.#translateAccepted(event);
    for (const item of emitted) {
      this.#digest.update(`${item.type}\n${stableJson(item.payload)}\n`, 'utf8');
    }
    return emitted;
  }

  end(): void {
    this.#assertReasoningSealed();
    if (!this.#terminal) {
      throw new ResponsesTranslationError(
        'unterminated_stream',
        'the gateway stream ended without a finish or error event'
      );
    }
  }

  #translateAccepted(event: HostedStreamEvent): readonly ResponsesSseEvent[] {
    switch (event.event) {
      case 'accepted': {
        this.#accepted = true;
        return [
          this.#emit('response.created', { response: this.#response('in_progress') }),
          this.#emit('response.in_progress', { response: this.#response('in_progress') }),
        ];
      }
      case 'text_delta':
        this.#assertReasoningSealed();
        return this.#messageDelta(event.delta);
      case 'reasoning_delta':
        return this.#bufferReasoningDelta(event.delta);
      case 'reasoning_continuation':
        return this.#sealReasoning(event.itemId, event.encryptedContent);
      case 'tool_call':
      case 'child_tool_call': {
        this.#assertReasoningSealed();
        const events = [...this.#closeOpenMessage()];
        const index = this.#itemIndex++;
        const itemId = `fc_${event.toolCallId}`;
        const dispatched =
          event.event === 'tool_call' && this.options.dispatchedToolNames?.includes(event.name);
        const args = JSON.stringify(
          dispatched
            ? { name: event.name, arguments: JSON.stringify(event.input ?? {}) }
            : (event.input ?? {})
        );
        const item = {
          id: itemId,
          type: 'function_call',
          status: 'completed',
          name:
            event.event === 'tool_call'
              ? hostedResponsesFunctionWireName(dispatched ? HOSTED_TOOL_DISPATCH_NAME : event.name)
              : event.name,
          call_id: event.toolCallId,
          arguments: args,
        };
        events.push(
          this.#emit('response.output_item.added', {
            output_index: index,
            item: { ...item, status: 'in_progress', arguments: '' },
          }),
          this.#emit('response.function_call_arguments.delta', {
            item_id: itemId,
            output_index: index,
            delta: args,
          }),
          this.#emit('response.function_call_arguments.done', {
            item_id: itemId,
            output_index: index,
            arguments: args,
          }),
          this.#emit('response.output_item.done', { output_index: index, item })
        );
        return events;
      }
      case 'finish': {
        this.#assertReasoningSealed();
        const events = [...this.#closeOpenMessage()];
        this.#terminal = true;
        const finishReason = event.finishReason.unified;
        const status: ResponsesTerminalStatus | undefined = TERMINAL_BY_FINISH_REASON[finishReason];
        if (status === undefined) {
          throw new ResponsesTranslationError(
            'unknown_event',
            `unrecognized gateway finish reason ${JSON.stringify(finishReason)}`
          );
        }
        const incompleteReason = INCOMPLETE_REASON_BY_FINISH_REASON[finishReason];
        if (status === 'incomplete' && incompleteReason === null) {
          throw new ResponsesTranslationError(
            'unknown_event',
            `gateway finish reason ${JSON.stringify(finishReason)} has no incomplete mapping`
          );
        }
        const response = {
          ...this.#response(status),
          usage: responsesUsage(event.usage),
          ...(status === 'incomplete'
            ? {
                incomplete_details: {
                  reason: incompleteReason,
                },
              }
            : {}),
          ...(status === 'failed'
            ? {
                error: {
                  code: 'provider_error',
                  message: event.finishReason.raw ?? 'the provider ended the turn in error',
                },
              }
            : {}),
        };
        const type =
          status === 'completed'
            ? 'response.completed'
            : status === 'incomplete'
              ? 'response.incomplete'
              : 'response.failed';
        events.push(this.#emit(type, { response }));
        return events;
      }
      case 'error': {
        this.#assertReasoningSealed();
        this.#terminal = true;
        return [
          this.#emit('error', {
            type: 'error',
            code: event.code,
            message: event.message,
            param: null,
          }),
        ];
      }
      default: {
        const unknown: never = event;
        throw new ResponsesTranslationError(
          'unknown_event',
          `unrecognized gateway event ${JSON.stringify(unknown)}`
        );
      }
    }
  }

  #assertWellFormedText(delta: string): void {
    if (LONE_SURROGATE.test(delta)) {
      throw new ResponsesTranslationError(
        'ill_formed_text',
        'the gateway delta is not well-formed text'
      );
    }
  }

  #assertReasoningSealed(): void {
    if (!this.#reasoningPending) return;
    throw new ResponsesTranslationError(
      'provider_continuity_missing',
      'the gateway exposed output after reasoning without sealing its provider continuation'
    );
  }

  #bufferReasoningDelta(delta: string): readonly ResponsesSseEvent[] {
    this.#assertWellFormedText(delta);
    const events = [...this.#closeOpenMessage()];
    this.#reasoningPending = true;
    this.#pendingReasoning += delta;
    return events;
  }

  #sealReasoning(itemId: string, encryptedContent: string): readonly ResponsesSseEvent[] {
    if (this.#sealedReasoningItemIds.has(itemId)) {
      throw new ResponsesTranslationError(
        'provider_continuity_mismatch',
        `provider reasoning item ${JSON.stringify(itemId)} was sealed more than once`
      );
    }
    const events = [...this.#closeOpenMessage()];
    const text = this.#pendingReasoning;
    const index = this.#itemIndex++;
    this.#pendingReasoning = '';
    this.#reasoningPending = false;
    this.#sealedReasoningItemIds.add(itemId);

    events.push(
      this.#emit('response.output_item.added', {
        output_index: index,
        item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
      })
    );
    if (text.length > 0) {
      events.push(
        this.#emit('response.reasoning_summary_part.added', {
          item_id: itemId,
          output_index: index,
          ...partIndex('reasoning'),
          part: { type: 'summary_text', text: '' },
        }),
        this.#emit('response.reasoning_summary_text.delta', {
          item_id: itemId,
          output_index: index,
          ...partIndex('reasoning'),
          delta: text,
        }),
        this.#emit('response.reasoning_summary_text.done', {
          item_id: itemId,
          output_index: index,
          ...partIndex('reasoning'),
          text,
        }),
        this.#emit('response.reasoning_summary_part.done', {
          item_id: itemId,
          output_index: index,
          ...partIndex('reasoning'),
          part: { type: 'summary_text', text },
        })
      );
    }
    events.push(
      this.#emit('response.output_item.done', {
        output_index: index,
        item: {
          id: itemId,
          type: 'reasoning',
          status: 'completed',
          summary: text.length > 0 ? [{ type: 'summary_text', text }] : [],
          encrypted_content: encryptedContent,
        },
      })
    );
    return events;
  }

  #messageDelta(delta: string): readonly ResponsesSseEvent[] {
    this.#assertWellFormedText(delta);
    const events: ResponsesSseEvent[] = [];
    if (this.#openMessage === null) {
      const index = this.#itemIndex++;
      const itemId = `msg_${this.options.responseId}_${index}`;
      this.#openMessage = { itemId, index, text: '' };
      events.push(
        this.#emit('response.output_item.added', {
          output_index: index,
          item: {
            id: itemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        }),
        this.#emit('response.content_part.added', {
          item_id: itemId,
          output_index: index,
          ...partIndex('message'),
          part: { type: 'output_text', text: '', annotations: [] },
        })
      );
    }
    const open = this.#openMessage;
    open.text += delta;
    if (delta.length === 0) return events;
    events.push(
      this.#emit('response.output_text.delta', {
        item_id: open.itemId,
        output_index: open.index,
        ...partIndex('message'),
        delta,
      })
    );
    return events;
  }

  #closeOpenMessage(): readonly ResponsesSseEvent[] {
    const open = this.#openMessage;
    if (open === null) return [];
    this.#openMessage = null;
    return [
      this.#emit('response.output_text.done', {
        item_id: open.itemId,
        output_index: open.index,
        ...partIndex('message'),
        text: open.text,
      }),
      this.#emit('response.content_part.done', {
        item_id: open.itemId,
        output_index: open.index,
        ...partIndex('message'),
        part: { type: 'output_text', text: open.text, annotations: [] },
      }),
      this.#emit('response.output_item.done', {
        output_index: open.index,
        item: {
          id: open.itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: open.text, annotations: [] }],
        },
      }),
    ];
  }

  #response(status: string): Record<string, unknown> {
    return {
      id: this.options.responseId,
      object: 'response',
      created_at: this.options.createdAt,
      model: this.options.model,
      status,
      store: false,
    };
  }

  #emit(type: string, payload: Record<string, unknown>): ResponsesSseEvent {
    return { type, payload: { type, sequence_number: this.#sequenceEmitted++, ...payload } };
  }
}

function partIndex(kind: 'message' | 'reasoning'): Record<string, number> {
  return kind === 'message' ? { content_index: 0 } : { summary_index: 0 };
}

export function encodeSseFrame(event: ResponsesSseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

function responsesUsage(usage: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly reasoningTokens: number | null;
}): Record<string, unknown> {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    total_tokens: input + output,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}
