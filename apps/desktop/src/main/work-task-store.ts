import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyWorkTaskCommand,
  evaluateWorkDueStatus,
  expandWorkOccurrences,
  resolveWorkSchedule,
  sortWorkAgenda,
  type ScientificWorkspaceSubmission,
  type WorkTaskDocument,
} from '@waypoint/domain-services';
import {
  canonicalPayload,
  scientificIdentityPath,
  type ScientificSnapshot,
  type ScientificReader,
} from '@waypoint/scientific-objects';
import {
  hasOperationReceipt,
  inspectResourceRevision,
  listWorkspaceResources,
  parseOperationId,
  parseResourceId,
  parseResourceRevisionId,
  type ResourceRevisionId,
} from '@waypoint/workspace-revisions';
import type {
  WorkOccurrenceQuery,
  WorkTaskHistory,
  WorkTaskInspection,
  WorkTaskMutation,
  WorkTaskMutationResult,
  WorkTaskQuery,
  WorkTaskQueryResult,
  WorkTaskRecord,
} from '../shared/work-tasks-ipc';
import {
  assertWorkProjectAtAcceptance,
  visibleWorkProjects,
  workProfile,
  workRefused,
  type WorkProjectAccess,
} from './work-task-projects';
import { assertWorkLink, workSourceReader } from './work-task-sources';
import { scientificWorkTaskSlots } from './scientific-work-task-slots';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificObjectInMain } from './scientific-object-commands';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

type Renderer = { ownerId: number; mutationToken?: string };

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectFor(db: Database.Database, root: string) {
  const project = visibleWorkProjects(db, root)[0];
  if (!project) return workRefused('The requested project is unavailable.');
  return project;
}

function resultRow(
  db: Database.Database,
  project: WorkProjectAccess,
  reader: ScientificReader,
  head: string | null,
  snapshot: ScientificSnapshot | null,
  now: number
): WorkTaskRecord | null {
  if (!head || snapshot?.document.kind !== 'work-task') return null;
  const document = snapshot.document;
  const schedule =
    document.completion?.schedule ??
    resolveWorkSchedule(document, workSourceReader(db, project, reader));
  return {
    project,
    id: snapshot.resourceId,
    revisionId: snapshot.revisionId,
    head,
    document,
    schedule,
    due: evaluateWorkDueStatus(document.status, schedule.deadline, now),
  };
}

export function readWorkTask(
  db: Database.Database,
  input: WorkTaskInspection
): WorkTaskRecord | null {
  const project = projectFor(db, input.workspaceRoot);
  const id = parseResourceId(input.taskId);
  if (!id.ok) return workRefused('Invalid task identity.');
  const { reader, head } = new ScientificObjectStore(db, project.workspaceId).read();
  return resultRow(db, project, reader, head, reader.current(id.value), Date.now());
}

export function workTaskOccurrences(db: Database.Database, input: WorkOccurrenceQuery) {
  const project = projectFor(db, input.workspaceRoot);
  const id = parseResourceId(input.taskId);
  if (!id.ok) return workRefused('Invalid task identity.');
  const { reader } = new ScientificObjectStore(db, project.workspaceId).read();
  const current = reader.current(id.value);
  if (current?.document.kind !== 'work-task') return [];
  const document = current.document;
  const visible = expandWorkOccurrences(
    document,
    input.from,
    input.through,
    workSourceReader(db, project, reader)
  );
  return [
    ...visible,
    ...document.occurrences.filter(
      (o) => o.status === 'skipped' && o.slot >= input.from && o.slot <= input.through
    ),
  ];
}

export function workTaskHistory(db: Database.Database, input: WorkTaskInspection): WorkTaskHistory {
  const project = projectFor(db, input.workspaceRoot);
  const id = parseResourceId(input.taskId);
  if (!id.ok) return workRefused('Invalid task identity.');
  const { graph, reader } = new ScientificObjectStore(db, project.workspaceId).read();
  const current = reader.current(id.value);
  if (current?.document.kind !== 'work-task') return { revisions: [] };
  const revisions: WorkTaskHistory['revisions'] = [];
  const pending: ResourceRevisionId[] = [current.revisionId];
  const seen = new Set<ResourceRevisionId>();
  for (let i = 0; i < pending.length; i++) {
    const revisionId = pending[i]!;
    if (seen.has(revisionId)) continue;
    seen.add(revisionId);
    const entry = reader.revision({ resourceId: id.value, revisionId });
    const revision = inspectResourceRevision(graph, revisionId);
    if (!revision.ok) throw new Error('Task revision history is unavailable.');
    if (entry?.document.kind === 'work-task')
      revisions.push({ revisionId, document: entry.document });
    pending.push(...revision.value.parentIds);
  }
  return { revisions };
}

export function queryWorkTasks(db: Database.Database, input: WorkTaskQuery): WorkTaskQueryResult {
  const projects = visibleWorkProjects(db, input.workspaceRoot);
  const actor = projects.length === 1 ? projects[0]!.actor : workProfile(db);
  const rows: WorkTaskRecord[] = [];
  const unavailable: WorkTaskQueryResult['unavailable'] = [];
  const now = Date.now();
  const term = input.search?.trim().toLowerCase() ?? '';
  const offset = input.offset ?? 0,
    limit = input.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    return workRefused('Invalid work query range.');
  }
  for (const project of projects) {
    try {
      const base = new ScientificObjectStore(db, project.workspaceId).read();
      const accepted: WorkTaskRecord[] = [];
      for (const slot of scientificWorkTaskSlots(base.graph, base.head)) {
        const row = resultRow(
          db,
          project,
          base.reader,
          base.head,
          base.reader.current(slot.resourceId),
          now
        );
        if (!row) continue;
        const t = row.document;
        const terminal = t.status === 'done' || t.status === 'canceled';
        if (
          (input.state === 'done' ? t.status !== 'done' : input.state !== 'all' && terminal) ||
          (input.assignee === 'me' &&
            (t.assignee?.id !== project.actor.id || t.assignee?.kind !== project.actor.kind)) ||
          (input.assignee === 'unassigned' && t.assignee !== null) ||
          (input.subjectId &&
            !t.links.some(
              (link) => link.projectId === project.id && link.resourceId === input.subjectId
            )) ||
          (term && !(t.name + ' ' + t.description).toLowerCase().includes(term))
        )
          continue;
        accepted.push(row);
      }
      rows.push(...accepted);
    } catch (error) {
      unavailable.push({
        project,
        reason: error instanceof Error ? error.message : 'Project work unavailable.',
      });
    }
  }
  const sorted = sortWorkAgenda(
    rows.map((row) => ({ ...row, status: row.document.status })),
    now
  );
  return {
    tasks: sorted.slice(offset, offset + limit).map(({ status: _status, ...task }) => task),
    projects,
    actor,
    now,
    total: sorted.length,
    nextOffset: offset + limit < sorted.length ? offset + limit : null,
    unavailable,
  };
}

function commandLinks(command: WorkTaskMutation['command']) {
  if (command.kind === 'create' || command.kind === 'edit') return command.links ?? [];
  const action = command.kind === 'occurrence' ? command.action : command;
  return action.kind === 'complete' ? (action.evidence ?? []) : [];
}

async function enroll(
  db: Database.Database,
  project: WorkProjectAccess,
  token: Renderer | undefined
) {
  const store = new ScientificObjectStore(db, project.workspaceId);
  if (store.read().head !== null) return;
  const manifest = join(project.root, scientificIdentityPath);
  const exists = lstatSync(manifest, { throwIfNoEntry: false }) !== undefined;
  const result = await submitScientificObjectInMain(
    db,
    {
      workspaceRoot: project.root,
      request: {
        workspace: project.id,
        operationId: 'work-enrollment-' + hash(project.id),
        expectedHead: null,
        source: exists ? { kind: 'working-files' } : { kind: 'documents', entries: [] },
      },
    },
    {
      ...(token ? { renderer: token } : {}),
      beforeAccept: () => {
        assertWorkProjectAtAcceptance(db, project, true);
        if (!exists && !store.read().head && lstatSync(manifest, { throwIfNoEntry: false }))
          workRefused(
            'The project identity file appeared during enrollment. Retry using its accepted records.'
          );
      },
    }
  );
  if (result.delivery?.kind === 'blocked')
    throw new Error(`Project enrollment delivery is pending: ${result.delivery.error}`);
  if (store.read().head === null) throw new Error('Project enrollment was not accepted.');
}

interface Prepared {
  request: ScientificWorkspaceSubmission;
  derivation: string;
}

interface SavedCommand {
  actor: string;
  request_hash: string;
  prepared_request: string;
}

function prepare(
  db: Database.Database,
  project: WorkProjectAccess,
  input: WorkTaskMutation
): Prepared {
  const id = parseResourceId(input.taskId);
  if (!id.ok || !parseOperationId(input.operationId).ok)
    return workRefused('Invalid work operation identity.');
  const fingerprint = hash(
    canonicalPayload({
      taskId: input.taskId,
      expectedRevisionId: input.expectedRevisionId,
      command: input.command,
    })
  );
  const actor = project.actor.kind + ':' + project.actor.id;
  const old = db
    .prepare(
      'SELECT actor,request_hash,prepared_request FROM scientific_work_commands WHERE workspace_id=? AND operation_id=?'
    )
    .get(project.workspaceId, input.operationId) as SavedCommand | undefined;
  if (old) {
    if (old.request_hash !== fingerprint || old.actor !== actor)
      return workRefused('This operation identity was used for another request.');
    return JSON.parse(old.prepared_request) as Prepared;
  }
  const store = new ScientificObjectStore(db, project.workspaceId);
  const base = store.read();
  const previous = base.reader.current(id.value);
  if ((previous?.revisionId ?? null) !== input.expectedRevisionId)
    throw new Error('WORK_TASK_CONFLICT: Task changed. Read its current revision before editing.');
  if (previous && previous.document.kind !== 'work-task')
    return workRefused('The selected resource is not a project task.');
  const current = previous?.document.kind === 'work-task' ? previous.document : null;
  const now = Date.now();
  let next: WorkTaskDocument;
  try {
    next = applyWorkTaskCommand(current, input.command, {
      actor,
      now,
      readSource: workSourceReader(db, project, base.reader),
      canAssign: (value) => value.kind === project.actor.kind && value.id === project.actor.id,
    });
  } catch (error) {
    return workRefused(error instanceof Error ? error.message : 'The task command is invalid.');
  }
  for (const link of commandLinks(input.command)) assertWorkLink(db, project, base.reader, link);
  const live = resolveWorkSchedule(
    next,
    workSourceReader(db, project, base.reader, { id: input.taskId, document: next })
  );
  if (Object.values(live).some((value) => value.kind === 'unresolved' && value.reason === 'cycle'))
    workRefused('The task schedule would introduce a date dependency cycle.');
  const catalog = base.head ? listWorkspaceResources(base.graph, base.head) : null;
  const path = catalog?.ok
    ? catalog.value.find((slot) => slot.resourceId === id.value)?.path
    : null;
  const prepared: Prepared = {
    derivation: canonicalPayload(live),
    request: {
      operationId: input.operationId,
      expectedHead: base.head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: input.expectedRevisionId,
        entry: {
          resourceId: input.taskId,
          path: path ?? `tasks/${hash(input.taskId)}.task.json`,
          representation: {
            format: 'work-task-v1',
            text: canonicalPayload({ id: input.taskId, ...next }) + '\n',
          },
        },
      },
    },
  };
  db.prepare(
    'INSERT INTO scientific_work_commands (workspace_id,operation_id,request_hash,actor,prepared_request) VALUES (?,?,?,?,?)'
  ).run(project.workspaceId, input.operationId, fingerprint, actor, canonicalPayload(prepared));
  return prepared;
}

export async function mutateWorkTask(
  db: Database.Database,
  input: WorkTaskMutation,
  renderer?: Renderer
): Promise<WorkTaskMutationResult> {
  const project = projectFor(db, input.workspaceRoot);
  if (!project.writable) return workRefused('This project does not admit work changes.');
  const operation = parseOperationId(input.operationId);
  if (!operation.ok || !parseResourceId(input.taskId).ok)
    return workRefused('Invalid task or operation identity.');
  if (input.command.kind === 'create' && input.expectedRevisionId === null)
    await enroll(db, project, renderer);
  const original = await withWorkspaceSyncDatabaseFence(db, async () => {
    assertWorkProjectAtAcceptance(db, project, true);
    return db.transaction(() => prepare(db, project, input)).immediate();
  });
  const store = new ScientificObjectStore(db, project.workspaceId);
  const beforeAccept = () => {
    assertWorkProjectAtAcceptance(db, project, true);
    const base = store.read();
    if (hasOperationReceipt(base.graph, operation.value)) return;
    if (original.request.source.kind !== 'native-artifact')
      throw new Error('Invalid prepared task request.');
    const doc = JSON.parse(original.request.source.entry.representation.text) as WorkTaskDocument;
    const reader = workSourceReader(db, project, base.reader, { id: input.taskId, document: doc });
    if (canonicalPayload(resolveWorkSchedule(doc, reader)) !== original.derivation) {
      throw new Error('WORK_TASK_CONFLICT: The source schedule changed before acceptance.');
    }
    for (const link of commandLinks(input.command)) assertWorkLink(db, project, base.reader, link);
  };
  const submission = await submitScientificObjectInMain(
    db,
    { workspaceRoot: project.root, request: { ...original.request, workspace: project.id } },
    { ...(renderer ? { renderer } : {}), beforeAccept, workTaskCommand: true }
  );
  assertWorkProjectAtAcceptance(db, project, false);
  const accepted = submission.accepted;
  if (!accepted) return { task: null, submission };
  const { reader } = store.read();
  const id = parseResourceId(input.taskId),
    revision = parseResourceRevisionId(accepted.resourceRevisionId);
  if (!id.ok || !revision.ok) throw new Error('Unrecognizable accepted task identity.');
  const task = resultRow(
    db,
    project,
    reader,
    accepted.workspaceVersionId,
    reader.revision({ resourceId: id.value, revisionId: revision.value }),
    Date.now()
  );
  return { task, submission };
}
