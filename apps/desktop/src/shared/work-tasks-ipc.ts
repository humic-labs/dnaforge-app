import type { WorkNotebookPlacement, WorkPlacementIntent } from './work-task-reference';
export type { WorkPlacementIntent } from './work-task-reference';
import type {
  WorkAssignee,
  WorkDueStatus,
  WorkSchedule,
  WorkTaskCommand,
  WorkTaskDocument,
} from '@waypoint/domain-services';
import type { ScientificWorkspaceSubmitResult } from '@waypoint/domain-services';

export interface WorkAssigneeListing {
  status: 'local' | 'verified' | 'unavailable';
  members: { principal: WorkAssignee; label: string }[];
}

export interface WorkProject {
  id: string;
  workspaceId: number;
  actor?: WorkAssignee;
  writable?: boolean;
  root: string;
  name: string;
}

export interface WorkTaskRecord {
  id: string;
  revisionId: string;
  head: string;
  project: WorkProject;
  document: WorkTaskDocument;
  schedule: WorkSchedule;
  due: WorkDueStatus;
}

export interface WorkTaskQuery {
  workspaceRoot?: string;
  subjectId?: string;
  state?: 'active' | 'all' | 'done';
  assignee?: 'me' | 'unassigned' | 'all';
  search?: string;
  offset?: number;
  limit?: number;
}

export interface WorkTaskQueryResult {
  tasks: WorkTaskRecord[];
  projects: WorkProject[];
  actor: WorkAssignee;
  now: number;
  total: number;
  nextOffset: number | null;
  unavailable: { project: WorkProject; reason: string }[];
}

export interface WorkTaskMutation {
  workspaceRoot: string;
  taskId: string;
  operationId: string;
  expectedRevisionId: string | null;
  command: WorkTaskCommand;
  notebookPlacement?: WorkNotebookPlacement;
  mutationToken?: string;
}

export interface WorkPlacementResolution {
  workspaceRoot: string;
  operationId: string;
  placementId: string;
  disposition: 'inserted' | 'abandoned';
}

export interface WorkTaskMutationResult {
  notebookPlacement?: WorkPlacementIntent;
  task: WorkTaskRecord | null;
  submission: ScientificWorkspaceSubmitResult;
}

export interface WorkTaskInspection {
  workspaceRoot: string;
  taskId: string;
}

export interface WorkOccurrenceQuery extends WorkTaskInspection {
  from: string;
  through: string;
}

export interface WorkTaskHistory {
  revisions: {
    revisionId: string;
    document: WorkTaskDocument;
  }[];
}

export interface WorkRecordDateQuery {
  workspaceRoot?: string;
  offset?: number;
  limit?: number;
}
export type WorkRecordDateRole = 'milestone' | 'deadline' | 'observation';
export type WorkRecordDate = {
  id: string;
  project: WorkProject;
  entityId: string;
  entityName: string;
  fieldKey: string;
  label: string;
  role: WorkRecordDateRole;
  revisionId: string | null;
  schemaRevisionId: string;
} & (
  | { status: 'resolved'; value: import('@waypoint/domain-services').WorkTime }
  | { status: 'unresolved'; value: null; raw: string | null }
);
export interface WorkRecordDateResult {
  rows: WorkRecordDate[];
  total: number;
  nextOffset: number | null;
}
