const notebookAuthorityTails = new Map<string, Promise<void>>();

export async function withNotebookAuthorityOperation<T>(
  pageId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = notebookAuthorityTails.get(pageId) ?? Promise.resolve();
  let release = (): void => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  notebookAuthorityTails.set(pageId, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (notebookAuthorityTails.get(pageId) === tail) notebookAuthorityTails.delete(pageId);
  }
}
