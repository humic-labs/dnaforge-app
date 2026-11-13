import type Database from 'better-sqlite3';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../shared/entity-schema';
import { parseLimsSchemaFields } from '../shared/lims';

export function readEntitySchemaSnapshotInDb(
  db: Database.Database,
  entityId: string
): ProjectableEntitySchemaRevisionSnapshot {
  const row = db
    .prepare(
      `
    SELECT s.id AS schema_id, r.id AS revision_id, r.version, r.fields,
           s.name, s.display_name, s.description
      FROM lims_entity e
      JOIN lims_schema_revision r ON r.id = e.schema_revision_id AND r.schema_id = e.schema_id
      JOIN lims_schema s ON s.id = r.schema_id AND s.kind = 'entity' AND s.name = e.kind
     WHERE e.id = ?
  `
    )
    .get(entityId) as
    | {
        schema_id: string;
        revision_id: string;
        version: number;
        fields: string;
        name: string;
        display_name: string;
        description: string | null;
      }
    | undefined;
  if (!row) throw new Error(`Registry entity ${entityId} has no matching schema revision.`);
  const definition = parseLimsSchemaFields(row.fields);
  return {
    schemaId: row.schema_id,
    schemaRevisionId: row.revision_id,
    version: row.version,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    baseKind: definition.baseKind ?? row.name,
    fields: definition.fields.map((field) => ({ ...field })),
  };
}
