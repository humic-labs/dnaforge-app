import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { platform } from '../../platform';
import type { WorkTaskQuery, WorkTaskQueryResult } from '../../shared/work-tasks-ipc';
import { getDesktopAuthSnapshot, subscribeDesktopAuthSnapshot } from '../auth/public/auth-state';
import { WORK_TASK_CHANGED } from './task-presentation';
import { WORKSPACE_FILES_CHANGED_EVENT } from '../../services/workspace-files-changed-event';
import { WORKSPACE_RECONCILED_EVENT } from '../../services/workspace-reconciled-event';
import { ENTITY_PROJECTION_UPDATED_EVENT } from '../../db/entity-substrate/adapter-events';

function accountKey() {
  const { state } = getDesktopAuthSnapshot();
  return state.status === 'signed-in' ? state.session.accountId : state.status;
}
export function useWorkAccount() {
  return useSyncExternalStore(subscribeDesktopAuthSnapshot, accountKey);
}

export function observeWorkChanges(refresh: () => void) {
  const events = [
    WORK_TASK_CHANGED,
    WORKSPACE_FILES_CHANGED_EVENT,
    WORKSPACE_RECONCILED_EVENT,
    ENTITY_PROJECTION_UPDATED_EVENT,
    'focus',
  ];
  for (const name of events) window.addEventListener(name, refresh);
  const timer = window.setInterval(() => {
    if (!document.hidden) refresh();
  }, 60_000);
  document.addEventListener('visibilitychange', refresh);
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = platform().workspaceMutations?.onLifecycle((event) => {
      if (event.phase === 'applied') refresh();
    });
  } catch {
    unsubscribe = undefined;
  }
  return () => {
    for (const name of events) window.removeEventListener(name, refresh);
    document.removeEventListener('visibilitychange', refresh);
    clearInterval(timer);
    unsubscribe?.();
  };
}
export function useWorkQuery(input: WorkTaskQuery) {
  const key = JSON.stringify(input);
  const account = useWorkAccount();
  const scope = JSON.stringify([key, account]);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    result?: WorkTaskQueryResult;
    error?: string;
  }>();
  useEffect(() => observeWorkChanges(refresh), [refresh]);
  useEffect(() => {
    let current = true;
    async function read() {
      try {
        const query: WorkTaskQuery = JSON.parse(key);
        const client = platform().workTasks;
        if (!client) throw new Error('This workspace does not support task scheduling.');
        const first = await client.query({ ...query, offset: 0, limit: 100 });
        const tasks = [...first.tasks];
        let offset = first.nextOffset;
        while (current && offset !== null) {
          const next = await client.query({ ...query, offset, limit: 100, asOf: first.now });
          if (!first.snapshotId || next.snapshotId !== first.snapshotId)
            throw new Error('Tasks changed while loading. Refresh to try again.');
          if (next.nextOffset !== null && next.nextOffset <= offset)
            throw new Error('Task list changed during loading. Refresh to try again.');
          tasks.push(...next.tasks);
          offset = next.nextOffset;
        }
        if (current) {
          const unique = new Map(
            tasks.map((task) => [JSON.stringify([task.project.id, task.id]), task])
          );
          setSnapshot({ scope, result: { ...first, tasks: [...unique.values()] } });
        }
      } catch (cause) {
        if (current)
          setSnapshot({
            scope,
            error: cause instanceof Error ? cause.message : 'Could not load work.',
          });
      }
    }
    void read();
    return () => {
      current = false;
    };
  }, [scope, key, generation]);
  return { ...(snapshot?.scope === scope ? snapshot : {}), refresh };
}
