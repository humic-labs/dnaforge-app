import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalPayload } from '@waypoint/scientific-objects';
import type { WorkTaskDocument } from '@waypoint/domain-services';
import { workRefused, type WorkProjectAccess } from './work-task-projects';

export interface NativeWorkTaskFile {
  resourceId: string;
  path: string;
  representation: { format: 'work-task-v1'; text: string };
}

export function workTaskFile(
  id: string,
  document: WorkTaskDocument,
  path?: string | null
): NativeWorkTaskFile {
  const name = createHash('sha256').update(id).digest('hex');
  return {
    resourceId: id,
    path: path ?? `tasks/${name}.task.json`,
    representation: { format: 'work-task-v1', text: canonicalPayload({ id, ...document }) + '\n' },
  };
}

export function prepareWorkOperation<T>(
  db: Database.Database,
  project: WorkProjectAccess,
  operationId: string,
  body: unknown,
  build: (actor: string) => T
): T {
  const fingerprint = createHash('sha256').update(canonicalPayload(body)).digest('hex');
  const actor = project.actor.kind + ':' + project.actor.id;
  const old = db
    .prepare(
      'SELECT actor,request_hash,prepared_request FROM scientific_work_commands WHERE workspace_id=? AND operation_id=?'
    )
    .get(project.workspaceId, operationId) as
    | { actor: string; request_hash: string; prepared_request: string }
    | undefined;
  if (old) {
    if (old.request_hash !== fingerprint || old.actor !== actor)
      return workRefused('This operation identity was used for another request.');
    return JSON.parse(old.prepared_request) as T;
  }
  const prepared = build(actor);
  db.prepare(
    'INSERT INTO scientific_work_commands (workspace_id,operation_id,request_hash,actor,prepared_request) VALUES (?,?,?,?,?)'
  ).run(project.workspaceId, operationId, fingerprint, actor, canonicalPayload(prepared));
  return prepared;
}
