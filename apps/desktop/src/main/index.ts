import { installAssociationPathRouter, installProtocolUrlRouter } from './early-file-association';
import './background-launch-cwd';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { getShellReadiness, installShellReadiness } from './ipc/shell-readiness';
import { installSequenceWheelOwnership } from './sequence-wheel-ownership';
import { mainIpc, sendRendererIpc } from '../shared/ipc-contract';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerSaveBlocker,
  screen,
  session,
  shell,
} from 'electron';
import { setActiveFilesystemWorkGuard } from './active-filesystem-work';
import { basename, join } from 'path';
import { execSync } from 'child_process';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'fs';
import { is } from '@electron-toolkit/utils';
import { ignoreStdioStreamError, isBrokenStdioError } from './stdio-errors';
import { assertBundledGitRuntimeReady } from './bundled-git-runtime';
import {
  ensureApiPort,
  getApiUrl,
  isExplicitE2eTestRuntime,
  loadConfig,
  parseE2eOwnedSidecarAuthority,
} from './config';
import { hasExplicitUserDataDir, migratePackagedUserData } from './userdata-migration';
import { prepareStartupProfile, readDatabaseSchemaVersion } from './startup-profile';
import { ProfileAlreadyOwnedError } from './profile-already-owned';
import { RELEASE_BUILD_IDENTITY } from './release-stamp';
import { isQualificationEphemeralAuthEnabled } from './qualification-auth-state';
import { migrateClonedDevProfileWorkspacePaths } from './dev-profile-workspace-path-migration';
import { registerAllIpcHandlers } from './ipc';
import { shutdownHostedAiGatewayHandlers } from './ipc/hosted-ai-gateway';
import { remoteGenomicsRuntime } from './remote-genomics-runtime';
import { remoteEndpointExplorer } from './remote-endpoint-explorer';
import { shutdownTerminalSessions, stopTerminalSessions } from './terminal/ipc';
import {
  configureMainFeatureProfile,
  agentToolsBridge,
  crashLoopBreaker,
  exitTelemetry,
  processExitSnapshot,
  captureStartupDatabaseDialogForTest,
  createStartupWindowTestBarrier,
  fileAssociations,
  holdAtStartupWindowTestBarrier,
  mainFeatureShutdownSteps,
  mainFeaturesSignedIn,
  prepareMainFeatureProfile,
  mainFeaturesWillQuit,
  nativeDocuments,
  openMainFeatureProtocolUrl,
  prepareMainFeatures,
  prepareNativeAdministration,
  createNativeDocumentQuitSaver,
  routeMainFeatureProtocolUrl,
  findMainFeatureProtocolUrlInArgv,
  skipsStartupRecoveryRelaunchForTest,
  startMainAgentTools,
  startMainFeaturesWithWindow,
  startMcpHttpServices,
  workspaceSync,
} from './features';
import { closeDatabase, getAnalyticsConsentStateFromDb, getDb, getDbPath } from './ipc/database';
import { managedRootDir } from './ipc/workspace-git';
import { purgeExpiredTrashedWorkspaces } from './workspace-git/trash';
import { MainWindowCreationGate } from './main-window-creation-gate';
import { parseManagedRuntimeLaunch, requestsManagedRuntime } from './managed-runtime-launch';
import {
  createUserDialogs,
  buildDatabaseErrorDialog,
  SchemaVersionTooNewError,
  type DatabaseErrorDialog,
  type DatabaseErrorDialogActionId,
} from './native-module-error';
import {
  reconcileInterruptedDatabaseRestore,
  reinstateNewerPreservedDatabase,
  resetIsolatedDatabase,
} from './database-recovery';
import {
  CURRENT_SCHEMA_VERSION,
  ensureSchemaForBuild,
  assertSchemaBuildCompatible,
} from './schema';
import { rememberDeveloperImportSourceRootsInDb } from './registry-source-eligibility';
import {
  getScenarioProfileAdmissionDiagnostic,
  isDisposableScenarioProfileAuthorized,
} from './scenario-profile';
import { DISPOSABLE_SCENARIO_PROFILE_ARGUMENT } from '../shared/scenario-mutation';
import {
  describeLimsSafetyAccessState,
  reconcileLegacyLimsSafetyQuarantine,
  type LimsSafetyAccessState,
} from './lims-safety-quarantine';
import { repairMissingAuthoritySequenceArchives } from './lims-missing-authority-repair';
import { killSidecar, preflightSidecarRuntime, startSidecar } from './sidecar';
import { sidecarSessionAuthority } from './sidecar-session-runtime';
import { createSidecarRequestHeaderHandler } from './compute/credential-injection';
import { readComputeCredential } from './compute/credentials';
import {
  isTrustedSidecarRequestOwner,
  sidecarHeaderFailureDiagnostic,
  SIDECAR_AUTH_REQUEST_FILTER,
} from './sidecar-request-auth';
import { installProteinExperimentWorkerPool } from './protein-experiment-workers';
import { ReviewRoundAdmission } from './review-round-admission';
import { ensureShellPathRepaired } from './agent-sdk/resolve-shell-path';
import { buildMenu } from './menu';
import {
  checkForVersionUpgrade,
  initAutoUpdater,
  isMacTeamIdCutoverBuild,
  isValidationAppIdentity,
  isUpdateDownloaded,
  readBetaUpdatesSetting,
  requestSaveAll,
  startSchemaUpdateRecovery,
  openInstallerDownloadPage,
  _setUpdateDownloadedForTest,
} from './auto-updater';
import { shouldAutomaticallyRecoverNewerSchema } from './schema-update-recovery';
import {
  getDirtyState,
  readCurrentDirtyState,
  registerDirtyStateHandler,
} from './dirty-state-cache';
import { installRendererRecovery, isRendererAvailable } from './renderer-recovery';
import { configureUnsavedWorkSaver, shouldSuppressBlockingDialogs } from './quit-consent';
import { createQuitPromptBinding, type QuitPromptBinding } from './quit-prompt-binding';
import { quitPromptSuppressed } from './quit-prompt-timing';
import { runShutdownSteps } from './shutdown-steps';
import {
  focusWindowUnlessBackground,
  installBackgroundWindowPolicy,
  isBackgroundWindowMode,
  shouldRunE2EInBackground,
  testWindowExceedsDisplay,
} from './background-window-mode';
import {
  handleBeforeQuit,
  hasQuitConsent,
  setQuitConsentGranted,
  showUnsavedWorkDialog,
} from './quit-orchestration';
import { showMacUpdateStatus } from './update-status';
import {
  captureMainException,
  flushAnalyticsForFatalStartup,
  initAnalyticsMain,
  shutdownAnalytics,
  trackEvent,
  trackAppClosed,
  trackAppSessionStarted,
  trackMainProcessError,
  trackRenderProcessCrashed,
} from './analytics';
import { appendBootLog } from './boot-log';
import {
  notifyBootSucceeded,
  reportBootOrCrashFailure,
  startDiagnosticsPhoneHome,
} from './diagnostics-upload';
import { reportPriorNativeCrashes } from './native-crash-reporter';
import { isSafeExternalProtocol, isTrustedRendererUrl } from './security';
import {
  assemblyAnnotationSceneResourceRegistry,
  installAssemblyAnnotationSceneProtocol,
} from './ipc/assembly-annotation-scene-resource';
import { readEnvLocalValue } from './electron-pre-ready';
import { disposeAssemblyAnnotationSearchQuerySessions } from './ipc/assembly-annotation-search-query';
import { assemblyAnnotationSearchAuthority } from './ipc/assembly-annotation-search-authority';
import { disposeAssemblyProteinSearchQuerySessions } from './ipc/assembly-protein-search-query';
import { assemblyProteinSearchAuthority } from './ipc/assembly-protein-search-authority';
import { disposeGenomeSearchQueryLifecycles } from './ipc/assembly-annotation-search-query-lifecycle';
import { WorkspaceSetPathDeliveryCoordinator } from './workspace-set-path-delivery';

import { shutdownGitReadRequests } from './ipc/shell';
import { registerProtocolScheme, findCallbackUrlInArgv } from './auth/protocol';
import { handleCallback, hydrateOnLaunch } from './auth/controller';
import { getMainWindowChromeOptions } from './window-chrome';
import { formatDevWindowTitle, normalizeDevInstanceLabel } from '../shared/dev-window-identity';
import { applyDevDockBadge } from './dev-dock-icon';
import {
  extractAssociationPathsFromArgv,
  MCP_LAUNCH_ARG,
  shouldShowSecondInstanceError,
} from './file-activation';

if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', ignoreStdioStreamError);
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', ignoreStdioStreamError);
}

process.on('uncaughtException', (error) => {
  if (isBrokenStdioError(error)) return;
  console.error('[main] Uncaught exception:', error);
  trackMainProcessError('uncaught_exception');
  reportBootOrCrashFailure('uncaught_exception', 'crash');
  void captureMainException(error);
});

process.on('unhandledRejection', (reason) => {
  if (isBrokenStdioError(reason)) return;
  console.error('[main] Unhandled rejection:', reason);
  trackMainProcessError('unhandled_rejection');
  reportBootOrCrashFailure('unhandled_rejection', 'crash');
  void captureMainException(reason);
});

let mainWindowRef: BrowserWindow | null = null;
const mainFeatureContext = { getMainWindow: (): BrowserWindow | null => mainWindowRef };

let terminalPrimaryOwnerRef: number | null = null;
let productQuit: QuitPromptBinding | null = null;
const mainWindowCreationGate = new MainWindowCreationGate<BrowserWindow>((window) =>
  window.isDestroyed()
);
const startupWindowCreationTestBarrier = createStartupWindowTestBarrier();
const managedRuntimeLaunch = parseManagedRuntimeLaunch(process.argv, process.cwd());
let schemaUpdateRecoveryInProgress = false;
let documentEditingClientCreated = false;
app.on('browser-window-created', () => {
  documentEditingClientCreated = true;
});
const canAssertNoEditingClient = () =>
  Boolean(managedRuntimeLaunch) && !documentEditingClientCreated;

if (managedRuntimeLaunch || !app.isPackaged) {
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
}
let trustedRendererUrlRef: string | null = null;
let trustedSidecarWebContentsId: number | null = null;
const proteinExperimentSidecarOwners = new Set<number>();
const workspaceSetPathDelivery = new WorkspaceSetPathDeliveryCoordinator(
  (target: Electron.WebContents, delivery) => {
    sendRendererIpc(
      target,
      'workspace:set-path',
      delivery.workspacePath,
      delivery.deliveryId,
      delivery.telemetryContext
    );
  },
  () => crypto.randomUUID()
);
mainIpc.on('workspace:set-path-listener-ready', (event) => {
  if (event.sender.id !== trustedSidecarWebContentsId) return;
  workspaceSetPathDelivery.markReady(event.sender);
});
function showStartupDatabaseError(model: DatabaseErrorDialog): DatabaseErrorDialogActionId {
  if (managedRuntimeLaunch) {
    console.error(`[Database] ${model.title}: ${model.detail}`);
    return 'quit';
  }
  const captured = captureStartupDatabaseDialogForTest(model);
  if (captured) return captured;

  if (!model.actions || model.actions.length === 0) {
    createUserDialogs(dialog).showErrorBox(
      toUserMessage(model.title, 'operation.failedTitle'),
      toUserMessage(model.detail, 'startup.databaseFailed')
    );
    return 'quit';
  }

  const response = createUserDialogs(dialog).showMessageBoxSync({
    type: 'error',
    title: toUserMessage(model.title, 'operation.failedTitle'),
    message: toUserMessage(model.title, 'operation.failed'),
    detail: toUserMessage(model.detail, 'startup.databaseFailed'),
    buttons: model.actions
      .map((action) => action.label)
      .map((label) => toUserMessage(label, 'dialog.continue')),
    defaultId: 0,
    cancelId: model.actions.findIndex((action) => action.id === 'quit'),
    noLink: true,
  });
  return model.actions[response]?.id ?? 'quit';
}

function relaunchAfterStartupDatabaseRecovery(): void {
  if (skipsStartupRecoveryRelaunchForTest()) {
    app.exit(0);
    return;
  }
  app.relaunch();
  app.exit(0);
}

const defaultUserDataPath = app.getPath('userData');
const treatExplicitUserDataAsSharedForE2e =
  process.env.WAYPOINT_TEST === '1' && process.argv.includes('--dnaforge-test-shared-profile');
const startupProfile = prepareStartupProfile({
  defaultUserData: defaultUserDataPath,
  argv: process.argv,
  isDev: is.dev,
  desktopDevPort: process.env.DESKTOP_DEV_PORT ?? readEnvLocalValue('DESKTOP_DEV_PORT'),
  release: RELEASE_BUILD_IDENTITY,
  currentSchemaVersion: CURRENT_SCHEMA_VERSION,
  applicationDirectory: app.getAppPath(),
  treatExplicitUserDataAsShared: treatExplicitUserDataAsSharedForE2e,
});
if (startupProfile.userDataPath !== app.getPath('userData')) {
  app.setPath('userData', startupProfile.userDataPath);
}

if (startupProfile.migrateLegacyUserData) {
  const migration = migratePackagedUserData({
    appData: app.getPath('appData'),
    defaultUserData: defaultUserDataPath,
  });
  if (migration.userDataPath !== app.getPath('userData')) {
    app.setPath('userData', migration.userDataPath);
  }
  if (migration.action === 'migrated') {
    console.log('[main] : migrated userData @waypoint/desktop → DNAForge');
  } else if (migration.action === 'fallback-legacy') {
    console.error('[main] : userData rename failed; using legacy @waypoint/desktop path');
  }
}

mkdirSync(app.getPath('userData'), { recursive: true });
configureMainFeatureProfile({
  isolated:
    process.env.WAYPOINT_TEST === '1' ||
    hasExplicitUserDataDir(process.argv) ||
    startupProfile.kind === 'scenario-disposable' ||
    startupProfile.kind === 'automation-isolated',
});

try {
  prepareMainFeatureProfile(app.getPath('userData'));
} catch (error) {
  console.error('[scientific-recovery] Cannot open a profile owned by another operation:', error);
  app.exit(1);
  throw error;
}

installBackgroundWindowPolicy(
  app,
  BrowserWindow,
  resolveDevWindowTitle(),
  process.env,
  process.platform,
  process.argv,
  (detail) => appendBootLog(`window_activation ${detail}`)
);
const startupAssociationPaths = extractAssociationPathsFromArgv(process.argv, process.cwd());
const startupProtocolUrl =
  findMainFeatureProtocolUrlInArgv(process.argv) ?? findCallbackUrlInArgv(process.argv);
if (!app.requestSingleInstanceLock()) {
  console.log('[main] Another instance is already running; exiting');
  if (
    !managedRuntimeLaunch &&
    shouldShowSecondInstanceError(
      app.isPackaged,
      startupAssociationPaths,
      startupProtocolUrl,
      process.argv
    )
  ) {
    createUserDialogs(dialog).showErrorBox(
      userMessage('dialog.dnaforge-is-already-running'),
      userMessage('dialog.another-dnaforge-process-already-owns-this-profile-switch-to-its-exist')
    );
  }
  throw new ProfileAlreadyOwnedError(managedRuntimeLaunch ? 1 : 0);
}
appendBootLog(`startup_profile kind=${startupProfile.kind}`);
const scenarioProfileAdmissionDiagnostic = getScenarioProfileAdmissionDiagnostic();
if (scenarioProfileAdmissionDiagnostic) {
  appendBootLog(
    `scenario_profile_admission_denied ${JSON.stringify(scenarioProfileAdmissionDiagnostic)}`
  );
}

nativeDocuments.bindProfile(app.getPath('userData'));

fileAssociations.configure({
  userDataPath: app.getPath('userData'),
  helperSourcePath: join(__dirname, '../../resources/helpers-src/dnaforge-file-association.m'),
  openExternal: (url) => shell.openExternal(url),
});

function focusMainWindow(): void {
  focusWindowUnlessBackground(mainWindowRef);
}

function routeAssociationPaths(paths: readonly string[]): void {
  const deliveries = fileAssociations.activationQueue.enqueue(paths);
  if (deliveries.length > 0 && mainWindowRef && !mainWindowRef.isDestroyed()) {
    sendRendererIpc(mainWindowRef.webContents, 'file-association:open-files', deliveries);
  }
  if (paths.length > 0) focusMainWindow();
}

routeAssociationPaths(startupAssociationPaths);
routeAssociationPaths(installAssociationPathRouter(routeAssociationPaths));

let protocolReady = false;
const bufferedProtocolUrls: string[] = [];
function routeProtocolUrl(url: string): void {
  if (!protocolReady) {
    bufferedProtocolUrls.push(url);
    return;
  }
  if (routeMainFeatureProtocolUrl(url, { window: mainWindowRef, activate: focusMainWindow }))
    return;
  if (openMainFeatureProtocolUrl(url, mainFeatureContext)) return;
  void handleCallback(url);
}

for (const url of installProtocolUrlRouter(routeProtocolUrl)) routeProtocolUrl(url);

if (startupProtocolUrl) routeProtocolUrl(startupProtocolUrl);

app.on('second-instance', (_event, argv, workingDirectory) => {
  if (requestsManagedRuntime(argv) || argv.includes(MCP_LAUNCH_ARG)) return;
  const callbackUrl = findMainFeatureProtocolUrlInArgv(argv) ?? findCallbackUrlInArgv(argv);
  if (callbackUrl) routeProtocolUrl(callbackUrl);
  routeAssociationPaths(extractAssociationPathsFromArgv(argv, workingDirectory));
  if (process.platform !== 'darwin') focusMainWindow();
});

function safeOpenExternal(url: string): void {
  if (!isSafeExternalProtocol(url)) return;
  shell.openExternal(url).catch((err) => {
    console.error('[Security] Failed to open external URL:', err);
  });
}

function getWindowPreloadPath(): string {
  return existsSync(join(__dirname, '../preload/index.js'))
    ? join(__dirname, '../preload/index.js')
    : join(__dirname, '..', '..', 'preload', 'index.js');
}

function getPreloadRuntimeArguments(): string[] {
  const args: string[] = [];
  if (process.platform === 'darwin') args.push('--dnaforge-native-wheel-ownership=1');
  if (process.argv.includes('--e2e') || process.argv.includes('--waypoint-e2e=1')) {
    args.push('--waypoint-e2e=1');
  }
  if (process.env.WAYPOINT_TEST === '1' || process.argv.includes('--waypoint-test=1')) {
    args.push('--waypoint-test=1');
  }
  if (
    process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION === '1' ||
    process.argv.includes('--dnaforge-allow-scenario-mutation=1')
  ) {
    args.push('--dnaforge-allow-scenario-mutation=1');
  }
  if (isDisposableScenarioProfileAuthorized(app.getPath('userData'))) {
    args.push(DISPOSABLE_SCENARIO_PROFILE_ARGUMENT);
  }
  return args;
}

function resolveDevWindowTitle(): string | null {
  if ((app.isPackaged || process.env.NODE_ENV === 'production') && !isBackgroundWindowMode())
    return null;
  const port =
    readEnvLocalValue('DESKTOP_DEV_PORT') ||
    process.env.DESKTOP_DEV_PORT ||
    process.env.VITE_DEV_SERVER_PORT ||
    null;
  let branch = '';
  let shortSha = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      cwd: app.getAppPath(),
    }).trim();
  } catch {
    branch = '';
  }
  try {
    shortSha = execSync('git rev-parse --short=7 HEAD', {
      encoding: 'utf8',
      cwd: app.getAppPath(),
    }).trim();
  } catch {
    shortSha = '';
  }

  let worktreeBase = basename(app.getAppPath());
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      cwd: app.getAppPath(),
    }).trim();
    worktreeBase = basename(top);
  } catch {}
  const label = normalizeDevInstanceLabel(branch, worktreeBase);
  return formatDevWindowTitle({ label, port, shortSha });
}

async function createWindow(): Promise<BrowserWindow> {
  const window = await mainWindowCreationGate.getOrCreate(mainWindowRef, createWindowOnce);
  mainWindowRef = window;

  retryWorkspaceSyncAfterRendererReady(window);
  return window;
}

function retryWorkspaceSyncAfterRendererReady(window: BrowserWindow): void {
  if (
    mainWindowRef !== window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    !getShellReadiness(window.webContents)?.shellReady
  ) {
    return;
  }
  workspaceSync.pullAfterRendererReady();
}

async function createWindowOnce(): Promise<BrowserWindow> {
  const isTest = process.env.NODE_ENV === 'test';
  const localBackgroundTest = shouldRunE2EInBackground(process.env, process.platform, process.argv);
  const backgroundWindow = (!isTest && isBackgroundWindowMode()) || localBackgroundTest;
  const showWindow =
    !localBackgroundTest &&
    ((!isTest && !backgroundWindow) || process.env.WAYPOINT_PACKAGED_E2E_SHOW_WINDOW === '1');
  const devTitle = resolveDevWindowTitle();

  const e2eArg = process.argv.includes('--e2e') || process.argv.includes('--waypoint-e2e=1');
  const querySearch = e2eArg ? 'e2e=true' : undefined;

  const packagedRendererPath = existsSync(join(__dirname, '../renderer/index.html'))
    ? join(__dirname, '../renderer/index.html')
    : join(__dirname, '..', '..', 'renderer', 'index.html');
  const preloadPath = getWindowPreloadPath();
  const trustedRendererUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? `${process.env['ELECTRON_RENDERER_URL']}${querySearch ? `?${querySearch}` : ''}`
      : (() => {
          const url = pathToFileURL(packagedRendererPath);
          if (querySearch) url.search = querySearch;
          return url.toString();
        })();
  trustedRendererUrlRef = trustedRendererUrl;
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,

    show: showWindow,
    ...(devTitle ? { title: devTitle } : {}),
    ...getMainWindowChromeOptions(),
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: getPreloadRuntimeArguments(),
    },
  });
  terminalPrimaryOwnerRef = mainWindow.webContents.id;
  appendBootLog(`main_window_instance_created id=${mainWindow.id}`);
  installSequenceWheelOwnership(mainWindow);
  if (
    backgroundWindow ||
    (isTest && process.platform === 'linux') ||
    testWindowExceedsDisplay(
      { NODE_ENV: process.env.NODE_ENV },
      process.platform,
      screen.getPrimaryDisplay().workAreaSize,
      {
        width: 1200,
        height: 800,
      }
    )
  ) {
    mainWindow.once('ready-to-show', () => {
      if (!mainWindow.isDestroyed()) mainWindow.showInactive();
    });
  } else if (is.dev && showWindow) {
    const external = screen
      .getAllDisplays()
      .find((display) => display.id !== screen.getPrimaryDisplay().id);
    if (external) {
      mainWindow.setBounds(external.bounds);
      mainWindow.moveTop();
      mainWindow.focus();
      const placed = mainWindow.getBounds();
      appendBootLog(
        `placed_on_external x=${placed.x} y=${placed.y} w=${placed.width} h=${placed.height}`
      );
    }
  }
  if (!isMacTeamIdCutoverBuild()) {
    installShellReadiness(mainWindow, trustedRendererUrl, () =>
      retryWorkspaceSyncAfterRendererReady(mainWindow)
    );
  }
  if (devTitle) {
    mainWindow.setTitle(devTitle);

    mainWindow.webContents.on('did-finish-load', () => {
      if (!mainWindow.isDestroyed()) mainWindow.setTitle(devTitle);
    });
  }
  const mainWindowWebContentsId = mainWindow.webContents.id;
  trustedSidecarWebContentsId = mainWindowWebContentsId;
  if (!isMacTeamIdCutoverBuild()) {
    installProteinExperimentWorkerPool({
      admission: new ReviewRoundAdmission(join(app.getPath('userData'), 'review-rounds')),
      rootWindow: mainWindow,
      rendererUrl: trustedRendererUrl,
      preloadPath,
      preloadArguments: getPreloadRuntimeArguments(),
      requireAgentToolsReady: agentToolsBridge.requireReady,
      onWorkerCreated: (contents) => proteinExperimentSidecarOwners.add(contents.id),
      onWorkerDestroyed: (contents) => proteinExperimentSidecarOwners.delete(contents.id),
    });
  }
  mainWindow.webContents.on('did-start-loading', () => {
    workspaceSetPathDelivery.markLoading(mainWindowWebContentsId);
  });
  mainWindow.once('closed', () => {
    workspaceSetPathDelivery.remove(mainWindowWebContentsId);
    if (trustedSidecarWebContentsId === mainWindowWebContentsId) {
      trustedSidecarWebContentsId = null;
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const prefix =
      ['[renderer:verbose]', '[renderer:info]', '[renderer:warn]', '[renderer:error]'][level] ||
      '[renderer]';
    console.log(prefix, message);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedRendererUrl(url, trustedRendererUrl)) {
      safeOpenExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, trustedRendererUrl)) {
      event.preventDefault();
      safeOpenExternal(url);
    }
  });

  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, trustedRendererUrl)) {
      event.preventDefault();
      safeOpenExternal(url);
    }
  });

  let rendererPid = mainWindow.webContents.getOSProcessId();
  let rendererStartedAt = Date.now();
  mainWindow.webContents.on('did-finish-load', () => {
    rendererPid = mainWindow.webContents.getOSProcessId();
    rendererStartedAt = Date.now();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const exit = {
      ...details,
      process_type: 'renderer',
      ...processExitSnapshot(rendererPid, rendererStartedAt),
    };
    trackRenderProcessCrashed(details.reason, exitTelemetry(exit));
    crashLoopBreaker.record(exit);
    reportBootOrCrashFailure(`render_${details.reason}`, 'crash');
  });

  mainWindow.on('close', (event) => {
    if (!productQuit) {
      throw new Error('Quit prompt was used before it was installed.');
    }
    productQuit.onWindowClose(event, mainWindow);
  });

  const preloadFailure = new Promise<never>((_resolve, reject) => {
    mainWindow.webContents.once('preload-error', (_event, preloadPath, error) => {
      reject(new Error(`Preload failed at ${preloadPath}: ${error.message}`));
    });
  });
  installRendererRecovery(mainWindow, {
    isQuitting: () => productQuit?.isQuitting() ?? false,
    isSafeMode: () => crashLoopBreaker.isSafeMode(),
    suppressDialogs: shouldSuppressBlockingDialogs,
    devServerUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    appUrl: trustedRendererUrl,
  });
  const rendererLoad =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? mainWindow.loadURL(trustedRendererUrl)
      : mainWindow.loadFile(
          packagedRendererPath,
          querySearch ? { search: querySearch } : undefined
        );
  await Promise.race([rendererLoad, preloadFailure]);

  const menu = buildMenu(mainWindow);
  Menu.setApplicationMenu(menu);
  if (process.platform === 'win32') {
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.on('resize', () => {
    if (!mainWindow.isDestroyed()) {
      sendRendererIpc(mainWindow.webContents, 'window:resize');
    }
  });
  mainWindow.on('move', () => {
    if (!mainWindow.isDestroyed()) {
      sendRendererIpc(mainWindow.webContents, 'window:move');
    }
  });

  return mainWindow;
}

function sendWorkspacePathToRenderer(mainWindow: BrowserWindow, workspacePath: string): void {
  workspaceSetPathDelivery.queue(mainWindow.webContents, workspacePath);
}

async function recoverNewerSchemaWithoutUserChoice(error: unknown): Promise<boolean> {
  if (!(error instanceof SchemaVersionTooNewError)) return false;
  const e2eSharedProfile =
    !app.isPackaged && process.env.WAYPOINT_TEST === '1' && treatExplicitUserDataAsSharedForE2e;
  if (
    !shouldAutomaticallyRecoverNewerSchema({
      error,
      isPackaged: app.isPackaged,
      isReleaseBuild: RELEASE_BUILD_IDENTITY.isReleaseBuild,
      isSharedProfile: startupProfile.kind === 'release-shared',
      isValidationApp: isValidationAppIdentity({
        isPackaged: app.isPackaged,
        appName: app.isPackaged ? app.getName() : '',
      }),
      isManagedRuntime: Boolean(managedRuntimeLaunch),
      e2eSharedProfile,
    })
  ) {
    return false;
  }

  schemaUpdateRecoveryInProgress = true;
  console.error('[main] Installed release is older than the shared database:', error);
  appendBootLog('schema_update_recovery_started');
  reportBootOrCrashFailure('schema_update_recovery_started', 'boot_failure');
  trackEvent('app_schema_refused', {
    db_version: error.dbVersion,
    build_version: error.appVersion,
    is_release: RELEASE_BUILD_IDENTITY.isReleaseBuild,
    recovery: 'automatic_update',
  });

  const result = await startSchemaUpdateRecovery({
    error,
    closeDatabase,
    flushFatalDiagnostics: flushAnalyticsForFatalStartup,
    openCurrentInstaller: () => safeOpenExternal('https://dnaforge.com/download'),
  });
  if (result.kind === 'fallback-required') {
    appendBootLog(`schema_update_recovery_fallback reason=${result.reason}`);
    openInstallerDownloadPage(safeOpenExternal);
    app.exit(1);
  }
  return true;
}

async function init(): Promise<void> {
  try {
    startDiagnosticsPhoneHome();

    reportPriorNativeCrashes();
    appendBootLog('sentry_initialized');
  } catch {}

  setImmediate(() => {
    const dockBadgeResult = applyDevDockBadge({
      port: process.env.DESKTOP_DEV_PORT ?? readEnvLocalValue('DESKTOP_DEV_PORT'),
    });
    if (dockBadgeResult === 'failed') {
      console.log(`[dev-dock-badge] not applied: ${dockBadgeResult}`);
    }
  });

  if (startupWindowCreationTestBarrier) {
    await holdAtStartupWindowTestBarrier(startupWindowCreationTestBarrier);
  }

  let config: Record<string, string> = {};

  const runtimeSidecarAuthority = parseE2eOwnedSidecarAuthority(
    process.argv,
    isExplicitE2eTestRuntime(process.argv, process.env.WAYPOINT_TEST)
  );
  try {
    config = loadConfig(app.getAppPath(), {
      strict: false,
      runtimeSidecarAuthority,
    });
    if (runtimeSidecarAuthority) {
      console.log(
        `[Config] Explicit E2E-owned sidecar authority on port ${runtimeSidecarAuthority.port}`
      );
    }
    appendBootLog('config_loaded');
  } catch (err) {
    console.error('[main] Config load failed:', err);
    appendBootLog('config_load_failed');
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (navEvent, url) => {
      if (!trustedRendererUrlRef || !isTrustedRendererUrl(url, trustedRendererUrlRef)) {
        navEvent.preventDefault();
        safeOpenExternal(url);
      }
    });
    contents.on('will-redirect', (navEvent, url) => {
      if (!trustedRendererUrlRef || !isTrustedRendererUrl(url, trustedRendererUrlRef)) {
        navEvent.preventDefault();
        safeOpenExternal(url);
      }
    });
  });

  if (isMacTeamIdCutoverBuild()) {
    if (managedRuntimeLaunch)
      throw new Error('This recovery-only build cannot own managed operations.');
    const mainWindow = await createWindow();
    mainWindowRef = mainWindow;
    appendBootLog('mac_team_id_cutover_window_created');
    appendBootLog('renderer_did_finish_load');
    appendBootLog('recovery_window_ready');
    notifyBootSucceeded('recovery_window');
    initAutoUpdater(mainWindow, { allowPrerelease: false });
    return;
  }

  const bundledGit = assertBundledGitRuntimeReady();
  appendBootLog(`bundled_git_ready version=${bundledGit.version}`);

  try {
    const reconciliation = reconcileInterruptedDatabaseRestore(getDbPath());
    if (reconciliation.action === 'rolled-back') {
      console.warn(
        `[main] Rolled back an interrupted database restore from ${reconciliation.preRestorePath}`
      );
    } else if (reconciliation.action === 'completed') {
      console.log(
        `[main] Finalized an interrupted database restore; preserved prior database at ${reconciliation.preRestorePath}`
      );
    } else if (reconciliation.action === 'cancelled') {
      console.warn('[main] Cleared a database restore intent that stopped before the swap began');
    }
  } catch (error) {
    console.error('[main] Interrupted database restore reconciliation failed:', error);
    showStartupDatabaseError({
      title: 'Database recovery requires attention',
      detail: [
        'DNAForge found an interrupted database recovery operation and did not open or create a database.',
        'Your database and recovery files have not been intentionally deleted.',
        '',
        `Error: ${String(error)}`,
      ].join('\n'),
    });
    app.exit(1);
    return;
  }

  if (startupProfile.migrationAllowed) {
    try {
      const reinstatement = reinstateNewerPreservedDatabase(getDbPath(), CURRENT_SCHEMA_VERSION);
      if (reinstatement.action === 'reinstated') {
        console.warn(
          `[main] Reinstated the newer preserved database ${reinstatement.reinstatedFromPath} ` +
            `(schema v${reinstatement.reinstatedSchemaVersion}); the older live database ` +
            `(schema v${reinstatement.supersededSchemaVersion}) was kept at ${reinstatement.supersededPath}`
        );
        appendBootLog(
          `database_reinstated from_schema=${reinstatement.supersededSchemaVersion} to_schema=${reinstatement.reinstatedSchemaVersion}`
        );
      }
    } catch (error) {
      console.error('[main] Preserved database reinstatement failed:', error);
      showStartupDatabaseError({
        title: 'Database recovery requires attention',
        detail: [
          'DNAForge found a newer preserved copy of your database but could not put it back in place, and did not open or create a database.',
          'Your database and recovery files have not been intentionally deleted.',
          '',
          `Error: ${String(error)}`,
        ].join('\n'),
      });
      app.exit(1);
      return;
    }
  }

  const persistedSchemaVersion = readDatabaseSchemaVersion(getDbPath());
  if (persistedSchemaVersion !== null && persistedSchemaVersion > CURRENT_SCHEMA_VERSION) {
    const newerSchemaError = new SchemaVersionTooNewError({
      dbVersion: persistedSchemaVersion,
      supportedVersion: CURRENT_SCHEMA_VERSION,
      appVersion: app.getVersion(),
    });
    if (await recoverNewerSchemaWithoutUserChoice(newerSchemaError)) return;
  }

  preflightSidecarRuntime();

  await ensureApiPort();

  await installAssemblyAnnotationSceneProtocol(
    session.defaultSession.protocol,
    assemblyAnnotationSceneResourceRegistry
  );

  void ensureShellPathRepaired();

  let database: ReturnType<typeof getDb>;
  try {
    database = getDb({ interactive: !managedRuntimeLaunch });
  } catch (error) {
    if (managedRuntimeLaunch) throw error;
    return;
  }
  const analyticsConsent = getAnalyticsConsentStateFromDb();
  initAnalyticsMain(config, analyticsConsent);
  try {
    assertSchemaBuildCompatible(database, { migrationAllowed: startupProfile.migrationAllowed });
    ensureSchemaForBuild(database, getDbPath(), {
      migrationAllowed: startupProfile.migrationAllowed,
      writer: {
        version: app.getVersion(),
        isReleaseBuild: RELEASE_BUILD_IDENTITY.isReleaseBuild,
        fingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        writtenAt: Date.now(),
      },
    });
    rememberDeveloperImportSourceRootsInDb(database);
  } catch (err) {
    console.error('[main] Schema initialization failed:', err);
    if (await recoverNewerSchemaWithoutUserChoice(err)) return;
    appendBootLog('schema_init_failed');
    reportBootOrCrashFailure('schema_init_failed', 'boot_failure');
    const isolatedProfile =
      startupProfile.kind === 'scenario-disposable' ||
      startupProfile.kind === 'explicit' ||
      startupProfile.kind === 'worktree-dev' ||
      startupProfile.kind === 'unstamped-isolated';
    const databaseDialog = buildDatabaseErrorDialog(err, {
      context: 'schema',
      isPackaged: app.isPackaged,
      dbPath: getDbPath(),
      isolatedProfile,
    });
    const selectedAction = showStartupDatabaseError(databaseDialog);
    try {
      await flushAnalyticsForFatalStartup();
    } catch (analyticsError) {
      console.warn('[main] Failed to flush fatal-startup analytics:', analyticsError);
    }

    try {
      if (selectedAction === 'install-current-release') {
        safeOpenExternal('https://dnaforge.com/download');
      } else if (selectedAction === 'reset-isolated-profile' && isolatedProfile) {
        closeDatabase();
        resetIsolatedDatabase(getDbPath());
        console.log('[main] Reset isolated development database after explicit user confirmation');
        relaunchAfterStartupDatabaseRecovery();
        return;
      }
    } catch (recoveryActionError) {
      console.error('[main] Startup database recovery action failed:', recoveryActionError);
      showStartupDatabaseError({
        title: 'Database recovery action failed',
        detail: [
          'DNAForge could not complete the selected recovery action.',
          'The existing database and any recovery files have not been intentionally deleted.',
          '',
          `Error: ${String(recoveryActionError)}`,
        ].join('\n'),
      });
    }

    app.exit(1);
    return;
  }

  let limsSafetyQuarantine: LimsSafetyAccessState | null;
  try {
    limsSafetyQuarantine = reconcileLegacyLimsSafetyQuarantine(database);
  } catch (error) {
    console.error('[main] Legacy LIMS safety reconciliation could not finish:', error);
    limsSafetyQuarantine = {
      status: 'unresolved',
      pendingCandidateCount: 1,
      reason: 'lims_safety_reconciliation_failed',
    };
  }
  if (limsSafetyQuarantine) {
    const message = describeLimsSafetyAccessState(limsSafetyQuarantine);
    if (managedRuntimeLaunch) console.error(`[LIMS] ${message.summary}: ${message.detail}`);
    else
      createUserDialogs(dialog).showErrorBox(
        userMessage('dialog.lims-registry-temporarily-unavailable'),
        userMessage('registry.recoveryNeeded')
      );
  }

  if (startupProfile.kind === 'worktree-dev') {
    try {
      const result = migrateClonedDevProfileWorkspacePaths(getDb(), app.getPath('userData'));
      if (result.action === 'migrated') {
        console.log(
          `[main] Rebound ${result.migratedWorkspaces} cloned dev managed workspace(s) to the current profile.`,
          result.migratedRows
        );
      }
      if (result.skipped.length > 0) {
        console.warn(
          '[main] Skipped unsafe cloned dev managed-workspace path repair(s):',
          result.skipped
        );
      }
    } catch (error) {
      console.warn('[main] Cloned dev managed-workspace path repair failed closed:', error);
    }
  }

  if (limsSafetyQuarantine === null) {
    try {
      const repair = repairMissingAuthoritySequenceArchives(database);
      if (repair.candidates > 0) {
        console.info('[main] Repaired incomplete-reconcile Registry archives:', repair);
      }
    } catch (error) {
      console.error('[main] Registry archive repair could not finish:', error);
    }
  }

  prepareNativeAdministration({ ...mainFeatureContext, appVersion: app.getVersion() });

  if (managedRuntimeLaunch) {
    await nativeDocuments.workspaces.replaceRoots(managedRuntimeLaunch.workspaceRoots);
    await nativeDocuments.start({ editingClient: 'none', canAssertNoEditingClient });
    await startSidecar(null);
    if (sidecarSessionAuthority.snapshot().state !== 'ready') {
      throw new Error('The managed runtime could not establish a ready operation service.');
    }
    console.log(
      '[ManagedRuntime] Ready; operation clients may connect. No editing client is active.'
    );
    return;
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(
    SIDECAR_AUTH_REQUEST_FILTER,
    createSidecarRequestHeaderHandler({
      isTrustedOwner: (details) =>
        isTrustedSidecarRequestOwner(details, trustedSidecarWebContentsId, trustedRendererUrlRef) ||
        [...proteinExperimentSidecarOwners].some((id) =>
          isTrustedSidecarRequestOwner(details, id, trustedRendererUrlRef)
        ),
      getSidecarBaseUrl: getApiUrl,
      authority: sidecarSessionAuthority,
      readCredential: readComputeCredential,
      onError: (error, stage, requestUrl) => {
        console.warn(
          '[Sidecar] Renderer request canceled at the header boundary:',
          sidecarHeaderFailureDiagnostic({
            stage,
            error,
            requestUrl,
            sidecarBaseUrl: getApiUrl(),
            snapshot: sidecarSessionAuthority.snapshot(),
          })
        );
      },
    })
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],

        'Content-Security-Policy': ["frame-src 'self'"],
      },
    });
  });

  nativeDocuments.startRendererPublisher(() => {
    const window = mainWindowRef;
    return window && !window.isDestroyed() && !window.webContents.isDestroyed()
      ? window.webContents
      : null;
  }, getShellReadiness);
  nativeDocuments.registerWorkspaceRootsHandler((event, loadId) => {
    const contents = mainWindowRef?.webContents;
    return (
      !!contents &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      !!trustedRendererUrlRef &&
      isTrustedRendererUrl(event.senderFrame.url, trustedRendererUrlRef) &&
      getShellReadiness(contents)?.loadId === loadId
    );
  });
  workspaceSync.startReplicaPublisher(() => mainWindowRef);
  workspaceSync.createRuntime(() => mainWindowRef);

  const replicaRecovery = await workspaceSync.recoverReplicaPullsBeforeRenderer();
  const { recoverNativeCatalogRecordsWithDatabaseFence } =
    await import('./native-catalog-record-mutations');
  const { withWorkspaceMutation } = await import('./workspace-sync-mutation-lease');
  const catalogRecoveryRoots = getDb()
    .prepare(
      `SELECT DISTINCT w.path FROM workspaces w JOIN native_catalog_publication_outbox o ON o.workspace_id = w.id`
    )
    .all() as Array<{ path: string }>;
  for (const { path: workspacePath } of catalogRecoveryRoots) {
    try {
      await withWorkspaceMutation(workspacePath, () =>
        recoverNativeCatalogRecordsWithDatabaseFence(getDb(), workspacePath)
      );
    } catch (error) {
      console.error('[NativeCatalog] pending record publication could not recover', {
        workspacePath,
        error,
      });
    }
  }
  if (
    replicaRecovery.recovered > 0 ||
    replicaRecovery.completed > 0 ||
    replicaRecovery.quarantined.length > 0
  ) {
    console.log('[WorkspaceSyncRuntime] pre-renderer replica recovery', replicaRecovery);
  }
  await fileAssociations.recoverPromotions();

  try {
    const trashPurge = await purgeExpiredTrashedWorkspaces(getDb(), managedRootDir());
    if (trashPurge.purged.length > 0) {
      console.log(`[main] Purged ${trashPurge.purged.length} expired trashed workspace(s).`);
    }
  } catch (error) {
    console.warn('[main] Trash purge on startup failed closed:', error);
  }
  await prepareMainFeatures(mainFeatureContext);
  workspaceSync.createActions((url) => shell.openExternal(url), mainFeatureContext.getMainWindow);
  workspaceSync.createOrganizationRegistry();
  registerAllIpcHandlers({
    googleSheetsTrustedRendererUrl: () => trustedRendererUrlRef,
    terminalTrustedRendererUrl: () => trustedRendererUrlRef,
    terminalIsPrimaryOwner: (id) => terminalPrimaryOwnerRef === id,
    terminalWindowPreload: () => ({
      preload: getWindowPreloadPath(),
      additionalArguments: getPreloadRuntimeArguments(),
    }),
    sendComputeJobTerminal: (event) => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        sendRendererIpc(mainWindowRef.webContents, 'compute:jobTerminal', event);
      }
    },
  });
  workspaceSync.subscribeAuth(() => mainFeaturesSignedIn(mainFeatureContext));
  workspaceSync.start();
  registerDirtyStateHandler(() => {
    workspaceSync.invalidateBoundWorkspaces('dirty_changed');
  });
  const mainWindow = await createWindow();
  mainWindowRef = mainWindow;
  startMainFeaturesWithWindow(mainWindow, mainFeatureContext);
  appendBootLog('main_window_created');

  if (!isQualificationEphemeralAuthEnabled()) {
    if (!isExplicitE2eTestRuntime(process.argv, process.env.WAYPOINT_TEST)) {
      registerProtocolScheme();
    }
  } else {
    (
      globalThis as typeof globalThis & {
        __dnaforgeQualificationProtocolRegistrationSkipped?: boolean;
      }
    ).__dnaforgeQualificationProtocolRegistrationSkipped = true;
  }
  void hydrateOnLaunch();
  protocolReady = true;
  for (const url of bufferedProtocolUrls.splice(0)) routeProtocolUrl(url);
  await startMainAgentTools({
    authority: sidecarSessionAuthority,
    getApiUrl,
    getBridge: () => agentToolsBridge.current(),
    startBridge: () => agentToolsBridge.start(mainWindow),
  });
  agentToolsBridge.installRendererPrompts(mainWindow);

  try {
    checkForVersionUpgrade(getDb());
  } catch (err) {
    console.error('[main] checkForVersionUpgrade failed:', err);
  }

  const workspaceArg = process.argv.find((a) => a.startsWith('--workspace='));
  if (workspaceArg) {
    const workspacePath = workspaceArg.slice('--workspace='.length);
    sendWorkspacePathToRenderer(mainWindow, workspacePath);
  }

  await nativeDocuments.start({ editingClient: 'renderer', canAssertNoEditingClient });

  startSidecar(mainWindow, agentToolsBridge.sidecarConnection());
  startMcpHttpServices();

  const allowPrerelease = readBetaUpdatesSetting(getDb());
  initAutoUpdater(mainWindow, { allowPrerelease, database: getDb() });

  trackAppSessionStarted();

  if (!app.isPackaged && process.env.NODE_ENV === 'test') {
    const { installMainTestBridge } = await import('./test-bridge');
    installMainTestBridge({
      getAgentToolsBridge: () => agentToolsBridge.current(),
      getWorkspaceSyncRuntime: () => workspaceSync.runtime(),
      getNativeDocumentRendererPublisher: () => nativeDocuments.rendererPublisher(),
    });
  }
}

export const productStartup = app
  .whenReady()
  .then(() => {
    if (process.platform === 'darwin') {
      setActiveFilesystemWorkGuard(() => {
        const id = powerSaveBlocker.start('prevent-app-suspension');
        return () => {
          powerSaveBlocker.stop(id);
        };
      });
    }
  })
  .then(init)
  .catch((err) => {
    console.error('[main] Startup error:', err);
    throw err;
  });

app.once('will-quit', () => {
  stopTerminalSessions();
  mainFeaturesWillQuit();
  assemblyAnnotationSceneResourceRegistry.dispose();
  disposeGenomeSearchQueryLifecycles();
  assemblyAnnotationSearchAuthority.dispose();
  assemblyProteinSearchAuthority.dispose();
  void disposeAssemblyAnnotationSearchQuerySessions();
  void disposeAssemblyProteinSearchQuerySessions();
});
configureUnsavedWorkSaver(
  createNativeDocumentQuitSaver({
    getMainWindow: () => mainWindowRef,
    nativeDocuments,
    isRendererAvailable,
    getDirtyState,
    readCurrentDirtyState,
    requestSaveAll,
  })
);
productQuit = createQuitPromptBinding({
  isSuppressed: () => quitPromptSuppressed(app.isPackaged, process.env.WAYPOINT_TEST),
  isCutoverBuild: isMacTeamIdCutoverBuild,
  getDirty: getDirtyState,
  readDirty: readCurrentDirtyState,
  isUpdateStaged: isUpdateDownloaded,
  hasConsent: hasQuitConsent,
  grantConsent: setQuitConsentGranted,
  showDialog: (win, opts) => showUnsavedWorkDialog(win as BrowserWindow | null, opts),
  getWindow: () => mainWindowRef,
  onQuitSettled: (result) => {
    if (result.cancelled) return;
    agentToolsBridge.close();
  },
  onQuitFailed: (err) => {
    console.error('[main] before-quit orchestration failed:', err);
    app.quit();
  },
  runQuit: (controls) =>
    handleBeforeQuit({
      mainWindow: mainWindowRef,
      freezeRenderer: controls.freezeRenderer,
      restoreRenderer: controls.restoreRenderer,
      concealRenderer: controls.concealRenderer,
      showUpdateStatus: showMacUpdateStatus,
      killSidecar: async () => {
        await killSidecar();
      },
      closeDatabase: async () => {
        await runShutdownSteps([
          {
            name: 'native terminal sessions',
            run: async () => {
              appendBootLog('quit_terminals_start');
              try {
                await shutdownTerminalSessions();
                appendBootLog('quit_terminals_complete');
              } catch (error) {
                appendBootLog('quit_terminals_failed');
                throw error;
              }
            },
          },
          {
            name: 'native document server and startup recovery',
            run: () => nativeDocuments.closeServerAndRecovery(),
          },
          {
            name: 'native document command server detach',
            run: () => nativeDocuments.detachCommandServer(),
          },
          { name: 'remote genomics runtime', run: () => remoteGenomicsRuntime.stopAll() },
          { name: 'remote endpoint explorer', run: () => remoteEndpointExplorer.stopAll() },
          ...mainFeatureShutdownSteps(),
          { name: 'git read requests', run: shutdownGitReadRequests },
          { name: 'hosted AI gateway', run: shutdownHostedAiGatewayHandlers },
          {
            name: 'native document renderer publisher',
            run: () => nativeDocuments.stopRendererPublisher(),
          },
          { name: 'workspace sync runtime', run: () => workspaceSync.stop() },
          { name: 'database', run: closeDatabase },
        ]);
      },
      trackAppClosed,
      shutdownAnalytics,
      quitApp: () => app.quit(),
      requestSaveAll,
    }),
});

app.on('before-quit', (event) => {
  if (!productQuit) {
    throw new Error('Quit prompt was used before it was installed.');
  }
  productQuit.onBeforeQuit(event);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (managedRuntimeLaunch || schemaUpdateRecoveryInProgress) return;
  void productStartup
    .then(async () => {
      if (managedRuntimeLaunch || schemaUpdateRecoveryInProgress) return;
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    })
    .catch((error) => {
      console.error('[main] Failed to recreate renderer window:', error);
      if (BrowserWindow.getAllWindows().length === 0) {
        reportBootOrCrashFailure('renderer_recreate_failed', 'boot_failure', String(error));
      }
    });
});
