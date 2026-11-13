import type Database from 'better-sqlite3';

import type { WorkspaceScopedDirtyState } from '../shared/cloud-sync-status';
import { getDirtyState, type DirtyState } from './dirty-state-cache';
import { isPathInsideBoundary } from '../shared/path-boundary';

interface DocumentWorkspaceRow {
  workspaceUuid: string;
}

interface PageWorkspaceRow {
  workspaceUuid: string;
}

export function getWorkspaceScopedDirtyState(
  db: Database.Database,
  dirtyState: DirtyState = getDirtyState()
): Readonly<Record<string, WorkspaceScopedDirtyState>> {
  const scoped: Record<string, WorkspaceScopedDirtyState> = {};

  for (const pageId of dirtyState.dirtyPageIds ?? []) {
    const rows = db
      .prepare(
        `SELECT DISTINCT w.repo_uuid AS workspaceUuid
         FROM catalog_entity_files f
         JOIN workspaces w ON w.id = f.workspace_id
         WHERE f.entity_id = ?
           AND f.status = 'current'
           AND w.repo_uuid IS NOT NULL
           AND w.archived_at IS NULL
           AND w.trashed_at IS NULL
         ORDER BY w.id`
      )
      .all(pageId) as PageWorkspaceRow[];
    for (const row of rows) append(scoped, row.workspaceUuid, 'dirtyPageIds', pageId);
  }

  for (const documentId of dirtyState.dirtySequenceDocumentIds ?? []) {
    const rows = db
      .prepare(
        `SELECT DISTINCT w.repo_uuid AS workspaceUuid
         FROM catalog_entity_files f
         JOIN workspaces w ON w.id = f.workspace_id
         WHERE f.entity_id = ?
           AND f.status = 'current'
           AND w.repo_uuid IS NOT NULL
           AND w.archived_at IS NULL
           AND w.trashed_at IS NULL
         UNION
         SELECT DISTINCT w.repo_uuid AS workspaceUuid
         FROM sequences s
         JOIN indexed_files i ON i.id = s.file_id
         JOIN workspaces w ON w.id = i.workspace_id
         WHERE s.document_id = ?
           AND w.repo_uuid IS NOT NULL
           AND w.archived_at IS NULL
           AND w.trashed_at IS NULL`
      )
      .all(documentId, documentId) as DocumentWorkspaceRow[];
    for (const row of rows) {
      append(scoped, row.workspaceUuid, 'dirtySequenceDocumentIds', documentId);
    }
  }

  const dirtyFilePaths = dirtyState.dirtyFilePaths ?? [];
  if (dirtyFilePaths.length > 0) {
    const workspaces = db
      .prepare(
        `SELECT repo_uuid AS workspaceUuid, path
         FROM workspaces
         WHERE repo_uuid IS NOT NULL
           AND archived_at IS NULL
           AND trashed_at IS NULL`
      )
      .all() as Array<{ workspaceUuid: string; path: string }>;
    for (const filePath of dirtyFilePaths) {
      for (const workspace of workspaces) {
        if (isPathInsideBoundary(filePath, workspace.path)) {
          append(scoped, workspace.workspaceUuid, 'dirtyFilePaths', filePath);
        }
      }
    }
  }

  return scoped;
}

export function hasUnsavedWorkspaceBuffers(state: WorkspaceScopedDirtyState | undefined): boolean {
  return (
    (state?.dirtyPageIds?.length ?? 0) > 0 ||
    (state?.dirtySequenceDocumentIds?.length ?? 0) > 0 ||
    (state?.dirtyFilePaths?.length ?? 0) > 0
  );
}

function append(
  scoped: Record<string, WorkspaceScopedDirtyState>,
  workspaceUuid: string,
  key: 'dirtyPageIds' | 'dirtySequenceDocumentIds' | 'dirtyFilePaths',
  value: string
): void {
  const current = scoped[workspaceUuid] ?? {};
  const values = current[key] ?? [];
  scoped[workspaceUuid] = { ...current, [key]: [...values, value] };
}
