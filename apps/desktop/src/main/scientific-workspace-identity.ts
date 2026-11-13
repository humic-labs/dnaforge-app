import { withUserMessage } from '@waypoint/user-messages';
import type Database from 'better-sqlite3';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

export function scientificWorkspaceIdForRoot(db: Database.Database, root: string): number | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get())
    return null;
  const identity = workspaceMutationRootIdentity(root);
  const rows = (
    db
      .prepare('SELECT id, path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL')
      .all() as { id: number; path: string }[]
  ).filter((row) => workspaceMutationRootIdentity(row.path) === identity);
  if (rows.length > 1)
    throw withUserMessage(
      new Error('Scientific document has ambiguous workspace ownership.'),
      'recovery.ambiguousProject'
    );
  return rows[0]?.id ?? null;
}
