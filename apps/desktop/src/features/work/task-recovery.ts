import type { WorkTaskMutation } from '../../shared/work-tasks-ipc';
import type { TaskDraft } from './task-form';

export interface WorkEditRecovery {
  workspaceRoot: string;
  taskId: string;
  revision: string | null;
  base: TaskDraft;
  draft: TaskDraft;
  pending: WorkTaskMutation | null;
  captured: TaskDraft | null;
}

export function readWorkRecovery(key: string): WorkEditRecovery | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value.workspaceRoot !== 'string' ||
    typeof value.taskId !== 'string' ||
    !value.base ||
    !value.draft
  )
    throw new Error('This task has an unreadable recovery record.');
  return value;
}
export function writeWorkRecovery(key: string, value: WorkEditRecovery | null) {
  if (value) localStorage.setItem(key, JSON.stringify(value));
  else localStorage.removeItem(key);
}
