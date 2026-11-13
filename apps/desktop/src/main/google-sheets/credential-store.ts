import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { googleSheetsAccountSchema } from '../../shared/google-sheets';

export const GOOGLE_SHEETS_READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const googleSheetsOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accountId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('device') }).strict(),
]);
export type GoogleSheetsOwner = z.infer<typeof googleSheetsOwnerSchema>;
export const googleSheetsGrantSchema = z
  .object({
    owner: googleSheetsOwnerSchema,
    materialVersion: z.string().uuid(),
    account: googleSheetsAccountSchema,
    clientId: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().finite().positive(),
    scopes: z.array(z.string()).refine((scopes) => scopes.includes(GOOGLE_SHEETS_READ_SCOPE)),
  })
  .strict();
export type GoogleSheetsGrant = z.infer<typeof googleSheetsGrantSchema>;

const header = z.object({
  schemaVersion: z.literal(1),
  owner: googleSheetsOwnerSchema,
  account: googleSheetsAccountSchema,
  clientId: z.string().min(1),
});
const envelopeSchema = z.discriminatedUnion('kind', [
  header.extend({ kind: z.literal('connected'), ciphertext: z.string().min(1) }).strict(),
  header.extend({ kind: z.literal('reconnect-required') }).strict(),
]);
export type GoogleSheetsStoredAccount = Pick<
  z.infer<typeof envelopeSchema>,
  'kind' | 'owner' | 'account' | 'clientId'
>;

export interface GoogleSheetsCipher {
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}
export class GoogleSheetsCredentialError extends Error {
  constructor(
    public readonly reason: 'unavailable' | 'unreadable',
    message: string
  ) {
    super(message);
    this.name = 'GoogleSheetsCredentialError';
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function createGoogleSheetsCredentialStore(input: {
  directory: string;
  cipher: GoogleSheetsCipher;
}) {
  function path(id: string): string {
    return join(input.directory, `${z.string().uuid().parse(id)}.json`);
  }
  async function envelope(id: string) {
    let serialized: string;
    try {
      serialized = await readFile(path(id), 'utf8');
    } catch (error) {
      if (missing(error)) return null;
      throw new GoogleSheetsCredentialError(
        'unreadable',
        'The saved Google connection could not be read.'
      );
    }
    try {
      if (serialized.length > 1048576) throw new Error('Oversized credential envelope');
      const parsed = envelopeSchema.parse(JSON.parse(serialized));
      if (parsed.account.id !== id) throw new Error('Wrong credential identity');
      return parsed;
    } catch {
      throw new GoogleSheetsCredentialError(
        'unreadable',
        'The saved Google connection is unreadable. Reconnect this account.'
      );
    }
  }
  async function write(id: string, value: z.infer<typeof envelopeSchema>): Promise<void> {
    const destination = path(id);
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const temporary = join(input.directory, `${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async function list(): Promise<{
    accounts: GoogleSheetsStoredAccount[];
    unreadableAccounts: number;
  }> {
    let names: string[];
    try {
      names = await readdir(input.directory);
    } catch (error) {
      if (missing(error)) return { accounts: [], unreadableAccounts: 0 };
      throw error;
    }
    const accounts: GoogleSheetsStoredAccount[] = [];
    let unreadableAccounts = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = z.string().uuid().safeParse(name.slice(0, -5));
      if (!id.success) continue;
      try {
        const value = await envelope(id.data);
        if (value)
          accounts.push({
            owner: value.owner,
            account: value.account,
            kind: value.kind,
            clientId: value.clientId,
          });
      } catch {
        unreadableAccounts += 1;
      }
    }
    return { accounts, unreadableAccounts };
  }

  async function read(id: string): Promise<GoogleSheetsGrant | null> {
    const value = await envelope(id);
    if (!value || value.kind === 'reconnect-required') return null;
    if (!input.cipher.available())
      throw new GoogleSheetsCredentialError(
        'unavailable',
        'Secure storage is unavailable for this Google connection.'
      );
    try {
      const grant = googleSheetsGrantSchema.parse(
        JSON.parse(input.cipher.decrypt(Buffer.from(value.ciphertext, 'base64')))
      );
      if (
        JSON.stringify(grant.owner) !== JSON.stringify(value.owner) ||
        JSON.stringify(grant.account) !== JSON.stringify(value.account) ||
        grant.clientId !== value.clientId
      )
        throw new Error('Wrong credential identity');
      return grant;
    } catch {
      throw new GoogleSheetsCredentialError(
        'unreadable',
        'The saved Google connection cannot be decrypted. Reconnect this account.'
      );
    }
  }
  async function save(value: GoogleSheetsGrant): Promise<void> {
    const grant = googleSheetsGrantSchema.parse(value);
    if (!input.cipher.available())
      throw new GoogleSheetsCredentialError(
        'unavailable',
        'Secure storage is unavailable. Google access was not saved.'
      );
    await write(grant.account.id, {
      schemaVersion: 1,
      kind: 'connected',
      owner: grant.owner,
      account: grant.account,
      clientId: grant.clientId,
      ciphertext: input.cipher.encrypt(JSON.stringify(grant)).toString('base64'),
    });
  }
  async function requireReconnect(id: string): Promise<void> {
    const value = await envelope(id);
    if (!value) return;
    await write(id, {
      schemaVersion: 1,
      kind: 'reconnect-required',
      owner: value.owner,
      account: value.account,
      clientId: value.clientId,
    });
  }
  async function forget(id: string): Promise<void> {
    try {
      await unlink(path(id));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  async function metadata(id: string): Promise<GoogleSheetsStoredAccount | null> {
    const value = await envelope(id);
    return value
      ? { owner: value.owner, account: value.account, kind: value.kind, clientId: value.clientId }
      : null;
  }
  return { list, metadata, read, save, requireReconnect, forget };
}
export type GoogleSheetsCredentialStore = ReturnType<typeof createGoogleSheetsCredentialStore>;
