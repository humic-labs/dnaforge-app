import type Database from 'better-sqlite3';

export function createScientificObjectTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scientific_revision_records (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      record_kind TEXT NOT NULL CHECK(record_kind IN (
        'resource-state', 'resource-revision', 'workspace-version', 'operation-receipt',
        'recovery-candidate', 'workspace-resource-map-node', 'workspace-path-map-node'
      )),
      canonical_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, record_id)
    );
    CREATE TABLE IF NOT EXISTS scientific_revision_refs (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      ref_name TEXT NOT NULL,
      head TEXT,
      PRIMARY KEY (workspace_id, ref_name),
      FOREIGN KEY (workspace_id, head) REFERENCES scientific_revision_records(workspace_id, record_id)
    );
    CREATE TABLE IF NOT EXISTS scientific_revision_blobs (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      blob_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      bytes BLOB NOT NULL CHECK(length(bytes) = byte_length),
      PRIMARY KEY (workspace_id, blob_hash)
    );
    CREATE TABLE IF NOT EXISTS scientific_materialization_jobs (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      base_version_id TEXT,
      payload_version INTEGER NOT NULL CHECK(payload_version = 1),
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'blocked', 'succeeded')),
      progress_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, version_id),
      UNIQUE (workspace_id, operation_id),
      FOREIGN KEY (workspace_id, version_id) REFERENCES scientific_revision_records(workspace_id, record_id),
      FOREIGN KEY (workspace_id, base_version_id) REFERENCES scientific_revision_records(workspace_id, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scientific_materialization_pending
      ON scientific_materialization_jobs(workspace_id, created_at)
      WHERE status != 'succeeded';
  `);
}
