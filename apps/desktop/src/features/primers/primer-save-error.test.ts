import { describe, expect, it } from 'vitest';
import { primerSaveErrorMessage } from './primer-save-error';

describe('primerSaveErrorMessage', () => {
  it.each([
    ['WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH', 'Choose a folder'],
    ['WORKSPACE_MUTATION_UNKNOWN_WORKSPACE', 'Open that project'],
    ['WORKSPACE_MUTATION_TOKEN_INVALID', 'save again'],
  ])('gives a bounded corrective action for %s', (code, recovery) => {
    const message = primerSaveErrorMessage(new Error(`IPC failed: ${code}`));
    expect(message).toContain(recovery);
    expect(message).toContain('Your primer draft is still here');
    expect(message).not.toContain(code);
  });

  it('retains an unrelated persistence error rather than claiming nothing was saved', () => {
    expect(primerSaveErrorMessage(new Error('Git history commit failed'))).toBe(
      'Git history commit failed'
    );
  });
});
