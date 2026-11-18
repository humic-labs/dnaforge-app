import type {
  WorkAssignee,
  WorkDueStatus,
  WorkSchedule,
  WorkTaskCommand,
  WorkTaskDocument,
} from '@waypoint/domain-services';
import type { ScientificWorkspaceSubmitResult } from '@waypoint/domain-services';

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
  mutationToken?: string;
}

export interface WorkTaskMutationResult {
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
