import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  updaterEvents: new Map<string, (...args: unknown[]) => void>(),
  nativeUpdaterEvents: new Map<string, () => void>(),
  appEvents: new Map<string, (...args: unknown[]) => void>(),
  idleSeconds: 0,
  userData: '',
  quit: vi.fn(),
  track: vi.fn(),
  readDirty: vi.fn(),
  dialog: vi.fn().mockResolvedValue('cancel'),
  autoUpdater: {
    checkForUpdates: vi.fn().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: vi.fn(),
    isUserWithinRollout: vi.fn().mockResolvedValue(true),
    autoDownload: true,
    autoInstallOnAppQuit: false,
  },
}));

vi.mock('electron-updater', () => ({ default: { autoUpdater: state.autoUpdater } }));
vi.mock('electron', () => ({
  autoUpdater: {
    on: (event: string, listener: () => void) => state.nativeUpdaterEvents.set(event, listener),
    removeListener: (event: string, listener: () => void) => {
      if (state.nativeUpdaterEvents.get(event) === listener)
        state.nativeUpdaterEvents.delete(event);
    },
    checkForUpdates: vi.fn(),
  },
  app: {
    getVersion: () => '2.0.0',
    getName: () => 'DNAForge',
    getPath: () => state.userData,
    isPackaged: true,
    on: (event: string, listener: (...args: unknown[]) => void) =>
      state.appEvents.set(event, listener),
    quit: () => state.quit(),
    relaunch: vi.fn(),
  },
  powerMonitor: { getSystemIdleTime: () => state.idleSeconds },
  net: { isOnline: () => true },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('../analytics', () => ({
  trackEvent: (...args: unknown[]) => state.track(...args),
  captureOptionalTelemetryOrigin: () => null,
  enqueueOptionalAnalyticsEvent: () => false,
  enqueueOptionalAnalyticsEventFromReceipt: () => false,
}));
vi.mock('../dirty-state-cache', () => ({ readCurrentDirtyState: () => state.readDirty() }));
vi.mock('../quit-consent', () => ({
  setQuitConsentGranted: vi.fn(),
  resetQuitConsent: vi.fn(),
  hasQuitConsent: () => false,
  shouldSuppressBlockingDialogs: () => false,
  showUnsavedWorkDialog: (...args: unknown[]) => state.dialog(...args),
}));

const minute = 60_000;
const hour = 60 * minute;
const candidate = {
  version: '2.1.0',
  files: [{ url: 'controlled.zip', sha512: 'controlled-digest', size: 128 }],
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
  state.userData = mkdtempSync(join(tmpdir(), 'dna-4029-'));
  state.idleSeconds = 0;
  state.updaterEvents.clear();
  state.nativeUpdaterEvents.clear();
  state.appEvents.clear();
  state.readDirty.mockReset().mockResolvedValue({ hasDirtyWork: false, details: '' });
  state.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null);
  state.autoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(true);
  state.autoUpdater.on.mockImplementation(
    (event: string, listener: (...args: unknown[]) => void) => {
      state.updaterEvents.set(event, listener);
    }
  );
});

afterEach(() => {
  state.appEvents.get('will-quit')?.();
  vi.useRealTimers();
  rmSync(state.userData, { recursive: true, force: true });
});

async function downloadedApp() {
  const updater = await import('../auto-updater');
  const { handleBeforeQuit } = await import('../quit-orchestration');
  const window = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  state.quit.mockImplementation(() => {
    void handleBeforeQuit({
      mainWindow: window as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: vi.fn(),
      requestSaveAll: vi.fn(),
    });
  });
  updater.initAutoUpdater(window as never);
  state.updaterEvents.get('update-available')!(candidate);
  state.updaterEvents.get('update-downloaded')!(candidate);
  if (process.platform === 'darwin') {
    const nativePrepared = state.nativeUpdaterEvents.get('update-downloaded');
    expect(nativePrepared).toBeTypeOf('function');
    nativePrepared?.();
  }
  return window;
}

describe(' downloaded update liveness', () => {
  it('installs exactly once after 25 hours when idle for 31 minutes with no dirty work', async () => {
    await downloadedApp();
    state.idleSeconds = 31 * 60;
    await vi.advanceTimersByTimeAsync(25 * hour);
    expect(state.autoUpdater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
    await vi.advanceTimersByTimeAsync(hour);
    expect(state.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it.each([
    { dirty: true, idleMinutes: 31 },
    { dirty: false, idleMinutes: 29 },
    { dirty: false, idleMinutes: 30 },
  ])(
    'does not install with dirty=$dirty and idle=$idleMinutes minutes',
    async ({ dirty, idleMinutes }) => {
      await downloadedApp();
      state.idleSeconds = idleMinutes * 60;
      state.readDirty.mockResolvedValue({
        hasDirtyWork: dirty,
        details: dirty ? 'Unsaved sequence' : '',
      });
      await vi.advanceTimersByTimeAsync(25 * hour);
      expect(state.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(state.quit).not.toHaveBeenCalled();
      expect(state.dialog).not.toHaveBeenCalled();
    }
  );

  it('does not install before the download has waited more than 24 hours', async () => {
    await downloadedApp();
    state.idleSeconds = 31 * 60;
    await vi.advanceTimersByTimeAsync(24 * hour);
    expect(state.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not restart when activity resumes while dirty state is being refreshed', async () => {
    await downloadedApp();
    state.idleSeconds = 31 * 60;
    state.readDirty.mockImplementation(async () => {
      state.idleSeconds = 0;
      return { hasDirtyWork: false, details: '' };
    });
    await vi.advanceTimersByTimeAsync(25 * hour);
    expect(state.quit).not.toHaveBeenCalled();
    expect(state.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('ten scheduled checks while downloaded emit no extra available or downloaded events', async () => {
    await downloadedApp();
    state.track.mockClear();
    state.autoUpdater.checkForUpdates.mockImplementation(async () => {
      state.updaterEvents.get('update-available')!(candidate);
      state.updaterEvents.get('update-downloaded')!(candidate);
      return null;
    });
    await vi.advanceTimersByTimeAsync(30_000 + 9 * 10 * minute);
    expect(state.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(
      state.track.mock.calls.filter(
        ([name]) => name === 'app_update_available' || name === 'app_update_downloaded'
      )
    ).toHaveLength(0);
  });
});
