import { describe, it, expect } from 'vitest';
import { modelMessageSchema } from 'ai';
import { convertToModelMessages, type ChatMessage } from './useChat';

function msg(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
  return { id: `msg-${Math.random()}`, content: '', createdAt: Date.now(), ...overrides };
}

describe('convertToModelMessages — AI SDK schema validation', () => {
  it('text-only conversation validates against modelMessageSchema', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'Hello' }),
      msg({ role: 'assistant', content: 'Hi there' }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('tool call + tool result validates against modelMessageSchema', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'list files' }),
      msg({ role: 'assistant', content: 'Let me check.' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-1',
        toolName: 'list_files',
        content: JSON.stringify({
          input: { path: '.' },
          output: { entries: ['a.gb', 'b.fasta'] },
        }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('create_reference tool result validates (the exact case that crashed)', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'analyze plasmid.gb' }),
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-ref',
        toolName: 'create_reference',
        content: JSON.stringify({
          input: {
            entityType: 'sequence',
            displayLabel: 'plasmid.gb',
            locator: 'file://plasmid.gb',
          },
          output: { referenceId: 'ref-abc123' },
        }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('tool with string output validates', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-str',
        toolName: 'read_file',
        content: JSON.stringify({
          input: { path: 'test.gb' },
          output: 'LOCUS       test 1000 bp',
        }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('tool with null/undefined output validates', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-null',
        toolName: 'run_action',
        content: JSON.stringify({ input: {} }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('tool with empty object output validates', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-empty',
        toolName: 'do_thing',
        content: JSON.stringify({ input: {}, output: {} }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('orphaned tool message validates', () => {
    const result = convertToModelMessages([
      msg({
        role: 'tool',
        toolCallId: 'tc-orphan',
        toolName: 'get_workspace',
        content: JSON.stringify({ input: {}, output: { panels: [{ type: 'files' }] } }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('multi-tool assistant message validates', () => {
    const result = convertToModelMessages([
      msg({ role: 'assistant', content: 'Let me check both.' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-a',
        toolName: 'list_files',
        content: JSON.stringify({ input: { path: '.' }, output: { entries: [] } }),
      }),
      msg({
        role: 'tool',
        toolCallId: 'tc-b',
        toolName: 'read_file',
        content: JSON.stringify({ input: { path: 'x.gb' }, output: 'LOCUS x' }),
      }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: ${JSON.stringify(m)} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });

  it('full realistic conversation with references validates end-to-end', () => {
    const result = convertToModelMessages([
      msg({ role: 'user', content: 'What is in this file? [[ref:sequence:plasmid.gb]]' }),
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-create-ref',
        toolName: 'create_reference',
        content: JSON.stringify({
          input: {
            entityType: 'sequence',
            displayLabel: 'plasmid.gb',
            locator: 'file://plasmid.gb',
          },
          output: { referenceId: 'ref-001', status: 'resolved' },
        }),
      }),
      msg({
        role: 'assistant',
        content: 'This is a 5000bp plasmid with an ampicillin resistance gene.',
      }),
      msg({ role: 'user', content: 'Design primers for the insert region' }),
      msg({ role: 'assistant', content: '' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-primers',
        toolName: 'design_primers',
        content: JSON.stringify({
          input: { sequenceId: 'ref-001', region: { start: 100, end: 500 } },
          output: {
            forward: { sequence: 'ATGCGATCGATCG', tm: 62.5 },
            reverse: { sequence: 'CGATCGATCGATC', tm: 61.8 },
          },
        }),
      }),
      msg({ role: 'assistant', content: 'Here are your primers: ...' }),
    ]);

    for (const m of result) {
      const parsed = modelMessageSchema.safeParse(m);
      expect(
        parsed.success,
        `Message failed schema: role=${(m as any).role} — ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
    }
  });
});
