import { beforeEach, expect, it, vi } from 'vitest';
import { createWorkTasksTool, workTasksSchema, workTasksOutputSchema } from './work-tasks';
import { applyWorkTaskCommand } from '@waypoint/domain-services';

const native = vi.hoisted(() => ({
  query: vi.fn(),
  read: vi.fn(),
  history: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ workTasks: native }) }));

beforeEach(() => {
  vi.resetAllMocks();
});

async function run(operation: unknown, pinned = false) {
  const tool = createWorkTasksTool([
    { id: 'project', name: 'Project', path: '/projects/lab', pinned },
  ] as never);
  return tool.execute!(workTasksSchema.parse({ project: 'Project', operation }), {
    toolCallId: 'work',
    messages: [],
  });
}

it('preserves uncertain mutation identity and reports pending file delivery after accepted retry', async () => {
  native.mutate.mockRejectedValueOnce(new Error('Reply lost')).mockResolvedValueOnce({
    task: null,
    submission: { replayed: true, receipt: { outcome: 'changed' }, delivery: { kind: 'blocked' } },
  });
  const operation = {
    kind: 'create',
    taskId: 'task-one',
    operationId: 'operation-one',
    name: 'Review result',
    deadline: {
      kind: 'fixed',
      value: {
        kind: 'timed',
        local: '2026-11-01T01:30',
        zone: 'America/Los_Angeles',
        fold: 'later',
      },
    },
  };
  expect(await run(operation)).toMatchObject({
    ok: false,
    retriable: true,
    stateChanged: 'unknown',
  });
  expect(await run(operation)).toMatchObject({ ok: true, replayed: true, fileDelivery: 'pending' });
  expect(native.mutate.mock.calls[0]![0]).toEqual(native.mutate.mock.calls[1]![0]);
  expect(native.mutate.mock.calls[0]![0]).toMatchObject({
    taskId: 'task-one',
    operationId: 'operation-one',
    expectedRevisionId: null,
    command: { deadline: { value: { instant: Date.parse('2026-11-01T09:30:00Z') } } },
  });
});

it('refuses an ambiguous clock time and a pinned project before crossing the native write boundary', async () => {
  const operation = {
    kind: 'create',
    taskId: 'task-one',
    operationId: 'operation-one',
    name: 'Review result',
    deadline: {
      kind: 'fixed',
      value: { kind: 'timed', local: '2026-11-01T01:30', zone: 'America/Los_Angeles' },
    },
  };
  expect(await run(operation)).toMatchObject({ ok: false, retriable: false, stateChanged: false });
  expect(await run({ ...operation, deadline: null }, true)).toMatchObject({
    ok: false,
    stateChanged: false,
  });
  expect(native.mutate).not.toHaveBeenCalled();
});

it('returns the frozen completion and its recorded time after a later reopening', async () => {
  const created = applyWorkTaskCommand(
    null,
    {
      kind: 'create',
      name: 'Review',
      deadline: { kind: 'fixed', value: { kind: 'day', date: '2026-11-19', zone: 'UTC' } },
    },
    { actor: 'owner', now: Date.parse('2026-11-17T12:00:00Z') }
  );
  const completed = applyWorkTaskCommand(
    created,
    { kind: 'complete', actualAt: Date.parse('2026-11-19T23:50:00Z') },
    { actor: 'owner', now: Date.parse('2026-11-20T01:00:00Z') }
  );
  const reopened = applyWorkTaskCommand(
    completed,
    { kind: 'reopen' },
    { actor: 'owner', now: Date.parse('2026-11-20T02:00:00Z') }
  );
  native.history.mockResolvedValue({
    revisions: [
      { revisionId: 'reopened', document: reopened },
      { revisionId: 'completed', document: completed },
    ],
  });
  const result = await run({ kind: 'history', taskId: 'task-one' });
  expect(result).toMatchObject({
    ok: true,
    revisions: [
      { status: 'todo', completion: null },
      {
        status: 'done',
        completion: {
          actualAt: Date.parse('2026-11-19T23:50:00Z'),
          recordedAt: Date.parse('2026-11-20T01:00:00Z'),
          reported: true,
          schedule: { deadline: { value: { date: '2026-11-19', zone: 'UTC' } } },
        },
      },
    ],
  });
  expect(workTasksOutputSchema.safeParse(result).success).toBe(true);
});
