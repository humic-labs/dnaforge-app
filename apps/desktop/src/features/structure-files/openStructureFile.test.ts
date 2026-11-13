import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/store';
import { useOversizedDialogStore } from '../sequence/oversized-dialog-store';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';
import { useWorkspaceStore } from '../../stores/workspaceStore';

const { mockStat, mockReadTextFile, mockReadFile, mockRegisterWorkspaceFile } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReadTextFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockRegisterWorkspaceFile: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      stat: mockStat,
      readTextFile: mockReadTextFile,
      readFile: mockReadFile,
    },
  }),
}));

vi.mock('../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: (folders: Array<{ path: string }>, filePath: string) =>
    folders
      .filter((folder) => filePath === folder.path || filePath.startsWith(`${folder.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null,
  inferCatalogFileKind: (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'pdb') return 'pdb';
    if (ext === 'bcif') return 'binary-cif';
    return 'mmcif';
  },
  registerWorkspaceFile: mockRegisterWorkspaceFile,
}));

import {
  __resetOpenStructureFileForTests,
  getStructureOpenCancellationDiagnosticsForTest,
  holdNextStructureReadAfterCapacityForTest,
  holdNextStructureOpenBeforeCommitForTest,
  openStructureFile,
  openStructureFileResult,
} from './openStructureFile';
import {
  getStructureFileSnapshot,
  getStructureFileSnapshotCacheDiagnostics,
} from './structure-file-snapshots';

const PDB_TEXT = 'HEADER    TEST STRUCTURE\nATOM      1  N   GLY A   1\nEND\n';

function resetCanvasStore(): void {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
    recentlyClosed: [],
  });
}

function allTabs() {
  return Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs);
}

describe('openStructureFile', () => {
  beforeEach(() => {
    resetCanvasStore();
    __resetOpenStructureFileForTests();
    useOversizedDialogStore.setState({ request: null });
    useWorkspaceStore.setState({
      folders: [{ path: '/lab/project', name: 'project', addedAt: 1 }],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    mockStat.mockReset().mockResolvedValue({
      size: PDB_TEXT.length,
      isFile: true,
      isDirectory: false,
      mtime: 123,
    });
    mockReadTextFile.mockReset().mockResolvedValue(PDB_TEXT);
    mockReadFile.mockReset();
    mockRegisterWorkspaceFile.mockReset().mockResolvedValue({ id: 'catalog-structure-1' });
  });

  it('distinguishes unavailable content, size blocking and caller cancellation', async () => {
    const options = { filePath: '/lab/project/test.pdb', label: 'Test' };
    mockStat.mockResolvedValue(null);
    expect(await openStructureFileResult(options)).toMatchObject({
      status: 'presented',
      content: 'missing',
    });
    resetCanvasStore();
    mockStat.mockResolvedValue({ size: HARD_CAP_BYTES + 1 });
    expect(await openStructureFileResult({ ...options, skipOversizedPrompt: true })).toMatchObject({
      status: 'blocked',
    });
    const controller = new AbortController();
    controller.abort();
    expect(await openStructureFileResult({ ...options, signal: controller.signal })).toMatchObject({
      status: 'cancelled',
    });
    expect(allTabs()).toEqual([]);
  });

  it('opens PDB text as one coordinate-only structure view without persisting raw coordinates', async () => {
    const tabId = await openStructureFile({
      filePath: '/lab/project/1FS0.pdb',
      label: '1FS0.pdb',
      strategy: { kind: 'focused' },
    });

    expect(tabId).toBeTruthy();
    expect(mockReadTextFile).toHaveBeenCalledWith('/lab/project/1FS0.pdb');
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockRegisterWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/lab/project/1FS0.pdb',
        entityType: 'structure',
        fileKind: 'pdb',
        workspaceRoot: '/lab/project',
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      })
    );

    const [tab] = allTabs();
    expect(tab.type).toBe('structure');
    expect(tab.label).toBe('1FS0.pdb');
    expect(tab.entityId).toBe(tab.initialStructureAttrs?.structureViewIdentity?.structureViewId);
    expect(tab.initialStructureAttrs?.structureBinding).toBeUndefined();
    expect(tab.initialStructureAttrs?.structureViewIdentity?.bindingId).toBeNull();
    expect(tab.initialStructureAttrs?.structureArtifactRef).toMatchObject({
      entityId: 'catalog-structure-1',
      artifactPath: '/lab/project/1FS0.pdb',
      format: 'pdb',
    });
    expect(JSON.stringify(tab)).not.toContain('HEADER');

    const snapshot = getStructureFileSnapshot(tab.entityId);
    expect(snapshot).toMatchObject({
      filePath: '/lab/project/1FS0.pdb',
      parser: 'pdb',
      encoding: 'text',
      data: PDB_TEXT,
    });
  });

  it('reads BinaryCIF through the binary IPC path and pins an explicit binary mmCIF snapshot', async () => {
    const uuid = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('3cd0dca8-46e7-4d72-a41c-1313a5d5501e');
    const bytes = new Uint8Array([131, 165, 100, 97, 116, 97, 1, 2, 3]);
    mockStat.mockResolvedValue({ size: bytes.length, isFile: true, isDirectory: false, mtime: 99 });
    mockReadFile.mockResolvedValue(bytes);

    await openStructureFile({
      filePath: '/lab/project/1FS0.bcif',
      label: '1FS0.bcif',
      strategy: { kind: 'focused' },
    });

    expect(mockReadFile).toHaveBeenCalledWith('/lab/project/1FS0.bcif');
    expect(mockReadTextFile).not.toHaveBeenCalled();
    const [tab] = allTabs();
    expect(tab.initialStructureAttrs?.structureArtifactRef?.format).toBe('binary-cif');
    expect(getStructureFileSnapshot(tab.entityId)).toMatchObject({
      parser: 'mmcif',
      encoding: 'binary',
      data: bytes,
    });
    uuid.mockRestore();
    expect(tab.id).toBe('3cd0dca8-46e7-4d72-a41c-1313a5d5501e');
    const thinTab = {
      id: '3cd0dca8-46e7-4d72-a41c-1313a5d5501e',
      type: 'structure',
      entityId: expect.stringMatching(/^structure-view:file:v1:[0-9a-f]{32}$/),
      label: '1FS0.bcif',
      loadStatus: 'loaded',
      initialStructureAttrs: {
        source: 'file',
        sourceId: '/lab/project/1FS0.bcif',
        coordinateFilePath: '/lab/project/1FS0.bcif',
        label: '1FS0.bcif',
        title: '1FS0.bcif',
        structureArtifactRef: {
          entityId: 'catalog-structure-1',
          revisionId: expect.stringMatching(/^structure-coordinate:file:v1:[0-9a-f]{64}$/),
          structureId: expect.stringMatching(/^structure:file:catalog-structure-1:[0-9a-f]{64}$/),
          coordinateDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          artifactPath: '/lab/project/1FS0.bcif',
          format: 'binary-cif',
        },
        structureViewIdentity: {
          schemaVersion: 1,
          structureViewId: tab.entityId,
          bindingId: null,
        },
      },
    };
    expect(tab).toEqual(thinTab);
    expect(() => expect({ ...tab, data: bytes }).toEqual(thinTab)).toThrow();
    expect(() =>
      expect({
        ...tab,
        initialStructureAttrs: { ...tab.initialStructureAttrs, data: Array.from(bytes) },
      }).toEqual(thinTab)
    ).toThrow();
    expect(() => expect({}).toEqual(thinTab)).toThrow();
  });

  it('deduplicates concurrent and repeated unchanged opens by logical view identity', async () => {
    const [first, second] = await Promise.all([
      openStructureFile({ filePath: '/lab/project/1FS0.pdb', label: '1FS0.pdb' }),
      openStructureFile({ filePath: '/lab/project/1FS0.pdb', label: '1FS0.pdb' }),
    ]);
    const third = await openStructureFile({
      filePath: '/lab/project/1FS0.pdb',
      label: '1FS0.pdb',
    });

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(allTabs()).toHaveLength(1);
  });

  it('does not register a snapshot or tab after the final open consumer aborts', async () => {
    let resolveRead!: (value: string) => void;
    mockReadTextFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const controller = new AbortController();
    const open = openStructureFile({
      filePath: '/lab/project/aborted.pdb',
      label: 'aborted.pdb',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(1));

    controller.abort();
    resolveRead(PDB_TEXT);

    await expect(open).resolves.toBeNull();
    await vi.waitFor(() => expect(allTabs()).toHaveLength(0));
    expect(mockRegisterWorkspaceFile).not.toHaveBeenCalled();
  });

  it('serializes a cancellable live successor behind an abandoned physical read', async () => {
    const readResolvers: Array<(value: string) => void> = [];
    mockReadTextFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          readResolvers.push(resolve);
        })
    );
    const controller = new AbortController();
    const abandoned = openStructureFile({
      filePath: '/lab/project/abandoned.pdb',
      label: 'abandoned.pdb',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(abandoned).resolves.toBeNull();
    expect(getStructureOpenCancellationDiagnosticsForTest().inflightCount).toBe(1);

    const cancelledRetryController = new AbortController();
    const cancelledRetry = openStructureFile({
      filePath: '/lab/project/abandoned.pdb',
      label: 'abandoned.pdb',
      signal: cancelledRetryController.signal,
    });
    cancelledRetryController.abort();
    await expect(cancelledRetry).resolves.toBeNull();
    const liveRetry = openStructureFile({
      filePath: '/lab/project/abandoned.pdb',
      label: 'abandoned.pdb',
    });
    await Promise.resolve();
    expect(mockReadTextFile).toHaveBeenCalledTimes(1);

    readResolvers[0]?.(PDB_TEXT);
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(2));
    readResolvers[1]?.(PDB_TEXT);
    await expect(liveRetry).resolves.toBeTruthy();
    await vi.waitFor(() =>
      expect(getStructureOpenCancellationDiagnosticsForTest().inflightCount).toBe(0)
    );
    expect(allTabs()).toHaveLength(1);
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
    const readResolvers: Array<(value: string) => void> = [];
    mockReadTextFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          readResolvers.push(resolve);
        })
    );
    const abandonedController = new AbortController();
    const abandoned = openStructureFile({
      filePath: '/lab/project/queued-panel.pdb',
      label: 'abandoned.pdb',
      signal: abandonedController.signal,
    });
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(1));
    abandonedController.abort();
    await expect(abandoned).resolves.toBeNull();

    const initiatorController = new AbortController();
    const initiator = openStructureFile({
      filePath: '/lab/project/queued-panel.pdb',
      label: 'initiator.pdb',
      strategy: { kind: 'panel', panelId: 'initiator' },
      signal: initiatorController.signal,
    });
    const survivor = openStructureFile({
      filePath: '/lab/project/queued-panel.pdb',
      label: 'survivor.pdb',
      strategy: { kind: 'panel', panelId: 'survivor' },
    });
    readResolvers[0]?.(PDB_TEXT);
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(2));

    initiatorController.abort();
    readResolvers[1]?.(PDB_TEXT);
    await expect(initiator).resolves.toBeNull();
    await expect(survivor).resolves.toBeTruthy();
    expect(useCanvasStore.getState().panels.initiator.tabs).toHaveLength(0);
    expect(useCanvasStore.getState().panels.survivor.tabs).toEqual([
      expect.objectContaining({ type: 'structure', label: 'survivor.pdb' }),
    ]);
  });

  it('does not start a read when the final consumer aborts after capacity admission', async () => {
    const hold = holdNextStructureReadAfterCapacityForTest();
    const controller = new AbortController();
    const open = openStructureFile({
      filePath: '/lab/project/abort-after-capacity.pdb',
      label: 'abort-after-capacity.pdb',
      signal: controller.signal,
    });

    await hold.reached;
    controller.abort();
    hold.release();

    await expect(open).resolves.toBeNull();
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it('holds shared byte capacity until an abandoned physical read settles', async () => {
    const readResolvers: Array<(value: string) => void> = [];
    mockStat.mockResolvedValue({
      size: HARD_CAP_BYTES / 2 + 1,
      isFile: true,
      isDirectory: false,
      mtime: 123,
    });
    mockReadTextFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          readResolvers.push(resolve);
        })
    );
    const firstController = new AbortController();
    const first = openStructureFile({
      filePath: '/lab/project/first-large.pdb',
      label: 'first-large.pdb',
      skipOversizedPrompt: true,
      signal: firstController.signal,
    });
    const second = openStructureFile({
      filePath: '/lab/project/second-large.pdb',
      label: 'second-large.pdb',
      skipOversizedPrompt: true,
    });
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(1));

    firstController.abort();
    await expect(first).resolves.toBeNull();
    await Promise.resolve();
    expect(mockReadTextFile).toHaveBeenCalledTimes(1);

    readResolvers[0]?.(PDB_TEXT);
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(2));
    readResolvers[1]?.(PDB_TEXT);
    await expect(second).resolves.toBeTruthy();
  });

  it('aborts a real open held immediately before snapshot and tab commit', async () => {
    const controller = new AbortController();
    const operationId = '123e4567-e89b-42d3-a456-426614174000';
    holdNextStructureOpenBeforeCommitForTest();
    const open = openStructureFile({
      filePath: '/lab/project/precommit.pdb',
      label: 'precommit.pdb',
      signal: controller.signal,
      operationId,
    });
    await vi.waitFor(() =>
      expect(getStructureOpenCancellationDiagnosticsForTest()).toMatchObject({
        inflightCount: 1,
        precommitHoldsStarted: 1,
        activePrecommitHolds: 1,
        abortedPrecommitHolds: 0,
        activePrecommitOperation: {
          operationId,
          filePath: '/lab/project/precommit.pdb',
          coordinateDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      })
    );

    controller.abort();

    await expect(open).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(getStructureOpenCancellationDiagnosticsForTest()).toMatchObject({
        inflightCount: 0,
        precommitHoldsStarted: 1,
        activePrecommitHolds: 0,
        abortedPrecommitHolds: 1,
        activePrecommitOperation: null,
        lastAbortedPrecommitOperation: {
          operationId,
          filePath: '/lab/project/precommit.pdb',
          coordinateDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      })
    );
    expect(mockRegisterWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(getStructureFileSnapshotCacheDiagnostics()).toEqual({
      viewIds: [],
      leasedViewIds: [],
      inactiveBytes: 0,
      registrationSequence: 0,
    });
    expect(allTabs()).toHaveLength(0);
  });

  it('preserves a shared structure open when another consumer remains live', async () => {
    let resolveRead!: (value: string) => void;
    mockReadTextFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const controller = new AbortController();
    const abortedConsumer = openStructureFile({
      filePath: '/lab/project/shared.pdb',
      label: 'shared.pdb',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(1));
    const liveConsumer = openStructureFile({
      filePath: '/lab/project/shared.pdb',
      label: 'shared.pdb',
    });

    controller.abort();
    resolveRead(PDB_TEXT);

    await expect(abortedConsumer).resolves.toBeNull();
    await expect(liveConsumer).resolves.toBeTruthy();
    expect(allTabs()).toHaveLength(1);
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
    let resolveRead!: (value: string) => void;
    mockReadTextFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const controller = new AbortController();
    const initiator = openStructureFile({
      filePath: '/lab/project/shared-panel.pdb',
      label: 'initiator.pdb',
      strategy: { kind: 'panel', panelId: 'initiator' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockReadTextFile).toHaveBeenCalledTimes(1));
    const survivor = openStructureFile({
      filePath: '/lab/project/shared-panel.pdb',
      label: 'survivor.pdb',
      strategy: { kind: 'panel', panelId: 'survivor' },
    });

    controller.abort();
    resolveRead(PDB_TEXT);

    await expect(initiator).resolves.toBeNull();
    await expect(survivor).resolves.toBeTruthy();
    expect(useCanvasStore.getState().panels.initiator.tabs).toHaveLength(0);
    expect(useCanvasStore.getState().panels.survivor.tabs).toEqual([
      expect.objectContaining({ type: 'structure', label: 'survivor.pdb' }),
    ]);
  });

  it('creates a new revision/view when the same catalog-owned file bytes change', async () => {
    await openStructureFile({ filePath: '/lab/project/1FS0.pdb', label: '1FS0.pdb' });
    const firstViewId = allTabs()[0].entityId;

    mockReadTextFile.mockResolvedValue(`${PDB_TEXT}REMARK changed\n`);
    await openStructureFile({ filePath: '/lab/project/1FS0.pdb', label: '1FS0.pdb' });

    expect(allTabs()).toHaveLength(2);
    expect(allTabs()[1].entityId).not.toBe(firstViewId);
    expect(allTabs()[1].initialStructureAttrs?.structureBinding).toBeUndefined();
  });

  it('turns a filesystem body-read failure into one recoverable structure error tab', async () => {
    mockReadTextFile.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    await expect(
      openStructureFile({ filePath: '/lab/project/private.pdb', label: 'private.pdb' })
    ).resolves.toBeTruthy();

    const [tab] = allTabs();
    expect(tab).toMatchObject({
      type: 'structure',
      label: 'private.pdb',
      loadStatus: 'error',
      initialStructureAttrs: {
        source: 'file',
        sourceId: '/lab/project/private.pdb',
        coordinateFilePath: '/lab/project/private.pdb',
        error: 'Coordinate file is unreadable',
        structureViewIdentity: { bindingId: null },
      },
    });
    expect(mockRegisterWorkspaceFile).not.toHaveBeenCalled();
  });

  it('blocks above the shared hard cap before any body read or tab creation', async () => {
    mockStat.mockResolvedValue({
      size: HARD_CAP_BYTES + 1,
      isFile: true,
      isDirectory: false,
      mtime: 1,
    });
    const resultPromise = openStructureFile({
      filePath: '/lab/project/huge.cif',
      label: 'huge.cif',
    });
    await vi.waitFor(() => expect(useOversizedDialogStore.getState().request?.kind).toBe('block'));
    useOversizedDialogStore.getState().resolveCurrent(false);

    await expect(resultPromise).resolves.toBeNull();
    expect(mockReadTextFile).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(allTabs()).toHaveLength(0);
  });
});
