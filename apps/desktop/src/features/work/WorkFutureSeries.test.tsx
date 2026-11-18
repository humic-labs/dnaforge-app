import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  applyWorkTaskCommand,
  resolveWorkSchedule,
  splitWorkSeries,
  workTimeFromInput,
  type WorkTaskDocument,
} from '@waypoint/domain-services';
import type { WorkTaskRecord, WorkTaskSplitRequest } from '../../shared/work-tasks-ipc';
import { WorkFutureSeries } from './WorkFutureSeries';
import { WORK_TASK_CHANGED } from './task-presentation';

const split = vi.hoisted(() => vi.fn());
vi.mock('../../platform', () => ({ platform: () => ({ workTasks: { split } }) }));

const context = { actor: 'author', now: Date.UTC(2026, 9, 15) };
const sourceId = '60d5d123-a3fb-47ca-a621-b9081ad82538';
const project = {
  id: 'project-a',
  workspaceId: 1,
  name: 'Project',
  root: '/project',
  actor: { kind: 'local', id: 'author' } as const,
  writable: true,
};
function record(
  document: WorkTaskDocument,
  id = sourceId,
  revisionId = 'original'
): WorkTaskRecord {
  return {
    id,
    document,
    revisionId,
    head: 'head',
    project,
    schedule: resolveWorkSchedule(document, () => ({ kind: 'missing' })),
    due: 'unscheduled',
  };
}
function original() {
  const document = applyWorkTaskCommand(
    null,
    {
      kind: 'create',
      name: 'Weekly review',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        state: 'active',
        fold: 'earlier',
        anchor: workTimeFromInput({
          kind: 'timed',
          local: '2026-10-25T01:30',
          zone: 'America/New_York',
        }),
      },
    },
    context
  );
  return record(
    applyWorkTaskCommand(
      document,
      {
        kind: 'occurrence',
        slot: '2026-11-08',
        action: { kind: 'skip' },
      },
      context
    )
  );
}
function accepted(originalRecord: WorkTaskRecord, request: WorkTaskSplitRequest) {
  const { previous, successor } = splitWorkSeries(
    originalRecord.document,
    request.firstSlot,
    request.replacement,
    context
  );
  return {
    task: record(previous, sourceId, 'updated'),
    successor: record(successor, request.successorId, 'new'),
    submission: { receipt: { outcome: 'changed' }, delivery: { kind: 'blocked' } },
  };
}
function editFrom(day: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Change future occurrences' }));
  fireEvent.change(screen.getByLabelText('First original occurrence to change'), {
    target: { value: day },
  });
}
function apply() {
  fireEvent.click(screen.getByRole('button', { name: 'Apply to this and future occurrences' }));
}
beforeEach(() => {
  split.mockReset();
  localStorage.clear();
});

it('saves a new cadence with the selected repeated clock hour, tracks the original exceptions and distinguishes file delivery', async () => {
  const task = original();
  const observed = vi.fn();
  const onAccepted = vi.fn();
  window.addEventListener(WORK_TASK_CHANGED, observed, { once: true });
  split.mockImplementation(async (request: WorkTaskSplitRequest) => accepted(task, request));
  render(<WorkFutureSeries record={task} editable onAccepted={onAccepted} />);
  editFrom('2026-10-25');
  fireEvent.change(screen.getByLabelText(/First date of new series/), {
    target: { value: '2026-11-01' },
  });
  fireEvent.change(screen.getByLabelText('When the clock repeats an hour'), {
    target: { value: 'later' },
  });
  fireEvent.change(screen.getByLabelText('Repeat frequency'), { target: { value: 'daily' } });
  fireEvent.change(screen.getByLabelText('Repeat interval'), { target: { value: '2' } });
  apply();
  expect(await screen.findByText('New series saved · Weekly review')).toBeVisible();
  expect(screen.getByText('File delivery needs attention.')).toBeVisible();
  expect(observed).toHaveBeenCalledTimes(1);
  const request = split.mock.calls[0][0];
  expect(request).toMatchObject({
    taskId: sourceId,
    workspaceRoot: project.root,
    expectedRevisionId: 'original',
    firstSlot: '2026-10-25',
    replacement: {
      frequency: 'daily',
      interval: 2,
      fold: 'later',
      anchor: workTimeFromInput({
        kind: 'timed',
        local: '2026-11-01T01:30',
        zone: 'America/New_York',
        fold: 'later',
      }),
    },
  });
  expect(onAccepted.mock.calls[0][0].task.document.occurrences).toEqual(task.document.occurrences);
  expect(onAccepted.mock.calls[0][0].successor.document.recurrence.excludedSlots).toContain(
    '2026-11-08'
  );
});

it('checks the exact original request after reopening an ended series whose reply was lost', async () => {
  const task = original();
  split.mockRejectedValueOnce(new Error('Reply lost'));
  const view = render(<WorkFutureSeries record={task} editable />);
  editFrom('2026-10-25');
  apply();
  expect(await screen.findByRole('alert')).toHaveTextContent('needs confirmation');
  const request = split.mock.calls[0][0] as WorkTaskSplitRequest;
  expect(request.operationId).not.toEqual(request.successorId);
  const result = accepted(task, request);
  expect(result.task.document.recurrence?.state).toBe('ended');
  view.unmount();
  split.mockResolvedValueOnce(result);
  render(<WorkFutureSeries record={result.task} editable />);
  expect(screen.queryByRole('button', { name: 'Change future occurrences' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Check split outcome' }));
  expect(await screen.findByText('New series saved · Weekly review')).toBeVisible();
  expect(split.mock.calls[1][0]).toEqual(request);
  expect(screen.queryByRole('button', { name: 'Check split outcome' })).toBeNull();
  expect(
    Object.keys(localStorage).filter((key) => key.startsWith('work-series-split-v1/'))
  ).toHaveLength(0);
});

it('keeps an invalid successor local and requires a new source revision after a native conflict', async () => {
  const task = original();
  split.mockResolvedValueOnce({
    task: null,
    successor: null,
    submission: { receipt: { outcome: 'conflict' } },
  });
  const view = render(<WorkFutureSeries record={task} editable />);
  editFrom('2026-11-01');
  fireEvent.change(screen.getByLabelText(/First date of new series/), {
    target: { value: '2026-10-31' },
  });
  apply();
  expect(await screen.findByRole('alert')).toHaveTextContent('on or after');
  expect(split).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/First date of new series/), {
    target: { value: '2026-11-01' },
  });
  apply();
  expect(await screen.findByText(/changed before this split/)).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Apply to this and future occurrences' })
  ).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Check split outcome' })).toBeNull();
  view.rerender(<WorkFutureSeries record={{ ...task, revisionId: 'newer' }} editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Load current rule' }));
  expect(screen.getByLabelText('First original occurrence to change')).toHaveValue('');
  expect(screen.getByLabelText('First original occurrence to change')).toBeEnabled();
});

it('restores a close-before-submit draft, keeps it bound to its revision and clears it on explicit cancel', async () => {
  const task = original();
  const first = render(<WorkFutureSeries record={task} editable />);
  editFrom('2026-11-01');
  fireEvent.change(screen.getByLabelText(/First date of new series/), {
    target: { value: '2026-11-09' },
  });
  fireEvent.change(screen.getByLabelText('Repeat frequency'), { target: { value: 'monthly' } });
  fireEvent.change(screen.getByLabelText('Repeat interval'), { target: { value: '3' } });
  first.unmount();
  const next = render(
    <WorkFutureSeries record={{ ...task, revisionId: 'changed-elsewhere' }} editable />
  );
  expect(await screen.findByLabelText('First original occurrence to change')).toHaveValue(
    '2026-11-01'
  );
  expect(screen.getByLabelText(/First date of new series/)).toHaveValue('2026-11-09');
  expect(screen.getByLabelText('Repeat frequency')).toHaveValue('monthly');
  expect(screen.getByLabelText('Repeat interval')).toHaveValue(3);
  expect(
    screen.getByRole('button', { name: 'Apply to this and future occurrences' })
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Load current rule' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel series change' }));
  next.unmount();
  render(<WorkFutureSeries record={task} editable />);
  expect(screen.getByRole('button', { name: 'Change future occurrences' })).toBeVisible();
  expect(screen.queryByLabelText('First original occurrence to change')).toBeNull();
  expect(split).not.toHaveBeenCalled();
});
