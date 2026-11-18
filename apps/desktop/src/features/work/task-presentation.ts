import { create } from 'zustand';
import type { WorkTaskInspection } from '../../shared/work-tasks-ipc';

export interface NewTaskContext {
  workspaceRoot?: string;
  workspaceId?: number;
  subjectIds?: string[];
  subjectName?: string;
  initialName?: string;
}
type Request =
  | { kind: 'open'; target: WorkTaskInspection }
  | { kind: 'create'; context: NewTaskContext };

export const useWorkTaskDialog = create<{ request: Request | null }>(() => ({ request: null }));

function present(request: Request) {
  if (useWorkTaskDialog.getState().request) return false;
  useWorkTaskDialog.setState({ request });
  return true;
}

export function openWorkTask(target: WorkTaskInspection) {
  return present({ kind: 'open', target });
}
export function createWorkTask(context: NewTaskContext) {
  return present({ kind: 'create', context });
}
export function closeWorkTask() {
  useWorkTaskDialog.setState({ request: null });
}
export const WORK_TASK_CHANGED = 'dnaforge-work-task-changed';
