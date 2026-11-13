import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import type Database from 'better-sqlite3';
import type { WorkspaceSyncAccessRole } from '../shared/cloud-sync-status';

export class SharedProjectViewOnlyError extends Error {
  readonly code = 'SHARED_PROJECT_VIEW_ONLY';

  constructor() {
    super('This shared project is view only. Editing access is required to change its contents.');
    this.name = 'SharedProjectViewOnlyError';
  }
}

export function assertSharedProjectContentWritable(
  db: Database.Database,
  knownWorkspacePath: string,
  databaseFence?: () => void
): void {
  assertCommittedDatabaseReadAllowed(db, databaseFence);
  assertSharedProjectRoleWritable(db, knownWorkspacePath);
}

export function assertAcceptingSharedProjectContentWritable(
  db: Database.Database,
  knownWorkspacePath: string
): void {
  if (!db.inTransaction) throw new Error('DATABASE_ACCEPTANCE_TRANSACTION_REQUIRED');
  assertSharedProjectRoleWritable(db, knownWorkspacePath);
}

function assertSharedProjectRoleWritable(db: Database.Database, knownWorkspacePath: string): void {
  const binding = db
    .prepare(
      `SELECT b.access_role FROM workspaces w
      JOIN workspace_sync_bindings b ON b.workspace_id = w.id
        AND b.workspace_uuid = w.repo_uuid
      WHERE w.path = ?`
    )
    .get(knownWorkspacePath) as { access_role: WorkspaceSyncAccessRole | null } | undefined;
  if (binding?.access_role === 'viewer') throw new SharedProjectViewOnlyError();
}
