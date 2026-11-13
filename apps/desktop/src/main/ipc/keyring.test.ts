import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  dir: '',
  available: true,
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from('enc::' + s, 'utf8')),
  decryptString: vi.fn((b: Buffer) => {
    const s = b.toString('utf8');
    if (!s.startsWith('enc::')) throw new Error('corrupt ciphertext');
    return s.slice(5);
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: (...a: unknown[]) => h.isEncryptionAvailable(...(a as [])),
    encryptString: (...a: unknown[]) => h.encryptString(...(a as [string])),
    decryptString: (...a: unknown[]) => h.decryptString(...(a as [Buffer])),
  },
}));

import {
  configureSharedCredentialStorage,
  hasCredential,
  readCredential,
  writeCredential,
  deleteCredential,
} from './keyring';
import { KEYRING_SERVICE, LEGACY_KEYRING_SERVICE } from '../../shared/keyring-service';

const NAME = 'anthropic_api_key';
const credDir = () => join(h.dir, 'credentials');
const newPath = (name = NAME) => join(credDir(), `${KEYRING_SERVICE}-${name}.enc`);
const legacyPath = (name = NAME) => join(credDir(), `${LEGACY_KEYRING_SERVICE}-${name}.enc`);

async function seedRaw(path: string, contents: string): Promise<void> {
  await mkdir(credDir(), { recursive: true });
  await writeFile(path, Buffer.from(contents, 'utf8'));
}

function expectNoSafeStorage(): void {
  expect(h.isEncryptionAvailable).not.toHaveBeenCalled();
  expect(h.encryptString).not.toHaveBeenCalled();
  expect(h.decryptString).not.toHaveBeenCalled();
}

beforeEach(() => {
  configureSharedCredentialStorage(null);
  h.dir = mkdtempSync(join(tmpdir(), 'fixture-keyring-'));
  h.available = true;
  h.isEncryptionAvailable.mockClear().mockImplementation(() => h.available);
  h.encryptString.mockClear();
  h.decryptString.mockClear();
});

describe('keyring — shared connections across ordinary development profiles', () => {
  it('shares a saved connection across branch profiles without decrypting presence', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'fixture-shared-keys-'));
    configureSharedCredentialStorage(shared);
    await writeCredential(KEYRING_SERVICE, 'nvidia-nim_compute_key', 'technical-connection-one');
    h.dir = mkdtempSync(join(tmpdir(), 'fixture-another-branch-'));
    h.isEncryptionAvailable.mockClear();
    h.encryptString.mockClear();
    h.decryptString.mockClear();
    expect(await hasCredential(KEYRING_SERVICE, 'nvidia-nim_compute_key')).toBe(true);
    expectNoSafeStorage();
    expect(await readCredential(KEYRING_SERVICE, 'nvidia-nim_compute_key')).toBe(
      'technical-connection-one'
    );
  });

  it('promotes a successfully decrypted legacy profile key and retains its original file', async () => {
    const original = newPath();
    await seedRaw(original, 'enc::technical-legacy-connection');
    const shared = mkdtempSync(join(tmpdir(), 'fixture-shared-keys-'));
    configureSharedCredentialStorage(shared);
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('technical-legacy-connection');
    expect(await readFile(original, 'utf8')).toBe('enc::technical-legacy-connection');
    h.dir = mkdtempSync(join(tmpdir(), 'fixture-another-branch-'));
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('technical-legacy-connection');
  });

  it('gives the shared replacement authority over an older per-profile key', async () => {
    await seedRaw(newPath(), 'enc::technical-old-connection');
    configureSharedCredentialStorage(mkdtempSync(join(tmpdir(), 'fixture-shared-keys-')));
    await writeCredential(KEYRING_SERVICE, NAME, 'technical-replaced-connection');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('technical-replaced-connection');
  });

  it('keeps disconnection authoritative when an older branch still has a local key', async () => {
    const original = newPath();
    await seedRaw(original, 'enc::technical-old-connection');
    configureSharedCredentialStorage(mkdtempSync(join(tmpdir(), 'fixture-shared-keys-')));
    await writeCredential(KEYRING_SERVICE, NAME, 'technical-current-connection');
    await deleteCredential(KEYRING_SERVICE, NAME);
    h.isEncryptionAvailable.mockClear();
    h.encryptString.mockClear();
    h.decryptString.mockClear();
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(false);
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBeNull();
    expectNoSafeStorage();
    expect(await readFile(original, 'utf8')).toBe('enc::technical-old-connection');
    h.dir = mkdtempSync(join(tmpdir(), 'fixture-another-branch-'));
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(false);
    await writeCredential(KEYRING_SERVICE, NAME, 'technical-reconnected');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('technical-reconnected');
  });

  it('keeps explicit disposable credential storage isolated from the shared owner', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'fixture-shared-keys-'));
    configureSharedCredentialStorage(shared);
    await writeCredential(KEYRING_SERVICE, NAME, 'technical-shared-connection');
    configureSharedCredentialStorage(null);
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(false);
    await writeCredential(KEYRING_SERVICE, NAME, 'technical-isolated-connection');
    await deleteCredential(KEYRING_SERVICE, NAME);
    configureSharedCredentialStorage(shared);
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('technical-shared-connection');
  });
});

describe('keyring — Part C: presence probe never touches safeStorage', () => {
  it('hasCredential on a missing key → false, ZERO safeStorage calls', async () => {
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(false);
    expectNoSafeStorage();
  });

  it('hasCredential with a canonical file present → true, ZERO safeStorage calls', async () => {
    await seedRaw(newPath(), 'enc::sk-present');
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(true);
    expectNoSafeStorage();
  });

  it('readCredential on a missing key → null BEFORE any safeStorage call', async () => {
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBeNull();
    expectNoSafeStorage();
  });

  it('a missing key is null even when encryption is unavailable (no throw, no prompt)', async () => {
    h.available = false;
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBeNull();
    expectNoSafeStorage();
  });
});

describe('keyring — Part B: dual-read of legacy waypoint-*', () => {
  it('hasCredential finds a legacy file when no canonical exists', async () => {
    await seedRaw(legacyPath(), 'enc::sk-legacy');
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(true);
    expectNoSafeStorage();
  });

  it('readCredential falls back to the legacy file and decrypts it', async () => {
    await seedRaw(legacyPath(), 'enc::sk-legacy');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('sk-legacy');
  });

  it('both files present → canonical value wins (read order is new-first)', async () => {
    await seedRaw(legacyPath(), 'enc::sk-OLD');
    await seedRaw(newPath(), 'enc::sk-NEW');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('sk-NEW');
  });

  it('corrupt canonical + valid legacy → falls back to legacy (F2, never strands)', async () => {
    await seedRaw(newPath(), 'GARBAGE-not-enc');
    await seedRaw(legacyPath(), 'enc::sk-legacy-good');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('sk-legacy-good');
  });

  it('both canonical AND legacy corrupt → null (never returns garbage)', async () => {
    await seedRaw(newPath(), 'GARBAGE-new');
    await seedRaw(legacyPath(), 'GARBAGE-legacy');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBeNull();
  });
});

describe('keyring — write/delete', () => {
  it('writeCredential encrypts to the canonical name (atomic, no .tmp left)', async () => {
    await writeCredential(KEYRING_SERVICE, NAME, 'sk-new');
    expect(h.encryptString).toHaveBeenCalledWith('sk-new');
    expect(await readFile(newPath(), 'utf8')).toBe('enc::sk-new');
    const files = await readdir(credDir());
    expect(files).not.toContain(`${KEYRING_SERVICE}-${NAME}.enc.tmp`);
  });

  it('writeCredential migrates-on-save: removes the legacy file', async () => {
    await seedRaw(legacyPath(), 'enc::sk-legacy');
    await writeCredential(KEYRING_SERVICE, NAME, 'sk-new');
    const files = await readdir(credDir());
    expect(files).toContain(`${KEYRING_SERVICE}-${NAME}.enc`);
    expect(files).not.toContain(`${LEGACY_KEYRING_SERVICE}-${NAME}.enc`);
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('sk-new');
  });

  it('deleteCredential removes BOTH canonical and legacy files (F3)', async () => {
    await seedRaw(newPath(), 'enc::sk-new');
    await seedRaw(legacyPath(), 'enc::sk-legacy');
    await deleteCredential(KEYRING_SERVICE, NAME);
    expect(await hasCredential(KEYRING_SERVICE, NAME)).toBe(false);
    const files = await readdir(credDir());
    expect(files).not.toContain(`${KEYRING_SERVICE}-${NAME}.enc`);
    expect(files).not.toContain(`${LEGACY_KEYRING_SERVICE}-${NAME}.enc`);
  });

  it('write → read round-trips a stored credential', async () => {
    await writeCredential(KEYRING_SERVICE, NAME, 'sk-roundtrip');
    expect(await readCredential(KEYRING_SERVICE, NAME)).toBe('sk-roundtrip');
  });
});

describe('keyring — validation (F9 path-traversal gate)', () => {
  it('hasCredential rejects a traversal name', async () => {
    await expect(hasCredential(KEYRING_SERVICE, '../evil')).rejects.toThrow(
      'Invalid credential service or name'
    );
  });
  it('readCredential rejects a traversal service', async () => {
    await expect(readCredential('../evil', NAME)).rejects.toThrow(
      'Invalid credential service or name'
    );
  });
  it('writeCredential rejects a traversal name', async () => {
    await expect(writeCredential(KEYRING_SERVICE, 'a/b', 'x')).rejects.toThrow(
      'Invalid credential service or name'
    );
  });
});

describe('keyring — encryption-unavailable on a real read', () => {
  it('throws "Encryption not available" when a file exists but safeStorage is down', async () => {
    await seedRaw(newPath(), 'enc::sk-present');
    h.available = false;
    await expect(readCredential(KEYRING_SERVICE, NAME)).rejects.toThrow('Encryption not available');
  });
});
