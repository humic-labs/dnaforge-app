import type Database from 'better-sqlite3';

export function createAdministrationTables(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS administration_actions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS administration_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
}

export function assertAdministrationSqlBoundary(sql: string): void {
  if (/\badministration_(actions|preferences)\b/iu.test(sql))
    throw new Error(
      'Use the native administration commands to access protected settings and retained actions.'
    );
}
