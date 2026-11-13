import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  dir: '',
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  isEncryptionAvailable: vi.fn(() => {
    throw new Error('safeStorage must not be touched');
  }),
  encryptString: vi.fn(() => {
    throw new Error('safeStorage must not be touched');
  }),
  decryptString: vi.fn(() => {
    throw new Error('safeStorage must not be touched');
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: h.mkdir,
    readFile: h.readFile,
    writeFile: h.writeFile,
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  safeStorage: {
    isEncryptionAvailable: h.isEncryptionAvailable,
    encryptString: h.encryptString,
    decryptString: h.decryptString,
  },
}));
vi.mock('../../sentry', () => ({ reportOperationalFailure: vi.fn() }));

import {
  clearAllSessions,
  configureQualificationEphemeralAuth,
  getActiveStoredSession,
  isEncryptionAvailable,
  listPublicSessions,
  removeSession,
  saveSession,
  updateSessionTokens,
  type StoredSession,
} from '../session-store';

const SOURCE = 'a'.repeat(40);

function session(accountId: string): StoredSession {
  return {
    accountId,
    desktopSessionId: `desktop-${accountId}`,
    accessToken: `access-${accountId}`,
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    refreshToken: `refresh-${accountId}`,
    email: `${accountId}@example.test`,
    channel: 'qualification',
    updatedAt: 1,
  };
}

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'fixture-ephemeral-auth-'));
  h.isEncryptionAvailable.mockClear();
  h.encryptString.mockClear();
  h.decryptString.mockClear();
  h.mkdir.mockClear();
  h.readFile.mockClear();
  h.writeFile.mockClear();
});

describe('qualification ephemeral auth session store', () => {
  it('keeps sign-in and token rotation only in process memory with zero safeStorage or file access', async () => {
    expect(() => configureQualificationEphemeralAuth('a'.repeat(39))).toThrow(
      /full lowercase Git SHA/u
    );
    configureQualificationEphemeralAuth(SOURCE);
    expect(() => configureQualificationEphemeralAuth('b'.repeat(40))).toThrow(
      /cannot change source/u
    );

    expect(isEncryptionAvailable()).toBe(true);
    await saveSession(session('one'));
    await saveSession(session('two'), false);
    await updateSessionTokens('one', {
      accessToken: 'access-rotated',
      accessTokenExpiresAt: '2031-01-01T00:00:00.000Z',
      refreshToken: 'refresh-rotated',
    });

    expect(await getActiveStoredSession()).toMatchObject({
      accountId: 'one',
      accessToken: 'access-rotated',
      refreshToken: 'refresh-rotated',
    });
    expect(await listPublicSessions()).toHaveLength(2);
    await removeSession('one');
    expect((await getActiveStoredSession())?.accountId).toBe('two');
    await clearAllSessions();
    expect(await getActiveStoredSession()).toBeNull();

    expect(h.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(h.encryptString).not.toHaveBeenCalled();
    expect(h.decryptString).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(existsSync(join(h.dir, 'auth', 'sessions.json'))).toBe(false);
  });
});
