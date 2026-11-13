const hostedHistoryTails = new Map<string, Promise<void>>();

export function withAlignmentHistoryAccess<T>(
  sourcePath: string,
  action: () => Promise<T>
): Promise<T> {
  if (!sourcePath.startsWith('/hosted/')) return action();
  const previous = hostedHistoryTails.get(sourcePath) ?? Promise.resolve();
  const result = previous.then(action);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  hostedHistoryTails.set(sourcePath, settled);
  void settled.then(() => {
    if (hostedHistoryTails.get(sourcePath) === settled) hostedHistoryTails.delete(sourcePath);
  });
  return result;
}
