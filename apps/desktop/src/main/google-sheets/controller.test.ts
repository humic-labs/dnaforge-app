// @vitest-environment node
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleSheetsReader } from './api';
import { createGoogleSheetsController, type GoogleSheetsController } from './controller';
import {
  createGoogleSheetsCredentialStore,
  GOOGLE_SHEETS_READ_SCOPE,
  type GoogleSheetsGrant,
} from './credential-store';
import { createGoogleSheetsOAuth } from './oauth';
import { getGoogleSheetsOwner } from './native-owner';

const native = vi.hoisted(() => ({
  directory: '',
  decrypt: vi.fn(() => {
    throw new Error('Native keychain is locked');
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => native.directory },
  safeStorage: {
    isEncryptionAvailable: native.decrypt,
    decryptString: native.decrypt,
    encryptString: native.decrypt,
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));

let server: Server;
let origin: string;
let controller: GoogleSheetsController;
let authorization: URL | null;
let callbackAutomatically: boolean;
let refreshCount: number;
let resourceStatus: number;
let revoked: boolean;
let refreshGate: Promise<void> | null;
let completeRefresh: () => void;
let ignoreRefreshAbort: boolean;
let failForget: boolean;
const config = { clientId: 'synthetic-native.apps.googleusercontent.com' };
const key = randomBytes(32);
const decrypt = vi.fn((bytes: Buffer) => {
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
});
function store() {
  return createGoogleSheetsCredentialStore({
    directory: join(native.directory, 'integrations', 'google-sheets'),
    cipher: {
      available: () => true,
      encrypt: (text) => {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv);
        return Buffer.concat([
          iv,
          cipher.update(text, 'utf8'),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
      },
      decrypt,
    },
  });
}
async function select(accountId: string | null) {
  await mkdir(join(native.directory, 'auth'), { recursive: true });
  await writeFile(
    join(native.directory, 'auth', 'sessions.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeAccountId: accountId,
      sessions: { a: 'opaque-a', b: 'opaque-b' },
    })
  );
}
async function seed(expired = false) {
  const grant: GoogleSheetsGrant = {
    owner: { kind: 'account', accountId: 'a' },
    materialVersion: randomUUID(),
    account: { id: randomUUID(), subject: 'google-subject', email: 'synthetic@example.test' },
    clientId: config.clientId,
    accessToken: 'old-access',
    refreshToken: 'existing-refresh',
    expiresAt: Date.now() + (expired ? -1000 : 3600000),
    scopes: [GOOGLE_SHEETS_READ_SCOPE],
  };
  await store().save(grant);
  return grant;
}
const cell = (value: string) => ({ formattedValue: value, effectiveValue: { stringValue: value } });
beforeEach(async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'fixture-google-controller-'));
  native.decrypt.mockClear();
  decrypt.mockClear();
  await select('a');
  authorization = null;
  callbackAutomatically = true;
  refreshCount = 0;
  resourceStatus = 200;
  revoked = false;
  refreshGate = null;
  ignoreRefreshAbort = false;
  failForget = false;
  completeRefresh = () => {};
  server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const body = new URLSearchParams(text),
      url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/token') {
      if (body.get('grant_type') === 'refresh_token') {
        refreshCount += 1;
        await refreshGate;
        response.statusCode = revoked ? 400 : 200;
        response.end(
          JSON.stringify(
            revoked
              ? { error: 'invalid_grant' }
              : { access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' }
          )
        );
      } else {
        const challenge = createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url');
        const valid =
          authorization &&
          body.get('code') === 'issued-code' &&
          challenge === authorization.searchParams.get('code_challenge') &&
          body.get('redirect_uri') === authorization.searchParams.get('redirect_uri');
        response.statusCode = valid ? 200 : 400;
        response.end(
          JSON.stringify(
            valid
              ? {
                  access_token: 'fresh-access',
                  refresh_token: 'fresh-refresh',
                  expires_in: 3600,
                  token_type: 'Bearer',
                  scope: `openid email ${GOOGLE_SHEETS_READ_SCOPE}`,
                }
              : { error: 'invalid_grant' }
          )
        );
      }
    } else if (url.pathname === '/v1/userinfo')
      response.end(
        JSON.stringify({
          sub: 'google-subject',
          email: 'synthetic@example.test',
          email_verified: true,
        })
      );
    else {
      response.statusCode = resourceStatus;
      response.end(
        JSON.stringify(
          resourceStatus === 200
            ? {
                spreadsheetId: 'source-id',
                properties: { title: 'Workbook' },
                sheets: [
                  {
                    properties: { sheetId: 17, title: 'Primers' },
                    ...(url.searchParams.has('ranges')
                      ? {
                          data: [
                            {
                              rowData: [
                                { values: [cell('Stable ID'), cell('Name')] },
                                { values: [cell('001'), cell('First')] },
                              ],
                            },
                          ],
                        }
                      : {}),
                  },
                ],
              }
            : { error: 'resource access denied' }
        )
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  origin = `http://127.0.0.1:${address.port}`;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect([
      'https://oauth2.googleapis.com',
      'https://openidconnect.googleapis.com',
      'https://sheets.googleapis.com',
    ]).toContain(url.origin);
    return fetch(
      new URL(url.pathname + url.search, origin),
      ignoreRefreshAbort && url.pathname === '/token' ? { ...init, signal: undefined } : init
    );
  };
  controller = createGoogleSheetsController({
    oauth: createGoogleSheetsOAuth({ config, fetch: transport }),
    reader: createGoogleSheetsReader({ fetch: transport }),
    store: {
      ...store(),
      forget: async (id) => {
        if (failForget) throw new Error('Private file is not writable');
        await store().forget(id);
      },
    },
    owner: getGoogleSheetsOwner,
    openExternal: async (value) => {
      authorization = new URL(value);
      if (callbackAutomatically) {
        const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
        callback.search = new URLSearchParams({
          state: authorization.searchParams.get('state') ?? '',
          code: 'issued-code',
        }).toString();
        await fetch(callback);
      }
    },
  });
});
afterEach(async () => {
  completeRefresh();
  await controller.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(native.directory, { recursive: true, force: true });
});

describe('Google grant lifecycle through native account metadata, sockets and files', () => {
  it('connects via real PKCE callback/exchange and returns no credentials in public status', async () => {
    await controller.start(10);
    await vi.waitFor(async () =>
      expect((await controller.status()).connection.kind).toBe('connected')
    );
    const status = await controller.status();
    expect(status.accounts).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain('fresh-access');
    expect(JSON.stringify(status)).not.toContain('fresh-refresh');
    expect((await store().read(status.accounts[0].account.id))?.owner).toEqual({
      kind: 'account',
      accountId: 'a',
    });
    expect(native.decrypt).not.toHaveBeenCalled();
  });
  it('does not expose or decrypt another selected account or device grant', async () => {
    const grant = await seed();
    await select('b');
    const other = await controller.status();
    expect(other.accounts).toEqual([]);
    await expect(
      controller.worksheet({ grantId: grant.account.id, spreadsheetId: 'source-id', sheetId: 17 })
    ).rejects.toMatchObject({ reason: 'reconnect-required' });
    expect(decrypt).not.toHaveBeenCalled();
    await select(null);
    expect((await controller.status()).accounts).toEqual([]);
    expect((await controller.status()).ownerKey).not.toBe(other.ownerKey);
  });
  it('fails closed on malformed account metadata instead of reading a signed-out grant', async () => {
    const grant = await seed();
    await store().save({ ...grant, owner: { kind: 'device' } });
    await writeFile(join(native.directory, 'auth', 'sessions.json'), '{broken');
    await expect(controller.status()).rejects.toMatchObject({
      reason: 'account-context-unavailable',
    });
    await expect(
      controller.worksheet({ grantId: grant.account.id, spreadsheetId: 'source-id', sheetId: 17 })
    ).rejects.toMatchObject({ reason: 'account-context-unavailable' });
    expect(decrypt).not.toHaveBeenCalled();
  });
  it('coalesces expired-token refresh across concurrent reads and retains a missing rotated refresh token', async () => {
    const grant = await seed(true);
    const request = { grantId: grant.account.id, spreadsheetId: 'source-id', sheetId: 17 };
    await Promise.all([controller.worksheet(request), controller.worksheet(request)]);
    expect(refreshCount).toBe(1);
    expect((await store().read(grant.account.id))?.refreshToken).toBe('existing-refresh');
  });
  it('retains credentials on a sheet permission error and requires reconnect only for a revoked refresh grant', async () => {
    const grant = await seed();
    resourceStatus = 403;
    await expect(
      controller.worksheet({ grantId: grant.account.id, spreadsheetId: 'source-id', sheetId: 17 })
    ).rejects.toMatchObject({ status: 403 });
    expect((await store().list()).accounts[0].kind).toBe('connected');
    await store().save({ ...grant, expiresAt: Date.now() - 1 });
    revoked = true;
    await expect(
      controller.worksheet({ grantId: grant.account.id, spreadsheetId: 'source-id', sheetId: 17 })
    ).rejects.toMatchObject({ reason: 'reconnect-required' });
    expect(await store().read(grant.account.id)).toBeNull();
    expect((await store().list()).accounts[0].kind).toBe('reconnect-required');
  });
  it('prevents a late refresh completion from resurrecting a forgotten connection', async () => {
    const grant = await seed(true);
    refreshGate = new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    ignoreRefreshAbort = true;
    const reading = controller.worksheet({
      grantId: grant.account.id,
      spreadsheetId: 'source-id',
      sheetId: 17,
    });
    const readFailure = expect(reading).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    const forgetting = controller.forget(grant.account.id);
    await vi.waitFor(async () => expect((await controller.status()).accounts).toEqual([]));
    completeRefresh();
    await forgetting;
    await readFailure;
    expect(await store().read(grant.account.id)).toBeNull();
  });
  it('restores a visible usable connection when forgetting fails', async () => {
    const grant = await seed();
    failForget = true;
    await expect(controller.forget(grant.account.id)).rejects.toThrow('not writable');
    expect((await controller.status()).accounts.map((entry) => entry.account.id)).toEqual([
      grant.account.id,
    ]);
    await controller.worksheet({
      grantId: grant.account.id,
      spreadsheetId: 'source-id',
      sheetId: 17,
    });
    expect(await store().read(grant.account.id)).not.toBeNull();
    failForget = false;
    await controller.forget(grant.account.id);
    expect((await controller.status()).accounts).toEqual([]);
  });
  it('does not save a late refresh after native account ownership changes', async () => {
    const grant = await seed(true);
    refreshGate = new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    ignoreRefreshAbort = true;
    const reading = controller.worksheet({
      grantId: grant.account.id,
      spreadsheetId: 'source-id',
      sheetId: 17,
    });
    const readFailure = expect(reading).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    await select('b');
    await controller.ownerChanged();
    completeRefresh();
    await readFailure;
    expect((await store().read(grant.account.id))?.materialVersion).toBe(grant.materialVersion);
    expect((await controller.status()).accounts).toEqual([]);
  });
  it('cancels only the requesting window and never persists a cancelled flow', async () => {
    callbackAutomatically = false;
    const id = await controller.start(10);
    await vi.waitFor(() => expect(authorization).not.toBeNull());
    expect(() => controller.cancel(id, 11)).toThrow('another window');
    expect(controller.cancel(id, 10)).toBe(true);
    expect((await controller.status()).connection).toEqual({ kind: 'idle' });
    expect((await store().list()).accounts).toEqual([]);
  });
});
