import type Database from 'better-sqlite3';

export function createScientificHistoryIdentityTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scientific_workspace_identities (
    workspace_id INTEGER PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    logical_workspace_id TEXT NOT NULL CHECK(length(logical_workspace_id) > 0),
    remote_workspace_id TEXT
  );`);
}

export function migrateScientificHistoryIdentity(db: Database.Database): void {
  createScientificHistoryIdentityTable(db);
  db.exec(`INSERT OR IGNORE INTO scientific_workspace_identities (workspace_id, logical_workspace_id)
    SELECT id, CASE WHEN repo_uuid IS NOT NULL AND length(repo_uuid) > 0 THEN repo_uuid ELSE 'ws' || id END
    FROM workspaces WHERE
      EXISTS (SELECT 1 FROM scientific_revision_records WHERE workspace_id=workspaces.id) OR
      EXISTS (SELECT 1 FROM scientific_revision_refs WHERE workspace_id=workspaces.id) OR
      EXISTS (SELECT 1 FROM scientific_revision_blobs WHERE workspace_id=workspaces.id) OR
      EXISTS (SELECT 1 FROM scientific_materialization_jobs WHERE workspace_id=workspaces.id);`);
}
