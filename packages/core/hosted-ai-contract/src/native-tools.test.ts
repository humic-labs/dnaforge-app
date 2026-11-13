import { describe, expect, it } from 'vitest';
import { HOSTED_NATIVE_TOOL_DEFINITIONS, getHostedNativeToolDefinition } from './native-tools';

describe('Hosted native tool contract', () => {
  it('defines every file and process capability exactly once', () => {
    const names = HOSTED_NATIVE_TOOL_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'Read',
      'LS',
      'Glob',
      'Grep',
      'WebFetch',
      'NotebookEdit',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'Write',
      'Edit',
      'MultiEdit',
      'Move',
      'Delete',
      'Bash',
      'ProcessStart',
      'ProcessStatus',
      'ProcessStop',
    ]);
  });

  it('keeps schemas closed and effect metadata explicit', () => {
    for (const definition of HOSTED_NATIVE_TOOL_DEFINITIONS) {
      expect(definition.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(definition.effects.length).toBeGreaterThan(0);
      expect(
        definition.effects.every((effect) => effect === 'read-only' || effect === 'mutating')
      ).toBe(true);
      expect(getHostedNativeToolDefinition(definition.name)).toBe(definition);
    }
    expect(getHostedNativeToolDefinition('unknown')).toBeNull();
  });
});
