import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { entitySchemaRevisionContent } from '../shared/entity-schema';
import { parseLimsSchemaFields } from '../shared/lims';
import type { ProjectableRelationshipSchemaRevisionSnapshot } from '../shared/relationship-schema';

export function assertRelationshipSchemaSnapshotsMatchInDb(
  db: Database.Database,
  snapshots: readonly ProjectableRelationshipSchemaRevisionSnapshot[] = []
): void {
  for (const snapshot of snapshots) {
    const native = readRelationshipSchemaSnapshotInDb(db, snapshot.name, snapshot.schemaRevisionId);
    if (
      !native ||
      !isDeepStrictEqual(
        { ...entitySchemaRevisionContent(snapshot), relationship: snapshot.relationship },
        { ...entitySchemaRevisionContent(native), relationship: native.relationship }
      )
    )
      throw new Error(
        'Record relationship schema and Registry differ. Reconcile the project before editing.'
      );
  }
}

export function readRelationshipSchemaSnapshotInDb(
  db: Database.Database,
  type: string,
  revisionId?: string
): ProjectableRelationshipSchemaRevisionSnapshot | undefined {
  const row = db
    .prepare(
      `
    SELECT s.id AS schema_id, r.id AS revision_id, r.version, r.fields,
           s.name, s.display_name, s.description, s.builtin
      FROM lims_schema s
      JOIN lims_schema_revision r ON r.schema_id = s.id AND r.id = COALESCE(?, s.current_revision_id)
     WHERE s.kind = 'relationship_type' AND s.name = ? AND s.tombstone = 0
  `
    )
    .get(revisionId ?? null, type) as
    | {
        schema_id: string;
        revision_id: string;
        version: number;
        fields: string;
        name: string;
        display_name: string;
        description: string | null;
        builtin: number;
      }
    | undefined;
  if (!row) throw new Error(`Relationship type ${type} has no matching active schema revision.`);
  if (row.builtin) return undefined;
  const definition = parseLimsSchemaFields(row.fields);
  return {
    schemaKind: 'relationship_type',
    schemaId: row.schema_id,
    schemaRevisionId: row.revision_id,
    version: row.version,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    baseKind: definition.baseKind ?? row.name,
    fields: definition.fields.map((field) => ({ ...field })),
    ...(definition.relationship === undefined ? {} : { relationship: definition.relationship }),
  };
}
