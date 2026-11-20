import { configureSavedFileBlobRoot } from '../saved-file-sources';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NATIVE_BINDING = path.join(__dirname, '__fixtures__', 'better_sqlite3_node.node');

export function createTestDb(): Database.Database {
  const db = new Database(':memory:', { nativeBinding: NATIVE_BINDING });
  let root: string | undefined;
  configureSavedFileBlobRoot(
    db,
    () => (root ??= mkdtempSync(path.join(tmpdir(), 'dnaforge-test-file-blobs-')))
  );
  const close = db.close.bind(db);
  db.close = () => {
    const result = close();
    if (root) rmSync(root, { recursive: true, force: true });
    return result;
  };
  return db;
}

export function openFileTestDb(filePath: string): Database.Database {
  return new Database(filePath, { nativeBinding: NATIVE_BINDING });
}

export function openReadonlyFileTestDb(filePath: string): Database.Database {
  return new Database(filePath, {
    nativeBinding: NATIVE_BINDING,
    readonly: true,
    fileMustExist: true,
  });
}

export function createFileTestDb(
  name = 'test',
  initialDatabase?: Buffer
): {
  db: Database.Database;
  dbPath: string;
  tmpDir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), `waypoint-test-${name}-`));
  const dbPath = path.join(dir, 'dnaforge.db');
  if (initialDatabase) writeFileSync(dbPath, initialDatabase);
  const db = new Database(dbPath, { nativeBinding: NATIVE_BINDING });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return {
    db,
    dbPath,
    tmpDir: dir,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
