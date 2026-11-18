import {
  startWorkReminderScheduler,
  readWorkReminders,
  workReminderCommand,
} from '../work-reminder-service';
import type { NativeNotebookWorkingCopyOwner } from '../notebook-document-owner';
import type Database from 'better-sqlite3';
import { handleGroup } from '../../shared/ipc-contract';
import { workTasksContract } from '../../shared/ipc/work-tasks.contract';
import {
  finishWorkPlacement,
  workPlacements,
  mutateWorkTask,
  queryWorkTasks,
  readWorkTask,
  workTaskHistory,
  workTaskOccurrences,
} from '../work-task-store';
import { withRendererDatabaseRead } from '../workspace-sync-database-fence';
import { workAssigneeListing } from '../work-task-assignees';
import { getDb } from './database';

export function registerWorkTaskHandlers(
  notebooks: NativeNotebookWorkingCopyOwner,
  resolveDb: () => Database.Database = getDb
): void {
  handleGroup(workTasksContract, {
    reminders: (_event, input) => readWorkReminders(resolveDb(), input.workspaceRoot),
    reminderCommand: (_event, input) => workReminderCommand(resolveDb(), input),
    query: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => queryWorkTasks(db, input));
    },
    assignees: async (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () =>
        workAssigneeListing(db, input.workspaceRoot)
      );
    },
    placements: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => workPlacements(db, input));
    },
    finishPlacement: (_event, input) => finishWorkPlacement(resolveDb(), input, notebooks),
    occurrences: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => workTaskOccurrences(db, input));
    },
    read: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => readWorkTask(db, input));
    },
    history: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => workTaskHistory(db, input));
    },
    mutate: (event, input) =>
      mutateWorkTask(
        resolveDb(),
        input,
        {
          ownerId: event.sender.id,
          ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
        },
        notebooks
      ),
  });
  startWorkReminderScheduler(resolveDb);
}
