import { describe, expect, it, vi } from 'vitest';
import type { HostedGenerateRequest, HostedStreamEvent } from '@waypoint/hosted-ai-contract';
import type { HostedAiBridge } from '../hosted-gateway';
import { createHostedIpcTransport } from './ipc-transport';

const request: HostedGenerateRequest = {
  version: 2,
  tier: 'auto',
  workflowId: 'conversation-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
  toolNames: [],
  traceContext: { source: 'desktop_chat', workspaceOpen: false, stagedReferenceIds: [] },
};
const accepted: HostedStreamEvent = {
  v: 2,
  seq: 0,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'accepted',
  reservationId: '00000000-0000-4000-8000-000000000001',
  tier: 'auto',
  catalogVersion: 'catalog-1',
  rateCardVersion: 'rate-1',
};
const finish: HostedStreamEvent = {
  v: 2,
  seq: 1,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'finish',
  reservationId: '00000000-0000-4000-8000-000000000001',
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
  finishReason: { unified: 'stop', raw: 'stop' },
  workflowTrace: null,
  researchContributionNotice: null,
};
const toolCall: HostedStreamEvent = {
  v: 2,
  seq: 1,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
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
const startInput = {
  clientRequestId: 'request-1',
  idempotencyKey: 'idempotency-1',
  turnBindingToken: 'turn-binding-1',
  request,
} as const;

function bridge() {
  let listener: ((envelope: never) => void) | null = null;
  const value = {
    startStream: vi.fn(async () => ({ ok: true as const })),
    cancelStream: vi.fn(async () => ({ ok: true })),
    onStreamEvent: vi.fn((callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
  } as unknown as HostedAiBridge;
  return { value, emit: (envelope: unknown) => listener?.(envelope as never) };
}

describe('Hosted IPC language-model transport', () => {
  it('subscribes before start and yields only the matching real gateway stream', async () => {
    const mock = bridge();
    mock.value.startStream = vi.fn(async () => {
      mock.emit({ clientRequestId: 'other', kind: 'event', event: accepted });
      mock.emit({ clientRequestId: 'request-1', kind: 'event', event: accepted });
      mock.emit({ clientRequestId: 'request-1', kind: 'event', event: finish });
      return { ok: true };
    });
    const transport = createHostedIpcTransport(mock.value);
    const events: HostedStreamEvent[] = [];
    for await (const event of transport.start(startInput)) {
      events.push(event);
    }
    expect(events).toEqual([accepted, finish]);
  });

  it('surfaces main-owned admission failures', async () => {
    const mock = bridge();
    mock.value.startStream = vi.fn(async () => ({
      ok: false,
      code: 'allowance_exhausted',
      message: 'Your DNAForge AI allowance is exhausted.',
    }));
    const transport = createHostedIpcTransport(mock.value);
    const collect = async () => {
      for await (const _event of transport.start(startInput)) {
        continue;
      }
    };
    await expect(collect()).rejects.toThrow('Your DNAForge AI allowance is exhausted.');
  });

  it('wakes a pending iterator and cancels the main-owned fetch on Stop', async () => {
    const mock = bridge();
    const transport = createHostedIpcTransport(mock.value);
    const iterator = transport.start(startInput)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(mock.value.startStream).toHaveBeenCalled());
    await transport.cancel('request-1');
    await expect(pending).rejects.toThrow('Hosted generation was stopped.');
    expect(mock.value.cancelStream).toHaveBeenCalledWith('request-1');
  });

  it('discards every buffered event when a transport failure arrives before consumption', async () => {
    const mock = bridge();
    mock.value.startStream = vi.fn(async () => {
      mock.emit({ clientRequestId: 'request-1', kind: 'event', event: accepted });
      mock.emit({ clientRequestId: 'request-1', kind: 'event', event: toolCall });
      mock.emit({
        clientRequestId: 'request-1',
        kind: 'transport_error',
        message: 'Invalid Hosted stream.',
      });
      return { ok: true };
    });
    const transport = createHostedIpcTransport(mock.value);
    const consumed: HostedStreamEvent[] = [];
    const collect = async () => {
      for await (const event of transport.start(startInput)) {
        consumed.push(event);
      }
    };

    await expect(collect()).rejects.toThrow('Invalid Hosted stream.');
    expect(consumed).toEqual([]);
  });

  it('lets a same-turn transport failure preempt a tool call waiting to be delivered', async () => {
    const mock = bridge();
    const transport = createHostedIpcTransport(mock.value);
    const iterator = transport.start(startInput)[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(mock.value.startStream).toHaveBeenCalled());
    mock.emit({ clientRequestId: 'request-1', kind: 'event', event: accepted });
    await expect(first).resolves.toEqual({ done: false, value: accepted });

    const pendingToolCall = iterator.next();
    await Promise.resolve();
    mock.emit({ clientRequestId: 'request-1', kind: 'event', event: toolCall });
    mock.emit({
      clientRequestId: 'request-1',
      kind: 'transport_error',
      message: 'Invalid Hosted stream.',
    });

    await expect(pendingToolCall).rejects.toThrow('Invalid Hosted stream.');
  });
});
