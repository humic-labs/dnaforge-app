import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFileTestDb, openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import {
  cloneSharedDatabaseIfAbsent,
  inspectSharedDatabaseState,
  prepareStartupProfile,
  readDatabaseSchemaVersion,
} from './startup-profile';
import { classifyReleaseBuildStamp, VALID_RELEASE_BUILD_STAMP } from './release-stamp';

let ctx: ReturnType<typeof createFileTestDb> | undefined;

const deps = {
  openDatabase: (path: string) => openReadonlyFileTestDb(path),
};

afterEach(() => {
  if (ctx) rmSync(`${ctx.tmpDir}-dev`, { recursive: true, force: true });
  ctx?.cleanup();
  ctx = undefined;
});

describe('startup profile filesystem boundary', () => {
  it('classifies a shared database by user_version without writing it', () => {
    ctx = createFileTestDb('startup-inspect');
    ctx.db.pragma('user_version = 18');

    expect(inspectSharedDatabaseState(ctx.dbPath, 19, deps)).toBe('older');
    expect(ctx.db.pragma('user_version', { simple: true })).toBe(18);
  });

  it('returns the exact newer schema version through a read-only connection', () => {
    ctx = createFileTestDb('startup-version-inspect');
    ctx.db.pragma('user_version = 33');

    expect(readDatabaseSchemaVersion(ctx.dbPath, deps)).toBe(33);
    expect(ctx.db.pragma('user_version', { simple: true })).toBe(33);
  });

  it('classifies invalid SQLite bytes as unreadable instead of an empty profile', () => {
    ctx = createFileTestDb('startup-unreadable');
    const invalidDbPath = join(ctx.tmpDir, 'invalid.db');
    writeFileSync(invalidDbPath, 'not a SQLite database');

    expect(inspectSharedDatabaseState(invalidDbPath, 19, deps)).toBe('unreadable');
  });

  it('clones committed WAL data into one self-contained private database', () => {
    ctx = createFileTestDb('startup-clone');
    ctx.db.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
    ctx.db.prepare('INSERT INTO sentinel VALUES (?)').run('committed-in-wal');
    ctx.db.pragma('user_version = 18');

    const destination = join(ctx.tmpDir, 'DNAForge-dev', 'dnaforge.db');
    expect(cloneSharedDatabaseIfAbsent(ctx.dbPath, destination, deps)).toBe(true);
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(destination + '-wal')).toBe(false);

    const clone = openFileTestDb(destination);
    try {
      expect(clone.prepare('SELECT value FROM sentinel').pluck().get()).toBe('committed-in-wal');
      expect(clone.pragma('user_version', { simple: true })).toBe(18);
    } finally {
      clone.close();
    }

    expect(ctx.db.prepare('SELECT value FROM sentinel').pluck().get()).toBe('committed-in-wal');
    expect(ctx.db.pragma('user_version', { simple: true })).toBe(18);
  });

  it('prepares an unstamped private profile from an older shared database', () => {
    ctx = createFileTestDb('startup-prepare');
    ctx.db.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
    ctx.db.prepare('INSERT INTO sentinel VALUES (?)').run('shared-data');
    ctx.db.pragma('user_version = 18');

    const defaultUserData = ctx.tmpDir;
    const decision = prepareStartupProfile(
      {
        defaultUserData,
        argv: ['DNAForge'],
        isDev: false,
        desktopDevPort: undefined,
        release: classifyReleaseBuildStamp(''),
        currentSchemaVersion: 19,
      },
      deps
    );

    expect(decision.kind).toBe('unstamped-isolated');
    expect(decision.userDataPath).toBe(`${defaultUserData}-dev`);
    const privateDb = openFileTestDb(join(decision.userDataPath, 'dnaforge.db'));
    try {
      expect(privateDb.prepare('SELECT value FROM sentinel').pluck().get()).toBe('shared-data');
      expect(privateDb.pragma('user_version', { simple: true })).toBe(18);
    } finally {
      privateDb.close();
    }
    expect(ctx.db.pragma('user_version', { simple: true })).toBe(18);
  });

  it('does not create the stamped shared target before  can rename the legacy profile', () => {
    ctx = createFileTestDb('startup-release-legacy-order');
    const defaultUserData = join(ctx.tmpDir, 'DNAForge');

    const decision = prepareStartupProfile({
      defaultUserData,
      argv: ['DNAForge'],
      isDev: false,
      desktopDevPort: undefined,
      release: classifyReleaseBuildStamp(VALID_RELEASE_BUILD_STAMP),
      currentSchemaVersion: 19,
    });

    expect(decision.kind).toBe('release-shared');
    expect(existsSync(defaultUserData)).toBe(false);
  });
});
