import type Database from 'better-sqlite3';
import { workRefused } from './work-task-projects';

export class ConfirmedReminderRejection extends Error {
  constructor(
    readonly requestId: string,
    message: string
  ) {
    super(message);
    this.name = 'ConfirmedReminderRejection';
  }
}

export function reminderReceipt(
  db: Database.Database,
  workspaceId: number,
  principal: string,
  requestId: string,
  command: string
): string | undefined {
  const row = db
    .prepare(
      'SELECT command_json,result_json FROM scientific_work_reminder_receipts WHERE workspace_id=? AND principal=? AND request_id=?'
    )
    .get(workspaceId, principal, requestId) as
    | { command_json: string; result_json: string }
    | undefined;
  if (row) {
    if (row.command_json !== command)
      return workRefused('This reminder request identity was reused.');
    return row.result_json;
  }
  if (
    db
      .prepare('SELECT 1 FROM scientific_work_reminder_receipts WHERE request_id=? LIMIT 1')
      .get(requestId)
  )
    return workRefused('This reminder request belongs to a different project or account.');
  return undefined;
}
