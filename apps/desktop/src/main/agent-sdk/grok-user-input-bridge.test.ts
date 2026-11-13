import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  answerGrokDnaForgeMcpPermission,
  answerGrokMcpUserInputPermission,
  createGrokUserInputHandoff,
  discardGrokUserInputHandoff,
} from './grok-user-input-bridge';

const options = [
  { optionId: 'always', name: 'always allow', kind: 'allow_always' as const },
  { optionId: 'once', name: 'allow once', kind: 'allow_once' as const },
  { optionId: 'reject', name: 'reject once', kind: 'reject_once' as const },
];

const routedInput = {
  variant: 'UseTool',
  tool_name: 'dnaforge__request_user_input',
  tool_input: {
    questions: [
      {
        id: 'assembly',
        header: 'Assembly',
        question: 'Which assembly method?',
        multiSelect: false,
        options: [
          { label: 'Gibson', description: 'Overlap assembly.' },
          { label: 'Golden Gate', description: 'Type IIS assembly.' },
        ],
      },
    ],
  },
};

describe('Grok user-input handoff', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function handoff() {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-grok-input-'));
    roots.push(root);
    return createGrokUserInputHandoff(root);
  }

  it('allows one exact authenticated DNAForge MCP call without showing a second permission card', () => {
    const params = {
      sessionId: 'grok-session',
      toolCall: {
        toolCallId: 'tool-read',
        name: 'mcp__dnaforge__read_file',
        title: 'Read portable skill',
        rawInput: { path: 'skill://primer-review/SKILL.md' },
      },
      options,
    };

    expect(answerGrokDnaForgeMcpPermission({ params, observedToolCalls: new Map() })).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    expect(
      answerGrokDnaForgeMcpPermission({
        params: { ...params, toolCall: { ...params.toolCall, name: 'mcp__other__read_file' } },
        observedToolCalls: new Map(),
      })
    ).toBeNull();
    expect(
      answerGrokDnaForgeMcpPermission({
        params: { ...params, toolCall: { ...params.toolCall, name: 'bash' } },
        observedToolCalls: new Map(),
      })
    ).toBeNull();
    expect(
      answerGrokDnaForgeMcpPermission({
        params: {
          ...params,
          toolCall: { ...params.toolCall, name: 'mcp__dnaforge__request_user_input' },
        },
        observedToolCalls: new Map(),
      })
    ).toBeNull();
    expect(
      answerGrokDnaForgeMcpPermission({
        params: { ...params, toolCall: { ...params.toolCall, name: undefined } },
        observedToolCalls: new Map([['tool-read', { mcpServer: 'dnaforge', name: 'read_file' }]]),
      })
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    expect(
      answerGrokDnaForgeMcpPermission({
        params: { ...params, options: options.filter((option) => option.kind !== 'allow_once') },
        observedToolCalls: new Map(),
      })
    ).toBeNull();
  });

  it('recognizes native and wrapped DNAForge names without trusting another namespace', () => {
    const base = {
      sessionId: 'grok-session',
      toolCall: { toolCallId: 'native-read', title: 'Read workspace' },
      options,
    };
    for (const toolCall of [
      { ...base.toolCall, name: 'dnaforge__get_workspace' },
      {
        ...base.toolCall,
        rawInput: { variant: 'UseTool', tool_name: 'dnaforge__get_workspace', tool_input: {} },
      },
    ]) {
      expect(
        answerGrokDnaForgeMcpPermission({
          params: { ...base, toolCall },
          observedToolCalls: new Map(),
        })
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    }
    for (const toolCall of [
      { ...base.toolCall, name: 'other__get_workspace' },
      {
        ...base.toolCall,
        name: 'other__get_workspace',
        rawInput: { variant: 'UseTool', tool_name: 'dnaforge__get_workspace', tool_input: {} },
      },
      { ...base.toolCall, name: 'dnaforge__request_user_input' },
      {
        ...base.toolCall,
        rawInput: { variant: 'UseTool', tool_name: 'dnaforge__request_user_input', tool_input: {} },
      },
      { ...base.toolCall, title: 'dnaforge__get_workspace' },
    ]) {
      expect(
        answerGrokDnaForgeMcpPermission({
          params: { ...base, toolCall },
          observedToolCalls: new Map(),
        })
      ).toBeNull();
    }
  });

  it('renders the exact routed MCP questions and writes one authenticated response', async () => {
    const target = handoff();
    const requestUserInput = vi.fn().mockResolvedValue({
      outcome: 'submitted',
      answers: { assembly: { selectedOptionIds: ['Gibson'] } },
    });
    const response = await answerGrokMcpUserInputPermission({
      params: {
        sessionId: 'grok-session',
        toolCall: { toolCallId: 'tool-7', title: 'Ask', rawInput: routedInput },
        options,
      },
      observedToolCalls: new Map(),
      handoff: target,
      conversationId: 'conversation-1',
      signal: new AbortController().signal,
      requestUserInput,
    });

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    expect(requestUserInput).toHaveBeenCalledWith(
      {
        provider: 'grok-acp',
        conversationId: 'conversation-1',
        questions: [
          {
            id: 'assembly',
            header: 'Assembly',
            prompt: 'Which assembly method?',
            options: [
              { id: 'Gibson', label: 'Gibson', description: 'Overlap assembly.' },
              {
                id: 'Golden Gate',
                label: 'Golden Gate',
                description: 'Type IIS assembly.',
              },
            ],
            multiSelect: false,
            allowFreeText: false,
          },
        ],
      },
      expect.any(AbortSignal)
    );
    expect(JSON.parse(readFileSync(target.path, 'utf8'))).toEqual({
      schema: 'dnaforge.grok-user-input-handoff/v1',
      token: target.token,
      arguments: routedInput.tool_input,
      response: {
        outcome: 'submitted',
        answers: { assembly: { selectedOptionIds: ['Gibson'] } },
      },
    });

    discardGrokUserInputHandoff(target);
    expect(existsSync(target.path)).toBe(false);
  });

  it('does not render or approve a spoofed server, route variant, or conflicting identity', async () => {
    const requestUserInput = vi.fn();
    for (const toolCall of [
      {
        toolCallId: 'tool-7',
        rawInput: { ...routedInput, tool_name: 'other__request_user_input' },
      },
      {
        toolCallId: 'tool-7',
        rawInput: { ...routedInput, variant: 'Other' },
      },
      {
        toolCallId: 'tool-7',
        name: 'mcp__other__request_user_input',
        rawInput: routedInput,
      },
    ]) {
      await expect(
        answerGrokMcpUserInputPermission({
          params: { sessionId: 'grok-session', toolCall, options },
          observedToolCalls: new Map(),
          handoff: handoff(),
          conversationId: null,
          signal: new AbortController().signal,
          requestUserInput,
        })
      ).resolves.toBeNull();
    }
    expect(requestUserInput).not.toHaveBeenCalled();
  });
});
