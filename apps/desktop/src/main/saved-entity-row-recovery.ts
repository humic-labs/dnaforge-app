import Database from 'better-sqlite3';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  flushFileAndParentDirectoryRequired,
  fsyncDirectoryRequired,
  parseDatabaseBackupFilename,
} from './database-recovery';
import {
  SAVED_ENTITY_ROW_SOURCES,
  type SavedEntityRowVersion,
  type SavedEntityRowVersionQuery,
  type SavedRowRecoveryRequest,
} from '../shared/saved-entity-row-version';
import { adoptLegacyRowsInRecoveryCopy, sqliteIdentifier } from './saved-entity-row-versions';

type Open = (path: string, options?: Database.Options) => Database.Database;
const openDatabase: Open = (path, options) => new Database(path, options);
const resetSuffix = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export function savedRowRecoveryGenerations(db: Database.Database): string[] {
  if (!isAbsolute(db.name)) return [];
  const prefix = basename(db.name) + '.pre-reset-';
  return readdirSync(dirname(db.name), { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
        ? entry.name.startsWith(prefix) && resetSuffix.test(entry.name.slice(prefix.length))
        : entry.isFile() &&
          (/^dnaforge-preRestore-v\d+-\d+(?:-\d+)?\.db$/u.test(entry.name) ||
            Boolean(parseDatabaseBackupFilename(entry.name)))
    )
    .map((entry) => entry.name)
    .sort();
}

function withGeneration<T>(
  db: Database.Database,
  generation: string | undefined,
  table: SavedEntityRowVersion['source'],
  open: Open,
  read: (source: Database.Database) => T
): T {
  if (generation === undefined) return read(db);
  if (!savedRowRecoveryGenerations(db).includes(generation))
    throw new Error('Unknown saved database generation.');
  const entry = join(dirname(db.name), generation);
  const path = lstatSync(entry).isDirectory() ? join(entry, basename(db.name)) : entry;
  const directory = mkdtempSync(join(tmpdir(), 'dnaforge-row-recovery-'));
  const isolated = join(directory, 'saved.db');
  try {
    for (const suffix of ['', '-wal', '-journal']) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (!stat && suffix) continue;
      if (!stat?.isFile()) throw new Error('Invalid saved database generation member.');
      copyFileSync(
        path + suffix,
        isolated + suffix,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
      );
    }
    const source = open(isolated, { fileMustExist: true });
    try {
      if (
        !source
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='saved_entity_row_versions'"
          )
          .get()
      ) {
        adoptLegacyRowsInRecoveryCopy(source, table, generation);
      }
      return read(source);
    } finally {
      source.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function listSavedEntityRowVersions(
  db: Database.Database,
  query: SavedEntityRowVersionQuery,
  open: Open = openDatabase
): SavedEntityRowVersion[] {
  if (
    !query ||
    !SAVED_ENTITY_ROW_SOURCES.includes(query.source) ||
    (query.identity !== undefined &&
      (!Array.isArray(query.identity) ||
        !query.identity.length ||
        query.identity.length > 16 ||
        query.identity.some((value) => typeof value !== 'string' || value.length > 8192))) ||
    (query.beforeVersion !== undefined &&
      (!Number.isSafeInteger(query.beforeVersion) || query.beforeVersion < 1)) ||
    (query.limit !== undefined &&
      (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200))
  )
    throw new Error('Invalid saved entity version query.');
  return withGeneration(db, query.generation, query.source, open, (source) => {
    const values: (string | number)[] = [query.source];
    let filters = 'source_table=?';
    if (query.identity) {
      filters += ' AND identity=?';
      values.push(JSON.stringify(query.identity));
    }
    if (query.beforeVersion) {
      filters += ' AND version<?';
      values.push(query.beforeVersion);
    }
    values.push(query.limit ?? 50);
    const rows = source
      .prepare(
        'SELECT version,revision_id AS revisionId,source_table AS source,identity,recorded_at AS recordedAt FROM saved_entity_row_versions WHERE ' +
          filters +
          ' ORDER BY version DESC LIMIT ?'
      )
      .all(...values) as Array<Omit<SavedEntityRowVersion, 'identity'> & { identity: string }>;
    return rows.map((row) => ({ ...row, identity: JSON.parse(row.identity) }));
  });
}

function sqliteValue(
  value: unknown,
  bytes: Buffer | null
): string | bigint | number | Buffer | null {
  if (value === null || typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value[0] === 'binary' && bytes !== null && value.length === 1) return bytes;
    if (value.length === 2 && typeof value[1] === 'string') {
      if (value[0] === 'integer') return BigInt(value[1]);
      if (value[0] === 'real') return Number(value[1].replace(/^(-?)Inf$/u, '$1Infinity'));
      if (value[0] === 'hex' && /^(?:[a-fA-F0-9]{2})*$/u.test(value[1]))
        return Buffer.from(value[1], 'hex');
    }
  }
  throw new Error('A retained SQLite value could not be decoded.');
}

export function recoverSavedEntityRowVersion(
  db: Database.Database,
  request: SavedRowRecoveryRequest,
  outputDirectory: string,
  open: Open = openDatabase
): { path: string } {
  if (
    !SAVED_ENTITY_ROW_SOURCES.includes(request?.source) ||
    typeof request?.revisionId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(request.revisionId) ||
    !isAbsolute(db.name)
  )
    throw new Error('A saved version in a persistent desktop database is required.');
  return withGeneration(db, request.generation, request.source, open, (source) => {
    const row = source
      .prepare(
        'SELECT source_table,identity,binary_payload,recorded_at FROM saved_entity_row_versions WHERE revision_id=? AND source_table=?'
      )
      .get(request.revisionId, request.source) as
      | {
          source_table: SavedEntityRowVersion['source'];
          identity: string;
          binary_payload: Buffer | null;
          recorded_at: number;
        }
      | undefined;
    if (!row || !SAVED_ENTITY_ROW_SOURCES.includes(row.source_table))
      throw new Error('Unknown saved entity version.');
    const fields = source
      .prepare(
        `
      SELECT field.key AS name,field.type AS type,
        CASE field.type WHEN 'text' THEN CAST(field.atom AS BLOB) ELSE field.value END AS value
      FROM saved_entity_row_versions,json_each(payload) AS field WHERE revision_id=?
    `
      )
      .all(request.revisionId) as Array<{
      name: string;
      type: 'text' | 'null' | 'array';
      value: string | Buffer | null;
    }>;
    const resultDir = mkdtempSync(join(outputDirectory, 'saved-entity-recovery-'));
    const path = join(resultDir, 'recovered.sqlite');
    try {
      const recovered = open(path);
      try {
        chmodSync(path, 0o600);
        const encoding = source.pragma('encoding', { simple: true });
        if (encoding === 'UTF-16le' || encoding === 'UTF-16be')
          recovered.pragma("encoding='" + encoding + "'");
        recovered.pragma('synchronous=FULL');
        recovered.transaction(() => {
          const table = sqliteIdentifier(row.source_table);
          const columns = fields.map((field) => sqliteIdentifier(field.name)).join(',');
          recovered.exec('CREATE TABLE ' + table + '(' + columns + ')');
          const values = fields.map((field) =>
            field.type === 'array' ? JSON.parse(field.value as string) : field.value
          );
          const placeholders = fields.map((field, index) =>
            field.type === 'text'
              ? 'CAST(? AS TEXT)'
              : Array.isArray(values[index]) && values[index][0] === 'real'
                ? 'CAST(? AS REAL)'
                : '?'
          );
          recovered
            .prepare('INSERT INTO ' + table + ' VALUES(' + placeholders.join(',') + ')')
            .run(
              ...values.map((value) =>
                Buffer.isBuffer(value) ? value : sqliteValue(value, row.binary_payload)
              )
            );

          recovered.exec(
            'CREATE TABLE recovery_source(source_table TEXT, identity TEXT, revision_id TEXT, recorded_at INTEGER, generation TEXT)'
          );
          recovered
            .prepare('INSERT INTO recovery_source VALUES(?,?,?,?,?)')
            .run(
              row.source_table,
              row.identity,
              request.revisionId,
              row.recorded_at,
              request.generation ?? null
            );
        })();
        if (recovered.pragma('quick_check(1)', { simple: true }) !== 'ok')
          throw new Error('Recovered SQLite file failed its integrity check.');
      } finally {
        recovered.close();
      }
      flushFileAndParentDirectoryRequired(path);
      fsyncDirectoryRequired(outputDirectory);
      return { path };
    } catch (error) {
      rmSync(resultDir, { recursive: true, force: true });
      throw error;
    }
  });
}
