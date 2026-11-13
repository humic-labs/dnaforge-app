function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function composeAbortSignal(
  signals: Array<AbortSignal | undefined>,
  timeoutMs?: number
): AbortSignal | undefined {
  const activeSignals = signals.filter(Boolean) as AbortSignal[];
  if (timeoutMs !== undefined) {
    activeSignals.push(AbortSignal.timeout(timeoutMs));
  }
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  const abortSignalCtor = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof abortSignalCtor.any === 'function') {
    return abortSignalCtor.any(activeSignals);
  }

  const controller = new AbortController();
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason ?? createAbortError('Operation aborted'));
    }
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function createTimeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} TIMEOUT after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

export async function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  parentSignal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason ?? createAbortError(`${label} aborted`));
    }
  };
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = createTimeoutError(label, timeoutMs);
      if (!controller.signal.aborted) controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
}

export async function runCliMain(
  label: string,
  run: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const controller = new AbortController();
  const abort = (eventLabel: string) => {
    if (controller.signal.aborted) return;
    controller.abort(createAbortError(`${label} aborted by ${eventLabel}`));
  };

  const onSigint = () => abort('SIGINT');
  const onSigterm = () => abort('SIGTERM');

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    await run(controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
