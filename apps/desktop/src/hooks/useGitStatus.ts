import { useState, useEffect, useCallback, useRef } from 'react';
import { isGitRepo, gitStatus, type GitFileStatus } from '../features/workspace/git';

const subscribers = new Map<string, Set<() => void>>();

export function notifyGitStatusChanged(folderPath: string): void {
  subscribers.get(folderPath)?.forEach((fn) => fn());
}

type GitStatusData = { statusMap: Map<string, GitFileStatus>; isTracked: boolean };
type GitStatusState =
  | { phase: 'idle'; folder: null }
  | { phase: 'loading' | 'ready' | 'error'; folder: string; data: GitStatusData };

const emptyStatus: GitStatusData = { statusMap: new Map(), isTracked: false };

export function useGitStatus(folderPath: string | null) {
  const [state, setState] = useState<GitStatusState>({ phase: 'idle', folder: null });
  const scope = useRef<{ folder: string | null } | null>(null);
  const currentRequest = useRef<object | null>(null);

  const refresh = useCallback(async () => {
    const owner = scope.current;
    if (!owner || owner.folder !== folderPath) return;
    const request = {};
    currentRequest.current = request;
    const isCurrent = () => scope.current === owner && currentRequest.current === request;
    if (!folderPath) {
      setState({ phase: 'idle', folder: null });
      return;
    }
    setState((previous) => ({
      phase: 'loading',
      folder: folderPath,
      data:
        previous.phase !== 'idle' && previous.folder === folderPath ? previous.data : emptyStatus,
    }));
    try {
      const tracked = await isGitRepo(folderPath);
      if (!isCurrent()) return;
      const status = tracked ? await gitStatus(folderPath) : new Map<string, GitFileStatus>();
      if (!isCurrent()) return;
      setState({
        phase: 'ready',
        folder: folderPath,
        data: { isTracked: tracked, statusMap: status },
      });
    } catch {
      if (isCurrent()) setState({ phase: 'error', folder: folderPath, data: emptyStatus });
    }
  }, [folderPath]);

  useEffect(() => {
    const owner = { folder: folderPath };
    scope.current = owner;
    void refresh();
    if (folderPath) {
      if (!subscribers.has(folderPath)) subscribers.set(folderPath, new Set());
      subscribers.get(folderPath)!.add(refresh);
    }
    return () => {
      if (scope.current === owner) {
        scope.current = null;
        currentRequest.current = null;
      }
      if (!folderPath) return;
      const subs = subscribers.get(folderPath);
      if (!subs) return;
      subs.delete(refresh);
      if (subs.size === 0) subscribers.delete(folderPath);
    };
  }, [folderPath, refresh]);

  const data = state.phase !== 'idle' && state.folder === folderPath ? state.data : emptyStatus;
  return { ...data, refresh };
}
