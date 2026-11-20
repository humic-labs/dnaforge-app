import type Database from 'better-sqlite3';

export function createSavedFileSourceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retained_file_source_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id INTEGER,
      entity_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','committed','rejected')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retained_file_publication_witnesses (
      revision_id TEXT PRIMARY KEY NOT NULL REFERENCES retained_file_source_revisions(id),
      device TEXT NOT NULL, inode TEXT NOT NULL, birth_ns TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS keep_retained_file_publication_witness BEFORE DELETE ON retained_file_publication_witnesses
      BEGIN SELECT RAISE(ABORT,'A retained publication witness is immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS freeze_retained_file_publication_witness BEFORE UPDATE ON retained_file_publication_witnesses
      BEGIN SELECT RAISE(ABORT,'A retained publication witness is immutable.'); END;
    CREATE INDEX IF NOT EXISTS idx_retained_file_source_owner
      ON retained_file_source_revisions(workspace_id,entity_id,status);
    CREATE TRIGGER IF NOT EXISTS prevent_retained_file_source_replacement BEFORE INSERT ON retained_file_source_revisions
      WHEN EXISTS(SELECT 1 FROM retained_file_source_revisions WHERE id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'A retained file source revision cannot be replaced.'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_retained_witness_replacement BEFORE INSERT ON retained_file_publication_witnesses
      WHEN EXISTS(SELECT 1 FROM retained_file_publication_witnesses WHERE revision_id=NEW.revision_id)
      BEGIN SELECT RAISE(ABORT,'A retained publication witness cannot be replaced.'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_retained_file_source
      BEFORE UPDATE ON retained_file_source_revisions WHEN
        OLD.status!='prepared' OR NEW.status NOT IN ('committed','rejected') OR
        NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR
        NEW.entity_id IS NOT OLD.entity_id OR NEW.source_path IS NOT OLD.source_path OR
        NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR NEW.manifest_json IS NOT OLD.manifest_json OR
        NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'A retained file source revision is immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS preserve_retained_file_source
      BEFORE DELETE ON retained_file_source_revisions
      BEGIN SELECT RAISE(ABORT,'A retained file source revision is permanent.'); END;
  `);
}
