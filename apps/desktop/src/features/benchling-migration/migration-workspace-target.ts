import type { PlatformBridge } from '../../platform';
import { workspaceScopeKey } from '../../shared/workspace-scoped-identity';

type WorkspaceRow = {
  id: number;
  repo_uuid: string | null;
  name: string;
  path: string;
  archived_at: number | null;
  trashed_at: number | null;
};

export async function resolveBenchlingMigrationWorkspace(
  scopeId: string,
  db: Pick<PlatformBridge['db'], 'select'>
): Promise<{ workspaceDbId: number; repoPath: string; name: string } | null> {
  const [rows, locks] = await Promise.all([
    db.select<WorkspaceRow[]>(
      'SELECT id, repo_uuid, name, path, archived_at, trashed_at FROM workspaces'
    ),
    db.select<Array<{ workspace_id: number; status: string }>>(
      'SELECT workspace_id, status FROM workspace_sync_restore_locks'
    ),
  ]);
  const incomplete = new Set(
    locks.filter((lock) => lock.status !== 'completed').map((lock) => lock.workspace_id)
  );
  const matches = rows.filter(
    (row) =>
      row.archived_at === null &&
      row.trashed_at === null &&
      !incomplete.has(row.id) &&
      workspaceScopeKey(row.repo_uuid, row.id) === scopeId
  );
  if (matches.length !== 1) return null;
  const row = matches[0];
  return { workspaceDbId: row.id, repoPath: row.path, name: row.name };
}
