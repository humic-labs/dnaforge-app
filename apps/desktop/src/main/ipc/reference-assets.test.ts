import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL,
  REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
  REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL,
  REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL,
  REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL,
  REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL,
  REFERENCE_ASSET_LIST_HOSTED_CHANNEL,
  REFERENCE_ASSET_LIST_LOCAL_CHANNEL,
  REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
  REFERENCE_ASSET_RETRY_LOCAL_CHANNEL,
  type HostedReferenceCatalogEntryV1,
  type PreparedReferenceAssemblyEntryV1,
} from '../../shared/reference-assets-ipc';

const { handle, showOpenDialog, fromWebContents } = vi.hoisted(() => ({
  handle: vi.fn(),
  showOpenDialog: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  dialog: { showOpenDialog },
  BrowserWindow: { fromWebContents },
}));

import { registerReferenceAssetIpcHandlers } from './reference-assets';

const READY_ENTRY: PreparedReferenceAssemblyEntryV1 = {
  id: 'local-puc19',
  name: 'pUC19',
  organism: 'synthetic DNA construct',
  description: 'Imported reference',
  assetCacheKey: 'local-puc19',
  members: [
    {
      chrom: 'puc19',
      displayName: 'puc19',
      lengthBp: 2686,
      circular: true,
      manifest: {
        fastaPath: 'prepared/puc19/puc19.fa',
        faiPath: 'prepared/puc19/puc19.fa.fai',
        gffPath: 'prepared/puc19/puc19.gff3.gz',
        tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
      },
    },
  ],
};

function registeredHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = handle.mock.calls.find(([candidate]) => candidate === channel);
  if (!registration) throw new Error(`Missing IPC handler: ${channel}`);
  return registration[1];
}

describe('custom reference asset IPC bridge', () => {
  beforeEach(() => {
    handle.mockReset();
    showOpenDialog.mockReset();
    fromWebContents.mockReset();
  });

  it('owns one native source gesture and forwards the selected path for main-owned recognition', async () => {
    const sender = { send: vi.fn() };
    const win = {};
    fromWebContents.mockReturnValue(win);
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/source/pUC19-reference'],
    });
    const importLocal = vi.fn(async ({ onProgress }) => {
      onProgress({
        assemblyId: READY_ENTRY.id,
        phase: 'indexing-annotations',
        label: 'Indexing annotations',
        completed: 1,
        total: 2,
      });
      return READY_ENTRY;
    });
    registerReferenceAssetIpcHandlers({
      importLocal,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
      createOperationId: () => 'import-1',
    });

    const result = await registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
      { sender },
      { operationId: 'import-1', themeMode: 'dark' }
    );

    expect(showOpenDialog).toHaveBeenCalledOnce();
    expect(showOpenDialog).toHaveBeenCalledWith(win, {
      title: 'Add reference',
      properties: ['openFile', 'openDirectory'],
      filters: [
        {
          name: 'Reference sequence or NCBI package',
          extensions: ['fa', 'fasta', 'fna', 'ffn', 'frn', 'gz', 'zip'],
        },
      ],
    });
    expect(importLocal).toHaveBeenCalledWith({
      selection: {
        path: '/source/pUC19-reference',
      },
      themeMode: 'dark',
      onProgress: expect.any(Function),
    });
    expect(sender.send).toHaveBeenNthCalledWith(1, REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, {
      operationId: 'import-1',
      phase: 'sources-selected',
      label: 'Inspecting selected reference source',
    });
    expect(sender.send).toHaveBeenNthCalledWith(2, REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, {
      operationId: 'import-1',
      assemblyId: READY_ENTRY.id,
      phase: 'indexing-annotations',
      label: 'Indexing annotations',
      completed: 1,
      total: 2,
    });
    expect(result).toEqual({ status: 'ready', entry: READY_ENTRY });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('returns cancelled without invoking preparation when the user cancels', async () => {
    const sender = { send: vi.fn() };
    fromWebContents.mockReturnValue({});
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const importLocal = vi.fn();
    registerReferenceAssetIpcHandlers({
      importLocal,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
        { sender },
        { operationId: 'cancel-1', themeMode: 'light' }
      )
    ).resolves.toEqual({ status: 'cancelled' });
    expect(importLocal).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('uses the same native source dialog for an NCBI package', async () => {
    const sender = { send: vi.fn() };
    const win = {};
    fromWebContents.mockReturnValue(win);
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/source/arabidopsis.zip'],
    });
    const importLocal = vi.fn(async () => READY_ENTRY);
    registerReferenceAssetIpcHandlers({
      importLocal,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
      createOperationId: () => 'package-1',
    });

    await registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
      { sender },
      { operationId: 'package-1', themeMode: 'light' }
    );

    expect(showOpenDialog).toHaveBeenCalledWith(win, {
      title: 'Add reference',
      properties: ['openFile', 'openDirectory'],
      filters: [
        {
          name: 'Reference sequence or NCBI package',
          extensions: ['fa', 'fasta', 'fna', 'ffn', 'frn', 'gz', 'zip'],
        },
      ],
    });
    expect(importLocal).toHaveBeenCalledWith({
      selection: { path: '/source/arabidopsis.zip' },
      themeMode: 'light',
      onProgress: expect.any(Function),
    });
    expect(sender.send).toHaveBeenCalledWith(REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, {
      operationId: 'package-1',
      phase: 'sources-selected',
      label: 'Inspecting selected reference source',
    });
  });

  it('accepts one absolute dropped source path without opening another dialog', async () => {
    const sender = { send: vi.fn() };
    fromWebContents.mockReturnValue({});
    const importLocal = vi.fn(async () => READY_ENTRY);
    registerReferenceAssetIpcHandlers({
      importLocal,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    await registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
      { sender },
      {
        operationId: 'drop-1',
        themeMode: 'light',
        sourcePath: '/source/reference-folder',
      }
    );

    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(importLocal).toHaveBeenCalledWith({
      selection: { path: '/source/reference-folder' },
      themeMode: 'light',
      onProgress: expect.any(Function),
    });
  });

  it('imports a hub genome through the authority without any native dialog', async () => {
    const sender = { send: vi.fn() };
    fromWebContents.mockReturnValue({});
    const importHubGenome = vi.fn(async ({ onProgress }) => {
      onProgress({
        phase: 'downloading-hub-sequence',
        label: 'Downloading sacCer3',
        completed: 1,
        total: 4,
      });
      return READY_ENTRY;
    });
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      importHubGenome,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    const result = await registeredHandler(REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL)(
      { sender },
      {
        operationId: 'hub-1',
        themeMode: 'dark',
        provider: 'assembly-hub',
        hubUrl: ' https://hub.example.org/yeast/hub.txt ',
        genome: 'sacCer3',
        twoBitPath: 'sacCer3/sacCer3.2bit',
        organism: ' Saccharomyces cerevisiae ',
        assemblyName: '',
        taxId: 559292,
      }
    );

    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(importHubGenome).toHaveBeenCalledWith({
      source: {
        provider: 'assembly-hub',
        hubUrl: 'https://hub.example.org/yeast/hub.txt',
        genome: 'sacCer3',
        twoBitPath: 'sacCer3/sacCer3.2bit',
        organism: 'Saccharomyces cerevisiae',
        taxId: 559292,
      },
      themeMode: 'dark',
      onProgress: expect.any(Function),
    });
    expect(sender.send).toHaveBeenNthCalledWith(1, REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, {
      operationId: 'hub-1',
      phase: 'hub-genome-selected',
      label: 'Fetching sacCer3 from its hub',
    });
    expect(sender.send).toHaveBeenNthCalledWith(2, REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, {
      operationId: 'hub-1',
      phase: 'downloading-hub-sequence',
      label: 'Downloading sacCer3',
      completed: 1,
      total: 4,
    });
    expect(result).toEqual({ status: 'ready', entry: READY_ENTRY });
  });

  it('rejects malformed hub genome requests before touching the authority', async () => {
    const importHubGenome = vi.fn();
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      importHubGenome,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });
    const valid = {
      operationId: 'hub-2',
      themeMode: 'light',
      provider: 'genark',
      hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
      genome: 'GCF_000146045.2',
      twoBitPath: 'GCF_000146045.2.2bit',
    };
    const handler = registeredHandler(REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL);
    for (const request of [
      { ...valid, provider: 'ftp-mirror' },
      { ...valid, genome: '../escape' },
      { ...valid, hubUrl: '' },
      { ...valid, twoBitPath: 'x'.repeat(2049) },
      { ...valid, taxId: -1 },
      { ...valid, organism: 42 },
      { ...valid, operationId: 'has space' },
    ]) {
      await expect(handler({ sender: { send: vi.fn() } }, request)).rejects.toThrow(
        'Invalid hub genome import request.'
      );
    }
    expect(importHubGenome).not.toHaveBeenCalled();
  });

  it('rejects malformed renderer input before opening a native dialog', async () => {
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
        { sender: { send: vi.fn() } },
        { operationId: 'invalid-theme', themeMode: 'sepia' }
      )
    ).rejects.toThrow('Invalid custom reference import request');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('rejects a relative dropped source path before invoking preparation', async () => {
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
        { sender: { send: vi.fn() } },
        { operationId: 'invalid-path', themeMode: 'light', sourcePath: '../reference.fa' }
      )
    ).rejects.toThrow('Invalid custom reference import request');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('keeps preparation running when the initiating renderer is destroyed', async () => {
    const sender = {
      isDestroyed: vi.fn(() => true),
      send: vi.fn(() => {
        throw new Error('Object has been destroyed');
      }),
    };
    fromWebContents.mockReturnValue({});
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/source/pUC19-reference'],
    });
    const importLocal = vi.fn(async ({ onProgress }) => {
      onProgress({
        assemblyId: READY_ENTRY.id,
        phase: 'ready',
        label: 'pUC19 is ready',
        completed: 1,
        total: 1,
      });
      return READY_ENTRY;
    });
    registerReferenceAssetIpcHandlers({
      importLocal,
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL)(
        { sender },
        { operationId: 'destroyed-renderer', themeMode: 'light' }
      )
    ).resolves.toEqual({ status: 'ready', entry: READY_ENTRY });
    expect(importLocal).toHaveBeenCalledOnce();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('reconciles and retries local preparation through local-only IPC', async () => {
    const sender = { send: vi.fn() };
    const failedStatus = {
      assemblyId: READY_ENTRY.id,
      status: 'failed' as const,
      phase: 'background-preparation-failed',
      label: 'Annotation products failed',
      updatedAtMs: 123,
    };
    const getLocalPreparationStatus = vi.fn(async () => failedStatus);
    const retryLocal = vi.fn(async ({ onProgress }) => {
      onProgress({
        assemblyId: READY_ENTRY.id,
        phase: 'ready',
        label: 'pUC19 is ready',
        completed: 1,
        total: 1,
      });
      return READY_ENTRY;
    });
    const installHosted = vi.fn();
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      getLocalPreparationStatus,
      retryLocal,
      listHosted: vi.fn(async () => []),
      installHosted,
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL)(
        {},
        { assemblyId: READY_ENTRY.id }
      )
    ).resolves.toEqual(failedStatus);
    await expect(
      registeredHandler(REFERENCE_ASSET_RETRY_LOCAL_CHANNEL)(
        { sender },
        {
          operationId: 'retry-local-1',
          assemblyId: READY_ENTRY.id,
          themeMode: 'dark',
        }
      )
    ).resolves.toEqual({ status: 'ready', entry: READY_ENTRY });

    expect(getLocalPreparationStatus).toHaveBeenCalledWith(READY_ENTRY.id);
    expect(retryLocal).toHaveBeenCalledWith({
      assemblyId: READY_ENTRY.id,
      themeMode: 'dark',
      onProgress: expect.any(Function),
    });
    expect(installHosted).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, {
      operationId: 'retry-local-1',
      assemblyId: READY_ENTRY.id,
      phase: 'ready',
      label: 'pUC19 is ready',
      completed: 1,
      total: 1,
    });
  });

  it('lists admitted entries through a structured-clone-safe DTO', async () => {
    const listLocal = vi.fn(async () => [READY_ENTRY]);
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal,
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    const result = await registeredHandler(REFERENCE_ASSET_LIST_LOCAL_CHANNEL)();
    expect(result).toEqual([READY_ENTRY]);
    expect(JSON.parse(JSON.stringify(result))).toEqual([READY_ENTRY]);
  });

  it('lists hosted display metadata and installs by main-owned catalog id only', async () => {
    const sender = { send: vi.fn() };
    const hosted: HostedReferenceCatalogEntryV1 = {
      id: 'puc19-l09137-2',
      name: 'pUC19',
      organism: 'synthetic DNA construct',
      assembly: 'L09137.2',
      description: 'Classic cloning vector.',
      cacheStatus: 'not-cached',
      lengthBp: 2686,
      contigCount: 1,
      downloadBytes: 4423,
      provider: 'NCBI',
      datasetVersion: 'L09137.2',
    };
    const listHosted = vi.fn(async () => [hosted]);
    const installHosted = vi.fn(async ({ onProgress }) => {
      onProgress({
        phase: 'downloading-reference',
        label: 'Downloading reference',
        completed: 4423,
        total: 4423,
      });
      return READY_ENTRY;
    });
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      listHosted,
      installHosted,
      createOperationId: () => 'hosted-1',
    });

    await expect(registeredHandler(REFERENCE_ASSET_LIST_HOSTED_CHANNEL)()).resolves.toEqual([
      hosted,
    ]);
    await expect(
      registeredHandler(REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL)(
        { sender },
        { catalogId: hosted.id, themeMode: 'light', intent: 'require-ready' }
      )
    ).resolves.toEqual({ status: 'ready', entry: READY_ENTRY });

    expect(installHosted).toHaveBeenCalledWith({
      catalogId: hosted.id,
      themeMode: 'light',
      onProgress: expect.any(Function),
    });
    expect(sender.send).toHaveBeenNthCalledWith(
      1,
      REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
      {
        operationId: 'hosted-1',
        catalogId: hosted.id,
        phase: 'resolving-hosted-reference',
        label: 'Checking the hosted reference',
      }
    );
    expect(sender.send).toHaveBeenNthCalledWith(
      2,
      REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
      {
        operationId: 'hosted-1',
        catalogId: hosted.id,
        phase: 'downloading-reference',
        label: 'Downloading reference',
        completed: 4423,
        total: 4423,
      }
    );
    expect(JSON.stringify(installHosted.mock.calls)).not.toContain('http');
    expect(JSON.stringify(installHosted.mock.calls)).not.toContain('sha256');
  });

  it('reconciles hosted full-capability status through a read-only main-owned snapshot', async () => {
    const readyStatus = {
      catalogId: 'grch38',
      themeMode: 'dark' as const,
      status: 'ready' as const,
      phase: 'ready' as const,
      label: 'GRCh38 is ready',
      updatedAtMs: 123,
      capabilityGenerationId: 'a'.repeat(64),
      entry: READY_ENTRY,
    };
    const getHostedPreparationStatus = vi.fn(async () => readyStatus);
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      getHostedPreparationStatus,
      installHosted: vi.fn(),
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL)(
        {},
        { catalogId: 'grch38', themeMode: 'dark' }
      )
    ).resolves.toEqual(readyStatus);
    expect(getHostedPreparationStatus).toHaveBeenCalledWith({
      catalogId: 'grch38',
      themeMode: 'dark',
    });

    expect(() =>
      registeredHandler(REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL)(
        {},
        { catalogId: '../grch38', themeMode: 'dark' }
      )
    ).toThrow('Invalid hosted reference preparation status request');
    expect(getHostedPreparationStatus).toHaveBeenCalledTimes(1);
  });

  it('routes staged opens and full admission by explicit renderer intent', async () => {
    const sender = { send: vi.fn() };
    const openHosted = vi.fn(async () => ({
      status: 'view-ready' as const,
      entry: READY_ENTRY,
    }));
    const installHosted = vi.fn(async () => READY_ENTRY);
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted,
      openHosted,
    });
    const handler = registeredHandler(REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL);

    await expect(
      handler({ sender }, { catalogId: 'grch38', themeMode: 'dark', intent: 'open-view' })
    ).resolves.toEqual({ status: 'view-ready', entry: READY_ENTRY });
    expect(openHosted).toHaveBeenCalledWith({
      catalogId: 'grch38',
      themeMode: 'dark',
      onProgress: expect.any(Function),
    });
    expect(installHosted).not.toHaveBeenCalled();

    await expect(
      handler({ sender }, { catalogId: 'grch38', themeMode: 'dark', intent: 'require-ready' })
    ).resolves.toEqual({ status: 'ready', entry: READY_ENTRY });
    expect(installHosted).toHaveBeenCalledWith({
      catalogId: 'grch38',
      themeMode: 'dark',
      onProgress: expect.any(Function),
    });
    expect(openHosted).toHaveBeenCalledTimes(1);
  });

  it('rejects hosted requests without an explicit open intent', async () => {
    registerReferenceAssetIpcHandlers({
      importLocal: vi.fn(),
      listLocal: vi.fn(async () => []),
      listHosted: vi.fn(async () => []),
      installHosted: vi.fn(),
    });

    await expect(
      registeredHandler(REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL)(
        { sender: { send: vi.fn() } },
        { catalogId: 'grch38', themeMode: 'light' }
      )
    ).rejects.toThrow('Invalid hosted reference install request');
  });
});
