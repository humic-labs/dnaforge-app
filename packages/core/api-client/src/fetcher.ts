export type HeadersLike = NonNullable<ConstructorParameters<typeof Headers>[0]>;

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
  }
}

export const SIDECAR_SESSION_HEADER = 'X-DNAForge-Session';

export interface ApiError {
  status: number;
  statusText: string;
  detail?: string;
  body?: unknown;
  bodyPreview?: string;
}

export class ApiResponseParseError extends Error {
  readonly responseStatus: number;
  readonly responseStatusText: string;
  readonly contentType: string;
  readonly parseError: unknown;

  constructor(response: Response, contentType: string, parseError: unknown) {
    const statusLabel = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    super(`API response was not valid JSON (HTTP ${statusLabel}).`);
    this.name = 'ApiResponseParseError';
    this.responseStatus = response.status;
    this.responseStatusText = response.statusText;
    this.contentType = contentType;
    this.parseError = parseError;
  }
}

export interface ApiClientConfiguration {
  baseUrl: string;
  headers?: () => HeadersLike | Promise<HeadersLike>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

let runtimeConfiguration: ApiClientConfiguration | null = null;

function normalizeConfiguration(configuration: ApiClientConfiguration): ApiClientConfiguration {
  const baseUrl = configuration.baseUrl.trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('API client baseUrl cannot be empty.');
  return {
    baseUrl,
    headers: configuration.headers,
    fetch: configuration.fetch,
  };
}

export function configureApiClient(configuration: ApiClientConfiguration): void {
  runtimeConfiguration = normalizeConfiguration(configuration);
}

export function resetApiClientConfigurationForTests(): void {
  runtimeConfiguration = null;
}

type QueryParams = URLSearchParams | Record<string, unknown>;

interface ReactQueryConfig {
  url: string;
  method: string;
  headers?: HeadersLike;
  data?: unknown;
  params?: QueryParams;
  signal?: AbortSignal;
}

function getBaseUrl(configuration: ApiClientConfiguration | null): string {
  if (configuration) return configuration.baseUrl;

  const electronRuntime =
    (typeof process !== 'undefined' && Boolean(process.versions?.electron)) ||
    (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent));
  if (electronRuntime) {
    throw new Error(
      'API client is not configured for Electron. Initialize it with the main-process sidecar URL before making requests.'
    );
  }

  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  if (typeof process !== 'undefined' && process.env?.API_URL) {
    return process.env.API_URL;
  }

  return 'http://localhost:8000';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
const LOCAL_ONLY_HEADERS = [
  SIDECAR_SESSION_HEADER,
  'X-DNAForge-Agent-Identity',
  'X-DNAForge-Agent-Capabilities',
] as const;

export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return LOOPBACK_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isDev(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    return true;
  }
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
    return true;
  }
  return false;
}

function isReactQueryConfig(arg: string | ReactQueryConfig): arg is ReactQueryConfig {
  return typeof arg === 'object' && arg !== null && 'url' in arg && 'method' in arg;
}

function mergeHeaders(...sources: Array<HeadersLike | undefined>): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, name) => merged.set(name, value));
  }
  return merged;
}

function appendQueryParams(url: string, params?: QueryParams): string {
  if (!params) {
    return url;
  }

  const [path, existingQuery = ''] = url.split('?', 2);
  const normalizedParams = new URLSearchParams(existingQuery);

  const appendValue = (key: string, value: unknown) => {
    if (value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => appendValue(key, item));
      return;
    }

    normalizedParams.append(key, value === null ? 'null' : String(value));
  };

  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => appendValue(key, value));
  } else {
    Object.entries(params).forEach(([key, value]) => appendValue(key, value));
  }

  const stringifiedParams = normalizedParams.toString();
  return stringifiedParams ? `${path}?${stringifiedParams}` : path;
}

export async function customFetch<T>(
  urlOrConfig: string | ReactQueryConfig,
  options?: RequestInit,
  requestConfiguration?: ApiClientConfiguration
): Promise<T> {
  let url: string;
  let finalOptions: RequestInit;

  if (isReactQueryConfig(urlOrConfig)) {
    url = appendQueryParams(urlOrConfig.url, urlOrConfig.params);

    finalOptions = {
      ...options,
      method: urlOrConfig.method,
      headers: mergeHeaders(urlOrConfig.headers, options?.headers),
      body: urlOrConfig.data === undefined ? options?.body : JSON.stringify(urlOrConfig.data),
      signal: urlOrConfig.signal ?? options?.signal,
    };
  } else {
    url = urlOrConfig;
    finalOptions = options || {};
  }

  const configuration = requestConfiguration
    ? normalizeConfiguration(requestConfiguration)
    : runtimeConfiguration;
  const baseUrl = getBaseUrl(configuration);
  const fullUrl = `${baseUrl}${url}`;

  const headers = mergeHeaders(await configuration?.headers?.(), finalOptions.headers);
  if (!headers.has('Content-Type') && finalOptions.body) {
    headers.set('Content-Type', 'application/json');
  }

  headers.delete(SIDECAR_SESSION_HEADER);
  if (!isLoopbackUrl(fullUrl)) {
    LOCAL_ONLY_HEADERS.slice(1).forEach((name) => headers.delete(name));
  }

  if (isDev()) {
    console.debug(`[API] ${finalOptions.method || 'GET'} ${fullUrl}`);
  }

  const fetchImpl = configuration?.fetch ?? fetch;
  const response = await fetchImpl(fullUrl, {
    ...finalOptions,
    headers,
  });

  if (!response.ok) {
    let detail: string | undefined;
    let body: unknown;
    let bodyPreview: string | undefined;

    try {
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            bodyPreview = text.slice(0, 500);
          }
        }
      } else {
        body = await response.json();
      }
      if (typeof body === 'object' && body !== null && 'detail' in body) {
        detail = String((body as { detail: unknown }).detail);
      }
    } catch {}

    const error: ApiError = {
      status: response.status,
      statusText: response.statusText,
      detail,
      body,
      bodyPreview,
    };

    if (isDev()) {
      console.error(`[API] Error: ${response.status} ${response.statusText}`, error);
    }

    throw error;
  }

  if (response.status === 204) {
    return {
      data: null,
      status: response.status,
      headers: response.headers,
    } as T;
  }

  const contentType = response.headers?.get?.('content-type') ?? '';
  let data: unknown = undefined;

  if (
    contentType.includes('application/json') ||
    contentType.startsWith('text/plain') ||
    !contentType
  ) {
    try {
      data = await response.json();
    } catch (error) {
      throw new ApiResponseParseError(response, contentType, error);
    }
  } else {
    throw new ApiResponseParseError(
      response,
      contentType,
      new Error(`Unsupported success response content type: ${contentType || '<missing>'}`)
    );
  }

  if (isDev()) {
    console.debug(`[API] Response:`, data);
  }

  return {
    data,
    status: response.status,
    headers: response.headers ?? new Headers(),
  } as T;
}

export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as ApiError).status === 'number'
  );
}
