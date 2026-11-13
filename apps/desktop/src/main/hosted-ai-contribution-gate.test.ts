import type { ContributionPolicy, ContributionReceipt } from '@waypoint/hosted-ai-contract';
import { describe, expect, it, vi } from 'vitest';
import { HostedAiContributionGate } from './hosted-ai-contribution-gate';
import { HostedContributionRefusal } from './hosted-contribution-error';

const policy: ContributionPolicy = {
  account_plan_setting: 'unset',
  account_setting_id: null,
  plan_authority_basis: 'none',
  choice_offered: true,
  contribution_choice: 'unchosen',
  contribution_choice_id: null,
  contribution_choice_recorded_at: null,
  hosted_authorized: false,
  hosted_unauthorized_reason: 'hosted_contribution_choice_required',
  contribution_authority_epoch: 0,
  show_research_contribution_notice: false,
  legal_challenge: {
    terms_version_id: '00000000-0000-4000-8000-000000000011',
    terms_version: 'terms-2026-08-11-aaaaaaaaaaaa',
    terms_effective_at: '2026-08-11T00:00:00.000Z',
    terms_url: 'https://www.dnaforge.com/terms',
    terms_content_sha256: 'a'.repeat(64),
    privacy_version_id: '00000000-0000-4000-8000-000000000012',
    privacy_version: 'privacy-2026-08-11-bbbbbbbbbbbb',
    privacy_effective_at: '2026-08-11T00:00:00.000Z',
    privacy_url: 'https://www.dnaforge.com/privacy',
    privacy_content_sha256: 'b'.repeat(64),
  },
  contribution_policy_generation: 'c'.repeat(64),
  contribution_choice_policy_generation: null,
  private_trial_limit: 3,
  private_trial_used: 3,
  private_trial_remaining: 0,
  private_trial_eligible: false,
};

const receipt: ContributionReceipt = {
  contribution_choice_id: '00000000-0000-4000-8000-000000000014',
  receipt_choice: 'joined',
  current_contribution_choice: 'joined',
  hosted_authorized: true,
  idempotent: false,
  contribution_authority_epoch: 1,
  contribution_choice_policy_generation: 'c'.repeat(64),
  contribution_policy_generation: 'c'.repeat(64),
  account_setting_id: '00000000-0000-4000-8000-000000000015',
};

const withdrawnReceipt: ContributionReceipt = {
  contribution_choice_id: '00000000-0000-4000-8000-000000000016',
  receipt_choice: 'withdrawn',
  current_contribution_choice: 'withdrawn',
  hosted_authorized: false,
  idempotent: false,
  contribution_authority_epoch: 2,
  contribution_choice_policy_generation: 'c'.repeat(64),
  contribution_policy_generation: 'c'.repeat(64),
  account_setting_id: '00000000-0000-4000-8000-000000000015',
};

const session = { accountId: 'account-1', desktopSessionId: 'session-1' };
const firstAttempt = {
  surface: 'first_hosted_attempt',
  workflowId: 'conversation-1',
  runId: 'turn-1',
  turnId: 'turn-1',
  workspacePath: '/workspace',
} as const;

const privatePolicy: ContributionPolicy = {
  ...policy,
  account_plan_setting: 'never_corpus',
  account_setting_id: '00000000-0000-4000-8000-000000000015',
  plan_authority_basis: 'signin_default',
  hosted_authorized: true,
  hosted_unauthorized_reason: null,
};
function dependencies(
  overrides: Partial<ConstructorParameters<typeof HostedAiContributionGate>[0]> = {}
) {
  return {
    getSession: vi.fn(async () => session),
    getPolicy: vi.fn(async () => privatePolicy),
    recordChoice: vi.fn(async () => receipt),
    issueTurnBinding: vi.fn(() => 'turn-binding-1'),
    revokeTurnBindings: vi.fn(),
    ...overrides,
  };
}

describe('HostedAiContributionGate', () => {
  it('starts a signed-in first message without recording contribution', async () => {
    const deps = dependencies();
    await expect(
      new HostedAiContributionGate(deps).prepare(41, firstAttempt)
    ).resolves.toMatchObject({
      ok: true,
      started: true,
      receipt: null,
      turnBindingToken: 'turn-binding-1',
    });
    expect(deps.recordChoice).not.toHaveBeenCalled();
    expect(deps.issueTurnBinding).toHaveBeenCalledWith(
      41,
      session,
      {
        workflowId: firstAttempt.workflowId,
        runId: firstAttempt.runId,
        turnId: firstAttempt.turnId,
      },
      '/workspace'
    );
  });
  it('admits default research authority without recording a Join', async () => {
    const deps = dependencies({
      getPolicy: vi.fn(async () => ({
        ...privatePolicy,
        account_plan_setting: 'research_contribution' as const,
      })),
    });
    const gate = new HostedAiContributionGate(deps);
    await expect(gate.prepare(41, firstAttempt)).resolves.toMatchObject({
      ok: true,
      started: true,
      receipt: null,
    });
    expect(deps.recordChoice).not.toHaveBeenCalled();
  });
  it('revokes a late turn binding if the account changes while it is issued', async () => {
    let active = session;
    const deps = dependencies({
      getSession: vi.fn(async () => active),
      issueTurnBinding: vi.fn(async () => {
        active = { accountId: 'account-2', desktopSessionId: 'session-2' };
        return 'late-binding';
      }),
    });
    const result = await new HostedAiContributionGate(deps).prepare(41, firstAttempt);
    expect(result).toMatchObject({ ok: false, code: 'signed_out' });
    expect(deps.revokeTurnBindings).toHaveBeenCalledWith(session);
  });
  it('does not reuse a pending request after the same account signs into a new session', async () => {
    let active = session;
    let resolveFirst!: (policy: ContributionPolicy) => void;
    const deps = dependencies({
      getSession: vi.fn(async () => active),
      getPolicy: vi.fn(async (requested) => {
        if (requested.desktopSessionId === session.desktopSessionId)
          return new Promise<ContributionPolicy>((resolve) => {
            resolveFirst = resolve;
          });
        return privatePolicy;
      }),
    });
    const gate = new HostedAiContributionGate(deps);
    const previous = gate.prepare(41, firstAttempt);
    await vi.waitFor(() => expect(deps.getPolicy).toHaveBeenCalledTimes(1));
    active = { ...session, desktopSessionId: 'session-2' };
    await expect(gate.prepare(41, firstAttempt)).resolves.toMatchObject({
      ok: true,
      started: true,
    });
    resolveFirst(privatePolicy);
    await expect(previous).resolves.toMatchObject({ ok: false, code: 'signed_out' });
    expect(deps.getPolicy).toHaveBeenCalledTimes(2);
  });
  it.each(['unchosen', 'declined', 'withdrawn'] as const)(
    'allows operational Hosted with %s contribution',
    async (choice) => {
      const deps = dependencies({
        getPolicy: async () => ({ ...privatePolicy, contribution_choice: choice }),
      });
      await expect(
        new HostedAiContributionGate(deps).prepare(41, firstAttempt)
      ).resolves.toMatchObject({ ok: true, started: true });
      expect(deps.recordChoice).not.toHaveBeenCalled();
    }
  );
  it('reads inline settings without a choice or a turn binding', async () => {
    const deps = dependencies();
    await expect(
      new HostedAiContributionGate(deps).prepare(41, { surface: 'settings' })
    ).resolves.toMatchObject({
      ok: true,
      started: false,
      policy: privatePolicy,
      receipt: null,
      turnBindingToken: null,
    });
    expect(deps.recordChoice).not.toHaveBeenCalled();
    expect(deps.issueTurnBinding).not.toHaveBeenCalled();
  });
  it('does not silently join against an older unauthorized server', async () => {
    const deps = dependencies({ getPolicy: async () => policy });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, firstAttempt)
    ).resolves.toMatchObject({ ok: false, code: 'gateway_unavailable' });
    expect(deps.recordChoice).not.toHaveBeenCalled();
    expect(deps.issueTurnBinding).not.toHaveBeenCalled();
  });
  it('requires sign-in', async () => {
    const deps = dependencies({ getSession: async () => null });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, firstAttempt)
    ).resolves.toMatchObject({ ok: false, code: 'signed_out' });
    expect(deps.recordChoice).not.toHaveBeenCalled();
  });
  it('preserves the sign-in-owned legal acceptance refusal', async () => {
    const deps = dependencies({
      getPolicy: async () => ({
        ...policy,
        hosted_unauthorized_reason: 'legal_acceptance_missing',
      }),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, firstAttempt)
    ).resolves.toMatchObject({ ok: false, code: 'legal_acceptance_missing' });
    expect(deps.issueTurnBinding).not.toHaveBeenCalled();
  });
  it('does not bind an uncataloged workspace', async () => {
    const deps = dependencies({
      issueTurnBinding: () => {
        throw new Error('uncataloged');
      },
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, firstAttempt)
    ).resolves.toMatchObject({ ok: false, code: 'gateway_unavailable' });
  });
  it.each(['joined', 'withdrawn'] as const)(
    'records an explicit inline %s choice and returns refreshed policy',
    async (choice) => {
      const current = { ...privatePolicy, contribution_choice: choice };
      const resultReceipt = {
        ...(choice === 'joined' ? receipt : withdrawnReceipt),
        hosted_authorized: true,
      };
      const deps = dependencies({
        getPolicy: vi.fn().mockResolvedValueOnce(privatePolicy).mockResolvedValue(current),
        recordChoice: vi.fn(async () => resultReceipt),
      });
      await expect(
        new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice })
      ).resolves.toMatchObject({
        ok: true,
        started: false,
        policy: current,
        receipt: resultReceipt,
        turnBindingToken: null,
      });
      expect(deps.recordChoice).toHaveBeenCalledWith(session, choice, expect.any(String), {
        terms_version_id: policy.legal_challenge.terms_version_id,
        terms_content_sha256: policy.legal_challenge.terms_content_sha256,
        privacy_version_id: policy.legal_challenge.privacy_version_id,
        privacy_content_sha256: policy.legal_challenge.privacy_content_sha256,
        contribution_policy_generation: policy.contribution_policy_generation,
      });
      expect(deps.revokeTurnBindings).toHaveBeenCalledTimes(choice === 'withdrawn' ? 1 : 0);
      expect(deps.issueTurnBinding).not.toHaveBeenCalled();
    }
  );
  it.each(['joined', 'withdrawn'] as const)(
    'does not record %s again when a retry finds the setting already saved',
    async (choice) => {
      const current = {
        ...privatePolicy,
        contribution_choice: choice,
        account_plan_setting:
          choice === 'joined' ? ('research_contribution' as const) : ('never_corpus' as const),
      };
      const deps = dependencies({ getPolicy: vi.fn(async () => current) });
      await expect(
        new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice })
      ).resolves.toMatchObject({ ok: true, started: false, policy: current, receipt: null });
      expect(deps.recordChoice).not.toHaveBeenCalled();
      expect(deps.issueTurnBinding).not.toHaveBeenCalled();
    }
  );
  it('waits for an in-flight privacy change before preparing a fresh turn', async () => {
    let acknowledge!: (value: ContributionReceipt) => void;
    const current = { ...privatePolicy, contribution_choice: 'withdrawn' as const };
    const deps = dependencies({
      getPolicy: vi.fn().mockResolvedValueOnce(policy).mockResolvedValue(current),
      recordChoice: vi.fn(
        () =>
          new Promise<ContributionReceipt>((resolve) => {
            acknowledge = resolve;
          })
      ),
    });
    const gate = new HostedAiContributionGate(deps);
    const changing = gate.prepare(41, { surface: 'settings', choice: 'withdrawn' });
    await vi.waitFor(() => expect(deps.recordChoice).toHaveBeenCalledTimes(1));
    const sending = gate.prepare(41, firstAttempt);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.issueTurnBinding).not.toHaveBeenCalled();
    expect(deps.getPolicy).toHaveBeenCalledTimes(1);
    acknowledge({ ...withdrawnReceipt, hosted_authorized: true });
    expect(await changing).toMatchObject({ ok: true });
    expect(await sending).toMatchObject({ ok: true, started: true, policy: current });
  });
  it('allows inline withdrawal without accepting a later legal revision', async () => {
    const current = { ...privatePolicy, contribution_choice: 'withdrawn' as const };
    const deps = dependencies({
      getPolicy: vi
        .fn()
        .mockResolvedValueOnce({
          ...policy,
          hosted_unauthorized_reason: 'legal_acceptance_missing',
        })
        .mockResolvedValue(current),
      recordChoice: vi.fn(async () => ({ ...withdrawnReceipt, hosted_authorized: true })),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice: 'withdrawn' })
    ).resolves.toMatchObject({ ok: true });
  });
  it.each([
    'legal_acceptance_missing',
    'contribution_policy_stale',
    'contribution_choice_rejected',
  ] as const)('preserves a late %s refusal without retrying the mutation', async (code) => {
    const deps = dependencies({
      recordChoice: vi.fn(async () => {
        throw new HostedContributionRefusal(code);
      }),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice: 'joined' })
    ).resolves.toMatchObject({ ok: false, code });
    expect(deps.recordChoice).toHaveBeenCalledTimes(1);
  });
  it('rejects a receipt for a different current choice', async () => {
    const deps = dependencies({
      recordChoice: vi.fn(async () => ({
        ...receipt,
        current_contribution_choice: 'withdrawn' as const,
      })),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice: 'joined' })
    ).resolves.toMatchObject({ ok: false });
  });
  it('preserves managed-plan restrictions', async () => {
    const deps = dependencies({
      getPolicy: async () => ({ ...privatePolicy, choice_offered: false }),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice: 'joined' })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(deps.recordChoice).not.toHaveBeenCalled();
  });
  it('retries a transient policy read once without writing a choice', async () => {
    const deps = dependencies({
      getPolicy: vi
        .fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(privatePolicy),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, firstAttempt)
    ).resolves.toMatchObject({ ok: true, started: true });
    expect(deps.getPolicy).toHaveBeenCalledTimes(2);
    expect(deps.recordChoice).not.toHaveBeenCalled();
  });
  it('refuses an account switch while policy is loading', async () => {
    const deps = dependencies({
      getSession: vi
        .fn()
        .mockResolvedValueOnce(session)
        .mockResolvedValue({ ...session, accountId: 'other' }),
    });
    await expect(
      new HostedAiContributionGate(deps).prepare(41, { surface: 'settings', choice: 'joined' })
    ).resolves.toMatchObject({ ok: false, code: 'signed_out' });
    expect(deps.recordChoice).not.toHaveBeenCalled();
  });
  it.each([
    { surface: 'settings', choice: 'declined' },
    { ...firstAttempt, choice: 'joined' },
    { surface: 'settings', accountId: 'other' },
  ])('rejects malformed or authority-bearing requests', async (request) => {
    const deps = dependencies();
    await expect(new HostedAiContributionGate(deps).prepare(41, request)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(deps.recordChoice).not.toHaveBeenCalled();
  });
});
