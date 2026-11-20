import type Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import { resolveExplicitProjectRoot } from '../shared/project-root-selection';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';

export function resolveAdmittedProjectRoot(
  db: Database.Database,
  admittedRoots: readonly string[],
  project: string
) {
  assertCommittedDatabaseReadAllowed(db);
  const admitted = new Set(admittedRoots);
  const candidates = (
    db
      .prepare(
        'SELECT id,name,path FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .all() as Array<{ id: number; name: string; path: string }>
  ).filter((row) => admitted.has(row.path));
  const current = resolveExplicitProjectRoot(candidates, project);
  if (current || !isAbsolute(project)) return current;
  const prior = db.prepare(
    "SELECT 1 FROM saved_entity_row_versions WHERE source_table='workspaces' AND identity=? AND json_extract(payload,'$.path')=? LIMIT 1"
  );
  const matches = candidates.filter(
    (row) => Number.isSafeInteger(row.id) && prior.get(JSON.stringify([String(row.id)]), project)
  );
  return matches.length === 1 ? matches[0] : null;
}
