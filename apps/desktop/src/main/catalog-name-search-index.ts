import type Database from 'better-sqlite3';

export const CATALOG_NAME_SEARCH_TRIGGERS = {
  catalog_entity_name_fts_insert: `CREATE TRIGGER catalog_entity_name_fts_insert
    AFTER INSERT ON catalog_entities BEGIN
      INSERT INTO catalog_entity_name_fts(rowid, name) VALUES (new.rowid, new.name);
    END`,
  catalog_entity_name_fts_delete: `CREATE TRIGGER catalog_entity_name_fts_delete
    AFTER DELETE ON catalog_entities BEGIN
      INSERT INTO catalog_entity_name_fts(catalog_entity_name_fts, rowid, name)
      VALUES ('delete', old.rowid, old.name);
    END`,
  catalog_entity_name_fts_update: `CREATE TRIGGER catalog_entity_name_fts_update
    AFTER UPDATE OF name, rowid ON catalog_entities BEGIN
      INSERT INTO catalog_entity_name_fts(catalog_entity_name_fts, rowid, name)
      VALUES ('delete', old.rowid, old.name);
      INSERT INTO catalog_entity_name_fts(rowid, name) VALUES (new.rowid, new.name);
    END`,
} as const;

interface CatalogNameSearchSchemaObject {
  type: string;
  name: string;
  sql: string | null;
}

function normalizedSql(sql: string | null | undefined): string {
  return (sql ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace('CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER ');
}

export function catalogNameSearchIndexState(
  objects: readonly CatalogNameSearchSchemaObject[]
): 'unavailable' | 'rebuild-required' | 'ready' {
  if (!objects.some((object) => object.type === 'table' && object.name === 'catalog_entities')) {
    return 'unavailable';
  }
  const indexExists = objects.some(
    (object) => object.type === 'table' && object.name === 'catalog_entity_name_fts'
  );
  const maintenanceComplete = Object.entries(CATALOG_NAME_SEARCH_TRIGGERS).every(([name, sql]) =>
    objects.some(
      (object) =>
        object.type === 'trigger' &&
        object.name === name &&
        normalizedSql(object.sql) === normalizedSql(sql)
    )
  );
  return indexExists && maintenanceComplete ? 'ready' : 'rebuild-required';
}

export function createCatalogNameSearchIndex(db: Database.Database): void {
  db.transaction(() => {
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE (type = 'table' AND name IN ('catalog_entities', 'catalog_entity_name_fts'))
            OR (type = 'trigger' AND tbl_name = 'catalog_entities')`
      )
      .all() as CatalogNameSearchSchemaObject[];
    const state = catalogNameSearchIndexState(objects);
    if (state === 'unavailable') return;

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_entities_active_name
      ON catalog_entities(name COLLATE NOCASE, updated_at DESC)
      WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_catalog_entities_active_updated
      ON catalog_entities(updated_at DESC)
      WHERE status = 'active';
      CREATE VIRTUAL TABLE IF NOT EXISTS catalog_entity_name_fts USING fts5(
        name,
        content = 'catalog_entities',
        content_rowid = 'rowid',
        tokenize = 'trigram'
      );
    `);

    if (state === 'rebuild-required') {
      for (const [name, sql] of Object.entries(CATALOG_NAME_SEARCH_TRIGGERS)) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        db.exec(sql);
      }
      db.exec("INSERT INTO catalog_entity_name_fts(catalog_entity_name_fts) VALUES ('rebuild')");
    }
  })();
}
