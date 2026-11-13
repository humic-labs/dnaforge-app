import { useEffect, useReducer, useCallback } from 'react';
import { isGitInstalled, isGitRepo, hasCommits } from '../features/workspace/git';

export type FolderGitState = 'loading' | 'no-git' | 'not-initialized' | 'no-commits' | 'tracked';

const cache = new Map<string, FolderGitState>();
const subscribers = new Map<string, Set<() => void>>();
const inFlight = new Map<string, Promise<FolderGitState>>();

async function detectFolderGitState(folderPath: string): Promise<FolderGitState> {
  try {
    const installed = await isGitInstalled();
    if (!installed) return 'no-git';
    const isRepo = await isGitRepo(folderPath);
    if (!isRepo) return 'not-initialized';
    const hasAny = await hasCommits(folderPath);
    return hasAny ? 'tracked' : 'no-commits';
  } catch {
    return 'no-git';
  }
}

function notify(folderPath: string) {
  subscribers.get(folderPath)?.forEach((fn) => fn());
}

async function loadIntoCache(folderPath: string) {
  let p = inFlight.get(folderPath);
  if (!p) {
    p = detectFolderGitState(folderPath);
    inFlight.set(folderPath, p);
  }
  const state = await p;
  inFlight.delete(folderPath);
  cache.set(folderPath, state);
  notify(folderPath);
  return state;
}

export function useFolderGitState(folderPath: string | null) {
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!folderPath) return;
    const callback = () => force();
    if (!subscribers.has(folderPath)) subscribers.set(folderPath, new Set());
    subscribers.get(folderPath)!.add(callback);

    if (!cache.has(folderPath)) {
      void loadIntoCache(folderPath);
    }

    return () => {
      const subs = subscribers.get(folderPath);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) subscribers.delete(folderPath);
      }
    };
  }, [folderPath]);

  const refresh = useCallback(async () => {
    if (!folderPath) return;
    cache.delete(folderPath);
    await loadIntoCache(folderPath);
  }, [folderPath]);

  const state: FolderGitState = folderPath ? (cache.get(folderPath) ?? 'loading') : 'loading';
  return { state, refresh };
}
