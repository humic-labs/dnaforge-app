// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  directory: '',
  encryptionAvailable: vi.fn(() => {
    throw new Error('Keychain is locked');
  }),
  encrypt: vi.fn(() => {
    throw new Error('Must not encrypt metadata');
  }),
  decrypt: vi.fn(() => {
    throw new Error('Must not decrypt metadata');
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => native.directory },
  safeStorage: {
    isEncryptionAvailable: native.encryptionAvailable,
    encryptString: native.encrypt,
    decryptString: native.decrypt,
  },
}));
vi.mock('../../sentry', () => ({ reportOperationalFailure: vi.fn() }));
import { clearAllSessions, getSelectedAccountContext, setActiveAccount } from '../session-store';

function path() {
  return join(native.directory, 'auth', 'sessions.json');
}
async function metadata(value: unknown) {
  await mkdir(join(native.directory, 'auth'), { recursive: true });
  await writeFile(path(), JSON.stringify(value));
}
beforeEach(async () => {
  vi.clearAllMocks();
  native.directory = await mkdtemp(join(tmpdir(), 'fixture-account-context-'));
});
afterEach(async () => {
  await rm(native.directory, { recursive: true, force: true });
});

describe('token-free native selected-account context', () => {
  it('distinguishes a valid signed-out state and does not select an inactive saved account', async () => {
    expect(await getSelectedAccountContext()).toEqual({ kind: 'signed-out' });
    await metadata({
      schemaVersion: 1,
      activeAccountId: null,
      sessions: { a: 'opaque-encrypted-session' },
    });
    expect(await getSelectedAccountContext()).toEqual({ kind: 'signed-out' });
  });
  it('follows canonical account switching and sign-out while the keychain stays locked', async () => {
    await metadata({
      schemaVersion: 1,
      activeAccountId: 'a',
      sessions: { a: 'opaque-a', b: 'opaque-b' },
    });
    expect(await getSelectedAccountContext()).toEqual({ kind: 'account', accountId: 'a' });
    await setActiveAccount('b');
    expect(await getSelectedAccountContext()).toEqual({ kind: 'account', accountId: 'b' });
    await clearAllSessions();
    expect(await getSelectedAccountContext()).toEqual({ kind: 'signed-out' });
    expect(native.encryptionAvailable).not.toHaveBeenCalled();
    expect(native.encrypt).not.toHaveBeenCalled();
    expect(native.decrypt).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { schemaVersion: 2, activeAccountId: null, sessions: {} },
    { schemaVersion: 1, activeAccountId: 'missing', sessions: { a: 'opaque' } },
    { schemaVersion: 1, activeAccountId: null, sessions: [] },
    { schemaVersion: 1, activeAccountId: 42, sessions: {} },
    { schemaVersion: 1, activeAccountId: null, sessions: { a: {} } },
    { schemaVersion: 1, sessions: {} },
  ])('reports malformed metadata without falling back to signed-out grants: %j', async (value) => {
    await metadata(value);
    const before = await readFile(path(), 'utf8');
    expect(await getSelectedAccountContext()).toEqual({ kind: 'unavailable', reason: 'malformed' });
    expect(await readFile(path(), 'utf8')).toBe(before);
    expect(native.decrypt).not.toHaveBeenCalled();
  });
  it('distinguishes unreadable and invalid JSON metadata from a missing profile', async () => {
    await mkdir(path(), { recursive: true });
    expect(await getSelectedAccountContext()).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
    await rm(path(), { recursive: true });
    await writeFile(path(), 'invalid-json');
    expect(await getSelectedAccountContext()).toEqual({ kind: 'unavailable', reason: 'malformed' });
    expect(native.decrypt).not.toHaveBeenCalled();
  });
});
