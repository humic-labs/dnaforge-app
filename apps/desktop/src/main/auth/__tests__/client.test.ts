import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronAppState = vi.hoisted(() => ({
  isPackaged: false,
  getWebBaseUrl: vi.fn(() => 'http://web.test'),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    getPath: () => '/tmp/dnaforge-auth-client-test',
    get isPackaged() {
      return electronAppState.isPackaged;
    },
  },
}));

vi.mock('../auth-config', () => ({
  getWebBaseUrl: () => electronAppState.getWebBaseUrl(),
}));

import {
  AUTH_FETCH_TIMEOUT_MS,
  emailStart,
  emailStartFailureMessage,
  emailVerify,
  oauthUrl,
  startFlow,
  waitDurationPhrase,
} from '../client';

describe('desktop auth HTTP client timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronAppState.isPackaged = false;
    electronAppState.getWebBaseUrl.mockReturnValue('http://web.test');
    delete process.env.DNAFORGE_TELEMETRY_ACTOR;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION;
    vi.stubGlobal('__DNAFORGE_BUILD_TAG__', 'v0.0.0-test');
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', 'prod');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.DNAFORGE_TELEMETRY_ACTOR;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION;
  });

  it('aborts a hung /start so the UI cannot stick on starting forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      })
    );

    const pending = startFlow({
      flowNonce: 'fn',
      challenge: 'ch',
      pollSecretHash: 'ph',
      deviceName: 'test',
      devicePlatform: 'darwin',
      installChannel: 'dev',
      redirectScheme: 'dnaforge-dev',
    });

    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(AUTH_FETCH_TIMEOUT_MS);
    await expectation;
  });

  it('keeps the timeout active when headers arrive but the response body stalls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream({
          start(controller) {
            const onAbort = () =>
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      })
    );

    const pending = emailStart('flow-1', 'user@example.com');
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(AUTH_FETCH_TIMEOUT_MS);
    await expectation;
  });

  it('sends bounded CI telemetry context with a packaged-auth attempt', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = '32902696778';
    process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION = 'dfactor2.c2lnbmVk.c2lnbmF0dXJl';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ url: 'https://accounts.example/authorize' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    await oauthUrl('fn', 'google', 'http://127.0.0.1:51000/callback', 'poll-secret');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.telemetry_actor).toBe('ci');
    expect(body.ci_run_id).toBe('32902696778');
    expect(body.telemetry_actor_assertion).toBe('dfactor2.c2lnbmVk.c2lnbmF0dXJl');
    expect(body).not.toHaveProperty('desktop_build_tag');
    expect(body.desktop_release_channel).toBe('prod');
  });

  it('joins desktop email start and verify with the server-owned attempt and CI context', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = '32902696778';
    process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION = 'dfactor2.c2lnbmVk.c2lnbmF0dXJl';
    const attemptId = '550e8400-e29b-41d4-a716-446655440040';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, auth_attempt_id: attemptId }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'header.payload.sig',
            refresh_token: 'refresh',
            expires_at: '2030-01-01T00:00:00.000Z',
            account_id: 'acct-1',
            desktop_session_id: 'session-1',
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(emailStart('flow-1', 'user@example.com')).resolves.toMatchObject({
      ok: true,
      attemptId,
    });
    await expect(
      emailVerify({
        flowNonce: 'flow-1',
        email: 'user@example.com',
        code: '123456',
        verifier: 'verifier',
        attemptId,
      })
    ).resolves.toMatchObject({ ok: true });

    const startBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const verifyBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(startBody).toMatchObject({
      telemetry_actor: 'ci',
      ci_run_id: '32902696778',
      telemetry_actor_assertion: 'dfactor2.c2lnbmVk.c2lnbmF0dXJl',
      desktop_release_channel: 'prod',
    });
    expect(verifyBody).toMatchObject({
      auth_attempt_id: attemptId,
    });
    expect(verifyBody).not.toHaveProperty('telemetry_actor');
    expect(verifyBody).not.toHaveProperty('ci_run_id');
  });

  it('omits actor claims when a packaged internal assertion is rejected', async () => {
    electronAppState.isPackaged = true;
    process.env.DNAFORGE_TELEMETRY_ACTOR = 'ci';
    process.env.GITHUB_RUN_ID = '32902696778';
    process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION = 'dfactor2.c2lnbmVk.c2lnbmF0dXJl';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ url: 'https://accounts.example/authorize' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    await oauthUrl('fn', 'google', 'http://127.0.0.1:51000/callback', 'poll-secret');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty('telemetry_actor');
    expect(body).not.toHaveProperty('ci_run_id');
    expect(body).not.toHaveProperty('telemetry_actor_assertion');
    expect(body.desktop_release_channel).toBe('prod');
  });

  it('returns the status, error code and wait time when a send is throttled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'SEND_RATE_LIMITED',
            message: 'Please wait before requesting another email.',
            retry_after_seconds: 2393,
          }),
          { status: 429 }
        )
      )
    );
    await expect(emailStart('flow-1', 'user@example.com')).resolves.toStrictEqual({
      ok: false,
      status: 429,
      error: 'SEND_RATE_LIMITED',
      retryAfterSeconds: 2393,
    });
  });

  it('falls back to the Retry-After header when the body has no wait time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'TOO_MANY_REQUESTS' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      )
    );
    await expect(emailStart('flow-1', 'user@example.com')).resolves.toStrictEqual({
      ok: false,
      status: 429,
      error: 'TOO_MANY_REQUESTS',
      retryAfterSeconds: 30,
    });
  });

  it('keeps email auth compatible with a web server that predates attempt IDs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'header.payload.sig',
            refresh_token: 'refresh',
            expires_at: '2030-01-01T00:00:00.000Z',
            account_id: 'acct-1',
            desktop_session_id: 'session-1',
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(emailStart('flow-1', 'user@example.com')).resolves.toEqual({
      ok: true,
      status: 200,
      attemptId: undefined,
    });
    await expect(
      emailVerify({
        flowNonce: 'flow-1',
        email: 'user@example.com',
        code: '123456',
        verifier: 'verifier',
      })
    ).resolves.toMatchObject({ ok: true });

    const verifyBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(verifyBody).not.toHaveProperty('auth_attempt_id');
  });
});

describe('desktop auth HTTP origin', () => {
  beforeEach(() => {
    electronAppState.getWebBaseUrl.mockReturnValue('https://dnaforge.com');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts desktop-auth to www when the sealed origin is apex', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ expires_at: '2030-01-01T00:00:00.000Z' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await startFlow({
      flowNonce: 'fn',
      challenge: 'ch',
      pollSecretHash: 'ph',
      deviceName: 'test',
      devicePlatform: 'darwin',
      installChannel: 'stable',
      redirectScheme: 'dnaforge',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.dnaforge.com/api/desktop-auth/start',
      expect.any(Object)
    );
  });
});

describe('waitDurationPhrase', () => {
  it.each([
    [1, 'about a minute'],
    [89, 'about a minute'],
    [90, 'about 2 minutes'],
    [2393, 'about 40 minutes'],
    [5399, 'about 90 minutes'],
    [5400, 'about 2 hours'],
    [18_000, 'about 5 hours'],
  ])('%i seconds reads as %s', (seconds, phrase) => {
    expect(waitDurationPhrase(seconds)).toBe(phrase);
  });
});

describe('emailStartFailureMessage', () => {
  it('builds a throttle message from the wait time', () => {
    expect(emailStartFailureMessage({ status: 429, retryAfterSeconds: 2393 })).toBe(
      'Please wait about 40 minutes before requesting another code, or continue with Google or GitHub.'
    );
  });

  it('handles a throttle without a wait time', () => {
    expect(emailStartFailureMessage({ status: 429 })).toBe(
      'Please wait a few minutes before requesting another code, or continue with Google or GitHub.'
    );
  });

  it('uses the generic message for other failures', () => {
    expect(emailStartFailureMessage({ status: 503, retryAfterSeconds: 30 })).toBe(
      'Could not send the code. Try again, or continue with Google or GitHub.'
    );
  });
});
