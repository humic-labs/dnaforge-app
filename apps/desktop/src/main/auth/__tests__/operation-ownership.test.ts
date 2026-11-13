import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  directory: '',
  exchange: vi.fn(),
  profile: vi.fn(),
  start: vi.fn(),
  email: vi.fn(),
  verify: vi.fn(),
  avatar: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => h.directory },
  shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));
vi.mock('../../sentry', () => ({ reportOperationalFailure: vi.fn() }));
vi.mock('../auth-config', () => ({
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));
vi.mock('../client', () => ({
  startFlow: (...args: unknown[]) => h.start(...args),
  exchange: (...args: unknown[]) => h.exchange(...args),
  updateProfile: (...args: unknown[]) => h.profile(...args),
  emailStart: (...args: unknown[]) => h.email(...args),
  emailVerify: (...args: unknown[]) => h.verify(...args),
  refresh: async () => ({
    ok: true,
    tokens: {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  }),
  revoke: async () => true,
}));
vi.mock('../materialize-avatar', () => ({
  materializeRendererAvatar: (...args: unknown[]) => h.avatar(...args),
}));
vi.mock('../loopback', () => ({ startLoopback: vi.fn() }));
vi.mock('../sign-in-url', () => ({ parseSignInUrl: () => null }));
import * as controller from '../controller';
import * as store from '../session-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tokens = {
  accountId: 'account-a',
  desktopSessionId: 'session-a',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
async function seed() {
  await store.saveSession({
    ...tokens,
    accessTokenExpiresAt: tokens.expiresAt,
    channel: 'dev',
    updatedAt: 1,
  });
}
async function callback() {
  const nonce = controller.getActiveFlowNonceForTest();
  return controller.handleCallback(`dnaforge-dev://auth-callback?code=code&flow_nonce=${nonce}`);
}
beforeEach(async () => {
  h.directory = await mkdtemp(join(tmpdir(), 'fixture-auth-'));
  h.start.mockReset().mockResolvedValue({ ok: true });
  h.exchange.mockReset();
  h.profile.mockReset();
  h.email.mockReset();
  h.verify.mockReset();
  h.avatar.mockReset().mockResolvedValue(null);
  await controller.cancelSignIn();
});
afterEach(async () => {
  await controller.cancelSignIn();
  await controller.signOut();
  await rm(h.directory, { recursive: true, force: true });
});

describe('authentication operation ownership with persisted sessions', () => {
  it('keeps a canceled exchange signed out when its response arrives', async () => {
    const exchange = deferred<unknown>();
    h.exchange.mockReturnValue(exchange.promise);
    await controller.startSignIn();
    const completing = callback();
    expect(controller.getAuthState().status).toBe('exchanging');
    await controller.cancelSignIn();
    exchange.resolve({ ok: true, tokens });
    await completing;
    expect(controller.getAuthState().status).toBe('signed-out');
    expect(await store.getActiveStoredSession()).toBeNull();
  });

  it('does not restore a canceled chooser when startup finishes', async () => {
    const start = deferred<unknown>();
    const entered = deferred<void>();
    h.start.mockImplementation(() => {
      entered.resolve();
      return start.promise;
    });
    const starting = controller.startSignIn();
    await entered.promise;
    await controller.cancelSignIn();
    start.resolve({ ok: true });
    await starting;
    expect(controller.getAuthState().status).toBe('signed-out');
    expect(controller.getActiveFlowNonceForTest()).toBeNull();
  });

  it('does not persist a canceled exchange after avatar loading', async () => {
    const avatar = deferred<string | null>();
    const entered = deferred<void>();
    h.avatar.mockImplementation(() => {
      entered.resolve();
      return avatar.promise;
    });
    h.exchange.mockResolvedValue({ ok: true, tokens });
    await controller.startSignIn();
    const completing = callback();
    await entered.promise;
    await controller.cancelSignIn();
    avatar.resolve(null);
    await completing;
    expect(controller.getAuthState().status).toBe('signed-out');
    expect(await store.getActiveStoredSession()).toBeNull();
  });

  it('does not restore an email screen after cancellation', async () => {
    const email = deferred<unknown>();
    h.email.mockReturnValue(email.promise);
    await controller.startSignIn();
    const sending = controller.startEmailSignIn('scientist@example.org');
    await controller.cancelSignIn();
    email.resolve({ ok: true, attemptId: 'attempt-a' });
    await sending;
    expect(controller.getAuthState().status).toBe('signed-out');
  });

  it('does not sign in from email verification completed after cancellation', async () => {
    const verify = deferred<unknown>();
    h.email.mockResolvedValue({ ok: true, attemptId: 'attempt-a' });
    h.verify.mockReturnValue(verify.promise);
    await controller.startSignIn();
    await controller.startEmailSignIn('scientist@example.org');
    const verifying = controller.submitEmailCode('123456');
    await controller.cancelSignIn();
    verify.resolve({ ok: true, tokens });
    await verifying;
    expect(controller.getAuthState().status).toBe('signed-out');
    expect(await store.getActiveStoredSession()).toBeNull();
  });

  it('preserves refreshed credentials when a profile response arrives', async () => {
    await seed();
    const result = deferred<unknown>();
    const entered = deferred<void>();
    h.profile.mockImplementation(() => {
      entered.resolve();
      return result.promise;
    });
    const editing = controller.updateProfile({ displayName: 'Updated' });
    await entered.promise;
    await controller.performRefresh();
    result.resolve({ ok: true, displayName: 'Updated', avatarUrl: null });
    expect(await editing).toEqual({ ok: true });
    expect(await store.getActiveStoredSession()).toMatchObject({
      displayName: 'Updated',
      refreshToken: 'new-refresh',
      accessToken: 'new-access',
    });
  });

  it('does not recreate a signed-out session from a profile response', async () => {
    await seed();
    const result = deferred<unknown>();
    const entered = deferred<void>();
    h.profile.mockImplementation(() => {
      entered.resolve();
      return result.promise;
    });
    const editing = controller.updateProfile({ displayName: 'Updated' });
    await entered.promise;
    await controller.signOut();
    result.resolve({ ok: true, displayName: 'Updated', avatarUrl: null });
    expect((await editing).ok).toBe(false);
    expect(await store.getActiveStoredSession()).toBeNull();
    expect(controller.getAuthState().status).toBe('signed-out');
  });

  it('preserves independently saved accounts during concurrent persistence', async () => {
    await Promise.all(
      ['a', 'b'].map((id) =>
        store.saveSession({
          ...tokens,
          accountId: id,
          desktopSessionId: `session-${id}`,
          accessTokenExpiresAt: tokens.expiresAt,
          channel: 'dev',
          updatedAt: 1,
        })
      )
    );
    expect((await store.getAllStoredSessions()).map((session) => session.accountId).sort()).toEqual(
      ['a', 'b']
    );
  });
});
