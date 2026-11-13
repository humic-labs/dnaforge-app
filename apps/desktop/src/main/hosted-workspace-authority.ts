import type Database from 'better-sqlite3';

interface WorkspacePathRow {
  readonly path: string;
}

export async function resolveActiveHostedWorkspacePath(
  db: Database.Database,
  requestedPath: string,
  resolveSafePath: (path: string) => Promise<string>
): Promise<string> {
  const row = db
    .prepare(
      `SELECT path
         FROM workspaces
        WHERE path = ?
          AND archived_at IS NULL
          AND trashed_at IS NULL
        LIMIT 1`
    )
    .get(requestedPath) as WorkspacePathRow | undefined;
  if (!row) throw new Error('The requested path is not in the active workspace catalog.');
  return resolveSafePath(row.path);
}
