import './early-file-association';
import { createUserDialogs } from './user-dialogs';
import { userMessage } from '@waypoint/user-messages';

import { app, dialog } from 'electron';

import { configureElectronBeforeReady } from './electron-pre-ready';
import { requestsManagedRuntime } from './managed-runtime-launch';
import { ProfileAlreadyOwnedError } from './profile-already-owned';
import {
  PACKAGED_SOURCE_COMMIT,
  RELEASE_BUILD_IDENTITY,
  classifyReleaseBHostedAuthority,
} from './release-stamp';
import {
  qualifyEphemeralAuthLaunch,
  qualifyEphemeralAuthSource,
} from './qualification-ephemeral-auth';
import { configureQualificationEphemeralAuth } from './qualification-auth-state';
import { installQualificationSafeStorageGuard } from './qualification-safe-storage';
import { isBackgroundWindowMode } from './background-window-mode';
import { disableKeychainInteraction } from './noninteractive-keychain.cjs';
import {
  isAgentLaunch as isAgentEnvironment,
  isTestLaunch,
} from '../../scripts/background-window-policy.cjs';

const hostedAuthorityStamp =
  typeof __DNAFORGE_RELEASE_B_HOSTED__ === 'string' ? __DNAFORGE_RELEASE_B_HOSTED__ : '';
const qualificationEphemeralAuthSource = qualifyEphemeralAuthSource({
  isPackaged: app.isPackaged,
  releaseBuildIdentity: RELEASE_BUILD_IDENTITY,
  releaseBHostedAuthority: classifyReleaseBHostedAuthority(
    hostedAuthorityStamp,
    typeof __DNAFORGE_HOSTED_AI_GATEWAY_URL__ === 'string' ? __DNAFORGE_HOSTED_AI_GATEWAY_URL__ : ''
  ),
  packagedSourceCommit: PACKAGED_SOURCE_COMMIT,
  bakedAuthorityStamp:
    typeof __DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH__ === 'string'
      ? __DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH__
      : '',
});
const qualificationEphemeralAuthLaunch = qualifyEphemeralAuthLaunch({
  sourceCommit: qualificationEphemeralAuthSource,
  platform: process.platform,
  argv: process.argv,
  appDataPath: app.getPath('appData'),
  appName: app.getName(),
});
configureQualificationEphemeralAuth(qualificationEphemeralAuthLaunch?.sourceCommit ?? null);
const qualificationSafeStorageAudit = installQualificationSafeStorageGuard(
  qualificationEphemeralAuthLaunch !== null
);
if (qualificationSafeStorageAudit) {
  (
    globalThis as typeof globalThis & {
      __dnaforgeQualificationSafeStorageAudit?: typeof qualificationSafeStorageAudit;
    }
  ).__dnaforgeQualificationSafeStorageAudit = qualificationSafeStorageAudit;
}

disableKeychainInteraction({
  enabled:
    !app.isPackaged ||
    isBackgroundWindowMode() ||
    isAgentEnvironment() ||
    isTestLaunch(process.env, process.argv) ||
    requestsManagedRuntime(process.argv) ||
    qualificationEphemeralAuthLaunch !== null,
});
configureElectronBeforeReady();

const bootstrapBuildIdentity = {
  sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
} as const;
const sourceCommitStamp = __DNAFORGE_SOURCE_COMMIT__;
const releaseBuildStamp = __DNAFORGE_RELEASE_BUILD__;
const hostedGatewayMarker = __DNAFORGE_HOSTED_AI_GATEWAY_MARKER__;
const hostedMainMarker = __DNAFORGE_HOSTED_AI_RELEASE_A_MARKER__;
const packagedAuthMarker = __DNAFORGE_PACKAGED_AUTH_MARKER__;

function hasValidPackagedSourceIdentity(): boolean {
  return /^DNAFORGE_SOURCE_COMMIT=[0-9a-f]{40}::SOURCE_COMMIT_PROVENANCE_V1::END$/u.test(
    sourceCommitStamp
  );
}

function hasCoherentPackagedPolicy(): boolean {
  const releaseBuildIsValid =
    releaseBuildStamp === '' ||
    releaseBuildStamp === 'DNAFORGE_RELEASE_BUILD=1::SCHEMA_MIGRATION_AUTHORITY_V1::END';
  const authIsValid =
    /^DNAFORGE_PACKAGED_AUTH=(release-a|release-b)::ORIGIN=https:\/\/[^/\s]+::DESKTOP_AUTH_AUTHORITY_V1::END$/u.test(
      packagedAuthMarker
    );
  const hostedIsReleaseA =
    hostedAuthorityStamp === '' &&
    hostedGatewayMarker.endsWith(':empty') &&
    hostedMainMarker.endsWith(':disabled');
  const hostedIsReleaseB =
    /^DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https:\/\/[^/\s]+::HOSTED_GATEWAY_AUTHORITY_V1::END$/u.test(
      hostedAuthorityStamp
    ) &&
    hostedGatewayMarker.endsWith(':configured') &&
    hostedMainMarker.endsWith(':enabled');
  return releaseBuildIsValid && authIsValid && (hostedIsReleaseA || hostedIsReleaseB);
}

function errorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) return error.name;
  return 'UnknownError';
}

async function startProduct(): Promise<void> {
  const product = await import('./index');
  await product.productStartup;
}

async function bootstrap(): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(bootstrapBuildIdentity.sourceBuildFingerprint)) {
    throw new Error('BuildSourceFingerprintError');
  }
  if (app.isPackaged && (!hasValidPackagedSourceIdentity() || !hasCoherentPackagedPolicy())) {
    throw new Error('PackagedBuildIdentityError');
  }
  if (app.isPackaged && process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE === 'before-ready') {
    throw new Error('ForcedBootstrapFailure');
  }
  if (app.isPackaged && process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE === '1') {
    const { maybeForceBootFailureAndExit } = await import('./diagnostics-upload');
    if (await maybeForceBootFailureAndExit()) return;
  }
  await startProduct();
}

void bootstrap().catch(async (error) => {
  if (error instanceof ProfileAlreadyOwnedError) {
    app.exit(error.exitCode);
    return;
  }
  const failureBeforeReady = !app.isReady();
  try {
    const { persistStartupFailure } = await import('./diagnostics-upload');
    await persistStartupFailure(failureBeforeReady ? 'bootstrap_error' : 'startup_error');
  } catch {
    void 0;
  }
  if (app.isPackaged && process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE === 'before-ready') {
    app.exit(42);
    return;
  }
  console.error(`[bootstrap] Startup failed (${errorClass(error)}):`, error);
  if (requestsManagedRuntime(process.argv)) {
    app.once('will-quit', () => app.exit(1));
    app.quit();
    return;
  }
  if (isBackgroundWindowMode()) {
    app.quit();
    return;
  }
  await app.whenReady();
  createUserDialogs(dialog).showErrorBox(
    userMessage('dialog.startup-error'),
    userMessage('startup.reinstall')
  );
  app.quit();
});
