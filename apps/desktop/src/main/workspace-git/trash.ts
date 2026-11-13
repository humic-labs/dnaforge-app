import { realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { userMessage, withUserMessage } from '@waypoint/user-messages';
import { TRASH_RETENTION_MS } from '../../shared/workspace-git-types';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
import { readOriginalDefaultProjectIdentity } from '../original-default-project';

interface TrashedWorkspaceRow {
  id: number;
  repo_uuid: string;
  name: string;
  path: string;
  trashed_at: number | null;
}

export interface PurgeExpiredTrashResult {
  purged: Array<{ repoUuid: string; name: string }>;
}

export async function purgeExpiredTrashedWorkspaces(
  db: Database.Database,
  managedRootDir: string,
  now: number = Date.now(),
  retentionMs: number = TRASH_RETENTION_MS
): Promise<PurgeExpiredTrashResult> {
  const rows = db
    .prepare(
      `SELECT id, repo_uuid, name, path, trashed_at FROM workspaces
       WHERE trashed_at IS NOT NULL AND repo_uuid IS NOT NULL`
    )
    .all() as TrashedWorkspaceRow[];
  const purged: PurgeExpiredTrashResult['purged'] = [];
  for (const row of rows) {
    if (typeof row.trashed_at !== 'number') continue;
    if (row.trashed_at + retentionMs > now) continue;
    const didPurge = await purgeManagedWorkspaceRow(db, managedRootDir, row, {
      now,
      retentionMs,
    });
    if (didPurge) purged.push({ repoUuid: row.repo_uuid, name: row.name });
  }
  return purged.length ? { purged } : { purged: [] };
}

export async function purgeTrashedWorkspaceByUuid(
  db: Database.Database,
  managedRootDir: string,
  repoUuid: string
): Promise<boolean> {
  const row = db
    .prepare(
      `SELECT id, repo_uuid, name, path, trashed_at FROM workspaces
       WHERE repo_uuid = ? AND trashed_at IS NOT NULL AND repo_uuid IS NOT NULL`
    )
    .get(repoUuid) as TrashedWorkspaceRow | undefined;
  if (!row) return false;
  return purgeManagedWorkspaceRow(db, managedRootDir, row);
}

async function purgeManagedWorkspaceRow(
  db: Database.Database,
  managedRootDir: string,
  row: TrashedWorkspaceRow,
  expiry?: { now: number; retentionMs: number }
): Promise<boolean> {
  const releaseMutation = await acquireWorkspaceSyncMutationLease(row.path);
  try {
    const releaseDatabase = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      const current = db
        .prepare(
          `SELECT id, repo_uuid, name, path, trashed_at
         FROM workspaces
         WHERE id = ?
           AND repo_uuid = ?
           AND path = ?
           AND trashed_at IS NOT NULL
         LIMIT 1`
        )
        .get(row.id, row.repo_uuid, row.path) as TrashedWorkspaceRow | undefined;
      if (!current || typeof current.trashed_at !== 'number') return false;
      if (expiry && current.trashed_at + expiry.retentionMs > expiry.now) return false;

      await assertWorkspaceMigrationActionsSettled(current.path);
      const refusal = permanentDeletionRefusal(db, current);
      if (refusal) {
        if (expiry) return false;
        throw refusal;
      }
      await removeManagedWorkspaceDirectory(managedRootDir, current);

      const deleted = db
        .prepare(
          `DELETE FROM workspaces
         WHERE id = ?
           AND repo_uuid = ?
           AND path = ?
           AND trashed_at = ?`
        )
        .run(current.id, current.repo_uuid, current.path, current.trashed_at);
      if (deleted.changes !== 1) {
        throw new Error('[trash] workspace lifecycle changed during permanent deletion');
      }
      return true;
    } finally {
      releaseDatabase();
    }
  } finally {
    releaseMutation();
  }
}

function permanentDeletionRefusal(db: Database.Database, row: TrashedWorkspaceRow): Error | null {
  const original = readOriginalDefaultProjectIdentity(db);
  if (original.status === 'unresolved') {
    return new Error(
      `Cannot permanently delete this project while the original My Project identity is unresolved. ${original.message}`
    );
  }
  if (original.repoUuid === row.repo_uuid) {
    return withUserMessage(
      new Error(userMessage('workspace.purgeOriginalRefused')),
      'workspace.purgeOriginalRefused'
    );
  }

  const retained = db
    .prepare(
      `
    SELECT 1 FROM lims_entity WHERE workspace_id = @workspaceId
    UNION ALL SELECT 1 FROM lims_link WHERE workspace_id = @workspaceId
    UNION ALL SELECT 1 FROM lims_audit WHERE workspace_id = @workspaceId
    UNION ALL SELECT 1 FROM primers WHERE workspace_id = @workspaceId
    UNION ALL SELECT 1 FROM catalog_entities
      WHERE workspace_id = @workspaceId AND type NOT IN ('file', 'folder')
    UNION ALL SELECT 1 FROM catalog_entity_files f
      JOIN catalog_entities e ON e.id = f.entity_id
      WHERE f.workspace_id = @workspaceId AND e.type NOT IN ('file', 'folder')
    UNION ALL SELECT 1 FROM catalog_workspace_placements WHERE workspace_id = @workspaceId
    LIMIT 1
  `
    )
    .get({ workspaceId: row.id });
  return retained
    ? withUserMessage(
        new Error(userMessage('workspace.purgeRetainedRefused')),
        'workspace.purgeRetainedRefused'
      )
    : null;
}

async function removeManagedWorkspaceDirectory(
  managedRootDir: string,
  row: TrashedWorkspaceRow
): Promise<void> {
  const workspaceDir = resolve(dirname(row.path));
  const container = resolve(managedRootDir);
  if (!isStrictlyInside(workspaceDir, container)) {
    throw new Error(
      `[trash] refusing to purge "${workspaceDir}" — not under the managed container`
    );
  }

  const realContainer = await realpath(container);
  let realDir: string;
  try {
    realDir = await realpath(workspaceDir);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (!isStrictlyInside(realDir, realContainer)) {
    throw new Error(
      `[trash] refusing to purge "${workspaceDir}" — resolved path escapes the managed container`
    );
  }
  await rm(workspaceDir, { recursive: true, force: false });
}

function isStrictlyInside(candidate: string, container: string): boolean {
  const fromContainer = relative(container, candidate);
  return fromContainer !== '' && !fromContainer.startsWith('..') && !isAbsolute(fromContainer);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
