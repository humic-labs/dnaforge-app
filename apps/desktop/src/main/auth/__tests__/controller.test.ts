import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DesktopAuthState } from '../../../shared/auth-types';

const h = vi.hoisted(() => ({
  state: null as null | {
    accountId: string;
    desktopSessionId: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    channel: string;
    updatedAt: number;
  },
  enc: true,
  isEncryptionAvailable: vi.fn(() => true),
}));

const refreshMock = vi.fn();
const startFlowMock = vi.fn();
const revokeMock = vi.fn();
const removeSessionMock = vi.fn(async () => {
  h.state = null;
});
const clearAllSessionsMock = vi.fn(async () => {
  h.state = null;
});
const updateTokensMock = vi.fn(async (_id: string, patch: Record<string, string>) => {
  if (h.state) h.state = { ...h.state, ...patch };
});
const openExternalMock = vi.fn(async (..._args: unknown[]) => {});
const EMAIL_ATTEMPT_ID = '550e8400-e29b-41d4-a716-446655440040';
type EmailStartResult = import('../client').EmailStartResult;
const emailStartMock = vi.fn(async (..._args: unknown[]): Promise<EmailStartResult> => {
  return { ok: true, status: 200, attemptId: EMAIL_ATTEMPT_ID };
});
const emailVerifyMock = vi.fn();
type OAuthUrlResult = { ok: boolean; status: number; url?: string };
const oauthUrlMock = vi.fn(async (..._args: unknown[]): Promise<OAuthUrlResult> => {
  return { ok: true, status: 200, url: 'https://provider.example/authorize?x=1' };
});
const ssoUrlMock = vi.fn(async (..._args: unknown[]) => ({
  ok: true,
  status: 200,
  url: 'https://api.workos.com/sso/authorize?x=1',
}));

vi.mock('../client', async (importOriginal) => ({
  emailStartFailurePayload: (await importOriginal<typeof import('../client')>())
    .emailStartFailurePayload,
  emailStartFailureMessage: (await importOriginal<typeof import('../client')>())
    .emailStartFailureMessage,
  refresh: (...a: unknown[]) => refreshMock(...a),
  startFlow: (...a: unknown[]) => startFlowMock(...a),
  revoke: (...a: unknown[]) => revokeMock(...a),
  exchange: vi.fn(),
  emailStart: (...a: unknown[]) => emailStartMock(...a),
  emailVerify: (...a: unknown[]) => emailVerifyMock(...a),
  oauthUrl: (...a: unknown[]) => oauthUrlMock(...a),
  ssoUrl: (...a: unknown[]) => ssoUrlMock(...a),
}));
vi.mock('../loopback', () => ({
  startLoopback: vi.fn(async () => ({
    redirectUri: 'http://127.0.0.1:65000/callback',
    waitForCallback: new Promise(() => {}),
    close: vi.fn(),
  })),
}));
vi.mock('../session-store', () => ({
  getActiveStoredSession: vi.fn(async () => h.state),
  getActivePublicSession: vi.fn(async () =>
    h.state
      ? {
          accountId: h.state.accountId,
          desktopSessionId: h.state.desktopSessionId,
          channel: h.state.channel,
          accessTokenExpiresAt: h.state.accessTokenExpiresAt,
        }
      : null
  ),
  updateSessionTokens: (...a: unknown[]) =>
    updateTokensMock(...(a as [string, Record<string, string>])),
  removeSession: () => removeSessionMock(),
  getAllStoredSessions: vi.fn(async () => (h.state ? [h.state] : [])),
  clearAllSessions: () => clearAllSessionsMock(),
  saveSession: vi.fn(),
  isEncryptionAvailable: (...a: unknown[]) => h.isEncryptionAvailable(...(a as [])),
}));
const pendingFlow = {
  flowNonce: 'fn-1',
  verifier: 'verifier-1',
  challenge: 'challenge-1',
  pollSecret: 'poll-1',
  pollSecretHash: 'pollhash-1',
  channel: 'dev',
  createdAt: 0,
};
vi.mock('../protocol', () => ({
  createPendingFlow: vi.fn(() => pendingFlow),
  getPendingFlow: vi.fn(() => pendingFlow),
  clearPendingFlow: vi.fn(),
  clearAllPendingFlows: vi.fn(),
  writeMarker: vi.fn(async () => {}),
  deleteMarker: vi.fn(async () => {}),
  gcMarkers: vi.fn(async () => {}),
  parseCallbackUrl: vi.fn(),
}));
vi.mock('../auth-config', () => ({
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
  getWebBaseUrl: () => 'http://fake',
}));
vi.mock('electron', () => ({
  shell: { openExternal: (...a: unknown[]) => openExternalMock(...a) },
}));
vi.mock('../../sentry', () => ({ reportOperationalFailure: vi.fn() }));

import {
  performRefresh,
  startSignIn,
  reopenSignIn,
  cancelSignIn,
  chooseOAuth,
  chooseSso,
  startEmailSignIn,
  submitEmailCode,
  handleCallback,
  signOut,
  hydrateOnLaunch,
  subscribeAuthState,
} from '../controller';
import * as clientModule from '../client';
import * as protocolModule from '../protocol';
import * as loopbackModule from '../loopback';
import * as sessionStore from '../session-store';

function storedSession(expiresInMs = 3600_000) {
  return {
    accountId: 'acct-1',
    desktopSessionId: 'sess-1',
    accessToken: 'at-1',
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    refreshToken: 'rt-1',
    channel: 'dev',
    updatedAt: 1,
  };
}
function tokens() {
  return {
    accessToken: 'at-2',
    refreshToken: 'rt-2',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: 'acct-1',
    desktopSessionId: 'sess-1',
  };
}

let states: DesktopAuthState[] = [];
let unsub: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.state = storedSession();
  h.enc = true;
  h.isEncryptionAvailable.mockReset().mockImplementation(() => h.enc);
  states = [];
  unsub = subscribeAuthState((s) => states.push(s));
});
afterEach(() => {
  unsub();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('performRefresh', () => {
  it('rotates tokens on success and stays signed-in', async () => {
    refreshMock.mockResolvedValue({ ok: true, tokens: tokens() });
    await expect(performRefresh()).resolves.toEqual({ status: 'refreshed' });
    expect(updateTokensMock).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ accessToken: 'at-2', refreshToken: 'rt-2' })
    );
    expect(states.at(-1)?.status).toBe('signed-in');
  });

  it('on revoked → drops the session and ends signed-out', async () => {
    refreshMock.mockResolvedValue({ ok: false, status: 401, error: 'REVOKED' });
    await expect(performRefresh()).resolves.toEqual({ status: 'signed_out' });
    expect(removeSessionMock).toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe('signed-out');
  });

  it('on reuse_detected → drops the session (signed out elsewhere)', async () => {
    refreshMock.mockResolvedValue({ ok: false, status: 401, error: 'REUSE_DETECTED' });
    await performRefresh();
    expect(removeSessionMock).toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe('signed-out');
  });

  it('on EXPIRED (>30d refresh) → drops the session + reprompt', async () => {
    refreshMock.mockResolvedValue({ ok: false, status: 401, error: 'EXPIRED' });
    await performRefresh();
    expect(removeSessionMock).toHaveBeenCalled();
    expect(states.some((s) => s.status === 'error')).toBe(true);
    expect(states.at(-1)?.status).toBe('signed-out');
  });

  it('on network failure → KEEPS the session (offline), does not sign out', async () => {
    refreshMock.mockRejectedValue(new Error('network down'));
    await expect(performRefresh()).resolves.toEqual({
      status: 'transient',
      code: 'NETWORK',
      message: 'network down',
    });
    expect(removeSessionMock).not.toHaveBeenCalled();
    expect(h.state).not.toBeNull();
  });

  it('reports rate limits and server outages as transient without ending the session', async () => {
    refreshMock.mockResolvedValueOnce({ ok: false, status: 429, error: 'slow_down' });
    await expect(performRefresh()).resolves.toEqual({
      status: 'transient',
      code: 'RATE_LIMITED',
      message: 'slow_down',
    });

    refreshMock.mockResolvedValueOnce({ ok: false, status: 503, error: 'unavailable' });
    await expect(performRefresh()).resolves.toEqual({
      status: 'transient',
      code: 'SERVER',
      message: 'unavailable',
    });

    expect(removeSessionMock).not.toHaveBeenCalled();
    expect(h.state).not.toBeNull();
  });

  it('main-process mutex: concurrent calls share ONE refresh', async () => {
    let resolveRefresh!: (v: unknown) => void;
    refreshMock.mockReturnValue(new Promise((r) => (resolveRefresh = r)));
    const a = performRefresh();
    const b = performRefresh();
    resolveRefresh({ ok: true, tokens: tokens() });
    await Promise.all([a, b]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe('startSignIn', () => {
  it('does not probe the OS keychain before showing the chooser ', async () => {
    h.enc = false;
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    const res = await startSignIn();
    expect(res.ok).toBe(true);
    expect(h.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(startFlowMock).toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe('choosing');
  });

  it('emits unavailable only when persisting the session fails (not on Sign In)', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({ ok: true, status: 200, attemptId: EMAIL_ATTEMPT_ID });
    emailVerifyMock.mockResolvedValue({ ok: true, tokens: tokens() });
    vi.mocked(sessionStore.saveSession).mockRejectedValueOnce(new Error('ENCRYPTION_UNAVAILABLE'));
    await startSignIn();
    expect(h.isEncryptionAvailable).not.toHaveBeenCalled();
    await startEmailSignIn('me@lab.edu');
    await submitEmailCode('123456');
    expect(states.at(-1)).toMatchObject({
      status: 'unavailable',
      reason: 'encryption_unavailable',
    });
  });

  it('registers the flow → shows the in-app chooser (no browser yet)', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    const res = await startSignIn();
    expect(res.ok).toBe(true);
    expect(startFlowMock).toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe('choosing');
  });

  it('refuses a non-HTTPS sign-in destination instead of handing it to the OS', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    oauthUrlMock.mockResolvedValueOnce({ ok: true, status: 200, url: 'file:///tmp/auth' });
    await startSignIn();
    await chooseOAuth('google');
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      reason: 'oauth_failed',
    });
  });

  it('refuses an unsafe SSO destination and does not store it for reopen', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    ssoUrlMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'smb://files.example/share',
    });
    await startSignIn();
    await chooseSso('me@lab.edu');
    expect(openExternalMock).not.toHaveBeenCalled();
    const callsBefore = openExternalMock.mock.calls.length;
    await reopenSignIn();
    expect(openExternalMock.mock.calls.length).toBe(callsBefore);
    expect(states.at(-1)?.status).toBe('error');
  });

  it('chooseOAuth opens the browser → awaiting-confirmation', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    await startSignIn();
    await chooseOAuth('google');
    expect(openExternalMock).toHaveBeenCalled();
    expect(openExternalMock).toHaveBeenCalledWith('https://provider.example/authorize?x=1');
    expect(states.at(-1)?.status).toBe('awaiting-confirmation');
  });

  it('loopback OAuth: the loopback catching the code completes → signed-in', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    vi.mocked(loopbackModule.startLoopback).mockResolvedValueOnce({
      redirectUri: 'http://127.0.0.1:65000/callback',
      waitForCallback: Promise.resolve({ code: 'oauth-code', flowNonce: 'fn-1' }),
      close: vi.fn(),
    });
    vi.mocked(clientModule.exchange).mockResolvedValue({ ok: true, tokens: tokens() } as never);
    await startSignIn();
    await chooseOAuth('google');
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)?.status).toBe('signed-in');
  });

  it('WorkOS loopback collision immediately names rescue sign-in methods', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    vi.mocked(loopbackModule.startLoopback).mockResolvedValueOnce({
      redirectUri: 'http://127.0.0.1:65000/callback',
      waitForCallback: Promise.resolve({ error: 'sso_collision', flowNonce: 'fn-1' }),
      close: vi.fn(),
    });

    await startSignIn();
    await chooseSso('me@lab.edu');
    await vi.advanceTimersByTimeAsync(1);

    expect(states.at(-1)).toMatchObject({
      status: 'error',
      reason: 'oauth_failed',
      message: expect.stringMatching(/Google, GitHub, or email/i),
    });
  });

  it('email path: startEmailSignIn → email-sent; submitEmailCode mints a session', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({ ok: true, status: 200, attemptId: EMAIL_ATTEMPT_ID });
    emailVerifyMock.mockResolvedValue({ ok: true, tokens: tokens() });
    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    expect(states.at(-1)).toMatchObject({ status: 'email-sent', email: 'me@lab.edu' });
    await submitEmailCode('123456');
    expect(emailVerifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'me@lab.edu',
        code: '123456',
        verifier: 'verifier-1',
        attemptId: EMAIL_ATTEMPT_ID,
      })
    );
    expect(states.at(-1)?.status).toBe('signed-in');
  });

  it('email path remains usable when an older web server omits the attempt ID', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({ ok: true, status: 200 });
    emailVerifyMock.mockResolvedValue({ ok: true, tokens: tokens() });

    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    await submitEmailCode('123456');

    expect(states.at(-1)?.status).toBe('signed-in');
    expect(emailVerifyMock).toHaveBeenCalledWith({
      flowNonce: 'fn-1',
      email: 'me@lab.edu',
      code: '123456',
      verifier: 'verifier-1',
    });
  });

  it('email path: a wrong code keeps the user on email-sent with an error', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({ ok: true, status: 200, attemptId: EMAIL_ATTEMPT_ID });
    emailVerifyMock.mockResolvedValue({ ok: false, status: 401, error: 'verify_failed' });
    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    await submitEmailCode('000000');
    expect(states.at(-1)).toMatchObject({ status: 'email-sent', email: 'me@lab.edu' });
    expect((states.at(-1) as { error?: string }).error).toBeTruthy();
  });

  it('a rate-limited send keeps the chooser open with a plain wait time', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({
      ok: false,
      status: 429,
      error: 'SEND_RATE_LIMITED',
      retryAfterSeconds: 2393,
    });
    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    expect(states.at(-1)).toEqual({
      status: 'choosing',
      error:
        'Please wait about 40 minutes before requesting another code, or continue with Google or GitHub.',
      errorMessagePayload: { key: 'auth.emailWait', values: { duration: 'about 40 minutes' } },
    });
    await chooseOAuth('google');
    expect(states.at(-1)?.status).toBe('awaiting-confirmation');
  });

  it('a refused resend stays on code entry so the earlier code still works', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock
      .mockResolvedValueOnce({ ok: true, status: 200, attemptId: EMAIL_ATTEMPT_ID })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        error: 'SEND_RATE_LIMITED',
        retryAfterSeconds: 45,
      });
    emailVerifyMock.mockResolvedValue({ ok: true, tokens: tokens() });
    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    await startEmailSignIn('me@lab.edu');
    expect(states.at(-1)).toEqual({
      status: 'email-sent',
      email: 'me@lab.edu',
      error:
        'Please wait about a minute before requesting another code, or continue with Google or GitHub.',
      errorMessagePayload: { key: 'auth.emailWait', values: { duration: 'about a minute' } },
    });
    await submitEmailCode('123456');
    expect(emailVerifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'me@lab.edu', attemptId: EMAIL_ATTEMPT_ID })
    );
  });

  it('a non-throttle send failure shows the generic message in the chooser', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({ ok: false, status: 503, error: 'EMAIL_UNAVAILABLE' });
    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    expect(states.at(-1)).toEqual({
      status: 'choosing',
      error: 'Could not send the code. Try again, or continue with Google or GitHub.',
    });
  });

  it('an expired flow on send ends the attempt so the next sign-in starts fresh', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    emailStartMock.mockResolvedValue({ ok: false, status: 400, error: 'FLOW_INVALID' });
    await startSignIn();
    await startEmailSignIn('me@lab.edu');
    expect(states.at(-1)).toEqual({
      status: 'error',
      reason: 'expired',
      message: 'Sign-in request expired. Start again.',
    });
  });

  it('emits error when the server /start fails', async () => {
    startFlowMock.mockResolvedValue({ ok: false, status: 500 });
    const res = await startSignIn();
    expect(res.ok).toBe(false);
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      reason: 'start_failed',
      message: userMessage('auth.guidance.13'),
    });
  });

  it('emits a NEUTRAL flag-off message on /start 404 — NEVER leaks internal config to the user ', async () => {
    startFlowMock.mockResolvedValue({ ok: false, status: 404 });
    const res = await startSignIn();
    expect(res).toEqual({ ok: false, reason: 'start_failed' });
    const last = states.at(-1) as { status?: string; reason?: string; message?: string };
    expect(last).toMatchObject({ status: 'error', reason: 'start_failed' });
    expect(last.message ?? '').not.toMatch(
      /POSTHOG|NEXT_PUBLIC|org_auth_desktop_signin|API key|feature ?flag/i
    );
    expect(last.message ?? '').toMatch(/temporarily unavailable/i);
  });

  it('chooseOAuth never silent-returns without an active flow — emits error', async () => {
    await chooseOAuth('google');
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      reason: 'oauth_failed',
      message: expect.stringMatching(/expired|Start again/i),
    });
  });

  it('chooseOAuth surfaces HTTP status when /oauth-url fails', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    oauthUrlMock.mockResolvedValue({ ok: false, status: 500 });
    await startSignIn();
    await chooseOAuth('google');
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      reason: 'oauth_failed',
      message: userMessage('auth.guidance.13'),
    });
  });

  it('chooseOAuth success emits awaiting-confirmation with providerUrl', async () => {
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    oauthUrlMock.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    });
    await startSignIn();
    await chooseOAuth('google');
    expect(states.at(-1)).toMatchObject({
      status: 'awaiting-confirmation',
      providerUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    });
  });

  it('emits error when /start aborts/times out — never leaves UI stuck on starting', async () => {
    startFlowMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );
    const res = await startSignIn();
    expect(res).toEqual({ ok: false, reason: 'network' });
    expect(states.some((s) => s.status === 'starting')).toBe(true);
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      reason: 'network',
      message: expect.stringMatching(/timed out/i),
    });
  });
});

describe('signOut', () => {
  it('full app sign-out: revokes every session server-side + wipes all local creds → signed-out', async () => {
    revokeMock.mockResolvedValue(true);
    await signOut();
    expect(revokeMock).toHaveBeenCalledWith('at-1', 'sess-1');
    expect(clearAllSessionsMock).toHaveBeenCalled();
    expect(removeSessionMock).not.toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe('signed-out');
  });
});

describe('hydrateOnLaunch', () => {
  it('emits signed-in + schedules a refresh when a session is persisted', async () => {
    refreshMock.mockResolvedValue({ ok: true, tokens: tokens() });
    h.state = storedSession(60_000);
    await hydrateOnLaunch();
    expect(states.at(-1)?.status).toBe('signed-in');
    await vi.advanceTimersByTimeAsync(10);
    expect(refreshMock).toHaveBeenCalled();
  });

  it('emits signed-out when no session is persisted', async () => {
    h.state = null;
    await hydrateOnLaunch();
    expect(states.at(-1)?.status).toBe('signed-out');
  });
});

describe('browser-open failure + reopen (Fix 4.1/4.3)', () => {
  it('T14: openExternal throwing keeps the flow alive + flags browserOpenFailed; reopen retries', async () => {
    h.state = null;
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    openExternalMock.mockRejectedValueOnce(new Error('no default browser'));

    const res = await startSignIn();
    expect(res.ok).toBe(true);
    await chooseOAuth('google');
    const awaiting = states.at(-1);
    expect(awaiting?.status).toBe('awaiting-confirmation');
    expect(awaiting?.status === 'awaiting-confirmation' && awaiting.browserOpenFailed).toBe(true);

    openExternalMock.mockResolvedValueOnce(undefined);
    const callsBefore = openExternalMock.mock.calls.length;
    await reopenSignIn();
    expect(openExternalMock.mock.calls.length).toBe(callsBefore + 1);
    const after = states.at(-1);
    expect(after?.status === 'awaiting-confirmation' && after.browserOpenFailed).toBe(false);
  });

  it('a FAILED reopen re-emits browserOpenFailed:true immediately (review #7)', async () => {
    h.state = null;
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    await startSignIn();
    await chooseOAuth('google');
    openExternalMock.mockRejectedValueOnce(new Error('still no browser'));
    await reopenSignIn();
    const after = states.at(-1);
    expect(after?.status === 'awaiting-confirmation' && after.browserOpenFailed).toBe(true);
  });

  it('reopen is a NO-OP after the flow ended — no stale-URL re-fire (review #6)', async () => {
    h.state = null;
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    await startSignIn();
    await chooseOAuth('google');
    await cancelSignIn();
    const callsBefore = openExternalMock.mock.calls.length;
    await reopenSignIn();
    expect(openExternalMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('exchange timeout (Fix 4.5)', () => {
  it('T13: a hanging /exchange aborts within the timeout → error AND tears down flow state', async () => {
    h.state = null;
    startFlowMock.mockResolvedValue({ ok: true, expiresAt: new Date().toISOString() });
    await startSignIn();
    await chooseOAuth('google');
    expect(states.at(-1)?.status).toBe('awaiting-confirmation');

    vi.mocked(protocolModule.parseCallbackUrl).mockReturnValue({
      flowNonce: 'fn-1',
      code: 'code-1',
    } as ReturnType<typeof protocolModule.parseCallbackUrl>);
    vi.mocked(clientModule.exchange).mockReturnValue(new Promise(() => {}) as never);

    const p = handleCallback('dnaforge-dev://auth-callback?code=code-1&flow_nonce=fn-1');
    expect(states.some((s) => s.status === 'exchanging')).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    await p;

    expect(states.at(-1)).toMatchObject({ status: 'error', reason: 'network' });

    expect(protocolModule.clearPendingFlow).toHaveBeenCalledWith('fn-1');
    expect(protocolModule.deleteMarker).toHaveBeenCalledWith('fn-1');
    const callsBefore = openExternalMock.mock.calls.length;
    await reopenSignIn();
    expect(openExternalMock.mock.calls.length).toBe(callsBefore);
  });
});
