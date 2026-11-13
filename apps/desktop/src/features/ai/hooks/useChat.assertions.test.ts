import { describe, test, expect } from 'vitest';

import { convertToModelMessages as convertToAnthropicMessages, type ChatMessage } from './useChat';

function msg(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    content: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('Architecture Hardening: Message Conversion', () => {
  test('A-10: converts simple user/assistant messages to {role, content} pairs', () => {
    const input = [
      msg({ role: 'user', content: 'Hello' }),
      msg({ role: 'assistant', content: 'Hi' }),
    ];
    const result = convertToAnthropicMessages(input);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  test('A-11: converts tool messages into tool-call/tool-result content block pairs', () => {
    const input = [
      msg({ role: 'user', content: 'list files' }),
      msg({ role: 'assistant', content: 'Let me check.' }),
      msg({
        role: 'tool',
        toolCallId: 'tc-1',
        toolName: 'list_files',
        content: JSON.stringify({
          input: { path: '.' },
          output: { entries: ['a.gb'] },
        }),
      }),
      msg({ role: 'assistant', content: 'Here are the files.' }),
    ];
    const result = convertToAnthropicMessages(input);

    const assistantWithTool = result[1] as any;
    expect(assistantWithTool.role).toBe('assistant');
    const toolCallPart = assistantWithTool.content.find((p: any) => p.type === 'tool-call');
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart.toolCallId).toBe('tc-1');

    const toolResultMsg = result[2] as any;
    expect(toolResultMsg.role).toBe('tool');
    const toolResultPart = toolResultMsg.content.find((p: any) => p.type === 'tool-result');
    expect(toolResultPart).toBeDefined();
    expect(toolResultPart.toolCallId).toBe('tc-1');
  });

  test('A-12: handles orphaned tool messages without crashing', () => {
    const input = [
      msg({
        role: 'tool',
        toolCallId: 'tc-orphan',
        toolName: 'get_workspace',
        content: JSON.stringify({ input: {}, output: { panels: [] } }),
      }),
    ];
    const result = convertToAnthropicMessages(input);
    expect(Array.isArray(result)).toBe(true);
    for (const m of result) {
      expect(m).toHaveProperty('role');
    }
  });

  test('A-13: handles tool messages with missing toolCallId', () => {
    const input = [
      msg({ role: 'assistant', content: 'checking' }),
      msg({
        role: 'tool',
        toolName: 'list_files',
        content: JSON.stringify({ input: {}, output: {} }),
      }),
    ];
    const result = convertToAnthropicMessages(input);
    expect(Array.isArray(result)).toBe(true);
    for (const m of result) {
      expect(m).toHaveProperty('role');
    }
  });
});
