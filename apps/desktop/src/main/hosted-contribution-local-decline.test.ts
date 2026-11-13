import { afterEach, describe, expect, it } from 'vitest';

import { createFileTestDb } from './__tests__/test-db';
import {
  createHostedContributionLocalDeclineTable,
  hostedContributionAccountSubjectHash,
  readHostedContributionLocalDecline,
  recordHostedContributionLocalDecline,
} from './hosted-contribution-local-decline';

const legalChallenge = {
  termsVersionId: '33333333-3333-4333-8333-333333333331',
  termsContentSha256: 'a'.repeat(64),
  privacyVersionId: '33333333-3333-4333-8333-333333333332',
  privacyContentSha256: 'b'.repeat(64),
};

let context: ReturnType<typeof createFileTestDb> | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function currentBinding(accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  return {
    accountId,
    contributionPolicyGeneration: 'e'.repeat(64),
    legalChallenge,
  };
}

describe('local Research Contribution Not now receipt', () => {
  it('stores only a hashed account subject and replays the exact receipt', () => {
    context = createFileTestDb('hosted-local-not-now');
    createHostedContributionLocalDeclineTable(context.db);
    const binding = currentBinding();

    const first = recordHostedContributionLocalDecline(context.db, binding, {
      receiptId: '11111111-1111-4111-8111-111111111111',
      recordedAt: 1_786_000_000_000,
    });
    const replay = recordHostedContributionLocalDecline(context.db, binding, {
      receiptId: '22222222-2222-4222-8222-222222222222',
      recordedAt: 1_786_000_000_001,
    });

    expect(replay).toEqual(first);
    expect(readHostedContributionLocalDecline(context.db, binding)).toEqual(first);
    expect(
      context.db
        .prepare(
          `SELECT account_subject_hash, receipt_id, contribution_policy_generation
           FROM hosted_contribution_local_declines`
        )
        .get()
    ).toEqual({
      account_subject_hash: hostedContributionAccountSubjectHash(binding.accountId),
      receipt_id: first.receiptId,
      contribution_policy_generation: binding.contributionPolicyGeneration,
    });
    expect(
      context.db
        .prepare(
          `SELECT count(*) AS count
           FROM hosted_contribution_local_declines
           WHERE account_subject_hash = ?`
        )
        .get(binding.accountId)
    ).toEqual({ count: 0 });
  });

  it('does not let another account or an old legal challenge suppress the chooser', () => {
    context = createFileTestDb('hosted-local-not-now-binding');
    createHostedContributionLocalDeclineTable(context.db);
    const binding = currentBinding();
    recordHostedContributionLocalDecline(context.db, binding, {
      receiptId: '11111111-1111-4111-8111-111111111111',
      recordedAt: 1,
    });

    expect(
      readHostedContributionLocalDecline(context.db, {
        ...binding,
        accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })
    ).toBeNull();
    expect(
      readHostedContributionLocalDecline(context.db, {
        ...binding,
        contributionPolicyGeneration: 'f'.repeat(64),
      })
    ).toBeNull();
    expect(
      readHostedContributionLocalDecline(context.db, {
        ...binding,
        legalChallenge: { ...legalChallenge, termsContentSha256: 'c'.repeat(64) },
      })
    ).toBeNull();
    expect(
      readHostedContributionLocalDecline(context.db, {
        ...binding,
        legalChallenge: {
          ...legalChallenge,
          privacyVersionId: '44444444-4444-4444-8444-444444444444',
        },
      })
    ).toBeNull();
  });

  it('fails closed when the same account and generation carry different legal bytes', () => {
    context = createFileTestDb('hosted-local-not-now-conflict');
    const { db } = context;
    createHostedContributionLocalDeclineTable(db);
    const binding = currentBinding();
    recordHostedContributionLocalDecline(db, binding);

    expect(() =>
      recordHostedContributionLocalDecline(db, {
        ...binding,
        legalChallenge: { ...legalChallenge, privacyContentSha256: 'c'.repeat(64) },
      })
    ).toThrow(/current legal challenge/i);
    expect(
      db.prepare('SELECT count(*) AS count FROM hosted_contribution_local_declines').get()
    ).toEqual({ count: 1 });
  });

  it('rejects malformed account, policy, document, hash, receipt, and time inputs', () => {
    context = createFileTestDb('hosted-local-not-now-validation');
    const { db } = context;
    createHostedContributionLocalDeclineTable(db);
    const binding = currentBinding();

    expect(() => recordHostedContributionLocalDecline(db, { ...binding, accountId: '' })).toThrow(
      /account/i
    );
    expect(() =>
      recordHostedContributionLocalDecline(db, {
        ...binding,
        contributionPolicyGeneration: 'E'.repeat(64),
      })
    ).toThrow(/policy generation/i);
    expect(() =>
      recordHostedContributionLocalDecline(db, {
        ...binding,
        legalChallenge: { ...legalChallenge, termsVersionId: 'not-a-uuid' },
      })
    ).toThrow(/terms version/i);
    expect(() =>
      recordHostedContributionLocalDecline(db, {
        ...binding,
        legalChallenge: { ...legalChallenge, privacyContentSha256: 'B'.repeat(64) },
      })
    ).toThrow(/privacy content/i);
    expect(() =>
      recordHostedContributionLocalDecline(db, binding, { receiptId: 'not-a-uuid' })
    ).toThrow(/receipt/i);
    expect(() => recordHostedContributionLocalDecline(db, binding, { recordedAt: -1 })).toThrow(
      /recorded time/i
    );
  });

  it('does not create the table as a side effect of a read', () => {
    context = createFileTestDb('hosted-local-not-now-read');

    expect(() => readHostedContributionLocalDecline(context!.db, currentBinding())).toThrow(
      /no such table/i
    );
    expect(
      context.db
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'hosted_contribution_local_declines'`
        )
        .get()
    ).toEqual({ count: 0 });
  });
});
