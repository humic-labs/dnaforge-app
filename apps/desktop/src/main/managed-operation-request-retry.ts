import { ApiResponseParseError, isApiError } from '@waypoint/api-client';

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export type ManagedOperationRetryDelay = (
  milliseconds: number,
  signal?: AbortSignal
) => Promise<void>;

interface ManagedOperationRequestRetryOptions {
  readonly signal?: AbortSignal;
  readonly delay?: ManagedOperationRetryDelay;
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export function managedOperationAbortError(): Error {
  return Object.assign(new Error('Stopped waiting for managed operation.'), {
    name: 'AbortError',
  });
}

export function throwIfManagedOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw managedOperationAbortError();
}

export function delayManagedOperationRequest(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfManagedOperationAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(managedOperationAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function hasRetryableNetworkCode(error: unknown, depth = 0): boolean {
  if (depth > 3 || typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly cause?: unknown };
  if (typeof candidate.code === 'string' && RETRYABLE_NETWORK_CODES.has(candidate.code)) {
    return true;
  }
  return hasRetryableNetworkCode(candidate.cause, depth + 1);
}

export function isRetryableManagedOperationRequestError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (isApiError(error)) {
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    );
  }
  return (
    error instanceof TypeError ||
    error instanceof ApiResponseParseError ||
    hasRetryableNetworkCode(error)
  );
}

export async function retryIdempotentManagedOperationRequest<T>(
  request: () => Promise<T>,
  options: ManagedOperationRequestRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const delay = options.delay ?? delayManagedOperationRequest;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Managed-operation request attempts must be a positive integer.');
  }
  if (
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < initialDelayMs
  ) {
    throw new Error('Managed-operation request retry delays are invalid.');
  }

  for (let attempt = 1; ; attempt += 1) {
    throwIfManagedOperationAborted(options.signal);
    try {
      return await request();
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt >= maxAttempts ||
        !isRetryableManagedOperationRequestError(error)
      ) {
        throw error;
      }
      const retryDelayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      await delay(retryDelayMs, options.signal);
      throwIfManagedOperationAborted(options.signal);
    }
  }
}
