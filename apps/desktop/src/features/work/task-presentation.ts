import { create } from 'zustand';
import type { WorkNotebookPlacement } from '../../shared/work-task-reference';
import type { WorkTaskInspection } from '../../shared/work-tasks-ipc';

export interface NewTaskContext {
  workspaceRoot?: string;
  workspaceId?: number;
  subjectIds?: string[];
  subjectName?: string;
  initialName?: string;
  notebookPlacement?: WorkNotebookPlacement;
}
type Request =
  | { kind: 'open'; target: WorkTaskInspection; occurrenceSlot?: string }
  | { kind: 'create'; context: NewTaskContext };

export const useWorkTaskDialog = create<{ request: Request | null }>(() => ({ request: null }));

function present(request: Request) {
  if (useWorkTaskDialog.getState().request) return false;
  useWorkTaskDialog.setState({ request });
  return true;
}

export function openWorkTask(target: WorkTaskInspection, occurrenceSlot?: string) {
  return present({ kind: 'open', target, occurrenceSlot });
}
export function createWorkTask(context: NewTaskContext) {
  return present({ kind: 'create', context });
}
export function closeWorkTask() {
  useWorkTaskDialog.setState({ request: null });
}
export const WORK_TASK_CHANGED = 'dnaforge-work-task-changed';
