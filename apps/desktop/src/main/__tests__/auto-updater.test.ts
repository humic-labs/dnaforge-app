import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const userDataRoot = vi.hoisted(() => ({ value: '' }));
const appIdentityName = vi.hoisted(() => ({ value: 'DNAForge' }));
const quitApp = vi.hoisted(() => vi.fn());
const appEvents = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());

const mockAutoUpdater = {
  emit: vi.fn(),
  checkForUpdates: vi.fn().mockResolvedValue(null),
  downloadUpdate: vi.fn().mockResolvedValue([]),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  setFeedURL: vi.fn(),
  isUserWithinRollout: vi.fn().mockResolvedValue(true),
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  allowDowngrade: false,
  disableWebInstaller: false,
};

vi.mock('electron-updater', () => ({
  default: { autoUpdater: mockAutoUpdater },
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getName: () => appIdentityName.value,
    getPath: () => userDataRoot.value,
    isPackaged: true,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      appEvents.set(event, listener);
    }),
    quit: quitApp,
  },
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn(),
    showErrorBox: vi.fn(),
  },
}));

vi.mock('../analytics', () => ({
  trackEvent: vi.fn(),
  captureOptionalTelemetryOrigin: () => null,
  enqueueOptionalAnalyticsEvent: () => false,
  enqueueOptionalAnalyticsEventFromReceipt: () => false,
}));

describe('auto-updater', () => {
  beforeEach(() => {
    userDataRoot.value = mkdtempSync(join(tmpdir(), 'dnaforge-updater-'));
    appIdentityName.value = 'DNAForge';
    vi.clearAllMocks();
    vi.resetModules();
    appEvents.clear();
    mockAutoUpdater.checkForUpdates.mockReset().mockResolvedValue(null);
    mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(true);
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = true;
    mockAutoUpdater.allowPrerelease = false;
    mockAutoUpdater.allowDowngrade = false;
    mockAutoUpdater.disableWebInstaller = false;
  });

  afterEach(() => {
    if (userDataRoot.value) rmSync(userDataRoot.value, { recursive: true, force: true });
  });

  it('delivers the synthetic download after the active SQLite query returns', async () => {
    const { _emitUpdateDownloadedForTest } = await import('../auto-updater');
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE receipts (version TEXT NOT NULL)');
      const info = {
        version: '2.0.0',
        releaseDate: '2026-01-01T00:00:00.000Z',
        path: 'fixture.AppImage',
        sha512: 'fixture',
        files: [{ url: 'fixture.AppImage', sha512: 'fixture' }],
        downloadedFile: 'fixture.AppImage',
      };
      mockAutoUpdater.emit.mockImplementationOnce((_event, received: typeof info) => {
        database.prepare('INSERT INTO receipts VALUES (?)').run(received.version);
        return true;
      });
      let completion: ReturnType<typeof _emitUpdateDownloadedForTest> | undefined;
      database.function('complete_download', () => {
        completion = _emitUpdateDownloadedForTest(info);
        return 1;
      });

      expect(database.prepare('SELECT complete_download() AS queued').get()).toEqual({
        queued: 1,
      });
      expect(mockAutoUpdater.emit).not.toHaveBeenCalled();
      await completion;
      expect(mockAutoUpdater.emit).toHaveBeenCalledExactlyOnceWith('update-downloaded', info);
      expect(database.prepare('SELECT version FROM receipts').all()).toEqual([
        { version: '2.0.0' },
      ]);
    } finally {
      database.close();
    }
  });

  it('should register event handlers and schedule delayed update check', async () => {
    vi.useFakeTimers();
    const { autoUpdater } = await import('electron-updater');
    const { initAutoUpdater } = await import('../auto-updater');
    const mockWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any;

    initAutoUpdater(mockWindow);

    expect(autoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function));

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('cancels the delayed check when shutdown starts before the initial timer', async () => {
    vi.useFakeTimers();
    const { autoUpdater } = await import('electron-updater');
    const { initAutoUpdater } = await import('../auto-updater');
    const mockWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any;

    initAutoUpdater(mockWindow);
    const willQuit = appEvents.get('will-quit');
    expect(willQuit).toEqual(expect.any(Function));
    expect(appEvents.has('before-quit')).toBe(false);
    willQuit?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should configure autoDownload=true and autoInstallOnAppQuit=false', async () => {
    const { autoUpdater } = await import('electron-updater');
    const { initAutoUpdater } = await import('../auto-updater');
    const mockWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any;

    initAutoUpdater(mockWindow);

    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  describe('exact CI rollout admission', () => {
    const rolloutId = '550e8400-e29b-41d4-a716-446655440000';
    const rolloutIdSha256 = createHash('sha256').update(rolloutId, 'utf8').digest('hex');
    const baseUpdateInfo = {
      version: '1.0.1',
      files: [{ url: 'DNAForge-1.0.1.zip', sha512: 'candidate-sha512' }],
      path: 'DNAForge-1.0.1.zip',
      sha512: 'candidate-sha512',
      releaseDate: '2026-08-29T00:00:00.000Z',
    };

    it('admits only the exact manifest hash of the durable app-owned install ID', async () => {
      writeFileSync(join(userDataRoot.value, 'install-id'), `${rolloutId}\n`, { mode: 0o600 });
      mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(false);
      const libraryRolloutDecision = mockAutoUpdater.isUserWithinRollout;
      const { autoUpdater } = await import('electron-updater');
      const { initAutoUpdater } = await import('../auto-updater');

      initAutoUpdater({ webContents: { send: vi.fn() }, isDestroyed: () => false } as never);
      const updateInfo = {
        ...baseUpdateInfo,
        dnaforgeCiRolloutIdSha256: rolloutIdSha256,
      };

      await expect(autoUpdater.isUserWithinRollout(updateInfo)).resolves.toBe(true);
      expect(libraryRolloutDecision).not.toHaveBeenCalled();
    });

    it('rejects a nonmatching exact cohort even when library staging would admit it', async () => {
      writeFileSync(join(userDataRoot.value, 'install-id'), rolloutId, { mode: 0o600 });
      mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(true);
      const libraryRolloutDecision = mockAutoUpdater.isUserWithinRollout;
      const { autoUpdater } = await import('electron-updater');
      const { initAutoUpdater } = await import('../auto-updater');

      initAutoUpdater({ webContents: { send: vi.fn() }, isDestroyed: () => false } as never);
      const updateInfo = {
        ...baseUpdateInfo,
        dnaforgeCiRolloutIdSha256: '0'.repeat(64),
      };

      await expect(autoUpdater.isUserWithinRollout(updateInfo)).resolves.toBe(false);
      expect(libraryRolloutDecision).not.toHaveBeenCalled();
    });

    it.each([
      null,
      true,
      42,
      {},
      [],
      '',
      'a'.repeat(63),
      'g'.repeat(64),
      'A'.repeat(64),
      `sha256:${'a'.repeat(64)}`,
      `${'a'.repeat(64)}\n`,
    ])('fails closed for malformed exact-cohort field %j', async (malformed) => {
      writeFileSync(join(userDataRoot.value, 'install-id'), rolloutId, { mode: 0o600 });
      mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(true);
      const libraryRolloutDecision = mockAutoUpdater.isUserWithinRollout;
      const { autoUpdater } = await import('electron-updater');
      const { initAutoUpdater } = await import('../auto-updater');

      initAutoUpdater({ webContents: { send: vi.fn() }, isDestroyed: () => false } as never);
      const updateInfo = {
        ...baseUpdateInfo,
        dnaforgeCiRolloutIdSha256: malformed,
      };

      await expect(autoUpdater.isUserWithinRollout(updateInfo)).resolves.toBe(false);
      expect(libraryRolloutDecision).not.toHaveBeenCalled();
    });

    it('delegates an absent DNAForge field to electron-updater stagingPercentage behavior', async () => {
      mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(false);
      const libraryRolloutDecision = mockAutoUpdater.isUserWithinRollout;
      const { autoUpdater } = await import('electron-updater');
      const { initAutoUpdater } = await import('../auto-updater');
      const updateInfo = { ...baseUpdateInfo, stagingPercentage: 17 };

      initAutoUpdater({ webContents: { send: vi.fn() }, isDestroyed: () => false } as never);

      await expect(autoUpdater.isUserWithinRollout(updateInfo)).resolves.toBe(false);
      expect(libraryRolloutDecision).toHaveBeenCalledOnce();
      expect(libraryRolloutDecision).toHaveBeenCalledWith(updateInfo);
    });
  });

  describe('newer-schema startup recovery', () => {
    it('downloads a strictly newer stable candidate and invokes the normal durable native install', async () => {
      const order: string[] = [];
      mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(false);
      mockAutoUpdater.checkForUpdates.mockImplementationOnce(async () => {
        order.push('candidate-downloaded');
        return {
          isUpdateAvailable: true,
          updateInfo: {
            version: '1.0.1',
            files: [
              {
                url: 'DNAForge-1.0.1-arm64-mac.zip',
                sha512: 'candidate-sha512',
                size: 1234,
              },
            ],
          },
          downloadPromise: Promise.resolve(['/tmp/DNAForge-1.0.1-arm64-mac.zip']),
        };
      });
      const { SchemaVersionTooNewError } = await import('../native-module-error');
      const { startSchemaUpdateRecovery } = await import('../auto-updater');

      await expect(
        startSchemaUpdateRecovery({
          error: new SchemaVersionTooNewError({
            dbVersion: 34,
            supportedVersion: 33,
            appVersion: '1.0.0',
          }),
          closeDatabase: () => order.push('database-closed'),
          flushFatalDiagnostics: async () => {
            order.push('diagnostics-flushed');
          },
          openCurrentInstaller: vi.fn(),
        })
      ).resolves.toEqual({ kind: 'install-started', targetVersion: '1.0.1' });

      expect(order).toEqual(['database-closed', 'diagnostics-flushed', 'candidate-downloaded']);
      expect(mockAutoUpdater.autoDownload).toBe(true);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
      expect(mockAutoUpdater.allowPrerelease).toBe(false);
      expect(mockAutoUpdater.allowDowngrade).toBe(false);
      expect(mockAutoUpdater.disableWebInstaller).toBe(true);
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
      expect(
        JSON.parse(readFileSync(join(userDataRoot.value, 'update-install-intent.json'), 'utf8'))
      ).toMatchObject({
        fromVersion: '1.0.0',
        targetVersion: '1.0.1',
        attemptedAt: expect.any(Number),
      });

      await expect(
        mockAutoUpdater.isUserWithinRollout({ version: '1.0.1', stagingPercentage: 1 })
      ).resolves.toBe(true);
      await expect(
        mockAutoUpdater.isUserWithinRollout({
          version: '1.0.1',
          dnaforgeCiRolloutIdSha256: '0'.repeat(64),
        })
      ).resolves.toBe(false);
    });

    it('returns installer fallback without native install when the stable feed has no update', async () => {
      mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: false,
        updateInfo: { version: '1.0.0', files: [] },
      });
      const { SchemaVersionTooNewError } = await import('../native-module-error');
      const { startSchemaUpdateRecovery } = await import('../auto-updater');

      await expect(
        startSchemaUpdateRecovery({
          error: new SchemaVersionTooNewError({
            dbVersion: 34,
            supportedVersion: 33,
            appVersion: '1.0.0',
          }),
          closeDatabase: vi.fn(),
          flushFatalDiagnostics: vi.fn(async () => undefined),
          openCurrentInstaller: vi.fn(),
        })
      ).resolves.toEqual({ kind: 'fallback-required', reason: 'no-update' });

      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);
      expect(mockAutoUpdater.removeListener).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('opens the current installer once if native replacement fails after handoff', async () => {
      mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: {
          version: '1.0.1',
          files: [{ url: 'DNAForge-1.0.1-arm64-mac.zip', sha512: 'candidate-sha512' }],
        },
        downloadPromise: Promise.resolve(['/tmp/DNAForge-1.0.1-arm64-mac.zip']),
      });
      const openCurrentInstaller = vi.fn();
      const { SchemaVersionTooNewError } = await import('../native-module-error');
      const { startSchemaUpdateRecovery } = await import('../auto-updater');

      await startSchemaUpdateRecovery({
        error: new SchemaVersionTooNewError({
          dbVersion: 34,
          supportedVersion: 33,
          appVersion: '1.0.0',
        }),
        closeDatabase: vi.fn(),
        flushFatalDiagnostics: vi.fn(async () => undefined),
        openCurrentInstaller,
      });
      const installErrorListener = mockAutoUpdater.on.mock.calls.find(
        ([event]) => event === 'error'
      )?.[1] as ((error: Error) => void) | undefined;
      expect(installErrorListener).toEqual(expect.any(Function));

      installErrorListener!(new Error('native replacement failed'));
      installErrorListener!(new Error('duplicate provider event'));

      expect(openCurrentInstaller).toHaveBeenCalledOnce();
      expect(quitApp).toHaveBeenCalledOnce();
    });
  });

  it('keeps the signed validation application updater-inert with a clean environment', async () => {
    vi.useFakeTimers();
    appIdentityName.value = 'DNAForge Validation';
    const { autoUpdater } = await import('electron-updater');
    const { initAutoUpdater } = await import('../auto-updater');
    const mockWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any;

    initAutoUpdater(mockWindow);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps a community build updater-inert and its schema recovery offline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
    try {
      const { autoUpdater } = await import('electron-updater');
      const { initAutoUpdater, openInstallerDownloadPage, startSchemaUpdateRecovery } =
        await import('../auto-updater');
      initAutoUpdater({ webContents: { send: vi.fn() }, isDestroyed: () => false } as never);
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      const openCurrentInstaller = vi.fn();
      const closeDatabase = vi.fn();
      const recovery = await startSchemaUpdateRecovery({
        error: { dbVersion: 99, supportedVersion: 1, appVersion: '1.0.0' },
        closeDatabase,
        flushFatalDiagnostics: async () => undefined,
        openCurrentInstaller,
      } as never);

      expect(recovery).toEqual({ kind: 'fallback-required', reason: 'no-update' });
      const openDownloadPage = vi.fn();
      openInstallerDownloadPage(openDownloadPage);
      expect(openDownloadPage).not.toHaveBeenCalled();
      vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
      openInstallerDownloadPage(openDownloadPage);
      expect(openDownloadPage).toHaveBeenCalledWith('https://dnaforge.com/download');
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(openCurrentInstaller).not.toHaveBeenCalled();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
      vi.useRealTimers();
    }
  });

  it('should skip in dev mode', async () => {
    vi.doMock('electron', () => ({
      app: {
        getVersion: () => '1.0.0',
        getPath: () => userDataRoot.value,
        isPackaged: false,
        on: vi.fn(),
        quit: quitApp,
      },
      BrowserWindow: vi.fn(),
      ipcMain: {
        on: vi.fn(),
        handle: vi.fn(),
        once: vi.fn(),
        removeHandler: vi.fn(),
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      dialog: {
        showMessageBox: vi.fn(),
        showErrorBox: vi.fn(),
      },
    }));

    const { autoUpdater } = await import('electron-updater');
    const { initAutoUpdater } = await import('../auto-updater');
    const mockWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any;

    initAutoUpdater(mockWindow);

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('disables Squirrel.Mac only for a flagged Team ID cutover build', async () => {
    const { shouldDisableAutoUpdaterForMacTeamIdCutover } = await import('../auto-updater');

    expect(
      shouldDisableAutoUpdaterForMacTeamIdCutover({
        macTeamIdCutoverEnabled: true,
        platform: 'darwin',
      })
    ).toBe(true);
    expect(
      shouldDisableAutoUpdaterForMacTeamIdCutover({
        macTeamIdCutoverEnabled: false,
        platform: 'darwin',
      })
    ).toBe(false);
    expect(
      shouldDisableAutoUpdaterForMacTeamIdCutover({
        macTeamIdCutoverEnabled: true,
        platform: 'win32',
      })
    ).toBe(false);
  });

  it('installUpdate should request ordinary quit before native installation when no dirty work', async () => {
    const { autoUpdater } = await import('electron-updater');
    const { installUpdate, _setUpdateDownloadedForTest, _setMainWindowForTest } =
      await import('../auto-updater');
    const { setDirtyState } = await import('../dirty-state-cache');
    setDirtyState({ hasDirtyWork: false, details: '' });
    _setUpdateDownloadedForTest(true);
    _setMainWindowForTest({
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
    } as any);

    await installUpdate();

    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
