import { describe, expect, it } from 'vitest';

import {
  readResponsesFrames,
  readUsage,
  ResponsesStreamError,
  ToolCallAssembler,
} from './responses-stream.js';

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function streamOf(text: string, options: { eol?: string; chunkSize?: number } = {}) {
  const body = text.replace(/\n/gu, options.eol ?? '\n');
  let cancelled = false;
  const size = options.chunkSize ?? body.length;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += size) {
        controller.enqueue(new TextEncoder().encode(body.slice(i, i + size)));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

async function collect(stream: ReadableStream<Uint8Array>, take: number): Promise<string[]> {
  const seen: string[] = [];
  for await (const f of readResponsesFrames(stream)) {
    seen.push(f.type);
    if (seen.length >= take) break;
  }
  return seen;
}

describe('reading a provider Responses stream', () => {
  it('reads frames split across chunk boundaries', async () => {
    const { stream } = streamOf(
      frame('response.output_text.delta', { delta: 'hello' }) + frame('response.completed', {}),
      { chunkSize: 3 }
    );
    expect(await collect(stream, 2)).toEqual(['response.output_text.delta', 'response.completed']);
  });

  it('reads frames delimited with CRLF', async () => {
    const { stream } = streamOf(frame('response.completed', {}), { eol: '\r\n' });
    expect(await collect(stream, 1)).toEqual(['response.completed']);
  });

  it('releases the stream when the consumer stops', async () => {
    const { stream, cancelled } = streamOf(
      frame('response.output_text.delta', { delta: 'a' }) + frame('response.completed', {})
    );
    await collect(stream, 1);
    expect(cancelled()).toBe(true);
  });

  it('refuses a frame that is not JSON', async () => {
    const { stream } = streamOf('event: response.output_text.delta\ndata: not json\n\n');
    await expect(collect(stream, 1)).rejects.toThrow(ResponsesStreamError);
  });
});

describe('reading reported usage', () => {
  it('reports what the provider counted', () => {
    expect(
      readUsage({
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      })
    ).toMatchObject({
      status: 'reported',
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 7,
      reasoningTokens: 2,
    });
  });

  it('says missing when the provider counted nothing', () => {
    expect(readUsage({}).status).toBe('missing');
    expect(readUsage(null).status).toBe('missing');
  });
});

describe('assembling a tool call', () => {
  const opened = {
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command' },
  };

  it('joins arguments arriving in pieces', () => {
    const assembler = new ToolCallAssembler();
    assembler.opened(opened);
    assembler.delta({ item_id: 'fc_1', delta: '{"cmd"' });
    assembler.delta({ item_id: 'fc_1', delta: ':"ls"}' });
    expect(assembler.closed(opened)).toEqual({
      callId: 'call_1',
      name: 'exec_command',
      input: { cmd: 'ls' },
    });
  });

  it('prefers the closing item over accumulated deltas', () => {
    const assembler = new ToolCallAssembler();
    assembler.opened(opened);
    assembler.delta({ item_id: 'fc_1', delta: '{"partial"' });
    expect(
      assembler.closed({
        item: { ...opened.item, arguments: '{"cmd":"whole"}' },
      })
    ).toMatchObject({ input: { cmd: 'whole' } });
  });

  it('assembles child-owned custom tool input through the same call boundary', () => {
    const assembler = new ToolCallAssembler();
    assembler.opened({
      item: { id: 'ct_1', type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch' },
    });
    assembler.delta({ item_id: 'ct_1', delta: '{"patch":"*** Begin Patch"}' });
    expect(
      assembler.closed({
        item: {
          id: 'ct_1',
          type: 'custom_tool_call',
          call_id: 'call_2',
          name: 'apply_patch',
          input: '{"patch":"*** Begin Patch"}',
        },
      })
    ).toEqual({
      callId: 'call_2',
      name: 'apply_patch',
      input: { patch: '*** Begin Patch' },
    });
  });

  it('ignores an item that is not a function call', () => {
    expect(new ToolCallAssembler().closed({ item: { type: 'reasoning', id: 'r_1' } })).toBeNull();
  });

  it('refuses a call with no id or no name', () => {
    const assembler = new ToolCallAssembler();
    expect(() =>
      assembler.closed({ item: { id: 'fc_1', type: 'function_call', call_id: '', name: 'x' } })
    ).toThrow(/no call id or no name/u);
  });

  it('refuses arguments that are not JSON', () => {
    const assembler = new ToolCallAssembler();
    assembler.opened(opened);
    assembler.delta({ item_id: 'fc_1', delta: 'not json' });
    expect(() => assembler.closed(opened)).toThrow(/not JSON/u);
  });
});
