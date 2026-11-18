import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { workTimeFromInput } from '@waypoint/domain-services';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { mutateWorkTask } from './work-task-store';
import { visibleWorkProjects } from './work-task-projects';
import {
  changeLocalReminder,
  scanLocalWorkReminders,
  localReminderView,
  dispatchRow,
} from './work-reminder-local';
import { handoffWorkReminders } from './work-reminder-remote';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => join(tmpdir(), 'dnaforge-work-reminder-test') },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

it('retains inbox and OS intent independently and never resumes after an unknown dispatch handoff', async () => {
  const f = createFileTestDb('work-reminders');
  try {
    ensureSchema(f.db, f.dbPath);
    const root = join(await realpath(f.tmpDir), 'project');
    await mkdir(root);
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Recorded', root, randomUUID());
    const project = visibleWorkProjects(f.db, root)[0]!;
    const start = Date.UTC(2028, 0, 7, 12),
      fire = start + 60000;
    const due = workTimeFromInput({ kind: 'timed', local: '2028-01-07T12:01', zone: 'UTC' });
    await mutateWorkTask(f.db, {
      workspaceRoot: root,
      taskId: 'task',
      operationId: randomUUID(),
      expectedRevisionId: null,
      command: { kind: 'create', name: 'Check actual', deadline: { kind: 'fixed', value: due } },
    });
    await withWorkspaceSyncDatabaseFence(f.db, async () => {
      changeLocalReminder(
        f.db,
        project,
        randomUUID(),
        { action: 'consent', inbox: true, email: false, desktop: true, expectedRevision: 0 },
        start
      );
      changeLocalReminder(
        f.db,
        project,
        randomUUID(),
        {
          action: 'rule',
          taskId: 'task',
          role: 'deadline',
          offsetMs: 0,
          email: false,
          desktop: true,
        },
        start
      );
    });
    const deliver = vi.fn();
    await withWorkspaceSyncDatabaseFence(f.db, async () => {
      scanLocalWorkReminders(f.db, project, fire, deliver);
      scanLocalWorkReminders(f.db, project, fire + 50, deliver);
      const view = localReminderView(f.db, project);
      expect(view.inbox).toHaveLength(1);
      expect(view.deliveries[0].state).toBe('submit-intent');
      const item = view.inbox[0];
      changeLocalReminder(
        f.db,
        project,
        randomUUID(),
        {
          action: 'inbox',
          id: item.id,
          expectedRevision: item.revision,
          state: 'snoozed',
          wakeAt: new Date(fire + 120000).toISOString(),
        },
        fire
      );
      scanLocalWorkReminders(f.db, project, fire + 120001, deliver);
      expect(localReminderView(f.db, project).inbox[0]).toMatchObject({
        state: 'unread',
        revision: 3,
      });
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const p = { ...project, actor: { kind: 'member' as const, id: randomUUID() } };
    const remoteId = randomUUID(),
      request = randomUUID();
    const post = vi.fn(async (id: string, command: object) => {
      if (Reflect.get(command, 'action') === 'rule') return { id };
      if (Reflect.get(command, 'action') === 'offer-handoff') {
        if (post.mock.calls.length === 2) throw new Error('Lost acknowledgement');
        return { id };
      }
      return { state: 'hosted', epoch: 1 };
    });
    const port = {
      id: remoteId,
      post,
      verify: () => {},
      read: async () => {
        throw new Error('unused');
      },
    };
    await expect(handoffWorkReminders(f.db, p, request, 0, port)).rejects.toThrow(
      'Lost acknowledgement'
    );
    const other = openFileTestDb(f.dbPath);
    try {
      expect(dispatchRow(other, project)?.state).toBe('fenced');
      scanLocalWorkReminders(other, project, fire + 130000, deliver);
      expect(deliver).toHaveBeenCalledTimes(1);
      await expect(handoffWorkReminders(other, p, randomUUID(), 0, port)).rejects.toThrow(
        'original handoff'
      );
      await handoffWorkReminders(other, p, request, 0, port);
      expect(dispatchRow(other, project)?.state).toBe('hosted');
      expect(post.mock.calls[3]).toEqual(post.mock.calls[1]);
      expect(post.mock.calls[1][1]).toMatchObject({
        action: 'offer-handoff',
        ledger: [{ taskId: 'task', disposition: 'uncertain' }],
      });
    } finally {
      other.close();
    }
  } finally {
    f.cleanup();
  }
});
