import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { mutateWorkTask, queryWorkTasks, readWorkTask, workTaskHistory } from './work-task-store';
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
            workspace: saved.task!.project.id,
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
