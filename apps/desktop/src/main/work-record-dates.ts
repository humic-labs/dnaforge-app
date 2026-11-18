import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { classifyLegacyWorkDate } from '@waypoint/domain-services';
import { parseLimsTemporalField } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import type {
  WorkRecordDateQuery,
  WorkRecordDateResult,
  WorkRecordDateRole,
} from '../shared/work-tasks-ipc';
import { readWorkQuerySnapshot } from './work-query-snapshot';
import { publicWorkProject, workRefused, type WorkProjectAccess } from './work-task-projects';

interface Row {
  workspace_id: number;
  entity_id: string;
  name: string;
  field_key: string;
  field_label: string;
  field_type: 'date' | 'datetime';
  raw_value: unknown;
  value_type: string;
  role: WorkRecordDateRole;
  zone: string | null;
  event_seq: number | null;
  schema_revision_id: string;
}

const from = `FROM lims_entity e JOIN lims_schema_revision r ON r.id=e.schema_revision_id
  JOIN json_each(CASE WHEN json_valid(r.fields) THEN r.fields ELSE '{}' END,'$.fields') f
  JOIN json_each(CASE WHEN json_valid(e.fields) THEN e.fields ELSE '{}' END) v ON v.key=json_extract(f.value,'$.key')
  WHERE e.workspace_id IN (SELECT value FROM json_each(?)) AND e.archived_at IS NULL AND e.tombstone=0
    AND f.type='object' AND json_extract(f.value,'$.type') IN ('date','datetime')
    AND json_extract(f.value,'$.agenda.role') IN ('deadline','milestone','observation')
    AND v.type!='null' AND NOT (v.type='text' AND v.value='')`;

export function queryWorkRecordDates(
  db: Database.Database,
  input: WorkRecordDateQuery
): WorkRecordDateResult {
  const offset = input.offset ?? 0,
    limit = input.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    return workRefused('Invalid record date query range.');
  return readWorkQuerySnapshot(db, input.workspaceRoot, (projects) =>
    readDatePage(db, projects, offset, limit)
  );
}

function readDatePage(
  db: Database.Database,
  projects: WorkProjectAccess[],
  offset: number,
  limit: number
): WorkRecordDateResult {
  const byWorkspace = new Map(projects.map((p) => [p.workspaceId, p]));
  if (!byWorkspace.size) return { rows: [], total: 0, nextOffset: null };
  const scope = JSON.stringify([...byWorkspace.keys()]);
  const total = (db.prepare('SELECT count(*) AS total ' + from).get(scope) as { total: number })
    .total;
  const rows = db
    .prepare(
      `SELECT e.workspace_id,e.id entity_id,e.name,e.event_seq,e.schema_revision_id,v.key field_key,
      json_extract(f.value,'$.label') field_label,json_extract(f.value,'$.type') field_type,
      json_extract(f.value,'$.agenda.zone') zone,json_extract(f.value,'$.agenda.role') role,v.value raw_value,v.type value_type
      ${from} ORDER BY e.workspace_id,e.id,v.key LIMIT ? OFFSET ?`
    )
    .all(scope, limit, offset) as Row[];
  return {
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
    rows: rows.map((row) => {
      const p = byWorkspace.get(row.workspace_id)!;
      const raw =
        (row.value_type === 'object' || row.value_type === 'array') &&
        typeof row.raw_value === 'string'
          ? JSON.parse(row.raw_value)
          : row.raw_value;
      const parsed =
        row.field_type === 'datetime'
          ? parseLimsTemporalField('datetime', raw)
          : classifyLegacyWorkDate(raw, row.zone ?? '');
      const id = createHash('sha256')
        .update(JSON.stringify([p.id, row.entity_id, row.field_key]))
        .digest('hex');
      return {
        id,
        project: publicWorkProject(p),
        entityId: row.entity_id,
        entityName: row.name,
        fieldKey: row.field_key,
        label: row.field_label ?? row.field_key,
        role: row.role,
        schemaRevisionId: row.schema_revision_id,
        revisionId: row.event_seq === null ? null : String(row.event_seq),
        ...(parsed.kind === 'exact'
          ? { status: 'resolved' as const, value: parsed.value }
          : {
              status: 'unresolved' as const,
              value: null,
              raw: typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? null),
            }),
      };
    }),
  };
}
