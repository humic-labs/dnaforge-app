import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFileTestDb, openFileTestDb } from './test-db';
import { createCatalogNameSearchIndex } from '../catalog-name-search-index';

it('retries repair after its owning process dies before the index rebuild commits', () => {
  const source = createFileTestDb('catalog-name-search-interruption');
  try {
    source.db.exec(
      'CREATE TABLE catalog_entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, updated_at INTEGER)'
    );
    createCatalogNameSearchIndex(source.db);
    source.db.exec(`
      INSERT INTO catalog_entities VALUES ('first', 'Original name', 'active', 1);
      DROP TRIGGER catalog_entity_name_fts_update;
      UPDATE catalog_entities SET name = 'Retained name' WHERE id = 'first';
    `);
    source.db.close();
    const moduleUrl = new URL('../catalog-name-search-index.ts', import.meta.url);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createRequire } from 'node:module';
      import { writeSync } from 'node:fs';
      const { createCatalogNameSearchIndex } = await import(process.argv[2]);
      const Database = createRequire(process.argv[2])('better-sqlite3');
      const db = new Database(process.argv[1], { nativeBinding: process.argv[3] });
      const original = db.exec.bind(db);
      db.exec = (sql) => {
        if (sql.includes("VALUES ('rebuild')")) {
          writeSync(1, 'repair-before-rebuild');
          process.kill(process.pid, 'SIGKILL');
        }
        return original(sql);
      };
      createCatalogNameSearchIndex(db);
      db.close();
    `,
        source.dbPath,
        moduleUrl.href,
        fileURLToPath(new URL('./__fixtures__/better_sqlite3_node.node', import.meta.url)),
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    expect(child.stdout).toBe('repair-before-rebuild');
    expect(child.signal).toBe('SIGKILL');
    const reopened = openFileTestDb(source.dbPath);
    try {
      expect(reopened.prepare('SELECT id, name FROM catalog_entities').all()).toEqual([
        { id: 'first', name: 'Retained name' },
      ]);
      expect(
        reopened
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'catalog_entity_name_fts_update'")
          .get()
      ).toBeUndefined();
      createCatalogNameSearchIndex(reopened);
      expect(
        reopened
          .prepare('SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?')
          .all('"Retained"')
      ).toHaveLength(1);
      expect(
        reopened
          .prepare('SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?')
          .all('"Original"')
      ).toEqual([]);
      reopened.exec(
        "INSERT INTO catalog_entity_name_fts(catalog_entity_name_fts, rank) VALUES ('integrity-check', 1)"
      );
    } finally {
      reopened.close();
    }
  } finally {
    source.cleanup();
  }
});
