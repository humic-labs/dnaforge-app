import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as nativeOwner from './shell-readiness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MigrationRun, ValidationReport } from '../../shared/benchling-migration';
import { BENCHLING_MIGRATION_IPC_CHANNELS } from '../../shared/benchling-migration-ipc';

const {
  ipcHandlers,
  sender,
  ownerWindow,
  browserWindowFromWebContents,
  dialogShowOpenDialog,
  assertSafePathMock,
  fileStat,
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: {
    id: 42,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  ownerWindow: { id: 7 },
  browserWindowFromWebContents: vi.fn(),
  dialogShowOpenDialog: vi.fn(),
  assertSafePathMock: vi.fn(async (path: string) => path),
  fileStat: vi.fn(async () => ({ isFile: (): boolean => true })),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: browserWindowFromWebContents },
  dialog: { showOpenDialog: dialogShowOpenDialog },
  shell: { openExternal: vi.fn(async () => undefined) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
  Notification: class MockNotification {
    static isSupported = vi.fn(() => false);
    show = vi.fn();
  },
}));

vi.mock('../boot-log', () => ({ appendBootLog: vi.fn() }));
vi.mock('../diagnostics-upload', () => ({ notifyBootSucceeded: vi.fn() }));
vi.mock('./path-allowlist', () => ({ assertSafePath: assertSafePathMock }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: { ...actual, stat: fileStat }, stat: fileStat };
});

import {
  MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS,
  MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS_PER_RENDERER,
  registerBenchlingMigrationHandlers,
  toBenchlingMigrationRunView,
  type BenchlingMigrationCoordinator,
  type BenchlingMigrationCoordinatorProgress,
} from './benchling-migration';

const scope: MigrationRun['scope'] = {
  version: 1,
  kind: 'folder',
  acquisition: 'local_bundle',
  folder: {
    id: 'local-export-folder',
    url: 'urn:dnaforge:benchling-local-export:folder:local-export-folder',
    objectType: 'folder',
  },
  includeChildren: false,
  includeArchived: false,
};

function run(overrides: Partial<MigrationRun> = {}): MigrationRun {
  return {
    version: 1,
    id: 'migration-run-a',
    workspaceId: 'workspace-a',
    workspacePath: '/private/staging/workspace-a',
    displayName: 'Local Benchling import',
    scope,
    binding: null,
    state: 'scope_planning',
    resumeState: null,
    attempt: 0,
    converterVersions: { artifact: '1' },
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    startedAt: null,
    unlockedAt: null,
    lastError: null,
    localExportArtifact: {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: 'Benchling export.zip',
      sha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 4096,
      immutableLocalPath: '/private/staging/workspace-a/.dnaforge/migration/archive/source',
      capturedAt: '2026-08-14T00:00:00.000Z',
      archive: {
        entryCount: 1,
        totalCompressedEntryBytes: 2048,
        totalUncompressedEntryBytes: 4096,
      },
      resources: [],
    },
    ...overrides,
  };
}

function coordinator(): BenchlingMigrationCoordinator & {
  emitProgress(progress: BenchlingMigrationCoordinatorProgress): void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((progress: BenchlingMigrationCoordinatorProgress) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    getActiveRun: vi.fn(async () => run()),
    listRuns: vi.fn(async () => [run()]),
    getRun: vi.fn(async () => run()),
    importLocalBundle: vi.fn(async () => run({ state: 'parsing' })),
    retryLocalBundleWithoutFailedFile: vi.fn(async () => run({ state: 'parsing' })),
    importLocalBundleToWorkspace: vi.fn(async () => run({ state: 'parsing' })),
    addLinkedItemExports: vi.fn(async () => run({ state: 'ready_to_unlock' })),
    appendWorkspaceExports: vi.fn(async () => run({ state: 'unlocked' })),
    resolveImportDecision: vi.fn(async () => run({ state: 'unlocked' })),
    resolveLinkedItemRecoveryLocation: vi.fn(
      async () => 'https://benchling.com/example/f/lib_recovery'
    ),
    start: vi.fn(async () => run({ state: 'export_pending' })),
    pause: vi.fn(async () => run({ state: 'paused', resumeState: 'export_pending' })),
    resume: vi.fn(async () => run({ state: 'export_pending' })),
    cancelPreserved: vi.fn(async () =>
      run({ state: 'cancelled_preserved', resumeState: 'export_pending' })
    ),
    startOverPreserved: vi.fn(async () => run({ state: 'failed' })),
    getReport: vi.fn(async (): Promise<ValidationReport | null> => null),
    unlock: vi.fn(async () => run({ state: 'unlocked' })),
    discard: vi.fn(async () => undefined),
    subscribeProgress: vi.fn((_runId, callback) => {
      listener = callback;
      return unsubscribe;
    }),
    emitProgress(progress) {
      listener?.(progress);
    },
    unsubscribe,
  };
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve(
    handler({ sender, senderFrame: Reflect.get(sender, 'mainFrame') }, ...args)
  );
}

function currentNativeAppendFixture(local: BenchlingMigrationCoordinator) {
  const events = new EventEmitter(),
    windowEvents = new EventEmitter();
  const frame = { url: 'file:///app/renderer/index.html' };
  Reflect.set(sender, 'mainFrame', frame);
  Reflect.set(sender, 'on', events.on.bind(events));
  sender.once.mockImplementation(events.once.bind(events));
  sender.removeListener.mockImplementation(events.removeListener.bind(events));
  Reflect.set(ownerWindow, 'webContents', sender);
  Reflect.set(ownerWindow, 'isDestroyed', () => false);
  Reflect.set(ownerWindow, 'once', windowEvents.once.bind(windowEvents));
  Reflect.apply(nativeOwner.installShellReadiness, undefined, [ownerWindow, frame.url]);
  events.emit(
    'did-start-navigation',
    { isMainFrame: true, isSameDocument: false },
    frame.url,
    false,
    true
  );
  return {
    getMainWindow: () => ownerWindow,
    coordinator: {
      ...local,
      async importLocalBundleToWorkspace(
        sourcePath: string,
        workspaceDbId: number,
        reviewedTables: Parameters<
          BenchlingMigrationCoordinator['importLocalBundleToWorkspace']
        >[2],
        admission?: { signal?: AbortSignal; assertCurrent?: () => void }
      ) {
        assert(admission?.signal instanceof AbortSignal);
        assert(!admission.signal.aborted);
        assert(typeof admission.assertCurrent === 'function');
        admission.assertCurrent();
        return reviewedTables === undefined
          ? local.importLocalBundleToWorkspace(sourcePath, workspaceDbId)
          : local.importLocalBundleToWorkspace(sourcePath, workspaceDbId, reviewedTables);
      },
    },
  };
}

describe('Benchling migration ZIP-only IPC boundary', () => {
  it('does not register completed-import Undo APIs', () => {
    registerBenchlingMigrationHandlers({ coordinator: coordinator() });
    for (const name of [
      'getImportActions',
      'previewImportUndo',
      'applyImportUndo',
      'finishPendingUndoRefreshes',
    ]) {
      expect(ipcHandlers.has(`benchlingMigration:${name}`)).toBe(false);
    }
    expect(ipcHandlers.has(BENCHLING_MIGRATION_IPC_CHANNELS.getHistory)).toBe(true);
  });
  beforeEach(() => {
    ipcHandlers.clear();
    sender.isDestroyed.mockReset();
    sender.isDestroyed.mockReturnValue(false);
    sender.send.mockReset();
    sender.once.mockReset();
    sender.removeListener.mockReset();
    browserWindowFromWebContents.mockReset();
    browserWindowFromWebContents.mockReturnValue(ownerWindow);
    dialogShowOpenDialog.mockReset();
    dialogShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    assertSafePathMock.mockReset();
    assertSafePathMock.mockImplementation(async (path: string) => path);
    fileStat.mockReset();
    fileStat.mockResolvedValue({ isFile: () => true });
  });

  it('registers exactly the local migration lifecycle channels', () => {
    registerBenchlingMigrationHandlers({ coordinator: coordinator() });

    expect([...ipcHandlers.keys()].sort()).toEqual(
      Object.values(BENCHLING_MIGRATION_IPC_CHANNELS)
        .filter((channel) => channel !== BENCHLING_MIGRATION_IPC_CHANNELS.progressChanged)
        .sort()
    );
  });

  it('sends completion only at unlocked, once, not during finalization', async () => {
    const subject = coordinator();
    const notification = vi.fn();
    vi.mocked(subject.getActiveRun).mockResolvedValue(run({ state: 'ready_to_unlock' }));
    registerBenchlingMigrationHandlers({
      coordinator: subject,
      showSystemNotification: notification,
    });
    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getActiveRun);
    expect(notification).not.toHaveBeenCalled();
    vi.mocked(subject.getActiveRun).mockResolvedValue(run({ state: 'unlocked' }));
    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getActiveRun);
    expect(notification).toHaveBeenCalledOnce();
    expect(notification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Benchling migration completed' })
    );
    vi.mocked(subject.getActiveRun).mockResolvedValue(
      run({ state: 'unlocked', updatedAt: '2026-08-14T00:10:00.000Z' })
    );
    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getActiveRun);
    expect(notification).toHaveBeenCalledOnce();
  });

  it('returns an opaque local run without filesystem paths', async () => {
    registerBenchlingMigrationHandlers({ coordinator: coordinator() });

    const activeRun = (await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getActiveRun)) as Record<
      string,
      unknown
    >;

    expect(activeRun).toMatchObject({
      id: 'migration-run-a',
      binding: null,
      localBundleState: 'ready',
      sourceArtifact: {
        kind: 'local_bundle',
        format: 'zip',
        fileName: 'Benchling export.zip',
        sizeBytes: 4096,
      },
    });
    expect(JSON.stringify(activeRun)).not.toContain('/private/staging');
    expect(activeRun).not.toHaveProperty('receiptConfirmationCandidates');
  });

  it('exposes adopted origin without inventing an initial ZIP artifact', () => {
    const view = toBenchlingMigrationRunView(
      run({
        workspaceOrigin: { kind: 'adopted_existing', workspaceDbId: 7 },
        localExportArtifact: undefined,
        state: 'unlocked',
      })
    );
    expect(view).toMatchObject({ workspaceOrigin: 'adopted_existing', localBundleState: null });
    expect(view).not.toHaveProperty('sourceArtifact');
    expect(view).not.toHaveProperty('workspaceDbId');
  });

  it('marks an external ZIP new-workspace run ready without copied source metadata', () => {
    const view = toBenchlingMigrationRunView(
      run({
        workspaceOrigin: { kind: 'migration_created' },
        localExportArtifact: undefined,
        externalZipSource: {
          schema: 'dnaforge.benchling.external-zip-source.v1',
          sourceId: 'external-source',
          originalPath: '/private/exports/source.zip',
          displayName: 'source.zip',
          zipSha256: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 100,
          selectedAt: '2026-08-29T12:00:00.000Z',
        },
      })
    );
    expect(view.localBundleState).toBe('ready');
    expect(view.localBundleMode).toBe('external_zip');
    expect(JSON.stringify(view)).not.toContain('/private/exports');
  });

  it('delegates external source viewing with identity only', async () => {
    const viewExternalSource = vi.fn().mockResolvedValue({
      status: 'source_unavailable',
      originalPath: '/Users/test/Downloads/export.zip',
      sourceDisplayName: 'export.zip',
      message: 'The original ZIP is unavailable.',
    });
    registerBenchlingMigrationHandlers({ coordinator: coordinator(), viewExternalSource });

    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.viewExternalSource, {
        workspaceId: 7,
        entityId: 'strain-1',
        sourceRecordId: 'bfi_STRAINAA',
      })
    ).resolves.toMatchObject({ status: 'source_unavailable' });
    expect(viewExternalSource).toHaveBeenCalledWith({
      workspaceId: 7,
      entityId: 'strain-1',
      sourceRecordId: 'bfi_STRAINAA',
    });
  });

  it('rejects renderer-supplied source paths before delegation', async () => {
    const viewExternalSource = vi.fn();
    registerBenchlingMigrationHandlers({ coordinator: coordinator(), viewExternalSource });

    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.viewExternalSource, {
        workspaceId: 7,
        entityId: 'strain-1',
        sourceRecordId: 'bfi_STRAINAA',
        originalPath: '/Users/test/Downloads/export.zip',
      })
    ).rejects.toThrow('fields are invalid');
    expect(viewExternalSource).not.toHaveBeenCalled();
  });

  it('passes one exact import-wide version choice to the coordinator', async () => {
    const localCoordinator = coordinator();
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.resolveImportDecision, {
        runId: 'migration-run-a',
        attemptId: 'workspace-append-1',
        decision: { kind: 'provider_version_conflict', policy: 'keep_existing' },
      })
    ).resolves.toEqual({ run: expect.objectContaining({ id: 'migration-run-a' }) });
    expect(localCoordinator.resolveImportDecision).toHaveBeenCalledWith(
      'migration-run-a',
      'workspace-append-1',
      { kind: 'provider_version_conflict', policy: 'keep_existing' }
    );
  });

  it('counts local created objects in history without sending the full catalog to the receipt', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'benchling-history-'));
    const historicalRun = run({
      workspacePath,
      state: 'unlocked',
      unlockedAt: '2026-08-14T01:00:00.000Z',
    });
    await mkdir(join(workspacePath, '.forge'), { recursive: true });
    await writeFile(
      join(workspacePath, '.forge', 'catalog.json'),
      JSON.stringify({
        schema: 'dnaforge.native-workspace-manifest.v1',
        entities: [
          {
            id: 'notebook-1',
            type: 'notebook',
            name: 'Human-readable experiment',
            path: 'Notebooks/Human-readable experiment',
            fileKind: 'waypoint-notebook',
          },
        ],
        links: [],
      })
    );
    const localCoordinator = coordinator();
    vi.mocked(localCoordinator.listRuns).mockResolvedValue([historicalRun]);
    vi.mocked(localCoordinator.getRun).mockResolvedValue(historicalRun);
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    try {
      await expect(invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getHistory)).resolves.toEqual([
        expect.objectContaining({
          run: expect.objectContaining({
            id: historicalRun.id,
            sourceArtifact: expect.objectContaining({ fileName: 'Benchling export.zip' }),
          }),
          createdObjectCount: 1,
          missingDependencyCount: 0,
        }),
      ]);
      await expect(
        invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getHistoryDetail, historicalRun.id)
      ).resolves.toEqual(
        expect.objectContaining({
          run: expect.objectContaining({ id: historicalRun.id, state: 'unlocked' }),
          report: null,
          createdObjects: [],
        })
      );
      expect(localCoordinator.getRun).not.toHaveBeenCalled();
      expect(localCoordinator.getReport).toHaveBeenCalledTimes(2);
      expect(localCoordinator.getReport).toHaveBeenNthCalledWith(1, historicalRun.id, {
        preserveRunState: true,
      });
      expect(localCoordinator.getReport).toHaveBeenNthCalledWith(2, historicalRun.id, {
        preserveRunState: true,
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('uses the validated source-entity count for local migration history', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'benchling-history-cardinality-'));
    const historicalRun = run({
      workspacePath,
      state: 'unlocked',
      unlockedAt: '2026-08-14T01:00:00.000Z',
    });
    await mkdir(join(workspacePath, '.forge'), { recursive: true });
    await writeFile(
      join(workspacePath, '.forge', 'catalog.json'),
      JSON.stringify({
        schema: 'dnaforge.native-workspace-manifest.v1',
        entities: Array.from({ length: 690 }, (_, index) => ({
          id: `entity-${index}`,
          type: 'notebook',
          name: `Entity ${index}`,
          path: `Notebooks/Entity ${index}`,
          fileKind: 'waypoint-notebook',
        })),
        links: [],
      })
    );
    const localCoordinator = coordinator();
    vi.mocked(localCoordinator.listRuns).mockResolvedValue([historicalRun]);
    vi.mocked(localCoordinator.getReport).mockResolvedValue({
      version: 2,
      sourceObjects: { actual: 663 },
    } as ValidationReport);
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    try {
      await expect(invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getHistory)).resolves.toEqual([
        expect.objectContaining({ createdObjectCount: 663 }),
      ]);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('keeps an internal adopted baseline out of visible migration history', async () => {
    const adopted = run({
      state: 'unlocked',
      unlockedAt: '2026-08-14T01:00:00.000Z',
      workspaceDbId: 28,
      repoUuid: null,
      projectionScopeId: 'ws28',
      workspaceOrigin: { kind: 'adopted_existing', workspaceDbId: 28 },
      baseline: {
        kind: 'adopted_workspace',
        adoptedAt: '2026-08-14T01:00:00.000Z',
        existingManifestSha256: null,
      },
      localExportArtifact: undefined,
      linkedItemRecovery: undefined,
    });
    const localCoordinator = coordinator();
    vi.mocked(localCoordinator.listRuns).mockResolvedValue([adopted]);
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await expect(invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getHistory)).resolves.toEqual([]);
    expect(localCoordinator.getReport).not.toHaveBeenCalled();
  });

  it('keeps healthy migration history visible when one catalog manifest is damaged', async () => {
    const healthyWorkspace = await mkdtemp(join(tmpdir(), 'benchling-history-healthy-'));
    const damagedWorkspace = await mkdtemp(join(tmpdir(), 'benchling-history-damaged-'));
    const healthyRun = run({
      id: 'migration-run-healthy',
      workspacePath: healthyWorkspace,
      state: 'unlocked',
      unlockedAt: '2026-08-14T01:00:00.000Z',
    });
    const damagedRun = run({
      id: 'migration-run-damaged',
      workspacePath: damagedWorkspace,
      state: 'unlocked',
      unlockedAt: '2026-08-14T02:00:00.000Z',
    });
    await Promise.all([
      mkdir(join(healthyWorkspace, '.forge'), { recursive: true }),
      mkdir(join(damagedWorkspace, '.forge'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(healthyWorkspace, '.forge', 'catalog.json'),
        JSON.stringify({
          schema: 'dnaforge.native-workspace-manifest.v1',
          entities: [
            {
              id: 'notebook-healthy',
              type: 'notebook',
              name: 'Healthy notebook',
              path: 'Notebooks/Healthy notebook',
              fileKind: 'waypoint-notebook',
            },
          ],
          links: [],
        })
      ),
      writeFile(join(damagedWorkspace, '.forge', 'catalog.json'), '{not valid JSON'),
    ]);
    const localCoordinator = coordinator();
    vi.mocked(localCoordinator.listRuns).mockResolvedValue([healthyRun, damagedRun]);
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    try {
      await expect(invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getHistory)).resolves.toEqual([
        expect.objectContaining({
          run: expect.objectContaining({ id: damagedRun.id }),
          createdObjectCount: 0,
        }),
        expect.objectContaining({
          run: expect.objectContaining({ id: healthyRun.id }),
          createdObjectCount: 1,
        }),
      ]);
    } finally {
      await Promise.all([
        rm(healthyWorkspace, { recursive: true, force: true }),
        rm(damagedWorkspace, { recursive: true, force: true }),
      ]);
    }
  });

  it('keeps healthy migration history visible when one validation report is unreadable', async () => {
    const healthyRun = run({
      id: 'migration-run-healthy',
      state: 'unlocked',
      unlockedAt: '2026-08-14T01:00:00.000Z',
    });
    const damagedRun = run({
      id: 'migration-run-damaged',
      state: 'unlocked',
      unlockedAt: '2026-08-14T02:00:00.000Z',
    });
    const localCoordinator = coordinator();
    vi.mocked(localCoordinator.listRuns).mockResolvedValue([healthyRun, damagedRun]);
    vi.mocked(localCoordinator.getReport).mockImplementation(async (runId) => {
      if (runId === damagedRun.id) throw new Error('Unreadable validation report');
      return null;
    });
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await expect(invoke(BENCHLING_MIGRATION_IPC_CHANNELS.getHistory)).resolves.toEqual([
      expect.objectContaining({
        run: expect.objectContaining({ id: damagedRun.id }),
        missingDependencyCount: 0,
      }),
      expect.objectContaining({
        run: expect.objectContaining({ id: healthyRun.id }),
        missingDependencyCount: 0,
      }),
    ]);
  });

  it('canonicalizes a dropped export before local intake', async () => {
    const localCoordinator = coordinator();
    assertSafePathMock.mockResolvedValue('/canonical/Benchling export.zip');
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle, {
      sourcePath: '/Users/test/Downloads/Benchling export.zip',
    });

    expect(assertSafePathMock).toHaveBeenCalledWith(
      '/Users/test/Downloads/Benchling export.zip',
      expect.objectContaining({ requireAbsolute: true })
    );
    expect(localCoordinator.importLocalBundle).toHaveBeenCalledWith(
      '/canonical/Benchling export.zip'
    );
  });

  it('passes a validated new-workspace name into local intake', async () => {
    const localCoordinator = coordinator();
    assertSafePathMock.mockResolvedValue('/canonical/Benchling export.zip');
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle, {
      sourcePath: '/Users/test/Downloads/Benchling export.zip',
      workspaceName: 'Sundew localization',
    });

    expect(localCoordinator.importLocalBundle).toHaveBeenCalledWith(
      '/canonical/Benchling export.zip',
      undefined,
      'Sundew localization'
    );
  });

  it('passes only the selected workspace row id to existing-workspace intake', async () => {
    const localCoordinator = coordinator();
    assertSafePathMock.mockResolvedValue('/canonical/Benchling export.zip');
    Reflect.apply(registerBenchlingMigrationHandlers, undefined, [
      currentNativeAppendFixture(localCoordinator),
    ]);

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle, {
      sourcePath: '/Users/test/Downloads/Benchling export.zip',
      workspaceDbId: 28,
    });

    expect(localCoordinator.importLocalBundleToWorkspace).toHaveBeenCalledWith(
      '/canonical/Benchling export.zip',
      28
    );
    expect(localCoordinator.importLocalBundle).not.toHaveBeenCalled();
  });

  it('uses the native ZIP-or-folder picker and prepares a selected folder', async () => {
    const localCoordinator = coordinator();
    const prepareLocalExportSource = vi.fn(async () => ({
      archivePath: '/app-data/prepared/folder-export.zip',
      sourceDisplayName: 'Folder export',
      managed: true,
    }));
    dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/test/Downloads/Folder export'],
    });
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator, prepareLocalExportSource });

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle);

    expect(dialogShowOpenDialog).toHaveBeenCalledWith(ownerWindow, {
      title: 'Choose a Benchling export',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Benchling ZIP exports', extensions: ['zip'] }],
    });
    expect(prepareLocalExportSource).toHaveBeenCalledWith('/Users/test/Downloads/Folder export');
    expect(localCoordinator.importLocalBundle).toHaveBeenCalledWith(
      '/app-data/prepared/folder-export.zip'
    );
  });

  it('releases a prepared folder archive after an external-ZIP import finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchling-prepared-source-'));
    const archivePath = join(root, 'folder-export.zip');
    await writeFile(archivePath, 'prepared export');
    const localCoordinator = coordinator();
    const externalZipSource: NonNullable<MigrationRun['externalZipSource']> = {
      schema: 'dnaforge.benchling.external-zip-source.v1',
      sourceId: 'external-source',
      originalPath: archivePath,
      displayName: 'folder-export.zip',
      zipSha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 15,
      selectedAt: '2026-08-31T00:00:00.000Z',
    };
    localCoordinator.importLocalBundle = vi.fn(async () =>
      run({ state: 'parsing', localExportArtifact: undefined, externalZipSource })
    );
    localCoordinator.getRun = vi.fn(async () =>
      run({ state: 'parsing', localExportArtifact: undefined, externalZipSource })
    );
    const prepareLocalExportSource = vi.fn(async () => ({
      archivePath,
      sourceDisplayName: 'Folder export',
      managed: true,
    }));
    dialogShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/test/Downloads/Folder export'],
    });
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator, prepareLocalExportSource });

    try {
      await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle);
      await expect(access(archivePath)).resolves.toBeUndefined();

      localCoordinator.emitProgress({
        run: run({ state: 'unlocked', localExportArtifact: undefined, externalZipSource }),
      });
      await vi.waitFor(async () => {
        await expect(access(archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forwards reviewed table choices to the destination coordinator', async () => {
    const localCoordinator = coordinator();
    Reflect.apply(registerBenchlingMigrationHandlers, undefined, [
      currentNativeAppendFixture(localCoordinator),
    ]);
    const reviewedTables = [
      {
        kind: 'registry_table_mapping',
        version: 1,
        source: {
          archiveSha256: 'a'.repeat(64),
          entrySha256: 'b'.repeat(64),
          entryPath: 'Records.csv',
          entrySizeBytes: 100,
        },
        outcome: { kind: 'source_only', reason: 'Keep original table' },
      },
    ];
    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle, {
      sourcePath: '/tmp/reviewed.zip',
      workspaceDbId: 7,
      reviewedTables,
    });
    expect(localCoordinator.importLocalBundleToWorkspace).toHaveBeenCalledWith(
      '/tmp/reviewed.zip',
      7,
      reviewedTables
    );
  });

  it('surveys a canonical archive path without touching migration run state', async () => {
    const localCoordinator = coordinator();
    const surveyImportDestinations = vi.fn(async () => ({
      archiveObjectCount: 3,
      candidates: [
        {
          workspaceDbId: 1,
          workspaceName: 'Ready lab',
          repoUuid: 'repo-unlocked',
          overlapCount: 2,
        },
        {
          workspaceDbId: 2,
          workspaceName: 'Still locked',
          repoUuid: 'repo-locked',
          overlapCount: 1,
        },
        {
          workspaceDbId: 3,
          workspaceName: 'Not a migration workspace',
          repoUuid: null,
          overlapCount: 0,
        },
      ],
    }));
    assertSafePathMock.mockResolvedValue('/canonical/Benchling export.zip');
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator, surveyImportDestinations });

    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.surveyImportDestinations, {
        archivePath: '/Users/test/Downloads/Benchling export.zip',
      })
    ).resolves.toEqual({
      preparedArchivePath: '/canonical/Benchling export.zip',
      sourceDisplayName: 'Benchling export.zip',
      archiveObjectCount: 3,
      candidates: expect.arrayContaining([
        expect.objectContaining({ workspaceName: 'Ready lab' }),
        expect.objectContaining({ workspaceName: 'Still locked' }),
        expect.objectContaining({ workspaceName: 'Not a migration workspace' }),
      ]),
    });
    expect(assertSafePathMock).toHaveBeenCalledWith(
      '/Users/test/Downloads/Benchling export.zip',
      expect.objectContaining({ requireAbsolute: true })
    );
    expect(surveyImportDestinations).toHaveBeenCalledWith({
      archivePath: '/canonical/Benchling export.zip',
    });
    expect(localCoordinator.listRuns).not.toHaveBeenCalled();
  });

  it('prepares an unzipped export folder before surveying it', async () => {
    const localCoordinator = coordinator();
    const prepareLocalExportSource = vi.fn(async () => ({
      archivePath: '/app-data/prepared/folder-export.zip',
      sourceDisplayName: 'Folder export',
      managed: true,
    }));
    const surveyImportDestinations = vi.fn(async () => ({
      archiveObjectCount: 45,
      candidates: [],
    }));
    assertSafePathMock.mockResolvedValue('/Users/test/Downloads/Folder export');
    registerBenchlingMigrationHandlers({
      coordinator: localCoordinator,
      prepareLocalExportSource,
      surveyImportDestinations,
    });

    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.surveyImportDestinations, {
        archivePath: '/Users/test/Downloads/Folder export',
      })
    ).resolves.toEqual({
      preparedArchivePath: '/app-data/prepared/folder-export.zip',
      sourceDisplayName: 'Folder export',
      archiveObjectCount: 45,
      candidates: [],
    });
    expect(prepareLocalExportSource).toHaveBeenCalledWith('/Users/test/Downloads/Folder export');
    expect(surveyImportDestinations).toHaveBeenCalledWith({
      archivePath: '/app-data/prepared/folder-export.zip',
    });
  });

  it('reattaches a dropped ZIP to the same run after a failed copy', async () => {
    const localCoordinator = coordinator();
    assertSafePathMock.mockResolvedValue('/canonical/Benchling export.zip');
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.importLocalBundle, {
      runId: 'migration-run-a',
      sourcePath: '/Users/test/Downloads/Benchling export.zip',
    });

    expect(localCoordinator.importLocalBundle).toHaveBeenCalledWith(
      '/canonical/Benchling export.zip',
      'migration-run-a'
    );
  });

  it('publishes and releases progress subscriptions by opaque IDs', async () => {
    const localCoordinator = coordinator();
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.subscribeProgress, {
      runId: 'migration-run-a',
      subscriptionId: 'subscription-a',
    });
    localCoordinator.emitProgress({
      run: run({ state: 'parsing' }),
      completedItems: 1,
      totalItems: 2,
    });

    expect(sender.send).toHaveBeenCalledWith(
      BENCHLING_MIGRATION_IPC_CHANNELS.progressChanged,
      expect.objectContaining({ runId: 'migration-run-a', completedItems: 1, totalItems: 2 })
    );

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.unsubscribeProgress, 'subscription-a');
    expect(localCoordinator.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('bounds progress subscriptions per renderer and re-admits after release', async () => {
    const localCoordinator = coordinator();
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });

    for (let index = 0; index < MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS_PER_RENDERER; index += 1) {
      await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.subscribeProgress, {
        runId: 'migration-run-a',
        subscriptionId: `subscription-${index}`,
      });
    }
    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.subscribeProgress, {
        runId: 'migration-run-a',
        subscriptionId: 'subscription-overflow',
      })
    ).rejects.toThrow('capacity is full for this renderer');

    await invoke(BENCHLING_MIGRATION_IPC_CHANNELS.unsubscribeProgress, 'subscription-0');
    await expect(
      invoke(BENCHLING_MIGRATION_IPC_CHANNELS.subscribeProgress, {
        runId: 'migration-run-a',
        subscriptionId: 'subscription-replacement',
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it('bounds progress subscriptions across renderer owners', async () => {
    const localCoordinator = coordinator();
    registerBenchlingMigrationHandlers({ coordinator: localCoordinator });
    const handler = ipcHandlers.get(BENCHLING_MIGRATION_IPC_CHANNELS.subscribeProgress);
    if (!handler) throw new Error('Missing progress subscription handler');

    for (let index = 0; index < MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS; index += 1) {
      const owner = {
        ...sender,
        id: 1_000 + index,
        once: vi.fn(),
        removeListener: vi.fn(),
      };
      await handler(
        { sender: owner },
        { runId: 'migration-run-a', subscriptionId: `subscription-${index}` }
      );
    }
    const overflowOwner = {
      ...sender,
      id: 9_999,
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    await expect(
      handler(
        { sender: overflowOwner },
        { runId: 'migration-run-a', subscriptionId: 'subscription-overflow' }
      )
    ).rejects.toThrow('Benchling progress subscription capacity is full');
  });

  it('maps the local artifact without its immutable path', () => {
    const view = toBenchlingMigrationRunView(run());
    expect(view.sourceArtifact?.fileName).toBe('Benchling export.zip');
    expect(JSON.stringify(view)).not.toContain('immutableLocalPath');
  });
});
