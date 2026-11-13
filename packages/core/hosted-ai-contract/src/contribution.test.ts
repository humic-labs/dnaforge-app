import { describe, expect, it } from 'vitest';
import { parseContributionPolicy, parseContributionReceipt } from './contribution.js';

const TERMS_SHA = 'a'.repeat(64);
const PRIVACY_SHA = 'b'.repeat(64);
const GENERATION = 'c'.repeat(64);

const challenge = {
  terms_version_id: '33333333-3333-4333-8333-333333333331',
  terms_version: 'terms-2026-08-06-e0f6b7091f06',
  terms_effective_at: '2026-08-06T00:00:00.000Z',
  terms_url: 'https://www.dnaforge.com/terms',
  terms_content_sha256: TERMS_SHA,
  privacy_version_id: '33333333-3333-4333-8333-333333333332',
  privacy_version: 'privacy-2026-08-06-5cb24db874cc',
  privacy_effective_at: '2026-08-06T00:00:00.000Z',
  privacy_url: 'https://www.dnaforge.com/privacy',
  privacy_content_sha256: PRIVACY_SHA,
};

const publishedV2Challenge = {
  ...challenge,
  terms_version: 'terms-v2',
  privacy_version: 'privacy-v2',
};

const unchosen = {
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
  legal_challenge: challenge,
  contribution_policy_generation: GENERATION,
  contribution_choice_policy_generation: null,
  private_trial_limit: 3,
  private_trial_used: 3,
  private_trial_remaining: 0,
  private_trial_eligible: false,
};

const privateTrial = {
  ...unchosen,
  account_plan_setting: 'never_corpus',
  account_setting_id: '44444444-4444-4444-8444-444444444440',
  plan_authority_basis: 'private_trial',
  hosted_authorized: true,
  hosted_unauthorized_reason: null,
  private_trial_used: 0,
  private_trial_remaining: 3,
  private_trial_eligible: true,
};

const joined = {
  ...unchosen,
  account_plan_setting: 'research_contribution',
  account_setting_id: '44444444-4444-4444-8444-444444444441',
  plan_authority_basis: 'explicit_contribution_choice',
  contribution_choice: 'joined',
  contribution_choice_id: '55555555-5555-4555-8555-555555555551',
  contribution_choice_recorded_at: '2026-08-06T10:00:00.000Z',
  hosted_authorized: true,
  hosted_unauthorized_reason: null,
  contribution_authority_epoch: 1,
  contribution_choice_policy_generation: GENERATION,
};

describe('parseContributionPolicy', () => {
  it('accepts private access after sign-in without contribution or a trial', () => {
    const policy = {
      ...privateTrial,
      plan_authority_basis: 'signin_default',
      private_trial_eligible: false,
      private_trial_remaining: 0,
    };
    expect(parseContributionPolicy(policy)).toMatchObject({
      hosted_authorized: true,
      contribution_choice: 'unchosen',
      account_plan_setting: 'never_corpus',
    });
    expect(parseContributionPolicy({ ...policy, account_plan_setting: 'private_ai' })).toBeNull();
  });
  it('accepts default research authority without fabricating an explicit Join', () => {
    const policy = {
      ...privateTrial,
      plan_authority_basis: 'signin_default',
      account_plan_setting: 'research_contribution',
      private_trial_eligible: false,
      private_trial_remaining: 0,
    };
    expect(parseContributionPolicy(policy)).toMatchObject({
      account_plan_setting: 'research_contribution',
      contribution_choice: 'unchosen',
      contribution_choice_id: null,
    });
    for (const choice of ['joined', 'declined', 'withdrawn'] as const) {
      expect(
        parseContributionPolicy({
          ...joined,
          ...policy,
          contribution_choice: choice,
          contribution_choice_id: joined.contribution_choice_id,
          contribution_choice_recorded_at: joined.contribution_choice_recorded_at,
          contribution_choice_policy_generation: GENERATION,
        })
      ).toBeNull();
    }
  });
  it('accepts the active versioned legal documents published by the database', () => {
    expect(
      parseContributionPolicy({
        ...unchosen,
        legal_challenge: publishedV2Challenge,
      })
    ).toMatchObject({
      legal_challenge: {
        terms_version: 'terms-v2',
        privacy_version: 'privacy-v2',
      },
    });
  });

  it('accepts the canonical ten-hex historical privacy document version', () => {
    expect(
      parseContributionPolicy({
        ...unchosen,
        legal_challenge: {
          ...challenge,
          privacy_version: 'privacy-2026-07-30-3c2345a78f',
        },
      })
    ).toMatchObject({
      legal_challenge: { privacy_version: 'privacy-2026-07-30-3c2345a78f' },
    });
  });

  it('does not widen ten-hex historical versions to the terms namespace', () => {
    expect(
      parseContributionPolicy({
        ...unchosen,
        legal_challenge: {
          ...challenge,
          terms_version: 'terms-2026-07-30-3c2345a78f',
        },
      })
    ).toBeNull();
  });

  it('accepts the states the server actually produces', () => {
    expect(parseContributionPolicy(unchosen)).toMatchObject({
      contribution_choice: 'unchosen',
      plan_authority_basis: 'none',
    });
    expect(parseContributionPolicy(joined)).toMatchObject({ hosted_authorized: true });
    expect(parseContributionPolicy(privateTrial)).toMatchObject({
      plan_authority_basis: 'private_trial',
      private_trial_remaining: 3,
      private_trial_eligible: true,
    });
    expect(
      parseContributionPolicy({
        ...unchosen,
        account_plan_setting: 'private_ai',
        account_setting_id: '44444444-4444-4444-8444-444444444442',
        plan_authority_basis: 'plan',
        choice_offered: false,
      })
    ).toMatchObject({ choice_offered: false });
  });

  it.each([
    ['a plan setting outside the closed set', { account_plan_setting: 'corpus_maybe' }],
    ['an unknown authority basis', { plan_authority_basis: 'legacy' }],
    ['an unknown contribution choice', { contribution_choice: 'pending' }],
    ['a non-integer epoch', { contribution_authority_epoch: 1.5 }],
    ['a generation that is not a digest', { contribution_policy_generation: 'generation-2' }],
    ['a missing legal challenge', { legal_challenge: null }],
    ['an unknown unauthorized reason', { hosted_unauthorized_reason: 'because' }],
    ['a setting id that is not a UUID', { account_setting_id: 'setting-1' }],
    ['an unparseable recorded time', { contribution_choice_recorded_at: 'yesterday' }],
    ['a missing authorization', { hosted_authorized: undefined }],
    ['a missing trial limit', { private_trial_limit: undefined }],
    ['a missing trial use count', { private_trial_used: undefined }],
    ['a missing trial remainder', { private_trial_remaining: undefined }],
    ['a missing trial eligibility flag', { private_trial_eligible: undefined }],
    ['a fractional trial use count', { private_trial_used: 1.5 }],
    ['a negative trial remainder', { private_trial_remaining: -1 }],
    ['a trial limit other than three', { private_trial_limit: 4 }],
  ])('refuses %s', (_name, override) => {
    expect(parseContributionPolicy({ ...unchosen, ...override })).toBeNull();
  });

  it.each([
    [
      'a terms hash reused as the privacy hash',
      { legal_challenge: { ...challenge, privacy_content_sha256: TERMS_SHA } },
    ],
    [
      'a privacy version in the terms slot',
      { legal_challenge: { ...challenge, terms_version: 'privacy-2026-08-06-5cb24db874cc' } },
    ],
    [
      'one document id standing for both',
      { legal_challenge: { ...challenge, privacy_version_id: challenge.terms_version_id } },
    ],
  ])('refuses %s rather than showing part of it', (_name, override) => {
    expect(parseContributionPolicy({ ...unchosen, ...override })).toBeNull();
  });

  it.each([
    ['authorized with a reason it is not', { hosted_authorized: true }],
    [
      'an unchosen account holding a choice id',
      { contribution_choice_id: joined.contribution_choice_id },
    ],
    [
      'an authorized lane whose own choice is a withdrawal',
      { ...joined, contribution_choice: 'withdrawn' },
    ],
    ['a named setting under no authority', { account_setting_id: joined.account_setting_id }],
    ['an authority with no setting behind it', { ...joined, account_setting_id: null }],
    [
      "a plan-decided lane offered as the account's to change",
      { ...joined, plan_authority_basis: 'plan', choice_offered: true },
    ],
    ['a contribution notice on an unauthorized lane', { show_research_contribution_notice: true }],
    [
      'trial arithmetic that does not add to three',
      { ...privateTrial, private_trial_used: 1, private_trial_remaining: 1 },
    ],
    [
      'trial eligibility without private-trial authority',
      { ...privateTrial, plan_authority_basis: 'plan' },
    ],
    [
      'private-trial authority after a contribution decision',
      {
        ...privateTrial,
        contribution_choice: 'joined',
        contribution_choice_id: joined.contribution_choice_id,
        contribution_choice_recorded_at: joined.contribution_choice_recorded_at,
        contribution_choice_policy_generation: GENERATION,
      },
    ],
  ])('refuses a policy that contradicts itself: %s', (_name, override) => {
    expect(parseContributionPolicy({ ...unchosen, ...override })).toBeNull();
  });
});

const receipt = {
  contribution_choice_id: '55555555-5555-4555-8555-555555555551',
  receipt_choice: 'joined',
  current_contribution_choice: 'joined',
  hosted_authorized: true,
  idempotent: false,
  contribution_authority_epoch: 1,
  contribution_choice_policy_generation: GENERATION,
  contribution_policy_generation: GENERATION,
  account_setting_id: '44444444-4444-4444-8444-444444444441',
};

describe('parseContributionReceipt', () => {
  it('allows Hosted access after withdrawing optional contribution', () => {
    expect(
      parseContributionReceipt({
        ...receipt,
        receipt_choice: 'withdrawn',
        current_contribution_choice: 'withdrawn',
      })
    ).toMatchObject({ hosted_authorized: true });
  });
  it('keeps the recorded decision and current state apart', () => {
    expect(
      parseContributionReceipt({
        ...receipt,
        current_contribution_choice: 'withdrawn',
        hosted_authorized: false,
        idempotent: true,
      })
    ).toMatchObject({
      receipt_choice: 'joined',
      current_contribution_choice: 'withdrawn',
      hosted_authorized: false,
    });
  });

  it.each([
    ['unchosen as a recorded decision', { receipt_choice: 'unchosen' }],
    ['a choice id that is not a UUID', { contribution_choice_id: 'choice-1' }],
    ['a missing replay flag', { idempotent: undefined }],
    ['a generation that is not a digest', { contribution_choice_policy_generation: 'gen-1' }],
    ['a setting id that is not a UUID', { account_setting_id: 'setting-1' }],
    ['a fractional epoch', { contribution_authority_epoch: 0.5 }],
  ])('refuses %s', (_name, override) => {
    expect(parseContributionReceipt({ ...receipt, ...override })).toBeNull();
  });
});
