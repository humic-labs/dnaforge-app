// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGoogleSheetsCredentialStore,
  GOOGLE_SHEETS_READ_SCOPE,
  type GoogleSheetsGrant,
} from './credential-store';

let directory: string;
const key = randomBytes(32);
const available = vi.fn(() => true);
const encrypt = vi.fn((text: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
});
const decrypt = vi.fn((bytes: Buffer) => {
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
});
const grant: GoogleSheetsGrant = {
  owner: { kind: 'device' },
  materialVersion: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
  account: {
    id: '05a1d6e7-3d6a-4a59-81ec-8629f742a751',
    subject: 'google-subject',
    email: 'synthetic@example.test',
  },
  clientId: 'native-client.apps.googleusercontent.com',
  accessToken: 'synthetic-access-token',
  refreshToken: 'synthetic-refresh-token',
  expiresAt: 2000000000000,
  scopes: [GOOGLE_SHEETS_READ_SCOPE],
};
function store() {
  return createGoogleSheetsCredentialStore({ directory, cipher: { available, encrypt, decrypt } });
}
beforeEach(async () => {
  vi.clearAllMocks();
  available.mockReturnValue(true);
  directory = await mkdtemp(join(tmpdir(), 'fixture-google-store-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('private Google provider credential files', () => {
  it('probes an absent connection without touching secure storage', async () => {
    expect(await store().read(grant.account.id)).toBeNull();
    expect(await store().list()).toEqual({ accounts: [], unreadableAccounts: 0 });
    expect(available).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
  it('round-trips encrypted material and lists only account metadata without decryption', async () => {
    await store().save(grant);
    const serialized = await readFile(join(directory, `${grant.account.id}.json`), 'utf8');
    expect(serialized).not.toContain(grant.accessToken);
    expect(serialized).not.toContain(grant.refreshToken);
    expect(await store().list()).toEqual({
      accounts: [
        { kind: 'connected', owner: grant.owner, account: grant.account, clientId: grant.clientId },
      ],
      unreadableAccounts: 0,
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(await store().read(grant.account.id)).toEqual(grant);
    expect(await readdir(directory)).toEqual([`${grant.account.id}.json`]);
  });
  it('refuses plaintext persistence when secure storage is unavailable', async () => {
    available.mockReturnValue(false);
    await expect(store().save(grant)).rejects.toThrow('Secure storage is unavailable');
    expect(encrypt).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects header identity substitution instead of decrypting another account as the selected one', async () => {
    await store().save(grant);
    const destination = join(directory, `${grant.account.id}.json`);
    const parsed: unknown = JSON.parse(await readFile(destination, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('Missing envelope');
    await writeFile(
      destination,
      JSON.stringify({ ...parsed, account: { ...grant.account, subject: 'foreign-subject' } })
    );
    await expect(store().read(grant.account.id)).rejects.toThrow('cannot be decrypted');
  });
  it('removes token material on reauthorization requirement while retaining explicit account status', async () => {
    await store().save(grant);
    await store().requireReconnect(grant.account.id);
    expect(await store().read(grant.account.id)).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    expect(await store().list()).toEqual({
      accounts: [
        {
          kind: 'reconnect-required',
          owner: grant.owner,
          account: grant.account,
          clientId: grant.clientId,
        },
      ],
      unreadableAccounts: 0,
    });
    expect(await readFile(join(directory, `${grant.account.id}.json`), 'utf8')).not.toContain(
      'ciphertext'
    );
  });
  it('forgets exactly the selected connection and reports a corrupt peer without blocking healthy accounts', async () => {
    await store().save(grant);
    const peerId = 'd788e456-ebdf-4672-818c-d5e6a1ff99b4';
    await writeFile(join(directory, `${peerId}.json`), '{broken');
    expect((await store().list()).unreadableAccounts).toBe(1);
    await store().forget(grant.account.id);
    expect(await store().read(grant.account.id)).toBeNull();
    expect(await readdir(directory)).toEqual([`${peerId}.json`]);
    await expect(store().forget('../foreign')).rejects.toThrow();
  });
});
