import Database from 'better-sqlite3';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  parseDatabaseBackupFilename,
  type DatabaseRecoveryDependencies,
} from './database-recovery';
import { CURRENT_SCHEMA_VERSION } from './schema-version';

export type OriginalProjectEvidence = { repoUuid: string } | { path: string };

function journalState(source: string): string {
  return JSON.stringify(
    ['-wal', '-journal'].map((suffix) => {
      const path = source + suffix;
      if (!existsSync(path)) return null;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0)
        throw new Error('The retained backup has a journal that must be reviewed.');
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    })
  );
}

export function readOriginalProjectBackupEvidence(
  dbPath: string,
  readEvidence: (db: Database.Database) => OriginalProjectEvidence | null,
  deps: Pick<DatabaseRecoveryDependencies, 'openDatabase'> = {}
): { identities: OriginalProjectEvidence[]; unreadable: boolean } {
  const result = { identities: [] as OriginalProjectEvidence[], unreadable: false };
  if (!isAbsolute(dbPath)) return result;
  let entries: string[];
  try {
    entries = readdirSync(dirname(dbPath));
  } catch {
    return { ...result, unreadable: true };
  }
  for (const entry of entries) {
    const parsed = parseDatabaseBackupFilename(entry);
    if (!parsed) continue;
    const source = join(dirname(dbPath), entry);
    let ownedDirectory: string | undefined;
    let backup: Database.Database | undefined;
    try {
      const before = lstatSync(source);
      if (!before.isFile() || before.isSymbolicLink())
        throw new Error('The retained backup is not a standalone snapshot.');

      const journalsBefore = journalState(source);
      if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION)
        throw new Error('The retained backup requires a newer application.');
      ownedDirectory = mkdtempSync(join(tmpdir(), 'dnaforge-original-project-evidence-'));
      const copy = join(ownedDirectory, 'evidence.db');
      copyFileSync(source, copy, constants.COPYFILE_FICLONE);
      const after = lstatSync(source);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        journalsBefore !== journalState(source)
      )
        throw new Error('The retained backup changed while it was being read.');
      backup = (deps.openDatabase ?? ((path, options) => new Database(path, options)))(copy, {
        readonly: true,
        fileMustExist: true,
      });
      if (backup.pragma('user_version', { simple: true }) !== parsed.schemaVersion)
        throw new Error('The retained backup version does not match its filename.');
      const identity = readEvidence(backup);
      if (identity) result.identities.push(identity);
    } catch (error) {
      console.warn('[OriginalProject] Could not read retained identity evidence:', source, error);
      result.unreadable = true;
    } finally {
      backup?.close();
      if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
    }
  }
  return result;
}
