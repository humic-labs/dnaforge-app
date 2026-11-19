import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  SAVED_ENTITY_ROW_SOURCES,
  type SavedEntityRowSource,
} from '../shared/saved-entity-row-version';

type Column = { name: string; type: string; pk: number };
export const sqliteIdentifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function createHistory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_entity_row_versions (
      version INTEGER PRIMARY KEY,
      revision_id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
      source_table TEXT NOT NULL,
      identity TEXT NOT NULL,
      payload TEXT NOT NULL,
      binary_payload BLOB,
      recorded_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS idx_saved_entity_row_identity ON saved_entity_row_versions(source_table,identity,version);
    CREATE INDEX IF NOT EXISTS idx_saved_entity_row_source ON saved_entity_row_versions(source_table,version);
    CREATE TRIGGER IF NOT EXISTS immutable_saved_entity_row_versions BEFORE UPDATE ON saved_entity_row_versions
      BEGIN SELECT RAISE(ABORT,'Saved entity versions are immutable.'); END;
    CREATE TRIGGER IF NOT EXISTS preserve_saved_entity_row_versions BEFORE DELETE ON saved_entity_row_versions
      BEGIN SELECT RAISE(ABORT,'Saved entity versions are retained.'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_replacing_saved_entity_row_versions BEFORE INSERT ON saved_entity_row_versions
      WHEN EXISTS(SELECT 1 FROM saved_entity_row_versions WHERE version=NEW.version OR revision_id=NEW.revision_id)
      BEGIN SELECT RAISE(ABORT,'A saved entity version cannot be replaced.'); END;
  `);
}

function retainRowSql(
  table: SavedEntityRowSource,
  columns: Column[],
  migrate: boolean,
  legacyRecovery = false
) {
  const alias = migrate ? 'source' : 'NEW';
  const field = (name: string) => alias + '.' + sqliteIdentifier(name);
  const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
  const keyFields = keys.length ? keys.map((c) => field(c.name)) : [alias + '.rowid'];
  const key =
    'json_array(' + keyFields.map((value) => 'CAST(' + value + ' AS TEXT)').join(',') + ')';
  const binary = columns.find((column) => column.type.toUpperCase() === 'BLOB');
  const raw = binary ? field(binary.name) : 'NULL';
  const fields = columns.map((column) => {
    const value = field(column.name);
    const blob =
      column === binary ? "json_array('binary')" : "json_array('hex',hex(" + value + '))';
    return `${literal(column.name)},CASE typeof(${value})
      WHEN 'integer' THEN json_array('integer',CAST(${value} AS TEXT))
      WHEN 'real' THEN json_array('real',printf('%!.26g',${value}))
      WHEN 'blob' THEN ${blob} ELSE ${value} END`;
  });
  const revisionColumn = legacyRecovery ? 'revision_id,' : '';
  const revisionValue = legacyRecovery
    ? 'saved_recovery_id(candidate.key,CAST(candidate.payload AS BLOB),candidate.raw),'
    : '';
  const prior = table.startsWith('lims_')
    ? `prior.source_table=${literal(table)} AND prior.identity=candidate.key`
    : `prior.version=(SELECT version FROM saved_entity_row_versions WHERE source_table=${literal(table)}
        AND identity=candidate.key ORDER BY version DESC LIMIT 1)`;
  const missing = `FROM (SELECT ${key} AS key,json_object(${fields.join(',')}) AS payload,
      CASE WHEN typeof(${raw})='blob' THEN ${raw} END AS raw
      ${migrate ? 'FROM ' + sqliteIdentifier(table) + ' AS source' : ''}) AS candidate
    WHERE NOT EXISTS(SELECT 1 FROM saved_entity_row_versions AS prior
      WHERE ${prior} AND prior.payload=candidate.payload AND prior.binary_payload IS candidate.raw)`;
  const insert = `INSERT INTO saved_entity_row_versions(${revisionColumn}source_table,identity,payload,binary_payload)
    SELECT ${revisionValue}${literal(table)},candidate.key,candidate.payload,candidate.raw ${missing}`;
  return { insert, missing };
}

function adoptRows(
  db: Database.Database,
  table: SavedEntityRowSource,
  columns: Column[],
  legacyRecovery = false
): void {
  const { insert, missing } = retainRowSql(table, columns, true, legacyRecovery);
  db.exec(insert);
  if (db.prepare('SELECT 1 ' + missing + ' LIMIT 1').get())
    throw new Error('Existing saved entity rows could not be retained.');
}

function installHistory(db: Database.Database, captureBeforeUpgrade: boolean): void {
  createHistory(db);
  const info = db.prepare('SELECT name,type,pk FROM pragma_table_info(?) ORDER BY cid');
  const findTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='trigger'");
  for (const table of SAVED_ENTITY_ROW_SOURCES) {
    const columns = info.all(table) as Column[];
    if (!columns.length) continue;
    if (captureBeforeUpgrade) {
      adoptRows(db, table, columns);
      continue;
    }
    const capture = retainRowSql(table, columns, false);
    const triggers = (['INSERT', 'UPDATE'] as const).map((operation) => {
      const name = 'retain_' + table + '_' + operation.toLowerCase();
      const changed =
        operation === 'UPDATE' && table === 'scientific_work_rules'
          ? ' WHEN ' +
            columns
              .filter((column) => column.name !== 'scanned_at')
              .map(
                (column) =>
                  'NEW.' +
                  sqliteIdentifier(column.name) +
                  ' IS NOT OLD.' +
                  sqliteIdentifier(column.name)
              )
              .join(' OR ')
          : '';
      const sql = `CREATE TRIGGER ${name} AFTER ${operation} ON ${sqliteIdentifier(table)}${changed}
        BEGIN
          ${capture.insert};
          SELECT CASE WHEN changes()=0 THEN CASE WHEN EXISTS(SELECT 1 ${capture.missing})
            THEN RAISE(ABORT,'Saved entity bytes must be retained before saving.') END END;
        END`;
      return { name, sql };
    });
    if (
      triggers.every(
        (trigger) =>
          (findTrigger.get(trigger.name) as { sql: string } | undefined)?.sql === trigger.sql
      )
    )
      continue;
    adoptRows(db, table, columns);
    for (const trigger of triggers) {
      db.exec('DROP TRIGGER IF EXISTS ' + trigger.name);
      db.exec(trigger.sql);
    }
  }
}

export function installSavedEntityRowHistory(
  db: Database.Database,
  captureBeforeUpgrade = false
): void {
  db.transaction(() => installHistory(db, captureBeforeUpgrade))();
}

export function adoptLegacyRowsInRecoveryCopy(
  db: Database.Database,
  table: SavedEntityRowSource,
  generation: string
): void {
  db.function(
    'saved_recovery_id',
    { deterministic: true },
    (key: string, payload: Buffer, bytes: Buffer | null) => {
      const digest = createHash('sha256')
        .update(JSON.stringify([generation, table, key]))
        .update('\0')
        .update(payload);
      if (bytes) digest.update(bytes);
      return digest.digest('hex').slice(0, 32);
    }
  );
  db.transaction(() => {
    createHistory(db);
    const columns = db
      .prepare('SELECT name,type,pk FROM pragma_table_info(?) ORDER BY cid')
      .all(table) as Column[];
    if (columns.length) adoptRows(db, table, columns, true);
  })();
}
