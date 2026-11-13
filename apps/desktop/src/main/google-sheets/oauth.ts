import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GOOGLE_SHEETS_READ_SCOPE } from './credential-store';

const token = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[^\r\n]+$/);
const configSchema = z
  .object({
    clientId: z.string().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
    clientSecret: token.optional(),
  })
  .strict();
export type GoogleSheetsOAuthConfig = z.infer<typeof configSchema>;
export function parseGoogleSheetsOAuthConfig(value: unknown): GoogleSheetsOAuthConfig | null {
  const parsed = configSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const responseSchema = z.object({
  access_token: token,
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(Number.MAX_SAFE_INTEGER / 1000),
  token_type: z.string().regex(/^Bearer$/i),
  refresh_token: token.optional(),
  scope: z.string().optional(),
});
const identitySchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.literal(true),
});
const errorSchema = z.object({ error: z.string() });
export type GoogleSheetsPkce = { verifier: string; challenge: string; state: string };
export type GoogleSheetsTokenReply = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[] | null;
};
export class GoogleSheetsOAuthError extends Error {
  constructor(
    public readonly reason:
      | 'invalid-grant'
      | 'insufficient-scope'
      | 'invalid-response'
      | 'unavailable',
    message: string
  ) {
    super(message);
    this.name = 'GoogleSheetsOAuthError';
  }
}

export function createGoogleSheetsPkce(): GoogleSheetsPkce {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
  };
}
function loopbackUri(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/callback' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Google Sheets requires its native loopback callback.');
  return url.href;
}
async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GoogleSheetsOAuthError(
      'invalid-response',
      'Google returned an unreadable authorization response.'
    );
  }
}

export function createGoogleSheetsOAuth(input: {
  config: GoogleSheetsOAuthConfig;
  fetch: typeof fetch;
}) {
  const config = configSchema.parse(input.config);
  function authorizationUrl(request: { redirectUri: string; pkce: GoogleSheetsPkce }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const verifier = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,128}$/)
      .parse(request.pkce.verifier);
    if (request.pkce.challenge !== createHash('sha256').update(verifier).digest('base64url'))
      throw new Error('Google Sheets authorization has an invalid PKCE challenge.');
    const state = z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(request.pkce.state);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: loopbackUri(request.redirectUri),
      response_type: 'code',
      scope: `openid email ${GOOGLE_SHEETS_READ_SCOPE}`,
      code_challenge: request.pkce.challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent select_account',
    }).toString();
    return url.href;
  }
  async function tokenRequest(
    parameters: Record<string, string>,
    signal?: AbortSignal
  ): Promise<GoogleSheetsTokenReply> {
    const body = new URLSearchParams({
      ...parameters,
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    });
    const response = await input.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    const raw = await responseJson(response);
    if (!response.ok) {
      const error = errorSchema.safeParse(raw);
      throw error.success && error.data.error === 'invalid_grant'
        ? new GoogleSheetsOAuthError(
            'invalid-grant',
            'This Google authorization expired or was revoked. Reconnect the account.'
          )
        : new GoogleSheetsOAuthError(
            'unavailable',
            'Google authorization could not complete. Try again.'
          );
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success)
      throw new GoogleSheetsOAuthError(
        'invalid-response',
        'Google returned incomplete authorization data.'
      );
    const scopes =
      parsed.data.scope === undefined ? null : parsed.data.scope.split(/\s+/).filter(Boolean);
    if (scopes && !scopes.includes(GOOGLE_SHEETS_READ_SCOPE))
      throw new GoogleSheetsOAuthError(
        'insufficient-scope',
        'Google Sheets read access was not granted.'
      );
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresInSeconds: parsed.data.expires_in,
      scopes,
    };
  }
  async function exchange(request: {
    code: string;
    verifier: string;
    redirectUri: string;
    signal?: AbortSignal;
  }) {
    const result = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code: token.parse(request.code),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43,128}$/)
          .parse(request.verifier),
        redirect_uri: loopbackUri(request.redirectUri),
      },
      request.signal
    );
    if (!result.refreshToken || !result.scopes)
      throw new GoogleSheetsOAuthError(
        'invalid-response',
        'Google did not return the offline Sheets grant. Reconnect with consent.'
      );
    return { ...result, refreshToken: result.refreshToken, scopes: result.scopes };
  }
  async function refresh(request: { refreshToken: string; signal?: AbortSignal }) {
    return tokenRequest(
      { grant_type: 'refresh_token', refresh_token: token.parse(request.refreshToken) },
      request.signal
    );
  }
  async function identity(request: { accessToken: string; signal?: AbortSignal }) {
    const response = await input.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token.parse(request.accessToken)}` },
      signal: request.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GoogleSheetsOAuthError(
        'unavailable',
        'Google could not confirm the connected account.'
      );
    }
    const parsed = identitySchema.safeParse(await responseJson(response));
    if (!parsed.success)
      throw new GoogleSheetsOAuthError(
        'invalid-response',
        'Google did not confirm a verified account identity.'
      );
    return { subject: parsed.data.sub, email: parsed.data.email };
  }
  return { clientId: config.clientId, authorizationUrl, exchange, refresh, identity };
}
export type GoogleSheetsOAuth = ReturnType<typeof createGoogleSheetsOAuth>;
