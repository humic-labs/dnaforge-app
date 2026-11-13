import { describe, expect, it, vi } from 'vitest';
import { HostedAiTurnAuthority } from './hosted-ai-turn-authority';

const identity = { workflowId: 'conversation-1', runId: 'turn-1', turnId: 'turn-1' };
const sessionA = {
  accountId: 'account-a',
  desktopSessionId: 'session-a',
  accessToken: 'token-a',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshToken: 'refresh-a',
  channel: 'dev',
  updatedAt: 1,
};

describe('HostedAiTurnAuthority', () => {
  it('binds one opaque capability to owner, account, desktop session, and turn identity', async () => {
    const getSession = vi.fn(async () => sessionA);
    const authority = new HostedAiTurnAuthority({
      getSession,
      idGenerator: () => 'binding-token-a',
      now: () => 1_000,
    });
    const token = authority.issue(7, sessionA, identity, '/workspace-a');

    await expect(authority.authorize(7, token, identity)).resolves.toBe(sessionA);
    await expect(authority.authorizeScope(7, token, identity)).resolves.toEqual({
      session: sessionA,
      workspacePath: '/workspace-a',
    });
    await expect(authority.authorize(8, token, identity)).rejects.toThrow(/binding/i);
    await expect(
      authority.authorize(7, token, { ...identity, turnId: 'turn-other' })
    ).rejects.toThrow(/binding/i);
  });

  it('fails closed when the active account or desktop session changes', async () => {
    let active = sessionA;
    const authority = new HostedAiTurnAuthority({
      getSession: async () => active,
      idGenerator: () => 'binding-token-a',
    });
    const token = authority.issue(7, sessionA, identity);
    active = { ...sessionA, accountId: 'account-b', desktopSessionId: 'session-b' };

    await expect(authority.authorize(7, token, identity)).rejects.toThrow(/changed/i);
  });

  it('atomically drains a turn before asynchronous native cleanup begins', async () => {
    const authority = new HostedAiTurnAuthority({
      getSession: async () => sessionA,
      idGenerator: () => 'binding-token-a',
    });
    const token = authority.issue(7, sessionA, identity);

    expect(() => authority.beginDrain(7, token, identity)).not.toThrow();
    await expect(authority.authorize(7, token, identity)).rejects.toThrow(/draining/i);
    expect(() => authority.beginDrain(7, token, identity)).not.toThrow();

    authority.release(7, token);
    expect(() => authority.beginDrain(7, token, identity)).toThrow(/invalid/i);
  });

  it('expires and revokes capabilities without affecting another owner', async () => {
    let now = 1_000;
    let sequence = 0;
    const authority = new HostedAiTurnAuthority({
      getSession: async () => sessionA,
      idGenerator: () => `binding-${++sequence}`,
      now: () => now,
      lifetimeMs: 10,
    });
    const expired = authority.issue(7, sessionA, identity);
    const other = authority.issue(8, sessionA, identity);
    now = 1_011;

    await expect(authority.authorize(7, expired, identity)).rejects.toThrow(/expired/i);
    authority.cancelOwner(7);
    await expect(authority.authorize(8, other, identity)).rejects.toThrow(/expired/i);

    now = 2_000;
    const kept = authority.issue(8, sessionA, identity);
    const revoked = authority.issue(7, sessionA, identity);
    authority.cancelOwner(7);
    await expect(authority.authorize(7, revoked, identity)).rejects.toThrow(/binding/i);
    await expect(authority.authorize(8, kept, identity)).resolves.toBe(sessionA);
  });
});
