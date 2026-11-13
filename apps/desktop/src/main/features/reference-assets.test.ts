// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  registerHandlers: vi.fn(),
  explicitE2e: { value: false },
  retention: {
    start: vi.fn(() => calls.push('retention.start')),
    checkpoint: vi.fn(async () => {
      calls.push('retention.checkpoint');
    }),
    stop: vi.fn(async () => undefined),
    pinOpening: vi.fn(async () => undefined),
    collect: vi.fn(),
    retainPreparation: vi.fn(),
    setRendererVersions: vi.fn(),
    releaseRenderer: vi.fn(),
  },
  reconciler: { start: vi.fn(), stop: vi.fn() },
  gate: { dispose: vi.fn() },
  uninstallGate: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/paths/${name}`,
    getAppPath: () => '/app',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../shared/ipc-contract', () => ({ sendRendererIpc: vi.fn() }));
vi.mock('../config', () => ({ isExplicitE2eTestRuntime: () => mocks.explicitE2e.value }));
vi.mock('../ipc/genome-data', () => ({ activeGenomeReferencePaths: () => [] }));
vi.mock('../ipc/reference-assets', () => ({
  registerReferenceAssetIpcHandlers: mocks.registerHandlers,
}));
vi.mock('../reference-assets/bgzf-fasta-migration', () => ({
  setBgzfFastaMigrationIndexerBinary: vi.fn(),
}));
vi.mock('../reference-assets/hosted-reference-asset-authority', () => ({
  createHostedReferenceAssetAuthority: vi.fn(() => {
    calls.push('hosted-authority');
    return { listHosted: vi.fn(), installHosted: vi.fn() };
  }),
}));
vi.mock('../reference-assets/hosted-reference-catalog', () => ({
  DNAFORGE_HOSTED_REFERENCE_BASE_URL_ENV: 'BASE_URL',
  HOSTED_REFERENCE_CATALOG_V1: [],
}));
vi.mock('../reference-assets/hosted-reference-catalog-fixture', () => ({
  hostedReferenceCatalogForRuntime: async () => [{ id: 'grch38' }],
  HOSTED_REFERENCE_CATALOG_FIXTURE_ENV: 'FIXTURE',
}));
vi.mock('../reference-assets/hosted-reference-cache-reconciler', () => ({
  HostedReferenceCacheReconciler: vi.fn(() => mocks.reconciler),
  hostedReferenceCacheVersionsV1: () => ({}),
}));
vi.mock('../reference-assets/hosted-reference-transport', () => ({
  installHostedReferenceBodyReadGate: () => mocks.uninstallGate,
}));
vi.mock('../reference-assets/local-reference-asset-authority', () => ({
  createLocalReferenceAssetAuthority: () => ({ listLocal: vi.fn() }),
  resolveDnaIndexerHelperPath: () => '/bin/dna-indexer',
}));
vi.mock('../reference-assets/office-resources-download-gate', () => ({
  OfficeResourcesDownloadGate: vi.fn(() => mocks.gate),
}));
vi.mock('../reference-assets/portable-prepared-reference-view-authority', () => ({
  portablePreparedReferenceViewAuthorityV1: { releaseGeneration: vi.fn() },
}));
vi.mock('../reference-assets/reference-asset-cache-root', () => ({
  resolveReferenceAssetRootLayout: () => ({
    cacheRoot: '/cache',
    publicationRoot: '/publication',
    fallbackPublicationRoot: null,
  }),
}));
vi.mock('../reference-assets/reference-asset-writer-lock', () => ({
  acquireReferenceAssetWriterLock: vi.fn(),
}));
vi.mock('../reference-assets/reference-generation-retention', () => ({
  ReferenceGenerationRetention: vi.fn(() => mocks.retention),
}));

import type { BrowserWindow } from 'electron';
import { referenceAssetsFeature } from './reference-assets';

afterEach(() => {
  referenceAssetsFeature.willQuit?.();
  calls.length = 0;
  vi.clearAllMocks();
  mocks.explicitE2e.value = false;
});

describe('reference assets feature', () => {
  it('pins catalog versions before the hosted authority can install them', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    expect(calls).toEqual(['retention.start', 'retention.checkpoint', 'hosted-authority']);
  });

  it('registers reference asset IPC with the prepared authorities and pins opened generations', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.registerIpc?.();
    expect(mocks.registerHandlers).toHaveBeenCalledTimes(1);
    const deps = mocks.registerHandlers.mock.calls[0][0];
    expect(deps).toEqual(
      expect.objectContaining({ listLocal: expect.any(Function), listHosted: expect.any(Function) })
    );
    await deps.retainOpenedVersion('owner-1', {
      assetCacheKey: 'grch38',
      portableView: { generationRoot: '/cache/grch38/generations/gen-7' },
      members: [],
    });
    expect(mocks.retention.pinOpening).toHaveBeenCalledWith('owner-1', {
      catalogId: 'grch38',
      generationId: 'gen-7',
    });
  });

  it('registers nothing before it is prepared', () => {
    referenceAssetsFeature.registerIpc?.();
    expect(mocks.registerHandlers).not.toHaveBeenCalled();
  });

  it('starts the hosted cache reconciler once the window exists, except in E2E runs', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.onMainWindow?.({} as BrowserWindow, { getMainWindow: () => null });
    expect(mocks.reconciler.start).toHaveBeenCalledTimes(1);

    referenceAssetsFeature.willQuit?.();
    mocks.explicitE2e.value = true;
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.onMainWindow?.({} as BrowserWindow, { getMainWindow: () => null });
    expect(mocks.reconciler.start).toHaveBeenCalledTimes(1);
  });

  it('stops retention, the reconciler and the download gate at quit', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.onMainWindow?.({} as BrowserWindow, { getMainWindow: () => null });
    referenceAssetsFeature.willQuit?.();
    expect(mocks.retention.stop).toHaveBeenCalledTimes(1);
    expect(mocks.reconciler.stop).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallGate).toHaveBeenCalledTimes(1);
    expect(mocks.gate.dispose).toHaveBeenCalledTimes(1);
  });
});
