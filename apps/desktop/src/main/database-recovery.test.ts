import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import {
  findNewestCompatibleBackup,
  reconcileInterruptedDatabaseRestore,
  reinstateNewerPreservedDatabase,
  resetIsolatedDatabase,
  restoreDatabaseBackupNonDestructively,
} from './database-recovery';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), 'fixture-recovery-'));
  return join(dir, 'dnaforge.db');
}

const deps = {
  openDatabase: (path: string) => openReadonlyFileTestDb(path),
};

function createDatabase(path: string, schemaVersion: number, sentinel: string): void {
  const db = openFileTestDb(path);
  try {
    db.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
    db.prepare('INSERT INTO sentinel VALUES (?)').run(sentinel);
    db.pragma(`user_version = ${schemaVersion}`);
  } finally {
    db.close();
  }
}

function readSentinel(path: string): string {
  const db = openReadonlyFileTestDb(path);
  try {
    return db.prepare('SELECT value FROM sentinel').pluck().get() as string;
  } finally {
    db.close();
  }
}

describe('database refusal recovery', () => {
  it('offers the newest backup whose schema this build can understand', () => {
    const dbPath = setup();
    const old = join(dir, 'dnaforge-backup-v16-100.db');
    const compatible = join(dir, 'dnaforge-backup-v19-200.db');
    const tooNew = join(dir, 'dnaforge-backup-v20-300.db');
    createDatabase(old, 16, 'old');
    createDatabase(compatible, 19, 'compatible');
    createDatabase(tooNew, 20, 'too-new');
    utimesSync(old, 300, 300);
    utimesSync(compatible, 100, 100);
    utimesSync(tooNew, 200, 200);

    expect(findNewestCompatibleBackup(dbPath, 19, deps)).toMatchObject({
      path: compatible,
      schemaVersion: 19,
    });
  });

  it('rejects corrupt and filename/schema-mismatched backup candidates', () => {
    const dbPath = setup();
    const compatible = join(dir, 'dnaforge-backup-v18-good.db');
    const corrupt = join(dir, 'dnaforge-backup-v19-corrupt.db');
    const mismatched = join(dir, 'dnaforge-backup-v19-mismatch.db');
    createDatabase(compatible, 18, 'compatible');
    writeFileSync(corrupt, 'not a SQLite database');
    createDatabase(mismatched, 18, 'mismatched');
    utimesSync(compatible, 100, 100);
    utimesSync(corrupt, 300, 300);
    utimesSync(mismatched, 200, 200);

    expect(findNewestCompatibleBackup(dbPath, 19, deps)).toMatchObject({
      path: compatible,
      schemaVersion: 18,
    });
  });

  it('restores only after preserving the newer live database and sidecars', () => {
    const dbPath = setup();
    const backupPath = join(dir, 'dnaforge-backup-v19-100.db');
    createDatabase(dbPath, 20, 'newer-live');
    const newerLiveBytes = readFileSync(dbPath);
    writeFileSync(dbPath + '-wal', 'newer-wal');
    writeFileSync(dbPath + '-shm', 'newer-shm');
    createDatabase(backupPath, 19, 'compatible-backup');

    const result = restoreDatabaseBackupNonDestructively(dbPath, backupPath, 20, 19, 1234, deps);

    expect(result.preRestorePath).toBe(join(dir, 'dnaforge-preRestore-v20-1234.db'));
    expect(readFileSync(result.preRestorePath)).toEqual(newerLiveBytes);
    expect(readFileSync(result.preRestorePath + '-wal', 'utf8')).toBe('newer-wal');
    expect(readFileSync(result.preRestorePath + '-shm', 'utf8')).toBe('newer-shm');
    expect(readSentinel(dbPath)).toBe('compatible-backup');
    expect(existsSync(dbPath + '-wal')).toBe(false);
    expect(existsSync(dbPath + '-shm')).toBe(false);
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(false);
  });

  it('rolls back an interrupted restore before SQLite can create a blank canonical database', () => {
    const dbPath = setup();
    const backupPath = join(dir, 'dnaforge-backup-v19-valid.db');
    const preRestorePath = join(dir, 'dnaforge-preRestore-v20-1234.db');
    const stagedPath = join(dir, 'dnaforge.db.restore-stage-999-1234');
    createDatabase(dbPath, 20, 'newer-live');
    createDatabase(backupPath, 19, 'compatible-backup');
    copyFileSync(backupPath, stagedPath);
    renameSync(dbPath, preRestorePath);
    writeFileSync(
      dbPath + '.restore-intent.json',
      JSON.stringify({
        version: 1,
        preRestorePath,
        stagedPath,
      })
    );

    expect(existsSync(dbPath)).toBe(false);
    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({
      action: 'rolled-back',
      preRestorePath,
    });
    expect(readSentinel(dbPath)).toBe('newer-live');
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(false);
  });

  it('clears an intent interrupted before the live database moved', () => {
    const dbPath = setup();
    const preRestorePath = join(dir, 'dnaforge-preRestore-v20-1234.db');
    const stagedPath = join(dir, 'dnaforge.db.restore-stage-999-1234');
    createDatabase(dbPath, 20, 'newer-live');
    createDatabase(stagedPath, 19, 'compatible-backup');
    writeFileSync(
      dbPath + '.restore-intent.json',
      JSON.stringify({
        version: 1,
        preRestorePath,
        stagedPath,
      })
    );

    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({ action: 'cancelled' });
    expect(readSentinel(dbPath)).toBe('newer-live');
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(false);
  });

  it('finalizes an installed backup without deleting the durable pre-restore database', () => {
    const dbPath = setup();
    const preRestorePath = join(dir, 'dnaforge-preRestore-v20-1234.db');
    const stagedPath = join(dir, 'dnaforge.db.restore-stage-999-1234');
    createDatabase(dbPath, 19, 'installed-backup');
    createDatabase(preRestorePath, 20, 'newer-live');
    writeFileSync(
      dbPath + '.restore-intent.json',
      JSON.stringify({
        version: 1,
        preRestorePath,
        stagedPath,
      })
    );

    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({
      action: 'completed',
      preRestorePath,
    });
    expect(readSentinel(dbPath)).toBe('installed-backup');
    expect(readSentinel(preRestorePath)).toBe('newer-live');
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(false);
  });

  it('keeps the recovery intent when the post-install durability barrier fails', () => {
    const dbPath = setup();
    const backupPath = join(dir, 'dnaforge-backup-v19-valid.db');
    createDatabase(dbPath, 20, 'newer-live');
    createDatabase(backupPath, 19, 'compatible-backup');

    expect(() =>
      restoreDatabaseBackupNonDestructively(dbPath, backupPath, 20, 19, 1234, {
        ...deps,
        flushInstalledDirectory: () => {
          throw new Error('injected directory fsync failure');
        },
      })
    ).toThrow(/injected directory fsync failure/);

    const preRestorePath = join(dir, 'dnaforge-preRestore-v20-1234.db');
    expect(readSentinel(dbPath)).toBe('compatible-backup');
    expect(readSentinel(preRestorePath)).toBe('newer-live');
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(true);
    expect(() =>
      reconcileInterruptedDatabaseRestore(dbPath, {
        flushInstalledDirectory: () => {
          throw new Error('injected reconciliation fsync failure');
        },
      })
    ).toThrow(/injected reconciliation fsync failure/);
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(true);
    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({
      action: 'completed',
      preRestorePath,
    });
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(false);
  });

  it('refuses an invalid backup before moving the live database', () => {
    const dbPath = setup();
    const backupPath = join(dir, 'dnaforge-backup-v19-corrupt.db');
    createDatabase(dbPath, 20, 'newer-live');
    const liveBytes = readFileSync(dbPath);
    writeFileSync(backupPath, 'truncated');

    expect(() =>
      restoreDatabaseBackupNonDestructively(dbPath, backupPath, 20, 19, 1234, deps)
    ).toThrow(/invalid or incompatible backup/i);
    expect(readFileSync(dbPath)).toEqual(liveBytes);
    expect(existsSync(join(dir, 'dnaforge-preRestore-v20-1234.db'))).toBe(false);
  });

  it('does not overwrite an existing pre-restore recovery point', () => {
    const dbPath = setup();
    const backupPath = join(dir, 'dnaforge-backup-v19-valid.db');
    const existing = join(dir, 'dnaforge-preRestore-v20-1234.db');
    createDatabase(dbPath, 20, 'newer-live');
    createDatabase(backupPath, 19, 'compatible-backup');
    writeFileSync(existing, 'existing-recovery');

    const result = restoreDatabaseBackupNonDestructively(dbPath, backupPath, 20, 19, 1234, deps);

    expect(readFileSync(existing, 'utf8')).toBe('existing-recovery');
    expect(result.preRestorePath).toBe(join(dir, 'dnaforge-preRestore-v20-1234-1.db'));
  });

  it('preserves every closed database file, including bytes SQLite cannot read, before resetting', () => {
    const dbPath = setup();
    const suffixes = ['', '-wal', '-shm', '-journal'];
    for (const suffix of suffixes) writeFileSync(dbPath + suffix, 'opaque source ' + suffix);
    const backupPath = join(dir, 'dnaforge-backup-v19-100.db');
    writeFileSync(backupPath, 'previous backup');
    resetIsolatedDatabase(dbPath);
    const archive = readdirSync(dir).find((name) => name.startsWith('dnaforge.db.pre-reset-'))!;
    expect(archive).toBeDefined();
    for (const suffix of suffixes) {
      expect(existsSync(dbPath + suffix)).toBe(false);
      expect(readFileSync(join(dir, archive, 'dnaforge.db' + suffix), 'utf8')).toBe(
        'opaque source ' + suffix
      );
    }
    expect(readFileSync(backupPath, 'utf8')).toBe('previous backup');
    createDatabase(dbPath, 1, 'fresh');
    expect(readSentinel(dbPath)).toBe('fresh');
  });

  it('retains committed data that exists only in the predecessor WAL', () => {
    const dbPath = setup();
    const source = join(dir, 'writer.db');
    createDatabase(source, 4, 'initial');
    const writer = openFileTestDb(source);
    try {
      writer.pragma('journal_mode=WAL');
      writer.pragma('wal_autocheckpoint=0');
      writer.prepare("UPDATE sentinel SET value='committed in WAL'").run();
      for (const suffix of ['', '-wal', '-shm']) copyFileSync(source + suffix, dbPath + suffix);
    } finally {
      writer.close();
    }
    resetIsolatedDatabase(dbPath);
    const archive = readdirSync(dir).find((name) => name.startsWith('dnaforge.db.pre-reset-'))!;
    expect(readSentinel(join(dir, archive, 'dnaforge.db'))).toBe('committed in WAL');
    createDatabase(dbPath, 1, 'fresh');
    expect(readSentinel(dbPath)).toBe('fresh');
  });

  it('keeps the entire original generation when its recovery copy cannot be flushed', () => {
    const dbPath = setup();
    for (const suffix of ['', '-shm', '-wal']) writeFileSync(dbPath + suffix, 'old' + suffix);
    expect(() =>
      resetIsolatedDatabase(dbPath, {
        flushBackupFile: () => {
          throw new Error('unavailable archive');
        },
      })
    ).toThrow('unavailable archive');
    for (const suffix of ['', '-shm', '-wal'])
      expect(readFileSync(dbPath + suffix, 'utf8')).toBe('old' + suffix);
    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({ action: 'none' });
  });

  it.each(['original', 'retained copy'])(
    'preserves all live names if the %s changes while recovery is pending',
    (part) => {
      const dbPath = setup();
      for (const suffix of ['', '-shm', '-wal']) writeFileSync(dbPath + suffix, 'old' + suffix);
      expect(() =>
        resetIsolatedDatabase(dbPath, {
          flushInstalledDirectory: () => {
            throw new Error('pause');
          },
        })
      ).toThrow('pause');
      const modified =
        part === 'original' ? dbPath : join(dbPath + '.reset-pending', 'dnaforge.db');
      writeFileSync(modified, 'replacement-content');
      expect(() => reconcileInterruptedDatabaseRestore(dbPath)).toThrow(
        /changed during reset|Incomplete database reset archive/
      );
      expect(readFileSync(dbPath + '-wal', 'utf8')).toBe('old-wal');
      expect(readFileSync(dbPath + '-shm', 'utf8')).toBe('old-shm');
      expect(existsSync(dbPath)).toBe(true);
    }
  );

  it('finishes an interrupted reset before SQLite can create a new live generation', () => {
    const dbPath = setup();
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(dbPath + suffix, 'old' + suffix);
    expect(() =>
      resetIsolatedDatabase(dbPath, {
        flushInstalledDirectory: () => {
          throw new Error('simulated interruption');
        },
      })
    ).toThrow('simulated interruption');
    unlinkSync(dbPath + '-wal');
    const outcome = reconcileInterruptedDatabaseRestore(dbPath);
    expect(outcome.action).toBe('completed');
    if (outcome.action !== 'completed') throw new Error('missing archive');
    for (const suffix of ['', '-wal', '-shm']) {
      expect(existsSync(dbPath + suffix)).toBe(false);
      expect(readFileSync(outcome.preRestorePath + suffix, 'utf8')).toBe('old' + suffix);
    }
    createDatabase(dbPath, 1, 'fresh');
    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({ action: 'none' });
    expect(readSentinel(dbPath)).toBe('fresh');
  });
});

describe('newer preserved database reinstatement ', () => {
  it('puts a newer preserved database back and keeps the older live one as a pre-restore copy', () => {
    const dbPath = setup();
    createDatabase(dbPath, 21, 'restored-july-copy');
    const preservedPath = join(dir, 'dnaforge-preRestore-v37-1790106685699.db');
    createDatabase(preservedPath, 37, 'current-user-data');
    writeFileSync(dbPath + '-wal', '');
    writeFileSync(dbPath + '-shm', '');

    const result = reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps);

    expect(result.action).toBe('reinstated');
    if (result.action !== 'reinstated') return;
    expect(result.reinstatedFromPath).toBe(preservedPath);
    expect(result.reinstatedSchemaVersion).toBe(37);
    expect(result.supersededSchemaVersion).toBe(21);
    expect(result.supersededPath).toBe(join(dir, 'dnaforge-preRestore-v21-1790107844000.db'));
    expect(readSentinel(dbPath)).toBe('current-user-data');
    expect(readSentinel(result.supersededPath)).toBe('restored-july-copy');
    expect(existsSync(result.supersededPath + '-wal')).toBe(true);
    expect(existsSync(result.supersededPath + '-shm')).toBe(true);
    expect(existsSync(dbPath + '-wal')).toBe(false);
    expect(readSentinel(preservedPath)).toBe('current-user-data');
    expect(existsSync(dbPath + '.restore-intent.json')).toBe(false);
    expect(reconcileInterruptedDatabaseRestore(dbPath)).toEqual({ action: 'none' });
  });

  it('includes committed WAL frames from the preserved set in the reinstated copy', () => {
    const dbPath = setup();
    createDatabase(dbPath, 36, 'older-live');
    const preservedPath = join(dir, 'dnaforge-preRestore-v37-1790106685699.db');
    const preserved = openFileTestDb(preservedPath);
    try {
      preserved.pragma('journal_mode = WAL');
      preserved.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
      preserved.prepare('INSERT INTO sentinel VALUES (?)').run('written-through-wal');
      preserved.pragma('user_version = 37');
    } finally {
      preserved.close();
    }

    const result = reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps);
    expect(result.action).toBe('reinstated');
    expect(readSentinel(dbPath)).toBe('written-through-wal');
  });

  it('chooses the newest valid preserved copy and skips corrupt or mismatched ones', () => {
    const dbPath = setup();
    createDatabase(dbPath, 21, 'older-live');
    createDatabase(join(dir, 'dnaforge-preRestore-v37-1790000000000.db'), 37, 'older-preserved');
    createDatabase(join(dir, 'dnaforge-preRestore-v37-1790106685699.db'), 37, 'newest-preserved');
    writeFileSync(join(dir, 'dnaforge-preRestore-v37-1790200000000.db'), 'not a database');
    createDatabase(join(dir, 'dnaforge-preRestore-v37-1790300000000.db'), 30, 'filename-lies');

    const result = reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps);
    expect(result.action).toBe('reinstated');
    expect(readSentinel(dbPath)).toBe('newest-preserved');
  });

  it.each([
    ['not newer than the live database', 21, 21],
    ['older than the live database', 30, 21],
    ['newer than this build can read', 21, 38],
  ])(
    'leaves the live database alone when the preserved copy is %s',
    (_label, liveVersion, preservedVersion) => {
      const dbPath = setup();
      createDatabase(dbPath, liveVersion, 'live');
      createDatabase(
        join(dir, `dnaforge-preRestore-v${preservedVersion}-1790106685699.db`),
        preservedVersion,
        'preserved'
      );
      const before = readFileSync(dbPath);

      expect(reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps)).toEqual({
        action: 'none',
      });
      expect(readFileSync(dbPath).equals(before)).toBe(true);
      expect(readSentinel(dbPath)).toBe('live');
    }
  );

  it('leaves a live database this build cannot read to the newer-schema guard', () => {
    const dbPath = setup();
    createDatabase(dbPath, 40, 'too-new-live');
    createDatabase(join(dir, 'dnaforge-preRestore-v37-1790106685699.db'), 37, 'preserved');

    expect(reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps)).toEqual({
      action: 'none',
    });
    expect(readSentinel(dbPath)).toBe('too-new-live');
  });

  it('is a no-op without a live database or without preserved copies', () => {
    const dbPath = setup();
    expect(reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps)).toEqual({
      action: 'none',
    });
    createDatabase(dbPath, 21, 'live');
    expect(reinstateNewerPreservedDatabase(dbPath, 37, 1790107844000, deps)).toEqual({
      action: 'none',
    });
  });
});
