import type Database from 'better-sqlite3';

export function readBetaUpdatesSetting(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('beta_updates') as
      | { value: string }
      | undefined;
    return row?.value === 'true';
  } catch {
    return false;
  }
}
