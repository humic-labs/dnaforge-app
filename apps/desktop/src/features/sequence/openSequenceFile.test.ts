import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCanvasStore } from '../canvas/store';
import { useOversizedDialogStore } from './oversized-dialog-store';
import { HARD_CAP_BYTES, SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { DocumentTarget } from '../document-opening/public/types';

const {
  mockStat,
  mockReveal,
  mockRegisterWorkspaceFile,
  mockGetCatalogEntityForFilePath,
  mockTrackRendererEvent,
  mockListProjectFolders,
  mockBeginWorkspaceMutation,
  mockEndWorkspaceMutation,
  mockCanonicalPath,
} = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReveal: vi.fn(),
  mockRegisterWorkspaceFile: vi.fn(),
  mockGetCatalogEntityForFilePath: vi.fn(),
  mockTrackRendererEvent: vi.fn(),
  mockListProjectFolders: vi.fn(),
  mockBeginWorkspaceMutation: vi.fn(),
  mockEndWorkspaceMutation: vi.fn(),
  mockCanonicalPath: vi.fn(),
}));

vi.mock('../workspace-loader/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: mockListProjectFolders,
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      stat: mockStat,
      canonicalPath: mockCanonicalPath,
      beginWorkspaceMutation: mockBeginWorkspaceMutation,
      endWorkspaceMutation: mockEndWorkspaceMutation,
    },
    shell: { revealItemInDir: mockReveal },
  }),
}));

vi.mock('../../shared/developer-import-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/developer-import-sources')>();
  return {
    ...actual,
    isDeveloperImportSourcePath: (path: string) =>
      actual.isDeveloperImportSourcePath(path, ['/developer/wp-assets']),
  };
});

vi.mock('../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: (folders: Array<{ path: string }>, filePath: string) =>
    folders
      .filter((folder) => filePath === folder.path || filePath.startsWith(`${folder.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null,
  inferCatalogFileKind: (filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'gb' || ext === 'gbk' || ext === 'gbff') return 'genbank';
    if (ext === 'fasta' || ext === 'fa') return 'fasta';
    return ext ?? 'file';
  },
  registerWorkspaceFile: mockRegisterWorkspaceFile,
  getCatalogEntityForFilePath: mockGetCatalogEntityForFilePath,
}));

vi.mock('../document-opening/filesystem-target', () => ({
  resolveFilesystemDocumentTarget: async (target: Extract<DocumentTarget, { kind: 'file' }>) => ({
    status: 'resolved',
    target,
  }),
}));

vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: mockTrackRendererEvent,
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
  getAnalyticsCaptureGeneration: () => 0,
  isAnalyticsCaptureReady: () => false,
}));

import {
  openSequenceFile,
  openSequenceFileResult,
  __resetInflightForTests,
} from './openSequenceFile';
import {
  __pendingFileOpenCountForTests,
  __resetFileOpenTelemetryForTests,
  failPendingFileOpen,
} from './file-open-telemetry';

function setMockSize(size: number) {
  mockStat.mockResolvedValue({
    size,
    isFile: true,
    isDirectory: false,
    mtime: 0,
    ctime: 0,
  });
}

function setMockMissing() {
  mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

function resetCanvasStore() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
}

describe('openSequenceFile  Layer A)', () => {
  beforeEach(() => {
    resetCanvasStore();
    useOversizedDialogStore.setState({ request: null });
    __resetInflightForTests();
    __resetFileOpenTelemetryForTests();
    mockStat.mockReset();
    mockCanonicalPath.mockReset().mockImplementation(async (path: string) => path);
    mockReveal.mockReset();
    mockRegisterWorkspaceFile.mockReset();
    mockTrackRendererEvent.mockReset();
    mockListProjectFolders.mockReset().mockResolvedValue([]);
    mockBeginWorkspaceMutation.mockReset().mockResolvedValue('open-sequence-mutation');
    mockEndWorkspaceMutation.mockReset().mockResolvedValue(undefined);
    mockRegisterWorkspaceFile.mockResolvedValue({ id: 'catalog-entity-1' });
    mockGetCatalogEntityForFilePath.mockReset();
    mockGetCatalogEntityForFilePath.mockResolvedValue(null);
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete document.documentElement.dataset.dnaforgeRuntime;
  });

  it('previews a loose developer-source sequence without a catalog or project registration', async () => {
    setMockSize(100);
    useWorkspaceStore.setState({
      folders: [{ path: '/developer/wp-assets', name: 'Source', addedAt: 1 }],
    });
    const filePath = '/developer/wp-assets/reference.gb';
    const first = await openSequenceFileResult({ filePath, label: 'Reference' });
    expect(first.status).toBe('presented');
    const tab = Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)[0];
    expect(tab.readOnly).toBe(true);
    expect(tab.sequenceDocument).toMatchObject({
      kind: 'import-source-sequence',
      sourcePath: filePath,
    });
    expect(tab.entityId).not.toBe(filePath);
    await openSequenceFileResult({ filePath, label: 'Reference again' });
    expect(
      Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
    ).toHaveLength(1);
    expect(mockRegisterWorkspaceFile).not.toHaveBeenCalled();
    expect(mockGetCatalogEntityForFilePath).not.toHaveBeenCalled();
  });

  function findTabByPath(_path: string) {
    for (const panel of Object.values(useCanvasStore.getState().panels)) {
      const t = panel.tabs.find(
        (tab) =>
          tab.type === 'sequence' &&
          tab.sequenceDocument?.kind === 'catalog-sequence' &&
          tab.sequenceDocument.entityId === 'catalog-entity-1'
      );
      if (t) return t;
    }
    return undefined;
  }

  function totalTabCount(): number {
    let n = 0;
    for (const panel of Object.values(useCanvasStore.getState().panels)) {
      n += panel.tabs.length;
    }
    return n;
  }

  it('shares preparation through the common operation while one caller cancels', async () => {
    const { openDocument } = await import('../document-opening/open-document');
    let releaseStat: ((value: { size: number }) => void) | undefined;
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStat = resolve;
        })
    );
    const controller = new AbortController();
    const first = openDocument({
      target: { kind: 'file', path: '/tmp/shared.gb' },
      signal: controller.signal,
    });
    const second = openDocument({ target: { kind: 'file', path: '/tmp/shared.gb' } });
    await vi.waitFor(() => expect(releaseStat).toBeDefined());
    controller.abort();
    expect(await first).toMatchObject({ status: 'cancelled' });
    releaseStat!({ size: 1024 });
    expect(await second).toMatchObject({ status: 'presented', content: 'loading' });
    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(totalTabCount()).toBe(1);
  });

  it('focuses the existing sequence panel during identity-first global reuse', async () => {
    setMockSize(1024);
    const options = { filePath: '/tmp/x.gb', label: 'x.gb' };
    const first = await openSequenceFileResult(options);
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-entity-1' });
    const other = useCanvasStore.getState().splitPanel('main', 'vertical');
    useCanvasStore.getState().focusPanel(other);
    expect(await openSequenceFileResult(options)).toMatchObject({
      ...first,
      disposition: 'reused',
    });
    expect(useCanvasStore.getState().focusedPanelId).toBe('main');
  });

  it('resolves a physical alias before catalog lookup and reuses the same document', async () => {
    setMockSize(1024);
    const original = await openSequenceFileResult({
      filePath: '/tmp/physical.gb',
      label: 'Physical',
    });
    mockCanonicalPath.mockResolvedValue('/tmp/physical.gb');
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-entity-1' });
    const aliased = await openSequenceFileResult({ filePath: '/tmp/alias.gb', label: 'Alias' });
    expect(aliased).toMatchObject({ ...original, disposition: 'reused' });
    expect(mockGetCatalogEntityForFilePath).toHaveBeenLastCalledWith('/tmp/physical.gb');
    expect(totalTabCount()).toBe(1);
  });

  it('opens an accepted Hosted file without calling the native physical-alias capability', async () => {
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    setMockSize(1024);
    const path = '/hosted/11111111-1111-4111-8111-111111111111/sequences/pUC19.gb';
    useWorkspaceStore.setState({
      folders: [
        { path: '/hosted/11111111-1111-4111-8111-111111111111', name: 'Project', addedAt: 1 },
      ],
    });
    mockCanonicalPath.mockRejectedValue(new Error('HostedCapabilityError: fs.canonicalPath'));

    await expect(openSequenceFileResult({ filePath: path, label: 'pUC19' })).resolves.toMatchObject(
      {
        status: 'presented',
      }
    );
    expect(mockCanonicalPath).not.toHaveBeenCalled();
    expect(mockStat).toHaveBeenCalledWith(path);
    expect(mockRegisterWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ path }));
    expect(totalTabCount()).toBe(1);
  });

  it('returns explicit presentation, recovery, blocking and cancellation outcomes', async () => {
    setMockSize(1024);
    const options = { filePath: '/tmp/x.gb', label: 'x.gb' };
    const result = await openSequenceFileResult(options);
    expect(result).toMatchObject({
      status: 'presented',
      disposition: 'created',
      content: 'loading',
    });
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-entity-1' });
    expect(await openSequenceFileResult(options)).toMatchObject({
      status: 'presented',
      disposition: 'reused',
    });
    resetCanvasStore();
    setMockMissing();
    expect(await openSequenceFileResult(options)).toMatchObject({
      status: 'presented',
      content: 'missing',
    });
    resetCanvasStore();
    setMockSize(HARD_CAP_BYTES + 1);
    expect(
      await openSequenceFileResult({
        ...options,
        filePath: '/tmp/x.ab1',
        skipOversizedPrompt: true,
      })
    ).toMatchObject({ status: 'blocked' });
    const controller = new AbortController();
    controller.abort();
    expect(await openSequenceFileResult({ ...options, signal: controller.signal })).toMatchObject({
      status: 'cancelled',
    });
    expect(totalTabCount()).toBe(0);
  });

  it('sub-threshold file opens silently without dialog', async () => {
    setMockSize(1024);
    const tabId = await openSequenceFile({
      filePath: '/tmp/x.gb',
      label: 'x.gb',
      strategy: { kind: 'focused' },
    });
    expect(tabId).toBeTruthy();
    expect(useOversizedDialogStore.getState().request).toBeNull();
    const tab = findTabByPath('/tmp/x.gb');
    expect(tab).toBeTruthy();
    expect(tab?.loadStatus).toBe('loaded');
    expect(tab?.fileSizeBytes).toBe(1024);
    expect(__pendingFileOpenCountForTests()).toBe(1);
  });

  it('marks sequences inside pinned reference projects read-only at the central open boundary', async () => {
    setMockSize(1024);
    useWorkspaceStore.setState({
      folders: [
        { path: '/tmp/reference-project', name: 'Test Fixtures', addedAt: 1, pinned: true },
      ],
    });

    await openSequenceFile({
      filePath: '/tmp/reference-project/pUC19.gb',
      label: 'pUC19.gb',
      strategy: { kind: 'focused' },
    });

    expect(findTabByPath('/tmp/reference-project/pUC19.gb')).toMatchObject({
      type: 'sequence',
      readOnly: true,
    });
  });

  it('keeps an unmounted reference read-only even when the caller requests a writable tab', async () => {
    setMockSize(1024);
    mockListProjectFolders.mockResolvedValue([
      {
        path: '/tmp/reference-project',
        name: 'Reference sequences',
        pinned: true,
        lifecycle: 'active',
      },
    ]);
    await openSequenceFile({
      filePath: '/tmp/reference-project/pUC19.gb',
      label: 'pUC19.gb',
      readOnly: false,
      strategy: { kind: 'focused' },
    });
    expect(findTabByPath('/tmp/reference-project/pUC19.gb')).toMatchObject({ readOnly: true });
    expect(mockRegisterWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/tmp/reference-project' })
    );
  });

  it('assigns an unmounted ordinary sequence to its durable active project', async () => {
    setMockSize(2048);
    mockListProjectFolders.mockResolvedValue([
      { path: '/tmp/older-project', name: 'Older project', pinned: false, lifecycle: 'active' },
    ]);
    await openSequenceFile({
      filePath: '/tmp/older-project/pUC19.gb',
      label: 'pUC19.gb',
      strategy: { kind: 'focused' },
    });
    expect(findTabByPath('/tmp/older-project/pUC19.gb')).toMatchObject({ readOnly: false });
    expect(mockListProjectFolders).toHaveBeenCalledWith({ includeSharedAccess: false });
    expect(mockRegisterWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/tmp/older-project' })
    );
  });

  it('waits for workspace admission before registering an opened sequence file', async () => {
    setMockSize(2048);
    useWorkspaceStore.setState({
      folders: [{ path: '/tmp/workspace', name: 'workspace', addedAt: 1 }],
    });
    let admit!: (token: string) => void;
    mockBeginWorkspaceMutation.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        admit = resolve;
      })
    );

    const opening = openSequenceFile({
      filePath: '/tmp/workspace/pUC19.gb',
      label: 'pUC19.gb',
      strategy: { kind: 'focused' },
    });
    await vi.waitFor(() =>
      expect(mockBeginWorkspaceMutation).toHaveBeenCalledWith('/tmp/workspace', undefined)
    );
    expect(mockRegisterWorkspaceFile).not.toHaveBeenCalled();
    expect(totalTabCount()).toBe(0);
    admit('open-sequence-mutation');
    await opening;

    expect(mockRegisterWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/workspace/pUC19.gb',
        name: 'pUC19.gb',
        entityType: 'sequence',
        fileKind: 'genbank',
        workspaceRoot: '/tmp/workspace',
        sizeBytes: 2048,
        modifiedAt: 0,
        mutationToken: 'open-sequence-mutation',
      })
    );
    expect(mockEndWorkspaceMutation).toHaveBeenCalledWith('open-sequence-mutation');
  });

  it('uses catalog identity rather than the physical GenBank path for a loose source', async () => {
    setMockSize(2048);
    useWorkspaceStore.setState({
      folders: [{ path: '/tmp/workspace', name: 'workspace', addedAt: 1 }],
    });

    await openSequenceFile({
      filePath: '/tmp/workspace/pUC19.gb',
      label: 'pUC19.gb',
      strategy: { kind: 'focused' },
    });

    const [tab] = useCanvasStore.getState().panels.main.tabs;
    expect(tab).toMatchObject({
      type: 'sequence',
      entityId: 'catalog-entity-1',
      sequenceDocument: {
        kind: 'catalog-sequence',
        entityId: 'catalog-entity-1',
      },
    });
    expect(tab?.entityId).not.toContain('.gb');
  });

  it('warn-threshold file fires warn dialog; cancel → no tab', async () => {
    setMockSize(SOFT_WARN_BYTES + 100);
    const promise = openSequenceFile({
      filePath: '/tmp/big.fastq',
      label: 'big.gb',
      strategy: { kind: 'focused' },
    });
    await vi.waitFor(() => {
      expect(useOversizedDialogStore.getState().request?.kind).toBe('warn');
    });
    useOversizedDialogStore.getState().resolveCurrent(false);
    const tabId = await promise;
    expect(tabId).toBeNull();
    expect(totalTabCount()).toBe(0);
    expect(__pendingFileOpenCountForTests()).toBe(0);
  });

  it('warn-threshold file fires warn dialog; confirm → tab created loaded', async () => {
    setMockSize(SOFT_WARN_BYTES + 100);
    const promise = openSequenceFile({
      filePath: '/tmp/big.fastq',
      label: 'big.gb',
      strategy: { kind: 'focused' },
    });
    await vi.waitFor(() => {
      expect(useOversizedDialogStore.getState().request?.kind).toBe('warn');
    });
    useOversizedDialogStore.getState().resolveCurrent(true);
    const tabId = await promise;
    expect(tabId).toBeTruthy();
    const tab = findTabByPath('/tmp/big.fastq');
    expect(tab?.loadStatus).toBe('loaded');
  });

  it('skipOversizedPrompt: a warn-band file loads WITHOUT a second dialog  import)', async () => {
    setMockSize(SOFT_WARN_BYTES + 100);

    const tabId = await openSequenceFile({
      filePath: '/tmp/already-confirmed.fastq',
      label: 'already-confirmed.fastq',
      strategy: { kind: 'focused' },
      skipOversizedPrompt: true,
    });
    expect(tabId).toBeTruthy();
    expect(useOversizedDialogStore.getState().request).toBeNull();
    expect(findTabByPath('/tmp/already-confirmed.fastq')?.loadStatus).toBe('loaded');
  });

  it('above hard cap for unsupported sequence input fires block dialog; no tab created', async () => {
    setMockSize(HARD_CAP_BYTES + 1);
    const promise = openSequenceFile({
      filePath: '/tmp/huge.fastq',
      label: 'huge.fastq',
      strategy: { kind: 'focused' },
    });
    await vi.waitFor(() => {
      expect(useOversizedDialogStore.getState().request?.kind).toBe('block');
    });
    useOversizedDialogStore.getState().resolveCurrent(false);
    const tabId = await promise;
    expect(tabId).toBeNull();
    expect(totalTabCount()).toBe(0);
  });

  it('chromosome-scale GenBank opens as indexed without warn/block dialog', async () => {
    setMockSize(HARD_CAP_BYTES + 1);
    const operationId = '123e4567-e89b-42d3-a456-426614174000';
    const tabId = await openSequenceFile({
      filePath: '/tmp/chr11.gbff',
      label: 'chr11.gbff',
      strategy: { kind: 'focused' },
      sourceSurface: 'sidebar',
      importOperationId: operationId,
    });
    expect(tabId).toBeTruthy();
    expect(useOversizedDialogStore.getState().request).toBeNull();
    const tab = findTabByPath('/tmp/chr11.gbff');
    expect(tab?.loadStatus).toBe('indexed-pending');
    expect(tab?.indexedGenome).toMatchObject({
      sourcePath: '/tmp/chr11.gbff',
      sourceExt: 'gbff',
      chrom: 'chr11',
    });
    expect(__pendingFileOpenCountForTests()).toBe(1);
  });

  it('does not reactivate an indexed-pending tab — the indexed open must re-drive', async () => {
    setMockSize(HARD_CAP_BYTES + 1);
    const first = await openSequenceFile({
      filePath: '/tmp/chr11.gbff',
      label: 'chr11.gbff',
      strategy: { kind: 'focused' },
    });
    expect(findTabByPath('/tmp/chr11.gbff')?.loadStatus).toBe('indexed-pending');

    const second = await openSequenceFile({
      filePath: '/tmp/chr11.gbff',
      label: 'chr11.gbff',
      strategy: { kind: 'focused' },
    });

    expect(second).toBeTruthy();

    expect(mockStat).toHaveBeenCalledTimes(2);
    expect(findTabByPath('/tmp/chr11.gbff')?.indexedGenome).toMatchObject({
      sourcePath: '/tmp/chr11.gbff',
      chrom: 'chr11',
    });
  });

  it('large FASTA routes to indexed before the soft warning dialog', async () => {
    setMockSize(80 * 1024 * 1024);
    const tabId = await openSequenceFile({
      filePath: '/tmp/chr22.fasta',
      label: 'chr22.fasta',
      strategy: { kind: 'focused' },
    });
    expect(tabId).toBeTruthy();
    expect(useOversizedDialogStore.getState().request).toBeNull();
    const tab = findTabByPath('/tmp/chr22.fasta');
    expect(tab?.loadStatus).toBe('indexed-pending');
    expect(tab?.indexedGenome?.chrom).toBe('chr22');
  });

  it('missing file → tab created with loadStatus=missing', async () => {
    setMockMissing();
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-entity-1' });
    const tabId = await openSequenceFile({
      filePath: '/tmp/gone.gb',
      label: 'gone.gb',
      strategy: { kind: 'focused' },
    });
    expect(tabId).toBeTruthy();
    const tab = findTabByPath('/tmp/gone.gb');
    expect(tab?.loadStatus).toBe('missing');
    expect(useOversizedDialogStore.getState().request).toBeNull();
  });

  it('reports a correlated post-import stat failure without exposing the path', async () => {
    setMockMissing();
    const operationId = '123e4567-e89b-42d3-a456-426614174000';

    await openSequenceFile({
      filePath: '/tmp/private-organism.gb',
      label: 'private-organism.gb',
      strategy: { kind: 'focused' },
      sourceSurface: 'sidebar',
      importOperationId: operationId,
    });

    const failureEvents = mockTrackRendererEvent.mock.calls.filter(
      ([event]) => event === 'file_open_failed' || event === 'import_failed'
    );
    expect(failureEvents).toEqual([
      [
        'file_open_failed',
        {
          feature_area: 'file',
          file_type_category: 'dna',
          source_surface: 'sidebar',
          size_bucket: 'unknown',
          error_class: 'filesystem',
        },
      ],
      [
        'import_failed',
        {
          feature_area: 'import',
          source_system_type: 'file',
          failure_stage: 'unknown',
          error_class: 'filesystem',
          operation_id: operationId,
        },
      ],
    ]);
    expect(JSON.stringify(failureEvents)).not.toContain('private-organism');
  });

  it('inflight dedup: two simultaneous opens for same path share one stat + one dialog', async () => {
    setMockSize(SOFT_WARN_BYTES + 100);
    const a = openSequenceFile({
      filePath: '/tmp/big.fastq',
      label: 'big.gb',
      strategy: { kind: 'focused' },
    });
    const b = openSequenceFile({
      filePath: '/tmp/big.fastq',
      label: 'big.gb',
      strategy: { kind: 'focused' },
    });
    await vi.waitFor(() => {
      expect(useOversizedDialogStore.getState().request?.kind).toBe('warn');
    });
    useOversizedDialogStore.getState().resolveCurrent(true);
    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).toBe(r2);
    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(totalTabCount()).toBe(1);
  });

  it('does not commit a tab after the final open consumer aborts', async () => {
    let resolveStat!: (value: {
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      mtime: number;
      ctime: number;
    }) => void;
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        })
    );
    const controller = new AbortController();
    const open = openSequenceFile({
      filePath: '/tmp/aborted.gb',
      label: 'aborted.gb',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(1));

    controller.abort();
    resolveStat({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });

    await expect(open).resolves.toBeNull();
    await vi.waitFor(() => expect(totalTabCount()).toBe(0));
    expect(mockRegisterWorkspaceFile).not.toHaveBeenCalled();
  });

  it('serializes a cancellable live successor behind an abandoned physical stat', async () => {
    const statResolvers: Array<
      (value: {
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        mtime: number;
        ctime: number;
      }) => void
    > = [];
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          statResolvers.push(resolve);
        })
    );
    const controller = new AbortController();
    const abandoned = openSequenceFile({
      filePath: '/tmp/abandoned.gb',
      label: 'abandoned.gb',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(abandoned).resolves.toBeNull();
    const cancelledRetryController = new AbortController();
    const cancelledRetry = openSequenceFile({
      filePath: '/tmp/abandoned.gb',
      label: 'abandoned.gb',
      signal: cancelledRetryController.signal,
    });
    cancelledRetryController.abort();
    await expect(cancelledRetry).resolves.toBeNull();
    const liveRetry = openSequenceFile({
      filePath: '/tmp/abandoned.gb',
      label: 'abandoned.gb',
    });
    await Promise.resolve();
    expect(mockStat).toHaveBeenCalledTimes(1);

    statResolvers[0]?.({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(2));
    statResolvers[1]?.({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });
    await expect(liveRetry).resolves.toBeTruthy();
    expect(totalTabCount()).toBe(1);
  });

  it('commits a queued successor with the consumer that remains live after it starts', async () => {
    useCanvasStore.setState({
      panels: {
        initiator: { id: 'initiator', tabs: [], activeTabId: null },
        survivor: { id: 'survivor', tabs: [], activeTabId: null },
      },
      layout: { type: 'panel', panelId: 'initiator' },
      focusedPanelId: 'initiator',
    });
    const statResolvers: Array<
      (value: {
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        mtime: number;
        ctime: number;
      }) => void
    > = [];
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          statResolvers.push(resolve);
        })
    );
    const abandonedController = new AbortController();
    const abandoned = openSequenceFile({
      filePath: '/tmp/queued-panel.gb',
      label: 'abandoned.gb',
      signal: abandonedController.signal,
    });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(1));
    abandonedController.abort();
    await expect(abandoned).resolves.toBeNull();

    const initiatorController = new AbortController();
    const initiator = openSequenceFile({
      filePath: '/tmp/queued-panel.gb',
      label: 'initiator.gb',
      strategy: { kind: 'panel', panelId: 'initiator' },
      signal: initiatorController.signal,
    });
    const survivor = openSequenceFile({
      filePath: '/tmp/queued-panel.gb',
      label: 'survivor.gb',
      strategy: { kind: 'panel', panelId: 'survivor' },
    });
    await vi.waitFor(() => expect(mockGetCatalogEntityForFilePath).toHaveBeenCalledTimes(3));
    statResolvers[0]?.({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(2));

    initiatorController.abort();
    statResolvers[1]?.({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });
    await expect(initiator).resolves.toBeNull();
    await expect(survivor).resolves.toBeTruthy();
    expect(useCanvasStore.getState().panels.initiator.tabs).toHaveLength(0);
    expect(useCanvasStore.getState().panels.survivor.tabs).toEqual([
      expect.objectContaining({
        type: 'sequence',
        label: 'survivor',
        sourceFileName: 'queued-panel.gb',
      }),
    ]);
  });

  it('preserves a shared open when another consumer remains live', async () => {
    let resolveStat!: (value: {
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      mtime: number;
      ctime: number;
    }) => void;
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        })
    );
    const controller = new AbortController();
    const abortedConsumer = openSequenceFile({
      filePath: '/tmp/shared.gb',
      label: 'shared.gb',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(1));
    const liveConsumer = openSequenceFile({
      filePath: '/tmp/shared.gb',
      label: 'shared.gb',
    });
    await vi.waitFor(() => expect(mockGetCatalogEntityForFilePath).toHaveBeenCalledTimes(2));

    await Promise.resolve();

    controller.abort();
    resolveStat({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });

    await expect(abortedConsumer).resolves.toBeNull();
    await expect(liveConsumer).resolves.toBeTruthy();
    expect(totalTabCount()).toBe(1);
  });

  it('commits a shared open with the surviving consumer panel strategy', async () => {
    useCanvasStore.setState({
      panels: {
        initiator: { id: 'initiator', tabs: [], activeTabId: null },
        survivor: { id: 'survivor', tabs: [], activeTabId: null },
      },
      layout: { type: 'panel', panelId: 'initiator' },
      focusedPanelId: 'initiator',
    });
    let resolveStat!: (value: {
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      mtime: number;
      ctime: number;
    }) => void;
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        })
    );
    const controller = new AbortController();
    const initiator = openSequenceFile({
      filePath: '/tmp/shared-panel.gb',
      label: 'initiator.gb',
      strategy: { kind: 'panel', panelId: 'initiator' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(1));
    const survivor = openSequenceFile({
      filePath: '/tmp/shared-panel.gb',
      label: 'survivor.gb',
      strategy: { kind: 'panel', panelId: 'survivor' },
    });
    await vi.waitFor(() => expect(mockGetCatalogEntityForFilePath).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    controller.abort();
    resolveStat({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });

    await expect(initiator).resolves.toBeNull();
    await expect(survivor).resolves.toBeTruthy();
    expect(useCanvasStore.getState().panels.initiator.tabs).toHaveLength(0);
    expect(useCanvasStore.getState().panels.survivor.tabs).toEqual([
      expect.objectContaining({
        type: 'sequence',
        label: 'survivor',
        sourceFileName: 'shared-panel.gb',
      }),
    ]);
  });

  it('retains import correlation when a non-import open of the same path starts first', async () => {
    let resolveStat!: (value: {
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      mtime: number;
      ctime: number;
    }) => void;
    mockStat.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        })
    );
    const filePath = '/tmp/concurrent-private-organism.gb';
    const operationId = '123e4567-e89b-42d3-a456-426614174000';
    const secondOperationId = '223e4567-e89b-42d3-a456-426614174000';

    const ordinaryOpen = openSequenceFile({
      filePath,
      label: 'concurrent-private-organism.gb',
      sourceSurface: 'file_tree',
    });
    await vi.waitFor(() => expect(mockStat).toHaveBeenCalledTimes(1));
    const importOpen = openSequenceFile({
      filePath,
      label: 'concurrent-private-organism.gb',
      sourceSurface: 'sidebar',
      importOperationId: operationId,
    });
    const secondImportOpen = openSequenceFile({
      filePath,
      label: 'concurrent-private-organism.gb',
      sourceSurface: 'sidebar',
      importOperationId: secondOperationId,
    });

    resolveStat({ size: 1024, isFile: true, isDirectory: false, mtime: 0, ctime: 0 });
    await Promise.all([ordinaryOpen, importOpen, secondImportOpen]);
    failPendingFileOpen('catalog-entity-1', 'parse_failed');

    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(mockTrackRendererEvent).toHaveBeenCalledWith('file_open_failed', {
      feature_area: 'file',
      file_type_category: 'dna',
      source_surface: 'sidebar',
      size_bucket: '1_10kb',
      error_class: 'parse_failed',
    });
    expect(mockTrackRendererEvent).toHaveBeenCalledWith('import_failed', {
      feature_area: 'import',
      source_system_type: 'file',
      failure_stage: 'parse',
      error_class: 'parse_failed',
      operation_id: operationId,
    });
    expect(mockTrackRendererEvent).toHaveBeenCalledWith('import_failed', {
      feature_area: 'import',
      source_system_type: 'file',
      failure_stage: 'parse',
      error_class: 'parse_failed',
      operation_id: secondOperationId,
    });
    expect(
      mockTrackRendererEvent.mock.calls.filter(([event]) => event === 'import_failed')
    ).toHaveLength(2);
  });

  it('reactivates an already-open tab without creating a second file-open pending token', async () => {
    setMockSize(1024);
    const first = await openSequenceFile({
      filePath: '/tmp/existing.gb',
      label: 'existing.gb',
      sourceSurface: 'file_tree',
    });
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-entity-1' });
    const second = await openSequenceFile({
      filePath: '/tmp/existing.gb',
      label: 'existing.gb',
      sourceSurface: 'recent',
    });

    expect(second).toBe(first);
    expect(totalTabCount()).toBe(1);
    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(__pendingFileOpenCountForTests()).toBe(1);
  });

  it('joins an import to an already-created tab whose parse is still pending', async () => {
    setMockSize(1024);
    const filePath = '/tmp/pending-parse.gb';
    const operationId = '123e4567-e89b-42d3-a456-426614174000';

    await openSequenceFile({
      filePath,
      label: 'pending-parse.gb',
      sourceSurface: 'file_tree',
    });
    mockGetCatalogEntityForFilePath.mockResolvedValue({ id: 'catalog-entity-1' });
    await openSequenceFile({
      filePath,
      label: 'pending-parse.gb',
      sourceSurface: 'sidebar',
      importOperationId: operationId,
    });
    failPendingFileOpen('catalog-entity-1', 'parse_failed');

    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(mockTrackRendererEvent).toHaveBeenCalledWith('file_open_failed', {
      feature_area: 'file',
      file_type_category: 'dna',
      source_surface: 'sidebar',
      size_bucket: '1_10kb',
      error_class: 'parse_failed',
    });
    expect(mockTrackRendererEvent).toHaveBeenCalledWith(
      'import_failed',
      expect.objectContaining({ operation_id: operationId })
    );
  });

  it('strategy=panel routes the open to the named panel', async () => {
    setMockSize(1024);
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [], activeTabId: null },
        right: { id: 'right', tabs: [], activeTabId: null },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    const tabId = await openSequenceFile({
      filePath: '/tmp/x.gb',
      label: 'x.gb',
      strategy: { kind: 'panel', panelId: 'right' },
    });
    expect(tabId).toBeTruthy();
    expect(useCanvasStore.getState().panels.right.tabs.length).toBe(1);
    expect(useCanvasStore.getState().panels.main.tabs.length).toBe(0);
  });

  it('default strategy opens sequence files in the currently focused panel', async () => {
    setMockSize(1024);
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [], activeTabId: null },
        right: { id: 'right', tabs: [], activeTabId: null },
      },
      layout: {
        type: 'split',
        direction: 'vertical',
        children: [
          { type: 'panel', panelId: 'main' },
          { type: 'panel', panelId: 'right' },
        ],
        sizes: [50, 50],
      },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const tabId = await openSequenceFile({
      filePath: '/tmp/recent-sequence.gb',
      label: 'recent-sequence.gb',
    });

    expect(tabId).toBeTruthy();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expect(useCanvasStore.getState().panels.right.tabs).toHaveLength(0);
  });
});
