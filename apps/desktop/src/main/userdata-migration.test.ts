import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migratePackagedUserData,
  LEGACY_USERDATA_SEGMENTS,
  CANONICAL_DB_BASENAME,
  CANONICAL_BACKUP_PREFIX,
  shouldMigratePackagedUserData,
  decideStartupUserDataProfile,
  hasExplicitUserDataDir,
} from './userdata-migration';
import { VALID_RELEASE_BUILD_STAMP, classifyReleaseBuildStamp } from './release-stamp';

let appData = '';
const legacyDir = () => join(appData, ...LEGACY_USERDATA_SEGMENTS);
const targetDir = () => join(appData, 'DNAForge');

function seedLegacyWithDb(): void {
  const dir = legacyDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'waypoint.db'), 'DBDATA');
  writeFileSync(join(dir, 'waypoint.db-wal'), 'WAL');
  writeFileSync(join(dir, 'waypoint.db-shm'), 'SHM');
  writeFileSync(join(dir, 'waypoint-backup-v0-123.db'), 'BACKUP');
  mkdirSync(join(dir, 'managed-workspaces'), { recursive: true });
  writeFileSync(join(dir, 'managed-workspaces', 'proj.txt'), 'workspace');
}

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'fixture-userdata-'));
});

describe('migratePackagedUserData', () => {
  it('moves the legacy @waypoint/desktop dir to the DNAForge default and canonicalizes DB names', () => {
    seedLegacyWithDb();
    const res = migratePackagedUserData({ appData, defaultUserData: targetDir() });

    expect(res.action).toBe('migrated');
    expect(res.userDataPath).toBe(targetDir());
    expect(existsSync(legacyDir())).toBe(false);
    expect(existsSync(join(targetDir(), 'waypoint.db'))).toBe(false);
    expect(readFileSync(join(targetDir(), CANONICAL_DB_BASENAME), 'utf8')).toBe('DBDATA');
    expect(readFileSync(join(targetDir(), `${CANONICAL_DB_BASENAME}-wal`), 'utf8')).toBe('WAL');
    expect(readFileSync(join(targetDir(), `${CANONICAL_DB_BASENAME}-shm`), 'utf8')).toBe('SHM');
    expect(readFileSync(join(targetDir(), `${CANONICAL_BACKUP_PREFIX}0-123.db`), 'utf8')).toBe(
      'BACKUP'
    );
    expect(readFileSync(join(targetDir(), 'managed-workspaces', 'proj.txt'), 'utf8')).toBe(
      'workspace'
    );
  });

  it('does nothing for a fresh install (no legacy dir) → clean default path', () => {
    const res = migratePackagedUserData({ appData, defaultUserData: targetDir() });
    expect(res.action).toBe('none');
    expect(res.userDataPath).toBe(targetDir());
  });

  it('does NOT clobber an already-active default path when both exist', () => {
    seedLegacyWithDb();
    mkdirSync(targetDir(), { recursive: true });
    writeFileSync(join(targetDir(), CANONICAL_DB_BASENAME), 'NEWER');

    const res = migratePackagedUserData({ appData, defaultUserData: targetDir() });
    expect(res.action).toBe('none');
    expect(res.userDataPath).toBe(targetDir());
    expect(readFileSync(join(targetDir(), CANONICAL_DB_BASENAME), 'utf8')).toBe('NEWER');
    expect(existsSync(legacyDir())).toBe(true);
  });

  it('moves an existing stub DNAForge dir aside before migrating legacy data', () => {
    seedLegacyWithDb();
    mkdirSync(targetDir(), { recursive: true });
    writeFileSync(join(targetDir(), 'first-run-marker.txt'), 'stub');

    const res = migratePackagedUserData({ appData, defaultUserData: targetDir() });

    expect(res.action).toBe('migrated');
    expect(res.userDataPath).toBe(targetDir());
    expect(existsSync(legacyDir())).toBe(false);
    expect(readFileSync(join(targetDir(), CANONICAL_DB_BASENAME), 'utf8')).toBe('DBDATA');
    expect(readFileSync(`${targetDir()}.pre-legacy-migration/first-run-marker.txt`, 'utf8')).toBe(
      'stub'
    );
  });

  it('uses the next displaced-target suffix when the first stub backup path exists', () => {
    seedLegacyWithDb();
    mkdirSync(targetDir(), { recursive: true });
    mkdirSync(`${targetDir()}.pre-legacy-migration`, { recursive: true });
    writeFileSync(join(targetDir(), 'first-run-marker.txt'), 'stub');

    const res = migratePackagedUserData({ appData, defaultUserData: targetDir() });

    expect(res.action).toBe('migrated');
    expect(readFileSync(join(targetDir(), CANONICAL_DB_BASENAME), 'utf8')).toBe('DBDATA');
    expect(readFileSync(`${targetDir()}.pre-legacy-migration-1/first-run-marker.txt`, 'utf8')).toBe(
      'stub'
    );
  });

  it('renames legacy DB names in an already-DNAForge userData dir', () => {
    mkdirSync(targetDir(), { recursive: true });
    writeFileSync(join(targetDir(), 'waypoint.db'), 'DBDATA');
    writeFileSync(join(targetDir(), 'waypoint-backup-v14-999.db'), 'BACKUP');

    const res = migratePackagedUserData({ appData, defaultUserData: targetDir() });

    expect(res.action).toBe('none');
    expect(readFileSync(join(targetDir(), CANONICAL_DB_BASENAME), 'utf8')).toBe('DBDATA');
    expect(readFileSync(join(targetDir(), `${CANONICAL_BACKUP_PREFIX}14-999.db`), 'utf8')).toBe(
      'BACKUP'
    );
  });

  it('moves separator-bug logs and snapshots dirs under userData when targets are absent', () => {
    mkdirSync(targetDir(), { recursive: true });
    mkdirSync(join(appData, 'com.waypoint.desktoplogs'), { recursive: true });
    mkdirSync(join(appData, 'com.waypoint.desktopsnapshots'), { recursive: true });
    writeFileSync(join(appData, 'com.waypoint.desktoplogs', 'client.log'), 'LOG');
    writeFileSync(join(appData, 'com.waypoint.desktopsnapshots', 'debug.json'), 'SNAP');

    migratePackagedUserData({ appData, defaultUserData: targetDir() });

    expect(readFileSync(join(targetDir(), 'logs', 'client.log'), 'utf8')).toBe('LOG');
    expect(readFileSync(join(targetDir(), 'snapshots', 'debug.json'), 'utf8')).toBe('SNAP');
    expect(existsSync(join(appData, 'com.waypoint.desktoplogs'))).toBe(false);
    expect(existsSync(join(appData, 'com.waypoint.desktopsnapshots'))).toBe(false);
  });

  it('rename fails but target now exists (concurrent sibling migrated) → uses target, not fallback', () => {
    seedLegacyWithDb();
    let targetExists = false;
    const res = migratePackagedUserData(
      { appData, defaultUserData: targetDir() },
      {
        existsSync: (p) => (p === targetDir() ? targetExists : existsSync(p)),
        readdirSync,
        renameSync: () => {
          targetExists = true;
          throw new Error('ENOENT: legacy gone (sibling migrated)');
        },
      }
    );
    expect(res.action).toBe('none');
    expect(res.userDataPath).toBe(targetDir());
  });

  it('falls back to the legacy path (never orphans) when renameSync fails', () => {
    seedLegacyWithDb();
    const res = migratePackagedUserData(
      { appData, defaultUserData: targetDir() },
      {
        existsSync,
        readdirSync,
        renameSync: () => {
          throw new Error('EXDEV: cross-device link not permitted');
        },
      }
    );
    expect(res.action).toBe('fallback-legacy');
    expect(res.userDataPath).toBe(legacyDir());
    expect(readFileSync(join(legacyDir(), 'waypoint.db'), 'utf8')).toBe('DBDATA');
  });
});

describe('shouldMigratePackagedUserData', () => {
  it('runs the one-time migration for a normal packaged launch', () => {
    expect(shouldMigratePackagedUserData({ isPackaged: true, argv: ['DNAForge'] })).toBe(true);
  });

  it('never moves the real legacy profile into an explicit temporary user-data directory', () => {
    expect(
      shouldMigratePackagedUserData({
        isPackaged: true,
        argv: ['DNAForge', '--user-data-dir=/tmp/dnaforge-e2e'],
      })
    ).toBe(false);
    expect(
      shouldMigratePackagedUserData({
        isPackaged: true,
        argv: ['DNAForge', '--user-data-dir', '/tmp/dnaforge-e2e'],
      })
    ).toBe(false);
  });

  it('does not run packaged migration logic in a development launch', () => {
    expect(shouldMigratePackagedUserData({ isPackaged: false, argv: ['electron'] })).toBe(false);
  });
});

describe('startup userData profile decision', () => {
  const defaultUserData = '/Users/test/Library/Application Support/DNAForge';
  const release = classifyReleaseBuildStamp(VALID_RELEASE_BUILD_STAMP);
  const unstamped = classifyReleaseBuildStamp('');
  const malformed = classifyReleaseBuildStamp('DNAFORGE_RELEASE_BUILD=true');

  it('honours --user-data-dir verbatim even when DESKTOP_DEV_PORT is present', () => {
    expect(hasExplicitUserDataDir(['DNAForge', '--user-data-dir=/tmp/fixture-explicit'])).toBe(
      true
    );
    expect(
      decideStartupUserDataProfile({
        defaultUserData: '/tmp/fixture-explicit',
        argv: ['DNAForge', '--user-data-dir=/tmp/fixture-explicit'],
        isDev: true,
        desktopDevPort: '1452',
        release,
        sharedDatabaseState: 'older',
      })
    ).toEqual({
      kind: 'explicit',
      userDataPath: '/tmp/fixture-explicit',
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    });
  });

  it('recognizes the split --user-data-dir form', () => {
    expect(hasExplicitUserDataDir(['DNAForge', '--user-data-dir', '/tmp/fixture-explicit'])).toBe(
      true
    );
  });

  it('can apply shared-profile policy inside an explicit disposable E2E path', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData: '/tmp/fixture-shared-contract',
        argv: ['DNAForge', '--user-data-dir=/tmp/fixture-shared-contract'],
        isDev: false,
        desktopDevPort: undefined,
        release: unstamped,
        sharedDatabaseState: 'older',
        treatExplicitUserDataAsShared: true,
      })
    ).toMatchObject({
      kind: 'unstamped-isolated',
      userDataPath: '/tmp/fixture-shared-contract-dev',
      cloneSharedDatabase: true,
    });
  });

  it('never lets the shared-policy E2E switch authorize a legacy-profile move', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData: '/tmp/fixture-shared-contract',
        argv: ['DNAForge', '--user-data-dir=/tmp/fixture-shared-contract'],
        isDev: false,
        desktopDevPort: undefined,
        release,
        sharedDatabaseState: 'older',
        treatExplicitUserDataAsShared: true,
      })
    ).toMatchObject({
      kind: 'release-shared',
      userDataPath: '/tmp/fixture-shared-contract',
      migrationAllowed: true,
      migrateLegacyUserData: false,
    });
  });

  it('keeps the existing worktree-port profile shape', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData,
        argv: ['electron'],
        isDev: true,
        desktopDevPort: '1452',
        release: unstamped,
        sharedDatabaseState: 'older',
      })
    ).toMatchObject({
      kind: 'worktree-dev',
      userDataPath: `${defaultUserData}-dev-1452`,
      migrationAllowed: true,
      migrateLegacyUserData: false,
    });
  });

  it('lets a valid official release migrate the shared profile', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData,
        argv: ['DNAForge'],
        isDev: false,
        desktopDevPort: undefined,
        release,
        sharedDatabaseState: 'older',
      })
    ).toEqual({
      kind: 'release-shared',
      userDataPath: defaultUserData,
      migrationAllowed: true,
      migrateLegacyUserData: true,
      cloneSharedDatabase: false,
    });
  });

  it('never lets an unstamped build write a current shared profile; it clones it into the private profile ', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData,
        argv: ['DNAForge'],
        isDev: false,
        desktopDevPort: undefined,
        release: unstamped,
        sharedDatabaseState: 'current',
      })
    ).toEqual({
      kind: 'unstamped-isolated',
      userDataPath: `${defaultUserData}-dev`,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: true,
    });
  });

  it('isolates and clones an older shared database when the stamp is absent', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData,
        argv: ['DNAForge'],
        isDev: false,
        desktopDevPort: undefined,
        release: unstamped,
        sharedDatabaseState: 'older',
      })
    ).toEqual({
      kind: 'unstamped-isolated',
      userDataPath: `${defaultUserData}-dev`,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: true,
    });
  });

  it('fails closed for a malformed stamp when the shared database is older', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData,
        argv: ['DNAForge'],
        isDev: false,
        desktopDevPort: undefined,
        release: malformed,
        sharedDatabaseState: 'older',
      })
    ).toMatchObject({
      kind: 'unstamped-isolated',
      userDataPath: `${defaultUserData}-dev`,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: true,
    });
  });

  it('uses a private empty profile when no shared database exists', () => {
    expect(
      decideStartupUserDataProfile({
        defaultUserData,
        argv: ['DNAForge'],
        isDev: false,
        desktopDevPort: undefined,
        release: unstamped,
        sharedDatabaseState: 'missing',
      })
    ).toMatchObject({
      kind: 'unstamped-isolated',
      userDataPath: `${defaultUserData}-dev`,
      cloneSharedDatabase: false,
    });
  });

  it.each(['newer', 'unreadable'] as const)(
    'keeps the real shared path for a %s database so startup reports the actual failure',
    (sharedDatabaseState) => {
      expect(
        decideStartupUserDataProfile({
          defaultUserData,
          argv: ['DNAForge'],
          isDev: false,
          desktopDevPort: undefined,
          release: unstamped,
          sharedDatabaseState,
        })
      ).toMatchObject({
        kind:
          sharedDatabaseState === 'newer'
            ? 'unstamped-shared-newer'
            : 'unstamped-shared-unreadable',
        userDataPath: defaultUserData,
        migrationAllowed: false,
        cloneSharedDatabase: false,
      });
    }
  );

  it('never authorizes the  legacy rename for an unstamped build', () => {
    const decision = decideStartupUserDataProfile({
      defaultUserData,
      argv: ['DNAForge'],
      isDev: false,
      desktopDevPort: undefined,
      release: unstamped,
      sharedDatabaseState: 'missing',
    });

    expect(decision.migrateLegacyUserData).toBe(false);
  });
});
