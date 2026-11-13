import { describe, expect, it } from 'vitest';

import {
  assertNoInternalIdentifiers,
  HostedCodexProjectionError,
  hostedCodexVisibleErrorCodes,
  projectHostedCodexError,
} from './user-visible-projection';

describe('Hosted Codex user-visible projection', () => {
  it('names missing legal acceptance and stale review without suggesting an unchanged retry', () => {
    const acceptance = projectHostedCodexError('HOSTED_LEGAL_ACCEPTANCE_REQUIRED');
    expect(acceptance.message).toMatch(/Terms and Privacy Policy/);
    expect(acceptance.message).toMatch(/sign out and sign in again/i);
    expect(acceptance.retryable).toBe(false);
    const stale = projectHostedCodexError('HOSTED_CONTRIBUTION_POLICY_CHANGED');
    expect(stale.message).toMatch(/review.*again/i);
    expect(stale.retryable).toBe(false);
  });

  it('gives every code a message a user can act on', () => {
    for (const code of hostedCodexVisibleErrorCodes()) {
      const visible = projectHostedCodexError(code);
      expect(visible.code).toBe(code);
      expect(visible.message.length).toBeGreaterThan(20);
      expect(visible.message).not.toMatch(/App Server|Codex|Azure|gateway|reservation/iu);
      expect(typeof visible.retryable).toBe('boolean');
    }
  });

  it('keeps troubleshooting facts out of the user-visible message', () => {
    const visible = projectHostedCodexError('HOSTED_UNAVAILABLE', {
      technicalCode: 'RESPONSE_STREAM_CONNECTION_FAILED',
      stage: 'final_response_after_local_tools',
      httpStatusCode: 503,
      retryable: true,
      referenceId: 'A5C9802C',
    });

    expect(visible.message).toBe('DNAForge AI is unavailable right now. Please try again shortly.');
    expect(visible.message).not.toMatch(/Error code:|Stage:|HTTP status:|Retry:|Reference ID:/u);
    expect(visible.retryable).toBe(true);
    expect(() => assertNoInternalIdentifiers(visible.message)).not.toThrow();
  });

  it('does not project unbounded diagnostic strings into chat', () => {
    const visible = projectHostedCodexError('HOSTED_UNAVAILABLE', {
      technicalCode: 'deployment staging-secret-model failed',
      stage: 'provider_response',
      retryable: true,
      referenceId: 'A5C9802C',
    });
    expect(visible.message).toBe('DNAForge AI is unavailable right now. Please try again shortly.');
    expect(visible.message).not.toContain('staging-secret-model');
  });

  it('refuses a code it has no message for', () => {
    expect(() =>
      projectHostedCodexError(
        'HOSTED_SOMETHING_NEW' as ReturnType<typeof hostedCodexVisibleErrorCodes>[number]
      )
    ).toThrow(/no user-visible message is defined/u);
  });

  it('refuses text carrying a content digest', () => {
    expect(() => assertNoInternalIdentifiers(`Failed: capsule ${'a'.repeat(64)}`)).toThrow(
      /a content digest/u
    );
  });

  it('refuses text carrying an internal identifier', () => {
    expect(() =>
      assertNoInternalIdentifiers('Failed for reservation 3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    ).toThrow(/an internal identifier/u);
    expect(() => assertNoInternalIdentifiers('could not settle reservation_id_a91f3c7e')).toThrow(
      /an internal identifier/u
    );
    expect(() => assertNoInternalIdentifiers('turn-id-7f19ab22c4 was interrupted')).toThrow(
      /an internal identifier/u
    );
  });

  it('refuses text naming the provider deployment', () => {
    expect(() =>
      assertNoInternalIdentifiers('model staging-gpt-5.6-luna-auto returned an error')
    ).toThrow(/a provider deployment name/u);
    expect(() => assertNoInternalIdentifiers('prod-gpt-5-hosted is unavailable')).toThrow(
      /a provider deployment name/u
    );
  });

  it('refuses a dumped protocol object', () => {
    expect(() =>
      assertNoInternalIdentifiers('DNAForge AI failed: {"type":"response.error","code":500}')
    ).toThrow(/a raw protocol object/u);
  });

  it('throws instead of scrubbing, so the leak is fixed where it was written', () => {
    const leaky = `Stopped: ${'b'.repeat(64)}`;
    let thrown: unknown;
    try {
      assertNoInternalIdentifiers(leaky);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostedCodexProjectionError);
    expect(leaky).toContain('b'.repeat(64));
  });

  it('accepts ordinary product prose', () => {
    expect(() =>
      assertNoInternalIdentifiers('DNAForge AI is unavailable right now. Please try again shortly.')
    ).not.toThrow();
    expect(() =>
      assertNoInternalIdentifiers('You stopped this response. Anything written before is kept.')
    ).not.toThrow();
    expect(() => assertNoInternalIdentifiers('pUC19 was not modified.')).not.toThrow();
  });

  it('marks a turn that must not be silently retried as non-retryable', () => {
    expect(projectHostedCodexError('HOSTED_RECONCILIATION_REQUIRED').retryable).toBe(false);
    expect(projectHostedCodexError('HOSTED_ALLOWANCE_EXHAUSTED').retryable).toBe(false);
    expect(projectHostedCodexError('HOSTED_TURN_BUDGET_EXHAUSTED').retryable).toBe(false);
    expect(projectHostedCodexError('HOSTED_CODEX_APP_SERVER_CRASH').retryable).toBe(true);
  });

  it('keeps every shipped message clean by construction', () => {
    for (const code of hostedCodexVisibleErrorCodes()) {
      expect(() =>
        assertNoInternalIdentifiers(projectHostedCodexError(code).message)
      ).not.toThrow();
    }
  });
});
