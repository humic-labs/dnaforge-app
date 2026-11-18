import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyWorkTaskCommand, resolveWorkSchedule } from '@waypoint/domain-services';
import type {
  WorkPlacementIntent,
  WorkTaskMutation,
  WorkTaskRecord,
} from '../../../shared/work-tasks-ipc';
import type {
  NativeNotebookRequest,
  NotebookDocumentSnapshot,
} from '../../../shared/notebook-document';
import type { NativeNotebookDocumentClient } from '../notebook-document-client';
import { NotebookWorkControl } from './NotebookWorkControl';
import { WorkTaskDialogHost } from '../../work/public/work';
import { closeWorkTask } from '../../work/task-presentation';

const operations = vi.hoisted(() => ({
  placements: vi.fn(),
  finishPlacement: vi.fn(),
  query: vi.fn(),
  mutate: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ workTasks: operations }) }));
const actor = { kind: 'local', id: 'owner' } as const;
const project = { id: 'project-a', name: 'Demo', workspaceId: 1, root: '/demo', actor };
const editors: Editor[] = [];
let task: WorkTaskRecord | null;
let pending: WorkPlacementIntent[];
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  task = null;
  pending = [];
  operations.placements.mockImplementation(async () => pending);
  operations.finishPlacement.mockImplementation(async () => {
    pending = [];
  });
  operations.query.mockImplementation(async () => ({
    tasks: task ? [task] : [],
    projects: [project],
    actor,
    now: 1,
    total: task ? 1 : 0,
    nextOffset: null,
    unavailable: [],
  }));
  operations.mutate.mockImplementation(async (input: WorkTaskMutation) => {
    const document = applyWorkTaskCommand(task?.document ?? null, input.command, {
      actor: actor.id,
      now: 1,
      canAssign: () => true,
    });
    task = {
      id: input.taskId,
      project,
      document,
      revisionId: 'new-task',
      head: 'h',
      schedule: resolveWorkSchedule(document),
      due: 'unscheduled',
    };
    if (input.notebookPlacement)
      pending = [
        {
          ...input.notebookPlacement,
          projectId: project.id,
          taskId: task.id,
          operationId: input.operationId,
        },
      ];
    return {
      task,
      notebookPlacement: pending[0],
      submission: { receipt: { outcome: 'changed' }, delivery: { kind: 'complete' } },
    };
  });
});
afterEach(() => {
  cleanup();
  act(() => closeWorkTask());
  for (const editor of editors.splice(0)) editor.destroy();
});

function notebook() {
  const editor = new Editor({
    extensions: [StarterKit, TaskList, TaskItem],
    content: {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Review measurements' }] },
              ],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Next block' }] },
      ],
    },
  });
  editors.push(editor);
  editor.commands.setTextSelection(5);
  const snapshot = {
    documentId: 'notebook-a',
    workspaceRoot: project.root,
    title: 'Notes',
    revision: 'original',
    blockCount: 2,
    copy: { content: editor.getJSON() },
    dirty: false,
  } as NotebookDocumentSnapshot;
  const command = vi.fn(
    async (
      op: NativeNotebookRequest['operation'],
      _intent?: { expectedRevision: string; requestId: string }
    ) =>
      op.kind === 'inspect-copy'
        ? snapshot
        : { ...snapshot, dirty: true, result: { disposition: 'draft' } }
  );
  const client = {
    snapshot,
    flush: vi.fn(async () => {}),
    command,
  } as unknown as NativeNotebookDocumentClient;
  return { editor, client, command, snapshot };
}

it('turns a selected checklist item into one task and delegates its adjacent reference to the notebook owner', async () => {
  const { editor, client, command } = notebook();
  render(
    <>
      <NotebookWorkControl editor={editor} client={client} />
      <WorkTaskDialogHost />
    </>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Link task' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create from checklist item' }));
  expect(await screen.findByLabelText('Name', { exact: true })).toHaveValue('Review measurements');
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(operations.finishPlacement).toHaveBeenCalled());
  fireEvent.click(screen.getByText('Reminders and calendar'));
  expect(await screen.findByText('Reminders are unavailable in this workspace.')).toBeVisible();
  const create = operations.mutate.mock.calls[0][0] as WorkTaskMutation;
  expect(create.command).toMatchObject({
    kind: 'create',
    links: [{ projectId: project.id, resourceId: 'notebook-a', role: 'notebook' }],
  });
  expect(create.notebookPlacement).toMatchObject({ expectedRevision: 'original', index: 1 });
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'insert-reference',
      index: 1,
      workTask: {
        projectId: project.id,
        taskId: create.taskId,
        placementId: create.notebookPlacement!.placementId,
      },
    }),
    expect.objectContaining({ expectedRevision: 'original' })
  );
  expect(operations.finishPlacement).toHaveBeenCalledWith({
    workspaceRoot: project.root,
    operationId: create.operationId,
    placementId: create.notebookPlacement!.placementId,
    disposition: 'inserted',
  });
  expect(editor.getJSON().content?.[0].content?.[0].attrs?.checked).toBe(false);
});

it('retries a pending reference after restart with the original target and slot before allowing reposition', async () => {
  const { editor, client, command, snapshot } = notebook();
  const intent = {
    documentId: 'notebook-a',
    expectedRevision: 'original',
    index: 1,
    placementId: crypto.randomUUID(),
    taskId: 'saved-task',
    projectId: project.id,
    operationId: 'work-create',
  };
  pending = [intent];
  command.mockRejectedValueOnce(new Error('Missing acknowledgement'));
  const first = render(<NotebookWorkControl editor={editor} client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Place reference' }));
  await screen.findByText(/Missing acknowledgement/);
  expect(screen.getByRole('button', { name: 'Use selected block' })).toBeDisabled();
  expect(operations.finishPlacement).not.toHaveBeenCalled();
  const original = command.mock.calls[0];
  first.unmount();
  command.mockResolvedValue({ ...snapshot, dirty: false, result: { disposition: 'removed' } });
  render(<NotebookWorkControl editor={editor} client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check placement' }));
  await screen.findByText('The reference was removed in the notebook.');
  expect(command.mock.calls[1]).toEqual(original);
  expect(operations.mutate).not.toHaveBeenCalled();
  expect(operations.finishPlacement).toHaveBeenCalledWith({
    workspaceRoot: project.root,
    operationId: 'work-create',
    placementId: intent.placementId,
    disposition: 'inserted',
  });
});
