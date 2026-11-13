import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { createCatalogNameSearchIndex } from '../catalog-name-search-index';

let db: Database.Database;

function catalog() {
  return db.prepare('SELECT id, name FROM catalog_entities ORDER BY id').all();
}

function matches(query: string) {
  return db
    .prepare(
      `SELECT id FROM catalog_entities WHERE rowid IN (
         SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?
       ) ORDER BY id`
    )
    .all(`"${query}"`);
}

function integrity() {
  db.exec(
    "INSERT INTO catalog_entity_name_fts(catalog_entity_name_fts, rank) VALUES ('integrity-check', 1)"
  );
}

beforeEach(() => {
  db = createTestDb();
  db.exec(
    'CREATE TABLE catalog_entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, updated_at INTEGER)'
  );
  createCatalogNameSearchIndex(db);
  db.prepare('INSERT INTO catalog_entities VALUES (?, ?, ?, ?)').run(
    'first',
    'Original target',
    'active',
    1
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('catalog name index lifecycle', () => {
  it.each(['insert', 'update', 'delete'])(
    'rebuilds missed changes after %s maintenance disappears',
    (operation) => {
      db.exec(`DROP TRIGGER catalog_entity_name_fts_${operation}`);
      if (operation === 'insert') {
        db.prepare('INSERT INTO catalog_entities VALUES (?, ?, ?, ?)').run(
          'second',
          'Added target',
          'active',
          2
        );
      } else if (operation === 'update') {
        db.prepare('UPDATE catalog_entities SET name = ? WHERE id = ?').run(
          'Renamed target',
          'first'
        );
      } else {
        db.prepare('DELETE FROM catalog_entities WHERE id = ?').run('first');
      }
      const before = catalog();
      expect(integrity).toThrow();

      createCatalogNameSearchIndex(db);

      expect(catalog()).toEqual(before);
      expect(integrity).not.toThrow();
      expect(matches('Original')).toEqual(operation === 'insert' ? [{ id: 'first' }] : []);
      expect(matches('Added')).toEqual(operation === 'insert' ? [{ id: 'second' }] : []);
      expect(matches('Renamed')).toEqual(operation === 'update' ? [{ id: 'first' }] : []);
    }
  );

  it('replaces an incomplete trigger before publishing the rebuilt index', () => {
    db.exec(`
      DROP TRIGGER catalog_entity_name_fts_update;
      CREATE TRIGGER catalog_entity_name_fts_update AFTER UPDATE OF name ON catalog_entities
      BEGIN SELECT 1; END;
    `);
    db.prepare('UPDATE catalog_entities SET name = ? WHERE id = ?').run('Missed rename', 'first');
    const before = catalog();

    createCatalogNameSearchIndex(db);

    expect(catalog()).toEqual(before);
    expect(integrity).not.toThrow();
    expect(matches('Missed')).toEqual([{ id: 'first' }]);
    db.prepare('UPDATE catalog_entities SET name = ? WHERE id = ?').run('Future rename', 'first');
    expect(matches('Missed')).toEqual([]);
    expect(matches('Future')).toEqual([{ id: 'first' }]);
  });

  it('rolls back failed repair and converges on the next attempt', () => {
    db.exec('DROP TRIGGER catalog_entity_name_fts_update');
    db.prepare('UPDATE catalog_entities SET name = ? WHERE id = ?').run('Missed rename', 'first');
    const before = catalog();
    const original = db.exec.bind(db);
    const intercepted = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql.includes("VALUES ('rebuild')")) throw new Error('interrupted repair');
      return original(sql);
    });

    expect(() => createCatalogNameSearchIndex(db)).toThrow('interrupted repair');
    expect(catalog()).toEqual(before);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'catalog_entity_name_fts_update'").get()
    ).toBeUndefined();
    intercepted.mockRestore();

    createCatalogNameSearchIndex(db);
    expect(matches('Missed')).toEqual([{ id: 'first' }]);
    expect(integrity).not.toThrow();
  });

  it('does not rebuild an already complete index on repeated initialization', () => {
    const original = db.exec.bind(db);
    const intercepted = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql.includes("VALUES ('rebuild')")) throw new Error('unexpected rebuild');
      return original(sql);
    });
    expect(() => createCatalogNameSearchIndex(db)).not.toThrow();
    expect(() => createCatalogNameSearchIndex(db)).not.toThrow();
    intercepted.mockRestore();
    expect(matches('Original')).toEqual([{ id: 'first' }]);
    expect(integrity).not.toThrow();
  });
});
