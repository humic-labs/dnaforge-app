import type { ContributionPolicy } from '@waypoint/hosted-ai-contract';

export function hostedPolicy(contributing?: boolean): ContributionPolicy {
  return {
    account_plan_setting: contributing !== false ? 'research_contribution' : 'never_corpus',
    account_setting_id: '44444444-4444-4444-8444-444444444441',
    plan_authority_basis: contributing ? 'explicit_contribution_choice' : 'signin_default',
    choice_offered: true,
    contribution_choice: contributing ? 'joined' : 'unchosen',
    contribution_choice_id: contributing ? '55555555-5555-4555-8555-555555555551' : null,
    contribution_choice_recorded_at: contributing ? '2026-09-29T00:00:00.000Z' : null,
    hosted_authorized: true,
    hosted_unauthorized_reason: null,
    contribution_authority_epoch: contributing ? 1 : 0,
    show_research_contribution_notice: false,
    legal_challenge: {
      terms_version_id: '33333333-3333-4333-8333-333333333331',
      terms_version: 'terms-v4',
      terms_effective_at: '2026-09-29T00:00:00.000Z',
      terms_url: 'https://www.dnaforge.com/terms',
      terms_content_sha256: 'a'.repeat(64),
      privacy_version_id: '33333333-3333-4333-8333-333333333332',
      privacy_version: 'privacy-v6',
      privacy_effective_at: '2026-09-29T00:00:00.000Z',
      privacy_url: 'https://www.dnaforge.com/privacy',
      privacy_content_sha256: 'b'.repeat(64),
    },
    contribution_policy_generation: 'c'.repeat(64),
    contribution_choice_policy_generation: contributing ? 'c'.repeat(64) : null,
    private_trial_limit: 3,
    private_trial_used: 3,
    private_trial_remaining: 0,
    private_trial_eligible: false,
  };
}
