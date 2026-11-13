type HostedFileChangedListener = (path: string) => void;

const fileChangedListeners = new Set<HostedFileChangedListener>();

export function emitHostedFileChanged(path: string): void {
  for (const listener of fileChangedListeners) listener(path);
}

export function subscribeHostedFileChanged(listener: HostedFileChangedListener): () => void {
  fileChangedListeners.add(listener);
  return () => {
    fileChangedListeners.delete(listener);
  };
}
