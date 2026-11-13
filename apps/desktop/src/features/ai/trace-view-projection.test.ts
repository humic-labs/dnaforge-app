import { describe, expect, it } from 'vitest';

import type { AgentTraceEventShape, AgentTraceToolCallShape } from '../../platform';
import { projectTraceItems } from './trace-view-projection';

function event(
  sequence: number,
  calls: AgentTraceToolCallShape[],
  status = calls[0]?.status ?? 'requested'
): AgentTraceEventShape {
  return {
    transport: 'claude-agent-sdk',
    sequence,
    receivedAt: '2026-08-20T00:00:00.000Z',
    providerEventType: status === 'requested' ? 'assistant' : 'user',
    raw: {},
    display: { kind: 'tool', title: 'Using tool', status },
    toolCalls: calls,
    versions: { sdkVersion: '0.3.150', cliVersion: '2.1.209' },
  };
}

describe('projectTraceItems', () => {
  it('keeps one stable row and merges request input with completion output', () => {
    const projected = projectTraceItems(
      [
        event(1, [
          {
            id: 'call-1',
            name: 'list_files',
            status: 'requested',
            input: { path: 'Samples' },
          },
        ]),
        event(2, [{ id: 'call-1', name: 'list_files', status: 'completed', output: { ok: true } }]),
      ],
      (item) => item,
      (_item, index) => `event-${index}`
    );

    expect(projected).toHaveLength(1);
    expect(projected[0].key).toBe('tool-call:call-1');
    expect(projected[0].event?.display).toMatchObject({
      title: 'List files',
      status: 'Completed',
      text: 'File: Samples',
    });
    expect(projected[0].event?.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'list_files',
        status: 'completed',
        input: { path: 'Samples' },
        output: { ok: true },
      },
    ]);
  });

  it('projects parallel calls independently and preserves first-request order', () => {
    const projected = projectTraceItems(
      [
        event(1, [
          { id: 'call-a', name: 'get_workspace', status: 'requested' },
          { id: 'call-b', name: 'list_files', status: 'requested' },
        ]),
        event(2, [{ id: 'call-b', name: 'list_files', status: 'failed' }], 'failed'),
        event(3, [{ id: 'call-a', name: 'get_workspace', status: 'completed' }], 'completed'),
      ],
      (item) => item,
      (_item, index) => `event-${index}`
    );

    expect(projected.map((item) => item.event?.toolCalls?.[0].id)).toEqual(['call-a', 'call-b']);
    expect(projected.map((item) => item.event?.toolCalls?.[0].status)).toEqual([
      'completed',
      'failed',
    ]);
  });

  it('never downgrades a terminal row when an active event arrives late', () => {
    const projected = projectTraceItems(
      [
        event(1, [{ id: 'call-1', name: 'list_files', status: 'completed' }], 'completed'),
        event(2, [{ id: 'call-1', name: 'list_files', status: 'running' }], 'running'),
      ],
      (item) => item,
      (_item, index) => `event-${index}`
    );

    expect(projected).toHaveLength(1);
    expect(projected[0].event?.toolCalls?.[0].status).toBe('completed');
  });

  it('preserves non-tool process messages around the coalesced tool row', () => {
    const reasoning: AgentTraceEventShape = {
      transport: 'claude-agent-sdk',
      sequence: 0,
      receivedAt: '2026-08-20T00:00:00.000Z',
      providerEventType: 'assistant',
      raw: {},
      display: { kind: 'reasoning', title: 'Thinking' },
      versions: { sdkVersion: '0.3.150', cliVersion: '2.1.209' },
    };
    const projected = projectTraceItems(
      [
        reasoning,
        event(1, [{ id: 'call-1', name: 'list_files', status: 'requested' }]),
        event(2, [{ id: 'call-1', name: 'list_files', status: 'completed' }], 'completed'),
      ],
      (item) => item,
      (_item, index) => `event-${index}`
    );

    expect(projected).toHaveLength(2);
    expect(projected[0].event?.display.kind).toBe('reasoning');
    expect(projected[1].event?.toolCalls?.[0].status).toBe('completed');
  });

  it('uses one completed result row when a materialized tool message shares the call id', () => {
    const request = event(1, [{ id: 'call-1', name: 'list_files', status: 'requested' }]);
    const completion = event(
      2,
      [{ id: 'call-1', name: 'list_files', status: 'completed' }],
      'completed'
    );
    const materialized = { toolCallId: 'call-1', result: { ok: true } };
    const items: Array<AgentTraceEventShape | typeof materialized> = [
      request,
      completion,
      materialized,
    ];
    const projected = projectTraceItems(
      items,
      (item) => ('sequence' in item ? item : null),
      (_item, index) => `item-${index}`,
      (item) => ('toolCallId' in item ? item.toolCallId : null)
    );

    expect(projected).toEqual([
      {
        key: 'tool-call:call-1',
        source: materialized,
        event: null,
      },
    ]);
  });

  it('keeps one result row when materialized output precedes lifecycle replay', () => {
    const materialized = { toolCallId: 'call-1', result: { ok: true } };
    const request = event(1, [{ id: 'call-1', name: 'list_files', status: 'requested' }]);
    const completion = event(
      2,
      [{ id: 'call-1', name: 'list_files', status: 'completed' }],
      'completed'
    );
    const items: Array<AgentTraceEventShape | typeof materialized> = [
      materialized,
      request,
      completion,
    ];

    const projected = projectTraceItems(
      items,
      (item) => ('sequence' in item ? item : null),
      (_item, index) => `item-${index}`,
      (item) => ('toolCallId' in item ? item.toolCallId : null)
    );

    expect(projected).toEqual([
      {
        key: 'tool-call:call-1',
        source: materialized,
        event: null,
      },
    ]);
  });
});
