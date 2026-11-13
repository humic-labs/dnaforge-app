const RETRY_DELAYS_MS = [200, 600] as const;

export async function fetchBbiRangeWithRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fetchImpl?: typeof fetch
): Promise<Response> {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await (fetchImpl ? fetchImpl(input, init) : fetch(input, init));
    } catch (error) {
      if (signal?.aborted || attempt >= RETRY_DELAYS_MS.length) throw error;
      await waitForRetry(RETRY_DELAYS_MS[attempt], signal);
      continue;
    }
    if (!isRetryableStatus(response.status) || attempt >= RETRY_DELAYS_MS.length) {
      return response;
    }
    try {
      await response.body?.cancel();
    } catch {}
    await waitForRetry(RETRY_DELAYS_MS[attempt], signal);
  }
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 503 ||
    status === 504
  );
}

function waitForRetry(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
