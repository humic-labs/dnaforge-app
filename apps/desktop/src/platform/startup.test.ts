import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridge: {
    config: { getApiUrl: vi.fn() },
    db: { select: vi.fn() },
    path: { appDataDir: vi.fn() },
    fs: { writeTextFile: vi.fn(), readFile: vi.fn(), readTextFile: vi.fn() },
  },
  configure: vi.fn(),
}));
vi.mock('./electron', () => ({ electronBridge: mocks.bridge }));
vi.mock('./browser-mock', () => ({ browserMockBridge: mocks.bridge }));
vi.mock('../services/service-manager', () => ({ serviceManager: { setBaseUrl: vi.fn() } }));
vi.mock('../services/sidecar-session', () => ({
  configureRendererSidecarApiClient: mocks.configure,
}));

describe('platform startup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.bridge.db.select.mockReset().mockResolvedValue([]);
    mocks.bridge.config.getApiUrl.mockResolvedValue('http://localhost:8123');
    mocks.bridge.path.appDataDir.mockResolvedValue('/isolated-profile');
    vi.stubGlobal('navigator', { userAgent: 'Chrome Electron/33' });
    vi.stubGlobal('window', { electronAPI: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects missing Electron preload instead of selecting the browser adapter', async () => {
    vi.stubGlobal('window', {});
    const { initPlatform } = await import('./index');
    await expect(initPlatform()).rejects.toThrow(/preload/i);
    expect(mocks.bridge.config.getApiUrl).not.toHaveBeenCalled();
  });

  it('keeps intentional browser development available', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { userAgent: 'Chrome' });
    const { initPlatform } = await import('./index');
    await expect(initPlatform()).resolves.toBe(mocks.bridge);
  });

  it('does not block the platform on optional native file warm-up', async () => {
    mocks.bridge.path.appDataDir.mockReturnValue(new Promise(() => {}));
    const { initPlatform } = await import('./index');
    await expect(initPlatform()).resolves.toBe(mocks.bridge);
  });

  it('shares essential initialization even after the adapter was selected', async () => {
    let resolveUrl!: (url: string) => void;
    mocks.bridge.config.getApiUrl.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveUrl = resolve;
      })
    );
    const { initPlatform, platform } = await import('./index');
    const first = initPlatform();
    await vi.waitFor(() => expect(mocks.bridge.config.getApiUrl).toHaveBeenCalledOnce());
    expect(() => platform()).toThrow('Platform not initialized');
    const second = initPlatform();
    expect(second).toBe(first);
    resolveUrl('http://localhost:8123');
    await second;
    expect(mocks.configure).toHaveBeenCalledWith('http://localhost:8123');
  });

  it('fails visibly when essential native configuration cannot be read', async () => {
    mocks.bridge.config.getApiUrl.mockRejectedValue(new Error('native configuration unavailable'));
    const { initPlatform } = await import('./index');
    await expect(initPlatform()).rejects.toThrow('native configuration unavailable');
  });

  it('finishes startup after replica finalization releases the policy read', async () => {
    mocks.bridge.db.select
      .mockRejectedValueOnce(
        new Error('WORKSPACE_SYNC_DATABASE_BUSY: a cloud replica is being finalized.')
      )
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'db:select': Error: WORKSPACE_SYNC_DATABASE_BUSY: a cloud replica is being finalized."
        )
      )
      .mockResolvedValue([{ value: JSON.stringify(['/retained-source/wp-assets']) }]);
    const { initPlatform, platform } = await import('./index');
    const { isDeveloperImportSourcePath } = await import('../shared/developer-import-sources');
    const initialized = initPlatform();
    expect(initPlatform()).toBe(initialized);
    await expect(initialized).resolves.toBe(mocks.bridge);
    expect(platform()).toBe(mocks.bridge);
    expect(isDeveloperImportSourcePath('/retained-source/wp-assets/record')).toBe(true);
    expect(mocks.bridge.config.getApiUrl).toHaveBeenCalledOnce();
    expect(mocks.bridge.db.select).toHaveBeenCalledTimes(3);
  });

  it('keeps a real policy read error fatal without publishing the platform', async () => {
    const failure = new Error('database policy read failed');
    mocks.bridge.db.select.mockRejectedValue(failure);
    const { initPlatform, platform } = await import('./index');
    await expect(initPlatform()).rejects.toBe(failure);
    expect(() => platform()).toThrow('Platform not initialized');
    expect(mocks.bridge.db.select).toHaveBeenCalledOnce();
    expect(mocks.bridge.config.getApiUrl).not.toHaveBeenCalled();
  });

  it('loads the durable import-source policy before publishing the desktop platform', async () => {
    let completeRead!: (rows: Array<{ value: string }>) => void;
    mocks.bridge.db.select.mockReturnValue(
      new Promise<Array<{ value: string }>>((resolve) => {
        completeRead = resolve;
      })
    );
    const { initPlatform, platform } = await import('./index');
    const { isDeveloperImportSourcePath } = await import('../shared/developer-import-sources');
    const initialized = initPlatform();
    await vi.waitFor(() => expect(mocks.bridge.db.select).toHaveBeenCalledOnce());
    expect(() => platform()).toThrow('Platform not initialized');
    completeRead([{ value: JSON.stringify(['/old-build/wp-assets']) }]);
    await initialized;
    expect(isDeveloperImportSourcePath('/old-build/wp-assets/pDEMO421')).toBe(true);
  });
});
