import type Database from 'better-sqlite3';

const retiredTables = [
  'benchling_import_version_pins',
  'benchling_import_undo_catalog_outbox',
  'benchling_import_undo_operations',
  'benchling_import_observations',
  'benchling_import_claims',
  'benchling_import_versions',
  'benchling_import_version_actions',
  'benchling_import_effects',
] as const;

export function hasRetiredBenchlingUndoStorage(db: Database.Database): boolean {
  return retiredTables.some((name) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  );
}

export function assertRetiredBenchlingUndoSettled(db: Database.Database): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='benchling_import_undo_operations'"
      )
      .get()
  )
    return;
  if (
    db
      .prepare("SELECT 1 FROM benchling_import_undo_operations WHERE status <> 'completed' LIMIT 1")
      .get()
  ) {
    throw new Error(
      'An unfinished import Undo from an older experimental build prevents this database upgrade. ' +
        'Contact hello@dnaforge.com for a compatible recovery build before continuing the upgrade. ' +
        'This build has not changed your database or project files.'
    );
  }
}

export function retireBenchlingUndoStorage(db: Database.Database): void {
  assertRetiredBenchlingUndoSettled(db);
  db.transaction(() => {
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'guard_import_undo_*'"
      )
      .all();
    for (const row of triggers) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('name' in row) ||
        typeof row.name !== 'string'
      )
        throw new Error('Retired migration trigger has no valid name.');
      db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
    }
    for (const table of retiredTables) db.exec(`DROP TABLE IF EXISTS ${table}`);
  })();
}
