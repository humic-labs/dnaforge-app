import { withUserMessage, userMessage } from '@waypoint/user-messages';

import { expectToastCall } from '../../test/toast-assertions';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BenchlingMigrationReportView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import { BenchlingMigrationWizard, ImportDecisionChoiceStep } from './BenchlingMigrationWizard';
import type { BenchlingMigrationWizardBridge, BenchlingMigrationWizardView } from './types';
import { useBenchlingMigrationWizard } from './useBenchlingMigrationWizard';

const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../stores/toast-store', () => ({
  useToastStore: (
    selector: (state: { addToast: typeof toastMocks.addToast }) => unknown
  ): unknown => selector({ addToast: toastMocks.addToast }),
}));

afterEach(() => {
  toastMocks.addToast.mockReset();
});

function run(
  state: BenchlingMigrationRunView['state'],
  overrides: Partial<BenchlingMigrationRunView> = {}
): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    displayName: 'Local Benchling import',
    scope: {
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
    },
    binding: null,
    state,
    resumeState: null,
    attempt: 1,
    converterVersions: {},
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:01.000Z',
    startedAt: '2026-08-14T00:00:00.000Z',
    unlockedAt: null,
    lastError: null,
    recoveryAction: null,
    localBundleState: state === 'draft' ? 'copying' : 'ready',
    ...overrides,
  };
}

function view(runView: BenchlingMigrationRunView | null): BenchlingMigrationWizardView {
  return { run: runView, report: null };
}

function passedReport(runView: BenchlingMigrationRunView): BenchlingMigrationReportView {
  const section = { expected: 0, actual: 0, passed: true, issues: [] };
  return {
    version: 2,
    converterVersions: runView.converterVersions,
    runId: runView.id,
    scope: runView.scope,
    snapshotId: 'snapshot-1',
    generatedAt: '2026-08-14T00:01:00.000Z',
    passed: true,
    sourceObjects: section,
    attachments: section,
    memberships: section,
    relationships: {
      ...section,
      countsByClass: {
        exact: 0,
        heuristic: 0,
        ambiguous: 0,
        unresolved: 0,
        external: 0,
        source_broken: 0,
      },
    },
    projections: {
      ...section,
      native: 0,
      nativeRepresentations: { dnaSequence: 0, strain: 0, needsSequence: 0 },
      artifact: 0,
      exceptions: 0,
    },
    hashes: section,
    rendering: section,
    exportJobs: {
      ...section,
      planned: 0,
      captured: 0,
      failedWithSuccessfulReplacement: 0,
      jobs: [],
    },
    snapshotParts: {
      ...section,
      exportArchives: 0,
      targetedReads: 0,
      superseded: 0,
      parts: [],
    },
    formulas: { ...section, supported: 0, unsupported: 0, stale: 0, evidence: [] },
    nativeConversionExceptions: { ...section, evidence: [] },
    collections: {
      ...section,
      expectedMemberships: 0,
      actualMemberships: 0,
      selectedRootSourceIds: [],
      evidence: [],
    },
    providerActivity: {
      ...section,
      networkRequests: 0,
      cacheHits: 0,
      coverageGaps: 0,
      countsAreExact: true,
      networkRequestsByClass: {
        export_submit: 0,
        export_task_status: 0,
        gmail_receipt_page: 0,
        export_archive_metadata: 0,
        export_archive_range: 0,
        export_archive_download: 0,
        targeted_read: 0,
      },
      cacheHitsByClass: {
        export_submit: 0,
        export_task_status: 0,
        gmail_receipt_page: 0,
        export_archive_metadata: 0,
        export_archive_range: 0,
        export_archive_download: 0,
        targeted_read: 0,
      },
      evidence: [],
    },
    issues: [],
  };
}

function bridge(initial: BenchlingMigrationWizardView): BenchlingMigrationWizardBridge {
  return {
    load: vi.fn(async () => initial),
    subscribeProgress: vi.fn(() => () => undefined),
    importLocalBundle: vi.fn(async () => initial),
    retryWithoutFailedFile: vi.fn(async () => initial),
    chooseLocalBundle: vi.fn(async () => null),
    prepareLocalBundle: vi.fn(async (sourcePath) => ({
      sourcePath,
      archiveName: 'export.zip',
      archiveObjectCount: 0,
      candidates: [],
    })),
    importPreparedLocalBundle: vi.fn(async () => initial),
    importDroppedLocalBundle: vi.fn(async () => initial),
    addLinkedItemExports: vi.fn(async () => initial),
    appendWorkspaceExports: vi.fn(async () => initial),
    resolveImportDecision: vi.fn(async () => initial),
    openLinkedItemRecoveryLocation: vi.fn(async () => undefined),
    start: vi.fn(async () => initial),
    pause: vi.fn(async () => initial),
    cancelPreserved: vi.fn(async () => initial),
    startOverPreserved: vi.fn(async () => view(null)),
    startNewMigration: vi.fn(async () => view(null)),
    discard: vi.fn(async () => view(null)),
    resume: vi.fn(async () => initial),
    unlock: vi.fn(async () => initial),
  };
}

describe('BenchlingMigrationWizard ZIP-only surface', () => {
  it('keeps a validated native ZIP on Finishing up until the workspace is unlocked', async () => {
    const ready = run('ready_to_unlock', {
      workspaceOrigin: 'migration_created',
      localBundleMode: 'external_zip',
      localBundleState: 'ready',
    });
    const localBridge = bridge({ run: ready, report: passedReport(ready) });
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);
    await screen.findByTestId('benchling-migration-wizard');
    expect(await screen.findByText('Finishing up')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-validation-report')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open project' })).not.toBeInTheDocument();
    expect(localBridge.unlock).not.toHaveBeenCalled();
  });

  it('keeps polling a finalizing native ZIP when no completion event arrives', async () => {
    const ready = run('ready_to_unlock', {
      workspaceOrigin: 'migration_created',
      localBundleMode: 'external_zip',
    });
    const localBridge = bridge(view(ready));
    let tick: (() => void) | undefined;
    const setInterval = window.setInterval.bind(window);
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((handler, delay) => {
      if (delay === 4_000 && typeof handler === 'function') {
        tick = () => handler();
        return 0;
      }
      return setInterval(handler, delay);
    });
    try {
      const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge, ready.id));
      await waitFor(() => expect(result.current.view.run?.state).toBe('ready_to_unlock'));
      expect(tick).toBeDefined();
      localBridge.load = vi.fn(async () => view(run('unlocked')));
      await act(async () => {
        tick?.();
      });
      await waitFor(() => expect(result.current.view.run?.state).toBe('unlocked'));
      expect(localBridge.load).toHaveBeenCalledWith(ready.id);
    } finally {
      interval.mockRestore();
    }
  });

  it('does not load a prior failed run when explicitly opened for a new migration', async () => {
    const failed = run('failed', {
      lastError: {
        code: 'internal_invariant',
        message: 'Failure from an earlier migration.',
        retryable: false,
        at: '2026-08-14T00:02:00.000Z',
      },
    });
    const localBridge = bridge(view(failed));

    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge, undefined, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(localBridge.load).not.toHaveBeenCalled();
    expect(result.current.view).toEqual({ run: null, report: null, createdObjects: [] });
    expect(result.current.error).toBeNull();
  });

  it('ignores backdrop clicks and closes only from an explicit control', async () => {
    const onClose = vi.fn();
    render(<BenchlingMigrationWizard bridge={bridge(view(null))} onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('benchling-migration-backdrop'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('benchling-migration-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the unlocked action result when a progress refresh arrives during unlock', async () => {
    const ready = run('ready_to_unlock');
    const unlocked = run('unlocked', { unlockedAt: '2026-08-14T00:01:00.000Z' });
    const localBridge = bridge(view(ready));
    let resolveUnlock: ((next: BenchlingMigrationWizardView) => void) | undefined;
    let notifyProgress: Parameters<BenchlingMigrationWizardBridge['subscribeProgress']>[1] = () =>
      undefined;
    localBridge.unlock = vi.fn(
      () =>
        new Promise<BenchlingMigrationWizardView>((resolve) => {
          resolveUnlock = resolve;
        })
    );
    localBridge.load = vi
      .fn<BenchlingMigrationWizardBridge['load']>()
      .mockResolvedValueOnce(view(ready))
      .mockResolvedValue(view(null));
    localBridge.subscribeProgress = vi.fn((_runId, callback) => {
      notifyProgress = callback;
      return () => undefined;
    });

    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge));
    await waitFor(() => expect(result.current.view.run?.state).toBe('ready_to_unlock'));

    let unlockPromise: Promise<BenchlingMigrationWizardView | null> | undefined;
    await act(async () => {
      unlockPromise = result.current.unlock();
      await Promise.resolve();
    });
    await act(async () => {
      notifyProgress({
        runId: ready.id,
        run: ready,
        message: 'Migration validated and project unlocked.',
        completedItems: null,
        totalItems: null,
        warnings: [],
        sequence: 1,
        emittedAt: 1,
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolveUnlock?.(view(unlocked));
      await unlockPromise;
    });

    expect(result.current.view.run?.state).toBe('unlocked');
  });

  it('refreshes once after a blocked action fails and no progress event follows', async () => {
    const ready = run('ready_to_unlock');
    const refreshed = run('ready_to_unlock', {
      updatedAt: '2026-08-14T00:02:00.000Z',
    });
    const localBridge = bridge(view(ready));
    localBridge.unlock = vi.fn(async () => {
      throw new Error('unlock failed');
    });
    localBridge.load = vi
      .fn<BenchlingMigrationWizardBridge['load']>()
      .mockResolvedValueOnce(view(ready))
      .mockResolvedValue(view(refreshed));

    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge));
    await waitFor(() => expect(result.current.view.run?.state).toBe('ready_to_unlock'));

    await act(async () => {
      await result.current.unlock();
    });

    await waitFor(() => expect(localBridge.load).toHaveBeenCalledTimes(2));
    expect(result.current.view.run?.updatedAt).toBe(refreshed.updatedAt);
    expect(result.current.error).toBe(userMessage('benchling.failed'));
  });

  it('keeps linked-item recovery progress live while the recovery action is pending', async () => {
    const ready = run('ready_to_unlock');
    const recovering = run('ready_to_unlock', {
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        attemptId: 'attempt-1',
        state: 'parsing',
        selectedFileCount: 5,
        processedFileCount: 2,
        recoveredUniqueObjectCount: 1,
        repairedRelationshipCount: 0,
        updatedAt: '2026-08-14T00:01:00.000Z',
      },
    });
    const localBridge = bridge(view(ready));
    let notifyProgress: Parameters<BenchlingMigrationWizardBridge['subscribeProgress']>[1] = () =>
      undefined;
    let resolveRecovery: ((next: BenchlingMigrationWizardView) => void) | undefined;
    localBridge.load = vi
      .fn<BenchlingMigrationWizardBridge['load']>()
      .mockResolvedValueOnce(view(ready))
      .mockResolvedValue(view(recovering));
    localBridge.addLinkedItemExports = vi.fn(
      () =>
        new Promise<BenchlingMigrationWizardView>((resolve) => {
          resolveRecovery = resolve;
        })
    );
    localBridge.subscribeProgress = vi.fn((_runId, callback) => {
      notifyProgress = callback;
      return () => undefined;
    });

    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge));
    await waitFor(() => expect(result.current.view.run?.state).toBe('ready_to_unlock'));

    let recoveryPromise: Promise<BenchlingMigrationWizardView | null> | undefined;
    await act(async () => {
      recoveryPromise = result.current.addLinkedItemExports(['/tmp/linked-items.zip']);
      await Promise.resolve();
      notifyProgress({
        runId: ready.id,
        run: recovering,
        message: 'Reading linked items',
        completedItems: 2,
        totalItems: 5,
        warnings: [],
        sequence: 1,
        emittedAt: 1,
      });
    });

    await waitFor(() =>
      expect(result.current.view.run?.linkedItemRecovery?.processedFileCount).toBe(2)
    );
    expect(localBridge.addLinkedItemExports).toHaveBeenCalledWith(ready.id, [
      '/tmp/linked-items.zip',
    ]);

    await act(async () => {
      resolveRecovery?.(view(recovering));
      await recoveryPromise;
    });
  });

  it('shows transient byte progress and does not let a durable watchdog refresh erase it', async () => {
    const durableCopying = run('unlocked', {
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'linked_item_recovery',
        attemptId: 'attempt-large',
        state: 'copying',
        selectedFileCount: 1,
        processedFileCount: 0,
        recoveredUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-14T00:01:00.000Z',
      },
    });
    const transientCopying = run('unlocked', {
      linkedItemRecovery: {
        ...durableCopying.linkedItemRecovery!,
        startedAt: '2026-08-14T00:01:00.000Z',
        work: {
          kind: 'copy_bytes',
          completed: 1_500_000_000,
          total: 2_800_000_000,
        },
      },
    });
    const localBridge = bridge(view(durableCopying));
    let notifyProgress: Parameters<BenchlingMigrationWizardBridge['subscribeProgress']>[1] = () =>
      undefined;
    localBridge.load = vi.fn(async () => view(durableCopying));
    localBridge.subscribeProgress = vi.fn((_runId, callback) => {
      notifyProgress = callback;
      return () => undefined;
    });

    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge));
    await waitFor(() => expect(result.current.view.run?.id).toBe(durableCopying.id));

    act(() => {
      notifyProgress({
        runId: durableCopying.id,
        run: transientCopying,
        message: 'Copying linked-item export',
        completedItems: null,
        totalItems: null,
        warnings: [],
        sequence: 1,
        emittedAt: 1,
      });
    });
    expect(result.current.view.run?.linkedItemRecovery?.work).toEqual({
      kind: 'copy_bytes',
      completed: 1_500_000_000,
      total: 2_800_000_000,
    });

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.view.run?.linkedItemRecovery?.work).toEqual({
      kind: 'copy_bytes',
      completed: 1_500_000_000,
      total: 2_800_000_000,
    });

    const durableParsing = run('unlocked', {
      linkedItemRecovery: {
        ...durableCopying.linkedItemRecovery!,
        state: 'parsing',
        processedFileCount: 1,
      },
    });
    localBridge.load = vi.fn(async () => view(durableParsing));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.view.run?.linkedItemRecovery?.state).toBe('parsing');
    expect(result.current.view.run?.linkedItemRecovery?.startedAt).toBe('2026-08-14T00:01:00.000Z');
    expect(result.current.view.run?.linkedItemRecovery?.work).toBeUndefined();
  });

  it('shows one local export intake and no scope, identity, or companion controls', async () => {
    render(<BenchlingMigrationWizard bridge={bridge(view(null))} onClose={vi.fn()} />);

    expect(await screen.findByText('Drop your Benchling export here')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-choose-export')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-file-url')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-folder-url')).not.toBeInTheDocument();
    expect(screen.queryByText(/companion/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/confirm identity/iu)).not.toBeInTheDocument();
  });

  it('surveys before showing the destination and does not start an import yet', async () => {
    const localBridge = bridge(view(null));
    localBridge.chooseLocalBundle = vi.fn(async () => '/Users/test/Downloads/export.zip');
    localBridge.prepareLocalBundle = vi.fn(async () => ({
      sourcePath: '/Users/test/Downloads/export.zip',
      archiveName: 'export.zip',
      archiveObjectCount: 3,
      candidates: [
        {
          workspaceDbId: 1,
          workspaceName: 'Existing lab',
          repoUuid: 'repo-existing',
          overlapCount: 2,
        },
      ],
    }));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('benchling-migration-choose-export'));

    expect(await screen.findByTestId('benchling-import-destination-step')).toBeVisible();
    expect(screen.getByTestId('benchling-migration-wizard')).toHaveClass('w-[min(56rem,94vw)]');
    expect(localBridge.prepareLocalBundle).toHaveBeenCalledOnce();
    expect(localBridge.importPreparedLocalBundle).not.toHaveBeenCalled();
    expect(localBridge.importLocalBundle).not.toHaveBeenCalled();
  });

  it('shows a safe compatibility error without Electron IPC internals', async () => {
    const localBridge = bridge(view(null));
    localBridge.chooseLocalBundle = vi.fn(async () => '/Users/test/Downloads/legacy.zip');
    localBridge.prepareLocalBundle = vi.fn(async () => {
      throw withUserMessage(
        new Error(
          "Error invoking remote method 'benchlingMigration:surveyImportDestinations': Error: This ZIP does not include Benchling object IDs. In Benchling, export All Items as HTML and choose that ZIP."
        ),
        'benchling.invalidExport'
      );
    });
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('benchling-migration-choose-export'));

    expect(await screen.findByText(userMessage('benchling.invalidExport'))).toBeVisible();
    expect(screen.getByText(userMessage('benchling.invalidExport'))).toBeVisible();
    expect(screen.queryByText(/invoking remote method/iu)).not.toBeInTheDocument();
  });

  it('replaces the destination picker with a loading screen as soon as the import starts', async () => {
    const localBridge = bridge(view(null));
    const onClose = vi.fn();
    let resolveImport: ((next: BenchlingMigrationWizardView) => void) | undefined;
    localBridge.chooseLocalBundle = vi.fn(async () => '/Users/test/Downloads/export.zip');
    localBridge.prepareLocalBundle = vi.fn(async () => ({
      sourcePath: '/Users/test/Downloads/export.zip',
      archiveName: 'export.zip',
      archiveObjectCount: 663,
      candidates: [
        {
          workspaceDbId: 1,
          workspaceName: 'Existing lab',
          repoUuid: 'repo-existing',
          overlapCount: 551,
        },
      ],
    }));
    localBridge.importPreparedLocalBundle = vi.fn(
      () =>
        new Promise<BenchlingMigrationWizardView>((resolve) => {
          resolveImport = resolve;
        })
    );
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('benchling-migration-choose-export'));
    expect(await screen.findByTestId('benchling-import-destination-step')).toBeVisible();

    fireEvent.click(screen.getByTestId('benchling-import-confirm-destination'));

    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.getByText('Preparing your import')).toBeVisible();
    expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
    expect(screen.getByText('Keep this window open.')).toBeVisible();
    expect(screen.queryByTestId('benchling-import-destination-step')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-import-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-close')).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-wizard')).toHaveClass('w-[min(56rem,94vw)]');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveImport?.(view(null));
    });

    expect(await screen.findByTestId('benchling-migration-close')).toBeVisible();
  });

  it('distinguishes opening the picker from reading the selected export', async () => {
    const localBridge = bridge(view(null));
    let resolvePicker: ((sourcePath: string | null) => void) | undefined;
    let resolveSurvey:
      | ((
          selection: Awaited<ReturnType<BenchlingMigrationWizardBridge['prepareLocalBundle']>>
        ) => void)
      | undefined;
    localBridge.chooseLocalBundle = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePicker = resolve;
        })
    );
    localBridge.prepareLocalBundle = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSurvey = resolve;
        })
    );
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('benchling-migration-choose-export'));

    expect(await screen.findByText('Opening file picker…')).toBeVisible();
    expect(screen.queryByText('Reading your export')).not.toBeInTheDocument();
    expect(localBridge.prepareLocalBundle).not.toHaveBeenCalled();

    await act(async () => {
      resolvePicker?.('/Users/test/Downloads/export.zip');
    });

    expect(await screen.findByText('Reading your export')).toBeVisible();
    expect(localBridge.prepareLocalBundle).toHaveBeenCalledWith('/Users/test/Downloads/export.zip');

    await act(async () => {
      resolveSurvey?.({
        sourcePath: '/Users/test/Downloads/export.zip',
        archiveName: 'export.zip',
        archiveObjectCount: 3,
        candidates: [],
      });
    });

    expect(await screen.findByTestId('benchling-import-destination-step')).toBeVisible();
  });

  it('keeps the imported run after confirming a prepared destination', async () => {
    const importing = run('parsing');
    const localBridge = bridge(view(null));
    localBridge.prepareLocalBundle = vi.fn(async () => ({
      sourcePath: '/Users/test/Downloads/export.zip',
      archiveName: 'export.zip',
      archiveObjectCount: 1,
      candidates: [],
    }));
    localBridge.importPreparedLocalBundle = vi.fn(async () => view(importing));
    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.prepareLocalBundle('/Users/test/Downloads/export.zip');
    });
    expect(result.current.pendingImport?.archiveName).toBe('export.zip');

    await act(async () => {
      await result.current.importPreparedLocalBundle({
        kind: 'new_workspace',
        workspaceName: 'Export workspace',
      });
    });

    expect(localBridge.importPreparedLocalBundle).toHaveBeenCalledOnce();
    expect(result.current.view.run).toEqual(importing);
    expect(result.current.pendingImport).toBeNull();
  });

  it('reconciles a fast local import by durable run id after it leaves the active slot', async () => {
    const copying = run('scope_planning', { localBundleState: 'copying' });
    const unlocked = run('unlocked', {
      localBundleState: 'ready',
      unlockedAt: '2026-08-14T00:01:00.000Z',
    });
    const localBridge = bridge(view(null));
    let notifyStatus: Parameters<BenchlingMigrationWizardBridge['subscribeProgress']>[2] = () =>
      undefined;
    localBridge.load = vi.fn(async (runId) => (runId === copying.id ? view(unlocked) : view(null)));
    localBridge.prepareLocalBundle = vi.fn(async () => ({
      sourcePath: '/Users/test/Downloads/export.zip',
      archiveName: 'export.zip',
      archiveObjectCount: 1,
      candidates: [],
    }));
    localBridge.importPreparedLocalBundle = vi.fn(async () => view(copying));
    localBridge.subscribeProgress = vi.fn((_runId, _onProgress, onStatus) => {
      notifyStatus = onStatus;
      return () => undefined;
    });
    const { result } = renderHook(() => useBenchlingMigrationWizard(localBridge));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.prepareLocalBundle('/Users/test/Downloads/export.zip');
    });
    await act(async () => {
      await result.current.importPreparedLocalBundle({
        kind: 'new_workspace',
        workspaceName: 'Export workspace',
      });
    });
    await waitFor(() =>
      expect(localBridge.subscribeProgress).toHaveBeenCalledWith(
        copying.id,
        expect.any(Function),
        expect.any(Function)
      )
    );

    await act(async () => {
      notifyStatus('ready');
    });

    await waitFor(() => expect(result.current.view.run).toEqual(unlocked));
    expect(localBridge.load).toHaveBeenLastCalledWith(copying.id);
  });

  it('shows local copy progress without a provider connection step', async () => {
    render(<BenchlingMigrationWizard bridge={bridge(view(run('draft')))} onClose={vi.fn()} />);

    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.getByText('Preparing your import')).toBeVisible();
    expect(screen.queryByText(/companion/iu)).not.toBeInTheDocument();
  });

  it('does not offer pause or cancel while a migration is running', async () => {
    render(<BenchlingMigrationWizard bridge={bridge(view(run('parsing')))} onClose={vi.fn()} />);

    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel & preserve' })).not.toBeInTheDocument();
  });

  it('shows a blocking local ZIP error without retry or cancel controls', async () => {
    const interrupted = run('action_required', {
      resumeState: 'parsing',
      lastError: {
        code: 'migration_interrupted',
        message: 'The local ZIP could not be read completely.',
        blocking: true,
      },
    });
    render(<BenchlingMigrationWizard bridge={bridge(view(interrupted))} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-resume')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel & preserve' })).not.toBeInTheDocument();
  });

  it('shows copy progress after the ZIP run reaches scope planning', async () => {
    const copying = run('scope_planning', { localBundleState: 'copying' });
    render(<BenchlingMigrationWizard bridge={bridge(view(copying))} onClose={vi.fn()} />);

    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.getByText('Preparing your import')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-failed')).not.toBeInTheDocument();
  });

  it('keeps an active workspace append on the loading screen until its receipt is complete', async () => {
    const checking = run('unlocked', {
      unlockedAt: '2026-08-14T00:01:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'workspace_append',
        attemptId: 'workspace-append-1',
        state: 'validating',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-24T12:00:00.000Z',
        startedAt: '2026-08-24T11:59:00.000Z',
        work: {
          kind: 'validate_saved_objects',
          completed: 812,
          total: 18_025,
        },
      },
    });

    render(
      <BenchlingMigrationWizard
        bridge={bridge({ run: checking, report: passedReport(checking) })}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.getByText('Finishing up')).toBeVisible();
    expect(screen.queryByText(/saved objects checked/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Finishing up' })).not.toHaveAttribute(
      'aria-valuenow'
    );
    expect(screen.queryByText(/usually takes 10–20 seconds/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-validation-report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-import-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-close')).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-wizard')).toHaveClass('w-[min(56rem,94vw)]');
  });

  it('asks once for an import-wide policy when the first different version is found', async () => {
    const awaitingChoice = run('unlocked', {
      unlockedAt: '2026-08-14T00:01:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'workspace_append',
        attemptId: 'workspace-append-1',
        state: 'awaiting_conflict_resolution',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        versionConflictResolution: {
          kind: 'awaiting_choice',
          firstConflict: { stableId: 'seq_CONFLICT', name: 'Conflicting sequence' },
        },
        updatedAt: '2026-08-24T12:00:00.000Z',
      },
    });
    const localBridge = bridge({ run: awaitingChoice, report: passedReport(awaitingChoice) });

    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByText('Choose which versions to use')).toBeVisible();
    expect(
      screen.getByText('DNAForge will apply your choice to every different version in this import.')
    ).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-close')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Use incoming versions' }));

    await waitFor(() =>
      expect(localBridge.resolveImportDecision).toHaveBeenCalledWith(
        'run-1',
        'workspace-append-1',
        { kind: 'provider_version_conflict', policy: 'use_incoming' }
      )
    );
    expect(localBridge.resolveImportDecision).toHaveBeenCalledTimes(1);
  });

  it('notifies the host when a workspace append finishes materializing objects', async () => {
    const checking = run('unlocked', {
      unlockedAt: '2026-08-14T00:01:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'workspace_append',
        attemptId: 'workspace-append-1',
        state: 'validating',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-24T12:00:00.000Z',
      },
    });
    const completed = run('unlocked', {
      ...checking,
      linkedItemRecovery: {
        ...checking.linkedItemRecovery!,
        state: 'completed',
        recoveredUniqueObjectCount: 2,
        updatedAt: '2026-08-24T12:00:01.000Z',
      },
    });
    const completedReport = passedReport(completed);
    if (completedReport.version !== 2) throw new Error('Expected a v2 report fixture.');
    completedReport.linkedItemRecovery = {
      expected: 0,
      actual: 0,
      passed: true,
      issues: [],
      evidence: {
        schema: 'dnaforge.benchling.linked-item-recovery-validation.v1',
        organizationBaseUrl: 'https://benchling.com/example',
        relationshipCount: 0,
        uniqueTargetCount: 0,
        folderCount: 0,
        recoveredUniqueObjectCount: 2,
        remainingUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        remainingRelationshipCount: 0,
        folders: [],
        targets: [],
        attempts: [
          {
            attemptId: 'workspace-append-1',
            selectedFileCount: 1,
            acceptedFileCount: 1,
            duplicateFileCount: 0,
            rejectedFileCount: 0,
            recoveredTargetCount: 2,
            repairedRelationshipCount: 0,
            outcome: 'completed',
            completedAt: '2026-08-24T12:00:01.000Z',
          },
        ],
      },
    };
    const localBridge = bridge(view(checking));
    let finishImportedObjectsRefresh!: () => void;
    const importedObjectsRefresh = new Promise<void>((resolve) => {
      finishImportedObjectsRefresh = resolve;
    });
    const onImportedObjectsChanged = vi.fn(() => importedObjectsRefresh);
    const onOpenWorkspace = vi.fn();
    let currentView = view(checking);
    let notifyProgress: Parameters<BenchlingMigrationWizardBridge['subscribeProgress']>[1] = () =>
      undefined;
    localBridge.load = vi.fn(async () => currentView);
    localBridge.subscribeProgress = vi.fn((_runId, callback) => {
      notifyProgress = callback;
      return () => undefined;
    });

    render(
      <BenchlingMigrationWizard
        bridge={localBridge}
        onClose={vi.fn()}
        onImportedObjectsChanged={onImportedObjectsChanged}
        onOpenWorkspace={onOpenWorkspace}
      />
    );
    await screen.findByTestId('benchling-migration-progress');
    expect(onImportedObjectsChanged).not.toHaveBeenCalled();

    act(() => {
      currentView = { run: completed, report: completedReport };
      notifyProgress({
        runId: checking.id,
        run: completed,
        message: 'Project append completed.',
        completedItems: null,
        totalItems: null,
        warnings: [],
        sequence: 1,
        emittedAt: 1,
      });
    });

    await waitFor(() =>
      expect(onImportedObjectsChanged).toHaveBeenCalledExactlyOnceWith('workspace-1')
    );

    fireEvent.click(screen.getByTestId('benchling-migration-open-workspace'));
    expect(onOpenWorkspace).not.toHaveBeenCalled();

    finishImportedObjectsRefresh();
    await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1'));
  });

  it('does not allow the modal to close while a linked-item ZIP is being imported', async () => {
    const importing = run('unlocked', {
      unlockedAt: '2026-08-14T00:01:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'linked_item_recovery',
        attemptId: 'linked-item-recovery-1',
        state: 'validating',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 50,
        repairedRelationshipCount: 67,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-24T12:00:00.000Z',
        startedAt: '2026-08-24T11:59:00.000Z',
        work: {
          kind: 'validate_saved_objects',
          completed: 812,
          total: 18_025,
        },
      },
    });

    render(
      <BenchlingMigrationWizard
        bridge={bridge({ run: importing, report: passedReport(importing) })}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByTestId('benchling-migration-wizard')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-close')).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-wizard')).toHaveClass('w-[min(56rem,94vw)]');
  });

  it('shows an error instead of a completion screen when object checking fails', async () => {
    const failed = run('unlocked', {
      unlockedAt: '2026-08-14T00:01:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'workspace_append',
        attemptId: 'workspace-append-1',
        state: 'failed',
        selectedFileCount: 1,
        processedFileCount: 0,
        recoveredUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-24T12:00:00.000Z',
        errorMessage: 'The ZIP could not be checked safely.',
      },
    });

    render(
      <BenchlingMigrationWizard
        bridge={bridge({ run: failed, report: passedReport(failed) })}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText('This export could not be checked')).toBeVisible();
    expect(
      screen.getByText(
        userMessage(
          'failure.dnaforge-could-not-finish-checking-every-entity-in-this-export-your-ex'
        )
      )
    ).toBeVisible();
    expect(screen.getByTestId('benchling-migration-close')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-validation-report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-import-complete')).not.toBeInTheDocument();
  });

  it('ends a failed ZIP copy without reopening the chooser for the same run', async () => {
    const waiting = run('action_required', {
      resumeState: 'scope_planning',
      localBundleState: 'waiting_for_selection',
      lastError: {
        code: 'migration_interrupted',
        message: 'The selected ZIP could not be copied safely.',
        blocking: true,
      },
    });
    const localBridge = bridge(view(waiting));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(
      screen.queryByText('The selected ZIP could not be copied safely.')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-choose-export')).not.toBeInTheDocument();
    expect(localBridge.importLocalBundle).not.toHaveBeenCalled();
    expect(localBridge.resume).not.toHaveBeenCalled();
  });

  it('lets a failed legacy file import close without retry or discard', async () => {
    const failedLegacyRun = run('failed', {
      scope: {
        version: 1,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: 'legacy-local-entry',
          url: 'urn:dnaforge:benchling-local-export:legacy-local-entry',
          objectType: 'notebook',
        },
      },
      localBundleState: 'waiting_for_selection',
      lastError: {
        code: 'migration_interrupted',
        message: 'Choose the original ZIP export again.',
        blocking: true,
      },
    });
    const localBridge = bridge(view(failedLegacyRun));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-choose-export')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-discard-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-retry-failed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('benchling-migration-close'));
    expect(localBridge.discard).not.toHaveBeenCalled();
    expect(localBridge.importLocalBundle).not.toHaveBeenCalled();
  });

  it('shows an internal ZIP failure without in-place retry', async () => {
    const failedRun = run('failed', {
      sourceArtifact: {
        kind: 'local_bundle',
        format: 'zip',
        fileName: 'original.zip',
        sha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 1024,
      },
      lastError: {
        code: 'internal_invariant',
        message: 'Migration execution failed internally.',
        blocking: true,
      },
    });
    const localBridge = bridge(view(failedRun));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByText('Migration execution failed internally.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-retry-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-discard-failed')).not.toBeInTheDocument();
    expect(localBridge.resume).not.toHaveBeenCalled();
    expect(localBridge.discard).not.toHaveBeenCalled();
    expect(localBridge.importLocalBundle).not.toHaveBeenCalled();
  });

  it.each(['failed', 'action_required'] as const)(
    'does not show historical validation success as completion while %s',
    async (state) => {
      const current = run(state, {
        resumeState: state === 'failed' ? null : 'validating',
        localBundleMode: 'external_zip',
        sourceArtifact: {
          kind: 'local_bundle',
          format: 'zip',
          fileName: 'original.zip',
          sha256: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 1024,
        },
        lastError: {
          code: 'internal_invariant',
          message: 'Import finalization was interrupted.',
          blocking: true,
        },
      });
      const report = passedReport(current);
      if (report.version !== 2) throw new Error('Expected v2 report');
      report.nativeImport = {
        actionId: current.id,
        history: 'new_workspace',
        providerVersions: null,
        exactNativeMatches: [],
        structuralDecisions: [],
        externalSources: [
          {
            sourceId: 'external-source',
            state: 'verified_at_import',
            checkedAt: current.updatedAt,
          },
        ],
      };
      const localBridge = bridge({ run: current, report });
      render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);
      if (state === 'failed')
        expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
      else if (state === 'action_required')
        expect(await screen.findByTestId('benchling-migration-import-failed')).toBeVisible();
      else expect(await screen.findByTestId('benchling-migration-import-failed')).toBeVisible();
      if (state === 'failed' || state === 'action_required')
        expect(screen.queryByText('Import finalization was interrupted.')).not.toBeInTheDocument();
      expect(screen.queryByTestId('benchling-migration-import-complete')).not.toBeInTheDocument();
      expect(screen.queryByText('Import complete')).not.toBeInTheDocument();
      expect(screen.queryByText('Your notebook came across complete')).not.toBeInTheDocument();
      expect(screen.queryByTestId('benchling-migration-unlock')).not.toBeInTheDocument();
      expect(screen.queryByTestId('benchling-migration-open-workspace')).not.toBeInTheDocument();
      expect(report.passed).toBe(true);
      if (state === 'failed')
        expect(screen.queryByTestId('benchling-migration-retry-failed')).not.toBeInTheDocument();
    }
  );

  it('shows the appropriate failure content while failed', async () => {
    const state = 'failed' as const;
    const current = run(state, { resumeState: state === 'failed' ? null : 'validating' });
    const report = passedReport(current);
    report.passed = false;
    report.issues = [
      {
        code: 'projection_failed',
        message: 'A required notebook file is missing.',
        blocking: true,
      },
    ];
    render(
      <BenchlingMigrationWizard bridge={bridge({ run: current, report })} onClose={vi.fn()} />
    );
    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByText('A required notebook file is missing.')).not.toBeInTheDocument();
    expect(screen.getByTestId('benchling-migration-import-failed')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-validation-report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-import-complete')).not.toBeInTheDocument();
  });

  it('lets an older provider-free local migration continue without deletion', async () => {
    const legacyLocalRun = run('scope_planning', {
      scope: {
        version: 1,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: 'legacy-local-entry',
          url: 'urn:dnaforge:benchling-local-export:legacy-local-entry',
          objectType: 'notebook',
        },
      },
      localBundleState: 'ready',
    });
    const localBridge = bridge(view(legacyLocalRun));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByTestId('benchling-migration-legacy-local-ready')).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-failed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('benchling-migration-continue-local'));
    await waitFor(() => expect(localBridge.start).toHaveBeenCalledWith('run-1'));
    expect(localBridge.discard).not.toHaveBeenCalled();
  });

  it('keeps a native file-scope ZIP on automatic progress instead of flashing legacy readiness', async () => {
    const native = run('scope_planning', {
      scope: {
        version: 1,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: 'local-export-pending-native',
          url: 'urn:dnaforge:benchling-local-export:pending',
        },
      },
      localBundleMode: 'external_zip',
      localBundleState: 'ready',
    });
    render(<BenchlingMigrationWizard bridge={bridge(view(native))} onClose={vi.fn()} />);
    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.getByText('Preparing your import')).toBeVisible();
    expect(screen.queryByText('Local export is ready')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue import' })).not.toBeInTheDocument();
  });

  it('describes external ZIP intake as verification without claiming a source copy', async () => {
    render(
      <BenchlingMigrationWizard
        bridge={bridge(view(run('draft', { localBundleMode: 'external_zip' })))}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText('Preparing your import')).toBeVisible();
    expect(screen.queryByText(/making a local copy/iu)).not.toBeInTheDocument();
  });

  it('does not offer retry for a preserved native ZIP after an internal failure', async () => {
    const localBridge = bridge(
      view(
        run('failed', {
          localBundleMode: 'external_zip',
          lastError: {
            code: 'internal_invariant',
            message: 'Migration execution failed internally.',
            blocking: true,
          },
        })
      )
    );
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-retry-failed')).not.toBeInTheDocument();
    expect(localBridge.resume).not.toHaveBeenCalled();
    expect(localBridge.discard).not.toHaveBeenCalled();
  });

  it('does not offer in-place retry for a blocked local ZIP', async () => {
    const actionRun = run('action_required', {
      resumeState: 'parsing',
      lastError: {
        code: 'migration_interrupted',
        message: 'The local ZIP could not be read completely.',
        blocking: true,
      },
    });
    const localBridge = bridge(view(actionRun));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-resume')).not.toBeInTheDocument();
    expect(localBridge.resume).not.toHaveBeenCalled();
  });

  it('does not ask the user to discard a blocked local ZIP', async () => {
    const actionRun = run('action_required', {
      resumeState: 'parsing',
      lastError: {
        code: 'migration_interrupted',
        message: 'The local ZIP could not be read completely.',
        blocking: true,
      },
    });
    const localBridge = bridge(view(actionRun));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByTestId('benchling-migration-discard')).not.toBeInTheDocument();
    expect(localBridge.discard).not.toHaveBeenCalled();
    expect(localBridge.resume).not.toHaveBeenCalled();
  });

  it('shows a compact terminal validation failure with the offending file', async () => {
    const failed = run('failed', {
      localBundleMode: 'external_zip',
      lastError: {
        code: 'validation_failed',
        message: 'Product routing selected sequence, not text.',
        blocking: true,
        sourceObjectId: 'seq_BADSEQ12',
        sourceFileName: 'Bad sequence (seq_BADSEQ12).gb',
      },
    });
    const report = passedReport(failed);
    report.passed = false;
    report.issues = [
      {
        code: 'validation_failed',
        message: 'Product routing selected sequence, not text.',
        blocking: true,
        sourceObjectId: 'seq_BADSEQ12',
      },
    ];
    const onClose = vi.fn();
    const localBridge = bridge({ run: failed, report });
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={onClose} />);

    await screen.findByTestId('benchling-migration-validation-failed');
    expect(screen.getByRole('heading', { name: 'Import failed' })).toHaveClass('text-error');
    expect(screen.getByText('on')).toBeVisible();
    expect(screen.getByText('Bad sequence (seq_BADSEQ12).gb')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Try again without this file' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Import failed');
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'on Bad sequence (seq_BADSEQ12).gb'
    );
    expect(screen.queryByText('Migrate from Benchling')).not.toBeInTheDocument();
    expect(screen.queryByText('Validation failed')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Product routing selected sequence, not text.')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('What this import changed')).not.toBeInTheDocument();
    expect(screen.queryByText('Some of your notebook did not come across')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-retry-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-discard-failed')).not.toBeInTheDocument();
    expect(localBridge.resume).not.toHaveBeenCalled();
    expect(localBridge.discard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('benchling-migration-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows only a generic failure when no file is identified', async () => {
    const failed = run('failed', {
      lastError: {
        code: 'validation_failed',
        message: 'The export could not be verified.',
        blocking: true,
      },
    });
    render(<BenchlingMigrationWizard bridge={bridge(view(failed))} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Import failed' })).toBeVisible();
    expect(screen.queryByText('The export could not be verified.')).not.toBeInTheDocument();
    expect(screen.queryByText('on')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Try again without this file' })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-retry-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('benchling-migration-discard-failed')).not.toBeInTheDocument();
  });

  it('keeps the import progress visible while file fallback continues automatically', async () => {
    const failed = run('failed', {
      localBundleMode: 'external_zip',
      bestEffortRecoveryPending: true,
      lastError: {
        code: 'validation_failed',
        message: 'Validation failed.',
        blocking: true,
        sourceObjectId: 'seq_BADSEQ12',
        sourceFileName: 'Bad sequence (seq_BADSEQ12).gb',
      },
    });
    const localBridge = bridge(view(failed));
    render(<BenchlingMigrationWizard bridge={localBridge} onClose={vi.fn()} />);

    expect(await screen.findByTestId('benchling-migration-progress')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Import failed' })).not.toBeInTheDocument();
    expect(localBridge.retryWithoutFailedFile).not.toHaveBeenCalled();
  });

  it('explains that an active local import continues after the modal closes', async () => {
    const onClose = vi.fn();
    render(<BenchlingMigrationWizard bridge={bridge(view(run('parsing')))} onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('benchling-migration-close'));

    expect(onClose).toHaveBeenCalledOnce();
    expectToastCall(
      toastMocks.addToast,
      expect.stringContaining('Migration continues in the background'),
      'info'
    );
  });

  it('does not offer a new migration action from a completed run', async () => {
    const completed = run('unlocked', { unlockedAt: '2026-08-14T00:01:00.000Z' });
    const localBridge = bridge(view(completed));
    render(
      <BenchlingMigrationWizard
        bridge={localBridge}
        onClose={vi.fn()}
        selectedRunId={completed.id}
      />
    );

    await screen.findByTestId('benchling-migration-wizard');
    expect(screen.queryByTestId('benchling-migration-start-new')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a new migration' })).not.toBeInTheDocument();
  });

  it.each(['provider', 'native-zip'] as const)(
    'opens the %s notebook with one click and stays pending through unlock and navigation',
    async (source) => {
      const providerScope = {
        version: 1 as const,
        kind: 'file' as const,
        source: { id: 'entry-1', url: 'https://example.benchling.com/entry-1' },
      };
      const ready = run('ready_to_unlock', {
        scope:
          source === 'provider'
            ? providerScope
            : {
                ...providerScope,
                acquisition: 'local_bundle',
                source: {
                  id: 'local-export',
                  url: 'urn:dnaforge:benchling-local-export:file:local-export',
                },
              },
        workspaceOrigin: 'migration_created',
        localBundleState: source === 'provider' ? null : 'ready',
      });
      const unlocked = {
        ...ready,
        state: 'unlocked' as const,
        unlockedAt: '2026-08-14T00:01:00.000Z',
      };
      const readyView = { run: ready, report: passedReport(ready) };
      const unlockedView = { run: unlocked, report: passedReport(unlocked) };
      if (source === 'native-zip') {
        for (const report of [readyView.report, unlockedView.report]) {
          if (report.version !== 2) throw new Error('Expected v2 report.');
          report.nativeImport = {
            actionId: ready.id,
            history: 'new_workspace',
            providerVersions: null,
            exactNativeMatches: [],
            structuralDecisions: [],
            externalSources: [
              {
                sourceId: 'external-source',
                state: 'verified_at_import',
                checkedAt: ready.updatedAt,
              },
            ],
          };
        }
      }
      const localBridge = bridge(readyView);
      let finishUnlock: (value: BenchlingMigrationWizardView) => void = () => undefined;
      localBridge.unlock = vi.fn(
        () =>
          new Promise((resolve) => {
            finishUnlock = resolve;
          })
      );
      let finishOpen: () => void = () => undefined;
      const onOpenWorkspace = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishOpen = resolve;
          })
      );
      render(
        <BenchlingMigrationWizard
          bridge={localBridge}
          onClose={vi.fn()}
          onOpenWorkspace={onOpenWorkspace}
        />
      );

      fireEvent.click(await screen.findByTestId('benchling-migration-unlock'));

      await waitFor(() => expect(localBridge.unlock).toHaveBeenCalledWith(ready.id));
      expect(onOpenWorkspace).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Opening' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Opening' }));
      expect(localBridge.unlock).toHaveBeenCalledOnce();
      await act(async () => finishUnlock(unlockedView));
      await waitFor(() =>
        source === 'native-zip'
          ? expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith(ready.workspaceId, [
              'external-source',
            ])
          : expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith(ready.workspaceId)
      );
      expect(screen.getByRole('button', { name: 'Opening' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Opening' }));
      expect(onOpenWorkspace).toHaveBeenCalledOnce();
      await act(async () => finishOpen());
      expect(screen.getByTestId('benchling-migration-open-workspace')).toBeEnabled();
      expect(screen.getByTestId('benchling-migration-wizard')).toHaveClass('w-[min(56rem,94vw)]');
    }
  );

  it('does not open the notebook when finalization fails and allows a retry', async () => {
    const ready = run('ready_to_unlock', {
      scope: {
        version: 1,
        kind: 'file',
        source: { id: 'entry-1', url: 'https://example.benchling.com/entry-1' },
      },
      localBundleState: null,
    });
    const localBridge = bridge({ run: ready, report: passedReport(ready) });
    localBridge.unlock = vi.fn(async () => {
      throw withUserMessage(new Error('Finalization failed'), 'guidance.finalization-failed');
    });
    const onOpenWorkspace = vi.fn();
    render(
      <BenchlingMigrationWizard
        bridge={localBridge}
        onClose={vi.fn()}
        onOpenWorkspace={onOpenWorkspace}
      />
    );
    fireEvent.click(await screen.findByTestId('benchling-migration-unlock'));
    await screen.findByText('Finalization failed');
    expect(onOpenWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId('benchling-migration-unlock')).toBeEnabled();
  });

  it('shows an opening error and clears pending so a completed notebook can be retried', async () => {
    const unlocked = run('unlocked', {
      scope: {
        version: 1,
        kind: 'file',
        source: { id: 'entry-1', url: 'https://example.benchling.com/entry-1' },
      },
      localBundleState: null,
    });
    const localBridge = bridge({ run: unlocked, report: passedReport(unlocked) });
    const onOpenWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error('Could not load notebook'))
      .mockResolvedValue(undefined);
    render(
      <BenchlingMigrationWizard
        bridge={localBridge}
        onClose={vi.fn()}
        onOpenWorkspace={onOpenWorkspace}
      />
    );
    fireEvent.click(await screen.findByTestId('benchling-migration-open-workspace'));
    await screen.findByText(userMessage('benchling.openFailed'));
    expect(screen.getByTestId('benchling-migration-open-workspace')).toBeEnabled();
    fireEvent.click(screen.getByTestId('benchling-migration-open-workspace'));
    await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Could not load notebook')).not.toBeInTheDocument();
    expect(localBridge.unlock).not.toHaveBeenCalled();
  });

  it('notifies the host when a pending run opened from history becomes unlocked', async () => {
    const ready = run('ready_to_unlock');
    const unlocked = run('unlocked', { unlockedAt: '2026-08-14T00:01:00.000Z' });
    const localBridge = bridge(view(ready));
    const onUnlocked = vi.fn();
    const onOpenWorkspace = vi.fn();
    let currentView = view(ready);
    let notifyProgress: Parameters<BenchlingMigrationWizardBridge['subscribeProgress']>[1] = () =>
      undefined;
    localBridge.load = vi.fn(async () => currentView);
    localBridge.subscribeProgress = vi.fn((_runId, callback) => {
      notifyProgress = callback;
      return () => undefined;
    });
    render(
      <BenchlingMigrationWizard
        bridge={localBridge}
        onClose={vi.fn()}
        onUnlocked={onUnlocked}
        onOpenWorkspace={onOpenWorkspace}
        selectedRunId={ready.id}
      />
    );
    await screen.findByText('Validation report unavailable');

    act(() => {
      currentView = view(unlocked);
      notifyProgress({
        runId: ready.id,
        run: unlocked,
        message: 'Migration validated and project unlocked.',
        completedItems: null,
        totalItems: null,
        warnings: [],
        sequence: 1,
        emittedAt: 1,
      });
    });

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith('workspace-1'));
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it('does not reopen a historical run that was already unlocked', async () => {
    const completed = run('unlocked', { unlockedAt: '2026-08-14T00:01:00.000Z' });
    const onUnlocked = vi.fn();
    render(
      <BenchlingMigrationWizard
        bridge={bridge(view(completed))}
        onClose={vi.fn()}
        onUnlocked={onUnlocked}
        selectedRunId={completed.id}
      />
    );

    await screen.findByText('Validation report unavailable');
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('explains an exact native match and emits the object-scoped link choice', () => {
    const onChoose = vi.fn(async () => undefined);
    const hash = `sha256:${'a'.repeat(64)}` as const;
    render(
      <ImportDecisionChoiceStep
        decision={{
          kind: 'unbound_exact_match',
          sourceObjectId: 'seq_INCOMING1',
          sourceDisplayName: 'Benchling sequence',
          candidateEntityId: 'native-sequence',
          candidateDisplayName: 'Existing sequence',
          expectedCandidateScientificSha256: hash,
        }}
        pending={false}
        onChoose={onChoose}
      />
    );

    expect(screen.getByText(/same scientific content/i)).toBeVisible();
    expect(screen.getByText(/identities are not linked yet/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Link existing item' }));
    expect(onChoose).toHaveBeenCalledWith({
      kind: 'unbound_exact_match',
      sourceObjectId: 'seq_INCOMING1',
      candidateEntityId: 'native-sequence',
      expectedCandidateScientificSha256: hash,
      expectedBindingState: 'unbound',
      policy: 'link_existing',
    });
  });

  it('shows an exact structural path and never offers replacement for protected roots', () => {
    const onChoose = vi.fn(async () => undefined);
    render(
      <ImportDecisionChoiceStep
        decision={{
          kind: 'structural_path_conflict',
          relativePath: '.dnaforge/migration',
          incomingKind: 'file',
          expectedExistingState: {
            kind: 'directory',
            treeSha256: `sha256:${'b'.repeat(64)}`,
          },
          replaceAllowed: true,
        }}
        pending={false}
        onChoose={onChoose}
      />
    );

    expect(screen.getByText('.dnaforge/migration')).toBeVisible();
    expect(screen.getByText(/incoming file conflicts with an existing directory/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rename incoming' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel import' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Replace existing' })).not.toBeInTheDocument();
  });
});
