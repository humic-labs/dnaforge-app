import type Database from 'better-sqlite3';
import {
  parseWorkspaceIdentity,
  splitWorkSeries,
  type ScientificWorkspaceSubmission,
} from '@waypoint/domain-services';
import { createScientificReader } from '@waypoint/scientific-objects';
import {
  hasOperationReceipt,
  listWorkspaceResources,
  parseResourceId,
  parseOperationId,
  parseResourceRevisionId,
  parseWorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import type { WorkTaskSplitRequest, WorkTaskSplitResult } from '../shared/work-tasks-ipc';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { submitScientificObjectInMain } from './scientific-object-commands';
import {
  assertWorkOutcomeReadable,
  assertWorkProjectAtAcceptance,
  workRefused,
} from './work-task-projects';
import { projectFor, workTaskResultRow } from './work-task-store';
import { authorizeWorkAssignee } from './work-task-assignees';
import { workSourceReader, assertWorkLink } from './work-task-sources';
import {
  prepareWorkOperation,
  workTaskFile,
  type NativeWorkTaskFile,
} from './work-task-preparation';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

interface PreparedSplit {
  request: ScientificWorkspaceSubmission;
  successor: NativeWorkTaskFile;
}
export async function splitProjectWorkTask(
  db: Database.Database,
  input: WorkTaskSplitRequest,
  renderer?: { ownerId: number; mutationToken?: string }
): Promise<WorkTaskSplitResult> {
  const project = projectFor(db, input.workspaceRoot);
  const originalId = parseResourceId(input.taskId),
    successorId = parseResourceId(input.successorId),
    operationId = parseOperationId(input.operationId);
  if (
    !project.writable ||
    !originalId.ok ||
    !successorId.ok ||
    !operationId.ok ||
    !parseResourceRevisionId(input.expectedRevisionId).ok ||
    input.taskId === input.successorId
  )
    return workRefused(
      'Choose two distinct series identities and a current writable task revision.'
    );
  const store = new ScientificObjectStore(db, project.workspaceId);
  const observed = store.read();
  if (!hasOperationReceipt(observed.graph, operationId.value)) {
    const task = observed.reader.current(originalId.value);
    if (task?.document.kind === 'work-task')
      await authorizeWorkAssignee(db, project, task.document.assignee);
  }
  const prepared = await withWorkspaceSyncDatabaseFence(db, async () =>
    db
      .transaction(() => {
        assertWorkProjectAtAcceptance(db, project, true);
        return prepareWorkOperation<PreparedSplit>(
          db,
          project,
          input.operationId,
          {
            kind: 'split',
            taskId: input.taskId,
            successorId: input.successorId,
            expectedRevisionId: input.expectedRevisionId,
            firstSlot: input.firstSlot,
            replacement: input.replacement,
          },
          (actor) => {
            const base = store.read();
            const current = base.reader.current(originalId.value);
            if (!base.head || !current || current.revisionId !== input.expectedRevisionId)
              throw new Error(
                'WORK_TASK_CONFLICT: The original series changed. Read its current revision.'
              );
            if (current.document.kind !== 'work-task')
              return workRefused('Choose an existing task series.');
            const slots = listWorkspaceResources(base.graph, base.head);
            if (!slots.ok) throw new Error('The accepted project namespace is unavailable.');
            if (slots.value.some((s) => s.resourceId === successorId.value))
              return workRefused('The successor identity already exists.');
            const originalSlot = slots.value.find((s) => s.resourceId === originalId.value);
            if (!originalSlot?.path || originalSlot.tombstone)
              return workRefused('The original series is unavailable.');
            const document = current.document;
            if (document.links.some((link) => link.role === 'series-successor'))
              return workRefused(
                'This series already has a successor. Open that successor to change later occurrences.'
              );
            const pair = (() => {
              try {
                return splitWorkSeries(document, input.firstSlot, input.replacement, {
                  actor,
                  now: Date.now(),
                  readSource: workSourceReader(db, project, base.reader),
                  canAssign: (assigned) =>
                    assigned.kind === document.assignee?.kind &&
                    assigned.id === document.assignee.id,
                });
              } catch (error) {
                return workRefused(
                  error instanceof Error ? error.message : 'This series cannot be split.'
                );
              }
            })();
            for (const link of pair.successor.links) assertWorkLink(db, project, base.reader, link);
            const first = {
              ...pair.previous,
              links: [
                ...pair.previous.links,
                { projectId: project.id, resourceId: successorId.value, role: 'series-successor' },
              ],
            };
            const next = {
              ...pair.successor,
              links: [
                ...pair.successor.links.filter(
                  (l) => l.role !== 'series-predecessor' && l.role !== 'series-successor'
                ),
                { projectId: project.id, resourceId: originalId.value, role: 'series-predecessor' },
              ],
            };
            return {
              request: {
                operationId: input.operationId,
                expectedHead: base.head,
                source: {
                  kind: 'native-artifact',
                  expectedRevisionId: current.revisionId,
                  entry: workTaskFile(originalId.value, first, originalSlot.path),
                },
              },
              successor: workTaskFile(successorId.value, next),
            };
          }
        );
      })
      .immediate()
  );
  const beforeAccept = () => {
    assertWorkProjectAtAcceptance(db, project, true);
    const base = store.read();
    if (hasOperationReceipt(base.graph, operationId.value)) return;
    const current = base.reader.current(originalId.value);
    if (current?.document.kind === 'work-task')
      for (const link of current.document.links) assertWorkLink(db, project, base.reader, link);
  };
  const submission = await submitScientificObjectInMain(
    db,
    {
      workspaceRoot: project.root,
      request: { ...prepared.request, workspace: parseWorkspaceIdentity(project.registeredId) },
    },
    {
      workTaskCommand: true,
      workTaskSuccessor: prepared.successor,
      beforeAccept,
      ...(renderer ? { renderer } : {}),
    }
  );
  assertWorkOutcomeReadable(db, project);
  if (!submission.accepted) return { task: null, successor: null, submission };
  const head = parseWorkspaceVersionId(submission.accepted.workspaceVersionId);
  if (!head.ok) throw new Error('Accepted series version is unavailable.');
  const { graph } = store.read();
  const reader = createScientificReader({
    graph,
    head: head.value,
    codecs: scientificNativeCodecs,
    readBlob: (blob) => store.readBlob(blob),
  });
  const now = Date.now();
  const task = workTaskResultRow(
    db,
    project,
    reader,
    head.value,
    reader.current(originalId.value),
    now
  );
  const successor = workTaskResultRow(
    db,
    project,
    reader,
    head.value,
    reader.current(successorId.value),
    now
  );
  if (!task || !successor) throw new Error('Accepted series split has incomplete resources.');
  return { task, successor, submission };
}
