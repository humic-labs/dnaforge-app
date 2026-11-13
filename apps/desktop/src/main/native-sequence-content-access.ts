import type Database from 'better-sqlite3';
import { assertSharedProjectContentWritable } from './shared-project-write-access';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';

export function assertNativeSequenceContentWritable(
  db: Database.Database,
  documentId: string,
  expectedWorkspaceRoot: string,
  databaseFence?: () => void
): void {
  assertCommittedDatabaseReadAllowed(db, databaseFence);
  const owners = db
    .prepare(
      `SELECT w.path
    FROM catalog_entity_files f JOIN workspaces w ON w.id = f.workspace_id
      JOIN catalog_entities e ON e.id = f.entity_id
      LEFT JOIN lims_entity l ON l.id = e.id
    WHERE f.entity_id = ? AND f.status = 'current'
      AND e.status = 'active' AND COALESCE(l.tombstone, 0) = 0 AND l.archived_at IS NULL
      AND w.access_mode = 'writable' AND w.archived_at IS NULL AND w.trashed_at IS NULL LIMIT 2`
    )
    .all(documentId) as Array<{ path: string | null }>;
  if (owners.length !== 1 || !owners[0].path) {
    throw new Error('The sequence document has no unique current owning project.');
  }
  const ownerPath = owners[0].path;
  if (
    workspaceMutationRootIdentity(ownerPath) !==
    workspaceMutationRootIdentity(expectedWorkspaceRoot)
  ) {
    throw new Error(
      'The sequence document owner changed before saving. Refresh it before retrying.'
    );
  }
  assertSharedProjectContentWritable(db, ownerPath, databaseFence);
}
