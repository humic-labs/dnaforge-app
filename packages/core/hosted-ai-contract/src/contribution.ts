import { z } from 'zod';

export const CONTRIBUTION_DECISIONS = ['joined', 'declined', 'withdrawn'] as const;
export type ContributionDecision = (typeof CONTRIBUTION_DECISIONS)[number];

export const CONTRIBUTION_CHOICES = ['unchosen', ...CONTRIBUTION_DECISIONS] as const;
export type ContributionChoice = (typeof CONTRIBUTION_CHOICES)[number];

export const ACCOUNT_PLAN_SETTINGS = [
  'unset',
  'never_corpus',
  'private_ai',
  'research_contribution',
] as const;
export type AccountPlanSetting = (typeof ACCOUNT_PLAN_SETTINGS)[number];

export const PLAN_AUTHORITY_BASES = [
  'none',
  'free_hosted_default',
  'signin_default',
  'private_trial',
  'explicit_contribution_choice',
  'plan',
  'written_agreement',
  'operator',
] as const;
export type PlanAuthorityBasis = (typeof PLAN_AUTHORITY_BASES)[number];

export const HOSTED_UNAUTHORIZED_REASONS = [
  'hosted_private_trial_exhausted',
  'hosted_contribution_choice_required',
  'hosted_contribution_declined',
  'hosted_contribution_withdrawn',
  'legal_acceptance_missing',
  'account_ai_setting_missing',
  'active_legal_document_missing',
  'invalid_environment',
] as const;
export type HostedUnauthorizedReason = (typeof HOSTED_UNAUTHORIZED_REASONS)[number];

export interface LegalChallenge {
  readonly terms_version_id: string;
  readonly terms_version: string;
  readonly terms_effective_at: string;
  readonly terms_url: string;
  readonly terms_content_sha256: string;
  readonly privacy_version_id: string;
  readonly privacy_version: string;
  readonly privacy_effective_at: string;
  readonly privacy_url: string;
  readonly privacy_content_sha256: string;
}

export interface ContributionPolicy {
  readonly account_plan_setting: AccountPlanSetting;
  readonly account_setting_id: string | null;
  readonly plan_authority_basis: PlanAuthorityBasis;
  readonly choice_offered: boolean;
  readonly contribution_choice: ContributionChoice;
  readonly contribution_choice_id: string | null;
  readonly contribution_choice_recorded_at: string | null;
  readonly hosted_authorized: boolean;
  readonly hosted_unauthorized_reason: HostedUnauthorizedReason | null;
  readonly contribution_authority_epoch: number;
  readonly show_research_contribution_notice: boolean;
  readonly legal_challenge: LegalChallenge;
  readonly contribution_policy_generation: string;
  readonly contribution_choice_policy_generation: string | null;
  readonly private_trial_limit: 3;
  readonly private_trial_used: number;
  readonly private_trial_remaining: number;
  readonly private_trial_eligible: boolean;
}

export interface ContributionReceipt {
  readonly contribution_choice_id: string;
  readonly receipt_choice: ContributionDecision;
  readonly current_contribution_choice: ContributionChoice;
  readonly hosted_authorized: boolean;
  readonly idempotent: boolean;
  readonly contribution_authority_epoch: number;
  readonly contribution_choice_policy_generation: string;
  readonly contribution_policy_generation: string;
  readonly account_setting_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_LOWERHEX = /^[0-9a-f]{64}$/;
const DOCUMENT_VERSION =
  /^(?:terms-(?:v[1-9]\d*|\d{4}-\d{2}-\d{2}-[0-9a-f]{12})|privacy-(?:v[1-9]\d*|\d{4}-\d{2}-\d{2}-(?:[0-9a-f]{10}|[0-9a-f]{12})))$/;
const LEGAL_URL = /^https:\/\/[a-z0-9.-]+\/[a-z0-9/-]*$/;

function member<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function sha256(value: unknown): string | null {
  return typeof value === 'string' && SHA256_LOWERHEX.test(value) ? value : null;
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function epoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function trialCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3
    ? value
    : null;
}

function legalChallenge(value: unknown): LegalChallenge | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fields = {
    terms_version_id: uuid(raw.terms_version_id),
    terms_version:
      typeof raw.terms_version === 'string' && DOCUMENT_VERSION.test(raw.terms_version)
        ? raw.terms_version
        : null,
    terms_effective_at: instant(raw.terms_effective_at),
    terms_url:
      typeof raw.terms_url === 'string' && LEGAL_URL.test(raw.terms_url) ? raw.terms_url : null,
    terms_content_sha256: sha256(raw.terms_content_sha256),
    privacy_version_id: uuid(raw.privacy_version_id),
    privacy_version:
      typeof raw.privacy_version === 'string' && DOCUMENT_VERSION.test(raw.privacy_version)
        ? raw.privacy_version
        : null,
    privacy_effective_at: instant(raw.privacy_effective_at),
    privacy_url:
      typeof raw.privacy_url === 'string' && LEGAL_URL.test(raw.privacy_url)
        ? raw.privacy_url
        : null,
    privacy_content_sha256: sha256(raw.privacy_content_sha256),
  };
  if (Object.values(fields).some((field) => field === null)) return null;
  const challenge = fields as LegalChallenge;
  if (
    !challenge.terms_version.startsWith('terms-') ||
    !challenge.privacy_version.startsWith('privacy-') ||
    challenge.terms_version_id === challenge.privacy_version_id ||
    challenge.terms_content_sha256 === challenge.privacy_content_sha256
  ) {
    return null;
  }
  return challenge;
}

function contributionPolicyIsContradictory(args: {
  hostedAuthorized: boolean;
  reason: HostedUnauthorizedReason | null;
  choice: ContributionChoice;
  choiceId: string | null;
  recordedAt: string | null;
  choiceGeneration: string | null;
  basis: PlanAuthorityBasis;
  settingId: string | null;
  choiceOffered: boolean;
  showResearchContributionNotice: boolean;
  trialUsed: number;
  trialRemaining: number;
  trialLimit: number;
  planSetting: AccountPlanSetting;
  privateTrialEligible: boolean;
}): boolean {
  return (
    (args.hostedAuthorized ? args.reason !== null : args.reason === null) ||
    (args.choice === 'unchosen'
      ? args.choiceId !== null || args.recordedAt !== null || args.choiceGeneration !== null
      : args.choiceId === null || args.recordedAt === null || args.choiceGeneration === null) ||
    (args.hostedAuthorized &&
      args.basis === 'explicit_contribution_choice' &&
      args.choice !== 'joined') ||
    (args.basis === 'signin_default' &&
      args.planSetting !== 'never_corpus' &&
      args.planSetting !== 'research_contribution') ||
    (args.basis === 'signin_default' &&
      args.planSetting === 'research_contribution' &&
      args.choice !== 'unchosen') ||
    (args.basis === 'none') !== (args.settingId === null) ||
    (args.basis === 'explicit_contribution_choice' && args.settingId === null) ||
    args.choiceOffered !==
      (args.basis === 'none' ||
        args.basis === 'signin_default' ||
        args.basis === 'private_trial' ||
        args.basis === 'explicit_contribution_choice') ||
    (args.showResearchContributionNotice && !args.hostedAuthorized) ||
    (args.choice === 'unchosen' && args.basis === 'private_trial'
      ? args.trialUsed + args.trialRemaining !== args.trialLimit
      : args.trialRemaining !== 0) ||
    (args.basis === 'private_trial' &&
      (args.choice !== 'unchosen' ||
        args.planSetting !== 'never_corpus' ||
        args.settingId === null)) ||
    args.privateTrialEligible !==
      (args.basis === 'private_trial' &&
        args.choice === 'unchosen' &&
        args.trialRemaining > 0 &&
        args.hostedAuthorized) ||
    (args.basis === 'private_trial' &&
      args.trialRemaining === 0 &&
      (args.hostedAuthorized || args.reason !== 'hosted_private_trial_exhausted'))
  );
}

export function parseContributionPolicy(value: unknown): ContributionPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const planSetting = member(ACCOUNT_PLAN_SETTINGS, raw.account_plan_setting);
  const basis = member(PLAN_AUTHORITY_BASES, raw.plan_authority_basis);
  const choice = member(CONTRIBUTION_CHOICES, raw.contribution_choice);
  const authorityEpoch = epoch(raw.contribution_authority_epoch);
  const generation = sha256(raw.contribution_policy_generation);
  const challenge = legalChallenge(raw.legal_challenge);
  const trialLimit = raw.private_trial_limit === 3 ? 3 : null;
  const trialUsed = trialCount(raw.private_trial_used);
  const trialRemaining = trialCount(raw.private_trial_remaining);
  if (
    planSetting === null ||
    basis === null ||
    choice === null ||
    authorityEpoch === null ||
    generation === null ||
    challenge === null ||
    trialLimit === null ||
    trialUsed === null ||
    trialRemaining === null ||
    typeof raw.choice_offered !== 'boolean' ||
    typeof raw.hosted_authorized !== 'boolean' ||
    typeof raw.show_research_contribution_notice !== 'boolean' ||
    typeof raw.private_trial_eligible !== 'boolean'
  ) {
    return null;
  }

  const settingId = raw.account_setting_id === null ? null : uuid(raw.account_setting_id);
  const choiceId = raw.contribution_choice_id === null ? null : uuid(raw.contribution_choice_id);
  const recordedAt =
    raw.contribution_choice_recorded_at === null
      ? null
      : instant(raw.contribution_choice_recorded_at);
  const choiceGeneration =
    raw.contribution_choice_policy_generation === null
      ? null
      : sha256(raw.contribution_choice_policy_generation);
  if (
    (raw.account_setting_id !== null && settingId === null) ||
    (raw.contribution_choice_id !== null && choiceId === null) ||
    (raw.contribution_choice_recorded_at !== null && recordedAt === null) ||
    (raw.contribution_choice_policy_generation !== null && choiceGeneration === null)
  ) {
    return null;
  }

  const reason =
    raw.hosted_unauthorized_reason === null
      ? null
      : member(HOSTED_UNAUTHORIZED_REASONS, raw.hosted_unauthorized_reason);
  if (raw.hosted_unauthorized_reason !== null && reason === null) return null;

  if (
    contributionPolicyIsContradictory({
      hostedAuthorized: raw.hosted_authorized,
      reason,
      choice,
      choiceId,
      recordedAt,
      choiceGeneration,
      basis,
      settingId,
      choiceOffered: raw.choice_offered,
      showResearchContributionNotice: raw.show_research_contribution_notice,
      trialUsed,
      trialRemaining,
      trialLimit,
      planSetting,
      privateTrialEligible: raw.private_trial_eligible,
    })
  ) {
    return null;
  }

  return {
    account_plan_setting: planSetting,
    account_setting_id: settingId,
    plan_authority_basis: basis,
    choice_offered: raw.choice_offered,
    contribution_choice: choice,
    contribution_choice_id: choiceId,
    contribution_choice_recorded_at: recordedAt,
    hosted_authorized: raw.hosted_authorized,
    hosted_unauthorized_reason: reason,
    contribution_authority_epoch: authorityEpoch,
    show_research_contribution_notice: raw.show_research_contribution_notice,
    legal_challenge: challenge,
    contribution_policy_generation: generation,
    contribution_choice_policy_generation: choiceGeneration,
    private_trial_limit: trialLimit,
    private_trial_used: trialUsed,
    private_trial_remaining: trialRemaining,
    private_trial_eligible: raw.private_trial_eligible,
  };
}

export function parseContributionReceipt(value: unknown): ContributionReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = uuid(raw.contribution_choice_id);
  const receiptChoice = member(CONTRIBUTION_DECISIONS, raw.receipt_choice);
  const currentChoice = member(CONTRIBUTION_CHOICES, raw.current_contribution_choice);
  const authorityEpoch = epoch(raw.contribution_authority_epoch);
  const receiptGeneration = sha256(raw.contribution_choice_policy_generation);
  const generation = sha256(raw.contribution_policy_generation);
  if (
    id === null ||
    receiptChoice === null ||
    currentChoice === null ||
    authorityEpoch === null ||
    receiptGeneration === null ||
    generation === null ||
    typeof raw.hosted_authorized !== 'boolean' ||
    typeof raw.idempotent !== 'boolean'
  ) {
    return null;
  }
  const settingId = raw.account_setting_id == null ? null : uuid(raw.account_setting_id);
  if (raw.account_setting_id != null && settingId === null) return null;
  return {
    contribution_choice_id: id,
    receipt_choice: receiptChoice,
    current_contribution_choice: currentChoice,
    hosted_authorized: raw.hosted_authorized,
    idempotent: raw.idempotent,
    contribution_authority_epoch: authorityEpoch,
    contribution_choice_policy_generation: receiptGeneration,
    contribution_policy_generation: generation,
    account_setting_id: settingId,
  };
}

export const HostedContributionPolicySchema = z.unknown().transform((value, context) => {
  const parsed = parseContributionPolicy(value);
  if (parsed) return parsed;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Hosted contribution policy' });
  return z.NEVER;
});

export const HostedContributionReceiptSchema = z.unknown().transform((value, context) => {
  const parsed = parseContributionReceipt(value);
  if (parsed) return parsed;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Hosted contribution receipt' });
  return z.NEVER;
});
