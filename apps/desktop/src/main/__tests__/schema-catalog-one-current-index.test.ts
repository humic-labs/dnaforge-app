import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

vi.mock('../analytics', () => ({
  trackEvent: vi.fn(),
}));

import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../schema';

const V16 = 16;

type FileSeed = {
  id: string;
  entity_id: string;
  path: string;
  status?: string;
};

function seedCatalogV16(db: Database.Database, entityIds: string[], files: FileSeed[]): void {
  db.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        repo_uuid TEXT, origin_path TEXT, archived_at INTEGER, trashed_at INTEGER,
        created_at INTEGER NOT NULL, last_opened_at INTEGER
      );
    CREATE TABLE catalog_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      locator TEXT NOT NULL UNIQUE,
      storage_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      workspace_id INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE catalog_entity_files (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      workspace_id INTEGER,
      path TEXT NOT NULL UNIQUE,
      relative_path TEXT,
      file_kind TEXT NOT NULL,
      content_hash TEXT,
      size_bytes INTEGER,
      modified_at INTEGER,
      status TEXT NOT NULL DEFAULT 'current',
      last_seen_at INTEGER,
      missing_since INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE catalog_entity_events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      summary TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  const insEntity = db.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, created_at, updated_at)
     VALUES (?, 'notebook', ?, ?, 'file', 'active', 0, 0)`
  );
  for (const id of entityIds) insEntity.run(id, id, `locator:${id}`);
  const insFile = db.prepare(
    `INSERT INTO catalog_entity_files (id, entity_id, path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'notebook', ?, 0, 0)`
  );
  for (const f of files) insFile.run(f.id, f.entity_id, f.path, f.status ?? 'current');
  db.pragma(`user_version = ${V16}`);
}

function currentBindings(db: Database.Database, entityId: string): string[] {
  return (
    db
      .prepare(
        `SELECT path FROM catalog_entity_files WHERE entity_id = ? AND status = 'current' ORDER BY path`
      )
      .all(entityId) as { path: string }[]
  ).map((r) => r.path);
}

function statusFor(db: Database.Database, fileId: string): string | undefined {
  const row = db.prepare(`SELECT status FROM catalog_entity_files WHERE id = ?`).get(fileId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function oneCurrentIndexExists(db: Database.Database): boolean {
  return (
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_catalog_entity_files_one_current'`
        )
        .all() as { name: string }[]
    ).length > 0
  );
}

let db: Database.Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

describe('migrateToV17 — one-current-binding dedup + partial unique index', () => {
  it('collapses multiple current bindings to the canonical one, keeping the notebooks/ path', () => {
    db = createTestDb();

    seedCatalogV16(
      db,
      ['ent-nb'],
      [
        { id: 'f1', entity_id: 'ent-nb', path: '/ws/Nb 2/.forge/notebook.json' },
        { id: 'f2', entity_id: 'ent-nb', path: '/ws/notebooks/Nb/.forge/notebook.json' },
        { id: 'f3', entity_id: 'ent-nb', path: '/ws/Nb 3/.forge/notebook.json' },
      ]
    );

    ensureSchema(db, ':memory:');

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(oneCurrentIndexExists(db)).toBe(true);

    expect(currentBindings(db, 'ent-nb')).toEqual(['/ws/notebooks/Nb/.forge/notebook.json']);
    expect(statusFor(db, 'f2')).toBe('current');
    expect(statusFor(db, 'f1')).toBe('historical');
    expect(statusFor(db, 'f3')).toBe('historical');

    const total = db.prepare(`SELECT COUNT(*) c FROM catalog_entity_files`).get() as { c: number };
    expect(total.c).toBe(3);
  });

  it('with no notebooks/ path, the lexicographically-first survives', () => {
    db = createTestDb();
    seedCatalogV16(
      db,
      ['ent-x'],
      [
        { id: 'a', entity_id: 'ent-x', path: '/ws/zeta.gb' },
        { id: 'b', entity_id: 'ent-x', path: '/ws/alpha.gb' },
        { id: 'c', entity_id: 'ent-x', path: '/ws/mid.gb' },
      ]
    );

    ensureSchema(db, ':memory:');

    expect(currentBindings(db, 'ent-x')).toEqual(['/ws/alpha.gb']);
  });

  it('the partial unique index structurally REJECTS a second current binding', () => {
    db = createTestDb();
    seedCatalogV16(db, ['ent-a'], [{ id: 'only', entity_id: 'ent-a', path: '/ws/a.gb' }]);

    ensureSchema(db, ':memory:');

    expect(() =>
      db!
        .prepare(
          `INSERT INTO catalog_entity_files (id, entity_id, path, file_kind, status, created_at, updated_at)
           VALUES ('dup', 'ent-a', '/ws/a-2.gb', 'sequence', 'current', 0, 0)`
        )
        .run()
    ).toThrow(/UNIQUE constraint failed/i);

    db.prepare(
      `INSERT INTO catalog_entity_files (id, entity_id, path, file_kind, status, created_at, updated_at)
       VALUES ('hist', 'ent-a', '/ws/a-3.gb', 'sequence', 'historical', 0, 0)`
    ).run();
    expect(() =>
      db!.prepare(`UPDATE catalog_entity_files SET status = 'current' WHERE id = 'hist'`).run()
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('is idempotent — a second ensureSchema demotes nothing and keeps the index', () => {
    db = createTestDb();
    seedCatalogV16(
      db,
      ['ent-nb'],
      [
        { id: 'f1', entity_id: 'ent-nb', path: '/ws/Nb 2/.forge/notebook.json' },
        { id: 'f2', entity_id: 'ent-nb', path: '/ws/notebooks/Nb/.forge/notebook.json' },
      ]
    );

    ensureSchema(db, ':memory:');
    const afterFirst = db
      .prepare(`SELECT id, status FROM catalog_entity_files ORDER BY id`)
      .all() as { id: string; status: string }[];

    ensureSchema(db, ':memory:');
    const afterSecond = db
      .prepare(`SELECT id, status FROM catalog_entity_files ORDER BY id`)
      .all() as { id: string; status: string }[];

    expect(afterSecond).toEqual(afterFirst);
    expect(oneCurrentIndexExists(db)).toBe(true);
  });

  it('leaves adversarial shapes untouched: all-historical, single-current, zero-row entities', () => {
    db = createTestDb();
    seedCatalogV16(
      db,
      ['ent-allhist', 'ent-single', 'ent-empty'],
      [
        { id: 'h1', entity_id: 'ent-allhist', path: '/ws/h1.gb', status: 'historical' },
        { id: 'h2', entity_id: 'ent-allhist', path: '/ws/h2.gb', status: 'historical' },
        { id: 's1', entity_id: 'ent-single', path: '/ws/s1.gb', status: 'current' },
      ]
    );

    expect(() => ensureSchema(db!, ':memory:')).not.toThrow();

    expect(currentBindings(db, 'ent-allhist')).toEqual([]);
    expect(currentBindings(db, 'ent-single')).toEqual(['/ws/s1.gb']);

    const total = db.prepare(`SELECT COUNT(*) c FROM catalog_entity_files`).get() as { c: number };
    expect(total.c).toBe(3);
  });

  it('does not brick on a large duplicate set (50 current bindings collapse to 1)', () => {
    db = createTestDb();
    const files: FileSeed[] = Array.from({ length: 50 }, (_, i) => ({
      id: `big-${i}`,
      entity_id: 'ent-big',
      path: `/ws/copy-${String(i).padStart(3, '0')}.gb`,
    }));
    seedCatalogV16(db, ['ent-big'], files);

    ensureSchema(db, ':memory:');

    expect(currentBindings(db, 'ent-big')).toEqual(['/ws/copy-000.gb']);
    const counts = db
      .prepare(
        `SELECT status, COUNT(*) c FROM catalog_entity_files GROUP BY status ORDER BY status`
      )
      .all() as { status: string; c: number }[];
    expect(counts).toEqual([
      { status: 'current', c: 1 },
      { status: 'historical', c: 49 },
    ]);
  });

  it('preserves every path + entity_id across the migration (only status changes)', () => {
    db = createTestDb();
    const seed: FileSeed[] = [
      { id: 'f1', entity_id: 'ent-nb', path: '/ws/Nb 2/.forge/notebook.json' },
      { id: 'f2', entity_id: 'ent-nb', path: '/ws/notebooks/Nb/.forge/notebook.json' },
      { id: 'g1', entity_id: 'ent-seq', path: '/ws/plasmid.gb' },
    ];
    seedCatalogV16(db, ['ent-nb', 'ent-seq'], seed);
    const before = db
      .prepare(`SELECT id, entity_id, path FROM catalog_entity_files ORDER BY id`)
      .all();

    ensureSchema(db, ':memory:');

    const after = db
      .prepare(`SELECT id, entity_id, path FROM catalog_entity_files ORDER BY id`)
      .all();
    expect(after).toEqual(before);
  });
});
