import Database from 'better-sqlite3';
import { existsSync, linkSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ReleaseBuildIdentity } from './release-stamp';
import { prepareDisposableScenarioProfile } from './scenario-profile';
import { isScenarioMutationRequested } from '../shared/scenario-mutation';
import { automationUserDataPath } from './automation-profile';
import {
  decideStartupUserDataProfile,
  hasExplicitUserDataDir,
  type SharedDatabaseState,
  type StartupUserDataProfileDecision,
} from './userdata-migration';

const DATABASE_BASENAME = 'dnaforge.db';
type OpenDatabase = (
  path: string,
  options: { readonly: boolean; fileMustExist: boolean }
) => Database.Database;

export interface StartupProfileDependencies {
  openDatabase?: OpenDatabase;
}

const openDatabase: OpenDatabase = (path, options) => new Database(path, options);

export function readDatabaseSchemaVersion(
  dbPath: string,
  deps: StartupProfileDependencies = {}
): number | null {
  if (!existsSync(dbPath)) return null;

  let db: Database.Database | null = null;
  try {
    db = (deps.openDatabase ?? openDatabase)(dbPath, { readonly: true, fileMustExist: true });
    const version = db.pragma('user_version', { simple: true }) as number;
    return Number.isInteger(version) && version >= 0 ? version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export interface PrepareStartupProfileInput {
  defaultUserData: string;
  argv: readonly string[];
  isDev: boolean;
  desktopDevPort: string | undefined;
  release: ReleaseBuildIdentity;
  currentSchemaVersion: number;
  applicationDirectory?: string;
  treatExplicitUserDataAsShared?: boolean;
  scenarioMutationRequested?: boolean;
}

export function inspectSharedDatabaseState(
  dbPath: string,
  currentSchemaVersion: number,
  deps: StartupProfileDependencies = {}
): SharedDatabaseState {
  if (!existsSync(dbPath)) return 'missing';
  const version = readDatabaseSchemaVersion(dbPath, deps);
  if (version === null) return 'unreadable';
  if (version < currentSchemaVersion) return 'older';
  if (version > currentSchemaVersion) return 'newer';
  return 'current';
}

export function cloneSharedDatabaseIfAbsent(
  sourcePath: string,
  destinationPath: string,
  deps: StartupProfileDependencies = {}
): boolean {
  if (!existsSync(sourcePath) || existsSync(destinationPath)) return false;

  mkdirSync(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.clone-${process.pid}-${Date.now()}`;
  let source: Database.Database | null = null;
  try {
    source = (deps.openDatabase ?? openDatabase)(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    const escapedDestination = temporaryPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedDestination}'`);
    try {
      linkSync(temporaryPath, destinationPath);
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : undefined;
      if (code !== 'EEXIST') throw error;
      unlinkSync(temporaryPath);
      return false;
    }
    unlinkSync(temporaryPath);
    return true;
  } finally {
    source?.close();
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {}
    }
  }
}

export function prepareStartupProfile(
  input: PrepareStartupProfileInput,
  deps: StartupProfileDependencies = {}
): StartupUserDataProfileDecision {
  const automationPath = automationUserDataPath(
    input.argv,
    process.env,
    input.applicationDirectory
  );
  if (automationPath && input.treatExplicitUserDataAsShared)
    throw new Error('Automation cannot use the shared application profile.');
  const scenarioRequested =
    input.scenarioMutationRequested ?? isScenarioMutationRequested(input.argv, process.env);
  const scenarioPath = prepareDisposableScenarioProfile({
    explicitUserDataPath:
      automationPath ?? (hasExplicitUserDataDir(input.argv) ? input.defaultUserData : undefined),
    treatExplicitUserDataAsShared: input.treatExplicitUserDataAsShared,
    allowUnmarkedElectronBootFiles:
      input.isDev && Boolean(input.desktopDevPort) && !input.argv.includes('--e2e'),
    requested: scenarioRequested,
  });
  if (automationPath && scenarioRequested && scenarioPath !== automationPath)
    throw new Error('The automation profile was not admitted as a disposable scenario.');
  if (scenarioPath) {
    return {
      kind: 'scenario-disposable',
      userDataPath: scenarioPath,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    };
  }
  if (automationPath) {
    return {
      kind: 'automation-isolated',
      userDataPath: automationPath,
      migrationAllowed: true,
      migrateLegacyUserData: false,
      cloneSharedDatabase: false,
    };
  }
  const canDecideWithoutSharedInspection =
    (hasExplicitUserDataDir(input.argv) && !input.treatExplicitUserDataAsShared) ||
    (input.isDev && Boolean(input.desktopDevPort)) ||
    input.release.isReleaseBuild;
  const sharedDbPath = join(input.defaultUserData, DATABASE_BASENAME);
  const sharedDatabaseState = canDecideWithoutSharedInspection
    ? 'missing'
    : inspectSharedDatabaseState(sharedDbPath, input.currentSchemaVersion, deps);
  const decision = decideStartupUserDataProfile({
    ...input,
    sharedDatabaseState,
  });

  if (!decision.migrateLegacyUserData) {
    mkdirSync(decision.userDataPath, { recursive: true });
  }
  if (decision.cloneSharedDatabase) {
    const privateDbPath = join(decision.userDataPath, DATABASE_BASENAME);
    cloneSharedDatabaseIfAbsent(sharedDbPath, privateDbPath, deps);
  }

  return decision;
}
