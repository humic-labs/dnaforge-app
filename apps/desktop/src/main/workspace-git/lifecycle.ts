import { assertProjectHasNoSavedOwners, assertProjectTrashAllowed } from '../saved-entity-file-retention';
import { withUserMessage } from '@waypoint/user-messages';
import type Database from 'better-sqlite3';

import {
  MAX_MANAGED_WORKSPACE_NAME_LENGTH,
  type ManagedWorkspaceLifecycleRequest,
  type ManagedWorkspaceLifecycleResult,
  type ManagedWorkspaceRenameRequest,
  type ManagedWorkspaceRenameResult,
} from '../../shared/workspace-git-types';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';

interface ManagedWorkspaceLifecycleRow {
  id: number;
  repo_uuid: string | null;
  path: string;
}

export async function transitionManagedWorkspaceLifecycle(
  db: Database.Database,
  request: ManagedWorkspaceLifecycleRequest,
  nowMs: number = Date.now()
): Promise<ManagedWorkspaceLifecycleResult> {
  const row = selectManagedWorkspace(db, request);
  if (!row) return { changed: 0 };

  const releaseMutation = await acquireWorkspaceSyncMutationLease(row.path);
  try {
    await assertWorkspaceMigrationActionsSettled(row.path);
    const trash = request.action === 'trash-by-path' || request.action === 'trash-by-uuid';
    if (trash) await assertProjectTrashAllowed(db, row.id, row.path);
    const result = db.transaction(() => {
      if (trash) assertProjectHasNoSavedOwners(db, row.id, row.path);
      return applyTransition(db, row, request, nowMs);
    }).immediate();
    return { changed: result.changes };
  } finally {
    releaseMutation();
  }
}

export async function renameManagedWorkspace(
  db: Database.Database,
  request: ManagedWorkspaceRenameRequest
): Promise<ManagedWorkspaceRenameResult> {
  const name = request.name.trim();
  if (!name)
    throw withUserMessage(new Error('A project name cannot be empty.'), 'validation.compatible.43');
  if (name.length > MAX_MANAGED_WORKSPACE_NAME_LENGTH) {
    throw new Error(
      `A project name cannot be longer than ${MAX_MANAGED_WORKSPACE_NAME_LENGTH} characters.`
    );
  }
  const row = selectManagedWorkspace(db, { repoPath: request.repoPath });
  if (!row?.repo_uuid) return { changed: 0 };

  const releaseMutation = await acquireWorkspaceSyncMutationLease(row.path);
  try {
    await assertWorkspaceMigrationActionsSettled(row.path);
    const result = db
      .prepare(
        `UPDATE workspaces
         SET name = ?
         WHERE id = ?
           AND repo_uuid = ?
           AND path = ?
           AND trashed_at IS NULL`
      )
      .run(name, row.id, row.repo_uuid, row.path);
    return { changed: result.changes };
  } finally {
    releaseMutation();
  }
}

function selectManagedWorkspace(
  db: Database.Database,
  request: { repoUuid: string } | { repoPath: string }
): ManagedWorkspaceLifecycleRow | undefined {
  if ('repoUuid' in request) {
    return db
      .prepare(
        `SELECT id, repo_uuid, path
         FROM workspaces
         WHERE repo_uuid = ?
           AND repo_uuid IS NOT NULL
         LIMIT 1`
      )
      .get(request.repoUuid) as ManagedWorkspaceLifecycleRow | undefined;
  }
  return db
    .prepare(
      `SELECT id, repo_uuid, path
       FROM workspaces
       WHERE path = ?
         AND (repo_uuid IS NOT NULL OR access_mode = 'writable')
       LIMIT 1`
    )
    .get(request.repoPath) as ManagedWorkspaceLifecycleRow | undefined;
}

function applyTransition(
  db: Database.Database,
  row: ManagedWorkspaceLifecycleRow,
  request: ManagedWorkspaceLifecycleRequest,
  nowMs: number
): Database.RunResult {
  switch (request.action) {
    case 'archive-by-uuid':
    case 'archive-by-path':
      return db
        .prepare(
          `UPDATE workspaces
           SET archived_at = ?
           WHERE id = ?
             AND repo_uuid IS ?
             AND path = ?
             AND trashed_at IS NULL`
        )
        .run(nowMs, row.id, row.repo_uuid, row.path);
    case 'trash-by-path':
      return db
        .prepare(
          `UPDATE workspaces
           SET trashed_at = ?, archived_at = NULL
           WHERE id = ?
             AND repo_uuid IS ?
             AND path = ?`
        )
        .run(nowMs, row.id, row.repo_uuid, row.path);
    case 'restore-archive-by-uuid':
    case 'restore-archive-by-path':
      return db
        .prepare(
          `UPDATE workspaces
           SET archived_at = NULL
           WHERE id = ?
             AND repo_uuid IS ?
             AND path = ?
             AND archived_at IS NOT NULL
             AND trashed_at IS NULL`
        )
        .run(row.id, row.repo_uuid, row.path);
    case 'restore-trash-by-uuid':
    case 'restore-trash-by-path':
      return db
        .prepare(
          `UPDATE workspaces
           SET trashed_at = NULL
           WHERE id = ?
             AND repo_uuid IS ?
             AND path = ?
             AND trashed_at IS NOT NULL`
        )
        .run(row.id, row.repo_uuid, row.path);
  }
}
