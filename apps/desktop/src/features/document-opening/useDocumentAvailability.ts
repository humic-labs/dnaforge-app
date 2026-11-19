import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  isMolecularDocumentFile,
  type DocumentAvailability,
} from '../../shared/document-availability';

const unchecked = { state: 'unchecked' } as const;

export function useDocumentAvailability(
  workspaceRoot: string | undefined,
  path: string | undefined
): DocumentAvailability | { state: 'checking' } | undefined {
  const canCheck = Boolean(workspaceRoot && path && isMolecularDocumentFile(path));
  const refresh = useWorkspaceStore((state) => (canCheck ? state.fileTreeRefreshToken : 0));
  const [result, setResult] = useState<{
    workspaceRoot: string;
    path: string;
    refresh: number;
    availability?: DocumentAvailability;
  }>();

  useEffect(() => {
    if (!canCheck || !workspaceRoot || !path) return;
    const { workspace, fs, on } = platform();
    if (!workspace?.checkDocument) return;
    let disposed = false;
    let attempt = 0;
    const update = (availability?: DocumentAvailability) =>
      setResult({ workspaceRoot, path, refresh, availability });
    const check = async () => {
      const current = ++attempt;
      update();
      const availability = await workspace.checkDocument!({ workspaceRoot, path }).catch(
        () => unchecked
      );
      if (!disposed && current === attempt) update(availability);
    };
    const stopListening = on('file-changed', (changed) => {
      if (changed === path) void check();
    });
    const watching = fs.watchFile(path).then(
      () => true,
      () => false
    );
    void watching.then((started) => {
      if (!disposed && started) return check();
      if (!disposed) update(unchecked);
    });
    return () => {
      disposed = true;
      stopListening();
      void watching
        .then((started) => {
          if (started) return fs.unwatchFile(path);
        })
        .catch(() => {});
    };
  }, [canCheck, workspaceRoot, path, refresh]);

  if (!path) return;
  if (!canCheck || !platform().workspace?.checkDocument) return unchecked;
  if (result?.path === path && result.workspaceRoot === workspaceRoot && result.refresh === refresh)
    return result.availability ?? { state: 'checking' };
  return { state: 'checking' };
}
