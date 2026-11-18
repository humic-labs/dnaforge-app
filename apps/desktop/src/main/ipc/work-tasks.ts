import type Database from 'better-sqlite3';
import { handleGroup } from '../../shared/ipc-contract';
import { workTasksContract } from '../../shared/ipc/work-tasks.contract';
import {
  mutateWorkTask,
  queryWorkTasks,
  readWorkTask,
  workTaskHistory,
  workTaskOccurrences,
} from '../work-task-store';
import { withRendererDatabaseRead } from '../workspace-sync-database-fence';
import { getDb } from './database';

export function registerWorkTaskHandlers(resolveDb: () => Database.Database = getDb): void {
  handleGroup(workTasksContract, {
    query: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => queryWorkTasks(db, input));
    },
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
      mutateWorkTask(resolveDb(), input, {
        ownerId: event.sender.id,
        ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
      }),
  });
}
