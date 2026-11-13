import { describe, expect, it } from 'vitest';
import { parseDesktopSyncClaimResponse } from './desktop-sync-claim';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ORG = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

function personalClaim(): Record<string, unknown> {
  return {
    status: 'created',
    workspaceId: WORKSPACE,
    clientWorkspaceId: 'workspace-a',
    ownerKind: 'personal',
    owner: { kind: 'personal', accountId: ACCOUNT },
    claimedBy: { accountId: ACCOUNT },
  };
}

function orgClaim(): Record<string, unknown> {
  return {
    status: 'reused',
    workspaceId: WORKSPACE,
    clientWorkspaceId: 'workspace-a',
    ownerKind: 'org',
    owner: { kind: 'org', orgId: ORG },
    claimedBy: { accountId: ACCOUNT },
  };
}

describe('parseDesktopSyncClaimResponse', () => {
  it('accepts a personal claim and preserves the server-confirmed identity', () => {
    expect(parseDesktopSyncClaimResponse(personalClaim())).toEqual({
      status: 'created',
      workspaceId: WORKSPACE,
      clientWorkspaceId: 'workspace-a',
      ownerKind: 'personal',
      owner: { kind: 'personal', accountId: ACCOUNT },
      claimedBy: { accountId: ACCOUNT },
    });
  });

  it('accepts an org claim made by a member account', () => {
    expect(parseDesktopSyncClaimResponse(orgClaim())).toEqual({
      status: 'reused',
      workspaceId: WORKSPACE,
      clientWorkspaceId: 'workspace-a',
      ownerKind: 'org',
      owner: { kind: 'org', orgId: ORG },
      claimedBy: { accountId: ACCOUNT },
    });
  });

  it('keeps a personal claim whose owner differs from the claimant parseable so the caller can reject it with evidence', () => {
    const value = personalClaim();
    value.owner = { kind: 'personal', accountId: OTHER_ACCOUNT };
    expect(parseDesktopSyncClaimResponse(value).owner).toEqual({
      kind: 'personal',
      accountId: OTHER_ACCOUNT,
    });
  });

  it.each([
    { label: 'a non-object', mutate: () => 'claimed' },
    { label: 'an array', mutate: () => [personalClaim()] },
    {
      label: 'an unknown status',
      mutate: (v: Record<string, unknown>) => ({ ...v, status: 'ready' }),
    },
    {
      label: 'a workspace id that is not a UUID',
      mutate: (v: Record<string, unknown>) => ({ ...v, workspaceId: 'not-a-uuid' }),
    },
    {
      label: 'an empty client workspace id',
      mutate: (v: Record<string, unknown>) => ({ ...v, clientWorkspaceId: '  ' }),
    },
    {
      label: 'a missing owner',
      mutate: (v: Record<string, unknown>) => ({ ...v, owner: undefined }),
    },
    {
      label: 'an unknown owner kind',
      mutate: (v: Record<string, unknown>) => ({ ...v, owner: { kind: 'team', teamId: ORG } }),
    },
    {
      label: 'a personal owner without an account id',
      mutate: (v: Record<string, unknown>) => ({ ...v, owner: { kind: 'personal' } }),
    },
    {
      label: 'a personal owner carrying an org id',
      mutate: (v: Record<string, unknown>) => ({
        ...v,
        owner: { kind: 'personal', accountId: ACCOUNT, orgId: ORG },
      }),
    },
    {
      label: 'an org owner without an org id',
      mutate: (v: Record<string, unknown>) => ({
        ...v,
        ownerKind: 'org',
        owner: { kind: 'org' },
      }),
    },
    {
      label: 'an owner kind that disagrees with the owner record',
      mutate: (v: Record<string, unknown>) => ({ ...v, ownerKind: 'org' }),
    },
    {
      label: 'a missing claimant',
      mutate: (v: Record<string, unknown>) => ({ ...v, claimedBy: null }),
    },
    {
      label: 'a claimant without an account id',
      mutate: (v: Record<string, unknown>) => ({ ...v, claimedBy: { accountId: '' } }),
    },
    {
      label: 'the pre- shape that only echoed an owner kind',
      mutate: (v: Record<string, unknown>) => {
        const { owner: _owner, claimedBy: _claimedBy, ...legacy } = v;
        return legacy;
      },
    },
  ])('rejects $label', ({ mutate }) => {
    expect(() => parseDesktopSyncClaimResponse(mutate(personalClaim()))).toThrow(/claim response/i);
  });
});
