import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '../../platform';
import {
  workReminderCommandSchema,
  type WorkReminderCommand,
  type WorkReminderRequest,
  type WorkReminderView,
} from '../../shared/work-reminders-ipc';
import { observeWorkChanges, useWorkAccount } from './use-work-query';

export function useWorkReminders(workspaceRoot: string) {
  const account = useWorkAccount();
  const key = JSON.stringify(['work-reminder-request', workspaceRoot, account]);
  const current = useRef(key);
  current.current = key;
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    view?: WorkReminderView;
    error?: string;
  }>();
  const [pending, setPending] = useState<{ key: string; request: WorkReminderRequest } | null>(
    null
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [blockedKey, setBlockedKey] = useState<string | null>(null);
  const busy = busyKey === key;
  useEffect(() => observeWorkChanges(refresh), [refresh]);
  useEffect(() => {
    let active = true;
    let recoveryError: string | undefined;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const request = JSON.parse(raw) as WorkReminderRequest;
        if (request.workspaceRoot !== workspaceRoot || typeof request.requestId !== 'string')
          throw new Error('Reminder recovery is unavailable.');
        workReminderCommandSchema.parse(request.command);
        setPending({ key, request });
      }
    } catch (cause) {
      recoveryError = cause instanceof Error ? cause.message : 'Reminder recovery is unavailable.';
      setBlockedKey(key);
      setSnapshot({ key, error: recoveryError });
    }
    platform()
      .workTasks.reminders({ workspaceRoot })
      .then((view) => {
        if (active) {
          if (view.pendingHandoff && !localStorage.getItem(key)) {
            const request: WorkReminderRequest = {
              workspaceRoot,
              requestId: view.pendingHandoff.requestId,
              command: { action: 'handoff', expectedEpoch: view.pendingHandoff.expectedEpoch },
            };
            localStorage.setItem(key, JSON.stringify(request));
            setPending({ key, request });
          }
          setSnapshot({ key, view, error: recoveryError });
        }
      })
      .catch((cause) => {
        if (active)
          setSnapshot({
            key,
            error: cause instanceof Error ? cause.message : 'Reminders are unavailable.',
          });
      });
    return () => {
      active = false;
    };
  }, [key, workspaceRoot, generation]);

  async function submit(request: WorkReminderRequest, retry = false) {
    setBusyKey(key);
    try {
      const result = await platform().workTasks.reminderCommand(request);
      if (retry && result.outcome === 'rejected') {
        if (current.current === key)
          setSnapshot((previous) => ({
            ...previous,
            key,
            error: result.error + ' The earlier request still needs confirmation.',
          }));
        return null;
      }
      localStorage.removeItem(key);
      if (current.current === key) {
        setPending(null);
        if (result.outcome === 'rejected')
          setSnapshot((previous) => ({ ...previous, key, error: result.error }));
        else refresh();
      }
      return result;
    } catch (cause) {
      if (current.current === key)
        setSnapshot((previous) => ({
          ...previous,
          key,
          error:
            cause instanceof Error
              ? cause.message
              : 'The reply was interrupted. Retry this request to recover its result.',
        }));
      return null;
    } finally {
      if (current.current === key) setBusyKey(null);
    }
  }
  async function run(command: WorkReminderCommand) {
    if (busy || pending?.key === key || blockedKey === key) return null;
    const request = { workspaceRoot, requestId: crypto.randomUUID(), command };
    try {
      localStorage.setItem(key, JSON.stringify(request));
      setPending({ key, request });
      return await submit(request);
    } catch (cause) {
      setSnapshot((previous) => ({
        ...previous,
        key,
        error: cause instanceof Error ? cause.message : 'Could not preserve this reminder request.',
      }));
      return null;
    }
  }
  return {
    ...(snapshot?.key === key ? snapshot : {}),
    busy,
    blocked: blockedKey === key,
    pending: pending?.key === key ? pending.request : null,
    run,
    retry: () => (pending?.key === key ? submit(pending.request, true) : Promise.resolve(null)),
    refresh,
  };
}
