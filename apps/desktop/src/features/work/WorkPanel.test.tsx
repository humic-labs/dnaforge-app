import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkTaskCommand,
  expandWorkOccurrences,
  resolveWorkSchedule,
  type WorkSourceReader,
  type WorkTaskDocument,
} from '@waypoint/domain-services';
import { WorkPanel } from './WorkPanel';
import { WorkTaskDialogHost } from './WorkTaskDialogHost';
import { WorkTaskReminders } from './WorkReminders';
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
  occurrences: vi.fn(),
  records: vi.fn(),
  reminders: vi.fn(),
  reminderCommand: vi.fn(),
  dates: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ workTasks: client, lims: { queryRegistrySummaries: client.records } }),
}));

const readSource: WorkSourceReader = (source) =>
  source.resourceId === 'lot-a' && source.role === 'expiry'
    ? {
        kind: 'resolved',
        spec: { kind: 'fixed', value: { kind: 'day', date: '2026-01-23', zone: 'UTC' } },
        revisionId: 'date-1',
      }
    : { kind: 'missing' };

function makeRecord(id: string, document: WorkTaskDocument): WorkTaskRecord {
  return {
    id,
    revisionId: 'r1',
    head: 'h1',
    project,
    document,
    schedule: resolveWorkSchedule(document, readSource),
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
    client.dates.mockResolvedValue({ rows: [], total: 0, nextOffset: null });
    client.reminders.mockResolvedValue({
      authority: 'local',
      scope: 'local',
      available: true,
      epoch: 1,
      consent: null,
      rules: [],
      inbox: [],
      deliveries: [],
      subscriptions: [],
    });
    client.mutate.mockImplementation(async (input: WorkTaskMutation) => {
      const document = applyWorkTaskCommand(stored?.document ?? null, input.command, {
        actor: actor.id,
        readSource,
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
  it('retains the exact reminder request through an interrupted reply and remount', async () => {
    const task = makeRecord(
      'reminded-task',
      applyWorkTaskCommand(null, { kind: 'create', name: 'Review result' }, { actor: 'p1', now })
    );
    client.reminderCommand
      .mockRejectedValueOnce(new Error('Reply interrupted'))
      .mockResolvedValueOnce({ outcome: 'applied', revision: 1 });
    const first = render(<WorkTaskReminders task={task} />);
    await screen.findByLabelText('In-app reminders');
    fireEvent.click(screen.getByLabelText('In-app reminders'));
    await screen.findByText('Reply interrupted');
    first.unmount();
    render(<WorkTaskReminders task={task} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry request' }));
    await waitFor(() => expect(client.reminderCommand).toHaveBeenCalledTimes(2));
    expect(client.reminderCommand.mock.calls[0]![0]).toEqual(
      client.reminderCommand.mock.calls[1]![0]
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry request' })).toBeNull());
  });
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
    await screen.findByRole('button', { name: 'Check save outcome' });
    fireEvent.change(name, { target: { value: 'Later draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close and keep pending save' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(add);
    const recoveredName = await screen.findByDisplayValue('Later draft');
    fireEvent.click(screen.getByRole('button', { name: 'Check save outcome' }));
    await screen.findByText('Saved');
    expect(client.mutate.mock.calls[0]).toEqual(client.mutate.mock.calls[1]);
    expect(stored!.document.name).toBe('Original');
    expect(recoveredName).toHaveValue('Later draft');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });
  it('follows a declared date field and saves a weekly series through the shared editor', async () => {
    client.records.mockResolvedValue({
      summaries: [
        {
          id: 'lot-a',
          name: 'Lot A',
          fieldValues: { expiry: '2026-01-23', date_notes: 'a note' },
          archived: false,
          schemaSnapshot: {
            fields: [
              { type: 'date', key: 'expiry', label: 'Expiry' },
              { type: 'text', key: 'date_notes', label: 'Date notes' },
            ],
          },
        },
      ],
    });
    render(
      <>
        <WorkPanel mode="record" workspaceId={4} subjectId="lot-a" subjectName="Lot A" />
        <WorkTaskDialogHost />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(await screen.findByLabelText('Name', { exact: true }), {
      target: { value: 'Review expiry' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Due date source' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lot A · Expiry' }));
    expect(client.records).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['lot-a'], workspaceIds: [4] })
    );
    expect(screen.queryByRole('button', { name: 'Lot A · Date notes' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Due source time zone'), {
      target: { value: 'Europe/London' },
    });
    fireEvent.change(screen.getByLabelText('Due offset direction'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Due offset', { exact: true }), {
      target: { value: 2 },
    });
    fireEvent.change(screen.getByLabelText('Repeat frequency'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('First occurrence', { exact: true }), {
      target: { value: '2026-01-14' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wed' }));
    fireEvent.change(screen.getByLabelText('Occurrence limit'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await screen.findByText('Saved');
    expect(stored?.document.deadline).toEqual({
      kind: 'relative',
      source: {
        projectId: 'project-a',
        resourceId: 'lot-a',
        role: 'expiry',
        zone: 'Europe/London',
      },
      offset: { unit: 'days', amount: -2 },
    });
    expect(stored?.document.recurrence).toMatchObject({
      frequency: 'weekly',
      interval: 1,
      weekdays: [3],
      count: 4,
    });
  });

  it('moves one occurrence using the original slot after reopening the series', async () => {
    const doc = applyWorkTaskCommand(
      null,
      {
        kind: 'create',
        name: 'Weekly review',
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          anchor: { kind: 'day', date: '2026-01-14', zone: 'UTC' },
          fold: 'earlier',
          state: 'active',
          count: 4,
        },
      },
      { actor: actor.id, now }
    );
    stored = makeRecord('series', doc);
    client.occurrences.mockImplementation(async (input) =>
      expandWorkOccurrences(stored!.document, input.from, input.through)
    );
    render(
      <>
        <WorkPanel mode="project" workspaceRoot={project.root} />
        <WorkTaskDialogHost />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: /Weekly review/ }));
    fireEvent.click(await screen.findByText('Occurrences', { exact: true }));
    fireEvent.change(await screen.findByLabelText('Occurrence month'), {
      target: { value: '2026-01' },
    });
    const slot = await screen.findByText('2026-01-21 · To do');
    fireEvent.click(within(slot.closest('li')!).getByRole('button', { name: 'Move' }));
    fireEvent.change(screen.getByLabelText('Occurrence plan', { exact: true }), {
      target: { value: '2026-01-23' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save occurrence' }));
    await screen.findByText('Saved');
    expect(stored?.document.occurrences).toHaveLength(1);
    expect(stored?.document.occurrences[0]).toMatchObject({
      slot: '2026-01-21',
      schedule: { start: { kind: 'resolved', value: { date: '2026-01-23' } } },
    });
  });

  it('requires an explicit choice for a repeated clock hour and refuses a missing one', async () => {
    render(
      <>
        <WorkPanel mode="project" workspaceRoot={project.root} />
        <WorkTaskDialogHost />
      </>
    );
    const add = await screen.findByRole('button', { name: 'Add task' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.change(await screen.findByLabelText('Name', { exact: true }), {
      target: { value: 'Check clocks' },
    });
    fireEvent.change(screen.getByLabelText('Due', { exact: true }), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('Due time zone'), {
      target: { value: 'America/New_York' },
    });
    fireEvent.change(screen.getByLabelText('Due time', { exact: true }), {
      target: { value: '01:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(client.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Due clock change'), { target: { value: 'later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await screen.findByText('Saved');
    expect(stored?.document.deadline).toMatchObject({
      value: { instant: Date.parse('2026-11-01T06:30Z') },
    });
    fireEvent.change(screen.getByLabelText('Due', { exact: true }), {
      target: { value: '2026-03-08' },
    });
    fireEvent.change(screen.getByLabelText('Due time', { exact: true }), {
      target: { value: '02:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(client.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toBeVisible();
  });
  it('reconciles changed fields against a newer task revision and reports blocked delivery', async () => {
    const original = applyWorkTaskCommand(
      null,
      { kind: 'create', name: 'Original', description: 'Source description' },
      { actor: actor.id, now }
    );
    stored = makeRecord('task-1', original);
    render(
      <>
        <WorkPanel mode="project" workspaceRoot={project.root} />
        <WorkTaskDialogHost />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: /Original/ }));
    const name = await screen.findByDisplayValue('Original');
    fireEvent.change(name, { target: { value: 'My new name' } });
    stored = {
      ...stored,
      revisionId: 'r2',
      document: { ...original, description: 'Shared change' },
    };
    client.mutate.mockResolvedValueOnce({
      task: null,
      submission: { receipt: { outcome: 'conflict', conflicts: [] }, delivery: null },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await screen.findByText('Shared change');
    fireEvent.click(screen.getByRole('button', { name: 'Keep my changed fields' }));
    expect(name).toHaveValue('My new name');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Shared change');
    client.mutate.mockImplementationOnce(async (m) => ({
      task: {
        ...stored,
        revisionId: 'r3',
        document: { ...stored!.document, name: m.command.name },
      },
      submission: {
        receipt: { outcome: 'changed', version: 'h3' },
        delivery: { kind: 'blocked', versionId: 'h3', error: 'Working file changed' },
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText(/Task saved. File delivery needs attention/)).toBeVisible();
    expect(client.mutate.mock.calls[1][0]).toMatchObject({
      expectedRevisionId: 'r2',
      command: { kind: 'edit', name: 'My new name' },
    });
    expect(client.mutate.mock.calls[1][0].command).not.toHaveProperty('description');
    expect(screen.queryByRole('button', { name: 'Check save outcome' })).toBeNull();
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
