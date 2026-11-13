import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../schema';

const V17 = 17;

function seedV17(db: Database.Database): void {
  db.exec(`
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER,
      repo_uuid TEXT
    );
    CREATE TABLE catalog_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      locator TEXT NOT NULL UNIQUE,
      storage_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE catalog_entity_files (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      workspace_id INTEGER,
      path TEXT NOT NULL UNIQUE,
      file_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'current',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE catalog_entity_events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      summary TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE catalog_entity_links (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      target_entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE entity_references (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      display_label TEXT NOT NULL,
      locator TEXT NOT NULL,
      deep_link_params TEXT,
      data TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_catalog_entity_files_one_current
      ON catalog_entity_files(entity_id) WHERE status = 'current';
  `);
  db.pragma(`user_version = ${V17}`);
}

function insWorkspace(db: Database.Database, id: number, path: string, repoUuid: string | null) {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, repo_uuid) VALUES (?, ?, ?, 0, ?)`
  ).run(id, `ws${id}`, path, repoUuid);
}
function insNotebook(db: Database.Database, id: string, wsId: number | null) {
  db.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
     VALUES (?, 'notebook', ?, ?, 'database', 'active', ?, 0, 0)`
  ).run(id, id, `entity://page/${id}`, wsId);
  db.prepare(
    `INSERT INTO pages (id, title, content, created_at, updated_at) VALUES (?, ?, '{}', 0, 0)`
  ).run(id, id);
}
function insFile(db: Database.Database, fileId: string, entityId: string, path: string) {
  db.prepare(
    `INSERT INTO catalog_entity_files (id, entity_id, path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'waypoint-notebook', 'current', 0, 0)`
  ).run(fileId, entityId, path);
}

let db: Database.Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

const entityIds = (d: Database.Database) =>
  (d.prepare(`SELECT id FROM catalog_entities ORDER BY id`).all() as { id: string }[]).map(
    (r) => r.id
  );
const fkViolations = (d: Database.Database) => d.prepare(`PRAGMA foreign_key_check`).all();

describe('migrateToV18 — workspace-scoped notebook identity', () => {
  it('re-keys a bare notebook (entity + file + event + link + page) to repo_uuid scope', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 1, '/ws-a', 'repo-a');
    insNotebook(db, 'nb-1', 1);
    insFile(db, 'f1', 'nb-1', '/ws-a/nb/.forge/notebook.json');
    db.prepare(
      `INSERT INTO catalog_entity_events (id, entity_id, event_type, created_at) VALUES ('e1', 'nb-1', 'created', 0)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entity_links (id, source_entity_id, relation, target_entity_id, created_at, updated_at)
       VALUES ('l1', 'nb-1', 'derived-from', 'nb-1', 0, 0)`
    ).run();

    ensureSchema(db, ':memory:');

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    const newId = 'repo-a::nb-1';
    expect(entityIds(db)).toEqual([newId]);
    expect(db.prepare(`SELECT locator FROM catalog_entities WHERE id = ?`).get(newId)).toEqual({
      locator: `entity://page/${newId}`,
    });
    expect(db.prepare(`SELECT entity_id FROM catalog_entity_files WHERE id='f1'`).get()).toEqual({
      entity_id: newId,
    });
    expect(db.prepare(`SELECT entity_id FROM catalog_entity_events WHERE id='e1'`).get()).toEqual({
      entity_id: newId,
    });
    expect(
      db
        .prepare(
          `SELECT source_entity_id, target_entity_id FROM catalog_entity_links WHERE id='l1'`
        )
        .get()
    ).toEqual({ source_entity_id: newId, target_entity_id: newId });
    expect(db.prepare(`SELECT id FROM pages`).all()).toEqual([{ id: newId }]);
    expect(fkViolations(db)).toEqual([]);
  });

  it('falls back to ws<id> scope when the workspace has no repo_uuid', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 5, '/ws-b', null);
    insNotebook(db, 'nb-2', 5);
    insFile(db, 'f2', 'nb-2', '/ws-b/nb/.forge/notebook.json');

    ensureSchema(db, ':memory:');

    expect(entityIds(db)).toEqual(['ws5::nb-2']);
    expect(db.prepare(`SELECT id FROM pages`).all()).toEqual([{ id: 'ws5::nb-2' }]);
  });

  it('leaves designs, null-workspace notebooks, and already-scoped ids untouched', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 1, '/ws-a', 'repo-a');
    db.prepare(
      `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('design-1', 'design', 'D', 'entity://design/design-1', 'localStorage', 'active', 1, 0, 0)`
    ).run();
    insNotebook(db, 'nb-nows', null);
    insNotebook(db, 'repo-a::nb-already', 1);

    ensureSchema(db, ':memory:');

    expect(entityIds(db).sort()).toEqual(['design-1', 'nb-nows', 'repo-a::nb-already']);
  });

  it('is idempotent — a second run (repair path at CURRENT) re-keys nothing more', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 1, '/ws-a', 'repo-a');
    insNotebook(db, 'nb-1', 1);
    insFile(db, 'f1', 'nb-1', '/ws-a/nb/.forge/notebook.json');

    ensureSchema(db, ':memory:');
    const after1 = entityIds(db);
    ensureSchema(db, ':memory:');
    expect(entityIds(db)).toEqual(after1);
    expect(after1).toEqual(['repo-a::nb-1']);
    expect(fkViolations(db)).toEqual([]);
  });

  it('preserves every row across all tables (no data loss)', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 1, '/ws-a', 'repo-a');
    insWorkspace(db, 2, '/ws-b', 'repo-b');
    insNotebook(db, 'nb-1', 1);
    insNotebook(db, 'nb-2', 2);
    insFile(db, 'f1', 'nb-1', '/ws-a/nb/.forge/notebook.json');
    insFile(db, 'f2', 'nb-2', '/ws-b/nb/.forge/notebook.json');
    const count = (t: string) =>
      (db!.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    const before = {
      e: count('catalog_entities'),
      f: count('catalog_entity_files'),
      p: count('pages'),
    };

    ensureSchema(db, ':memory:');

    expect({
      e: count('catalog_entities'),
      f: count('catalog_entity_files'),
      p: count('pages'),
    }).toEqual(before);
    expect(entityIds(db).sort()).toEqual(['repo-a::nb-1', 'repo-b::nb-2']);
    expect(fkViolations(db)).toEqual([]);
  });

  it('re-keys a page @-mention locator in entity_references (SSOT soft ref, #7)', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 1, '/ws-a', 'repo-a');
    insNotebook(db, 'nb-1', 1);
    insFile(db, 'f1', 'nb-1', '/ws-a/nb/.forge/notebook.json');
    db.prepare(
      `INSERT INTO entity_references (id, entity_type, display_label, locator, source, status, created_at, updated_at)
       VALUES ('ref1', 'page', 'NB', 'entity://page/nb-1', 'ai', 'created', 0, 0)`
    ).run();

    ensureSchema(db, ':memory:');

    expect(db.prepare(`SELECT locator FROM entity_references WHERE id = 'ref1'`).get()).toEqual({
      locator: 'entity://page/repo-a::nb-1',
    });
  });

  it('does NOT wedge the upgrade when the target scoped id already exists in pages', () => {
    db = createTestDb();
    seedV17(db);
    insWorkspace(db, 1, '/ws-a', 'repo-a');
    insNotebook(db, 'nb-x', 1);
    insFile(db, 'f1', 'nb-x', '/ws-a/nb/.forge/notebook.json');
    db.prepare(
      `INSERT INTO pages (id, title, content, created_at, updated_at) VALUES ('repo-a::nb-x', 'preexisting', '{}', 0, 0)`
    ).run();

    expect(() => ensureSchema(db!, ':memory:')).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(entityIds(db)).toContain('nb-x');
    expect(db.prepare(`SELECT title FROM pages WHERE id = 'repo-a::nb-x'`).get()).toEqual({
      title: 'preexisting',
    });
    expect(fkViolations(db)).toEqual([]);
  });
});
