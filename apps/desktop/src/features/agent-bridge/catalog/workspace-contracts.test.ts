import { describe, expect, it } from 'vitest';
import { workspaceTools } from './workspace';

describe('complete workspace tool contracts', () => {
  for (const [name, definition] of Object.entries(workspaceTools)) {
    it(`${name} declares successful data and explicit outcomes`, () => {
      expect('outputSchema' in definition && definition.outputSchema).toBeTruthy();
      expect(definition.execution.resultContract).toBe('explicit-v1');
    });
  }
});
