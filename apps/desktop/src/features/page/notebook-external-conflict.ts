export function isExternalConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    candidate.name === 'NotebookExternalConflictError' ||
    candidate.code === 'NOTEBOOK_EXTERNAL_CONFLICT' ||
    (typeof candidate.message === 'string' &&
      /(?:NOTEBOOK_EXTERNAL_CONFLICT|changed (?:on disk|since it was opened))/i.test(
        candidate.message
      ))
  );
}
