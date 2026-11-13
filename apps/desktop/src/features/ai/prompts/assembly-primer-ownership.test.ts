import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT } from './system-prompt';
import { DNAFORGE_CLI_SYSTEM_PROMPT } from '../../../shared/ai-reference-system-prompt';

describe('assembly primer ownership across agent routes', () => {
  it.each([
    ['built-in', BASE_SYSTEM_PROMPT],
    ['CLI', DNAFORGE_CLI_SYSTEM_PROMPT],
  ])('%s keeps source provenance separate from primer attachment', (_route, prompt) => {
    expect(prompt).toContain('Assembly primers belong to the assembly');
    expect(prompt).toContain('Do not call add_primer_binding on source sequences');
    expect(prompt).toContain('unless the user explicitly requests those source attachments');
  });
});
