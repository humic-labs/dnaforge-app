import type Database from 'better-sqlite3';
import { parseWorkspaceId, type WorkspaceId } from '@waypoint/workspace-revisions';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';

export function scientificHistoryWorkspaceIdentity(
  db: Database.Database,
  workspaceId: number
): WorkspaceId {
  const owner = db.prepare('SELECT repo_uuid FROM workspaces WHERE id=?').get(workspaceId) as
    | { repo_uuid: string | null }
    | undefined;
  if (!owner) throw new Error('Scientific history workspace is not registered.');
  const hasMapping = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_workspace_identities'"
    )
    .get();
  if (Number(db.pragma('user_version', { simple: true })) >= 43 && !hasMapping)
    throw new Error('Scientific history identity schema is incomplete.');
  const mapped = hasMapping
    ? (db
        .prepare(
          'SELECT logical_workspace_id FROM scientific_workspace_identities WHERE workspace_id=?'
        )
        .get(workspaceId) as { logical_workspace_id: string } | undefined)
    : undefined;
  if (hasMapping && !mapped) {
    const retained = db
      .prepare(
        `SELECT 1 FROM (
      SELECT workspace_id FROM scientific_revision_records UNION ALL
      SELECT workspace_id FROM scientific_revision_refs UNION ALL
      SELECT workspace_id FROM scientific_revision_blobs UNION ALL
      SELECT workspace_id FROM scientific_materialization_jobs
    ) WHERE workspace_id=? LIMIT 1`
      )
      .get(workspaceId);
    if (retained) throw new Error('Retained scientific history is missing its logical identity.');
  }
  const id = parseWorkspaceId(
    mapped?.logical_workspace_id ?? workspaceScopeKey(owner.repo_uuid, workspaceId) ?? ''
  );
  if (!id.ok) throw new Error('Scientific history workspace identity is invalid.');
  return id.value;
}

export function pinScientificHistoryWorkspaceIdentity(
  db: Database.Database,
  workspaceId: number,
  logicalId: WorkspaceId,
  remoteWorkspaceId?: string | null
): void {
  if (!db.inTransaction)
    throw new Error('Scientific identity requires its acceptance transaction.');
  const previous = db
    .prepare(
      'SELECT logical_workspace_id, remote_workspace_id FROM scientific_workspace_identities WHERE workspace_id=?'
    )
    .get(workspaceId) as
    | { logical_workspace_id: string; remote_workspace_id: string | null }
    | undefined;
  if (previous) {
    if (
      previous.logical_workspace_id !== logicalId ||
      (remoteWorkspaceId !== undefined &&
        previous.remote_workspace_id !== null &&
        previous.remote_workspace_id !== remoteWorkspaceId)
    )
      throw new Error('Scientific history identity belongs to another project or cloud replica.');
    if (previous.remote_workspace_id === null && remoteWorkspaceId != null)
      db.prepare(
        'UPDATE scientific_workspace_identities SET remote_workspace_id=? WHERE workspace_id=?'
      ).run(remoteWorkspaceId, workspaceId);
    return;
  }
  db.prepare(
    'INSERT INTO scientific_workspace_identities (workspace_id, logical_workspace_id, remote_workspace_id) VALUES (?, ?, ?)'
  ).run(workspaceId, logicalId, remoteWorkspaceId ?? null);
}
