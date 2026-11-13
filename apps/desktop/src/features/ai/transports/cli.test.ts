import { describe, expect, it } from 'vitest';
import type { AgentTraceEventShape } from '../../../platform';
import { ClaudeTraceAdapter } from '../../../main/agent-sdk/trace-adapter';
import {
  createCliTranscriptAccumulator,
  materializeCliToolBlocks,
  findReferenceId,
  isCliTranscriptTraceEvent,
} from './cli';

describe('CLI transcript accumulator', () => {
  it('persists the full Claude assistant message while keeping its activity preview bounded', () => {
    const answer = 'Actual scientific result. '.repeat(150);
    const adapter = new ClaudeTraceAdapter({ sdkVersion: '0.3.150', cliVersion: '2.1.156' });
    const event = adapter.adapt({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Private reasoning is not answer text.' },
          { type: 'text', text: answer },
        ],
      },
    });
    expect(event.display.text).toContain('[truncated]');
    const accumulator = createCliTranscriptAccumulator();
    accumulator.append(event);
    expect(accumulator.blocks).toHaveLength(1);
    expect(accumulator.blocks[0]).toMatchObject({ type: 'assistant_text', content: answer.trim() });
  });
  it('retains assistant explanations but lets the turn-error surface own provider rejection diagnostics', () => {
    const text = 'Some models are not supported with a ChatGPT account.';
    const answer = assistantTrace(text, 0);
    expect(isCliTranscriptTraceEvent(answer)).toBe(true);
    const diagnostic: AgentTraceEventShape = {
      ...answer,
      display: { kind: 'error', title: 'Provider error', text },
      terminal: 'failed',
      raw: {},
    };
    expect(isCliTranscriptTraceEvent(diagnostic)).toBe(false);
    expect(
      isCliTranscriptTraceEvent({
        ...diagnostic,
        toolCalls: [{ id: 'failed-tool', name: 'read', status: 'failed' }],
      })
    ).toBe(true);
  });

  it('accepts a successful saved-view reference and rejects references inside failed tool results', () => {
    const referenceId = '44f03a58-b863-4c04-9ab5-2a017dec13bf';
    expect(findReferenceId({ result: { ok: true, referenceId } })).toBe(referenceId);
    expect(findReferenceId({ ok: false, details: { referenceId } })).toBeNull();
    expect(findReferenceId({ isError: true, structuredContent: { referenceId } })).toBeNull();
  });
  it('indexes provider items and updates them without duplicating blocks', () => {
    const accumulator = createCliTranscriptAccumulator();
    accumulator.append(trace('running'));
    accumulator.append(trace('completed'));

    expect(accumulator.indexedItems).toBe(1);
    expect(accumulator.blocks).toHaveLength(1);
    expect(accumulator.blocks[0]).toMatchObject({
      type: 'trace',
      event: { display: { status: 'completed' } },
    });
  });

  it('never downgrades a terminal provider item with a late active event', () => {
    const accumulator = createCliTranscriptAccumulator();
    accumulator.append(trace('completed'));
    accumulator.append(trace('running'));

    expect(accumulator.blocks[0]).toMatchObject({
      type: 'trace',
      event: { display: { status: 'completed' } },
    });
  });

  it('restores provider order when quarantined assistant prose arrives after live tool activity', () => {
    const accumulator = createCliTranscriptAccumulator();
    accumulator.append(toolTrace([], 1));
    accumulator.append(assistantTrace('I will inspect the workspace.', 0));

    expect(
      accumulator.blocks.map((block) =>
        block.type === 'assistant_text' || block.type === 'trace'
          ? block.event.providerEventType
          : block.type
      )
    ).toEqual(['assistant.completed', 'item.completed']);
  });

  it('keeps monotonic streaming events ordered when late prose is inserted', () => {
    const accumulator = createCliTranscriptAccumulator();
    for (let sequence = 10; sequence < 110; sequence += 1) {
      accumulator.append(toolTrace([], sequence, `item-${sequence}`));
    }
    accumulator.append(assistantTrace('Earlier preamble.', 5));

    expect(
      accumulator.blocks.map((block) =>
        block.type === 'assistant_text' || block.type === 'trace' ? block.event.sequence : null
      )
    ).toEqual([5, ...Array.from({ length: 100 }, (_, index) => index + 10)]);
    expect(accumulator.indexedItems).toBe(101);
  });

  it('replaces one Grok answer with the latest joined text', () => {
    const accumulator = createCliTranscriptAccumulator();
    accumulator.append(grokAssistant('Hel', 1, 'grok-message-0'));
    accumulator.append(grokAssistant('Hello ', 2, 'grok-message-0'));
    accumulator.append(grokAssistant('Hello world', 3, 'grok-message-0'));

    expect(accumulator.blocks).toHaveLength(1);
    expect(accumulator.blocks[0]).toMatchObject({
      type: 'assistant_text',
      content: 'Hello world',
    });
  });

  it('keeps a provider item in its first position when a later lifecycle update arrives', () => {
    const accumulator = createCliTranscriptAccumulator();
    accumulator.append(trace('running', 1));
    accumulator.append(assistantTrace('Still working.', 2));
    accumulator.append(trace('completed', 3));

    expect(
      accumulator.blocks.map((block) =>
        block.type === 'assistant_text' || block.type === 'trace'
          ? block.event.providerItemId
          : block.type
      )
    ).toEqual(['item-1', 'assistant-item-1']);
    expect(accumulator.blocks[0]).toMatchObject({
      type: 'trace',
      event: { display: { status: 'completed' } },
    });
  });

  it('materializes completed reactivatable DNAForge calls as durable tool messages', async () => {
    const blocks = await materializeCliToolBlocks([
      {
        type: 'trace',
        event: toolTrace([
          {
            id: 'call-highlight',
            name: 'mcp__dnaforge__highlight_range',
            mcpServer: 'dnaforge',
            status: 'completed',
            input: { path: '/workspace/pUC19.gb', start: 683, end: 688 },
            output: { ok: true },
          },
          {
            id: 'call-finalize',
            name: 'mcp__dnaforge__finalize_design_assembly',
            mcpServer: 'dnaforge',
            status: 'completed',
            input: { designId: 'design-1' },
            output: { ok: true },
          },
        ]),
      },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(['trace', 'tool']);
    expect(blocks[1]).toMatchObject({
      type: 'tool',
      message: {
        role: 'tool',
        toolName: 'highlight_range',
        toolCallId: 'call-highlight',
      },
    });
    if (blocks[1].type !== 'tool') throw new Error('expected a tool block');
    expect(JSON.parse(blocks[1].message.content)).toEqual({
      input: { path: '/workspace/pUC19.gb', start: 683, end: 688 },
      output: { ok: true },
      isError: false,
    });
  });

  it('uses the canonical empty object when a lifecycle never records tool input', async () => {
    const blocks = await materializeCliToolBlocks([
      {
        type: 'trace',
        event: toolTrace([
          {
            id: 'call-highlight',
            name: 'mcp__dnaforge__highlight_range',
            mcpServer: 'dnaforge',
            status: 'requested',
          },
        ]),
      },
      {
        type: 'trace',
        event: toolTrace([
          {
            id: 'call-highlight',
            name: 'mcp__dnaforge__highlight_range',
            mcpServer: 'dnaforge',
            status: 'completed',
            output: { ok: true },
          },
        ]),
      },
    ]);

    const toolBlock = blocks.find((block) => block.type === 'tool');
    if (!toolBlock || toolBlock.type !== 'tool') throw new Error('expected a tool block');
    expect(JSON.parse(toolBlock.message.content).input).toEqual({});
  });
});

function trace(status: string, sequence = 0): AgentTraceEventShape {
  return {
    transport: 'codex-sdk',
    sequence,
    receivedAt: new Date(0).toISOString(),
    providerEventType: 'item.updated',
    providerItemId: 'item-1',
    providerItemType: 'command_execution',
    display: { kind: 'command', title: 'Command', status },
    terminal: null,
    toolCalls: [],
    raw: {},
    versions: { sdkVersion: null, cliVersion: null },
  };
}

function grokAssistant(
  text: string,
  sequence: number,
  providerItemId: string
): AgentTraceEventShape {
  return {
    transport: 'grok-acp',
    sequence,
    receivedAt: new Date(0).toISOString(),
    providerEventType: 'session/update',
    providerItemId,
    providerItemType: 'agent_message_chunk',
    display: { kind: 'assistant_text', title: 'Grok', text },
    terminal: null,
    toolCalls: [],
    raw: {},
    versions: { sdkVersion: null, cliVersion: null },
  };
}

function assistantTrace(text: string, sequence: number): AgentTraceEventShape {
  return {
    transport: 'codex-sdk',
    sequence,
    receivedAt: new Date(0).toISOString(),
    providerEventType: 'assistant.completed',
    providerItemId: 'assistant-item-1',
    providerItemType: 'agent_message',
    display: { kind: 'assistant_text', title: 'Assistant', text },
    terminal: 'completed',
    toolCalls: [],
    raw: { item: { text } },
    versions: { sdkVersion: null, cliVersion: null },
  };
}

function toolTrace(
  toolCalls: AgentTraceEventShape['toolCalls'],
  sequence = 1,
  providerItemId = 'tool-item-1'
): AgentTraceEventShape {
  return {
    transport: 'codex-sdk',
    sequence,
    receivedAt: new Date(0).toISOString(),
    providerEventType: 'item.completed',
    providerItemId,
    providerItemType: 'mcp_tool_call',
    display: { kind: 'tool', title: 'DNAForge tool', status: 'completed', visibility: 'chat' },
    terminal: 'completed',
    toolCalls,
    raw: {},
    versions: { sdkVersion: null, cliVersion: null },
  };
}
