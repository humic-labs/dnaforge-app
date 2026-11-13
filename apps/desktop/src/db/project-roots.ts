import { platform } from '../platform';
import { stripTrailingSep } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';

interface ProjectRow {
  id: number;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

interface RestoreLockRow {
  workspace_id: number;
  status: string;
}

async function activeProjectRows(): Promise<ProjectRow[]> {
  const [rows, restores] = await Promise.all([
    platform().db.select<ProjectRow[]>(
      'SELECT id, path, repo_uuid, archived_at, trashed_at FROM workspaces',
      []
    ),
    platform().db.select<RestoreLockRow[]>(
      'SELECT workspace_id, status FROM workspace_sync_restore_locks',
      []
    ),
  ]);
  const restoring = new Set(
    restores.filter((row) => row.status !== 'completed').map((row) => row.workspace_id)
  );
  return rows.filter(
    (row) => row.archived_at == null && row.trashed_at == null && !restoring.has(row.id)
  );
}

export async function listSearchableProjectRoots(
  mountedRoots: readonly string[]
): Promise<string[]> {
  const rows = await activeProjectRows();
  const library = rows.filter((row) => row.repo_uuid != null).map((row) => row.path);
  return [...new Set([...library, ...mountedRoots].map(stripTrailingSep).filter(Boolean))];
}

export async function resolveProjectRoot(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  const rows = await activeProjectRows();
  const match = rows.find((row) => workspaceScopeKey(row.repo_uuid, row.id) === projectId);
  return match ? stripTrailingSep(match.path) : null;
}
