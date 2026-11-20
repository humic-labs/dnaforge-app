import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const BACKUP_PATTERN = /^dnaforge-backup-v(\d+)-([^.]+)\.db$/;
const PRE_RESTORE_PREFIX = 'dnaforge-preRestore-v';
const PRE_RESTORE_PATTERN = /^dnaforge-preRestore-v(\d+)-(\d+)(?:-\d+)?\.db$/;
const RESTORE_INTENT_SUFFIX = '.restore-intent.json';
const RESTORE_INTENT_VERSION = 1;

export interface CompatibleDatabaseBackup {
  path: string;
  schemaVersion: number;
  createdAtMs: number;
  createdAtLabel: string;
}

export interface DatabaseRestoreResult {
  restoredBackupPath: string;
  preRestorePath: string;
}

export type PreservedDatabaseReinstatement =
  | { action: 'none' }
  | {
      action: 'reinstated';
      reinstatedFromPath: string;
      reinstatedSchemaVersion: number;
      supersededPath: string;
      supersededSchemaVersion: number;
    };

export type DatabaseRestoreReconciliation =
  | { action: 'none' }
  | { action: 'cancelled' }
  | { action: 'completed'; preRestorePath: string }
  | { action: 'rolled-back'; preRestorePath: string };

interface DatabaseRestoreIntent {
  version: typeof RESTORE_INTENT_VERSION;
  preRestorePath: string;
  stagedPath: string;
}

type OpenReadonlyDatabase = (
  path: string,
  options: { readonly: boolean; fileMustExist: boolean }
) => Database.Database;

export interface DatabaseRecoveryDependencies {
  openDatabase?: OpenReadonlyDatabase;
  flushBackupFile?: (path: string) => void;
  flushInstalledDirectory?: (directory: string) => void;
}

const openReadonlyDatabase: OpenReadonlyDatabase = (path, options) => new Database(path, options);

export interface ParsedDatabaseBackupFilename {
  schemaVersion: number;
  createdAtMs: number | null;
}

export function parseDatabaseBackupFilename(filename: string): ParsedDatabaseBackupFilename | null {
  const match = filename.match(BACKUP_PATTERN);
  if (!match) return null;
  const schemaVersion = Number(match[1]);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) return null;
  const timestampToken = match[2];
  const createdAtMs = /^\d+$/.test(timestampToken) ? Number(timestampToken) : null;
  return {
    schemaVersion,
    createdAtMs:
      createdAtMs !== null && Number.isSafeInteger(createdAtMs) && createdAtMs >= 0
        ? createdAtMs
        : null,
  };
}

export function databaseBackupCreatedAtMs(path: string): number {
  const parsed = parseDatabaseBackupFilename(basename(path));
  return parsed?.createdAtMs ?? statSync(path).mtimeMs;
}

export function inspectCompatibleDatabaseFile(
  path: string,
  maximumSchemaVersion: number,
  expectedSchemaVersion: number | undefined,
  deps: DatabaseRecoveryDependencies
): number | null {
  let db: Database.Database | null = null;
  try {
    if (!statSync(path).isFile()) return null;
    db = (deps.openDatabase ?? openReadonlyDatabase)(path, {
      readonly: true,
      fileMustExist: true,
    });
    const quickCheck = db.pragma('quick_check(1)', { simple: true });
    if (quickCheck !== 'ok') return null;
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    if (
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 0 ||
      schemaVersion > maximumSchemaVersion ||
      (expectedSchemaVersion !== undefined && schemaVersion !== expectedSchemaVersion)
    ) {
      return null;
    }
    return schemaVersion;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function findNewestCompatibleBackup(
  dbPath: string,
  maximumSchemaVersion: number,
  deps: DatabaseRecoveryDependencies = {}
): CompatibleDatabaseBackup | null {
  let entries: string[];
  try {
    entries = readdirSync(dirname(dbPath));
  } catch {
    return null;
  }

  const candidates = entries
    .map((name): CompatibleDatabaseBackup | null => {
      const parsed = parseDatabaseBackupFilename(name);
      if (!parsed) return null;
      const filenameSchemaVersion = parsed.schemaVersion;
      if (
        !Number.isInteger(filenameSchemaVersion) ||
        filenameSchemaVersion > maximumSchemaVersion
      ) {
        return null;
      }
      const path = join(dirname(dbPath), name);
      try {
        const schemaVersion = inspectCompatibleDatabaseFile(
          path,
          maximumSchemaVersion,
          filenameSchemaVersion,
          deps
        );
        if (schemaVersion === null) return null;
        const createdAtMs = databaseBackupCreatedAtMs(path);
        return {
          path,
          schemaVersion,
          createdAtMs,
          createdAtLabel: new Date(createdAtMs).toLocaleString(),
        };
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is CompatibleDatabaseBackup => candidate !== null)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  return candidates[0] ?? null;
}

export function restoreDatabaseBackupNonDestructively(
  dbPath: string,
  backupPath: string,
  liveSchemaVersion: number,
  maximumSchemaVersion: number,
  nowMs = Date.now(),
  deps: DatabaseRecoveryDependencies = {}
): DatabaseRestoreResult {
  const parsedBackupName = parseDatabaseBackupFilename(basename(backupPath));
  const filenameSchemaVersion = parsedBackupName?.schemaVersion ?? Number.NaN;
  const backupSchemaVersion = inspectCompatibleDatabaseFile(
    backupPath,
    maximumSchemaVersion,
    filenameSchemaVersion,
    deps
  );
  if (backupSchemaVersion === null) {
    throw new Error(`Refusing to restore an invalid or incompatible backup: ${backupPath}`);
  }

  const preRestorePath = installDatabaseCopyNonDestructively(
    dbPath,
    {
      sourcePath: backupPath,
      sourceSchemaVersion: backupSchemaVersion,
      stage: (stagedPath) => copyFileSync(backupPath, stagedPath, constants.COPYFILE_EXCL),
    },
    liveSchemaVersion,
    maximumSchemaVersion,
    nowMs,
    deps
  );
  return { restoredBackupPath: backupPath, preRestorePath };
}

export function reinstateNewerPreservedDatabase(
  dbPath: string,
  maximumSchemaVersion: number,
  nowMs = Date.now(),
  deps: DatabaseRecoveryDependencies = {}
): PreservedDatabaseReinstatement {
  if (!existsSync(dbPath)) return { action: 'none' };
  const liveSchemaVersion = inspectCompatibleDatabaseFile(
    dbPath,
    maximumSchemaVersion,
    undefined,
    deps
  );
  if (liveSchemaVersion === null) return { action: 'none' };

  let entries: string[];
  try {
    entries = readdirSync(dirname(dbPath));
  } catch {
    return { action: 'none' };
  }
  const candidates = entries
    .map((name) => {
      const match = PRE_RESTORE_PATTERN.exec(name);
      if (!match) return null;
      const filenameSchemaVersion = Number(match[1]);
      const preservedAtMs = Number(match[2]);
      if (
        !Number.isInteger(filenameSchemaVersion) ||
        filenameSchemaVersion <= liveSchemaVersion ||
        filenameSchemaVersion > maximumSchemaVersion
      ) {
        return null;
      }
      const path = join(dirname(dbPath), name);
      const schemaVersion = inspectCompatibleDatabaseFile(
        path,
        maximumSchemaVersion,
        filenameSchemaVersion,
        deps
      );
      if (schemaVersion === null) return null;
      return { path, schemaVersion, preservedAtMs };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.preservedAtMs - a.preservedAtMs || b.schemaVersion - a.schemaVersion);
  const newest = candidates[0];
  if (!newest) return { action: 'none' };

  const supersededPath = installDatabaseCopyNonDestructively(
    dbPath,
    {
      sourcePath: newest.path,
      sourceSchemaVersion: newest.schemaVersion,
      stage: (stagedPath) => vacuumInto(newest.path, stagedPath, deps),
    },
    liveSchemaVersion,
    maximumSchemaVersion,
    nowMs,
    deps
  );
  return {
    action: 'reinstated',
    reinstatedFromPath: newest.path,
    reinstatedSchemaVersion: newest.schemaVersion,
    supersededPath,
    supersededSchemaVersion: liveSchemaVersion,
  };
}

function vacuumInto(
  sourcePath: string,
  destinationPath: string,
  deps: DatabaseRecoveryDependencies
): void {
  const source = (deps.openDatabase ?? openReadonlyDatabase)(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    source.exec(`VACUUM INTO '${destinationPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

interface DatabaseCopySource {
  sourcePath: string;
  sourceSchemaVersion: number;
  stage: (stagedPath: string) => void;
}

function installDatabaseCopyNonDestructively(
  dbPath: string,
  source: DatabaseCopySource,
  liveSchemaVersion: number,
  maximumSchemaVersion: number,
  nowMs: number,
  deps: DatabaseRecoveryDependencies
): string {
  const stagedPath = nextAvailableStagePath(dbPath, nowMs);
  let preRestorePath: string | null = null;
  try {
    source.stage(stagedPath);
    if (
      inspectCompatibleDatabaseFile(
        stagedPath,
        maximumSchemaVersion,
        source.sourceSchemaVersion,
        deps
      ) === null
    ) {
      throw new Error(`Staged database copy failed validation: ${source.sourcePath}`);
    }
    fsyncFileRequired(stagedPath);

    preRestorePath = nextAvailablePreRestorePath(dbPath, liveSchemaVersion, nowMs);
    writeRestoreIntent(dbPath, { preRestorePath, stagedPath });
    try {
      moveDatabaseSet(dbPath, preRestorePath);
      fsyncDatabaseSetRequired(preRestorePath);
      fsyncDirectoryRequired(dirname(dbPath));
      renameSync(stagedPath, dbPath);
    } catch (error) {
      if (!existsSync(dbPath) && existsSync(preRestorePath)) {
        moveDatabaseSet(preRestorePath, dbPath);
      }
      if (existsSync(dbPath)) {
        fsyncDatabaseSetRequired(dbPath);
        fsyncDirectoryRequired(dirname(dbPath));
        clearRestoreIntent(dbPath);
      }
      throw error;
    }
    (deps.flushInstalledDirectory ?? fsyncDirectoryRequired)(dirname(dbPath));
    clearRestoreIntent(dbPath);
    return preRestorePath;
  } finally {
    if (existsSync(stagedPath)) {
      try {
        unlinkSync(stagedPath);
      } catch {}
    }
  }
}

export function reconcileInterruptedDatabaseRestore(
  dbPath: string,
  deps: DatabaseRecoveryDependencies = {}
): DatabaseRestoreReconciliation {
  const intentPath = restoreIntentPath(dbPath);
  const pendingReset = dbPath + '.reset-pending';
  if (lstatSync(pendingReset, { throwIfNoEntry: false })) {
    if (existsSync(intentPath)) throw new Error('A database restore and reset are both pending.');
    return {
      action: 'completed',
      preRestorePath: completeIsolatedReset(dbPath, pendingReset, deps),
    };
  }
  if (!existsSync(intentPath)) return { action: 'none' };

  const intent = readRestoreIntent(dbPath);
  if (existsSync(dbPath)) {
    fsyncDatabaseSetRequired(dbPath);
    (deps.flushInstalledDirectory ?? fsyncDirectoryRequired)(dirname(dbPath));
    removeFileBestEffort(intent.stagedPath);
    clearRestoreIntent(dbPath);
    return existsSync(intent.preRestorePath)
      ? { action: 'completed', preRestorePath: intent.preRestorePath }
      : { action: 'cancelled' };
  }

  if (!existsSync(intent.preRestorePath)) {
    throw new Error(
      `Interrupted database restore cannot be reconciled: neither ${dbPath} nor ${intent.preRestorePath} exists`
    );
  }

  moveDatabaseSet(intent.preRestorePath, dbPath);
  fsyncDatabaseSetRequired(dbPath);
  (deps.flushInstalledDirectory ?? fsyncDirectoryRequired)(dirname(dbPath));
  removeFileBestEffort(intent.stagedPath);
  clearRestoreIntent(dbPath);
  return { action: 'rolled-back', preRestorePath: intent.preRestorePath };
}

const RESET_FILE_SUFFIXES = ['-wal', '-shm', '-journal', ''] as const;

function resetFileIdentity(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Expected a regular database file at ${path}`);
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':');
}

function completeIsolatedReset(
  dbPath: string,
  pending: string,
  deps: DatabaseRecoveryDependencies
): string {
  if (!lstatSync(pending).isDirectory())
    throw new Error(`Invalid database reset archive at ${pending}`);
  const captured: unknown = JSON.parse(readFileSync(join(pending, 'generation.json'), 'utf8'));
  if (!Array.isArray(captured) || captured.length !== RESET_FILE_SUFFIXES.length)
    throw new Error(`Invalid database reset generation in ${pending}`);
  const present: string[] = [];
  for (const [i, suffix] of RESET_FILE_SUFFIXES.entries()) {
    const saved = captured[i];
    const archived = resetFileIdentity(join(pending, basename(dbPath) + suffix));
    if (
      !saved ||
      typeof saved !== 'object' ||
      !('source' in saved) ||
      !('copy' in saved) ||
      saved.copy !== archived ||
      (archived === null ? saved.source !== null : typeof saved.source !== 'string')
    )
      throw new Error(`Incomplete database reset archive at ${pending}`);
    const live = dbPath + suffix;
    const identity = resetFileIdentity(live);
    if (identity === null) continue;
    if (identity !== saved.source) throw new Error(`Database file changed during reset: ${live}`);
    present.push(live);
  }
  const directory = dirname(dbPath);
  const flush = deps.flushInstalledDirectory ?? fsyncDirectoryRequired;
  flush(directory);
  for (const live of present) unlinkSync(live);
  flush(directory);
  const archive = dbPath + '.pre-reset-' + randomUUID();
  renameSync(pending, archive);
  flush(directory);
  return join(archive, basename(dbPath));
}

export function resetIsolatedDatabase(
  dbPath: string,
  deps: DatabaseRecoveryDependencies = {}
): void {
  if (existsSync(restoreIntentPath(dbPath)))
    throw new Error('A database restore is already pending.');
  const pending = dbPath + '.reset-pending';
  if (lstatSync(pending, { throwIfNoEntry: false })) {
    completeIsolatedReset(dbPath, pending, deps);
    return;
  }
  const captured = RESET_FILE_SUFFIXES.map((suffix) => resetFileIdentity(dbPath + suffix));
  if (captured.every((identity) => identity === null)) return;
  const stage = mkdtempSync(dbPath + '.reset-stage-');
  try {
    for (const [i, suffix] of RESET_FILE_SUFFIXES.entries()) {
      if (captured[i] === null) continue;
      const destination = join(stage, basename(dbPath) + suffix);
      copyFileSync(
        dbPath + suffix,
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
      );
      chmodSync(destination, 0o600);
      (deps.flushBackupFile ?? fsyncFileRequired)(destination);
    }
    const manifest = join(stage, 'generation.json');
    const generation = RESET_FILE_SUFFIXES.map((suffix, i) => ({
      source: captured[i],
      copy: resetFileIdentity(join(stage, basename(dbPath) + suffix)),
    }));
    writeFileSync(manifest, JSON.stringify(generation), { flag: 'wx', mode: 0o600 });
    fsyncFileRequired(manifest);
    fsyncDirectoryRequired(stage);
    renameSync(stage, pending);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  completeIsolatedReset(dbPath, pending, deps);
}

function nextAvailablePreRestorePath(
  dbPath: string,
  liveSchemaVersion: number,
  nowMs: number
): string {
  const stem = `${PRE_RESTORE_PREFIX}${liveSchemaVersion}-${nowMs}`;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(dirname(dbPath), `${stem}${suffix === 0 ? '' : `-${suffix}`}.db`);
    if (
      !existsSync(candidate) &&
      !existsSync(candidate + '-wal') &&
      !existsSync(candidate + '-shm')
    ) {
      return candidate;
    }
  }
}

function nextAvailableStagePath(dbPath: string, nowMs: number): string {
  const stem = `${basename(dbPath)}.restore-stage-${process.pid}-${nowMs}`;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(dirname(dbPath), `${stem}${suffix === 0 ? '' : `-${suffix}`}`);
    if (!existsSync(candidate)) return candidate;
  }
}

function restoreIntentPath(dbPath: string): string {
  return dbPath + RESTORE_INTENT_SUFFIX;
}

function writeRestoreIntent(dbPath: string, intent: Omit<DatabaseRestoreIntent, 'version'>): void {
  const intentPath = restoreIntentPath(dbPath);
  const fd = openSync(intentPath, 'wx');
  let durable = false;
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        version: RESTORE_INTENT_VERSION,
        ...intent,
      } satisfies DatabaseRestoreIntent),
      'utf8'
    );
    fsyncSync(fd);
    durable = true;
  } finally {
    try {
      closeSync(fd);
    } finally {
      if (!durable) removeFileBestEffort(intentPath);
    }
  }
  fsyncDirectoryRequired(dirname(dbPath));
}

function readRestoreIntent(dbPath: string): DatabaseRestoreIntent {
  const intentPath = restoreIntentPath(dbPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(intentPath, 'utf8'));
  } catch (error) {
    throw new Error(`Database restore intent is unreadable at ${intentPath}`, { cause: error });
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== RESTORE_INTENT_VERSION ||
    !('preRestorePath' in parsed) ||
    typeof parsed.preRestorePath !== 'string' ||
    !('stagedPath' in parsed) ||
    typeof parsed.stagedPath !== 'string'
  ) {
    throw new Error(`Database restore intent is invalid at ${intentPath}`);
  }

  const preRestorePath = parsed.preRestorePath;
  const stagedPath = parsed.stagedPath;
  const expectedDirectory = dirname(dbPath);
  if (
    dirname(preRestorePath) !== expectedDirectory ||
    !basename(preRestorePath).startsWith(PRE_RESTORE_PREFIX) ||
    dirname(stagedPath) !== expectedDirectory ||
    !basename(stagedPath).startsWith(`${basename(dbPath)}.restore-stage-`)
  ) {
    throw new Error(`Database restore intent contains unsafe paths at ${intentPath}`);
  }

  return {
    version: RESTORE_INTENT_VERSION,
    preRestorePath,
    stagedPath,
  };
}

function clearRestoreIntent(dbPath: string): void {
  unlinkSync(restoreIntentPath(dbPath));
  fsyncDirectoryBestEffort(dirname(dbPath));
}

function removeFileBestEffort(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {}
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function flushFileAndParentDirectoryRequired(path: string): void {
  fsyncFileRequired(path);
  fsyncDirectoryRequired(dirname(path));
}

function fsyncFileRequired(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDatabaseSetRequired(basePath: string): void {
  for (const path of [basePath, basePath + '-wal', basePath + '-shm']) {
    if (existsSync(path)) fsyncFileRequired(path);
  }
}

export function fsyncDirectoryRequired(directory: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function moveDatabaseSet(sourceBase: string, destinationBase: string): void {
  const pairs = [
    [sourceBase, destinationBase],
    [sourceBase + '-wal', destinationBase + '-wal'],
    [sourceBase + '-shm', destinationBase + '-shm'],
  ].filter(([source]) => existsSync(source));
  const moved: Array<[string, string]> = [];
  try {
    for (const [source, destination] of pairs) {
      renameSync(source, destination);
      moved.push([source, destination]);
    }
  } catch (error) {
    for (const [source, destination] of moved.reverse()) {
      if (!existsSync(source) && existsSync(destination)) {
        renameSync(destination, source);
      }
    }
    throw error;
  }
}
