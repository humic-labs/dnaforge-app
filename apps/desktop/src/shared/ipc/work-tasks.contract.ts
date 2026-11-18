import type { WorkOccurrence } from '@waypoint/domain-services';
import type {
  WorkPlacementIntent,
  WorkPlacementResolution,
  WorkOccurrenceQuery,
  WorkAssigneeListing,
  WorkTaskHistory,
  WorkTaskInspection,
  WorkTaskMutation,
  WorkTaskMutationResult,
  WorkTaskQuery,
  WorkTaskQueryResult,
  WorkTaskRecord,
} from '../work-tasks-ipc';
import { defineGroup, invoke } from './contract';

export const workTasksContract = defineGroup('workTasks', {
  query: invoke<[input: WorkTaskQuery], WorkTaskQueryResult>(),
  assignees: invoke<[input: { workspaceRoot: string }], WorkAssigneeListing>(),
  placements: invoke<
    [input: { workspaceRoot: string; documentId: string }],
    WorkPlacementIntent[]
  >(),
  finishPlacement: invoke<[input: WorkPlacementResolution], void>(),
  occurrences: invoke<[input: WorkOccurrenceQuery], WorkOccurrence[]>(),
  read: invoke<[input: WorkTaskInspection], WorkTaskRecord | null>(),
  history: invoke<[input: WorkTaskInspection], WorkTaskHistory>(),
  mutate: invoke<[input: WorkTaskMutation], WorkTaskMutationResult>(),
});
