import type Database from 'better-sqlite3';
import { parseWorkspaceId } from '@waypoint/workspace-revisions';

export class ScientificCloudTransferUnsupportedError extends Error {
  readonly code = 'SCIENTIFIC_CLOUD_TRANSFER_UNSUPPORTED';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ScientificCloudTransferUnsupportedError';
  }
}

const scientificAuthorityTables = [
  'scientific_workspace_identities',
  'scientific_revision_records',
  'scientific_revision_refs',
  'scientific_revision_blobs',
  'scientific_materialization_jobs',
] as const;

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

export function assertScientificCloudTransferSupported(
  db: Database.Database,
  workspaceId: number,
  scientificHistoryFormat?: 1
): void {
  if (scientificHistoryFormat === 1) {
    if (
      Number(db.pragma('user_version', { simple: true })) < 43 ||
      scientificAuthorityTables.some((table) => !hasTable(db, table))
    )
      throw new ScientificCloudTransferUnsupportedError('Scientific history schema is incomplete.');
    if (!hasRetainedScientificAuthority(db, workspaceId)) return;
    const identity = db
      .prepare(
        'SELECT logical_workspace_id FROM scientific_workspace_identities WHERE workspace_id=?'
      )
      .get(workspaceId) as { logical_workspace_id: string } | undefined;
    if (!identity || !parseWorkspaceId(identity.logical_workspace_id).ok)
      throw new ScientificCloudTransferUnsupportedError(
        'Scientific history has no valid logical project identity.'
      );
    return;
  }
  for (const table of scientificAuthorityTables) {
    if (
      hasTable(db, table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? LIMIT 1`).get(workspaceId)
    ) {
      throw new ScientificCloudTransferUnsupportedError(
        'Cloud sync does not yet carry scientific database history. Keep this project local; its files alone do not preserve its accepted history.'
      );
    }
  }
}

export function hasRetainedScientificAuthority(
  db: Database.Database,
  workspaceId: number
): boolean {
  return scientificAuthorityTables.some(
    (table) =>
      hasTable(db, table) &&
      Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? LIMIT 1`).get(workspaceId))
  );
}

export function hasScientificCloudHistoryBinding(
  db: Database.Database,
  workspaceId: number
): boolean {
  if (!hasTable(db, 'scientific_workspace_identities') || !hasTable(db, 'workspace_sync_bindings'))
    return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM scientific_workspace_identities identity
    JOIN workspace_sync_bindings binding ON binding.workspace_id=identity.workspace_id
      AND binding.remote_workspace_id=identity.remote_workspace_id
    WHERE identity.workspace_id=? AND identity.remote_workspace_id IS NOT NULL`
      )
      .get(workspaceId)
  );
}

export function assertScientificWorkspaceLocalOnly(
  db: Database.Database,
  workspaceId: number
): void {
  if (
    hasTable(db, 'workspace_sync_bindings') &&
    db
      .prepare('SELECT 1 FROM workspace_sync_bindings WHERE workspace_id = ? LIMIT 1')
      .get(workspaceId)
  ) {
    if (hasScientificCloudHistoryBinding(db, workspaceId)) {
      assertScientificCloudTransferSupported(db, workspaceId, 1);
      return;
    }

    throw new ScientificCloudTransferUnsupportedError(
      'Scientific database storage cannot be enabled for a project with a cloud-sync binding. Use a separate local project until scientific history transfer is supported.'
    );
  }
}
