import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { DocumentAvailability } from '../../shared/document-availability';
import { checkDocumentOpen } from './check-document-open';

const unchecked = { state: 'unchecked' } as const;
const checking = { state: 'checking' } as const;
const maxConcurrentChecks = 3;
const queuedChecks: (() => void)[] = [];
let runningChecks = 0;

async function limitBackgroundChecks(operation: () => Promise<void>) {
  if (runningChecks === maxConcurrentChecks)
    await new Promise<void>((resolve) => queuedChecks.push(resolve));
  else runningChecks++;
  try {
    await operation();
  } finally {
    const next = queuedChecks.shift();
    if (next) next();
    else runningChecks--;
  }
}

export function useDocumentAvailability(
  workspaceRoot: string | undefined,
  path: string | undefined,
  isPackage = false
): DocumentAvailability | typeof checking | undefined {
  const canCheck = Boolean(workspaceRoot && path && platform().workspace?.checkDocument);
  const refresh = useWorkspaceStore((state) => (canCheck ? state.fileTreeRefreshToken : 0));
  const [result, setResult] = useState<{
    workspaceRoot: string | undefined;
    path: string;
    isPackage: boolean;
    refresh: number;
    availability?: DocumentAvailability;
  }>();

  useEffect(() => {
    if (!canCheck || !path) return;
    const { fs, on } = platform();
    let disposed = false;
    let attempt = 0;
    let running = false;
    const watches = new Map<string, Promise<boolean>>();
    const update = (availability?: DocumentAvailability) =>
      setResult({ workspaceRoot, path, isPackage, refresh, availability });
    const watch = (target: string) => {
      if (watches.has(target)) return;
      watches.set(
        target,
        fs.watchFile(target).then(
          () => true,
          () => false
        )
      );
    };
    const unwatch = (target: string, watchResult: Promise<boolean>) => {
      void watchResult
        .then((started) => {
          if (started) return fs.unwatchFile(target);
        })
        .catch(() => {});
    };
    const check = () => {
      attempt++;
      update();
      if (running) return;
      running = true;
      void limitBackgroundChecks(async () => {
        try {
          while (!disposed) {
            const current = attempt;
            const availability = await checkDocumentOpen({
              workspaceRoot,
              path,
              package: isPackage,
            });
            if (disposed) return;
            if (current !== attempt) continue;
            const needed = new Set([
              path,
              ...('paths' in availability ? (availability.paths ?? []) : []),
            ]);
            for (const target of needed) watch(target);
            for (const [target, watcher] of watches) {
              if (needed.has(target)) continue;
              unwatch(target, watcher);
              watches.delete(target);
            }
            update(availability);
            return;
          }
        } finally {
          running = false;
        }
      });
    };
    const stopListening = on('file-changed', (changed) => {
      if (watches.has(changed)) check();
    });
    watch(path);
    check();
    return () => {
      disposed = true;
      stopListening();
      for (const [target, watcher] of watches) unwatch(target, watcher);
    };
  }, [canCheck, workspaceRoot, path, refresh, isPackage]);

  if (!path) return;
  if (!canCheck) return unchecked;
  if (
    result?.path === path &&
    result.workspaceRoot === workspaceRoot &&
    result.isPackage === isPackage &&
    result.refresh === refresh
  )
    return result.availability ?? checking;
  return checking;
}
