import { ConfirmedReminderRejection } from './work-reminder-receipts';
import type { EntityNavigationTarget } from '../shared/entity-navigation';
import { DesktopSyncClientError } from './desktop-sync-client-errors';
import { app, Notification, powerMonitor } from 'electron';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  workReminderCommandSchema,
  type WorkReminderRequest,
  type WorkReminderView,
  type WorkReminderResult,
} from '../shared/work-reminders-ipc';
import {
  dispatchRow,
  scanLocalWorkReminders,
  localReminderNavigationTarget,
  localReminderView,
  changeLocalReminder,
  type LocalEffect,
} from './work-reminder-local';
import {
  startProjectReminderHandoff,
  readRemoteWorkReminders,
  remoteWorkReminderClient,
  runRemoteReminderCommand,
} from './work-reminder-remote';
import { visibleWorkProjects, workRefused } from './work-task-projects';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

function project(db: Database.Database, root: string) {
  return visibleWorkProjects(db, root)[0] ?? workRefused('Project reminders are unavailable.');
}

export async function readWorkReminders(
  db: Database.Database,
  root: string
): Promise<WorkReminderView> {
  const p = await withWorkspaceSyncDatabaseFence(db, async () => project(db, root));
  if (p.actor.kind === 'member') return readRemoteWorkReminders(db, p);
  return withWorkspaceSyncDatabaseFence(db, async () => localReminderView(db, project(db, root)));
}

async function applyReminderCommand(db: Database.Database, input: WorkReminderRequest) {
  const cmd = workReminderCommandSchema.parse(input.command),
    requestId = z.string().uuid().parse(input.requestId);
  const p = await withWorkspaceSyncDatabaseFence(db, async () => project(db, input.workspaceRoot));
  if (p.actor.kind === 'local')
    return withWorkspaceSyncDatabaseFence(db, async () =>
      changeLocalReminder(db, project(db, input.workspaceRoot), requestId, cmd, Date.now())
    );
  const remote = remoteWorkReminderClient(db, p);
  if (cmd.action === 'handoff' && !cmd.sourceOfferId)
    return startProjectReminderHandoff(db, p, requestId, cmd.expectedEpoch, remote);
  if (cmd.action === 'rearm') return workRefused('Shared dispatch requires a verified handoff.');
  if ((cmd.action === 'consent' || cmd.action === 'rule') && cmd.desktop)
    return workRefused('Choose a shared delivery channel.');
  if (cmd.action === 'consent' || cmd.action === 'rule') {
    const { desktop: _desktop, ...shared } = cmd;
    return runRemoteReminderCommand(db, p, remote, requestId, shared);
  }
  return runRemoteReminderCommand(db, p, remote, requestId, cmd);
}

export async function workReminderCommand(
  db: Database.Database,
  input: WorkReminderRequest
): Promise<WorkReminderResult> {
  try {
    return { ...(await applyReminderCommand(db, input)), outcome: 'applied' };
  } catch (error) {
    if (input?.command?.action === 'handoff') {
      const ownsFence = await withWorkspaceSyncDatabaseFence(db, async () => {
        const found = visibleWorkProjects(db, input.workspaceRoot)[0];
        const row = found && dispatchRow(db, found);
        return (
          row?.state === 'fenced' &&
          row.fence_json &&
          JSON.parse(row.fence_json).requestId === input.requestId
        );
      });
      if (ownsFence) throw error;
    }
    if (error instanceof ConfirmedReminderRejection)
      return { outcome: 'rejected', error: error.message, confirmedRequestId: error.requestId };
    if (
      error instanceof z.ZodError ||
      (error instanceof Error && error.message.startsWith('WORK_TASK_REFUSED:')) ||
      (error instanceof DesktopSyncClientError &&
        [400, 401, 403, 404, 409, 422].includes(error.status ?? 0))
    ) {
      return { outcome: 'rejected', error: error.message };
    }
    throw error;
  }
}

export function startWorkReminderScheduler(
  getDb: () => Database.Database,
  navigate: (target: EntityNavigationTarget) => void
) {
  let ticking = false,
    closed = false,
    started = false;
  const notificationReceipts = new Set<Notification>();
  const notify = (db: Database.Database, root: string, effect: LocalEffect, epoch: number) => {
    const settle = (state: string) => {
      void withWorkspaceSyncDatabaseFence(db, async () => {
        db.prepare(
          "UPDATE scientific_work_effects SET channel=? WHERE id=? AND channel='submit-intent'"
        ).run(state, effect.id);
      }).catch(() => {});
    };
    try {
      if (!Notification.isSupported()) {
        settle('unsupported');
        return;
      }
      const n = new Notification({
        title: 'DNAForge reminder',
        body: 'A project task has reached its reminder time.',
      });
      notificationReceipts.add(n);
      n.once('show', () => settle('accepted'));
      n.once('close', () => notificationReceipts.delete(n));
      n.once('failed', () => {
        notificationReceipts.delete(n);
        settle('rejected');
      });
      n.once('click', () => {
        notificationReceipts.delete(n);
        void withWorkspaceSyncDatabaseFence(db, async () => {
          if (closed) return;
          const target = localReminderNavigationTarget(db, root, effect.id, epoch);
          if (target) navigate(target);
        }).catch(() => {});
      });
      n.show();
    } catch {
      settle('uncertain');
    }
  };
  const tick = async () => {
    if (closed || ticking) return;
    ticking = true;
    try {
      const db = getDb();
      await withWorkspaceSyncDatabaseFence(db, async () => {
        if (closed) return;
        const now = Date.now();
        db.prepare(
          "UPDATE scientific_work_effects SET channel='uncertain' WHERE channel='submit-intent' AND admitted_at<?"
        ).run(started ? now - 10 * 60000 : now + 1);
        started = true;
        const owners = db
          .prepare(
            "SELECT w.path FROM scientific_work_dispatch d JOIN workspaces w ON w.id=d.workspace_id WHERE d.state='local' AND w.archived_at IS NULL AND w.trashed_at IS NULL"
          )
          .all() as { path: string }[];
        for (const owner of owners) {
          const p = visibleWorkProjects(db, owner.path)[0];
          if (!p) continue;
          try {
            scanLocalWorkReminders(db, p, now, (e, epoch) => notify(db, owner.path, e, epoch));
          } catch (error) {
            console.warn(
              '[Work reminders] Could not evaluate project reminders.',
              error instanceof Error ? error.name : 'Error'
            );
          }
        }
      });
    } catch (error) {
      if (!closed)
        console.warn(
          '[Work reminders] Scheduler unavailable.',
          error instanceof Error ? error.name : 'Error'
        );
    } finally {
      ticking = false;
    }
  };
  const interval = setInterval(() => void tick(), 30000);
  interval.unref();
  const wake = () => void tick();
  powerMonitor.on('resume', wake);
  app.once('will-quit', () => {
    closed = true;
    clearInterval(interval);
    powerMonitor.off('resume', wake);
    notificationReceipts.clear();
  });
  void tick();
}
