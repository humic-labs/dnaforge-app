import { describe, expect, it } from 'vitest';
import type { ConversationLedgerEvent } from './envelope';
import { compareProjectedMessagesToLive, projectConversationLedgerEvents } from './projection';

function event(
  input: Partial<ConversationLedgerEvent> & { event_seq: number }
): ConversationLedgerEvent {
  return {
    schema_version: 1,
    event_id: `event-${input.event_seq}`,
    conversation_id: 'conv-1',
    turn_id: 'turn-1',
    source: 'provider:vercel',
    provider: 'anthropic',
    model: 'claude-sonnet',
    stream_event_type: 'text-delta',
    block_id: null,
    call_id: null,
    item_id: null,
    payload: {},
    created_at: `2026-06-11T00:00:${String(input.event_seq).padStart(2, '0')}.000Z`,
    ...input,
  };
}

describe('projectConversationLedgerEvents', () => {
  it('rebuilds provider user/text/tool/text messages ordered by event_seq', () => {
    const projection = projectConversationLedgerEvents([
      event({
        event_seq: 4,
        stream_event_type: 'text-delta',
        payload: { type: 'text-delta', id: 'text-2', text: 'Done.' },
      }),
      event({
        event_seq: 1,
        source: 'app:chat',
        provider: 'anthropic',
        model: 'claude-sonnet',
        stream_event_type: 'user-message',
        payload: {
          message: { role: 'user', content: 'List files' },
          route: { routeKind: 'provider' },
        },
      }),
      event({
        event_seq: 2,
        stream_event_type: 'text-delta',
        payload: { type: 'text-delta', id: 'text-1', text: 'I will check. ' },
      }),
      event({
        event_seq: 3,
        stream_event_type: 'tool-result',
        payload: {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'list_files',
          input: { path: '/workspace' },
          output: { files: ['a.gb'] },
        },
      }),
    ]);

    expect(projection).toHaveLength(1);
    expect(projection[0].messages).toMatchObject([
      { role: 'user', content: 'List files' },
      { role: 'assistant', content: 'I will check. ' },
      { role: 'tool', tool_name: 'list_files', tool_call_id: 'tc-1' },
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(JSON.parse(projection[0].messages[2].content)).toEqual({
      input: { path: '/workspace' },
      output: { files: ['a.gb'] },
      isError: false,
    });
  });

  it('uses chat.turn-materialized as the exact assistant/reference projection', () => {
    const referenceId = '11111111-1111-4111-8111-111111111111';
    const canonicalContent = `Open [pUC19](dnaforge-chat://reference/${referenceId}).`;
    const entityReference = {
      id: referenceId,
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Research Workspace/constructs/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'folders:["/repo"]',
      workspace_root_path: '/repo',
      created_at: 10,
      updated_at: 10,
    };
    const projection = projectConversationLedgerEvents([
      event({
        event_seq: 1,
        source: 'app:chat',
        stream_event_type: 'user-message',
        payload: { message: { role: 'user', content: 'Show pUC19' } },
      }),
      event({
        event_seq: 2,
        stream_event_type: 'text-delta',
        payload: {
          text: 'Open [pUC19](dnaforge-chat://entity/sequence/Research%20Workspace/constructs/pUC19.gb).',
        },
      }),
      event({
        event_seq: 3,
        source: 'app:chat',
        stream_event_type: 'chat.turn-materialized',
        payload: {
          schema_version: 1,
          messages: [
            {
              message: {
                id: 'assistant-1',
                role: 'assistant',
                content: canonicalContent,
                tool_name: null,
                tool_call_id: null,
                created_at: 10,
              },
              reference_ids: [referenceId],
            },
          ],
          entity_references: [entityReference],
        },
      }),
    ]);

    expect(projection[0].messages).toMatchObject([
      { role: 'user', content: 'Show pUC19' },
      {
        role: 'assistant',
        content: canonicalContent,
        message_id: 'assistant-1',
        reference_ids: [referenceId],
      },
    ]);
    expect(projection[0].entity_references).toEqual([entityReference]);
  });

  it('lets the latest materialized turn replace stale entity rows from an earlier projection', () => {
    const entityReference = (id: string, label: string) => ({
      id,
      entity_type: 'sequence',
      display_label: label,
      locator: `git://Research Workspace/${label}`,
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'folders:["/repo"]',
      workspace_root_path: '/repo',
      created_at: 10,
      updated_at: 10,
    });
    const stale = entityReference('11111111-1111-4111-8111-111111111111', 'stale.gb');
    const current = entityReference('22222222-2222-4222-8222-222222222222', 'current.gb');
    const materialized = (
      eventSeq: number,
      reference: ReturnType<typeof entityReference>
    ): ConversationLedgerEvent =>
      event({
        event_seq: eventSeq,
        source: 'app:chat',
        stream_event_type: 'chat.turn-materialized',
        payload: {
          schema_version: 1,
          messages: [
            {
              message: {
                id: `assistant-${eventSeq}`,
                role: 'assistant',
                content: `[${reference.display_label}](dnaforge-chat://reference/${reference.id})`,
                tool_name: null,
                tool_call_id: null,
                created_at: eventSeq,
              },
              reference_ids: [reference.id],
            },
          ],
          entity_references: [reference],
        },
      });

    const projection = projectConversationLedgerEvents([
      materialized(1, stale),
      materialized(2, current),
    ]);

    expect(projection[0].entity_references).toEqual([current]);
    expect(projection[0].messages).toMatchObject([
      { message_id: 'assistant-2', reference_ids: [current.id] },
    ]);
  });

  it('projects CLI assistant text and chat-visible activity while dropping diagnostics', () => {
    const projection = projectConversationLedgerEvents([
      event({
        event_seq: 1,
        source: 'app:chat',
        stream_event_type: 'user-message',
        payload: { message: { role: 'user', content: 'Inspect workspace' } },
      }),
      event({
        event_seq: 2,
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'thread.started',
        payload: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-11T00:00:00.000Z',
          providerEventType: 'thread.started',
          display: { kind: 'lifecycle', title: 'thread.started' },
        },
      }),
      event({
        event_seq: 3,
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'item.completed',
        payload: {
          transport: 'codex-sdk',
          sequence: 1,
          receivedAt: '2026-06-11T00:00:01.000Z',
          providerEventType: 'item.completed',
          providerItemId: 'assistant-1',
          raw: { item: { text: 'I inspected it.' } },
          display: { kind: 'assistant_text', title: 'Assistant', text: 'fallback' },
        },
      }),
      event({
        event_seq: 4,
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'item.completed',
        payload: {
          transport: 'codex-sdk',
          sequence: 2,
          receivedAt: '2026-06-11T00:00:02.000Z',
          providerEventType: 'item.completed',
          providerItemId: 'cmd-1',
          display: { kind: 'command', title: 'Read files', text: 'ls' },
        },
      }),
    ]);

    expect(projection[0].messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'activity',
    ]);
    expect(projection[0].messages[1].content).toBe('I inspected it.');
  });

  it('rebuilds a completed CLI history view call as an activity plus durable tool receipt', () => {
    const projection = projectConversationLedgerEvents([
      event({
        event_seq: 1,
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'item.completed',
        payload: {
          transport: 'codex-sdk',
          sequence: 1,
          receivedAt: '2026-06-11T00:00:01.000Z',
          providerEventType: 'item.completed',
          providerItemId: 'tool-1',
          display: {
            kind: 'tool',
            title: 'highlight_range',
            status: 'completed',
            visibility: 'chat',
          },
          toolCalls: [
            {
              id: 'call-highlight',
              name: 'mcp__dnaforge__highlight_range',
              mcpServer: 'dnaforge',
              status: 'completed',
              input: { path: '/workspace/pUC19.gb', start: 683, end: 688 },
              output: { ok: true },
            },
          ],
        },
      }),
    ]);

    expect(projection[0].messages).toMatchObject([
      { role: 'activity' },
      {
        role: 'tool',
        tool_name: 'highlight_range',
        tool_call_id: 'call-highlight',
      },
    ]);
    expect(JSON.parse(projection[0].messages[1].content)).toEqual({
      input: { path: '/workspace/pUC19.gb', start: 683, end: 688 },
      output: { ok: true },
      isError: false,
    });
  });

  it('preserves CLI tool input across a running event that omits it', () => {
    const request = event({
      event_seq: 1,
      source: 'cli:codex',
      provider: 'codex-sdk',
      stream_event_type: 'item.started',
      payload: {
        transport: 'codex-sdk',
        sequence: 1,
        receivedAt: '2026-06-11T00:00:01.000Z',
        providerEventType: 'item.started',
        display: { kind: 'tool', title: 'highlight_range', status: 'running' },
        toolCalls: [
          {
            id: 'call-highlight',
            name: 'mcp__dnaforge__highlight_range',
            mcpServer: 'dnaforge',
            status: 'requested',
            input: { path: '/workspace/pUC19.gb', start: 683, end: 688 },
          },
        ],
      },
    });
    const running = event({
      event_seq: 2,
      source: 'cli:codex',
      provider: 'codex-sdk',
      stream_event_type: 'item.updated',
      payload: {
        transport: 'codex-sdk',
        sequence: 2,
        receivedAt: '2026-06-11T00:00:02.000Z',
        providerEventType: 'item.updated',
        display: { kind: 'tool', title: 'highlight_range', status: 'running' },
        toolCalls: [
          {
            id: 'call-highlight',
            name: 'mcp__dnaforge__highlight_range',
            mcpServer: 'dnaforge',
            status: 'running',
          },
        ],
      },
    });
    const completed = event({
      event_seq: 3,
      source: 'cli:codex',
      provider: 'codex-sdk',
      stream_event_type: 'item.completed',
      payload: {
        transport: 'codex-sdk',
        sequence: 3,
        receivedAt: '2026-06-11T00:00:03.000Z',
        providerEventType: 'item.completed',
        display: { kind: 'tool', title: 'highlight_range', status: 'completed' },
        toolCalls: [
          {
            id: 'call-highlight',
            name: 'mcp__dnaforge__highlight_range',
            mcpServer: 'dnaforge',
            status: 'completed',
            output: { ok: true },
          },
        ],
      },
    });

    const projection = projectConversationLedgerEvents([request, running, completed]);
    const toolMessage = projection[0].messages.find((message) => message.role === 'tool');

    expect(JSON.parse(toolMessage?.content ?? '{}').input).toEqual({
      path: '/workspace/pUC19.gb',
      start: 683,
      end: 688,
    });
  });

  it('dedupes a CLI tool lifecycle and matches the live empty-input representation', () => {
    const lifecycle = [
      { eventSeq: 1, eventType: 'item.started', status: 'requested' },
      { eventSeq: 3, eventType: 'item.updated', status: 'running' },
      { eventSeq: 4, eventType: 'item.completed', status: 'completed' },
    ] as const;
    const projection = projectConversationLedgerEvents([
      ...lifecycle.map(({ eventSeq, eventType, status }) =>
        event({
          event_seq: eventSeq,
          source: 'cli:codex',
          provider: 'codex-sdk',
          stream_event_type: eventType,
          payload: {
            transport: 'codex-sdk',
            sequence: eventSeq,
            receivedAt: `2026-06-11T00:00:0${eventSeq}.000Z`,
            providerEventType: eventType,
            providerItemId: 'tool-without-input',
            display: {
              kind: 'tool',
              title: 'highlight_range',
              status,
              visibility: 'chat',
            },
            toolCalls: [
              {
                id: 'call-without-input',
                name: 'mcp__dnaforge__highlight_range',
                mcpServer: 'dnaforge',
                status,
                ...(status === 'completed' ? { output: { ok: true } } : {}),
              },
            ],
          },
        })
      ),
      event({
        event_seq: 2,
        source: 'cli:codex',
        provider: 'codex-sdk',
        stream_event_type: 'item.completed',
        payload: {
          transport: 'codex-sdk',
          sequence: 2,
          receivedAt: '2026-06-11T00:00:02.000Z',
          providerEventType: 'item.completed',
          providerItemId: 'assistant-between',
          display: { kind: 'assistant_text', title: 'Assistant' },
          raw: { item: { text: 'Working on it.' } },
        },
      }),
    ]);

    expect(projection[0].messages.map((message) => message.role)).toEqual([
      'activity',
      'tool',
      'assistant',
    ]);
    expect(projection[0].messages[0]).toMatchObject({ first_event_seq: 1, last_event_seq: 4 });
    expect(projection[0].messages[1]).toMatchObject({ first_event_seq: 1, last_event_seq: 4 });
    expect(
      JSON.parse(projection[0].messages[0].content).event.toolCalls.map(
        (call: { status: string }) => call.status
      )
    ).toEqual(['requested', 'running', 'completed']);
    expect(JSON.parse(projection[0].messages[1].content)).toEqual({
      input: {},
      output: { ok: true },
      isError: false,
    });
  });

  it('keeps a completed CLI activity terminal when a late running event arrives', () => {
    const lifecycle = [
      { eventSeq: 1, eventType: 'item.started', status: 'requested' },
      { eventSeq: 2, eventType: 'item.completed', status: 'completed' },
      { eventSeq: 3, eventType: 'item.updated', status: 'running' },
    ] as const;
    const projection = projectConversationLedgerEvents(
      lifecycle.map(({ eventSeq, eventType, status }) =>
        event({
          event_seq: eventSeq,
          source: 'cli:codex',
          provider: 'codex-sdk',
          stream_event_type: eventType,
          payload: {
            transport: 'codex-sdk',
            sequence: eventSeq,
            receivedAt: `2026-06-11T00:00:0${eventSeq}.000Z`,
            providerEventType: eventType,
            providerItemId: 'late-active-tool',
            display: {
              kind: 'tool',
              title: 'highlight_range',
              status,
              visibility: 'chat',
            },
            toolCalls: [
              {
                id: 'call-late-active',
                name: 'mcp__dnaforge__highlight_range',
                mcpServer: 'dnaforge',
                status,
                ...(status === 'completed' ? { output: { ok: true } } : {}),
              },
            ],
          },
        })
      )
    );

    const activity = projection[0].messages.find((message) => message.role === 'activity');
    expect(activity).toMatchObject({ first_event_seq: 1, last_event_seq: 2 });
    const projectedEvent = JSON.parse(activity?.content ?? '{}').event;
    expect(projectedEvent.display.status).toBe('completed');
    expect(projectedEvent.toolCalls.map((call: { status: string }) => call.status)).toEqual([
      'requested',
      'completed',
    ]);
  });

  it('drops events superseded by an append-only tombstone', () => {
    const projection = projectConversationLedgerEvents([
      event({
        event_seq: 1,
        source: 'app:chat',
        stream_event_type: 'user-message',
        payload: { message: { role: 'user', content: 'Draft answer' } },
      }),
      event({
        event_seq: 2,
        event_id: 'event-retracted',
        stream_event_type: 'text-delta',
        payload: { type: 'text-delta', id: 'text-1', text: 'Retracted answer.' },
      }),
      event({
        event_seq: 3,
        source: 'system',
        provider: null,
        model: null,
        stream_event_type: 'message.superseded',
        payload: {
          reason: 'provider-retraction',
          retracted_event_ids: ['event-retracted'],
        },
      }),
      event({
        event_seq: 4,
        stream_event_type: 'text-delta',
        payload: { type: 'text-delta', id: 'text-2', text: 'Replacement answer.' },
      }),
    ]);

    expect(projection[0].messages).toMatchObject([
      { role: 'user', content: 'Draft answer' },
      { role: 'assistant', content: 'Replacement answer.' },
    ]);
  });
});

describe('compareProjectedMessagesToLive', () => {
  it('reports semantic parity against live SQLite message rows', () => {
    const projected = projectConversationLedgerEvents([
      event({
        event_seq: 1,
        source: 'app:chat',
        stream_event_type: 'user-message',
        payload: { message: { role: 'user', content: 'Hello' } },
      }),
      event({
        event_seq: 2,
        payload: { type: 'text-delta', id: 'text-1', text: 'Hi' },
      }),
    ])[0].messages;

    expect(
      compareProjectedMessagesToLive(projected, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ])
    ).toEqual({ ok: true, mismatches: [] });

    expect(compareProjectedMessagesToLive(projected, [{ role: 'user', content: 'wrong' }]).ok).toBe(
      false
    );
  });
});
