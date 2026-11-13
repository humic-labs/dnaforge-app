import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ dir: '', available: true, failDecrypt: false }));

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    encryptString: (s: string) => Buffer.from('enc::' + s, 'utf8'),
    decryptString: (b: Buffer) => {
      if (h.failDecrypt) throw new Error('keychain reset');
      const s = b.toString('utf8');
      if (!s.startsWith('enc::')) throw new Error('corrupt');
      return s.slice(5);
    },
  },
}));
const captureMessage = vi.fn();
vi.mock('../../sentry', () => ({
  reportOperationalFailure: (...a: unknown[]) => captureMessage(...a),
}));

import {
  saveSession,
  getActiveStoredSession,
  getActivePublicSession,
  updateSessionTokens,
  removeSession,
  setActiveAccount,
  listPublicSessions,
  type StoredSession,
} from '../session-store';

function makeSession(id: string): StoredSession {
  return {
    accountId: id,
    desktopSessionId: `sess-${id}`,
    accessToken: `at-${id}`,
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    refreshToken: `rt-${id}`,
    email: `${id}@x.com`,
    displayName: `User ${id}`,
    channel: 'stable',
    updatedAt: 1,
  };
}

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'fixture-sess-'));
  h.available = true;
  h.failDecrypt = false;
  captureMessage.mockClear();
});

describe('session-store', () => {
  it('saves and reads back the active session', async () => {
    await saveSession(makeSession('a'));
    const s = await getActiveStoredSession();
    expect(s?.accountId).toBe('a');
    expect(s?.refreshToken).toBe('rt-a');
  });

  it('exposes only a sanitized public session (no tokens)', async () => {
    await saveSession(makeSession('a'));
    const pub = await getActivePublicSession();
    expect(pub?.accountId).toBe('a');
    expect(pub?.email).toBe('a@x.com');
    const fields: Record<string, unknown> = { ...pub };
    expect(fields.accessToken).toBeUndefined();
    expect(fields.refreshToken).toBeUndefined();
  });

  it('refuses to save when encryption is unavailable', async () => {
    h.available = false;
    await expect(saveSession(makeSession('a'))).rejects.toThrow(/ENCRYPTION_UNAVAILABLE/);
  });

  it('preserves the encrypted session when Keychain access is unavailable', async () => {
    await saveSession(makeSession('a'));
    const path = join(h.dir, 'auth', 'sessions.json');
    const original = readFileSync(path);
    h.failDecrypt = true;
    expect(await getActiveStoredSession()).toBeNull();
    expect(readFileSync(path)).toEqual(original);
    expect(captureMessage).toHaveBeenCalledWith(
      'auth.session_decryption_unavailable',
      expect.anything()
    );
    h.failDecrypt = false;
    expect((await getActiveStoredSession())?.accountId).toBe('a');
  });

  it('rotates tokens via updateSessionTokens', async () => {
    await saveSession(makeSession('a'));
    await updateSessionTokens('a', {
      accessToken: 'at-new',
      accessTokenExpiresAt: '2031-01-01T00:00:00.000Z',
      refreshToken: 'rt-new',
    });
    const s = await getActiveStoredSession();
    expect(s?.accessToken).toBe('at-new');
    expect(s?.refreshToken).toBe('rt-new');
  });

  it('active account is explicit, not MRU: a non-active save does not steal active', async () => {
    await saveSession(makeSession('a'), true);
    await saveSession(makeSession('b'), false);
    expect((await getActiveStoredSession())?.accountId).toBe('a');
    await setActiveAccount('b');
    expect((await getActiveStoredSession())?.accountId).toBe('b');
    expect(await listPublicSessions()).toHaveLength(2);
  });

  it('removing the active account repoints active to a remaining one', async () => {
    await saveSession(makeSession('a'), true);
    await saveSession(makeSession('b'), false);
    await removeSession('a');
    expect((await getActiveStoredSession())?.accountId).toBe('b');
  });
});
