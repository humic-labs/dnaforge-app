import type Database from 'better-sqlite3';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

export class WorkspaceWriteAdmissionError extends Error {
  constructor(
    readonly code: 'WORKSPACE_READ_ONLY' | 'WORKSPACE_INACTIVE',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'WorkspaceWriteAdmissionError';
  }
}

export function assertWorkspaceWriteAllowed(db: Database.Database, paths: readonly string[]): void {
  const rows = db
    .prepare('SELECT path,access_mode,archived_at,trashed_at FROM workspaces')
    .all() as Array<{
    path: string;
    access_mode: string;
    archived_at: number | null;
    trashed_at: number | null;
  }>;
  for (const candidate of paths) {
    const path = workspaceMutationRootIdentity(candidate);
    for (const row of rows) {
      if (!row.path || !pathIsAtOrUnder(path, workspaceMutationRootIdentity(row.path))) continue;
      if (row.access_mode !== 'writable')
        throw new WorkspaceWriteAdmissionError(
          'WORKSPACE_READ_ONLY',
          'Import an editable copy before changing a reference project.'
        );
      if (row.archived_at !== null || row.trashed_at !== null)
        throw new WorkspaceWriteAdmissionError(
          'WORKSPACE_INACTIVE',
          'Restore the owning project before changing its documents.'
        );
    }
  }
}
