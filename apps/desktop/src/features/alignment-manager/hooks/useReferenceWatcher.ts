import { useEffect, useRef } from 'react';
import { platform } from '../../../platform';

export function useReferenceWatcher(referencePath: string, onFileChanged: () => void): void {
  const onFileChangedRef = useRef(onFileChanged);
  onFileChangedRef.current = onFileChanged;

  useEffect(() => {
    if (!referencePath) return;

    platform()
      .fs.watchFile(referencePath)
      .catch((err) => {
        console.warn('[useReferenceWatcher] Failed to start watching:', err);
      });

    const unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
      const changedPath = args[0] as string;
      if (changedPath === referencePath) {
        onFileChangedRef.current();
      }
    });

    return () => {
      platform()
        .fs.unwatchFile(referencePath)
        .catch(() => {});
      unsubscribe();
    };
  }, [referencePath]);
}
