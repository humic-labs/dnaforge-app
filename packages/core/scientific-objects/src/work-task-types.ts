export type WorkTimeInput =
  | { kind: 'day'; date: string; zone: string }
  | { kind: 'timed'; local: string; zone: string; fold?: 'earlier' | 'later' };

export type WorkTime =
  | { kind: 'day'; date: string; zone: string }
  | { kind: 'timed'; local: string; zone: string; instant: number };

export interface WorkLink {
  projectId: string;
  resourceId: string;
  role?: string;
  revisionId?: string;
}

export type WorkSource = WorkLink & { role: string };
export type WorkOffset = { unit: 'days' | 'milliseconds'; amount: number };
export type WorkDateSpec =
  | { kind: 'fixed'; value: WorkTime }
  | { kind: 'relative'; source: WorkSource; offset: WorkOffset };

export interface WorkPlan {
  start: WorkDateSpec;
  end?: WorkDateSpec;
}

export type WorkSourceValue =
  | { kind: 'resolved'; spec: WorkDateSpec; revisionId: string }
  | { kind: 'missing' | 'unresolved' | 'archived' | 'unavailable' | 'denied' | 'unsupported' };

export type WorkSourceReader = (source: WorkSource) => WorkSourceValue;

export type WorkResolvedDate =
  | { kind: 'missing' }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'resolved'; value: WorkTime; sources: readonly WorkSource[] };

export interface WorkSchedule {
  start: WorkResolvedDate;
  end: WorkResolvedDate;
  deadline: WorkResolvedDate;
}

export type WorkAssignee = { kind: 'local' | 'member'; id: string };
export type WorkStatus = 'todo' | 'in-progress' | 'done' | 'canceled';
export type WorkDueStatus =
  | 'terminal'
  | 'unscheduled'
  | 'unresolved'
  | 'upcoming'
  | 'today'
  | 'overdue';

export interface WorkCompletion {
  recordedAt: number;
  actualAt: number;
  reported: boolean;
  actor: string;
  assignee: WorkAssignee | null;
  schedule: WorkSchedule;
  evidence: readonly WorkLink[];
}

export interface WorkCancellation {
  recordedAt: number;
  actor: string;
  reason: string | null;
}

export interface WorkRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  anchor: WorkTime;
  weekdays?: readonly number[];
  excludedSlots?: readonly string[];
  pauses?: readonly { start: number; end: number | null }[];
  count?: number;
  until?: string;
  fold: 'earlier' | 'later';
  state: 'active' | 'paused' | 'ended';
}

export interface WorkOccurrence {
  slot: string;
  nominal: WorkTime;
  status: WorkStatus | 'skipped';
  schedule: WorkSchedule;
  override?: { plan: WorkPlan | null; deadline: WorkDateSpec | null };
  assignee: WorkAssignee | null;
  recurrence: WorkRecurrence;
  completion: WorkCompletion | null;
  cancellation: WorkCancellation | null;
}

export interface WorkTaskDocument {
  formatVersion: 1;
  kind: 'work-task';
  name: string;
  description: string;
  status: WorkStatus;
  assignee: WorkAssignee | null;
  links: readonly WorkLink[];
  plan: WorkPlan | null;
  deadline: WorkDateSpec | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  completion: WorkCompletion | null;
  cancellation: WorkCancellation | null;
  recurrence: WorkRecurrence | null;
  occurrences: readonly WorkOccurrence[];
}

export interface WorkTaskFields {
  name?: string;
  description?: string;
  assignee?: WorkAssignee | null;
  links?: readonly WorkLink[];
  plan?: WorkPlan | null;
  deadline?: WorkDateSpec | null;
  recurrence?: WorkRecurrence | null;
}

type ActionKind<K extends string> = { [P in K]: { kind: P } }[K];

type WorkFinish = { kind: 'complete'; actualAt?: number; evidence?: readonly WorkLink[] };
type WorkCancel = { kind: 'cancel'; reason?: string };
export type WorkOccurrenceAction =
  | { kind: 'move'; plan: WorkPlan | null; deadline: WorkDateSpec | null }
  | ActionKind<'skip' | 'restore' | 'start' | 'todo' | 'reopen'>
  | WorkFinish
  | WorkCancel;

export type WorkTaskCommand =
  | ({ kind: 'create'; name: string } & WorkTaskFields)
  | ({ kind: 'edit' } & WorkTaskFields)
  | ActionKind<'start' | 'todo' | 'reopen'>
  | WorkFinish
  | WorkCancel
  | { kind: 'occurrence'; slot: string; action: WorkOccurrenceAction };

export interface WorkTaskContext {
  actor: string;
  now: number;
  readSource?: WorkSourceReader;
  canAssign?: (assignee: WorkAssignee) => boolean;
}
