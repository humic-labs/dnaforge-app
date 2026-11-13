// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { createAdministrationStorage } from './administration-storage';
import {
  assertAdministrationSqlBoundary,
  createAdministrationTables,
} from './administration-schema';

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { CURRENT_SCHEMA_VERSION, ensureSchema } from './schema';

describe('native administration persistence', () => {
  it('migrates an existing profile through the normal versioned schema without changing its old settings', () => {
    const db = createTestDb();
    try {
      ensureSchema(db, ':memory:');
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        'display_zoom',
        '1.25',
        100
      );
      db.exec(
        'DROP TABLE administration_actions; DROP TABLE administration_preferences; PRAGMA user_version = 41'
      );
      ensureSchema(db, ':memory:');
      expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      expect(createAdministrationStorage(() => db).readSettings()).toMatchObject({
        displayZoom: 1.25,
      });
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('display_zoom')).toEqual({
        value: '1.25',
      });
    } finally {
      db.close();
    }
  });

  it('never creates tables while inspecting preferences or a retained action', () => {
    const db = createTestDb();
    const storage = createAdministrationStorage(() => db);
    try {
      expect(() => storage.readSettings()).toThrow('no such table');
      expect(() => storage.readAction('missing')).toThrow('no such table');
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'administration_%'").all()
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps canonical native values authoritative after compatibility settings change', () => {
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    createAdministrationTables(db);
    const storage = createAdministrationStorage(() => db);
    try {
      storage.writeSettings(
        {
          theme: 'dark',
          displayZoom: 1.25,
          assemblyColorScheme: 'carbon',
          webglPerformance: 'stability',
        },
        ['theme', 'displayZoom', 'assemblyColorScheme', 'webglPerformance']
      );
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('2', 'display_zoom');
      expect(createAdministrationStorage(() => db).readSettings()).toEqual({
        theme: 'dark',
        displayZoom: 1.25,
        assemblyColorScheme: 'carbon',
        webglPerformance: 'stability',
      });
    } finally {
      db.close();
    }
  });

  it.each([
    'SELECT * FROM administration_actions',
    'DELETE FROM "administration_preferences"',
    "UPDATE main.[administration_actions] SET payload = '{}'",
    'WITH candidate AS (SELECT payload FROM `administration_actions`) SELECT * FROM candidate',
  ])('refuses renderer SQL against protected native state: %s', (sql) => {
    expect(() => assertAdministrationSqlBoundary(sql)).toThrow('native administration');
  });
});
