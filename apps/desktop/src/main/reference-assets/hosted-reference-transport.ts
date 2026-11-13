export type HostedReferenceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HostedReferenceBodyReadGate {
  reserve(bytes: number, signal: AbortSignal): Promise<void>;
}

export const HOSTED_REFERENCE_BODY_READ_RESERVATION_BYTES = 65_536;

let processWideBodyReadGate: HostedReferenceBodyReadGate | null = null;

export function installHostedReferenceBodyReadGate(gate: HostedReferenceBodyReadGate): () => void {
  if (processWideBodyReadGate) {
    throw new Error('Hosted reference body-read gate is already installed.');
  }
  processWideBodyReadGate = gate;
  return () => {
    if (processWideBodyReadGate === gate) processWideBodyReadGate = null;
  };
}

export const HOSTED_REFERENCE_STALL_TIMEOUT_MS = 15_000;

export const HOSTED_REFERENCE_RESPONSE_HEADER_TIMEOUT_MS = 60_000;

export class HostedReferenceTransportError extends Error {
  readonly retryable: boolean;
  readonly kind: 'abort' | 'transport';
  readonly responseStatus: number | null;
  readonly contentRange: string | null;

  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly retryable: boolean;
      readonly kind?: 'abort' | 'transport';
      readonly responseStatus?: number;
      readonly contentRange?: string | null;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = 'HostedReferenceTransportError';
    this.retryable = options.retryable;
    this.kind = options.kind ?? 'transport';
    this.responseStatus = options.responseStatus ?? null;
    this.contentRange = options.contentRange ?? null;
  }
}

export function isRetryableHostedReferenceTransportError(
  error: unknown
): error is HostedReferenceTransportError {
  return error instanceof HostedReferenceTransportError && error.retryable;
}

export function validateHostedReferenceAssetBaseUrl(
  rawValue: string,
  allowLoopbackHttpForTests: boolean
): URL {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('Hosted reference asset base URL must be an absolute URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Hosted reference asset base URL cannot contain credentials, query, or hash.');
  }
  const loopbackHttp =
    allowLoopbackHttpForTests && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('Hosted reference assets require HTTPS.');
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

export function resolveHostedReferenceAssetUrl(baseUrl: URL, relativePath: string): URL {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.includes('?') ||
    relativePath.includes('#')
  ) {
    throw new Error(`Hosted reference asset path must be relative: ${relativePath}`);
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    throw new Error(`Hosted reference asset path is not valid URL text: ${relativePath}`);
  }
  if (
    decodedPath.includes('\\') ||
    decodedPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Hosted reference asset path contains an unsafe segment: ${relativePath}`);
  }
  const resolved = new URL(relativePath, baseUrl);
  if (resolved.origin !== baseUrl.origin) {
    throw new Error('Hosted reference assets must use the configured origin.');
  }
  return resolved;
}

function mergeRequestHeaders(
  input: RequestInit['headers'],
  rangeStart: number | undefined
): Record<string, string> | undefined {
  const headers = new Map<string, { name: string; value: string }>();
  const set = (name: string, value: string): void => {
    headers.set(name.toLowerCase(), { name, value });
  };
  if (Array.isArray(input)) {
    for (const [name, value] of input) set(name, value);
  } else if (input && typeof (input as Headers).forEach === 'function') {
    (input as Headers).forEach((value, name) => set(name, value));
  } else if (input) {
    for (const [name, value] of Object.entries(input)) set(name, value);
  }
  if (rangeStart !== undefined) set('Range', `bytes=${rangeStart}-`);
  if (headers.size === 0) return undefined;
  return Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));
}

export async function requestHostedReferenceAsset(input: {
  readonly url: URL;
  readonly label: string;
  readonly fetchAsset: HostedReferenceFetch;
  readonly signal: AbortSignal;
  readonly headers?: RequestInit['headers'];
  readonly redirect?: RequestInit['redirect'];
  readonly rangeStart?: number;
  readonly stallTimeoutMs?: number;
  readonly responseHeaderTimeoutMs?: number;
  readonly bodyReadGate?: HostedReferenceBodyReadGate;
}): Promise<Response> {
  const stallTimeoutMs = input.stallTimeoutMs ?? HOSTED_REFERENCE_STALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs < 1) {
    throw new Error('Hosted reference stall timeout must be a positive integer.');
  }
  const responseHeaderTimeoutMs =
    input.responseHeaderTimeoutMs ?? HOSTED_REFERENCE_RESPONSE_HEADER_TIMEOUT_MS;
  if (!Number.isSafeInteger(responseHeaderTimeoutMs) || responseHeaderTimeoutMs < 1) {
    throw new Error('Hosted reference response header timeout must be a positive integer.');
  }
  const requestController = new AbortController();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    input.signal.removeEventListener('abort', forwardCancellation);
  };
  const forwardCancellation = (): void => {
    requestController.abort(input.signal.reason);
  };
  input.signal.addEventListener('abort', forwardCancellation, { once: true });
  if (input.signal.aborted) forwardCancellation();
  const bodyReadGate = input.bodyReadGate ?? processWideBodyReadGate;
  let reservedBodyBytes = 0;

  const reserveBodyBytes = async (bytes: number): Promise<void> => {
    if (!bodyReadGate || bytes <= 0) return;
    let remaining = bytes;
    while (remaining > 0) {
      const reservation = Math.min(remaining, HOSTED_REFERENCE_BODY_READ_RESERVATION_BYTES);
      await bodyReadGate.reserve(reservation, requestController.signal);
      reservedBodyBytes += reservation;
      remaining -= reservation;
    }
  };

  let response: Response;
  try {
    if (bodyReadGate) {
      await reserveBodyBytes(HOSTED_REFERENCE_BODY_READ_RESERVATION_BYTES);
    }
    const headers = mergeRequestHeaders(input.headers, input.rangeStart);
    response = await waitForNetworkProgress({
      operation: input.fetchAsset(input.url, {
        method: 'GET',
        redirect: input.redirect ?? 'follow',
        cache: 'no-store',
        signal: requestController.signal,
        headers,
      }),
      signal: requestController.signal,
      stallTimeoutMs: responseHeaderTimeoutMs,
      stallError: () => responseHeaderTimeoutError(input.label, responseHeaderTimeoutMs),
      onStall: (error) => requestController.abort(error),
    });
  } catch (error) {
    dispose();
    throw normalizeTransportError(input, error);
  }
  try {
    assertHostedReferenceResponseOrigin(response, input.url);
  } catch (error) {
    dispose();
    throw error;
  }
  if (isRetryableHttpStatus(response.status)) {
    dispose();
    void response.body?.cancel().catch(() => undefined);
    throw new HostedReferenceTransportError(
      `Could not download hosted ${input.label}: HTTP ${response.status}.`,
      {
        retryable: true,
        responseStatus: response.status,
        contentRange: response.headers.get('content-range'),
      }
    );
  }
  if (!response.body || !response.ok) {
    dispose();
    return response;
  }

  const reader = (() => {
    if (!bodyReadGate) {
      const source = response.body.getReader();
      return {
        read: () => source.read(),
        cancel: (reason?: unknown) => source.cancel(reason),
      };
    }
    try {
      const source = response.body.getReader({ mode: 'byob' });
      return {
        read: () => {
          const byteLength = Math.min(
            reservedBodyBytes,
            HOSTED_REFERENCE_BODY_READ_RESERVATION_BYTES
          );
          if (byteLength < 1) {
            return Promise.reject(
              new Error('Hosted reference body read started without a reserved byte.')
            );
          }
          return source.read(new Uint8Array(byteLength));
        },
        cancel: (reason?: unknown) => source.cancel(reason),
      };
    } catch (error) {
      dispose();
      void response.body.cancel(error).catch(() => undefined);
      throw new Error(
        'Hosted reference transfer was blocked because bounded body reads are unavailable under the shared download policy.',
        { cause: error }
      );
    }
  })();
  const monitoredBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (bodyReadGate && reservedBodyBytes === 0) {
          await reserveBodyBytes(HOSTED_REFERENCE_BODY_READ_RESERVATION_BYTES);
        }
        const next = await waitForNetworkProgress({
          operation: reader.read(),
          signal: requestController.signal,
          stallTimeoutMs,
          stallError: () => stalledRequestError(input.label, stallTimeoutMs),
          onStall: (error) => requestController.abort(error),
        });
        if (next.done) {
          dispose();
          controller.close();
          return;
        }
        if (bodyReadGate && next.value.byteLength > reservedBodyBytes) {
          throw new Error('Hosted reference body exceeded its reserved byte allowance.');
        }
        reservedBodyBytes -= next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        dispose();
        void reader.cancel(error).catch(() => undefined);
        controller.error(normalizeTransportError(input, error));
      }
    },
    async cancel(reason) {
      dispose();
      requestController.abort(reason);
      await reader.cancel(reason);
    },
  });
  return new Response(monitoredBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function waitForNetworkProgress<T>(input: {
  readonly operation: Promise<T>;
  readonly signal: AbortSignal;
  readonly stallTimeoutMs: number;
  readonly stallError: () => HostedReferenceTransportError;
  readonly onStall: (error: HostedReferenceTransportError) => void;
}): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason =
        input.signal.reason ??
        new HostedReferenceTransportError('Hosted reference download was cancelled.', {
          retryable: false,
        });
      finish(() => reject(reason));
    };
    const timer = setTimeout(() => {
      const error = input.stallError();
      input.onStall(error);
      finish(() => reject(error));
    }, input.stallTimeoutMs);
    timer.unref?.();
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    input.operation.then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function stalledRequestError(label: string, stallTimeoutMs: number): HostedReferenceTransportError {
  return new HostedReferenceTransportError(
    `Could not download hosted ${label}: no network progress for ${stallTimeoutMs} ms.`,
    { retryable: true }
  );
}

function responseHeaderTimeoutError(
  label: string,
  responseHeaderTimeoutMs: number
): HostedReferenceTransportError {
  return new HostedReferenceTransportError(
    `Could not download hosted ${label}: response headers exceeded the ${responseHeaderTimeoutMs} ms timeout.`,
    { retryable: true }
  );
}

function normalizeTransportError(
  input: Readonly<{ label: string; signal: AbortSignal }>,
  error: unknown
): unknown {
  if (error instanceof HostedReferenceTransportError) return error;
  if (isLocalResourceError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const aborted =
    input.signal.aborted ||
    Boolean(
      error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError'
    );
  if (aborted) {
    return new HostedReferenceTransportError(
      `Could not download hosted ${input.label}: download was cancelled.`,
      { cause: error, retryable: false, kind: 'abort' }
    );
  }
  return new HostedReferenceTransportError(`Could not download hosted ${input.label}: ${detail}`, {
    cause: error,
    retryable: true,
  });
}

const LOCAL_RESOURCE_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

function isLocalResourceError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    LOCAL_RESOURCE_ERROR_CODES.has((error as { code: string }).code)
  );
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function assertHostedReferenceResponseOrigin(response: Response, requestedUrl: URL): void {
  if (!response.url) return;
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== requestedUrl.origin) {
    throw new Error('Hosted reference asset redirect changed origin.');
  }
  if (responseUrl.protocol !== requestedUrl.protocol) {
    throw new Error('Hosted reference asset redirect changed transport.');
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
