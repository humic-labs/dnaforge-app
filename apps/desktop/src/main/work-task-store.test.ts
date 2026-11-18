import { splitProjectWorkTask } from './work-task-split';
import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  finishWorkPlacement,
  workPlacements,
  mutateWorkTask,
  queryWorkTasks,
  readWorkTask,
  workTaskHistory,
} from './work-task-store';
import { submitScientificObjectInMain } from './scientific-object-commands';
import { withAgentProjectScope } from './registered-project-authority';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => join(tmpdir(), 'dnaforge-work-tests') },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

it('publishes a task once, retains completion after restart and refuses unscoped changes', async () => {
  const f = createFileTestDb('work-task');
  try {
    ensureSchema(f.db, f.dbPath);
    const root = join(await realpath(f.tmpDir), 'project');
    await mkdir(root);
    f.db
      .prepare('INSERT INTO workspaces (name,path,repo_uuid,created_at) VALUES (?,?,?,?)')
      .run('Bench', root, 'work-project', 1);
    const input = { workspaceRoot: root, taskId: '0daa5320-ed9d-4fbd-acbc-e669d60d5c6a' };
    const create = {
      ...input,
      operationId: 'create-task',
      expectedRevisionId: null,
      command: { kind: 'create', name: 'Check certificate' } as const,
    };
    const saved = await mutateWorkTask(f.db, create);
    expect(saved.submission.delivery).toEqual({ kind: 'complete' });
    expect(saved.task?.document.status).toBe('todo');
    const [file] = await readdir(join(root, 'tasks'));
    expect(JSON.parse(await readFile(join(root, 'tasks', file!), 'utf8'))).toMatchObject({
      id: input.taskId,
      name: 'Check certificate',
      status: 'todo',
    });
    const finish = {
      ...input,
      operationId: 'finish-task',
      expectedRevisionId: saved.task!.revisionId,
      command: { kind: 'complete' } as const,
    };
    const completed = await mutateWorkTask(f.db, finish);
    expect(completed.task?.document.completion?.actor).toMatch(/^local:/u);
    const reopenedDb = openFileTestDb(f.dbPath);
    try {
      const replay = await mutateWorkTask(reopenedDb, finish);
      expect(replay.submission.replayed).toBe(true);
      expect(replay.task).toEqual(completed.task);
      expect(readWorkTask(reopenedDb, input)?.revisionId).toBe(completed.task!.revisionId);
      expect(workTaskHistory(reopenedDb, input).revisions.map((r) => r.document.status)).toEqual([
        'done',
        'todo',
      ]);
      await expect(
        mutateWorkTask(reopenedDb, { ...finish, command: { kind: 'reopen' } })
      ).rejects.toThrow('operation identity');
      await expect(
        mutateWorkTask(reopenedDb, { ...finish, operationId: 'stale-finish' })
      ).rejects.toThrow('WORK_TASK_CONFLICT');
      expect(queryWorkTasks(reopenedDb, { workspaceRoot: root }).tasks).toEqual([]);
      expect(queryWorkTasks(reopenedDb, { state: 'done' }).tasks.map((task) => task.id)).toEqual([
        input.taskId,
      ]);
      expect(
        withAgentProjectScope(
          { kind: 'project-roots', roots: [] },
          () => queryWorkTasks(reopenedDb, { state: 'all' }).total
        )
      ).toBe(0);
      await expect(
        submitScientificObjectInMain(reopenedDb, {
          workspaceRoot: root,
          request: {
            workspace: parseWorkspaceIdentity(saved.task!.project.id),
            expectedHead: completed.task!.head,
            operationId: 'direct-edit',
            source: { kind: 'documents', entries: [] },
          },
        })
      ).rejects.toThrow('Use project work commands');
    } finally {
      reopenedDb.close();
    }
  } finally {
    f.cleanup();
  }
});

it('recovers accepted notebook creation and finishes only after its independent reference is retained', async () => {
  const f = createFileTestDb('work-placement');
  const root = join(await realpath(f.tmpDir), 'project');
  const native = createNativeNotebookWorkingCopies({
    db: () => f.db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => [root],
    captureWorkspace: () => () => {},
    profileDirectory: () => join(f.tmpDir, 'profile'),
    relocateEntityFile: async () => {
      throw new Error('Unsupported fixture rename.');
    },
  });
  try {
    ensureSchema(f.db, f.dbPath);
    await mkdir(root);
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES (?,?,?,1)')
      .run('Records', root, 'records');
    const notebook = await native.create({
      title: 'Certificate log',
      workspaceRoot: root,
      requestId: 'notebook-create',
    });
    const placement = {
      documentId: notebook.documentId,
      expectedRevision: notebook.revision,
      index: 0,
      placementId: '404ac673-51f6-4299-b454-afa232ee277d',
    };
    const args = {
      workspaceRoot: root,
      operationId: 'compound',
      taskId: 'certificate',
      expectedRevisionId: null,
      notebookPlacement: placement,
      command: {
        kind: 'create' as const,
        name: 'Review certificate',
        links: [{ projectId: 'records', resourceId: notebook.documentId, role: 'notebook' }],
      },
    };
    const task = await mutateWorkTask(f.db, args, undefined, native);
    expect(task.notebookPlacement).toMatchObject({ ...placement, taskId: 'certificate' });
    const query = { workspaceRoot: root, documentId: notebook.documentId };
    const persisted = openFileTestDb(f.dbPath);
    try {
      expect(workPlacements(persisted, query)).toEqual([task.notebookPlacement]);
    } finally {
      persisted.close();
    }
    const ack = {
      workspaceRoot: root,
      operationId: 'compound',
      placementId: placement.placementId,
      disposition: 'inserted' as const,
    };
    await expect(finishWorkPlacement(f.db, ack, native)).rejects.toThrow(
      'retained insertion receipt'
    );
    await native.execute({
      documentId: notebook.documentId,
      expectedRevision: notebook.revision,
      operation: {
        kind: 'insert-reference',
        index: 0,
        workTask: {
          projectId: 'records',
          taskId: 'certificate',
          placementId: placement.placementId,
        },
      },
    });
    await finishWorkPlacement(f.db, ack, native);
    expect(workPlacements(f.db, query)).toEqual([]);
    expect((await mutateWorkTask(f.db, args, undefined, native)).notebookPlacement).toBeUndefined();
  } finally {
    await native.close();
    f.cleanup();
  }
});

it('cuts a series and creates its successor in one accepted version, including exact restart replay', async () => {
  const f = createFileTestDb('split-series');
  try {
    ensureSchema(f.db, f.dbPath);
    const root = join(await realpath(f.tmpDir), 'project');
    await mkdir(root);
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Runs', root, 'runs');
    const date = (day: string) => ({ kind: 'day' as const, date: day, zone: 'America/New_York' });
    const rule = {
      frequency: 'daily' as const,
      interval: 1,
      anchor: date('2028-03-01'),
      fold: 'earlier' as const,
      state: 'active' as const,
    };
    const saved = await mutateWorkTask(f.db, {
      workspaceRoot: root,
      taskId: 'series',
      operationId: 'initial-series',
      expectedRevisionId: null,
      command: {
        kind: 'create',
        name: 'Daily check',
        plan: { start: { kind: 'fixed', value: rule.anchor } },
        recurrence: rule,
      },
    });
    const input = {
      workspaceRoot: root,
      taskId: 'series',
      successorId: 'new-series',
      operationId: 'split-weekly',
      expectedRevisionId: saved.task!.revisionId,
      firstSlot: '2028-03-05',
      replacement: { ...rule, frequency: 'weekly' as const, anchor: date('2028-03-07') },
    };
    const result = await splitProjectWorkTask(f.db, input);
    expect(result.task?.document.recurrence?.until).toBe('2028-03-04');
    expect(result.successor?.document.recurrence?.anchor).toEqual(date('2028-03-07'));
    expect(result.task?.head).toEqual(result.successor?.head);
    expect(result.task?.document.links).toContainEqual({
      projectId: 'runs',
      resourceId: 'new-series',
      role: 'series-successor',
    });
    expect(result.submission.delivery).toEqual({ kind: 'complete' });
    expect(await readdir(join(root, 'tasks'))).toHaveLength(2);
    const reopened = openFileTestDb(f.dbPath);
    try {
      expect((await splitProjectWorkTask(reopened, input)).submission.replayed).toBe(true);
      expect(
        workTaskHistory(reopened, { workspaceRoot: root, taskId: 'series' }).revisions
      ).toHaveLength(2);
      expect(
        workTaskHistory(reopened, { workspaceRoot: root, taskId: 'new-series' }).revisions
      ).toHaveLength(1);
      await expect(
        splitProjectWorkTask(reopened, {
          ...input,
          operationId: 'would-overwrite',
          expectedRevisionId: result.task!.revisionId,
        })
      ).rejects.toThrow('successor identity already exists');
      expect(readWorkTask(reopened, { workspaceRoot: root, taskId: 'series' })?.head).toBe(
        result.task?.head
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});
