import { isTrustedRendererUrl } from './security';

export const SIDECAR_SESSION_HEADER = 'X-DNAForge-Session';
export const SIDECAR_OPERATION_AUTHORITY_HEADER = 'X-DNAForge-Operation-Authority';
export const SIDECAR_NATIVE_DOCUMENT_AUTHORITY_HEADER = 'X-DNAForge-Native-Document-Authority';

function isOperationPath(url: URL): boolean {
  return (
    url.pathname === '/operations' ||
    url.pathname.startsWith('/operations/') ||
    url.pathname.startsWith('/external/credential-broker/') ||
    url.pathname === '/toolbox/retry/annotation'
  );
}

function isNativeDocumentPath(url: URL): boolean {
  return (
    url.pathname.startsWith('/internal/managed-documents/') ||
    /^\/agent-grants\/[^/]+\/organization-inventory\/(?:claim-policy|lease)$/.test(url.pathname)
  );
}

export const SIDECAR_AUTH_REQUEST_FILTER: { urls: string[] } = { urls: ['<all_urls>'] };

export type SidecarRequestHeaders = Record<string, string | string[]>;

export interface SidecarRequestOwner {
  readonly webContentsId?: number;
  readonly webContents?: {
    readonly id: number;
    readonly mainFrame?: { readonly url: string };
    isDestroyed?(): boolean;
  };
  readonly frame?: { readonly url: string } | null;
}

export function isTrustedSidecarRequestOwner(
  details: SidecarRequestOwner,
  trustedWebContentsId: number | null,
  trustedRendererUrl: string | null
): boolean {
  if (trustedWebContentsId === null || !trustedRendererUrl) return false;
  const reportedIds = [details.webContentsId, details.webContents?.id].filter(
    (id): id is number => typeof id === 'number'
  );
  if (!reportedIds.length || reportedIds.some((id) => id !== trustedWebContentsId)) return false;
  try {
    return Boolean(
      details.webContents &&
      !details.webContents.isDestroyed?.() &&
      details.frame &&
      details.frame === details.webContents.mainFrame &&
      isTrustedRendererUrl(details.frame.url, trustedRendererUrl)
    );
  } catch {
    return false;
  }
}

function loopbackSidecarUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const loopbackHost =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !loopbackHost || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function authorizedSidecarDestination(
  requestUrl: string,
  sidecarBaseUrl: string
): URL | null {
  const request = loopbackSidecarUrl(requestUrl);
  const sidecar = loopbackSidecarUrl(sidecarBaseUrl);
  return request && sidecar && request.origin === sidecar.origin ? request : null;
}

export function stripSidecarSessionHeaders(
  requestHeaders: SidecarRequestHeaders
): SidecarRequestHeaders {
  const headers: SidecarRequestHeaders = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (
      name.toLowerCase() !== SIDECAR_SESSION_HEADER.toLowerCase() &&
      name.toLowerCase() !== SIDECAR_OPERATION_AUTHORITY_HEADER.toLowerCase() &&
      name.toLowerCase() !== SIDECAR_NATIVE_DOCUMENT_AUTHORITY_HEADER.toLowerCase()
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

interface ReadySessionSnapshot {
  readonly owner: 'electron' | 'external';
  readonly generation: number;
  readonly state: 'starting' | 'ready' | 'restarting' | 'stopped';
  readonly token: string;
}

export type SidecarHeaderFailureStage = 'sidecar-session' | 'compute-header' | 'header-callback';

export function sidecarHeaderFailureDiagnostic(input: {
  readonly stage: SidecarHeaderFailureStage;
  readonly error: unknown;
  readonly requestUrl: string;
  readonly sidecarBaseUrl: string;
  readonly snapshot: ReadySessionSnapshot;
}) {
  const requestUrl = loopbackSidecarUrl(input.requestUrl);
  const sidecarUrl = loopbackSidecarUrl(input.sidecarBaseUrl);
  const sidecarOriginMatches = Boolean(
    requestUrl && sidecarUrl && requestUrl.origin === sidecarUrl.origin
  );
  const error = input.error instanceof Error ? input.error : undefined;
  const name = error?.name;
  const code = error && 'code' in error ? error.code : undefined;
  return {
    stage: input.stage,
    errorName:
      typeof name === 'string' &&
      [
        'Error',
        'TypeError',
        'RangeError',
        'SyntaxError',
        'SidecarSessionUnavailableError',
      ].includes(name)
        ? name
        : 'unknown',
    errorCode:
      typeof code === 'string' &&
      [
        'SIDECAR_SESSION_UNAVAILABLE',
        'ERR_INVALID_ARG_TYPE',
        'ERR_INVALID_ARG_VALUE',
        'ERR_INVALID_URL',
      ].includes(code)
        ? code
        : 'unknown',
    owner: input.snapshot.owner,
    generation: input.snapshot.generation,
    state: input.snapshot.state,
    pathname: sidecarOriginMatches ? requestUrl?.pathname : null,
    sidecarOriginMatches,
  };
}

interface InjectReadySidecarSessionHeaderInput {
  readonly requestUrl: string;
  readonly sidecarBaseUrl: string;
  readonly requestHeaders: SidecarRequestHeaders;
  readonly authority: {
    waitForReadySnapshot(timeoutMs?: number): Promise<ReadySessionSnapshot>;
    isCurrent(snapshot: ReadySessionSnapshot): boolean;
    humanOperationToken?(snapshot: ReadySessionSnapshot): string | undefined;
  };
  readonly timeoutMs?: number;
}

export async function injectReadySidecarSessionHeader(
  input: InjectReadySidecarSessionHeaderInput
): Promise<SidecarRequestHeaders> {
  const headers = stripSidecarSessionHeaders(input.requestHeaders);
  const requestUrl = authorizedSidecarDestination(input.requestUrl, input.sidecarBaseUrl);
  if (!requestUrl) return headers;

  const timeoutMs = input.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await input.authority.waitForReadySnapshot(Math.max(1, deadline - Date.now()));

    if (!input.authority.isCurrent(snapshot)) continue;
    const humanToken = isOperationPath(requestUrl)
      ? input.authority.humanOperationToken?.(snapshot)
      : undefined;
    return {
      ...headers,
      [SIDECAR_SESSION_HEADER]: snapshot.token,
      ...(humanToken ? { [SIDECAR_OPERATION_AUTHORITY_HEADER]: humanToken } : {}),
    };
  }
  throw new Error('SIDECAR_SESSION_UNAVAILABLE: timed out waiting for a ready generation');
}

interface CreateSidecarFetchOptions {
  readonly getBaseUrl: () => string;
  readonly getCurrentToken: () => string;
  readonly getHumanOperationToken?: () => string | undefined;
  readonly getNativeDocumentToken?: () => string | undefined;
  readonly fetchImpl?: typeof fetch;
}

export type SidecarFetch = (pathOrUrl: string | URL, init?: RequestInit) => Promise<Response>;

export function createSidecarFetch(options: CreateSidecarFetchOptions): SidecarFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (pathOrUrl: string | URL, init?: RequestInit): Promise<Response> => {
    const baseUrl = options.getBaseUrl().replace(/\/+$/, '');
    const validatedBaseUrl = loopbackSidecarUrl(baseUrl);
    if (!validatedBaseUrl) {
      throw new Error('sidecarFetch refuses a non-loopback configured sidecar URL');
    }
    const rawTarget = typeof pathOrUrl === 'string' ? pathOrUrl : pathOrUrl.toString();
    const target = /^https?:\/\//i.test(rawTarget)
      ? new URL(rawTarget).toString()
      : `${baseUrl}/${rawTarget.replace(/^\/+/, '')}`;
    const validatedTarget = loopbackSidecarUrl(target);
    if (!validatedTarget || validatedTarget.origin !== validatedBaseUrl.origin) {
      throw new Error('sidecarFetch refuses requests outside the configured sidecar origin');
    }

    let currentUrl = target;
    let currentInit: RequestInit = { ...init };

    for (let redirects = 0; redirects <= 20; redirects += 1) {
      const token = options.getCurrentToken();
      const headers = new Headers(currentInit.headers);
      headers.delete(SIDECAR_SESSION_HEADER);
      headers.delete(SIDECAR_OPERATION_AUTHORITY_HEADER);
      headers.delete(SIDECAR_NATIVE_DOCUMENT_AUTHORITY_HEADER);
      headers.set(SIDECAR_SESSION_HEADER, token);
      if (isOperationPath(new URL(currentUrl))) {
        const humanToken = options.getHumanOperationToken?.();
        if (humanToken) headers.set(SIDECAR_OPERATION_AUTHORITY_HEADER, humanToken);
      }
      if (isNativeDocumentPath(new URL(currentUrl))) {
        const nativeToken = options.getNativeDocumentToken?.();
        if (nativeToken) headers.set(SIDECAR_NATIVE_DOCUMENT_AUTHORITY_HEADER, nativeToken);
      }
      const response = await fetchImpl(currentUrl, {
        ...currentInit,
        headers,
        redirect: 'manual',
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects === 20) {
        throw new Error('sidecarFetch refused more than 20 redirects');
      }

      const nextUrl = new URL(location, currentUrl);
      if (!loopbackSidecarUrl(nextUrl.toString()) || nextUrl.origin !== validatedBaseUrl.origin) {
        throw new Error('sidecarFetch refuses redirects outside the configured sidecar origin');
      }

      const method = (currentInit.method ?? 'GET').toUpperCase();
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        const nextHeaders = new Headers(currentInit.headers);
        nextHeaders.delete('content-length');
        nextHeaders.delete('content-type');
        currentInit = { ...currentInit, method: 'GET', body: undefined, headers: nextHeaders };
      }
      currentUrl = nextUrl.toString();
    }

    throw new Error('sidecarFetch redirect handling reached an impossible state');
  };
}
