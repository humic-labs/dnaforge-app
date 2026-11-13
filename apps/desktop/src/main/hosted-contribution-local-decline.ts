import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface HostedContributionLegalChallenge {
  readonly termsVersionId: string;
  readonly termsContentSha256: string;
  readonly privacyVersionId: string;
  readonly privacyContentSha256: string;
}

export interface HostedContributionLocalDeclineBinding {
  readonly accountId: string;
  readonly contributionPolicyGeneration: string;
  readonly legalChallenge: HostedContributionLegalChallenge;
}

export interface HostedContributionLocalDeclineReceipt extends HostedContributionLegalChallenge {
  readonly receiptId: string;
  readonly contributionPolicyGeneration: string;
  readonly recordedAt: string;
}

interface HostedContributionLocalDeclineRow {
  readonly receipt_id: string;
  readonly contribution_policy_generation: string;
  readonly terms_version_id: string;
  readonly terms_content_sha256: string;
  readonly privacy_version_id: string;
  readonly privacy_content_sha256: string;
  readonly recorded_at: number;
}

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const ACCOUNT_SUBJECT_HASH_DOMAIN = 'dnaforge:hosted-contribution-account-subject:v1\0';

export function hostedContributionAccountSubjectHash(accountId: string): string {
  assertAccountId(accountId);
  return createHash('sha256')
    .update(ACCOUNT_SUBJECT_HASH_DOMAIN, 'utf8')
    .update(accountId, 'utf8')
    .digest('hex');
}

export function createHostedContributionLocalDeclineTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_contribution_local_declines (
      account_subject_hash TEXT NOT NULL
        CHECK(length(account_subject_hash) = 64
          AND account_subject_hash NOT GLOB '*[^0-9a-f]*'),
      contribution_policy_generation TEXT NOT NULL
        CHECK(length(contribution_policy_generation) = 64
          AND contribution_policy_generation NOT GLOB '*[^0-9a-f]*'),
      terms_version_id TEXT NOT NULL CHECK(length(terms_version_id) = 36),
      terms_content_sha256 TEXT NOT NULL
        CHECK(length(terms_content_sha256) = 64
          AND terms_content_sha256 NOT GLOB '*[^0-9a-f]*'),
      privacy_version_id TEXT NOT NULL CHECK(length(privacy_version_id) = 36),
      privacy_content_sha256 TEXT NOT NULL
        CHECK(length(privacy_content_sha256) = 64
          AND privacy_content_sha256 NOT GLOB '*[^0-9a-f]*'),
      receipt_id TEXT NOT NULL UNIQUE CHECK(length(receipt_id) = 36),
      recorded_at INTEGER NOT NULL CHECK(recorded_at BETWEEN 0 AND 8640000000000000),
      PRIMARY KEY (account_subject_hash, contribution_policy_generation)
    ) WITHOUT ROWID
  `);
}

export function readHostedContributionLocalDecline(
  db: Database.Database,
  binding: HostedContributionLocalDeclineBinding
): HostedContributionLocalDeclineReceipt | null {
  const validated = validateBinding(binding);
  const row = db
    .prepare(
      `SELECT
         receipt_id,
         contribution_policy_generation,
         terms_version_id,
         terms_content_sha256,
         privacy_version_id,
         privacy_content_sha256,
         recorded_at
       FROM hosted_contribution_local_declines
       WHERE account_subject_hash = ?
         AND contribution_policy_generation = ?
         AND terms_version_id = ?
         AND terms_content_sha256 = ?
         AND privacy_version_id = ?
         AND privacy_content_sha256 = ?`
    )
    .get(
      validated.accountSubjectHash,
      binding.contributionPolicyGeneration,
      binding.legalChallenge.termsVersionId,
      binding.legalChallenge.termsContentSha256,
      binding.legalChallenge.privacyVersionId,
      binding.legalChallenge.privacyContentSha256
    ) as HostedContributionLocalDeclineRow | undefined;

  return row ? receiptFromRow(row) : null;
}

export function recordHostedContributionLocalDecline(
  db: Database.Database,
  binding: HostedContributionLocalDeclineBinding,
  input: { readonly receiptId?: string; readonly recordedAt?: number } = {}
): HostedContributionLocalDeclineReceipt {
  const validated = validateBinding(binding);
  const receiptId = input.receiptId ?? randomUUID();
  const recordedAt = input.recordedAt ?? Date.now();
  assertUuid(receiptId, 'receipt ID');
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0 || recordedAt > MAX_DATE_MS) {
    throw new Error('The local contribution decline recorded time is invalid.');
  }

  db.prepare(
    `INSERT INTO hosted_contribution_local_declines (
       account_subject_hash,
       contribution_policy_generation,
       terms_version_id,
       terms_content_sha256,
       privacy_version_id,
       privacy_content_sha256,
       receipt_id,
       recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_subject_hash, contribution_policy_generation) DO NOTHING`
  ).run(
    validated.accountSubjectHash,
    binding.contributionPolicyGeneration,
    binding.legalChallenge.termsVersionId,
    binding.legalChallenge.termsContentSha256,
    binding.legalChallenge.privacyVersionId,
    binding.legalChallenge.privacyContentSha256,
    receiptId,
    recordedAt
  );

  const receipt = readHostedContributionLocalDecline(db, binding);
  if (!receipt) {
    throw new Error('The local contribution decline did not match the current legal challenge.');
  }
  return receipt;
}

function validateBinding(binding: HostedContributionLocalDeclineBinding): {
  readonly accountSubjectHash: string;
} {
  const accountSubjectHash = hostedContributionAccountSubjectHash(binding.accountId);
  assertSha256(binding.contributionPolicyGeneration, 'contribution policy generation');
  assertUuid(binding.legalChallenge.termsVersionId, 'Terms version ID');
  assertSha256(binding.legalChallenge.termsContentSha256, 'Terms content hash');
  assertUuid(binding.legalChallenge.privacyVersionId, 'Privacy version ID');
  assertSha256(binding.legalChallenge.privacyContentSha256, 'Privacy content hash');
  return { accountSubjectHash };
}

function assertAccountId(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new Error('The Hosted AI account subject is invalid.');
  }
}

function assertSha256(value: string, label: string): void {
  if (!LOWER_SHA256.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!LOWER_UUID.test(value)) {
    throw new Error(`The ${label} must be a canonical lowercase UUID.`);
  }
}

function receiptFromRow(
  row: HostedContributionLocalDeclineRow
): HostedContributionLocalDeclineReceipt {
  return {
    receiptId: row.receipt_id,
    contributionPolicyGeneration: row.contribution_policy_generation,
    termsVersionId: row.terms_version_id,
    termsContentSha256: row.terms_content_sha256,
    privacyVersionId: row.privacy_version_id,
    privacyContentSha256: row.privacy_content_sha256,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}
