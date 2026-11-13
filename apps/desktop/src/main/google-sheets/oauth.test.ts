// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_SHEETS_READ_SCOPE } from './credential-store';
import { createGoogleSheetsOAuth, createGoogleSheetsPkce, GoogleSheetsOAuthError } from './oauth';

let server: Server;
let origin: string;
let tokenStatus: number;
let tokenReply: Record<string, unknown>;
let verified: boolean;
const calls: Array<{
  url: string;
  method: string | undefined;
  body: URLSearchParams;
  authorization: string | undefined;
}> = [];
const config = {
  clientId: 'synthetic-desktop.apps.googleusercontent.com',
  clientSecret: 'synthetic-public-installed-secret',
};
const redirectUri = 'http://127.0.0.1:48001/callback';
beforeEach(async () => {
  calls.length = 0;
  tokenStatus = 200;
  tokenReply = {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: `openid email ${GOOGLE_SHEETS_READ_SCOPE}`,
  };
  verified = true;
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const url = request.url ?? '/';
    calls.push({
      url,
      method: request.method,
      body: new URLSearchParams(body),
      authorization: request.headers.authorization,
    });
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = url === '/token' ? tokenStatus : 200;
    if (tokenStatus === 302) response.setHeader('Location', '/unexpected-redirect');
    response.end(
      JSON.stringify(
        url === '/token'
          ? tokenReply
          : { sub: 'google-subject', email: 'synthetic@example.test', email_verified: verified }
      )
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function oauth() {
  return createGoogleSheetsOAuth({
    config,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(['https://oauth2.googleapis.com', 'https://openidconnect.googleapis.com']).toContain(
        url.origin
      );
      return fetch(new URL(url.pathname + url.search, origin), init);
    },
  });
}

describe('Google native OAuth over actual HTTP', () => {
  it('refuses token endpoint redirects without resending refresh material', async () => {
    tokenStatus = 302;
    await expect(oauth().refresh({ refreshToken: 'private-refresh' })).rejects.toBeInstanceOf(
      Error
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/token');
  });
  it('opens only the provider URL with read scope, state and S256 challenge, never verifier or client secret', () => {
    const first = createGoogleSheetsPkce(),
      second = createGoogleSheetsPkce();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    const url = new URL(oauth().authorizationUrl({ redirectUri, pkce: first }));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge')).toBe(first.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(first.state);
    expect(url.searchParams.get('scope')).toBe(`openid email ${GOOGLE_SHEETS_READ_SCOPE}`);
    expect(url.href).not.toContain(first.verifier);
    expect(url.href).not.toContain(config.clientSecret);
  });
  it('exchanges the exact code/verifier/callback and obtains verified identity without changing DNAForge sign-in', async () => {
    const pkce = createGoogleSheetsPkce(),
      api = oauth();
    const tokens = await api.exchange({
      code: 'synthetic-code',
      verifier: pkce.verifier,
      redirectUri,
    });
    expect(tokens.refreshToken).toBe('synthetic-refresh');
    expect(calls[0].body.get('code_verifier')).toBe(pkce.verifier);
    expect(calls[0].body.get('redirect_uri')).toBe(redirectUri);
    expect(calls[0].body.get('grant_type')).toBe('authorization_code');
    expect(calls[0].body.get('client_id')).toBe(config.clientId);
    expect(calls[0].method).toBe('POST');
    expect(await api.identity({ accessToken: tokens.accessToken })).toEqual({
      subject: 'google-subject',
      email: 'synthetic@example.test',
    });
    expect(calls[1]).toMatchObject({
      url: '/v1/userinfo',
      method: 'GET',
      authorization: 'Bearer synthetic-access',
    });
  });
  it('preserves omitted refresh-token/scope fields for the existing grant owner to retain on refresh', async () => {
    tokenReply = { access_token: 'renewed-access', expires_in: 3600, token_type: 'Bearer' };
    const result = await oauth().refresh({ refreshToken: 'existing-refresh' });
    expect(result).toEqual({
      accessToken: 'renewed-access',
      refreshToken: null,
      scopes: null,
      expiresInSeconds: 3600,
    });
    expect(calls[0].body.get('grant_type')).toBe('refresh_token');
    expect(calls[0].body.get('refresh_token')).toBe('existing-refresh');
    expect(calls[0].body.has('code_verifier')).toBe(false);
  });
  it('rejects a partial grant that excludes Sheets reads', async () => {
    tokenReply.scope = 'openid email';
    await expect(
      oauth().exchange({
        code: 'synthetic-code',
        verifier: createGoogleSheetsPkce().verifier,
        redirectUri,
      })
    ).rejects.toMatchObject({ reason: 'insufficient-scope' });
  });
  it('reports revoked refresh authorization without returning provider error descriptions', async () => {
    tokenStatus = 400;
    tokenReply = { error: 'invalid_grant', error_description: 'private-provider-details' };
    const error = await oauth()
      .refresh({ refreshToken: 'expired-refresh' })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoogleSheetsOAuthError);
    if (!(error instanceof GoogleSheetsOAuthError)) throw new Error('Missing OAuth error');
    expect(error.reason).toBe('invalid-grant');
    expect(error.message).not.toContain('private-provider-details');
  });
  it('does not classify an invalid client or temporary server error as a revoked user grant', async () => {
    tokenStatus = 503;
    tokenReply = { error: 'temporarily_unavailable' };
    await expect(oauth().refresh({ refreshToken: 'existing-refresh' })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
  it('requires verified provider identity and a complete initial offline grant', async () => {
    verified = false;
    await expect(oauth().identity({ accessToken: 'synthetic-access' })).rejects.toMatchObject({
      reason: 'invalid-response',
    });
    delete tokenReply.refresh_token;
    await expect(
      oauth().exchange({
        code: 'synthetic-code',
        verifier: createGoogleSheetsPkce().verifier,
        redirectUri,
      })
    ).rejects.toMatchObject({ reason: 'invalid-response' });
  });
  it('rejects non-loopback redirects and inconsistent PKCE before any provider request', async () => {
    const pkce = createGoogleSheetsPkce();
    expect(() =>
      oauth().authorizationUrl({ redirectUri: 'https://foreign.example/callback', pkce })
    ).toThrow('native loopback');
    expect(() =>
      oauth().authorizationUrl({ redirectUri, pkce: { ...pkce, challenge: 'foreign' } })
    ).toThrow('invalid PKCE');
    await expect(
      oauth().exchange({
        code: 'synthetic-code',
        verifier: pkce.verifier,
        redirectUri: 'https://foreign.example/callback',
      })
    ).rejects.toThrow('native loopback');
    expect(calls).toHaveLength(0);
  });
});
