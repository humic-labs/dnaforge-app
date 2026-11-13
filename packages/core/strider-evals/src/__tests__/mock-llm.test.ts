import { describe, expect, it } from 'vitest';
import { MockLLM, assertScriptFullyConsumed } from '../mock-llm/mock-llm.ts';
import type { MockLLMScript } from '../mock-llm/types.ts';

const script: MockLLMScript = {
  id: 'two-turn-explore',
  turns: [
    {
      userPrompt: 'list files',
      toolCalls: [{ actionName: 'workspace.listFiles', input: { path: '.' } }],
      finalText: 'Listed 3 files.',
    },
    {
      userPrompt: 'read pUC19.gb',
      toolCalls: [{ actionName: 'sequence.readFile', input: { path: 'pUC19.gb' } }],
      finalText: 'This is the pUC19 plasmid.',
    },
  ],
};

describe('MockLLM', () => {
  it('replays scripted turns in order', () => {
    const mock = new MockLLM(script);
    const first = mock.run('list files');
    expect(first.toolCalls[0]?.actionName).toBe('workspace.listFiles');
    expect(first.finalText).toBe('Listed 3 files.');

    const second = mock.run('read pUC19.gb');
    expect(second.toolCalls[0]?.actionName).toBe('sequence.readFile');
    expect(mock.isExhausted()).toBe(true);
  });

  it('throws on prompt mismatch (no fuzzy matching — determinism)', () => {
    const mock = new MockLLM(script);
    expect(() => mock.run('something else')).toThrow(/expected prompt/);
  });

  it('throws past end of script', () => {
    const mock = new MockLLM({ ...script, turns: script.turns.slice(0, 1) });
    mock.run('list files');
    expect(() => mock.run('list files again')).toThrow(/script exhausted/);
  });

  it('assertScriptFullyConsumed flags unused turns', () => {
    const mock = new MockLLM(script);
    mock.run('list files');
    expect(() => assertScriptFullyConsumed(mock)).toThrow(/not fully consumed/);
  });

  it('preserves toolCall order within a turn', () => {
    const mock = new MockLLM({
      id: 'multi-tool',
      turns: [
        {
          userPrompt: 'do both',
          toolCalls: [
            { actionName: 'workspace.listFiles', input: {} },
            { actionName: 'workspace.getWorkspace', input: {} },
          ],
          finalText: 'done',
        },
      ],
    });
    const out = mock.run('do both');
    expect(out.toolCalls.map((c) => c.actionName)).toEqual([
      'workspace.listFiles',
      'workspace.getWorkspace',
    ]);
  });

  it('empty script throws immediately on first prompt', () => {
    const mock = new MockLLM({ id: 'empty', turns: [] });
    expect(() => mock.run('anything')).toThrow(/script exhausted/);
  });

  it('mismatch error names the script id for debuggability', () => {
    const mock = new MockLLM(script);
    expect(() => mock.run('wrong prompt')).toThrow(/MockLLM\(two-turn-explore\)/);
  });

  it('a turn with zero toolCalls returns empty array', () => {
    const mock = new MockLLM({
      id: 'no-tools',
      turns: [{ userPrompt: 'hi', toolCalls: [], finalText: 'hello' }],
    });
    const out = mock.run('hi');
    expect(out.toolCalls).toEqual([]);
    expect(out.finalText).toBe('hello');
  });
});
