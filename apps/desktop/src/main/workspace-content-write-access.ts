import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import type Database from 'better-sqlite3';
import { assertSharedProjectContentWritable } from './shared-project-write-access';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

export function assertKnownWorkspaceContentWritable(
  db: Database.Database,
  workspaceRoot: string
): void {
  assertCommittedDatabaseReadAllowed(db);
  const root = workspaceMutationRootIdentity(workspaceRoot);
  const rows = db
    .prepare(
      `SELECT path, access_mode FROM workspaces
    WHERE archived_at IS NULL AND trashed_at IS NULL AND path IS NOT NULL`
    )
    .all() as Array<{ path: string; access_mode: string }>;
  const owners = rows.filter((row) => workspaceMutationRootIdentity(row.path) === root);
  if (owners.length !== 1 || owners[0].access_mode !== 'writable') {
    throw new Error('This content change requires one active writable owning project.');
  }
  assertSharedProjectContentWritable(db, owners[0].path);
}
