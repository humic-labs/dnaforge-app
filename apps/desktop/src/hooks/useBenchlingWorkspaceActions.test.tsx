/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BenchlingMigrationHistorySummaryView,
  BenchlingMigrationRunView,
} from '../shared/benchling-migration-ipc';
import type { BenchlingMigrationStatusSnapshot } from '../features/benchling-migration';

vi.mock('../platform', () => ({ platform: () => ({}) }));
vi.mock('../db/workspace-catalog', () => ({ getCatalogEntityForFilePath: vi.fn() }));
vi.mock('../features/document-opening/open-document', () => ({ openDocument: vi.fn() }));
vi.mock('../features/document-opening/compat', () => ({ openSequenceFile: vi.fn() }));
vi.mock('../features/page', () => ({
  usePageStore: { getState: () => ({ refreshNewPages: vi.fn() }) },
}));

import {
  useBenchlingWorkspaceActions,
  type BenchlingWorkspaceActionsOptions,
} from './useBenchlingWorkspaceActions';

function makeRun(
  id: string,
  state: BenchlingMigrationRunView['state'],
  overrides: Partial<BenchlingMigrationRunView> = {}
): BenchlingMigrationRunView {
  return {
    version: 1,
    id,
    workspaceId: `workspace-${id}`,
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
    unlockedAt: state === 'unlocked' ? '2026-08-17T17:02:00.000Z' : null,
    lastError: null,
    recoveryAction: null,
    localBundleState: 'ready',
    ...overrides,
  };
}

function snapshot(
  run: BenchlingMigrationRunView | null,
  error: string | null = null
): BenchlingMigrationStatusSnapshot {
  return { run, message: null, completedItems: null, totalItems: null, warnings: [], error };
}

const unlocked: BenchlingMigrationHistorySummaryView = {
  run: makeRun('run-unlocked', 'unlocked'),
  createdObjectCount: 3,
  missingDependencyCount: 2,
};

function options(
  status: BenchlingMigrationStatusSnapshot,
  showBenchlingMigration = vi.fn(),
  openBenchlingMigration = vi.fn()
): BenchlingWorkspaceActionsOptions {
  return {
    refreshBenchlingMigrationHistory: vi.fn(async () => {}),
    dispatchBenchlingMigrationSession: vi.fn(),
    closeBenchlingMigration: vi.fn(),
    clearBenchlingMigrationStatus: vi.fn(),
    openBenchlingMigration,
    showBenchlingMigration,
    benchlingMigrationStatus: status,
    benchlingMigrationHistory: [unlocked],
    benchlingMigrationHistoryError: null,
    refreshWorkspaceLibrary: vi.fn(async () => {}),
    handleViewChange: vi.fn(),
    setProjectHomePath: vi.fn(),
    openWorkspaceSource: vi.fn(async () => true),
  };
}

describe('Benchling workspace actions open the migration wizard', () => {
  it('opens each settings action through showBenchlingMigration with its session event', () => {
    const show = vi.fn();
    const start = vi.fn();
    const { result } = renderHook(() =>
      useBenchlingWorkspaceActions(options(snapshot(null, 'status refused'), show, start))
    );
    const view = result.current.migrationSettings;

    view.sources[0]?.onStart();
    expect(start).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();

    view.activeMigration?.onOpen();
    expect(show).toHaveBeenLastCalledWith({ type: 'active_migration_opened' });

    const entry = view.history[0];
    entry?.onOpenDetails();
    expect(show).toHaveBeenLastCalledWith({ type: 'history_opened', runId: 'run-unlocked' });

    if (entry?.missingDependencies.kind !== 'available') {
      throw new Error('expected importable missing dependencies');
    }
    entry.missingDependencies.onImport();
    expect(show).toHaveBeenLastCalledWith({
      type: 'missing_dependencies_opened',
      runId: 'run-unlocked',
    });
    expect(show).toHaveBeenCalledTimes(3);
  });

  it('opens a running migration by its run id', () => {
    const show = vi.fn();
    const { result } = renderHook(() =>
      useBenchlingWorkspaceActions(options(snapshot(makeRun('run-active', 'downloading')), show))
    );

    result.current.migrationSettings.activeMigration?.onOpen();

    expect(show).toHaveBeenCalledExactlyOnceWith({ type: 'history_opened', runId: 'run-active' });
  });

  it('keeps the settings view identity across renders with the same inputs', () => {
    const initial = options(snapshot(null, 'status refused'));
    const { result, rerender } = renderHook((props) => useBenchlingWorkspaceActions(props), {
      initialProps: initial,
    });
    const view = result.current.migrationSettings;

    rerender({ ...initial });

    expect(result.current.migrationSettings).toBe(view);
  });
});
