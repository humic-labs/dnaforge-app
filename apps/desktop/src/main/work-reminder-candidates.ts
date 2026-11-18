import { createHash } from 'node:crypto';
import {
  workTimeFromInput,
  workTimeStart,
  workDatePart,
  type WorkAssignee,
  type WorkSchedule,
  type WorkStatus,
} from '@waypoint/domain-services';
import type Database from 'better-sqlite3';
import type { WorkReminderRuleView } from '../shared/work-reminders-ipc';
import type { WorkTaskRecord } from '../shared/work-tasks-ipc';
import { workTaskOccurrences } from './work-task-store';

export interface LocalRule extends Omit<WorkReminderRuleView, 'email_enabled' | 'desktop_enabled'> {
  principal: string;
  scanned_at: number;
  workspace_id: number;
  desktop_enabled: number;
}
export interface ReminderOccurrence {
  slot: string;
  status: WorkStatus | 'skipped';
  schedule: WorkSchedule;
  assignee: WorkAssignee | null;
}
export function reminderGeneration(
  dueAt: number,
  recipient: string,
  rule: Pick<LocalRule, 'role' | 'offset_ms'>
): string {
  return createHash('sha256')
    .update(JSON.stringify([dueAt, recipient, rule.role, rule.offset_ms]))
    .digest('hex');
}
export function workReminderFire(
  rule: LocalRule,
  occurrence: ReminderOccurrence,
  actor: WorkAssignee
): number | null {
  if (occurrence.status !== 'todo' && occurrence.status !== 'in-progress') return null;
  if (
    occurrence.assignee &&
    (occurrence.assignee.id !== actor.id || occurrence.assignee.kind !== actor.kind)
  )
    return null;
  const date = occurrence.schedule[rule.role];
  if (date.kind !== 'resolved') return null;
  if (date.value.kind === 'timed') return date.value.instant - rule.offset_ms;
  if (!rule.day_time) return null;
  try {
    return (
      workTimeStart(
        workTimeFromInput({
          kind: 'timed',
          local: workDatePart(date.value) + 'T' + rule.day_time,
          zone: date.value.zone,
          fold: rule.day_fold,
        })
      ) - rule.offset_ms
    );
  } catch {
    return null;
  }
}
export function reminderOccurrences(
  db: Database.Database,
  task: WorkTaskRecord,
  rule: LocalRule,
  from: number,
  through: number
): ReminderOccurrence[] {
  if (!task.document.recurrence && task.document.occurrences.length === 0)
    return [
      {
        slot: 'once',
        status: task.document.status,
        assignee: task.document.assignee,
        schedule: task.schedule,
      },
    ];
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return workTaskOccurrences(db, {
    workspaceRoot: task.project.root,
    taskId: task.id,
    from: day(from + rule.offset_ms - 2 * 86400000),
    through: day(through + rule.offset_ms + 2 * 86400000),
  });
}
