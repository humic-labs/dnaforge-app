import { describe, expect, it, vi } from 'vitest';
import type {
  BenchlingMigrationHistorySummaryView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import { buildBenchlingMigrationSettingsView } from './migration-settings-adapter';
import type { BenchlingMigrationStatusSnapshot } from './useBenchlingMigrationStatus';

function makeRun(
  state: BenchlingMigrationRunView['state'],
  overrides: Partial<BenchlingMigrationRunView> = {}
): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-settings',
    workspaceId: 'workspace-settings',
    displayName: 'Notebook migration',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: {
        id: 'local-export-pending-1',
        url: 'urn:dnaforge:benchling-local-export:pending:1',
        objectType: 'notebook',
      },
    },
    binding: null,
    state,
    resumeState: null,
    attempt: 1,
    converterVersions: {},
    createdAt: '2026-08-17T17:00:00.000Z',
    updatedAt: '2026-08-17T17:01:00.000Z',
    startedAt: '2026-08-17T17:00:30.000Z',
    unlockedAt: null,
    lastError: null,
    recoveryAction: null,
    localBundleState: 'ready',
    ...overrides,
  };
}

function snapshot(
  run: BenchlingMigrationRunView | null,
  overrides: Partial<BenchlingMigrationStatusSnapshot> = {}
): BenchlingMigrationStatusSnapshot {
  return {
    run,
    message: null,
    completedItems: null,
    totalItems: null,
    warnings: [],
    error: null,
    ...overrides,
  };
}

function build(
  status: BenchlingMigrationStatusSnapshot,
  history: readonly BenchlingMigrationHistorySummaryView[] = []
) {
  return buildBenchlingMigrationSettingsView({
    snapshot: status,
    history,
    historyError: null,
    onStart: vi.fn(),
    onOpenActive: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onImportMissingDependencies: vi.fn(),
  });
}

describe('Benchling migration settings adapter', () => {
  it('keeps a validated native ZIP in progress until finalization succeeds', () => {
    const ready = makeRun('ready_to_unlock', {
      workspaceOrigin: 'migration_created',
      localBundleMode: 'external_zip',
    });
    expect(build(snapshot(ready)).activeMigration).toMatchObject({
      phase: 'Finishing up',
      tone: 'progress',
      eta: 'No time estimate',
    });
    expect(
      build(snapshot(null), [{ run: ready, createdObjectCount: 1, missingDependencyCount: 0 }])
        .history[0]
    ).toMatchObject({
      stateLabel: 'Finishing up',
      workspaceAction: { kind: 'unavailable' },
    });
  });

  it('contributes Benchling as one provider-neutral migration source', () => {
    const view = build(snapshot(null));

    expect(view.sources).toEqual([
      expect.objectContaining({
        id: 'benchling',
        name: 'Benchling',
        description: 'Import notebooks and their linked scientific entities from a Benchling ZIP.',
      }),
    ]);
    expect(view.activeMigration).toBeNull();
  });

  it('maps active progress and warnings without inventing a time estimate', () => {
    const view = build(
      snapshot(makeRun('validating'), {
        completedItems: 44,
        totalItems: 45,
        warnings: ['One linked item is missing.'],
        message: 'Checking native objects.',
      })
    );

    expect(view.activeMigration).toEqual(
      expect.objectContaining({
        sourceId: 'benchling',
        sourceName: 'Benchling',
        phase: 'Checking imported objects',
        completed: '44 of 45',
        eta: 'No time estimate',
        warnings: ['One linked item is missing.'],
        tone: 'progress',
      })
    );
  });

  it('maps completed runs to source-labelled history records', () => {
    const historicalRun = makeRun('unlocked', {
      id: 'run-history',
      unlockedAt: '2026-08-17T18:00:00.000Z',
      sourceArtifact: {
        kind: 'local_bundle',
        format: 'zip',
        fileName: 'Notebook export.zip',
        sha256: `sha256:${'a'.repeat(64)}`,
        sizeBytes: 4096,
      },
    });
    const view = build(snapshot(null), [
      { run: historicalRun, createdObjectCount: 46, missingDependencyCount: 39 },
    ]);

    expect(view.history).toEqual([
      expect.objectContaining({
        id: 'run-history',
        sourceId: 'benchling',
        sourceName: 'Benchling',
        title: 'Notebook export.zip',
        stateLabel: 'Completed',
        createdObjectCount: 46,
        workspaceAction: expect.objectContaining({ kind: 'available' }),
        missingDependencies: expect.objectContaining({ kind: 'available', count: 39 }),
      }),
    ]);
  });

  it('keeps leftover action_required as Current migration when later history exists', () => {
    const leftover = makeRun('action_required', {
      id: 'leftover-blocked',
      lastError: {
        code: 'validation_failed',
        message: 'Local export validation found 1 blocking issue(s).',
        blocking: true,
      },
    });
    const completed = makeRun('unlocked', {
      id: 'later-import',
      unlockedAt: '2026-08-17T18:00:00.000Z',
    });
    const view = build(
      snapshot(leftover, {
        warnings: ['Local export validation found 1 blocking issue(s).'],
      }),
      [
        { run: completed, createdObjectCount: 2, missingDependencyCount: 0 },
        { run: leftover, createdObjectCount: 0, missingDependencyCount: 0 },
      ]
    );

    expect(view.activeMigration).toMatchObject({
      id: leftover.id,
      phase: 'Action required',
      eta: 'Waiting for action',
      tone: 'error',
    });
    expect(view.history.map((entry) => entry.id)).toEqual([completed.id]);
  });

  it('does not duplicate the active run in history', () => {
    const active = makeRun('validating');
    const view = build(snapshot(active), [
      { run: active, createdObjectCount: 0, missingDependencyCount: 2 },
    ]);

    expect(view.activeMigration?.id).toBe(active.id);
    expect(view.history).toEqual([]);
  });

  it('moves a completed observed run into history instead of keeping it active', () => {
    const completed = makeRun('unlocked');
    const view = build(snapshot(completed), [
      { run: completed, createdObjectCount: 3, missingDependencyCount: 1 },
    ]);

    expect(view.activeMigration).toBeNull();
    expect(view.history).toHaveLength(1);
    expect(view.history[0]?.id).toBe(completed.id);
  });

  it('reopens the exact active run through durable history detail', () => {
    const active = makeRun('validating');
    const onOpenActive = vi.fn();
    const onOpenHistory = vi.fn();
    const view = buildBenchlingMigrationSettingsView({
      snapshot: snapshot(active),
      history: [],
      historyError: null,
      onStart: vi.fn(),
      onOpenActive,
      onOpenHistory,
      onOpenWorkspace: vi.fn(),
      onImportMissingDependencies: vi.fn(),
    });

    view.activeMigration?.onOpen();

    expect(onOpenHistory).toHaveBeenCalledWith(active.id);
    expect(onOpenActive).not.toHaveBeenCalled();
  });

  it('routes completed history actions to the exact workspace and migration run', () => {
    const historicalRun = makeRun('unlocked', { id: 'run-history' });
    const onOpenWorkspace = vi.fn();
    const onImportMissingDependencies = vi.fn();
    const view = buildBenchlingMigrationSettingsView({
      snapshot: snapshot(null),
      history: [{ run: historicalRun, createdObjectCount: 4, missingDependencyCount: 2 }],
      historyError: null,
      onStart: vi.fn(),
      onOpenActive: vi.fn(),
      onOpenHistory: vi.fn(),
      onOpenWorkspace,
      onImportMissingDependencies,
    });
    const entry = view.history[0];

    if (entry?.workspaceAction.kind === 'available') entry.workspaceAction.onOpen();
    if (entry?.missingDependencies.kind === 'available') entry.missingDependencies.onImport();

    expect(onOpenWorkspace).toHaveBeenCalledWith(historicalRun.workspaceId);
    expect(onImportMissingDependencies).toHaveBeenCalledWith(historicalRun.id);
  });

  it('keeps setup and scope planning labels idle until execution starts', () => {
    expect(build(snapshot(makeRun('draft'))).activeMigration?.phase).toBe('Setup');
    expect(build(snapshot(makeRun('scope_planning'))).activeMigration?.phase).toBe('Review scope');
  });

  it('tells the user when a local import is waiting for its export file', () => {
    const view = build(
      snapshot(makeRun('scope_planning', { localBundleState: 'waiting_for_selection' }))
    );

    expect(view.activeMigration).toEqual(
      expect.objectContaining({
        phase: 'Waiting for export',
        eta: 'Waiting for ZIP',
        tone: 'warning',
      })
    );
  });

  it('keeps failures visible in Settings without a top-bar status control', () => {
    const view = build(snapshot(makeRun('failed'), { error: 'IPC status read failed.' }));

    expect(view.activeMigration).toEqual(
      expect.objectContaining({
        phase: 'Status unavailable',
        warnings: ['IPC status read failed.'],
        tone: 'error',
      })
    );
  });
});
