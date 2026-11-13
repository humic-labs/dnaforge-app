import type Database from 'better-sqlite3';
import { WORKSPACE_SCOPE_SEP } from '../shared/workspace-scoped-identity';

export function catalogSequenceIdForPath(db: Database.Database, path: string): string | undefined {
  const rows = db
    .prepare(
      `SELECT DISTINCT f.entity_id
         FROM catalog_entity_files f
         JOIN catalog_entities e ON e.id = f.entity_id
        WHERE f.path = ?
          AND f.status IN ('current', 'missing')
          AND e.type = 'sequence'`
    )
    .all(path) as Array<{ entity_id: string }>;
  if (rows.length !== 1) return undefined;
  const entityId = rows[0].entity_id;
  return entityId.includes(WORKSPACE_SCOPE_SEP) ? undefined : entityId;
}
