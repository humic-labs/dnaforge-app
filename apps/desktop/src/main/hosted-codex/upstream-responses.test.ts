import { describe, expect, it } from 'vitest';

import { HostedStreamEventSchema } from '@waypoint/hosted-ai-contract';

import type { AcceptedResponsesRequest } from './responses-wire';
import { createUpstreamStep, UpstreamResponsesError } from './upstream-responses';

const ACCEPTED: AcceptedResponsesRequest = {
  model: 'a-model',
  input: [{ type: 'message', role: 'user', content: 'hi' }],
  toolNames: [],
  maxOutputTokens: undefined,
  instructions: undefined,
  promptCacheKey: undefined,
  parallelToolCalls: undefined,
  reasoning: undefined,
  include: undefined,
  forwarded: { model: 'a-model', stream: true, store: false },
  requestDigest: 'a'.repeat(64),
};

function providerSending(
  frames: string[],
  options: { eol?: string } = {}
): {
  fetchImpl: typeof fetch;
  cancelled: () => boolean;
} {
  const eol = options.eol ?? '\n';
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame.replace(/\n/gu, eol)));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = (async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as never;
  return { fetchImpl, cancelled: () => cancelled };
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const COMPLETED = frame('response.completed', {
  response: { usage: { input_tokens: 11, output_tokens: 3 } },
});

async function collect(fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
  const step = createUpstreamStep({
    apiKey: 'k',
    runId: 'run',
    providerModel: 'a-model',
    fetchImpl,
  });
  const out: Record<string, unknown>[] = [];
  for await (const event of step(ACCEPTED)) out.push(event as unknown as Record<string, unknown>);
  return out;
}

describe('createUpstreamStep', () => {
  it('overwrites the private child model with the reviewed provider route', async () => {
    const seen: { body: Record<string, unknown> | null } = { body: null };
    const step = createUpstreamStep({
      apiKey: 'k',
      runId: 'run',
      providerModel: 'gpt-5.6-luna',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(COMPLETED));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        );
      }) as never,
    });

    for await (const _event of step(ACCEPTED)) void _event;

    expect(seen.body?.model).toBe('gpt-5.6-luna');
    expect(ACCEPTED.forwarded.model).toBe('a-model');
  });

  describe('how the credential is presented', () => {
    it('sends a bearer header by default', async () => {
      const seen: { headers: Headers | null } = { headers: null };
      const step = createUpstreamStep({
        apiKey: 'k',
        runId: 'run',
        providerModel: 'a-model',
        fetchImpl: (async (_url: string, init: RequestInit) => {
          seen.headers = new Headers(init.headers);
          return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
        }) as never,
      });
      await expect(async () => {
        for await (const _event of step(ACCEPTED)) void _event;
      }).rejects.toThrow();
      expect(seen.headers?.get('authorization')).toBe('Bearer k');
      expect(seen.headers?.get('api-key')).toBeNull();
    });

    it('sends an api-key header for Azure', async () => {
      const seen: { headers: Headers | null } = { headers: null };
      const step = createUpstreamStep({
        apiKey: 'k',
        runId: 'run',
        providerModel: 'a-model',
        authScheme: 'azure-api-key',
        fetchImpl: (async (_url: string, init: RequestInit) => {
          seen.headers = new Headers(init.headers);
          return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
        }) as never,
      });
      await expect(async () => {
        for await (const _event of step(ACCEPTED)) void _event;
      }).rejects.toThrow();
      expect(seen.headers?.get('api-key')).toBe('k');
      expect(seen.headers?.get('authorization')).toBeNull();
    });
  });

  describe('what it emits', () => {
    it('emits only events the wire contract accepts', async () => {
      const provider = providerSending([
        frame('response.output_text.delta', { delta: 'hello' }),
        frame('response.reasoning_summary_text.delta', { delta: 'thinking' }),
        COMPLETED,
      ]);
      for (const event of await collect(provider.fetchImpl)) {
        expect(HostedStreamEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
      }
    });

    it('marks a reasoning delta as a summary', async () => {
      const provider = providerSending([
        frame('response.reasoning_summary_text.delta', { delta: 'thinking' }),
        COMPLETED,
      ]);
      const reasoning = (await collect(provider.fetchImpl)).find(
        (event) => event.event === 'reasoning_delta'
      );
      expect(reasoning).toMatchObject({ summary: true, delta: 'thinking' });
    });

    it('reports usage as missing when the provider counted nothing', async () => {
      const provider = providerSending([frame('response.completed', { response: {} })]);
      const finish = (await collect(provider.fetchImpl)).find(
        (event) => event.event === 'finish'
      ) as { usage?: { status?: string } };
      expect(finish.usage?.status).toBe('missing');
    });

    it('reports usage as reported when it did count', async () => {
      const provider = providerSending([COMPLETED]);
      const finish = (await collect(provider.fetchImpl)).find(
        (event) => event.event === 'finish'
      ) as { usage?: { status?: string; inputTokens?: number } };
      expect(finish.usage?.status).toBe('reported');
      expect(finish.usage?.inputTokens).toBe(11);
    });
  });

  describe('the provider stream', () => {
    it('releases the connection once a turn is finished', async () => {
      const provider = providerSending([
        frame('response.output_text.delta', { delta: 'hello' }),
        COMPLETED,
      ]);
      await collect(provider.fetchImpl);
      expect(provider.cancelled()).toBe(true);
    });

    it('reads frames delimited with CRLF', async () => {
      const provider = providerSending(
        [frame('response.output_text.delta', { delta: 'hello' }), COMPLETED],
        { eol: '\r\n' }
      );
      const text = (await collect(provider.fetchImpl)).find(
        (event) => event.event === 'text_delta'
      );
      expect(text).toMatchObject({ delta: 'hello' });
    });

    it('refuses a stream that stops before a terminal event', async () => {
      const provider = providerSending([frame('response.output_text.delta', { delta: 'hi' })]);
      const step = createUpstreamStep({
        apiKey: 'k',
        runId: 'run',
        providerModel: 'a-model',
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(frame('response.output_text.delta', { delta: 'hi' }))
                );
                controller.close();
              },
            }),
            { status: 200 }
          )) as never,
      });
      void provider;
      await expect(async () => {
        for await (const _event of step(ACCEPTED)) void _event;
      }).rejects.toThrow(/ended before it completed/u);
    });
  });

  describe('tool calls', () => {
    const opened = frame('response.output_item.added', {
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command' },
    });

    it('assembles arguments and binds a ticket to the call', async () => {
      const provider = providerSending([
        opened,
        frame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"cmd"' }),
        frame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: ':"ls"}' }),
        frame('response.output_item.done', {
          item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command' },
        }),
        COMPLETED,
      ]);
      const call = (await collect(provider.fetchImpl)).find(
        (event) => event.event === 'tool_call'
      ) as { input?: unknown; ticket?: { providerCallId?: string; toolName?: string } };
      expect(call.input).toEqual({ cmd: 'ls' });
      expect(call.ticket?.providerCallId).toBe('call_1');
      expect(call.ticket?.toolName).toBe('exec_command');
    });

    it('refuses a tool call with no call id', async () => {
      const provider = providerSending([
        frame('response.output_item.added', {
          item: { id: 'fc_1', type: 'function_call', call_id: '', name: 'exec_command' },
        }),
        frame('response.output_item.done', {
          item: { id: 'fc_1', type: 'function_call', call_id: '', name: 'exec_command' },
        }),
        COMPLETED,
      ]);
      await expect(collect(provider.fetchImpl)).rejects.toThrow(UpstreamResponsesError);
    });

    it('refuses tool arguments that are not JSON', async () => {
      const provider = providerSending([
        opened,
        frame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: 'not json' }),
        frame('response.output_item.done', {
          item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command' },
        }),
        COMPLETED,
      ]);
      await expect(collect(provider.fetchImpl)).rejects.toThrow(/not JSON/u);
    });
  });
});
