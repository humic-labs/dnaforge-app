import { userMessage } from '@waypoint/user-messages';
import { expectToastCall } from '../test/toast-assertions';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DesktopAuthState } from '../shared/auth-types';

const addToast = vi.fn();
vi.mock('./toast-store', () => ({ useToastStore: { getState: () => ({ addToast }) } }));

import { hasDesktopAuthBridge, useAuthStore } from './auth-store';

let stateCb: ((s: DesktopAuthState) => void) | null = null;
const authMock = {
  startSignIn: vi.fn(async () => ({ ok: true })),
  cancelSignIn: vi.fn(async () => {}),
  reopenSignIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  getActiveSession: vi.fn(async () => null as unknown),
  getState: vi.fn(async () => ({ status: 'signed-out' }) as DesktopAuthState),
  onAuthStateChanged: vi.fn((cb: (s: DesktopAuthState) => void) => {
    stateCb = cb;
    return () => {};
  }),
};

const signedInSession = {
  accountId: 'a',
  desktopSessionId: 's',
  channel: 'stable',
  email: 'user@example.com',
  accessTokenExpiresAt: '2030-01-01T00:00:00Z',
};

const flush = () => new Promise((r) => setTimeout(r, 0));

let savedElectronAPI: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  stateCb = null;
  savedElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { electronAPI?: unknown }).electronAPI = { auth: authMock };
  useAuthStore.setState({
    state: { status: 'signed-out' },
    initialized: false,
    hydrated: false,
  });
});
afterEach(() => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = savedElectronAPI;
});

describe('useAuthStore', () => {
  it('init subscribes to state changes and hydrates from getState', async () => {
    authMock.getState.mockResolvedValueOnce({
      status: 'signed-in',
      session: {
        accountId: 'a',
        desktopSessionId: 's',
        channel: 'stable',
        accessTokenExpiresAt: '2030-01-01T00:00:00Z',
      },
    } as DesktopAuthState);
    useAuthStore.getState().init();
    expect(authMock.onAuthStateChanged).toHaveBeenCalled();
    await flush();
    expect(useAuthStore.getState().state).toMatchObject({ status: 'signed-in' });
    expect(useAuthStore.getState().hydrated).toBe(true);
  });

  it('init is idempotent (second call is a no-op)', () => {
    useAuthStore.getState().init();
    useAuthStore.getState().init();
    expect(authMock.onAuthStateChanged).toHaveBeenCalledTimes(1);
  });

  it('surfaces error states as a toast', () => {
    useAuthStore.getState().init();
    stateCb?.({ status: 'error', reason: 'x', message: 'Sign-in failed' });
    expectToastCall(addToast, userMessage('operation.failed'), 'error');
    expect(useAuthStore.getState().state.status).toBe('error');
  });

  it('surfaces encryption-unavailable as a persistent error toast', () => {
    useAuthStore.getState().init();
    stateCb?.({ status: 'unavailable', reason: 'encryption_unavailable' });
    expectToastCall(addToast, expect.stringContaining('Encrypted storage'), 'error', 0);
  });

  it('fires a success toast ONLY on the interactive sign-in (justSignedIn)', () => {
    useAuthStore.getState().init();
    stateCb?.({ status: 'signed-in', session: signedInSession, justSignedIn: true });
    expectToastCall(addToast, 'Signed in as user@example.com', 'success');
    expect(useAuthStore.getState().state.status).toBe('signed-in');
  });

  it('does NOT toast on signed-in without justSignedIn (launch hydration / refresh)', () => {
    useAuthStore.getState().init();
    stateCb?.({ status: 'signed-in', session: signedInSession });
    expect(addToast).not.toHaveBeenCalled();
    expect(useAuthStore.getState().state.status).toBe('signed-in');
  });

  it('actions delegate to the electron bridge', async () => {
    await useAuthStore.getState().startSignIn();
    await useAuthStore.getState().cancelSignIn();
    await useAuthStore.getState().reopenSignIn();
    await useAuthStore.getState().signOut();
    expect(authMock.startSignIn).toHaveBeenCalled();
    expect(authMock.cancelSignIn).toHaveBeenCalled();
    expect(authMock.reopenSignIn).toHaveBeenCalled();
    expect(authMock.signOut).toHaveBeenCalled();
  });

  it('browser mode (no electron bridge) stays uninitialized and toasts on startSignIn', async () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
    expect(hasDesktopAuthBridge()).toBe(false);
    useAuthStore.getState().init();
    expect(useAuthStore.getState().initialized).toBe(false);
    await expect(useAuthStore.getState().startSignIn()).resolves.toBeUndefined();
    expectToastCall(addToast, 'Sign-in is unavailable in this environment.', 'error');
  });

  it('identifies a real desktop auth bridge before session hydration completes', () => {
    expect(hasDesktopAuthBridge()).toBe(true);
  });

  it('startSignIn pulls authoritative state after the IPC round-trip', async () => {
    useAuthStore.getState().init();
    await flush();
    authMock.getState.mockResolvedValueOnce({ status: 'choosing' } as DesktopAuthState);
    await useAuthStore.getState().startSignIn();
    expect(authMock.startSignIn).toHaveBeenCalled();
    expect(useAuthStore.getState().state.status).toBe('choosing');
  });
});
