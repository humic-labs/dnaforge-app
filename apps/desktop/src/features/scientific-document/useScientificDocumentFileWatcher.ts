import { useCallback, useEffect, useRef, useState } from 'react';

import { platform } from '../../platform';

type ScientificDocumentFileWatcherOptions = {
  filePath: string;
  isDirty: boolean;
  onReload: (discardChanges: boolean) => Promise<boolean>;
};

type ScientificDocumentFileWatcherResult = {
  externalChangePending: boolean;
  acceptExternalChange: () => void;
  dismissExternalChange: () => void;
  suppressNextChange: () => void;
};

const SELF_WRITE_SUPPRESS_MS = 1_200;

export function useScientificDocumentFileWatcher({
  filePath,
  isDirty,
  onReload,
}: ScientificDocumentFileWatcherOptions): ScientificDocumentFileWatcherResult {
  const [externalChangePending, setExternalChangePending] = useState(false);
  const dirtyRef = useRef(isDirty);
  const onReloadRef = useRef(onReload);
  const suppressUntilRef = useRef(0);
  dirtyRef.current = isDirty;
  onReloadRef.current = onReload;

  const reload = useCallback((discardChanges = false) => {
    setExternalChangePending(false);
    void onReloadRef.current(discardChanges).then((adopted) => setExternalChangePending(!adopted));
  }, []);

  const suppressNextChange = useCallback(() => {
    suppressUntilRef.current = Date.now() + SELF_WRITE_SUPPRESS_MS;
  }, []);

  useEffect(() => {
    if (!filePath) return;
    platform()
      .fs.watchFile(filePath)
      .catch((watchError: unknown) => {
        console.warn('[ScientificDocumentTab] Failed to watch file:', watchError);
      });

    const unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
      if (args[0] !== filePath || Date.now() < suppressUntilRef.current) return;
      if (dirtyRef.current) {
        setExternalChangePending(true);
      } else {
        reload();
      }
    });

    return () => {
      platform()
        .fs.unwatchFile(filePath)
        .catch(() => {});
      unsubscribe();
    };
  }, [filePath, reload]);

  return {
    externalChangePending,
    acceptExternalChange: () => reload(true),
    dismissExternalChange: useCallback(() => setExternalChangePending(false), []),
    suppressNextChange,
  };
}
