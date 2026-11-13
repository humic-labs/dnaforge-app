import { expect, it } from 'vitest';
import { observedAuthenticatedState } from './auth-publication-observation';

it('requires the requested host to be published as authenticated', () => {
  const detection = { claudeCode: { auth: 'unauthenticated' }, codex: { auth: 'authenticated' } };
  expect(observedAuthenticatedState(detection, 'claude-agent-sdk')).toBe(false);
  expect(observedAuthenticatedState(detection, 'codex-sdk')).toBe(true);
  expect(observedAuthenticatedState(null, 'claude-agent-sdk')).toBe(false);
  expect(
    observedAuthenticatedState({ claudeCode: { auth: 'authenticated' } }, 'claude-agent-sdk')
  ).toBe(true);
});
