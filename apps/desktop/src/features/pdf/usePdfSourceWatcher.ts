import { useEffect, useRef } from 'react';
import { platform } from '../../platform';

export function usePdfSourceWatcher(
  filePath: string,
  changed: () => void,
  unavailable: () => void
): void {
  const callbacks = useRef({ changed, unavailable });
  callbacks.current = { changed, unavailable };
  useEffect(() => {
    let disposed = false;
    let acquired = false;
    const bridge = platform();
    const unsubscribe = bridge.on('file-changed', (...args: unknown[]) => {
      if (!disposed && args[0] === filePath) callbacks.current.changed();
    });
    void bridge.fs
      .watchFile(filePath)
      .then(() => {
        acquired = true;
        if (disposed) void bridge.fs.unwatchFile(filePath).catch(() => {});
      })
      .catch(() => {
        if (!disposed) callbacks.current.unavailable();
      });
    return () => {
      disposed = true;
      unsubscribe();
      if (acquired) void bridge.fs.unwatchFile(filePath).catch(() => {});
    };
  }, [filePath]);
}
