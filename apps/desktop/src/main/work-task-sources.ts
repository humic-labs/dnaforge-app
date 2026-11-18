import type Database from 'better-sqlite3';
import {
  classifyLegacyWorkDate,
  type WorkLink,
  type WorkSourceReader,
  type WorkTaskDocument,
} from '@waypoint/domain-services';
import type { ScientificReader } from '@waypoint/scientific-objects';
import { parseResourceId, parseResourceRevisionId } from '@waypoint/workspace-revisions';
import { parseLimsSchemaFields, type LimsEntityRow } from '../shared/lims';
import type { WorkProject } from '../shared/work-tasks-ipc';
import { getSchemaRevisionForEntity } from './lims-engine-core';
import { workRefused } from './work-task-projects';

export function workSourceReader(
  db: Database.Database,
  project: WorkProject,
  reader: ScientificReader,
  pending?: { id: string; document: WorkTaskDocument }
): WorkSourceReader {
  return (source) => {
    if (source.projectId !== project.id) return { kind: 'denied' };
    const id = parseResourceId(source.resourceId);
    const pin = source.revisionId ? parseResourceRevisionId(source.revisionId) : null;
    const row = !id.ok
      ? null
      : pin
        ? pin.ok
          ? reader.revision({ resourceId: id.value, revisionId: pin.value })
          : null
        : reader.current(id.value);
    const task =
      pending?.id === source.resourceId && !source.revisionId ? pending.document : row?.document;
    if (task?.kind === 'work-task') {
      const spec =
        source.role === 'deadline'
          ? task.deadline
          : source.role === 'plan'
            ? task.plan?.start
            : null;
      return spec && row
        ? { kind: 'resolved', spec, revisionId: row.revisionId }
        : { kind: 'missing' };
    }
    const entity = db
      .prepare('SELECT * FROM lims_entity WHERE id=? AND workspace_id=?')
      .get(source.resourceId, project.workspaceId) as LimsEntityRow | undefined;
    if (!entity) return { kind: 'missing' };
    if (entity.tombstone || entity.archived_at !== null) return { kind: 'archived' };
    const definition = parseLimsSchemaFields(
      getSchemaRevisionForEntity(db, entity).fieldsJson
    ).fields.find((f) => f.key === source.role);
    if (!definition || definition.type !== 'date') return { kind: 'unsupported' };
    const revisionId = String(entity.event_seq);
    if (source.revisionId && source.revisionId !== revisionId) return { kind: 'unavailable' };
    const legacy = classifyLegacyWorkDate(JSON.parse(entity.fields)[definition.key], 'UTC');
    return legacy.kind === 'exact'
      ? { kind: 'resolved', spec: { kind: 'fixed', value: legacy.value }, revisionId }
      : legacy.kind === 'missing'
        ? { kind: 'missing' }
        : { kind: 'unresolved' };
  };
}

export function assertWorkLink(
  db: Database.Database,
  project: WorkProject,
  reader: ScientificReader,
  target: WorkLink
) {
  if (target.projectId !== project.id)
    workRefused('The linked resource requires a readable owner in this project.');
  const id = parseResourceId(target.resourceId);
  if (id.ok && target.revisionId) {
    const pin = parseResourceRevisionId(target.revisionId);
    if (pin.ok && reader.revision({ resourceId: id.value, revisionId: pin.value })) return;
  } else if (id.ok && reader.current(id.value)) return;
  const row = db
    .prepare(
      'SELECT event_seq FROM lims_entity WHERE id=? AND workspace_id=? AND archived_at IS NULL AND tombstone=0'
    )
    .get(target.resourceId, project.workspaceId) as { event_seq: number | null } | undefined;
  if (row && (!target.revisionId || String(row.event_seq) === target.revisionId)) return;
  if (
    !target.revisionId &&
    db
      .prepare("SELECT 1 FROM catalog_entities WHERE id=? AND workspace_id=? AND status='active'")
      .get(target.resourceId, project.workspaceId)
  )
    return;
  workRefused('The linked record or revision is unavailable.');
}
