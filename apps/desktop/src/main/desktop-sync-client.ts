import { performRefresh, type DesktopAuthRefreshOutcome } from './auth/controller';
import { getWebBaseUrl } from './auth/auth-config';
import { canonicalizeWebApiOrigin } from './auth/web-api-origin';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import {
  BUNDLE_SCHEMA_CAPABILITY_HEADER,
  WORKSPACE_SYNC_BUNDLE_SCHEMA_VERSION,
} from '@waypoint/share-bundle';

import {
  DesktopSyncClientError,
  type DesktopSyncClientErrorCode,
} from './desktop-sync-client-errors';
export { DesktopSyncClientError };
export type { DesktopSyncClientErrorCode };

const FRESH_TOKEN_LEAD_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;

export const MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface DesktopSyncClientDeps {
  baseUrl?: string;
  fetch?: typeof fetch;
  getActiveStoredSession?: () => Promise<StoredSession | null>;
  performRefresh?: () => Promise<DesktopAuthRefreshOutcome>;
  nowMs?: () => number;
  requestTimeoutMs?: number;
}

export interface DesktopSyncRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  maxResponseBytes?: number;
  parseResponse?: (bytes: Uint8Array) => Promise<unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;

  blobUploadProtocol?: 's3-multipart-v1';

  expectedAccountId?: string;
  expectedDesktopSessionId?: string;
}

export interface DesktopSyncClient {
  requestJson<T = unknown>(path: string, options: DesktopSyncRequestOptions): Promise<T>;
  requestStream(path: string, options: DesktopSyncRequestOptions): Promise<Response>;

  assertAccount?: (expectedAccountId: string) => Promise<void>;
  getAccountId?: () => Promise<string>;
}

interface NormalizedDeps {
  baseUrl: string;
  fetch: typeof fetch;
  getActiveStoredSession: () => Promise<StoredSession | null>;
  performRefresh: () => Promise<DesktopAuthRefreshOutcome>;
  nowMs: () => number;
  requestTimeoutMs: number;
}

export function createDesktopSyncClient(deps: DesktopSyncClientDeps = {}): DesktopSyncClient {
  const normalized: NormalizedDeps = {
    baseUrl: canonicalizeWebApiOrigin(deps.baseUrl ?? getWebBaseUrl()),
    fetch: deps.fetch ?? fetch,
    getActiveStoredSession: deps.getActiveStoredSession ?? getActiveStoredSession,
    performRefresh: deps.performRefresh ?? performRefresh,
    nowMs: deps.nowMs ?? Date.now,
    requestTimeoutMs: deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };

  return {
    requestJson: (path, options) => requestJson(normalized, path, options),
    requestStream: (path, options) => requestResponse(normalized, path, options),
    assertAccount: async (expectedAccountId) => {
      await getFreshSession(normalized, expectedAccountId);
    },
    getAccountId: async () => (await getFreshSession(normalized, undefined)).accountId,
  };
}

async function requestJson<T>(
  deps: NormalizedDeps,
  path: string,
  options: DesktopSyncRequestOptions
): Promise<T> {
  const response = await requestResponse(deps, path, options);
  return (await readJson(response, options.maxResponseBytes, true, options.parseResponse)) as T;
}

async function requestResponse(
  deps: NormalizedDeps,
  path: string,
  options: DesktopSyncRequestOptions
): Promise<Response> {
  const firstSession = await getFreshSession(
    deps,
    options.expectedAccountId,
    options.expectedDesktopSessionId
  );
  let response = await performFetch(deps, path, options, firstSession.accessToken);

  if (response.status === 401) {
    const refreshed = await renewSession(
      deps,
      firstSession.accountId,
      options.expectedDesktopSessionId
    );
    if (refreshed.accessToken === firstSession.accessToken) {
      throw badResponseError('Authentication refresh did not replace the rejected access token.');
    }
    assertFreshSession(deps, refreshed);
    response = await performFetch(deps, path, options, refreshed.accessToken);
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response;
}

async function getFreshSession(
  deps: NormalizedDeps,
  expectedAccountId: string | undefined,
  expectedDesktopSessionId?: string
): Promise<StoredSession> {
  const session = await deps.getActiveStoredSession();
  if (!session) throw signedOutError();
  if (expectedAccountId !== undefined) assertSameAccount(expectedAccountId, session);
  if (expectedDesktopSessionId !== undefined)
    assertSameDesktopSession(expectedDesktopSessionId, session);

  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= deps.nowMs() + FRESH_TOKEN_LEAD_MS) {
    return renewSession(deps, session.accountId, expectedDesktopSessionId);
  }

  return session;
}

async function renewSession(
  deps: NormalizedDeps,
  accountId: string,
  expectedDesktopSessionId?: string
): Promise<StoredSession> {
  const outcome = await refreshOrThrow(deps);
  const refreshed = await deps.getActiveStoredSession();
  if (refreshed) assertSameAccount(accountId, refreshed);
  if (refreshed && expectedDesktopSessionId !== undefined)
    assertSameDesktopSession(expectedDesktopSessionId, refreshed);
  if (outcome === 'signed_out' || !refreshed) throw sessionRevokedError();
  assertFreshSession(deps, refreshed);
  return refreshed;
}

function assertSameAccount(expectedAccountId: string, session: StoredSession): void {
  if (session.accountId === expectedAccountId) return;
  throw new DesktopSyncClientError(
    'ACCOUNT_CHANGED',
    'The signed-in account changed before this sync request was sent. Sign in as the account that started it and try again.',
    {
      retryable: true,
      terminal: false,
      authPaused: true,
      details: { expectedAccountId, activeAccountId: session.accountId },
    }
  );
}

function assertSameDesktopSession(expectedDesktopSessionId: string, session: StoredSession): void {
  if (session.desktopSessionId === expectedDesktopSessionId) return;
  throw new DesktopSyncClientError(
    'SESSION_CHANGED',
    'The signed-in session changed before this sync request was sent.',
    {
      retryable: true,
      terminal: false,
      authPaused: true,
      details: { expectedDesktopSessionId, activeDesktopSessionId: session.desktopSessionId },
    }
  );
}

async function refreshOrThrow(deps: NormalizedDeps): Promise<'refreshed' | 'signed_out'> {
  let outcome: DesktopAuthRefreshOutcome;
  try {
    outcome = await deps.performRefresh();
  } catch (err) {
    throw networkError(err);
  }
  if (outcome.status === 'transient') {
    throw typedError(outcome.code, outcome.message, undefined, true, false);
  }
  return outcome.status;
}

function assertFreshSession(deps: NormalizedDeps, session: StoredSession): void {
  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= deps.nowMs() + FRESH_TOKEN_LEAD_MS) {
    throw badResponseError('Authentication refresh did not produce a fresh access token.');
  }
}

async function performFetch(
  deps: NormalizedDeps,
  path: string,
  options: DesktopSyncRequestOptions,
  accessToken: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    [BUNDLE_SCHEMA_CAPABILITY_HEADER]: String(WORKSPACE_SYNC_BUNDLE_SCHEMA_VERSION),
  };
  if (options.blobUploadProtocol)
    headers['x-workspace-sync-blob-upload'] = options.blobUploadProtocol;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  try {
    const requestedTimeoutMs = options.timeoutMs;
    const timeoutMs =
      typeof requestedTimeoutMs === 'number' &&
      Number.isSafeInteger(requestedTimeoutMs) &&
      requestedTimeoutMs > 0
        ? requestedTimeoutMs
        : deps.requestTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return await deps.fetch(`${deps.baseUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (err) {
    throw networkError(err);
  }
}

async function readJson(
  response: Response,
  maxResponseBytes = DEFAULT_RESPONSE_BYTES,
  strict = true,
  parseResponse?: (bytes: Uint8Array) => Promise<unknown>
): Promise<unknown> {
  const boundedBytes = normalizeResponseLimit(maxResponseBytes);
  const bytes = await readResponseBytesBounded(response, boundedBytes);
  if (bytes.byteLength === 0) {
    if (strict) throw badResponseError('Desktop sync returned an empty successful response.');
    return {};
  }
  if (parseResponse) {
    try {
      return await parseResponse(bytes);
    } catch (error) {
      if (error instanceof DesktopSyncClientError) throw error;
      throw badResponseError(
        error instanceof Error ? error.message : 'Desktop sync returned an invalid response.'
      );
    }
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    if (strict) throw badResponseError('Desktop sync returned malformed JSON.');
    return {};
  }
}

function normalizeResponseLimit(requestedBytes: number): number {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    return DEFAULT_RESPONSE_BYTES;
  }
  return Math.min(requestedBytes, MAX_DESKTOP_SYNC_LATEST_RESPONSE_BYTES);
}

async function readResponseBytesBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw badResponseError(`Desktop sync response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const advertisedBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0;
  let bytes = new Uint8Array(Math.min(maxBytes, Math.max(advertisedBytes, 64 * 1024)));
  let totalBytes = 0;
  let nextChunk = await readResponseChunk(reader);
  while (!nextChunk.done) {
    const { value } = nextChunk;
    if (value) {
      const nextTotal = totalBytes + value.byteLength;
      if (nextTotal > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw badResponseError(`Desktop sync response exceeds ${maxBytes} bytes.`);
      }
      if (nextTotal > bytes.byteLength) {
        let capacity = bytes.byteLength;
        while (capacity < nextTotal)
          capacity = Math.min(maxBytes, Math.max(capacity * 2, nextTotal));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, totalBytes));
        bytes = grown;
      }
      bytes.set(value, totalBytes);
      totalBytes = nextTotal;
    }
    nextChunk = await readResponseChunk(reader);
  }
  return totalBytes === bytes.byteLength ? bytes : bytes.slice(0, totalBytes);
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  try {
    return await reader.read();
  } catch (error) {
    if (error instanceof DesktopSyncClientError) throw error;
    throw networkError(error);
  }
}

async function errorFromResponse(response: Response): Promise<DesktopSyncClientError> {
  const body = await readJson(response, DEFAULT_RESPONSE_BYTES, false);
  const code = bodyCode(body);
  const message = bodyMessage(body) ?? `Desktop sync request failed (${response.status}).`;
  const details = bodyDetails(body);

  if (response.status === 401) return sessionRevokedError(message, details);
  if (code === 'IDEMPOTENCY_CONFLICT') {
    return typedError('IDEMPOTENCY_CONFLICT', message, response.status, false, true, details);
  }
  if (code === 'SYNC_CONFLICT') {
    return typedError('CONFLICT', message, response.status, false, true, details);
  }
  if (code === 'RECOVERY_BLOBS_PENDING') {
    return typedError('SERVER', message, response.status, true, false, details);
  }
  if (code === 'RECOVERY_CANDIDATE_EXPIRED') {
    return typedError('RECOVERY_CANDIDATE_EXPIRED', message, response.status, false, true, details);
  }
  if (code === 'REGISTRY_NOT_CONFIGURED') {
    return typedError('NOT_CONFIGURED', message, response.status, false, false, details);
  }
  if (code === 'MANIFEST_RESTORE_REQUIRED') {
    return typedError('MANIFEST_RESTORE_REQUIRED', message, response.status, false, false, details);
  }

  if (
    code === 'BAD_HASH' ||
    code === 'BAD_BUNDLE' ||
    code === 'LEGACY_LIMS_QUARANTINED' ||
    code === 'UPLOAD_FAILED' ||
    code === 'STORAGE_VERIFY_FAILED'
  ) {
    return typedError('VALIDATION', message, response.status, false, true, details);
  }
  if (response.status === 409) {
    return typedError('CONFLICT', message, response.status, false, true, details);
  }

  if (
    code === 'QUOTA_EXCEEDED' ||
    code === 'BLOB_QUOTA_EXCEEDED' ||
    code === 'STORAGE_POLICY_EXCEEDED' ||
    response.status === 507
  ) {
    return typedError('QUOTA_EXCEEDED', message, response.status, false, true, details);
  }
  if (response.status === 413 || code === 'PAYLOAD_TOO_LARGE' || code === 'BUNDLE_TOO_LARGE') {
    return typedError('VALIDATION', message, response.status, false, true, details);
  }
  if (response.status === 426 || code === 'UPGRADE_REQUIRED') {
    return typedError('VALIDATION', message, response.status, false, true, details);
  }
  if (response.status === 429) {
    return typedError('RATE_LIMITED', message, response.status, true, false, details);
  }
  if (code === 'FEATURE_DISABLED') {
    return typedError('FEATURE_DISABLED', message, response.status, true, false, details);
  }
  if (response.status === 503 && code === 'SEQUENCE_PACKAGE_ADMISSION_PENDING') {
    return typedError('IN_PROGRESS', message, response.status, true, false, {
      ...details,
      serverErrorCode: code,
    });
  }
  if (response.status >= 500) {
    return typedError('SERVER', message, response.status, true, false, details);
  }
  if (response.status === 403) {
    return typedError('FORBIDDEN', message, response.status, false, true, details);
  }
  if (response.status === 404) {
    return typedError('NOT_FOUND', message, response.status, false, true, details);
  }
  if (response.status === 400 || response.status === 422) {
    return typedError('VALIDATION', message, response.status, false, true, details);
  }
  return typedError('UNKNOWN', message, response.status, false, true, details);
}

function signedOutError(): DesktopSyncClientError {
  return typedError('SIGNED_OUT', 'Sign in before using desktop sync.', undefined, false, true, {
    auth: 'missing_session',
  });
}

function sessionRevokedError(
  message = 'Desktop sync session ended. Sign in again.',
  details?: Record<string, unknown>
): DesktopSyncClientError {
  return new DesktopSyncClientError('SESSION_REVOKED', message, {
    retryable: false,
    terminal: true,
    authPaused: true,
    details,
  });
}

function networkError(err: unknown): DesktopSyncClientError {
  return typedError(
    'NETWORK',
    err instanceof Error ? err.message : 'Network error',
    undefined,
    true,
    false
  );
}

function badResponseError(message: string): DesktopSyncClientError {
  return typedError('BAD_RESPONSE', message, undefined, true, false);
}

function typedError(
  code: DesktopSyncClientErrorCode,
  message: string,
  status: number | undefined,
  retryable: boolean,
  terminal: boolean,
  details?: Record<string, unknown>
): DesktopSyncClientError {
  return new DesktopSyncClientError(code, message, {
    status,
    retryable,
    terminal,
    details,
  });
}

function bodyCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.code === 'string') return body.code;
  if (typeof body.error === 'string') return body.error;
  return null;
}

function bodyMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.message === 'string' ? body.message : null;
}

function bodyDetails(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.details)) return undefined;
  return body.details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
