// @vitest-environment node
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bootLog = vi.hoisted(() => ({ append: vi.fn() }));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../boot-log', () => ({ appendBootLog: bootLog.append }));
vi.mock('./startup-phases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./startup-phases')>()),
  enforcesStartupPhases: () => true,
}));
vi.mock('./remote-hosts', () => ({ remoteHostsFeature: { id: 'remote-hosts' } }));
vi.mock('./reference-assets', () => ({ referenceAssetsFeature: { id: 'reference-assets' } }));
vi.mock('./external-agent-tools', () => ({
  externalAgentToolsFeature: { id: 'external-agent-tools' },
}));
vi.mock('./track-store', () => ({ trackStoreFeature: { id: 'track-store' } }));
vi.mock('./benchling-migration', () => ({
  benchlingMigrationFeature: { id: 'benchling-migration' },
}));
vi.mock('./auth', () => ({ authFeature: { id: 'auth' } }));
vi.mock('./memory-pressure', () => ({ memoryPressureFeature: { id: 'memory-pressure' } }));
vi.mock('./beta-attribution', () => ({ betaAttributionFeature: { id: 'beta-attribution' } }));
vi.mock('./share-links', () => ({ shareLinksFeature: { id: 'share-links' } }));
vi.mock('./native-documents', () => ({ nativeDocuments: {} }));
vi.mock('./agent-tools-bridge', () => ({ agentToolsBridge: {} }));
vi.mock('./mcp-http', () => ({ startMcpHttpServices: () => undefined }));
vi.mock('./workspace-sync', () => ({ workspaceSync: {} }));
vi.mock('./file-associations', () => ({
  fileAssociations: {},
  fileAssociationsFeature: { id: 'file-associations' },
}));

const NO_WINDOW = { getMainWindow: () => null };

beforeEach(() => {
  vi.resetModules();
  bootLog.append.mockClear();
  vi.stubEnv('DNAFORGE_BACKGROUND_LAUNCH_SAFE', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('main process startup phase wiring', () => {
  it('REJECTS loading the feature list before background-launch-cwd, naming the phase order', async () => {
    await expect(import('.')).rejects.toThrow(
      'Startup phase "features-loaded" ran out of order. Phases must run as working-directory → features-loaded → features-prepared → feature-ipc-registered → main-window-ready; reached so far: none.'
    );
  });

  it('writes each startup phase to the boot log once background-launch-cwd runs first', async () => {
    await import('../background-launch-cwd');
    const features = await import('.');

    await features.prepareMainFeatures(NO_WINDOW, []);
    features.registerMainFeatureIpc([]);
    expect(bootLog.append).toHaveBeenLastCalledWith(
      'startup_phases working-directory features-loaded features-prepared feature-ipc-registered'
    );

    features.startMainFeaturesWithWindow({} as BrowserWindow, NO_WINDOW, []);
    expect(bootLog.append).toHaveBeenLastCalledWith(
      'startup_phases working-directory features-loaded features-prepared feature-ipc-registered main-window-ready'
    );
    expect(bootLog.append).toHaveBeenCalledTimes(2);
  });
});
