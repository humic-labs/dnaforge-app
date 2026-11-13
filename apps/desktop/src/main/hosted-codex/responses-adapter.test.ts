import {
  HOSTED_GENERATION_WIRE_VERSION,
  HOSTED_TOOL_DISPATCH_NAME,
  hostedResponsesFunctionWireName,
  HostedStreamEventSchema,
  type HostedFinishReason,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import { describe, expect, it } from 'vitest';

import {
  encodeSseFrame,
  ResponsesTranslationError,
  ResponsesTranslator,
  type ResponsesSseEvent,
} from './responses-adapter';

const RESERVATION = '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let seq = 0;
function base(): {
  v: typeof HOSTED_GENERATION_WIRE_VERSION;
  seq: number;
  requestId: string;
  runId: string;
  turnId: string;
  stepSequence: number;
} {
  return {
    v: HOSTED_GENERATION_WIRE_VERSION,
    seq: ++seq,
    requestId: 'req-1',
    runId: 'run-1',
    turnId: 'turn-1',
    stepSequence: 1,
  };
}

const usage = {
  status: 'reported',
  inputTokens: 120,
  outputTokens: 40,
  cacheReadTokens: 8,
  cacheWriteTokens: null,
  reasoningTokens: 12,
} as const;

function accepted(): HostedStreamEvent {
  return {
    ...base(),
    event: 'accepted',
    reservationId: RESERVATION,
    tier: 'auto',
    catalogVersion: '1.0.0',
    rateCardVersion: '1.0.0',
  };
}

function textDelta(delta: string): HostedStreamEvent {
  return { ...base(), event: 'text_delta', delta };
}

function reasoningDelta(delta: string): HostedStreamEvent {
  return {
    ...base(),
    event: 'reasoning_delta',
    summary: true,
    delta,
  };
}

function reasoningContinuation(
  itemId = 'rs_provider_1',
  encryptedContent = 'encrypted-provider-reasoning'
): HostedStreamEvent {
  return {
    ...base(),
    event: 'reasoning_continuation',
    itemId,
    encryptedContent,
  };
}

function toolCall(toolCallId: string, name: string, input: unknown): HostedStreamEvent {
  return {
    ...base(),
    event: 'tool_call',
    toolCallId,
    name,
    input,
    ticket: {
      token: 'ticketpayload.ticketsignature',
      expiresAt: '2026-08-20T00:00:00.000Z',
      providerCallId: toolCallId,
      toolName: name,
      requiresUserApproval: false,
    },
  };
}

function childToolCall(toolCallId: string, name: string, input: unknown): HostedStreamEvent {
  return {
    ...base(),
    event: 'child_tool_call',
    toolCallId,
    name,
    input,
  };
}

describe('discovered action Responses transport', () => {
  it('retains original ticket identity while returning the offered dispatcher to the real child', () => {
    const translator = new ResponsesTranslator({
      responseId: 'resp-dispatch',
      model: 'gpt-5-codex',
      createdAt: 0,
      dispatchedToolNames: ['create_design'],
    });
    translator.translate(accepted());
    const event = toolCall('original-provider-call', 'create_design', { name: 'Owned design' });
    const emitted = translator.translate(event);
    expect(
      emitted.find((item) => item.type === 'response.output_item.done')?.payload.item
    ).toMatchObject({
      call_id: 'original-provider-call',
      name: hostedResponsesFunctionWireName(HOSTED_TOOL_DISPATCH_NAME),
      arguments: JSON.stringify({
        name: 'create_design',
        arguments: JSON.stringify({ name: 'Owned design' }),
      }),
    });
    expect(event).toMatchObject({
      name: 'create_design',
      ticket: { toolName: 'create_design', providerCallId: 'original-provider-call' },
    });
  });
});

function finish(unified: HostedFinishReason['unified']): HostedStreamEvent {
  return {
    ...base(),
    event: 'finish',
    reservationId: RESERVATION,
    usageEventId: null,
    outcome: 'completed',
    usage,
    finishReason: { unified, raw: unified },
    workflowTrace: null,
    researchContributionNotice: null,
  };
}

function streamError(code: string): HostedStreamEvent {
  return {
    ...base(),
    event: 'error',
    reservationId: RESERVATION,
    code,
    message: 'the provider stream failed',
    retryable: true,
    reservationDisposition: 'released',
  };
}

function translator(): ResponsesTranslator {
  seq = 0;
  return new ResponsesTranslator({
    responseId: 'resp_abc',
    model: 'gpt-5-codex',
    createdAt: 1_770_000_000,
  });
}

function types(events: readonly ResponsesSseEvent[]): string[] {
  return events.map((event) => event.type);
}

function rejection(run: () => void): ResponsesTranslationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ResponsesTranslationError) return error;
    throw error;
  }
  throw new Error('expected the translation to be refused');
}

describe('ResponsesTranslator', () => {
  it('builds fixtures the gateway contract actually accepts', () => {
    seq = 0;
    for (const event of [
      accepted(),
      textDelta('hi'),
      reasoningDelta('thinking'),
      reasoningContinuation(),
      childToolCall('call-child-1', 'exec_command', { cmd: 'pwd' }),
      toolCall('call-1', 'read_file', { path: 'a.txt' }),
      finish('stop'),
      streamError('provider_unavailable'),
    ]) {
      expect(HostedStreamEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('opens the response before any output', () => {
    const subject = translator();
    expect(types(subject.translate(accepted()))).toEqual([
      'response.created',
      'response.in_progress',
    ]);
  });

  it('emits a complete text turn in Responses order', () => {
    const subject = translator();
    const emitted = [
      ...subject.translate(accepted()),
      ...subject.translate(textDelta('The plate ')),
      ...subject.translate(textDelta('has 96 wells.')),
      ...subject.translate(finish('stop')),
    ];
    expect(types(emitted)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const done = emitted.find((event) => event.type === 'response.output_text.done');
    expect(done?.payload.text).toBe('The plate has 96 wells.');
  });

  it('numbers every emitted event consecutively from zero', () => {
    const subject = translator();
    const emitted = [
      ...subject.translate(accepted()),
      ...subject.translate(textDelta('a')),
      ...subject.translate(finish('stop')),
    ];
    expect(emitted.map((event) => event.payload.sequence_number)).toEqual(
      emitted.map((_event, index) => index)
    );
  });

  it('carries the gateway usage into the terminal event without recomputing it', () => {
    const subject = translator();
    subject.translate(accepted());
    const [completed] = subject.translate(finish('stop'));
    expect(completed?.payload.response).toMatchObject({
      status: 'completed',
      store: false,
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        total_tokens: 160,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 12 },
      },
    });
  });

  it('reports a tool call as a completed function_call item', () => {
    const subject = translator();
    subject.translate(accepted());
    const emitted = subject.translate(toolCall('call-1', 'read_file', { path: 'a.txt' }));
    expect(types(emitted)).toEqual([
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
    ]);
    expect(emitted.at(-1)?.payload.item).toMatchObject({
      type: 'function_call',
      status: 'completed',
      name: 'read_file',
      call_id: 'call-1',
      arguments: '{"path":"a.txt"}',
    });
  });

  it('reports a child-owned call without inventing a DNAForge tool ticket', () => {
    const subject = translator();
    subject.translate(accepted());
    const emitted = subject.translate(childToolCall('call-1', 'exec_command', { cmd: 'pwd' }));
    expect(types(emitted)).toEqual([
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
    ]);
    expect(emitted.at(-1)?.payload.item).toMatchObject({
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call-1',
      arguments: '{"cmd":"pwd"}',
    });
  });

  it('returns a canonical dotted DNAForge tool under its exact child wire name', () => {
    const subject = translator();
    subject.translate(accepted());
    const emitted = subject.translate(toolCall('call-1', 'external.fetch', { url: 'https://x' }));

    expect(emitted.at(-1)?.payload.item).toMatchObject({
      type: 'function_call',
      name: 'dnaforge_ZXh0ZXJuYWwuZmV0Y2g',
      call_id: 'call-1',
    });
  });

  it('closes open text before starting a tool call', () => {
    const subject = translator();
    subject.translate(accepted());
    subject.translate(textDelta('Let me look.'));
    const emitted = subject.translate(toolCall('call-1', 'read_file', {}));
    expect(types(emitted).slice(0, 3)).toEqual([
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
    ]);
  });

  it('separates reasoning from message output', () => {
    const subject = translator();
    subject.translate(accepted());
    const reasoning = subject.translate(reasoningDelta('Checking the plate.'));
    expect(reasoning).toEqual([]);
    const sealed = subject.translate(reasoningContinuation());
    expect(types(sealed)).toEqual([
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
    ]);
    const text = subject.translate(textDelta('96 wells.'));
    expect(types(text)).toEqual([
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
    ]);
  });

  it('replays the provider reasoning id and encrypted payload for stateless continuation', () => {
    const subject = translator();
    subject.translate(accepted());
    expect(subject.translate(reasoningDelta('Inspecting the workspace.'))).toEqual([]);
    const sealed = subject.translate(reasoningContinuation());
    const reasoningDone = sealed.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        isRecord(event.payload.item) &&
        event.payload.item.type === 'reasoning'
    );

    expect(reasoningDone?.payload.item).toEqual({
      id: 'rs_provider_1',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'Inspecting the workspace.' }],
      encrypted_content: 'encrypted-provider-reasoning',
    });
  });

  it('fails locally before exposing a tool when reasoning continuity is missing', () => {
    const subject = translator();
    subject.translate(accepted());
    expect(subject.translate(reasoningDelta('Inspecting the workspace.'))).toEqual([]);

    const error = rejection(() => subject.translate(toolCall('call-1', 'read_file', {})));

    expect(error.code).toBe('provider_continuity_missing');
  });

  it('refuses a duplicate provider reasoning continuation identity', () => {
    const subject = translator();
    subject.translate(accepted());
    subject.translate(reasoningDelta('First item.'));
    subject.translate(reasoningContinuation('rs_provider_1', 'encrypted-first'));
    subject.translate(reasoningDelta('Second item.'));

    const error = rejection(() =>
      subject.translate(reasoningContinuation('rs_provider_1', 'encrypted-second'))
    );

    expect(error.code).toBe('provider_continuity_mismatch');
  });

  it('gives every output item a distinct index', () => {
    const subject = translator();
    subject.translate(accepted());
    const emitted = [
      ...subject.translate(reasoningDelta('thinking')),
      ...subject.translate(reasoningContinuation()),
      ...subject.translate(textDelta('answering')),
      ...subject.translate(toolCall('call-1', 'read_file', {})),
      ...subject.translate(finish('tool-calls')),
    ];
    const indexes = new Set(
      emitted
        .filter((event) => event.type === 'response.output_item.done')
        .map((event) => event.payload.output_index)
    );
    expect([...indexes]).toEqual([0, 1, 2]);
  });

  describe('terminal mapping', () => {
    it('never turns an unknown future finish reason into completed', () => {
      const subject = translator();
      subject.translate(accepted());
      const event = finish('stop');
      const future = {
        ...event,
        finishReason: { unified: 'future-provider-status', raw: 'future-provider-status' },
      };

      const error = rejection(() => Reflect.apply(subject.translate, subject, [future]));

      expect(error.code).toBe('unknown_event');
    });

    it.each([
      ['stop', 'response.completed', 'completed'],
      ['tool-calls', 'response.completed', 'completed'],
      ['other', 'response.completed', 'completed'],
      ['length', 'response.incomplete', 'incomplete'],
      ['content-filter', 'response.incomplete', 'incomplete'],
      ['error', 'response.failed', 'failed'],
    ] as const)('maps the gateway finish reason %s to %s', (unified, type, status) => {
      const subject = translator();
      subject.translate(accepted());
      const [terminal] = subject.translate(finish(unified));
      expect(terminal?.type).toBe(type);
      expect((terminal?.payload.response as { status: string }).status).toBe(status);
      expect(subject.isTerminal).toBe(true);
    });

    it('names why an incomplete response stopped', () => {
      const subject = translator();
      subject.translate(accepted());
      const [terminal] = subject.translate(finish('length'));
      expect(terminal?.payload.response).toMatchObject({
        incomplete_details: { reason: 'max_output_tokens' },
      });
    });

    it('reports a gateway error as a Responses error and ends the stream', () => {
      const subject = translator();
      subject.translate(accepted());
      const emitted = subject.translate(streamError('provider_unavailable'));
      expect(types(emitted)).toEqual(['error']);
      expect(emitted[0]?.payload).toMatchObject({ code: 'provider_unavailable' });
      expect(subject.isTerminal).toBe(true);
    });

    it('abandons partial text on error rather than reporting it as an answer', () => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(textDelta('The plate has'));
      const emitted = subject.translate(streamError('provider_unavailable'));
      expect(types(emitted)).toEqual(['error']);
    });
  });

  describe('OpenAI wire vocabulary', () => {
    it.each([
      ['length', 'max_output_tokens'],
      ['content-filter', 'content_filter'],
    ] as const)('reports the gateway reason %s as the Responses reason %s', (unified, expected) => {
      const subject = translator();
      subject.translate(accepted());
      const [terminal] = subject.translate(finish(unified));
      expect(terminal?.payload.response).toMatchObject({
        incomplete_details: { reason: expected },
      });
    });

    it('gives a failed response a reason to show', () => {
      const subject = translator();
      subject.translate(accepted());
      const [terminal] = subject.translate(finish('error'));
      expect(terminal?.type).toBe('response.failed');
      expect((terminal?.payload.response as { error: unknown }).error).toMatchObject({
        code: 'provider_error',
        message: expect.any(String),
      });
    });

    it('indexes message content and reasoning summaries by their own field only', () => {
      const subject = translator();
      const emitted = [
        ...subject.translate(accepted()),
        ...subject.translate(reasoningDelta('thinking')),
        ...subject.translate(reasoningContinuation()),
        ...subject.translate(textDelta('answering')),
        ...subject.translate(toolCall('call-1', 'read_file', {})),
        ...subject.translate(finish('tool-calls')),
      ];

      const contentEvents = emitted.filter(
        (event) => event.type.includes('output_text') || event.type.includes('content_part')
      );
      const summaryEvents = emitted.filter((event) => event.type.includes('reasoning_summary'));
      expect(contentEvents.length).toBeGreaterThan(0);
      expect(summaryEvents.length).toBeGreaterThan(0);

      for (const event of contentEvents) {
        expect(event.payload, event.type).toHaveProperty('content_index');
        expect(event.payload, event.type).not.toHaveProperty('summary_index');
      }
      for (const event of summaryEvents) {
        expect(event.payload, event.type).toHaveProperty('summary_index');
        expect(event.payload, event.type).not.toHaveProperty('content_index');
      }
      for (const event of emitted.filter((entry) =>
        entry.type.startsWith('response.output_item.')
      )) {
        expect(event.payload, event.type).not.toHaveProperty('content_index');
        expect(event.payload, event.type).not.toHaveProperty('summary_index');
      }
    });
  });

  describe('order', () => {
    it.each([
      ['text', () => textDelta('hi')],
      ['a tool call', () => toolCall('call-1', 'read_file', {})],
      ['a finish', () => finish('stop')],
      ['an error', () => streamError('boom')],
    ])('refuses %s before the step is accepted', (_label, make) => {
      const subject = translator();
      expect(rejection(() => subject.translate(make())).code).toBe('event_before_accepted');
    });

    it('refuses a second accepted event', () => {
      const subject = translator();
      subject.translate(accepted());
      expect(rejection(() => subject.translate(accepted())).code).toBe('duplicate_accepted');
    });

    it('names what is actually wrong when a replay is also a duplicate', () => {
      const subject = translator();
      const first = accepted();
      subject.translate(first);
      expect(rejection(() => subject.translate({ ...first })).code).toBe('duplicate_accepted');
    });

    it('names the missing accepted rather than the sequence when both are wrong', () => {
      const subject = translator();
      subject.translate(accepted());
      const fresh = translator();
      expect(rejection(() => fresh.translate(textDelta('hi'))).code).toBe('event_before_accepted');
    });

    it('refuses a repeated gateway sequence number', () => {
      const subject = translator();
      subject.translate(accepted());
      const replayed = { ...textDelta('a'), seq: 1 } as HostedStreamEvent;
      expect(rejection(() => subject.translate(replayed)).code).toBe('sequence_not_advancing');
    });

    it('refuses a regressed gateway sequence number', () => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(textDelta('a'));
      const stale = { ...textDelta('b'), seq: 2 } as HostedStreamEvent;
      expect(rejection(() => subject.translate(stale)).code).toBe('sequence_not_advancing');
    });

    it('accepts a gap in the gateway sequence, which only proves advance', () => {
      const subject = translator();
      subject.translate(accepted());
      const skipped = { ...textDelta('a'), seq: 99 } as HostedStreamEvent;
      expect(types(subject.translate(skipped))).toContain('response.output_text.delta');
    });

    it.each([
      ['text', () => textDelta('trailing')],
      ['a second finish', () => finish('stop')],
      ['a tool call', () => toolCall('call-2', 'read_file', {})],
      ['an error', () => streamError('late')],
    ])('refuses %s after a finish', (_label, make) => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(finish('stop'));
      expect(rejection(() => subject.translate(make())).code).toBe('event_after_terminal');
    });

    it('refuses a finish after an error', () => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(streamError('boom'));
      expect(rejection(() => subject.translate(finish('stop'))).code).toBe('event_after_terminal');
    });
  });

  describe('truncated streams', () => {
    it('refuses a stream that ends with no terminal event', () => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(textDelta('The plate has'));
      expect(rejection(() => subject.end()).code).toBe('unterminated_stream');
    });

    it('refuses a stream that produced nothing at all', () => {
      expect(rejection(() => translator().end()).code).toBe('unterminated_stream');
    });

    it('accepts a stream that ended terminally', () => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(finish('stop'));
      expect(() => subject.end()).not.toThrow();
    });

    it('treats an aborted turn as unterminated, not as an empty answer', () => {
      const subject = translator();
      subject.translate(accepted());
      subject.translate(textDelta('partial'));
      expect(rejection(() => subject.end()).code).toBe('unterminated_stream');
    });
  });

  describe('text integrity', () => {
    it.each([
      ['a lone high surrogate', '\uD83D'],
      ['a lone low surrogate', '\uDE00'],
      ['a high surrogate followed by ASCII', 'ok \uD83D!'],
      ['a low surrogate after text', 'ok\uDC00'],
    ])('refuses %s in a text delta', (_label, delta) => {
      const subject = translator();
      subject.translate(accepted());
      expect(rejection(() => subject.translate(textDelta(delta))).code).toBe('ill_formed_text');
    });

    it('refuses ill-formed reasoning text too', () => {
      const subject = translator();
      subject.translate(accepted());
      expect(rejection(() => subject.translate(reasoningDelta('\uD800'))).code).toBe(
        'ill_formed_text'
      );
    });

    it.each([
      ['an emoji', 'plate 🧬 ready'],
      ['combining marks', 'état'],
      ['CJK', '培養プレート'],
      ['a newline', 'line one\nline two'],
    ])('carries %s through unchanged', (_label, delta) => {
      const subject = translator();
      subject.translate(accepted());
      const emitted = subject.translate(textDelta(delta));
      expect(emitted.at(-1)?.payload.delta).toBe(delta);
    });
  });

  describe('SSE framing', () => {
    it('frames an event as a single SSE record', () => {
      const frame = encodeSseFrame({ type: 'response.created', payload: { type: 'x' } });
      expect(frame).toBe('event: response.created\ndata: {"type":"x"}\n\n');
    });

    it('never lets text split a frame', () => {
      const subject = translator();
      subject.translate(accepted());
      const emitted = subject.translate(textDelta('one\ntwo\r\n\r\nthree'));
      const frame = encodeSseFrame(emitted.at(-1)!);
      expect(frame.split('\n\n')).toHaveLength(2);
      const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '));
      expect(dataLines).toHaveLength(1);
    });

    it('round-trips the delta through the frame', () => {
      const subject = translator();
      subject.translate(accepted());
      const emitted = subject.translate(textDelta('a\tb"c\\d e'));
      const frame = encodeSseFrame(emitted.at(-1)!);
      const data = frame.slice(frame.indexOf('data: ') + 6, -2);
      expect((JSON.parse(data) as { delta: string }).delta).toBe('a\tb"c\\d e');
    });
  });

  describe('response digest', () => {
    it('is stable for an identical stream and differs for a different one', () => {
      const run = (text: string): string => {
        const subject = translator();
        subject.translate(accepted());
        subject.translate(textDelta(text));
        subject.translate(finish('stop'));
        return subject.responseDigest();
      };
      expect(run('same')).toBe(run('same'));
      expect(run('same')).not.toBe(run('different'));
    });

    it('can be read before the stream ends without ending it', () => {
      const subject = translator();
      subject.translate(accepted());
      const early = subject.responseDigest();
      subject.translate(textDelta('more'));
      expect(subject.responseDigest()).not.toBe(early);
      expect(() => subject.translate(finish('stop'))).not.toThrow();
    });
  });
});
