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
  localReminderNavigationTarget,
} from './work-reminder-local';
import { workReminderCommand } from './work-reminder-service';
import { DesktopSyncClientError } from './desktop-sync-client-errors';
import { handoffWorkReminders, runRemoteReminderCommand } from './work-reminder-remote';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

import {
  listSavedEntityRowVersions,
  recoverSavedEntityRowVersion,
} from './saved-entity-row-recovery';
import { openFileTestDb } from './__tests__/test-db';
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
    const { id: savedRuleId } = f.db.prepare('SELECT id FROM scientific_work_rules').get() as {
      id: string;
    };
    const rules = () =>
      listSavedEntityRowVersions(f.db, {
        source: 'scientific_work_rules',
        identity: [savedRuleId],
      });
    const [rule] = rules();
    expect(rule).toBeDefined();
    f.db
      .prepare('UPDATE scientific_work_rules SET scanned_at=scanned_at + 1 WHERE id=?')
      .run(savedRuleId);
    expect(rules()).toEqual([rule]);
    const exported = recoverSavedEntityRowVersion(
      f.db,
      { source: 'scientific_work_rules', revisionId: rule.revisionId },
      f.tmpDir,
      openFileTestDb
    );
    const recovered = openFileTestDb(exported.path);
    try {
      expect(recovered.prepare('SELECT * FROM scientific_work_rules').get()).toMatchObject({
        id: savedRuleId,
        task_id: 'task',
        role: 'deadline',
        offset_ms: 0,
        desktop_enabled: 1,
        state: 'armed',
      });
    } finally {
      recovered.close();
    }
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
    const [effect, epoch] = deliver.mock.calls[0];
    expect(localReminderNavigationTarget(f.db, root, effect.id, epoch)).toEqual({
      entityId: 'work-task:task',
      projectId: project.id,
    });
    expect(localReminderNavigationTarget(f.db, root, effect.id, epoch + 1)).toBeNull();
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
      expect(localReminderNavigationTarget(other, root, effect.id, epoch)).toBeNull();
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

it('confirms the exact stored refusal after restart and keeps a previously interrupted remote result unknown', async () => {
  const f = createFileTestDb('work-refusal');
  try {
    ensureSchema(f.db, f.dbPath);
    const root = join(await realpath(f.tmpDir), 'project');
    await mkdir(root);
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Dates', root, randomUUID());
    const project = visibleWorkProjects(f.db, root)[0]!;
    const input = {
      workspaceRoot: root,
      requestId: randomUUID(),
      command: { action: 'consent' as const, expectedRevision: 1, inbox: true, email: false },
    };
    const rejected = await workReminderCommand(f.db, input);
    expect(rejected).toMatchObject({ outcome: 'rejected', confirmedRequestId: input.requestId });
    expect(
      await workReminderCommand(f.db, {
        ...input,
        requestId: randomUUID(),
        command: { ...input.command, expectedRevision: 0 },
      })
    ).toMatchObject({ outcome: 'applied', revision: 1 });
    const reopened = openFileTestDb(f.dbPath);
    try {
      expect(await workReminderCommand(reopened, input)).toEqual(rejected);
      expect(
        await workReminderCommand(reopened, {
          ...input,
          command: { ...input.command, inbox: false },
        })
      ).not.toHaveProperty('confirmedRequestId');
      expect(
        await workReminderCommand(reopened, { ...input, workspaceRoot: join(root, 'missing') })
      ).not.toHaveProperty('confirmedRequestId');
      expect(localReminderView(reopened, project).consent?.revision).toBe(1);
      const member = { ...project, actor: { kind: 'member' as const, id: randomUUID() } };
      const refused = new DesktopSyncClientError('FORBIDDEN', 'No access.', {
        status: 403,
        terminal: true,
        retryable: false,
      });
      const post = vi.fn(async (): Promise<never> => {
        throw refused;
      });
      const port = {
        id: randomUUID(),
        post,
        verify: () => {},
        read: async () => {
          throw Error('Unused');
        },
      };
      const fresh = randomUUID();
      await expect(
        runRemoteReminderCommand(reopened, member, port, fresh, input.command)
      ).rejects.toMatchObject({ requestId: fresh });
      await expect(
        runRemoteReminderCommand(reopened, member, port, fresh, input.command)
      ).rejects.toMatchObject({ requestId: fresh });
      expect(post).toHaveBeenCalledTimes(1);
      const unknown = randomUUID();
      post.mockRejectedValueOnce(new Error('Connection lost.'));
      await expect(
        runRemoteReminderCommand(reopened, member, port, unknown, input.command)
      ).rejects.toThrow('Connection lost.');
      await expect(
        runRemoteReminderCommand(reopened, member, port, unknown, input.command)
      ).rejects.toThrow('cannot confirm an earlier request');
      const pending = reopened
        .prepare('SELECT result_json FROM scientific_work_reminder_receipts WHERE request_id=?')
        .get(unknown) as { result_json: string };
      expect(JSON.parse(pending.result_json)).toMatchObject({ pending: true });
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});

it('keeps restored reminders suspended and retires queued deliveries before explicit rearm', async () => {
  const f = createFileTestDb('work-reminder-archive');
  try {
    ensureSchema(f.db, f.dbPath);
    const root = join(await realpath(f.tmpDir), 'project');
    await mkdir(root);
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Archive test', root, randomUUID());
    const project = visibleWorkProjects(f.db, root)[0]!;
    const start = Date.UTC(2028, 0, 7, 12),
      fire = start + 120000;
    await mutateWorkTask(f.db, {
      workspaceRoot: root,
      taskId: 'check',
      operationId: randomUUID(),
      expectedRevisionId: null,
      command: {
        kind: 'create',
        name: 'Review',
        deadline: {
          kind: 'fixed',
          value: workTimeFromInput({ kind: 'timed', local: '2028-01-07T12:02', zone: 'UTC' }),
        },
      },
    });
    changeLocalReminder(
      f.db,
      project,
      randomUUID(),
      { action: 'consent', inbox: true, desktop: true, email: false, expectedRevision: 0 },
      start
    );
    for (const offsetMs of [60000, 0]) {
      changeLocalReminder(
        f.db,
        project,
        randomUUID(),
        {
          action: 'rule',
          taskId: 'check',
          role: 'deadline',
          offsetMs,
          desktop: true,
          email: false,
        },
        start
      );
    }
    const notify = vi.fn();
    scanLocalWorkReminders(f.db, project, start + 60000, notify);
    f.db.exec(
      "CREATE TEMP TRIGGER interrupt_delivery BEFORE UPDATE OF channel ON scientific_work_effects WHEN NEW.channel='submit-intent' BEGIN SELECT RAISE(ABORT,'interrupted delivery'); END"
    );
    expect(() => scanLocalWorkReminders(f.db, project, fire, notify)).toThrow(
      'interrupted delivery'
    );
    f.db.exec('DROP TRIGGER interrupt_delivery');
    const channels = () =>
      f.db.prepare('SELECT channel FROM scientific_work_effects ORDER BY due_at').pluck().all();
    expect(channels()).toEqual(['submit-intent', 'queued']);
    const original = dispatchRow(f.db, project)!;
    f.db.prepare('UPDATE workspaces SET archived_at=? WHERE id=?').run(fire, project.workspaceId);
    f.db.prepare('UPDATE workspaces SET archived_at=NULL WHERE id=?').run(project.workspaceId);
    const restored = dispatchRow(f.db, project)!;
    expect(restored).toMatchObject({ state: 'suspended', epoch: original.epoch + 1 });
    expect(channels()).toEqual(['submit-intent', 'suppressed']);
    scanLocalWorkReminders(f.db, project, fire + 100, notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      changeLocalReminder(
        f.db,
        project,
        randomUUID(),
        { action: 'rearm', expectedEpoch: restored.epoch },
        fire + 200
      )
    ).toEqual({ state: 'local', epoch: restored.epoch + 1 });
    scanLocalWorkReminders(f.db, project, fire + 300, notify);
    expect(channels()).toEqual(['submit-intent', 'suppressed']);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});
