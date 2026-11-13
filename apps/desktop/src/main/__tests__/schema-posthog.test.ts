import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFileTestDb, openReadonlyFileTestDb } from './test-db';

const trackEvent = vi.fn();
const showErrorBox = vi.fn();
const releaseBuildIdentity = vi.hoisted(() => ({ isReleaseBuild: false }));

vi.mock('electron', () => ({
  dialog: { showErrorBox: (...args: unknown[]) => showErrorBox(...args) },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0'), isPackaged: true },
}));

vi.mock('../analytics', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

vi.mock('../release-stamp', () => ({
  RELEASE_BUILD_IDENTITY: releaseBuildIdentity,
}));

import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../schema';

let ctx: ReturnType<typeof createFileTestDb>;
const databaseRecoveryDependencies = {
  openDatabase: (path: string) => openReadonlyFileTestDb(path),
};

beforeEach(() => {
  trackEvent.mockClear();
  showErrorBox.mockClear();
  releaseBuildIdentity.isReleaseBuild = false;
  delete process.env.DNAFORGE_RELEASE_BUILD;
});

afterEach(() => {
  if (ctx) {
    ctx.cleanup();
  }
});

describe('schema migration PostHog events', () => {
  it('does not classify a locally packaged app as an official release', () => {
    ctx = createFileTestDb('posthog-schema-refused');
    const { db, dbPath } = ctx;
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);

    expect(() => ensureSchema(db, dbPath)).toThrow();

    expect(trackEvent).toHaveBeenCalledWith('app_schema_refused', {
      db_version: CURRENT_SCHEMA_VERSION + 1,
      build_version: '1.0.0',
      is_release: false,
    });
    expect(showErrorBox).not.toHaveBeenCalled();
  });

  it('classifies only the compiled build identity as an official release', () => {
    releaseBuildIdentity.isReleaseBuild = true;
    ctx = createFileTestDb('posthog-schema-refused-release');
    const { db, dbPath } = ctx;
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);

    expect(() => ensureSchema(db, dbPath)).toThrow();

    expect(trackEvent).toHaveBeenCalledWith(
      'app_schema_refused',
      expect.objectContaining({ is_release: true })
    );
  });

  it('4.5 app_migration_backup event on success', () => {
    ctx = createFileTestDb('posthog-backup-ok');
    const { db, dbPath } = ctx;

    ensureSchema(db, dbPath);

    expect(trackEvent).toHaveBeenCalledWith('app_migration_backup', {
      from_version: 0,
      success: true,
    });
  });

  it('4.6 app_migration_backup with success: false on backup failure', () => {
    ctx = createFileTestDb('posthog-backup-fail');
    const { db, dbPath } = ctx;

    const origPragma = db.pragma.bind(db);
    (db as unknown as { pragma: unknown }).pragma = (arg: string, opts?: unknown) => {
      if (typeof arg === 'string' && arg.includes('wal_checkpoint')) {
        throw new Error('injected wal_checkpoint failure');
      }
      return origPragma(arg, opts as never);
    };

    try {
      ensureSchema(db, dbPath);
    } finally {
      (db as unknown as { pragma: unknown }).pragma = origPragma;
    }

    expect(trackEvent).toHaveBeenCalledWith('app_migration_backup', {
      from_version: 0,
      success: false,
    });
  });

  it('4.7 app_migration_result on successful migration', () => {
    ctx = createFileTestDb('posthog-result-ok');
    const { db, dbPath } = ctx;

    ensureSchema(db, dbPath);

    expect(trackEvent).toHaveBeenCalledWith('app_migration_result', {
      from_version: 0,
      to_version: CURRENT_SCHEMA_VERSION,
      success: true,
      restored_from_backup: false,
    });
  });

  it('4.8 app_migration_result with restored_from_backup: true on failure', () => {
    ctx = createFileTestDb('posthog-result-restored');
    const { db, dbPath } = ctx;

    const origTransaction = db.transaction.bind(db);
    (db as unknown as { transaction: unknown }).transaction = () => () => {
      throw new Error('injected');
    };

    try {
      expect(() => ensureSchema(db, dbPath, databaseRecoveryDependencies)).toThrow();
    } finally {
      (db as unknown as { transaction: unknown }).transaction = origTransaction;
    }

    expect(trackEvent).toHaveBeenCalledWith('app_migration_result', {
      from_version: 0,
      to_version: CURRENT_SCHEMA_VERSION,
      success: false,
      restored_from_backup: true,
    });
  });
});
