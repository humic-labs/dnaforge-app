import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  renameSync as nodeRenameSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ReleaseBuildIdentity } from './release-stamp';

export const LEGACY_USERDATA_SEGMENTS = ['@waypoint', 'desktop'] as const;
export const LEGACY_DB_BASENAME = 'waypoint.db';
export const CANONICAL_DB_BASENAME = 'dnaforge.db';
export const LEGACY_BACKUP_PREFIX = 'waypoint-backup-v';
export const CANONICAL_BACKUP_PREFIX = 'dnaforge-backup-v';

export interface UserDataMigrationInput {
  appData: string;
  defaultUserData: string;
}

export type UserDataMigrationAction = 'migrated' | 'none' | 'fallback-legacy';

export interface UserDataMigrationResult {
  action: UserDataMigrationAction;
  userDataPath: string;
  legacyPath: string;
}

export interface UserDataMigrationFs {
  existsSync: (path: string) => boolean;
  renameSync: (from: string, to: string) => void;
  readdirSync: (path: string) => string[];
}

export interface PackagedUserDataMigrationEligibility {
  isPackaged: boolean;
  argv: readonly string[];
}

export type SharedDatabaseState = 'missing' | 'older' | 'current' | 'newer' | 'unreadable';

export type StartupUserDataProfileKind =
  | 'automation-isolated'
  | 'explicit'
  | 'scenario-disposable'
  | 'worktree-dev'
  | 'release-shared'
  | 'unstamped-shared-newer'
  | 'unstamped-shared-unreadable'
  | 'unstamped-isolated';

export interface StartupUserDataProfileDecision {
  kind: StartupUserDataProfileKind;
  userDataPath: string;
  migrationAllowed: boolean;
  migrateLegacyUserData: boolean;
  cloneSharedDatabase: boolean;
}

export interface StartupUserDataProfileInput {
  defaultUserData: string;
  argv: readonly string[];
  isDev: boolean;
  desktopDevPort: string | undefined;
  release: ReleaseBuildIdentity;
  sharedDatabaseState: SharedDatabaseState;
  treatExplicitUserDataAsShared?: boolean;
}

const defaultFs: UserDataMigrationFs = {
  existsSync: nodeExistsSync,
  renameSync: nodeRenameSync,
  readdirSync: nodeReaddirSync,
};

export function shouldMigratePackagedUserData(
  input: PackagedUserDataMigrationEligibility
): boolean {
  if (!input.isPackaged) return false;
  return !input.argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
}

export function hasExplicitUserDataDir(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
}

export function decideStartupUserDataProfile(
  input: StartupUserDataProfileInput
): StartupUserDataProfileDecision {
  const hasExplicitProfile = hasExplicitUserDataDir(input.argv);
  if (hasExplicitProfile && !input.treatExplicitUserDataAsShared) {
    return {
      kind: 'explicit',
      userDataPath: input.defaultUserData,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    };
  }

  if (input.isDev && input.desktopDevPort && /^\d+$/.test(input.desktopDevPort)) {
    return {
      kind: 'worktree-dev',
      userDataPath: `${input.defaultUserData}-dev-${input.desktopDevPort}`,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    };
  }

  if (input.release.isReleaseBuild) {
    return {
      kind: 'release-shared',
      userDataPath: input.defaultUserData,
      migrationAllowed: true,
      migrateLegacyUserData: !hasExplicitProfile,
      cloneSharedDatabase: false,
    };
  }

  if (input.sharedDatabaseState === 'newer') {
    return {
      kind: 'unstamped-shared-newer',
      userDataPath: input.defaultUserData,
      migrationAllowed: false,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    };
  }

  if (input.sharedDatabaseState === 'unreadable') {
    return {
      kind: 'unstamped-shared-unreadable',
      userDataPath: input.defaultUserData,
      migrationAllowed: false,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    };
  }

  return {
    kind: 'unstamped-isolated',
    userDataPath: `${input.defaultUserData}-dev`,
    migrationAllowed: true,
    migrateLegacyUserData: false,
    cloneSharedDatabase:
      input.sharedDatabaseState === 'older' || input.sharedDatabaseState === 'current',
  };
}

export function migratePackagedUserData(
  input: UserDataMigrationInput,
  fs: UserDataMigrationFs = defaultFs
): UserDataMigrationResult {
  const legacyPath = join(input.appData, ...LEGACY_USERDATA_SEGMENTS);
  const target = input.defaultUserData;

  if (!fs.existsSync(legacyPath)) {
    migrateCanonicalContents(input.appData, target, fs);
    return { action: 'none', userDataPath: target, legacyPath };
  }
  if (fs.existsSync(target)) {
    if (!hasDatabaseFiles(target, fs)) {
      const displacedTarget = nextDisplacedTargetPath(target, fs);
      try {
        fs.renameSync(target, displacedTarget);
        try {
          fs.renameSync(legacyPath, target);
          migrateCanonicalContents(input.appData, target, fs);
          return { action: 'migrated', userDataPath: target, legacyPath };
        } catch {
          try {
            fs.renameSync(displacedTarget, target);
          } catch {}
          migrateCanonicalContents(input.appData, legacyPath, fs);
          return { action: 'fallback-legacy', userDataPath: legacyPath, legacyPath };
        }
      } catch {}
    }
    migrateCanonicalContents(input.appData, target, fs);
    return { action: 'none', userDataPath: target, legacyPath };
  }
  try {
    fs.renameSync(legacyPath, target);
    migrateCanonicalContents(input.appData, target, fs);
    return { action: 'migrated', userDataPath: target, legacyPath };
  } catch {
    if (fs.existsSync(target)) {
      migrateCanonicalContents(input.appData, target, fs);
      return { action: 'none', userDataPath: target, legacyPath };
    }
    migrateCanonicalContents(input.appData, legacyPath, fs);
    return { action: 'fallback-legacy', userDataPath: legacyPath, legacyPath };
  }
}

function hasDatabaseFiles(userDataPath: string, fs: UserDataMigrationFs): boolean {
  return [
    CANONICAL_DB_BASENAME,
    `${CANONICAL_DB_BASENAME}-wal`,
    `${CANONICAL_DB_BASENAME}-shm`,
    LEGACY_DB_BASENAME,
    `${LEGACY_DB_BASENAME}-wal`,
    `${LEGACY_DB_BASENAME}-shm`,
  ].some((entry) => fs.existsSync(join(userDataPath, entry)));
}

function nextDisplacedTargetPath(target: string, fs: UserDataMigrationFs): string {
  const base = `${target}.pre-legacy-migration`;
  if (!fs.existsSync(base)) return base;
  for (let index = 1; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function migrateCanonicalContents(
  appData: string,
  userDataPath: string,
  fs: UserDataMigrationFs
): void {
  renameIfTargetAbsent(
    join(userDataPath, LEGACY_DB_BASENAME),
    join(userDataPath, CANONICAL_DB_BASENAME),
    fs
  );
  renameIfTargetAbsent(
    join(userDataPath, `${LEGACY_DB_BASENAME}-wal`),
    join(userDataPath, `${CANONICAL_DB_BASENAME}-wal`),
    fs
  );
  renameIfTargetAbsent(
    join(userDataPath, `${LEGACY_DB_BASENAME}-shm`),
    join(userDataPath, `${CANONICAL_DB_BASENAME}-shm`),
    fs
  );
  migrateBackupNames(userDataPath, fs);
  renameIfTargetAbsent(join(appData, 'com.waypoint.desktoplogs'), join(userDataPath, 'logs'), fs);
  renameIfTargetAbsent(
    join(appData, 'com.waypoint.desktopsnapshots'),
    join(userDataPath, 'snapshots'),
    fs
  );
}

function migrateBackupNames(userDataPath: string, fs: UserDataMigrationFs): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(userDataPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_BACKUP_PREFIX) || !entry.endsWith('.db')) continue;
    const canonical = `${CANONICAL_BACKUP_PREFIX}${entry.slice(LEGACY_BACKUP_PREFIX.length)}`;
    renameIfTargetAbsent(join(userDataPath, entry), join(userDataPath, canonical), fs);
  }
}

function renameIfTargetAbsent(from: string, to: string, fs: UserDataMigrationFs): void {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  try {
    fs.renameSync(from, to);
  } catch {}
}
