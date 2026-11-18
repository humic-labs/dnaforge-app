import { parseLimsTemporalField } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import type Database from 'better-sqlite3';
import {
  classifyLegacyWorkDate,
  type WorkLink,
  type WorkSourceReader,
  type WorkTaskDocument,
} from '@waypoint/domain-services';
import type { ScientificReader } from '@waypoint/scientific-objects';
import { parseResourceId, parseResourceRevisionId } from '@waypoint/workspace-revisions';
import {
  limsEntityFromRow,
  parseLimsSchemaFields,
  type LimsEntity,
  type LimsEntityRow,
} from '../shared/lims';
import type { WorkProject } from '../shared/work-tasks-ipc';
import { getSchemaRevisionForEntity } from './lims-engine-core';
import { workRefused } from './work-task-projects';

function pinnedRegistryRecord(db: Database.Database, row: LimsEntityRow, revisionId: string) {
  if (!/^[1-9]\d*$/u.test(revisionId) || !Number.isSafeInteger(Number(revisionId))) return null;
  const audit = db
    .prepare(
      "SELECT after FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=? AND workspace_id=? AND event_seq=? AND tombstone=0"
    )
    .get(row.id, row.workspace_id, Number(revisionId)) as { after: string | null } | undefined;
  if (!audit?.after) return null;
  const value = JSON.parse(audit.after) as Partial<LimsEntity> | null;
  if (
    !value ||
    value.id !== row.id ||
    value.workspaceId !== row.workspace_id ||
    typeof value.schemaRevisionId !== 'string' ||
    !value.fields ||
    typeof value.fields !== 'object' ||
    Array.isArray(value.fields)
  )
    return null;
  return {
    fields: value.fields,
    schemaRevisionId: value.schemaRevisionId,
    archivedAt: value.archivedAt,
    tombstone: value.tombstone,
  };
}

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
          : source.role === 'plan' || source.role === 'plan-start'
            ? task.plan?.start
            : source.role === 'plan-end'
              ? task.plan?.end
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
    const revisionId =
      source.revisionId ?? (entity.event_seq === null ? null : String(entity.event_seq));
    if (!revisionId) return { kind: 'unavailable' };
    const target =
      revisionId === String(entity.event_seq)
        ? limsEntityFromRow(entity)
        : pinnedRegistryRecord(db, entity, revisionId);
    if (!target) return { kind: 'unavailable' };
    if (target.archivedAt || target.tombstone) return { kind: 'archived' };
    const definition = parseLimsSchemaFields(
      getSchemaRevisionForEntity(db, { ...entity, schema_revision_id: target.schemaRevisionId })
        .fieldsJson
    ).fields.find((f) => f.key === source.role);
    if (!definition || (definition.type !== 'date' && definition.type !== 'datetime'))
      return { kind: 'unsupported' };
    const raw = target.fields[definition.key];
    const legacy =
      definition.type === 'datetime'
        ? parseLimsTemporalField('datetime', raw)
        : classifyLegacyWorkDate(raw, source.zone ?? definition.agenda?.zone ?? '');
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
      'SELECT * FROM lims_entity WHERE id=? AND workspace_id=? AND archived_at IS NULL AND tombstone=0'
    )
    .get(target.resourceId, project.workspaceId) as LimsEntityRow | undefined;
  if (
    row &&
    (!target.revisionId ||
      String(row.event_seq) === target.revisionId ||
      pinnedRegistryRecord(db, row, target.revisionId))
  )
    return;
  if (
    !target.revisionId &&
    db
      .prepare("SELECT 1 FROM catalog_entities WHERE id=? AND workspace_id=? AND status='active'")
      .get(target.resourceId, project.workspaceId)
  )
    return;
  workRefused('The linked record or revision is unavailable.');
}
