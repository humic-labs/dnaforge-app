import { SchemaVersionTooNewError } from './native-module-error';

export interface SchemaUpdateRecoveryEligibility {
  error: unknown;
  isPackaged: boolean;
  isReleaseBuild: boolean;
  isSharedProfile: boolean;
  isValidationApp: boolean;
  isManagedRuntime: boolean;
  e2eSharedProfile: boolean;
}

export function shouldAutomaticallyRecoverNewerSchema(
  input: SchemaUpdateRecoveryEligibility
): input is SchemaUpdateRecoveryEligibility & { error: SchemaVersionTooNewError } {
  if (
    !(input.error instanceof SchemaVersionTooNewError) ||
    input.isManagedRuntime ||
    input.isValidationApp
  ) {
    return false;
  }
  if (!input.isPackaged) return input.e2eSharedProfile;
  return input.isReleaseBuild && input.isSharedProfile;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isStrictlyNewerStableVersion(candidate: string, running: string): boolean {
  const candidateMatch = STABLE_VERSION.exec(candidate);
  const runningMatch = STABLE_VERSION.exec(running);
  if (!candidateMatch || !runningMatch) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(candidateMatch[index]) - Number(runningMatch[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export type SchemaUpdateDownloadResult =
  | { kind: 'downloaded'; targetVersion: string }
  | { kind: 'no-update' };

export type SchemaUpdateRecoveryResult =
  | { kind: 'install-started'; targetVersion: string }
  | { kind: 'fallback-required'; reason: 'no-update' }
  | { kind: 'fallback-required'; reason: 'failed'; error: unknown };

export interface SchemaUpdateRecoveryDependencies {
  runningVersion: string;
  closeDatabase: () => void;
  flushFatalDiagnostics: () => Promise<void>;
  checkAndDownload: () => Promise<SchemaUpdateDownloadResult>;
  beginInstall: (targetVersion: string) => void;
  reportDiagnosticFailure: (stage: 'close' | 'flush' | 'check-or-install', error: unknown) => void;
}

export async function runSchemaUpdateRecovery(
  deps: SchemaUpdateRecoveryDependencies
): Promise<SchemaUpdateRecoveryResult> {
  try {
    deps.closeDatabase();
  } catch (error) {
    deps.reportDiagnosticFailure('close', error);
    return { kind: 'fallback-required', reason: 'failed', error };
  }

  try {
    await deps.flushFatalDiagnostics();
  } catch (error) {
    deps.reportDiagnosticFailure('flush', error);
  }

  try {
    const update = await deps.checkAndDownload();
    if (update.kind === 'no-update') {
      return { kind: 'fallback-required', reason: 'no-update' };
    }
    if (!isStrictlyNewerStableVersion(update.targetVersion, deps.runningVersion)) {
      throw new Error(
        `Schema recovery rejected non-newer update ${update.targetVersion} for ${deps.runningVersion}`
      );
    }
    deps.beginInstall(update.targetVersion);
    return { kind: 'install-started', targetVersion: update.targetVersion };
  } catch (error) {
    deps.reportDiagnosticFailure('check-or-install', error);
    return { kind: 'fallback-required', reason: 'failed', error };
  }
}
