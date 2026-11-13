import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBoxSync: vi.fn(() => 0),
  },
  app: {
    getPath: vi.fn(),
    getVersion: vi.fn(() => '0.7.1'),
  },
}));

import {
  CURRENT_SCHEMA_VERSION,
  DATABASE_WRITER_IDENTITY_KEY,
  ensureSchemaForBuild,
  assertSchemaBuildCompatible,
} from '../schema';

let ctx: ReturnType<typeof createFileTestDb> | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function writer(isReleaseBuild: boolean) {
  return {
    version: '0.7.1',
    isReleaseBuild,
    fingerprint: 'fixture-test-fingerprint',
    writtenAt: 1_721_970_000_000,
  };
}

describe('release-authorized schema gate', () => {
  it.each(['current', 'newer', 'older-authorized', 'older-unauthorized'] as const)(
    'checks %s compatibility without running repairs or recording a writer',
    (scenario) => {
      ctx = createFileTestDb('read-only-schema-preflight');
      const { db } = ctx;
      db.exec(
        "CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('intact')"
      );
      const version =
        scenario === 'current'
          ? CURRENT_SCHEMA_VERSION
          : scenario === 'newer'
            ? CURRENT_SCHEMA_VERSION + 1
            : CURRENT_SCHEMA_VERSION - 1;
      db.pragma(`user_version = ${version}`);
      const before = db.prepare('SELECT * FROM sqlite_master').all();
      const check = () =>
        assertSchemaBuildCompatible(db, { migrationAllowed: scenario !== 'older-unauthorized' });
      if (scenario === 'newer') expect(check).toThrow(/newer/i);
      else if (scenario === 'older-unauthorized') expect(check).toThrow(/not authorized/i);
      else expect(check).not.toThrow();
      expect(db.prepare('SELECT * FROM sqlite_master').all()).toEqual(before);
      expect(db.prepare('SELECT value FROM sentinel').pluck().get()).toBe('intact');
      expect(db.pragma('user_version', { simple: true })).toBe(version);
    }
  );
  it('refuses an older shared database when migration is not authorized', () => {
    ctx = createFileTestDb('unstamped-shared-older');
    const { db, dbPath } = ctx;
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('intact')");

    expect(() =>
      ensureSchemaForBuild(db, dbPath, {
        migrationAllowed: false,
        writer: writer(false),
      })
    ).toThrow(/release stamp|not authorized/i);

    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare('SELECT value FROM sentinel').pluck().get()).toBe('intact');
  });

  it('allows the same unstamped build to migrate its isolated private profile', () => {
    ctx = createFileTestDb('unstamped-isolated-older');
    const { db, dbPath } = ctx;

    ensureSchemaForBuild(db, dbPath, {
      migrationAllowed: true,
      writer: writer(false),
    });

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('allows a stamped release to migrate the shared profile', () => {
    ctx = createFileTestDb('release-shared-older');
    const { db, dbPath } = ctx;

    ensureSchemaForBuild(db, dbPath, {
      migrationAllowed: true,
      writer: writer(true),
    });

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('opens a current shared schema without running additive repair when unstamped', () => {
    ctx = createFileTestDb('unstamped-shared-current');
    const { db, dbPath } = ctx;
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);

    ensureSchemaForBuild(db, dbPath, {
      migrationAllowed: false,
      writer: writer(false),
    });

    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lims_audit'").get()
    ).toBeUndefined();
  });

  it('records one truthful last-writer row after an authorized launch', () => {
    ctx = createFileTestDb('writer-identity');
    const { db, dbPath } = ctx;

    ensureSchemaForBuild(db, dbPath, {
      migrationAllowed: true,
      writer: writer(true),
    });

    const value = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .pluck()
      .get(DATABASE_WRITER_IDENTITY_KEY) as string;
    expect(JSON.parse(value)).toEqual({
      last_writer_version: '0.7.1',
      last_writer_is_release: true,
      last_writer_fingerprint: 'fixture-test-fingerprint',
      last_writer_at: 1_721_970_000_000,
    });
  });
});
