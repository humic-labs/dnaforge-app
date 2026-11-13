import { describe, expect, it, vi } from 'vitest';
import { consumeHostedStream, jsonSafeForIpc } from './hosted';

describe('hosted transport adapter', () => {
  it('reduces text and completed tool parts in stream order', async () => {
    const events = [
      { type: 'text-delta', text: 'before' },
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'mol_get_state', output: {} },
      { type: 'text-delta', delta: 'after' },
    ];
    const seen: string[] = [];

    await consumeHostedStream({
      stream: iterable(events),
      signal: new AbortController().signal,
      onPart: vi.fn(),
      onText: (text) => seen.push(`text:${text}`),
      onTool: async (part) => {
        seen.push(`tool:${part.toolCallId}`);
      },
    });

    expect(seen).toEqual(['text:before', 'tool:call-1', 'text:after']);
  });

  it('throws provider errors and never emits them as answer text', async () => {
    const error = new Error('provider failed');
    await expect(
      consumeHostedStream({
        stream: iterable([{ type: 'error', error }]),
        signal: new AbortController().signal,
        onPart: vi.fn(),
        onText: vi.fn(),
        onTool: vi.fn(),
      })
    ).rejects.toThrow('provider failed');
  });

  it('serializes non-IPC values and circular metadata deterministically', () => {
    const circular: Record<string, unknown> = { count: 1n };
    circular.self = circular;
    expect(jsonSafeForIpc(circular)).toEqual({
      count: { __conversation_ledger_type: 'bigint', value: '1' },
      self: { __conversation_ledger_type: 'circular' },
    });
  });

  it('preserves Error details in the provider event ledger payload', () => {
    const error = new Error('provider failed after tool execution');
    expect(jsonSafeForIpc({ type: 'error', error })).toEqual({
      type: 'error',
      error: {
        __conversation_ledger_type: 'error',
        name: 'Error',
        message: 'provider failed after tool execution',
        stack: error.stack,
        cause: null,
      },
    });
  });
});

async function* iterable(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value;
}
