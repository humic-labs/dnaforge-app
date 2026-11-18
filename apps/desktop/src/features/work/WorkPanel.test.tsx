import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkTaskCommand,
  resolveWorkSchedule,
  type WorkTaskDocument,
} from '@waypoint/domain-services';
import { WorkPanel } from './WorkPanel';
import { WorkTaskDialogHost } from './WorkTaskDialogHost';
import { closeWorkTask } from './task-presentation';
import type {
  WorkTaskInspection,
  WorkTaskMutation,
  WorkTaskQuery,
  WorkTaskRecord,
} from '../../shared/work-tasks-ipc';

const project = { workspaceId: 4, id: 'project-a', name: 'Project A', root: '/project-a' };
const actor = { kind: 'local', id: 'p1' } as const;
const now = Date.UTC(2026, 0, 13, 12);
const client = vi.hoisted(() => ({
  query: vi.fn(),
  mutate: vi.fn(),
  read: vi.fn(),
  history: vi.fn(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ workTasks: client }) }));

function makeRecord(id: string, document: WorkTaskDocument): WorkTaskRecord {
  return {
    id,
    revisionId: 'r1',
    head: 'h1',
    project,
    document,
    schedule: resolveWorkSchedule(document),
    due: 'unscheduled',
  };
}
let stored: WorkTaskRecord | null;

describe('linked work', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    stored = null;
    client.query.mockImplementation(async (input: WorkTaskQuery) => ({
      tasks: stored ? [stored] : [],
      actor,
      projects: [project],
      now,
      total: stored ? 1 : 0,
      nextOffset: null,
      unavailable: [],
    }));
    client.read.mockImplementation(async (input: WorkTaskInspection) =>
      stored?.id === input.taskId ? stored : null
    );
    client.history.mockResolvedValue({ revisions: [] });
    client.mutate.mockImplementation(async (input: WorkTaskMutation) => {
      const document = applyWorkTaskCommand(stored?.document ?? null, input.command, {
        actor: actor.id,
        canAssign: (a) => a.kind === actor.kind && a.id === actor.id,
        now,
      });
      stored = makeRecord(input.taskId, document);
      return {
        task: stored,
        submission: { receipt: { outcome: 'changed' }, delivery: { kind: 'complete' } },
      };
    });
  });
  afterEach(() =>
    act(() => {
      closeWorkTask();
    })
  );
  it('creates a task from a source record, then opens its accepted identity from the project', async () => {
    render(
      <>
        <WorkPanel mode="record" workspaceId={4} subjectId="record-id" subjectName="Lot A" />
        <WorkPanel mode="project" workspaceRoot={project.root} />
        <WorkTaskDialogHost />
      </>
    );
    const record = screen.getByTestId('work-record');
    const add = within(record).getByRole('button', { name: 'Add task' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name', exact: true }), {
      target: { value: 'Review lot' },
    });
    fireEvent.change(screen.getByLabelText('Due', { exact: true }), {
      target: { value: '2026-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await screen.findByText('Saved');
    expect(client.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: project.root,
        expectedRevisionId: null,
        command: expect.objectContaining({
          assignee: actor,
          name: 'Review lot',
          links: [{ projectId: project.id, resourceId: 'record-id' }],
          deadline: {
            kind: 'fixed',
            value: expect.objectContaining({ kind: 'day', date: '2026-01-15' }),
          },
        }),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    fireEvent.click(
      await within(screen.getByTestId('work-project')).findByRole('button', { name: /Review lot/ })
    );
    expect(await screen.findByDisplayValue('Review lot')).toBeVisible();
    expect(client.read).toHaveBeenCalledWith({ workspaceRoot: project.root, taskId: stored!.id });
  });
  it('retries an uncertain write with the identical request and retains newer typing', async () => {
    render(
      <>
        <WorkPanel mode="mine" />
        <WorkTaskDialogHost />
      </>
    );
    const add = screen.getByRole('button', { name: 'Add task' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    const name = await screen.findByRole('textbox', { name: 'Name', exact: true });
    fireEvent.change(name, { target: { value: 'Original' } });
    client.mutate.mockRejectedValueOnce(new Error('Connection interrupted'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    const retry = await screen.findByRole('button', { name: 'Check save outcome' });
    fireEvent.change(name, { target: { value: 'Later draft' } });
    fireEvent.click(retry);
    await screen.findByText('Saved');
    expect(client.mutate.mock.calls[0]).toEqual(client.mutate.mock.calls[1]);
    expect(stored!.document.name).toBe('Original');
    expect(name).toHaveValue('Later draft');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });
  it('displays an unavailable project without asserting it has no due work', async () => {
    client.query.mockResolvedValue({
      tasks: [],
      projects: [project],
      actor,
      now,
      total: 0,
      nextOffset: null,
      unavailable: [{ project, reason: 'History unavailable' }],
    });
    render(<WorkPanel mode="mine" />);
    expect(await screen.findByText(/History unavailable/)).toBeVisible();
    expect(screen.queryByText('No tasks assigned to you.')).toBeNull();
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ assignee: 'me' }));
  });
});
