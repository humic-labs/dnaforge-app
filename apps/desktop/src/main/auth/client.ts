import {
  userMessagePayload,
  userMessageValue,
  renderUserMessagePayload,
  type UserMessagePayload,
} from '@waypoint/user-messages';
import { app } from 'electron';
import { resolvePublicTelemetryActorRequestContext } from '../telemetry-runtime';
import { getWebBaseUrl } from './auth-config';
import { canonicalizeWebApiOrigin } from './web-api-origin';

function desktopAuthApiUrl(path: string): string {
  return `${canonicalizeWebApiOrigin(getWebBaseUrl())}${path}`;
}

export const AUTH_FETCH_TIMEOUT_MS = 15_000;

function clientVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {};
  }
}

interface AuthFetchResult {
  response: Response;
  body: Record<string, unknown>;
}

function telemetryActorRequestFields(): Record<string, string> {
  const telemetry = resolvePublicTelemetryActorRequestContext();
  if (telemetry.telemetrySuppressed) {
    return {
      desktop_release_channel: telemetry.releaseChannel,
      ...(telemetry.buildTag ? { desktop_build_tag: telemetry.buildTag } : {}),
    };
  }
  const actor = telemetry.telemetryActor;
  const actorCanBeAsserted = actor === 'maintainer' || actor === 'ci';
  return {
    ...(actor === 'user' || actorCanBeAsserted ? { telemetry_actor: actor } : {}),
    ...(actor === 'ci' && telemetry.ciRunId ? { ci_run_id: telemetry.ciRunId } : {}),
    ...(actorCanBeAsserted && telemetry.actorAssertion
      ? { telemetry_actor_assertion: telemetry.actorAssertion }
      : {}),
    desktop_release_channel: telemetry.releaseChannel,
    ...(telemetry.buildTag ? { desktop_build_tag: telemetry.buildTag } : {}),
  };
}

async function authFetch(url: string, init: RequestInit): Promise<AuthFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const body = await readJson(response);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export interface StartFlowInput {
  flowNonce: string;
  challenge: string;
  pollSecretHash: string;
  deviceName: string;
  devicePlatform: string;
  installChannel: string;
  redirectScheme: string;
}

export async function startFlow(
  input: StartFlowInput
): Promise<{ ok: boolean; status: number; expiresAt?: string }> {
  const { response: res, body } = await authFetch(desktopAuthApiUrl('/api/desktop-auth/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      flow_nonce: input.flowNonce,
      challenge_s256: input.challenge,
      poll_secret_hash: input.pollSecretHash,
      device_name: input.deviceName,
      device_platform: input.devicePlatform,
      install_channel: input.installChannel,
      redirect_scheme: input.redirectScheme,
      client_version: clientVersion(),
    }),
  });
  return {
    ok: res.ok,
    status: res.status,
    expiresAt: typeof body.expires_at === 'string' ? body.expires_at : undefined,
  };
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  accountId: string;
  desktopSessionId: string;
  email?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  meaningfulActivityAuthority?: {
    actorKind: 'external' | 'internal' | 'test' | 'unknown';
    executionMode: 'interactive' | 'automated' | 'synthetic';
    impersonated: boolean;
  };
}

export type ExchangeResult =
  | { ok: true; tokens: TokenBundle }
  | { ok: false; status: number; error: string };

export async function exchange(input: {
  code: string;
  verifier: string;
  flowNonce: string;
}): Promise<ExchangeResult> {
  const { response: res, body } = await authFetch(desktopAuthApiUrl('/api/desktop-auth/exchange'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: input.code,
      verifier: input.verifier,
      flow_nonce: input.flowNonce,
      client_version: clientVersion(),
      ...telemetryActorRequestFields(),
    }),
  });
  if (!res.ok || !body.access_token) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'exchange_failed',
    };
  }
  return { ok: true, tokens: tokensFrom(body) };
}

export interface EmailStartResult {
  ok: boolean;
  status: number;
  attemptId?: string;
  error?: string;
  retryAfterSeconds?: number;
}

function retryAfterSecondsFrom(res: Response, body: Record<string, unknown>): number | undefined {
  const fromBody = body.retry_after_seconds;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const fromHeader = Number(res.headers.get('Retry-After'));
  return Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : undefined;
}

export async function emailStart(flowNonce: string, email: string): Promise<EmailStartResult> {
  const telemetry = telemetryActorRequestFields();
  const { response: res, body } = await authFetch(
    desktopAuthApiUrl('/api/desktop-auth/email-start'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow_nonce: flowNonce,
        email,
        client_version: clientVersion(),
        ...telemetry,
      }),
    }
  );
  if (!res.ok) {
    const retryAfterSeconds = retryAfterSecondsFrom(res, body);
    return {
      ok: false,
      status: res.status,
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  return {
    ok: true,
    status: res.status,
    attemptId: typeof body.auth_attempt_id === 'string' ? body.auth_attempt_id : undefined,
  };
}

export async function emailVerify(input: {
  flowNonce: string;
  email: string;
  code: string;
  verifier: string;
  attemptId?: string;
}): Promise<ExchangeResult> {
  const { response: res, body } = await authFetch(
    desktopAuthApiUrl('/api/desktop-auth/email-verify'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow_nonce: input.flowNonce,
        email: input.email,
        code: input.code,
        verifier: input.verifier,
        ...(input.attemptId ? { auth_attempt_id: input.attemptId } : {}),
        client_version: clientVersion(),
      }),
    }
  );
  if (!res.ok || !body.access_token) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'verify_failed',
    };
  }
  return { ok: true, tokens: tokensFrom(body) };
}

export async function oauthUrl(
  flowNonce: string,
  provider: string,
  redirectUri: string,
  pollSecret: string
): Promise<{ ok: boolean; status: number; url?: string }> {
  const telemetry = telemetryActorRequestFields();
  const { response: res, body } = await authFetch(
    desktopAuthApiUrl('/api/desktop-auth/oauth-url'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Poll-Secret': pollSecret },
      body: JSON.stringify({
        flow_nonce: flowNonce,
        provider,
        redirect_uri: redirectUri,
        client_version: clientVersion(),
        ...telemetry,
      }),
    }
  );
  return {
    ok: res.ok,
    status: res.status,
    url: typeof body.url === 'string' ? body.url : undefined,
  };
}

export async function ssoUrl(
  flowNonce: string,
  email: string,
  redirectUri: string,
  pollSecret: string
): Promise<{ ok: boolean; status: number; url?: string; error?: string }> {
  const telemetry = telemetryActorRequestFields();
  const { response: res, body } = await authFetch(desktopAuthApiUrl('/api/desktop-auth/sso-url'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Poll-Secret': pollSecret },
    body: JSON.stringify({
      flow_nonce: flowNonce,
      email,
      redirect_uri: redirectUri,
      client_version: clientVersion(),
      ...telemetry,
    }),
  });
  return {
    ok: res.ok,
    status: res.status,
    url: typeof body.url === 'string' ? body.url : undefined,
    error: typeof body.error === 'string' ? body.error : undefined,
  };
}

export type RefreshResult =
  | { ok: true; tokens: TokenBundle }
  | { ok: false; status: number; error: string };

export async function refresh(refreshToken: string): Promise<RefreshResult> {
  const { response: res, body } = await authFetch(desktopAuthApiUrl('/api/desktop-auth/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, client_version: clientVersion() }),
  });
  if (!res.ok || !body.access_token) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : 'refresh_failed',
    };
  }
  return { ok: true, tokens: tokensFrom(body) };
}

export async function revoke(accessToken: string, desktopSessionId?: string): Promise<boolean> {
  try {
    const { response: res } = await authFetch(desktopAuthApiUrl('/api/desktop-auth/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(desktopSessionId ? { desktop_session_id: desktopSessionId } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function tokensFrom(body: Record<string, unknown>): TokenBundle {
  const authority = body.meaningful_activity_authority;
  const parsedAuthority =
    authority && typeof authority === 'object' && !Array.isArray(authority)
      ? (authority as Record<string, unknown>)
      : null;
  const actorKind = parsedAuthority?.actor_kind;
  const executionMode = parsedAuthority?.execution_mode;
  const meaningfulActivityAuthority =
    ['external', 'internal', 'test', 'unknown'].includes(String(actorKind)) &&
    ['interactive', 'automated', 'synthetic'].includes(String(executionMode)) &&
    typeof parsedAuthority?.impersonated === 'boolean'
      ? {
          actorKind: actorKind as 'external' | 'internal' | 'test' | 'unknown',
          executionMode: executionMode as 'interactive' | 'automated' | 'synthetic',
          impersonated: parsedAuthority.impersonated,
        }
      : undefined;
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token),
    expiresAt: String(body.expires_at),
    accountId: String(body.account_id),
    desktopSessionId: String(body.desktop_session_id),
    email: typeof body.email === 'string' ? body.email : undefined,
    displayName: typeof body.display_name === 'string' ? body.display_name : null,
    avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
    ...(meaningfulActivityAuthority ? { meaningfulActivityAuthority } : {}),
  };
}

export interface ProfileUpdateInput {
  displayName?: string | null;
  avatarBase64?: string;
  avatarContentType?: string;
  clearAvatar?: boolean;
}

export interface ProfileUpdateResult {
  ok: boolean;
  status: number;
  displayName?: string | null;
  avatarUrl?: string | null;
  error?: string;
}

export async function updateProfile(
  accessToken: string,
  input: ProfileUpdateInput
): Promise<ProfileUpdateResult> {
  const body: Record<string, unknown> = {};
  if ('displayName' in input) body.display_name = input.displayName ?? null;
  if (input.clearAvatar) body.clear_avatar = true;
  if (typeof input.avatarBase64 === 'string') {
    body.avatar_base64 = input.avatarBase64;
    body.avatar_content_type = input.avatarContentType ?? 'image/png';
  }
  try {
    const { response: res, body: json } = await authFetch(
      desktopAuthApiUrl('/api/desktop-auth/profile'),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof json.message === 'string' ? json.message : 'profile_update_failed',
      };
    }
    return {
      ok: true,
      status: res.status,
      displayName: typeof json.display_name === 'string' ? json.display_name : null,
      avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : null,
    };
  } catch {
    return { ok: false, status: 0, error: 'network_error' };
  }
}

export async function fetchProfile(accessToken: string): Promise<ProfileUpdateResult> {
  try {
    const { response: res, body: json } = await authFetch(
      desktopAuthApiUrl('/api/desktop-auth/profile'),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof json.message === 'string' ? json.message : 'profile_fetch_failed',
      };
    }
    return {
      ok: true,
      status: res.status,
      displayName: typeof json.display_name === 'string' ? json.display_name : null,
      avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : null,
    };
  } catch {
    return { ok: false, status: 0, error: 'network_error' };
  }
}

export const EMAIL_START_GENERIC_FAILURE =
  'Could not send the code. Try again, or continue with Google or GitHub.';

export function waitDurationPhrase(seconds: number): string {
  if (seconds < 90) return 'about a minute';
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}

export function emailStartFailureMessage(
  result: Pick<EmailStartResult, 'status' | 'retryAfterSeconds'>
): string {
  if (result.status !== 429) return EMAIL_START_GENERIC_FAILURE;
  const wait =
    result.retryAfterSeconds === undefined
      ? 'a few minutes'
      : waitDurationPhrase(result.retryAfterSeconds);
  return renderUserMessagePayload(
    userMessagePayload('auth.emailWait', { duration: userMessageValue(wait) })
  );
}

export function emailStartFailurePayload(
  result: Pick<EmailStartResult, 'status' | 'retryAfterSeconds'>
): UserMessagePayload | undefined {
  if (result.status !== 429) return undefined;
  return userMessagePayload('auth.emailWait', {
    duration: userMessageValue(
      result.retryAfterSeconds === undefined
        ? 'a few minutes'
        : waitDurationPhrase(result.retryAfterSeconds)
    ),
  });
}
