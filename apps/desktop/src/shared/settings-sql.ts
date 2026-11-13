export const SELECT_SETTING_SQL = 'SELECT value FROM settings WHERE key = ?';
export const UPSERT_SETTING_SQL =
  'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)';
