import { expect, it, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
}));

import { ensureSchema } from '../schema';
import { createFileTestDb, openFileTestDb } from './test-db';

it('preserves indexed catalog identities through the native VACUUM INTO backup route', () => {
  const source = createFileTestDb('catalog-name-search-backup');
  try {
    ensureSchema(source.db, ':memory:');
    const insert = source.db.prepare(
      `INSERT INTO catalog_entities
         (rowid, id, type, name, locator, storage_type, created_at, updated_at)
       VALUES (?, ?, 'structure', ?, ?, 'file', 1, 1)`
    );
    insert.run(500, 'alpha', 'Alpha structure', 'file://alpha');
    insert.run(900, 'gamma', 'Gamma structure', 'file://gamma');
    source.db.prepare('UPDATE catalog_entities SET rowid = 1200 WHERE id = ?').run('gamma');
    const backupPath = join(source.tmpDir, 'backup.db');
    source.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    const backup = openFileTestDb(backupPath);
    try {
      expect(
        backup
          .prepare(
            `SELECT e.id FROM catalog_entities e
             WHERE e.rowid IN (SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?)`
          )
          .all('"Gamma"')
      ).toEqual([{ id: 'gamma' }]);
      backup.exec(
        "INSERT INTO catalog_entity_name_fts(catalog_entity_name_fts, rank) VALUES ('integrity-check', 1)"
      );
    } finally {
      backup.close();
    }
  } finally {
    source.cleanup();
  }
});
