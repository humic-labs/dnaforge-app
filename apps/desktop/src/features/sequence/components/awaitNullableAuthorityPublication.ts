const PUBLICATION_DEADLINE_MS = 30_000;
const INITIAL_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 1_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function readNullableAuthorityUntilPublishedV1<T>(input: {
  readonly read: (signal: AbortSignal) => Promise<T | null>;
  readonly signal: AbortSignal;
  readonly authorityLabel?: string;
  readonly deadlineReady?: () => boolean;
  readonly deadlineMs?: number;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}): Promise<T> {
  const deadlineMs = input.deadlineMs ?? PUBLICATION_DEADLINE_MS;
  const initialRetryDelayMs = input.initialRetryDelayMs ?? INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = input.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
  const deadlineError = new Error(
    `${input.authorityLabel ?? 'The requested authority'} was not published within ${deadlineMs} ms.`
  );
  const requestController = new AbortController();
  const abortFromOwner = (): void => requestController.abort(abortReason(input.signal));
  if (input.signal.aborted) abortFromOwner();
  else input.signal.addEventListener('abort', abortFromOwner, { once: true });
  let deadlineStartedAt: number | null = null;
  let deadlineTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const activateDeadlineIfReady = (): void => {
    if (deadlineStartedAt !== null || !(input.deadlineReady?.() ?? true)) return;
    deadlineStartedAt = performance.now();
    deadlineTimer = globalThis.setTimeout(() => requestController.abort(deadlineError), deadlineMs);
  };
  activateDeadlineIfReady();
  let retryDelayMs = initialRetryDelayMs;
  let result: T | null = null;

  try {
    while (result === null && !requestController.signal.aborted) {
      result = await awaitWithAbort(input.read(requestController.signal), requestController.signal);
      if (result !== null) break;
      activateDeadlineIfReady();
      const remainingMs =
        deadlineStartedAt === null
          ? Number.POSITIVE_INFINITY
          : deadlineMs - (performance.now() - deadlineStartedAt);
      if (remainingMs <= 0) {
        requestController.abort(deadlineError);
        throw deadlineError;
      }
      await waitForRetry(Math.min(retryDelayMs, remainingMs), requestController.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
    }
    if (result === null) throw abortReason(requestController.signal);
    return result;
  } catch (error) {
    if (requestController.signal.reason === deadlineError) throw deadlineError;
    throw error;
  } finally {
    if (deadlineTimer !== null) globalThis.clearTimeout(deadlineTimer);
    input.signal.removeEventListener('abort', abortFromOwner);
  }
}
