import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTraceEventShape } from '../../../platform';
import { blocksToMessages, hasMaterializedAssistantText } from './chat-projections';
import type { ContentBlock } from './chat-types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('blocksToMessages', () => {
  it('mints distinct app-owned message IDs when separate Codex turns reuse a provider item ID', () => {
    const providerItemId = 'assistant-text:codex-sdk:item_2';
    const event: AgentTraceEventShape = {
      transport: 'codex-sdk',
      sequence: 2,
      receivedAt: new Date(0).toISOString(),
      providerEventType: 'item.completed',
      providerItemId: 'item_2',
      providerItemType: 'agent_message',
      display: { kind: 'assistant_text', title: 'Assistant', text: 'Done.' },
      terminal: 'completed',
      toolCalls: [],
      raw: {},
      versions: { sdkVersion: null, cliVersion: null },
    };

    const first = blocksToMessages(
      [{ type: 'assistant_text', id: providerItemId, event, content: 'First answer.' }],
      'turn-a'
    )[0];
    const second = blocksToMessages(
      [{ type: 'assistant_text', id: providerItemId, event, content: 'Second answer.' }],
      'turn-b'
    )[0];

    expect(first.id).not.toBe(providerItemId);
    expect(second.id).not.toBe(providerItemId);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(second.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect([first.turnId, second.turnId]).toEqual(['turn-a', 'turn-b']);
  });

  it('assigns one monotonic timestamp sequence in visible block order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const trace: AgentTraceEventShape = {
      transport: 'codex-sdk',
      sequence: 1,
      receivedAt: new Date(0).toISOString(),
      providerEventType: 'item.completed',
      providerItemId: 'tool-item-1',
      providerItemType: 'mcp_tool_call',
      display: { kind: 'tool', title: 'DNAForge tool', status: 'completed', visibility: 'chat' },
      terminal: 'completed',
      toolCalls: [],
      raw: {},
      versions: { sdkVersion: null, cliVersion: null },
    };
    const blocks: ContentBlock[] = [
      { type: 'trace', event: trace },
      {
        type: 'tool',
        message: {
          id: 'tool-message-1',
          role: 'tool',
          toolName: 'highlight_range',
          toolCallId: 'call-1',
          content: JSON.stringify({ input: {}, output: { ok: true }, isError: false }),
          createdAt: 1,
        },
      },
      { type: 'text', id: 'assistant-message-1', content: 'Done.' },
    ];

    const messages = blocksToMessages(blocks, 'turn-1');

    expect(messages.map((message) => message.role)).toEqual(['activity', 'tool', 'assistant']);
    expect(messages.map((message) => message.createdAt)).toEqual([1_000, 1_001, 1_002]);
    expect(messages[2]?.id).not.toBe('assistant-message-1');
  });

  it('preserves the finalized inline document and ordered reference joins', () => {
    const messages = blocksToMessages([
      {
        type: 'text',
        id: 'assistant-message-1',
        content: 'Open pUC19.',
        document: { source: 'Open pUC19.', renderSource: 'Open pUC19.', parts: [] },
        referenceIds: ['11111111-1111-4111-8111-111111111111'],
      },
    ]);

    expect(messages[0]).toMatchObject({
      document: { source: 'Open pUC19.' },
      referenceIds: ['11111111-1111-4111-8111-111111111111'],
    });
    expect(messages[0]?.id).not.toBe('assistant-message-1');
  });
});

describe('hasMaterializedAssistantText', () => {
  it('recognizes a Codex terminal result joined from multiple assistant items', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: 'I will inspect the workspace.',
        createdAt: 1,
      },
      {
        id: 'activity-1',
        role: 'activity' as const,
        content: 'tool activity',
        createdAt: 2,
      },
      {
        id: 'assistant-2',
        role: 'assistant' as const,
        content: 'pUC19.gb is present.',
        createdAt: 3,
      },
    ];

    expect(
      hasMaterializedAssistantText(messages, 'I will inspect the workspace.\npUC19.gb is present.')
    ).toBe(true);
    expect(
      hasMaterializedAssistantText(
        [{ ...messages[0], content: 'I will inspect the workspace.\n\n' }, messages[2]],
        'I will inspect the workspace.\n\npUC19.gb is present.'
      )
    ).toBe(true);
    expect(hasMaterializedAssistantText(messages, 'A different final answer.')).toBe(false);
  });
});
