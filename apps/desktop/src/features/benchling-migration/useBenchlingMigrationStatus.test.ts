import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BenchlingMigrationProgressEvent,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import { useBenchlingMigrationStatus } from './useBenchlingMigrationStatus';

function run(
  state: BenchlingMigrationRunView['state'],
  overrides: Partial<BenchlingMigrationRunView> = {}
): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-status',
    workspaceId: 'workspace-status',
    displayName: 'Import',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: { id: 'source', url: 'urn:test:source' },
    },
    binding: null,
    state,
    resumeState: null,
    attempt: 1,
    converterVersions: {},
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    startedAt: '2026-08-30T00:00:00.000Z',
    unlockedAt: null,
    lastError: null,
    recoveryAction: null,
    localBundleState: 'ready',
    ...overrides,
  };
}

function progressEvent(next: BenchlingMigrationRunView): BenchlingMigrationProgressEvent {
  return {
    runId: next.id,
    run: next,
    message: 'done',
    completedItems: 2,
    totalItems: 2,
    warnings: [],
    sequence: 1,
    emittedAt: 1,
  };
}

describe('useBenchlingMigrationStatus leftover visibility', () => {
  it('hides an older local validation failure while the backend retires it', async () => {
    const leftover = run('action_required', {
      id: 'leftover',
      lastError: {
        code: 'validation_failed',
        message: 'Local export validation found 1 blocking issue(s).',
        blocking: true,
      },
    });
    const later = run('unlocked', {
      id: 'later',
      updatedAt: '2026-08-30T00:02:00.000Z',
      unlockedAt: '2026-08-30T00:02:00.000Z',
    });
    let active: BenchlingMigrationRunView | null = leftover;
    const bridge = {
      getActiveRun: vi.fn(async () => active),
      subscribeProgress: vi.fn(() => () => undefined),
    };

    const { result } = renderHook(() => useBenchlingMigrationStatus(bridge, true));
    await waitFor(() => expect(bridge.getActiveRun).toHaveBeenCalled());
    expect(result.current.snapshot.run).toBeNull();

    active = leftover;
    act(() => result.current.observeRun(later));

    await waitFor(() => expect(bridge.getActiveRun).toHaveBeenCalledTimes(2));
    expect(result.current.snapshot.run).toBeNull();
  });

  it('removes a terminal local validation failure from current status on progress', async () => {
    const importing = run('validating');
    const failed = run('failed', {
      updatedAt: '2026-08-30T00:01:00.000Z',
      lastError: {
        code: 'validation_failed',
        message: 'Product routing selected sequence, not text.',
        blocking: true,
      },
    });
    let onProgress: ((event: BenchlingMigrationProgressEvent) => void) | undefined;
    const bridge = {
      getActiveRun: vi.fn(async () => importing),
      subscribeProgress: vi.fn(
        (_runId: string, callback: (event: BenchlingMigrationProgressEvent) => void) => {
          onProgress = callback;
          return () => undefined;
        }
      ),
    };
    const { result } = renderHook(() => useBenchlingMigrationStatus(bridge, true));
    await waitFor(() => expect(result.current.snapshot.run?.state).toBe('validating'));

    bridge.getActiveRun.mockResolvedValue(null);
    act(() => onProgress?.(progressEvent(failed)));

    await waitFor(() => expect(result.current.snapshot.run).toBeNull());
  });

  it('hides a terminal local import failure with another error code', async () => {
    const failed = run('failed', {
      lastError: {
        code: 'internal_invariant',
        message: 'Migration execution failed internally.',
        blocking: true,
      },
    });
    const bridge = {
      getActiveRun: vi.fn(async () => failed),
      subscribeProgress: vi.fn(() => () => undefined),
    };
    const { result } = renderHook(() => useBenchlingMigrationStatus(bridge, true));
    await waitFor(() => expect(bridge.getActiveRun).toHaveBeenCalled());
    expect(result.current.snapshot.run).toBeNull();
  });

  it('restores leftover action_required when the later import unlocks over progress', async () => {
    const leftover = run('action_required', { id: 'leftover' });
    const later = run('projecting', {
      id: 'later',
      updatedAt: '2026-08-30T00:01:00.000Z',
    });
    const unlocked = {
      ...later,
      state: 'unlocked' as const,
      updatedAt: '2026-08-30T00:02:00.000Z',
    };
    let active: BenchlingMigrationRunView | null = leftover;
    let onProgress: ((event: BenchlingMigrationProgressEvent) => void) | undefined;
    const bridge = {
      getActiveRun: vi.fn(async () => active),
      subscribeProgress: vi.fn(
        (_runId: string, callback: (event: BenchlingMigrationProgressEvent) => void) => {
          onProgress = callback;
          return () => undefined;
        }
      ),
    };

    const { result } = renderHook(() => useBenchlingMigrationStatus(bridge, true));
    await waitFor(() => expect(result.current.snapshot.run?.id).toBe(leftover.id));

    active = later;
    act(() => result.current.observeRun(later));
    await waitFor(() => expect(result.current.snapshot.run?.id).toBe(later.id));

    active = leftover;
    act(() => onProgress?.(progressEvent(unlocked)));

    await waitFor(() => expect(result.current.snapshot.run?.id).toBe(leftover.id));
    expect(result.current.snapshot.run?.state).toBe('action_required');
  });
});
