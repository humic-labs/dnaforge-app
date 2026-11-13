export async function forEachSyncFileBounded<T>(
  files: readonly T[],
  signal: AbortSignal | undefined,
  transfer: (file: T, signal: AbortSignal) => Promise<void>
): Promise<void> {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      try {
        while (next < files.length && !failure) {
          requestSignal.throwIfAborted();
          const file = files[next++];
          await transfer(file, requestSignal);
        }
      } catch (error) {
        failure ??= { error };
        controller.abort(error);
      }
    })
  );
  if (failure) throw failure.error;
  requestSignal.throwIfAborted();
}
