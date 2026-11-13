import { userMessage } from '@waypoint/user-messages';
export { createUserDialogs } from './user-dialogs';
import { isAbiError, isArchError, isLoadError } from '../../scripts/native-abi-patterns.cjs';
import { CURRENT_SCHEMA_VERSION } from './schema-version';

export type NativeModuleErrorKind = 'abi' | 'arch' | 'load' | null;

export const NATIVE_MODULE_REBUILD_COMMAND = 'cd apps/desktop && node scripts/rebuild-native.cjs';

export interface SchemaVersionTooNewDetails {
  dbVersion: number;
  supportedVersion: number;
  appVersion: string;
}

export class SchemaVersionTooNewError extends Error {
  readonly code = 'SCHEMA_VERSION_TOO_NEW';
  readonly dbVersion: number;
  readonly supportedVersion: number;
  readonly appVersion: string;

  constructor({ dbVersion, supportedVersion, appVersion }: SchemaVersionTooNewDetails) {
    super(
      `Database schema v${dbVersion} is newer than this build's CURRENT_SCHEMA_VERSION=${supportedVersion}; refusing to launch`
    );
    this.name = 'SchemaVersionTooNewError';
    this.dbVersion = dbVersion;
    this.supportedVersion = supportedVersion;
    this.appVersion = appVersion;
  }
}

export class SchemaMigrationNotAuthorizedError extends Error {
  readonly code = 'SCHEMA_MIGRATION_NOT_AUTHORIZED';
  readonly databaseVersion: number;
  readonly supportedVersion: number;

  constructor(databaseVersion: number, supportedVersion = CURRENT_SCHEMA_VERSION) {
    super(
      `Database schema v${databaseVersion} requires migration to v${supportedVersion}, ` +
        'but this build has no valid release stamp and migration is not authorized'
    );
    this.name = 'SchemaMigrationNotAuthorizedError';
    this.databaseVersion = databaseVersion;
    this.supportedVersion = supportedVersion;
  }
}

export interface SchemaUpgradeBackupRequiredDetails {
  dbPath: string;
}

export class SchemaUpgradeBackupRequiredError extends Error {
  readonly code = 'SCHEMA_UPGRADE_BACKUP_REQUIRED';
  readonly dbPath: string;

  constructor({ dbPath }: SchemaUpgradeBackupRequiredDetails) {
    super('Database backup failed and a destructive migration was refused');
    this.name = 'SchemaUpgradeBackupRequiredError';
    this.dbPath = dbPath;
  }
}

export interface SchemaMigrationRecoveredDetails {
  migrationError: unknown;
  backupPath: string;
  backupCreatedAtLabel: string;
  preRestorePath: string;
}

export class SchemaMigrationRecoveredError extends Error {
  readonly code = 'SCHEMA_MIGRATION_RECOVERED';
  readonly migrationError: unknown;
  readonly backupPath: string;
  readonly backupCreatedAtLabel: string;
  readonly preRestorePath: string;

  constructor(details: SchemaMigrationRecoveredDetails) {
    super(`Database migration failed and was restored: ${errorMessage(details.migrationError)}`);
    this.name = 'SchemaMigrationRecoveredError';
    this.migrationError = details.migrationError;
    this.backupPath = details.backupPath;
    this.backupCreatedAtLabel = details.backupCreatedAtLabel;
    this.preRestorePath = details.preRestorePath;
  }
}

export interface SchemaMigrationRecoveryFailedDetails {
  migrationError: unknown;
  recoveryError: unknown;
  backupPath: string;
  dbPath: string;
}

export class SchemaMigrationRecoveryFailedError extends Error {
  readonly code = 'SCHEMA_MIGRATION_RECOVERY_FAILED';
  readonly migrationError: unknown;
  readonly recoveryError: unknown;
  readonly backupPath: string;
  readonly dbPath: string;

  constructor(details: SchemaMigrationRecoveryFailedDetails) {
    super(
      `Database migration and automatic recovery failed: ${errorMessage(details.recoveryError)}`
    );
    this.name = 'SchemaMigrationRecoveryFailedError';
    this.migrationError = details.migrationError;
    this.recoveryError = details.recoveryError;
    this.backupPath = details.backupPath;
    this.dbPath = details.dbPath;
  }
}

export class SchemaMigrationFailedWithoutBackupError extends Error {
  readonly code = 'SCHEMA_MIGRATION_FAILED_WITHOUT_BACKUP';
  readonly migrationError: unknown;

  constructor(migrationError: unknown) {
    super(`Database migration failed without a recovery backup: ${errorMessage(migrationError)}`);
    this.name = 'SchemaMigrationFailedWithoutBackupError';
    this.migrationError = migrationError;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyNativeModuleError(error: unknown): NativeModuleErrorKind {
  const msg = errorMessage(error);
  if (isAbiError(msg)) return 'abi';
  if (isArchError(msg)) return 'arch';
  if (isLoadError(msg)) return 'load';
  return null;
}

export interface DatabaseErrorDialogOptions {
  context: 'open' | 'schema';
  isPackaged: boolean;
  dbPath: string;
  isolatedProfile?: boolean;
}

export type DatabaseErrorDialogActionId =
  | 'install-current-release'
  | 'reset-isolated-profile'
  | 'quit';

export interface DatabaseErrorDialogAction {
  id: DatabaseErrorDialogActionId;
  label: string;
}

export interface DatabaseErrorDialog {
  title: string;
  detail: string;
  actions?: DatabaseErrorDialogAction[];
}

function nativeModuleFixLines(isPackaged: boolean): string[] {
  if (isPackaged) {
    return [
      'This installation looks corrupted.',
      'Reinstall DNAForge from https://dnaforge.com and relaunch.',
    ];
  }
  return [
    'Fix: run this in your terminal, then relaunch:',
    `  ${NATIVE_MODULE_REBUILD_COMMAND}`,
    '',
    'Or reinstall the dependencies from the repository root, which rebuilds native modules:',
    '  pnpm install --frozen-lockfile',
  ];
}

export function buildDatabaseErrorDialog(
  error: unknown,
  { context, isPackaged, dbPath, isolatedProfile = false }: DatabaseErrorDialogOptions
): DatabaseErrorDialog {
  const msg = errorMessage(error);

  if (error instanceof SchemaVersionTooNewError) {
    const actions: DatabaseErrorDialogAction[] = [
      { id: 'install-current-release', label: 'Install current release' },
    ];
    const recoveryLines: string[] = [];
    if (isolatedProfile) {
      actions.push({
        id: 'reset-isolated-profile',
        label: 'Reset this development profile',
      });
      recoveryLines.push(
        '',
        'This is an isolated development profile. You can reset only this profile without changing the installed release profile.'
      );
    }
    actions.push({ id: 'quit', label: 'Quit' });

    return {
      title: userMessage('dialog.update-required'),
      detail: [
        `This database uses schema v${error.dbVersion}.`,
        `DNAForge ${error.appVersion} supports schema v${error.supportedVersion}.`,
        '',
        'Install the current DNAForge release from https://dnaforge.com/download and relaunch.',
        ...recoveryLines,
        '',
        'Your database has not been modified.',
      ].join('\n'),
      actions,
    };
  }

  if (error instanceof SchemaMigrationNotAuthorizedError) {
    return {
      title: userMessage('dialog.current-release-required'),
      detail: [
        `This database uses schema v${error.databaseVersion}.`,
        `This development build cannot upgrade the shared database to schema v${error.supportedVersion}.`,
        '',
        'Install the current DNAForge release from https://dnaforge.com/download and relaunch.',
        '',
        'Your database has not been modified.',
      ].join('\n'),
      actions: [
        { id: 'install-current-release', label: 'Install current release' },
        { id: 'quit', label: 'Quit' },
      ],
    };
  }

  if (error instanceof SchemaUpgradeBackupRequiredError) {
    return {
      title: userMessage('dialog.database-upgrade-blocked'),
      detail: [
        'DNAForge did not change the database because it could not create the safety backup required for this upgrade.',
        '',
        'Free disk space or check folder permissions, then relaunch.',
        `Database folder: ${error.dbPath}`,
      ].join('\n'),
    };
  }

  if (error instanceof SchemaMigrationRecoveredError) {
    return {
      title: userMessage('dialog.database-migration-failed'),
      detail: [
        'DNAForge restored the database backup created immediately before this upgrade.',
        `Backup restored: ${error.backupCreatedAtLabel}`,
        '',
        `The failed database was preserved at ${error.preRestorePath}.`,
        `Migration error: ${errorMessage(error.migrationError)}`,
      ].join('\n'),
    };
  }

  if (error instanceof SchemaMigrationRecoveryFailedError) {
    return {
      title: userMessage('dialog.database-recovery-failed'),
      detail: [
        'The database upgrade failed, and DNAForge could not restore its safety backup automatically.',
        'Do not delete either file. Contact support with these paths:',
        `Live database: ${error.dbPath}`,
        `Safety backup: ${error.backupPath}`,
        '',
        `Recovery error: ${errorMessage(error.recoveryError)}`,
      ].join('\n'),
    };
  }

  if (error instanceof SchemaMigrationFailedWithoutBackupError) {
    return {
      title: userMessage('dialog.database-migration-failed'),
      detail: [
        'The database upgrade failed, and no safety backup was available to restore.',
        'DNAForge will not start against the partially upgraded database.',
        '',
        `Migration error: ${errorMessage(error.migrationError)}`,
      ].join('\n'),
    };
  }

  const kind = classifyNativeModuleError(error);

  if (kind === 'load') {
    return {
      title: userMessage('dialog.database-engine-failed-to-load'),
      detail: [
        "DNAForge's database engine (better-sqlite3) could not be loaded.",
        'This is a problem with the app’s native files (a corrupt or quarantined',
        'install), NOT your data — deleting the database will not help.',
        '',
        ...nativeModuleFixLines(isPackaged),
        '',
        `Error: ${msg}`,
      ].join('\n'),
    };
  }

  if (kind === 'abi') {
    return {
      title: userMessage('dialog.native-module-version-mismatch'),
      detail: [
        'better-sqlite3 was built for a different Node/Electron version (an ABI mismatch).',
        'This is NOT a CPU-architecture problem, and it CANNOT be fixed by deleting the database.',
        '',
        ...nativeModuleFixLines(isPackaged),
        '',
        `Error: ${msg}`,
      ].join('\n'),
    };
  }

  if (kind === 'arch') {
    return {
      title: userMessage('dialog.native-module-architecture-mismatch'),
      detail: [
        'better-sqlite3 was compiled for the wrong CPU architecture.',
        'This CANNOT be fixed by deleting the database.',
        '',
        ...nativeModuleFixLines(isPackaged),
        '',
        `Error: ${msg}`,
      ].join('\n'),
    };
  }

  return {
    title:
      context === 'schema'
        ? userMessage('dialog.database-schema-error')
        : userMessage('dialog.database-failed-to-initialize'),
    detail: [
      context === 'schema'
        ? 'The database schema could not be initialized.'
        : 'The database could not be opened. Data will not be saved.',
      '',
      `Error: ${msg}`,
      '',
      'If this persists, back up your database file first, then move it aside',
      '(do not delete it) and relaunch to start with a fresh database:',
      `  ${dbPath}`,
    ].join('\n'),
  };
}
