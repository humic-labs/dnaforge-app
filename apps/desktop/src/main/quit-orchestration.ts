import { app, type BrowserWindow } from 'electron';
import { readCurrentDirtyState } from './dirty-state-cache';
import { appendBootLog } from './boot-log';
import {
  readUpdateInstallCandidate,
  hasStartedMacUpdatePreparation,
  quitAndInstall,
  prepareUpdateInstallIntent,
  recordUpdateInstallOutcome,
  refuseUpdateRestartAfterShutdownFailure,
  restoreDownloadedUpdateAfterQuitCancellation,
} from './auto-updater';
import {
  hasQuitConsent,
  resetQuitConsent,
  setQuitConsentGranted,
  shouldSuppressBlockingDialogs,
  showUnsavedWorkDialog,
} from './quit-consent';

export {
  hasQuitConsent,
  resetQuitConsent,
  setQuitConsentGranted,
  showUnsavedWorkDialog,
} from './quit-consent';

export interface BeforeQuitDeps {
  mainWindow: BrowserWindow | null;
  freezeRenderer: () => void;
  restoreRenderer: () => void;

  concealRenderer?: () => void;
  killSidecar: () => void | Promise<void>;
  closeDatabase: () => void | Promise<void>;
  trackAppClosed: () => void;
  shutdownAnalytics: () => Promise<void>;
  quitApp: () => void;
  requestSaveAll: (win: BrowserWindow) => Promise<void>;

  relaunchApp?: () => void;
  installDownloadedUpdate?: typeof quitAndInstall;
  showUpdateStatus?: (version: string) => Promise<() => void>;
}

export async function handleBeforeQuit(deps: BeforeQuitDeps): Promise<{ cancelled: boolean }> {
  let stopUpdateStatus: (() => void) | undefined;
  let sidecarStopped = false;
  let installPrepared = false;
  const candidate = readUpdateInstallCandidate();
  try {
    deps.freezeRenderer();

    if (!hasQuitConsent() && !shouldSuppressBlockingDialogs()) {
      const dirty = await readCurrentDirtyState();
      if (dirty.hasDirtyWork) {
        const decision = await showUnsavedWorkDialog(deps.mainWindow, {
          staged: candidate !== null,
          details: dirty.details,
        });
        if (decision === 'cancel') {
          restoreDownloadedUpdateAfterQuitCancellation();
          deps.restoreRenderer();
          return { cancelled: true };
        }
        setQuitConsentGranted();
      }
    }

    if (candidate) {
      const intent = prepareUpdateInstallIntent(candidate);
      if (intent.status === 'failed') {
        restoreDownloadedUpdateAfterQuitCancellation();
        deps.restoreRenderer();
        return { cancelled: true };
      }
      installPrepared = true;
      stopUpdateStatus = await deps.showUpdateStatus?.(candidate.version);
    }
    deps.concealRenderer?.();

    let sidecarShutdownFailed = false;
    try {
      appendBootLog('quit_sidecar_start');
      await deps.killSidecar();
      sidecarStopped = true;
      appendBootLog('quit_sidecar_complete');
    } catch (err) {
      appendBootLog('quit_sidecar_failed');
      if (hasStartedMacUpdatePreparation()) {
        stopUpdateStatus?.();
        refuseUpdateRestartAfterShutdownFailure(err);
        deps.restoreRenderer();
        return { cancelled: true };
      }

      console.error('[main] sidecar shutdown failed during before-quit:', err);
      sidecarShutdownFailed = true;
    }
    appendBootLog('quit_services_start');
    await deps.closeDatabase();
    appendBootLog('quit_services_complete');
    deps.trackAppClosed();

    if (installPrepared) {
      void deps.shutdownAnalytics();
      if (sidecarShutdownFailed) {
        recordUpdateInstallOutcome('failed', 'shutdown_failed');

        stopUpdateStatus?.();
        (deps.relaunchApp ?? (() => app.relaunch()))();
        deps.quitApp();
        return { cancelled: false };
      }
      const install = (deps.installDownloadedUpdate ?? quitAndInstall)();
      if (install.status === 'failed') {
        stopUpdateStatus?.();
        (deps.relaunchApp ?? (() => app.relaunch()))();
        deps.quitApp();
      }
    } else {
      appendBootLog('quit_analytics_start');
      await deps.shutdownAnalytics();
      appendBootLog('quit_analytics_complete');
      deps.quitApp();
    }

    return { cancelled: false };
  } catch (err) {
    console.error('[main] before-quit handler errored:', err);
    if (sidecarStopped) {
      if (installPrepared) {
        appendBootLog('update_restart_recovered_after_teardown_error');
        const install = (deps.installDownloadedUpdate ?? quitAndInstall)();
        if (install.status === 'started') return { cancelled: false };
        stopUpdateStatus?.();
        (deps.relaunchApp ?? (() => app.relaunch()))();
      }
      deps.quitApp();
      return { cancelled: false };
    }
    stopUpdateStatus?.();
    if (hasStartedMacUpdatePreparation()) {
      refuseUpdateRestartAfterShutdownFailure(err);
      deps.restoreRenderer();
      return { cancelled: true };
    }

    try {
      deps.quitApp();
    } catch {}
    return { cancelled: false };
  } finally {
    resetQuitConsent();
  }
}
