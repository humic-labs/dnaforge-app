export async function readBbiWithSharedAbortRecovery<T>(
  operation: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw new DOMException('BBI read canceled.', 'AbortError');
  try {
    return await operation();
  } catch (error) {
    const abort = findAbortCause(error);
    if (signal.aborted) throw new DOMException('BBI read canceled.', 'AbortError');
    if (!abort) throw error;
    return operation();
  }
}

function findAbortCause(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current !== 'object') return false;
    if ('name' in current && current.name === 'AbortError') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
