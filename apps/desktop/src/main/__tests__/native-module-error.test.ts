import { describe, it, expect } from 'vitest';
import {
  classifyNativeModuleError,
  buildDatabaseErrorDialog,
  SchemaMigrationNotAuthorizedError,
  SchemaMigrationRecoveredError,
  SchemaUpgradeBackupRequiredError,
  SchemaVersionTooNewError,
} from '../native-module-error';

const HARMFUL_DELETE_ADVICE = /try deleting the database/i;
const RM_COMMAND = /\brm\s+["']/;

const ABI_MESSAGE =
  "The module '/x/better_sqlite3.node' was compiled against a different Node.js version using " +
  'NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 130.';
const LEGACY_ABI_MESSAGE = 'Error: The module was compiled against a different Node.js version';
const ARCH_MESSAGE = "dlopen(...): tried: '...' (mach-o file, but is an incompatible architecture)";
const ELF_MESSAGE = 'Error: /x/better_sqlite3.node: wrong ELF class: ELFCLASS32';
const WIN_MESSAGE = '%1 is not a valid Win32 application.';
const GENERIC_DB_MESSAGE = 'SqliteError: database disk image is malformed';

const CODESIGN_MESSAGE =
  'dlopen(/Applications/DNAForge.app/.../better_sqlite3.node): code signature in (...) not valid for use in process';
const MISSING_DYLIB_MESSAGE =
  'dlopen(...): Library not loaded: @rpath/libfoo.dylib ... image not found';
const EPERM_MESSAGE = "Error: EPERM: operation not permitted, open '/.../better_sqlite3.node'";
const LINUX_SO_MESSAGE =
  'Error: libfoo.so: cannot open shared object file: No such file or directory';

const DB_PATH = '/Users/x/Library/Application Support/DNAForge/dnaforge.db';

describe('classifyNativeModuleError', () => {
  it('classifies NODE_MODULE_VERSION as abi (the platform-stable signal)', () => {
    expect(classifyNativeModuleError(new Error(ABI_MESSAGE))).toBe('abi');
  });

  it('classifies "compiled against a different Node.js version" as abi, NOT arch (Bug A red-first)', () => {
    expect(classifyNativeModuleError(new Error(LEGACY_ABI_MESSAGE))).toBe('abi');
  });

  it('classifies genuine CPU-architecture errors as arch', () => {
    expect(classifyNativeModuleError(new Error(ARCH_MESSAGE))).toBe('arch');
    expect(classifyNativeModuleError(new Error(ELF_MESSAGE))).toBe('arch');
    expect(classifyNativeModuleError(new Error(WIN_MESSAGE))).toBe('arch');
  });

  it('classifies non-ABI/arch loader failures (signature/quarantine/missing-lib/EPERM) as load', () => {
    expect(classifyNativeModuleError(new Error(CODESIGN_MESSAGE))).toBe('load');
    expect(classifyNativeModuleError(new Error(MISSING_DYLIB_MESSAGE))).toBe('load');
    expect(classifyNativeModuleError(new Error(EPERM_MESSAGE))).toBe('load');
    expect(classifyNativeModuleError(new Error(LINUX_SO_MESSAGE))).toBe('load');
  });

  it('classifies a real DB/SQL error as null (not a native-module failure)', () => {
    expect(classifyNativeModuleError(new Error(GENERIC_DB_MESSAGE))).toBeNull();
  });

  it('accepts non-Error values (string)', () => {
    expect(classifyNativeModuleError(ABI_MESSAGE)).toBe('abi');
    expect(classifyNativeModuleError('plain string')).toBeNull();
  });
});

describe('buildDatabaseErrorDialog — native-loader failure (load) case', () => {
  for (const isPackaged of [false, true]) {
    it(`treats it as a native-file problem, never DB-blaming (packaged=${isPackaged})`, () => {
      const { title, detail } = buildDatabaseErrorDialog(new Error(CODESIGN_MESSAGE), {
        context: 'schema',
        isPackaged,
        dbPath: DB_PATH,
      });
      expect(title).toBe('Database engine failed to load');
      expect(detail).toMatch(/could not be loaded/i);
      expect(detail).not.toContain(DB_PATH);
      expect(detail).not.toMatch(/move it aside/i);
      expect(detail).not.toMatch(/back up your database/i);
      expect(detail).not.toMatch(HARMFUL_DELETE_ADVICE);
      expect(detail).not.toMatch(RM_COMMAND);
    });
  }

  it('gives rebuild guidance in dev and reinstall guidance when packaged', () => {
    const dev = buildDatabaseErrorDialog(new Error(MISSING_DYLIB_MESSAGE), {
      context: 'open',
      isPackaged: false,
      dbPath: DB_PATH,
    });
    expect(dev.detail).toContain('cd apps/desktop && node scripts/rebuild-native.cjs');

    const packaged = buildDatabaseErrorDialog(new Error(MISSING_DYLIB_MESSAGE), {
      context: 'open',
      isPackaged: true,
      dbPath: DB_PATH,
    });
    expect(packaged.detail).toMatch(/reinstall/i);
    expect(packaged.detail).not.toContain('node scripts/');
  });
});

describe('buildDatabaseErrorDialog — ABI case', () => {
  for (const context of ['open', 'schema'] as const) {
    for (const isPackaged of [false, true]) {
      it(`labels it a version mismatch and never recommends deletion (context=${context}, packaged=${isPackaged})`, () => {
        const { title, detail } = buildDatabaseErrorDialog(new Error(ABI_MESSAGE), {
          context,
          isPackaged,
          dbPath: DB_PATH,
        });
        expect(title).toBe('Native module version mismatch');
        expect(detail).not.toMatch(/wrong CPU architecture/i);
        expect(detail).toMatch(/ABI/);
        expect(detail).not.toMatch(HARMFUL_DELETE_ADVICE);
        expect(detail).not.toMatch(RM_COMMAND);
        expect(detail).toMatch(/CANNOT be fixed by deleting the database/);
      });
    }
  }

  it('dev build shows the CLI rebuild command', () => {
    const { detail } = buildDatabaseErrorDialog(new Error(ABI_MESSAGE), {
      context: 'open',
      isPackaged: false,
      dbPath: DB_PATH,
    });
    expect(detail).toContain('cd apps/desktop && node scripts/rebuild-native.cjs');
  });

  it('packaged build tells the user to reinstall, never a CLI they cannot run', () => {
    const { detail } = buildDatabaseErrorDialog(new Error(ABI_MESSAGE), {
      context: 'open',
      isPackaged: true,
      dbPath: DB_PATH,
    });
    expect(detail).toMatch(/reinstall/i);
    expect(detail).toContain('dnaforge.com');
    expect(detail).not.toContain('node scripts/');
    expect(detail).not.toContain('apps/desktop');
  });
});

describe('buildDatabaseErrorDialog — arch case', () => {
  it('labels CPU-architecture mismatch and never recommends deletion', () => {
    const { title, detail } = buildDatabaseErrorDialog(new Error(ARCH_MESSAGE), {
      context: 'open',
      isPackaged: false,
      dbPath: DB_PATH,
    });
    expect(title).toBe('Native module architecture mismatch');
    expect(detail).toMatch(/CPU architecture/i);
    expect(detail).not.toMatch(HARMFUL_DELETE_ADVICE);
    expect(detail).not.toMatch(RM_COMMAND);
  });
});

describe('buildDatabaseErrorDialog — genuine DB error (null)', () => {
  it('schema context: titled schema error, backs up first, no rm, no harmful delete advice', () => {
    const { title, detail } = buildDatabaseErrorDialog(new Error(GENERIC_DB_MESSAGE), {
      context: 'schema',
      isPackaged: false,
      dbPath: DB_PATH,
    });
    expect(title).toBe('Database schema error');
    expect(detail).toMatch(/back up/i);
    expect(detail).toContain(DB_PATH);
    expect(detail).not.toMatch(HARMFUL_DELETE_ADVICE);
    expect(detail).not.toMatch(RM_COMMAND);
  });

  it('open context: titled open-failure', () => {
    const { title } = buildDatabaseErrorDialog(new Error(GENERIC_DB_MESSAGE), {
      context: 'open',
      isPackaged: false,
      dbPath: DB_PATH,
    });
    expect(title).toBe('Database failed to initialize');
  });
});

describe('buildDatabaseErrorDialog — newer-schema refusal', () => {
  for (const isPackaged of [false, true]) {
    it(`leads with the current release and never blames a healthy database (packaged=${isPackaged})`, () => {
      const error = new SchemaVersionTooNewError({
        dbVersion: 20,
        supportedVersion: 19,
        appVersion: '0.6.2',
      });
      const { title, detail, actions } = buildDatabaseErrorDialog(error, {
        context: 'schema',
        isPackaged,
        dbPath: DB_PATH,
      });

      expect(title).toBe('Update required');
      expect(detail).toMatch(/DNAForge 0\.6\.2/);
      expect(detail).toMatch(/schema v20/);
      expect(detail).toMatch(/supports schema v19/);
      expect(detail).toMatch(/install the current DNAForge release/i);
      expect(detail).toContain('dnaforge.com');
      expect(detail).toMatch(/has not been modified/i);
      expect(detail).not.toContain(DB_PATH);
      expect(detail).not.toMatch(/move it aside/i);
      expect(detail).not.toMatch(/back up your database/i);
      expect(detail).not.toMatch(/fresh database/i);
      expect(detail).not.toMatch(HARMFUL_DELETE_ADVICE);
      expect(detail).not.toMatch(RM_COMMAND);
      expect(actions?.map((action) => action.id)).toEqual(['install-current-release', 'quit']);
    });
  }

  it('never turns a compatible backup into a user-facing database downgrade', () => {
    const error = new SchemaVersionTooNewError({
      dbVersion: 20,
      supportedVersion: 19,
      appVersion: '0.6.2',
    });
    const staleCallerOptions = {
      context: 'schema',
      isPackaged: true,
      dbPath: DB_PATH,
      compatibleBackup: {
        schemaVersion: 19,
        createdAtLabel: '7/26/2026, 9:15:00 PM',
      },
      isolatedProfile: true,
    } as const;
    const { detail, actions } = buildDatabaseErrorDialog(error, staleCallerOptions);

    expect(detail).not.toMatch(/choice/i);
    expect(detail).not.toMatch(/restore/i);
    expect(detail).not.toContain('7/26/2026, 9:15:00 PM');
    expect(actions?.map((action) => action.id)).toEqual([
      'install-current-release',
      'reset-isolated-profile',
      'quit',
    ]);
  });
});

describe('buildDatabaseErrorDialog — typed migration recovery', () => {
  it('routes an unauthorized shared migration to release guidance, never move-aside advice', () => {
    const { title, detail, actions } = buildDatabaseErrorDialog(
      new SchemaMigrationNotAuthorizedError(18, 19),
      { context: 'schema', isPackaged: true, dbPath: DB_PATH }
    );

    expect(title).toBe('Current release required');
    expect(detail).toMatch(/development build cannot upgrade the shared database/i);
    expect(detail).toContain('dnaforge.com');
    expect(detail).toMatch(/has not been modified/i);
    expect(detail).not.toContain(DB_PATH);
    expect(detail).not.toMatch(/move it aside/i);
    expect(detail).not.toMatch(/back up your database/i);
    expect(detail).not.toMatch(/fresh database/i);
    expect(actions?.map((action) => action.id)).toEqual(['install-current-release', 'quit']);
  });

  it('reports the dated automatic restore without move-aside advice', () => {
    const { title, detail } = buildDatabaseErrorDialog(
      new SchemaMigrationRecoveredError({
        migrationError: new Error('injected migration failure'),
        backupPath: '/data/dnaforge-backup-v18-1.db',
        backupCreatedAtLabel: '7/26/2026, 9:15:00 PM',
        preRestorePath: '/data/dnaforge-preRestore-v18-2.db',
      }),
      { context: 'schema', isPackaged: true, dbPath: DB_PATH }
    );

    expect(title).toBe('Database migration failed');
    expect(detail).toContain('7/26/2026, 9:15:00 PM');
    expect(detail).toContain('/data/dnaforge-preRestore-v18-2.db');
    expect(detail).not.toMatch(/move it aside/i);
  });

  it('explains a backup-required refusal without claiming corruption', () => {
    const { title, detail } = buildDatabaseErrorDialog(
      new SchemaUpgradeBackupRequiredError({ dbPath: '/data' }),
      { context: 'schema', isPackaged: true, dbPath: DB_PATH }
    );

    expect(title).toBe('Database upgrade blocked');
    expect(detail).toMatch(/did not change the database/i);
    expect(detail).toMatch(/disk space|permissions/i);
    expect(detail).not.toMatch(/move it aside/i);
  });
});

describe('Bug B dominant-path regression lock (schema context, ABI error)', () => {
  it('the schema-init dialog for an ABI error never tells the user to delete the database', () => {
    const { detail } = buildDatabaseErrorDialog(new Error(ABI_MESSAGE), {
      context: 'schema',
      isPackaged: false,
      dbPath: DB_PATH,
    });
    expect(detail).not.toMatch(HARMFUL_DELETE_ADVICE);
    expect(detail).not.toContain('Try deleting the database and relaunching');
  });
});
