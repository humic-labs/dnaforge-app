import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { ensureSchema } from '../schema';

let db: Database.Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

function seedEntityWithCurrent(d: Database.Database, entityId: string, path: string): void {
  d.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, created_at, updated_at)
     VALUES (?, 'notebook', ?, ?, 'database', 'active', 0, 0)`
  ).run(entityId, entityId, `entity://page/${entityId}`);
  d.prepare(
    `INSERT INTO catalog_entity_files
     (id, entity_id, path, file_kind, status, object_uuid, created_at, updated_at)
     VALUES (?, ?, ?, 'waypoint-notebook', 'current', ?, 0, 0)`
  ).run(`${entityId}-file-a`, entityId, path, crypto.randomUUID());
}

describe(' S4 — demote-first under v17 one-current index', () => {
  it('upserting a second current BEFORE demoting violates the unique index (B2 RED)', () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedEntityWithCurrent(db, 'e1', '/ws/notebooks/A');

    expect(() => {
      db!
        .prepare(
          `INSERT INTO catalog_entity_files
         (id, entity_id, path, file_kind, status, object_uuid, created_at, updated_at)
         VALUES ('e1-file-b', 'e1', '/ws/notebooks/B', 'waypoint-notebook', 'current', ?, 0, 0)`
        )
        .run(crypto.randomUUID());
    }).toThrow(/UNIQUE|unique/i);
  });

  it('demoting the prior current THEN upserting the new current succeeds (S4 GREEN)', () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedEntityWithCurrent(db, 'e1', '/ws/notebooks/A');

    db.prepare(`UPDATE catalog_entity_files SET status = 'historical' WHERE path = ?`).run(
      '/ws/notebooks/A'
    );
    expect(() => {
      db!
        .prepare(
          `INSERT INTO catalog_entity_files
         (id, entity_id, path, file_kind, status, object_uuid, created_at, updated_at)
         VALUES ('e1-file-b', 'e1', '/ws/notebooks/B', 'waypoint-notebook', 'current', ?, 0, 0)`
        )
        .run(crypto.randomUUID());
    }).not.toThrow();

    const currents = db
      .prepare(
        `SELECT path FROM catalog_entity_files WHERE entity_id = 'e1' AND status = 'current'`
      )
      .all() as { path: string }[];
    expect(currents.map((r) => r.path)).toEqual(['/ws/notebooks/B']);
  });
});
