import { describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../../platform';
import type {
  BenchlingMigrationReportView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';

const telemetry = vi.hoisted(() => ({ observeWorkflowAction: vi.fn() }));

vi.mock('../../lib/workflow-telemetry', () => ({
  observeWorkflowAction: telemetry.observeWorkflowAction,
}));

import { createBenchlingMigrationWizardBridge as createConfiguredBenchlingMigrationWizardBridge } from './platform-adapter';
import { waitForWorkspaceReconcileIdle } from '../../services/workspace-reconcile-lifecycle';
function createBenchlingMigrationWizardBridge(
  platform: PlatformBridge['benchlingMigration'],
  openDialog?: PlatformBridge['dialog']['open']
) {
  return createConfiguredBenchlingMigrationWizardBridge(platform, {
    ...(openDialog ? { openDialog } : {}),
    existingWorkspaceReadiness: {
      getWorkspaceRootById: async (id: number) => (id === 28 ? '/fixture/native-root-28' : null),
      waitForWorkspaceReconcileIdle,
    },
  });
}

function run(state: BenchlingMigrationRunView['state'] = 'draft'): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    displayName: 'Local Benchling import',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: {
        id: 'local-export-pending-test',
        url: 'urn:dnaforge:benchling-local-export:pending:test',
        objectType: 'notebook',
      },
    },
    binding: null,
    state,
    resumeState: null,
    attempt: 0,
    converterVersions: {},
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    startedAt: null,
    unlockedAt: null,
    lastError: null,
    recoveryAction: null,
    localBundleState: state === 'draft' ? 'copying' : 'ready',
  };
}

describe('Benchling migration platform adapter', () => {
  it('records a non-empty unlocked import only from a user action', async () => {
    telemetry.observeWorkflowAction.mockReset();
    const completedRun = { ...run('unlocked'), updatedAt: '2026-08-14T00:01:00.000Z' };
    const detail = {
      run: completedRun,
      report: null,
      createdObjects: [
        { id: 'notebook-1', type: 'notebook' as const, name: 'Experiment', path: 'Experiment' },
      ],
    };
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: completedRun }),
      getHistoryDetail: vi.fn().mockResolvedValue(detail),
      getActiveRun: vi.fn().mockResolvedValue(completedRun),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(bridge.importLocalBundle()).resolves.toEqual(detail);
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledOnce();
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'benchling_migration',
      action: 'import',
      status: 'completed',
      resultCount: 1,
      usableResult: true,
      success: true,
      initiatedAtMs: Date.parse(completedRun.createdAt),
    });

    telemetry.observeWorkflowAction.mockClear();
    await expect(bridge.load()).resolves.toEqual(detail);
    expect(telemetry.observeWorkflowAction).not.toHaveBeenCalled();
  });

  it('records a reviewable action-required import as a usable partial result', async () => {
    telemetry.observeWorkflowAction.mockReset();
    const partialRun = {
      ...run('action_required'),
      updatedAt: '2026-08-14T00:01:00.000Z',
    };
    const report = {
      projections: { actual: 2 },
    } as unknown as BenchlingMigrationReportView;
    const platform = {
      resume: vi.fn().mockResolvedValue(partialRun),
      getReport: vi.fn().mockResolvedValue(report),
    } as unknown as PlatformBridge['benchlingMigration'];

    await expect(
      createBenchlingMigrationWizardBridge(platform).resume(partialRun.id)
    ).resolves.toEqual({
      run: partialRun,
      report,
      createdObjects: [],
    });
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledOnce();
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'benchling_migration',
      action: 'import',
      status: 'needs_action',
      resultCount: 2,
      usableResult: true,
      success: true,
      initiatedAtMs: Date.parse(partialRun.createdAt),
    });
  });

  it('records a blocked folder import even when nothing projected', async () => {
    telemetry.observeWorkflowAction.mockReset();
    const blockedRun = {
      ...run('action_required'),
      updatedAt: '2026-09-11T02:28:00.000Z',
    };
    const report = {
      projections: { actual: 0 },
    } as unknown as BenchlingMigrationReportView;
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: blockedRun }),
      getReport: vi.fn().mockResolvedValue(report),
      getHistoryDetail: vi.fn().mockResolvedValue({
        run: blockedRun,
        report,
        createdObjects: [],
      }),
    } as unknown as PlatformBridge['benchlingMigration'];

    await createBenchlingMigrationWizardBridge(platform).importLocalBundle();
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'benchling_migration',
      action: 'import',
      status: 'needs_action',
      resultCount: 0,
      usableResult: false,
      success: true,
      initiatedAtMs: Date.parse(blockedRun.createdAt),
    });
  });

  it('records a failed import so PostHog can see the miss', async () => {
    telemetry.observeWorkflowAction.mockReset();
    const failedRun = { ...run('failed'), updatedAt: '2026-09-11T02:28:00.000Z' };
    const detail = {
      run: failedRun,
      report: null,
      createdObjects: [
        { id: 'notebook-1', type: 'notebook' as const, name: 'Experiment', path: 'Experiment' },
      ],
    };
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: failedRun }),
      getHistoryDetail: vi.fn().mockResolvedValue(detail),
      getReport: vi.fn().mockResolvedValue(null),
    } as unknown as PlatformBridge['benchlingMigration'];

    await createBenchlingMigrationWizardBridge(platform).importLocalBundle();
    expect(telemetry.observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'benchling_migration',
      action: 'import',
      status: 'failed',
      resultCount: 0,
      usableResult: false,
      success: false,
      initiatedAtMs: Date.parse(failedRun.createdAt),
    });
  });

  it.each([
    { name: 'validation-only', state: 'ready_to_unlock' as const, createdObjectCount: 1 },
    { name: 'zero-item', state: 'unlocked' as const, createdObjectCount: 0 },
  ])('does not record a $name import result', async ({ state, createdObjectCount }) => {
    telemetry.observeWorkflowAction.mockReset();
    const resultRun = run(state);
    const detail = {
      run: resultRun,
      report: null,
      createdObjects: Array.from({ length: createdObjectCount }, (_, index) => ({
        id: `notebook-${index}`,
        type: 'notebook' as const,
        name: 'Experiment',
        path: 'Experiment',
      })),
    };
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: resultRun }),
      getHistoryDetail: vi.fn().mockResolvedValue(detail),
      getReport: vi.fn().mockResolvedValue(null),
    } as unknown as PlatformBridge['benchlingMigration'];

    await createBenchlingMigrationWizardBridge(platform).importLocalBundle();

    expect(telemetry.observeWorkflowAction).not.toHaveBeenCalled();
  });

  it('deduplicates the same terminal migration receipt in one bridge', async () => {
    telemetry.observeWorkflowAction.mockReset();
    const completedRun = { ...run('unlocked'), updatedAt: '2026-08-14T00:01:00.000Z' };
    const detail = {
      run: completedRun,
      report: null,
      createdObjects: [
        { id: 'notebook-1', type: 'notebook' as const, name: 'Experiment', path: 'Experiment' },
      ],
    };
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: completedRun }),
      getHistoryDetail: vi.fn().mockResolvedValue(detail),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await bridge.importLocalBundle();
    await bridge.importLocalBundle();

    expect(telemetry.observeWorkflowAction).toHaveBeenCalledOnce();
  });

  it.each(['external_zip', 'copied_artifact'] as const)(
    'requests coordinator recovery only for a finalizing %s receipt',
    async (localBundleMode) => {
      const detail = {
        run: {
          ...run('ready_to_unlock'),
          workspaceOrigin: 'migration_created' as const,
          localBundleMode,
        },
        report: null,
        createdObjects: [],
      };
      const platform = {
        getHistoryDetail: vi.fn().mockResolvedValue(detail),
        getActiveRun: vi.fn().mockResolvedValue(null),
      } as unknown as PlatformBridge['benchlingMigration'];
      await expect(
        createBenchlingMigrationWizardBridge(platform).load(detail.run.id)
      ).resolves.toEqual(detail);
      expect(platform.getActiveRun).toHaveBeenCalledTimes(
        localBundleMode === 'external_zip' ? 1 : 0
      );
    }
  );
  it('loads only the active local run', async () => {
    const activeRun = run('parsing');
    const platform = {
      getActiveRun: vi.fn().mockResolvedValue(activeRun),
    } as unknown as PlatformBridge['benchlingMigration'];

    await expect(createBenchlingMigrationWizardBridge(platform).load()).resolves.toEqual({
      run: activeRun,
      report: null,
      createdObjects: [],
    });
  });

  it('loads created objects for a live migration that just finished', async () => {
    const completedRun = run('unlocked');
    const detail = {
      run: completedRun,
      report: null,
      createdObjects: [
        { id: 'notebook-1', type: 'notebook' as const, name: 'Experiment', path: 'Experiment' },
      ],
    };
    const platform = {
      getActiveRun: vi.fn().mockResolvedValue(completedRun),
      getHistoryDetail: vi.fn().mockResolvedValue(detail),
    } as unknown as PlatformBridge['benchlingMigration'];

    await expect(createBenchlingMigrationWizardBridge(platform).load()).resolves.toEqual(detail);
    expect(platform.getHistoryDetail).toHaveBeenCalledWith(completedRun.id);
  });

  it('shows active linked-item progress without scanning every created object', async () => {
    const activeRun: BenchlingMigrationRunView = {
      ...run('unlocked'),
      unlockedAt: '2026-08-14T00:01:00.000Z',
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
        mode: 'linked_item_recovery',
        attemptId: 'large-append',
        state: 'parsing',
        selectedFileCount: 1,
        processedFileCount: 1,
        recoveredUniqueObjectCount: 0,
        repairedRelationshipCount: 0,
        retainedExistingObjectCount: 0,
        retainedExistingObjects: [],
        corroboratedExistingObjectCount: 0,
        updatedAt: '2026-08-14T00:02:00.000Z',
        work: { kind: 'read_and_classify_objects', completed: 8_192, total: 17_604 },
      },
    };
    const platform = {
      getActiveRun: vi.fn().mockResolvedValue(activeRun),
      getReport: vi.fn().mockResolvedValue(null),
      getHistoryDetail: vi.fn(),
    } as unknown as PlatformBridge['benchlingMigration'];

    await expect(createBenchlingMigrationWizardBridge(platform).load()).resolves.toEqual({
      run: activeRun,
      report: null,
      createdObjects: [],
    });
    expect(platform.getReport).toHaveBeenCalledWith(activeRun.id);
    expect(platform.getHistoryDetail).not.toHaveBeenCalled();
  });

  it('keeps the current migration visible when its ZIP picker is cancelled', async () => {
    const activeRun = run('scope_planning');
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: null }),
      getActiveRun: vi.fn().mockResolvedValue(activeRun),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    const view = await bridge.importLocalBundle(activeRun.id);

    expect(view.run).toEqual(activeRun);
    expect(platform.importLocalBundle).toHaveBeenCalledWith({ runId: activeRun.id });
    expect(platform.getActiveRun).toHaveBeenCalledOnce();
  });

  it('does not survey or import when the native ZIP picker is cancelled', async () => {
    const platform = {
      surveyImportDestinations: vi.fn(),
      importLocalBundle: vi.fn(),
    } as unknown as PlatformBridge['benchlingMigration'];
    const openDialog = vi.fn().mockResolvedValue(null);

    const bridge = createBenchlingMigrationWizardBridge(platform, openDialog);

    await expect(bridge.chooseLocalBundle()).resolves.toBeNull();
    expect(openDialog).toHaveBeenCalledWith({
      title: 'Choose a Benchling export',
      fileOrDirectory: true,
      filters: [{ name: 'Benchling ZIP exports', extensions: ['zip'] }],
    });
    expect(platform.surveyImportDestinations).not.toHaveBeenCalled();
    expect(platform.importLocalBundle).not.toHaveBeenCalled();
  });

  it('surveys a selected ZIP without copying it', async () => {
    const platform = {
      surveyImportDestinations: vi.fn().mockResolvedValue({
        preparedArchivePath: '/Users/test/Downloads/sundew_export_2.zip',
        sourceDisplayName: 'sundew_export_2.zip',
        archiveObjectCount: 663,
        candidates: [
          {
            workspaceDbId: 28,
            workspaceName: 'Sundew localization',
            repoUuid: 'repo-sundew',
            overlapCount: 412,
          },
        ],
      }),
      importLocalBundle: vi.fn(),
      appendWorkspaceExports: vi.fn(),
    } as unknown as PlatformBridge['benchlingMigration'];

    await expect(
      createBenchlingMigrationWizardBridge(platform).prepareLocalBundle(
        '/Users/test/Downloads/sundew_export_2.zip'
      )
    ).resolves.toEqual({
      sourcePath: '/Users/test/Downloads/sundew_export_2.zip',
      archiveName: 'sundew_export_2.zip',
      archiveObjectCount: 663,
      candidates: [
        {
          workspaceDbId: 28,
          workspaceName: 'Sundew localization',
          repoUuid: 'repo-sundew',
          overlapCount: 412,
        },
      ],
    });
    expect(platform.surveyImportDestinations).toHaveBeenCalledWith({
      archivePath: '/Users/test/Downloads/sundew_export_2.zip',
    });
    expect(platform.importLocalBundle).not.toHaveBeenCalled();
    expect(platform.appendWorkspaceExports).not.toHaveBeenCalled();
  });

  it('routes an existing destination through its authoritative workspace row', async () => {
    const destinationRun = run('unlocked');
    const appended = { run: destinationRun, report: null, createdObjects: [] };
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: destinationRun }),
      getHistoryDetail: vi.fn().mockResolvedValue(appended),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(
      bridge.importPreparedLocalBundle(
        {
          sourcePath: '/Users/test/Downloads/export.zip',
          archiveName: 'export.zip',
          archiveObjectCount: 3,
          candidates: [],
        },
        { kind: 'existing_workspace', workspaceDbId: 28 }
      )
    ).resolves.toEqual(appended);
    expect(platform.importLocalBundle).toHaveBeenCalledWith({
      sourcePath: '/Users/test/Downloads/export.zip',
      workspaceDbId: 28,
    });
  });

  it('routes a new destination to local-bundle intake', async () => {
    const importing = run('parsing');
    const platform = {
      importLocalBundle: vi.fn().mockResolvedValue({ run: importing }),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(
      bridge.importPreparedLocalBundle(
        {
          sourcePath: '/Users/test/Downloads/export.zip',
          archiveName: 'export.zip',
          archiveObjectCount: 3,
          candidates: [],
        },
        { kind: 'new_workspace', workspaceName: 'Sundew localization' }
      )
    ).resolves.toEqual({ run: importing, report: null, createdObjects: [] });
    expect(platform.importLocalBundle).toHaveBeenCalledWith({
      sourcePath: '/Users/test/Downloads/export.zip',
      workspaceName: 'Sundew localization',
    });
  });

  it('forwards an exact-native answer with its reviewed preconditions intact', async () => {
    const activeRun = run('unlocked');
    const decision = {
      kind: 'unbound_exact_match',
      sourceObjectId: 'seq_INCOMING1',
      candidateEntityId: 'entity-existing',
      expectedCandidateScientificSha256: `sha256:${'a'.repeat(64)}`,
      expectedBindingState: 'unbound',
      policy: 'link_existing',
    } as const;
    const platform = {
      resolveImportDecision: vi.fn().mockResolvedValue({ run: activeRun }),
      getHistoryDetail: vi.fn().mockResolvedValue({
        run: activeRun,
        report: null,
        createdObjects: [],
      }),
    } as unknown as PlatformBridge['benchlingMigration'];

    await createBenchlingMigrationWizardBridge(platform).resolveImportDecision(
      activeRun.id,
      'workspace-append-1',
      decision
    );

    expect(platform.resolveImportDecision).toHaveBeenCalledWith({
      runId: activeRun.id,
      attemptId: 'workspace-append-1',
      decision,
    });
  });

  it('clears cached local data after discard', async () => {
    const activeRun = run('scope_planning');
    const platform = {
      getActiveRun: vi.fn().mockResolvedValue(activeRun),
      discard: vi.fn().mockResolvedValue({ runId: activeRun.id, discarded: true }),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(bridge.discard(activeRun.id)).resolves.toEqual({
      run: null,
      report: null,
      createdObjects: [],
    });
    expect(platform.discard).toHaveBeenCalledWith(activeRun.id);
  });

  it('starts fresh from an unlocked migration without unlocking it again', async () => {
    const completedRun = run('unlocked');
    const platform = {
      getHistoryDetail: vi.fn().mockResolvedValue({
        run: completedRun,
        report: null,
        createdObjects: [],
      }),
      unlock: vi.fn(),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(bridge.startNewMigration(completedRun.id)).resolves.toEqual({
      run: null,
      report: null,
      createdObjects: [],
    });
    expect(platform.unlock).not.toHaveBeenCalled();
  });

  it('unlocks a ready migration before starting fresh', async () => {
    const readyRun = run('ready_to_unlock');
    const platform = {
      getHistoryDetail: vi.fn().mockResolvedValue({
        run: readyRun,
        report: null,
        createdObjects: [],
      }),
      unlock: vi.fn().mockResolvedValue({ run: run('unlocked'), workspaceId: 'workspace-1' }),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(bridge.startNewMigration(readyRun.id)).resolves.toEqual({
      run: null,
      report: null,
      createdObjects: [],
    });
    expect(platform.unlock).toHaveBeenCalledWith(readyRun.id);
  });

  it('loads a selected historical run and refreshes its created objects after recovery', async () => {
    const historicalRun = run('unlocked');
    const firstDetail = {
      run: historicalRun,
      report: null,
      createdObjects: [
        { id: 'notebook-1', type: 'notebook' as const, name: 'Experiment', path: 'Experiment' },
      ],
    };
    const recoveredDetail = {
      ...firstDetail,
      createdObjects: [
        ...firstDetail.createdObjects,
        {
          id: 'sequence-1',
          type: 'sequence' as const,
          name: 'Recovered plasmid',
          path: 'Sequences/Recovered plasmid.gb',
        },
      ],
    };
    const platform = {
      getHistoryDetail: vi
        .fn()
        .mockResolvedValueOnce(firstDetail)
        .mockResolvedValue(recoveredDetail),
      addLinkedItemExports: vi.fn().mockResolvedValue({ run: historicalRun }),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(bridge.load(historicalRun.id)).resolves.toEqual(firstDetail);
    await expect(bridge.addLinkedItemExports(historicalRun.id)).resolves.toEqual(recoveredDetail);
    expect(platform.getHistoryDetail).toHaveBeenCalledTimes(2);
  });

  it('keeps a completed migration visible when its linked-item picker is cancelled', async () => {
    const historicalRun = run('unlocked');
    const historicalDetail = {
      run: historicalRun,
      report: null,
      createdObjects: [
        { id: 'notebook-1', type: 'notebook' as const, name: 'Experiment', path: 'Experiment' },
      ],
    };
    const platform = {
      addLinkedItemExports: vi.fn().mockResolvedValue({ run: null }),
      getHistoryDetail: vi.fn().mockResolvedValue(historicalDetail),
      getActiveRun: vi.fn(),
    } as unknown as PlatformBridge['benchlingMigration'];
    const bridge = createBenchlingMigrationWizardBridge(platform);

    await expect(bridge.addLinkedItemExports(historicalRun.id)).resolves.toEqual(historicalDetail);
    expect(platform.getHistoryDetail).toHaveBeenCalledWith(historicalRun.id);
    expect(platform.getActiveRun).not.toHaveBeenCalled();
  });
});
