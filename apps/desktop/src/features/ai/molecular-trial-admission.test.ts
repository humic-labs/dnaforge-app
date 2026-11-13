import { describe, expect, it } from 'vitest';
import { assertFreshMolecularTrialConversation } from './molecular-trial-admission';

describe('independent protein trial conversation', () => {
  const fresh = {
    question: 'Explain the observed contrast.',
    content: 'Explain the observed contrast.',
    policyVersion: 1,
    existingMessages: 0,
    existingTurns: 0,
    references: 0,
    attachments: 0,
  };
  it('admits only a first fixed-question turn', () => {
    expect(() => assertFreshMolecularTrialConversation(fresh)).not.toThrow();
    for (const change of [
      { existingMessages: 1 },
      { existingTurns: 1 },
      { references: 1 },
      { attachments: 1 },
      { content: 'Repair the previous scene.' },
      { policyVersion: undefined },
    ])
      expect(() => assertFreshMolecularTrialConversation({ ...fresh, ...change })).toThrow();
  });
});
