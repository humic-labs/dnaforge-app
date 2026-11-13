import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';
import { useToastStore } from '../../stores/toast-store';
import { useBenchlingMigrationNotifications } from './useBenchlingMigrationNotifications';
import {
  useBenchlingMigrationStatus,
  type BenchlingMigrationStatusSnapshot,
} from './useBenchlingMigrationStatus';

function snapshot(
  state: BenchlingMigrationRunView['state'] | null,
  id = 'run-1'
): BenchlingMigrationStatusSnapshot {
  return {
    run: state
      ? {
          version: 1,
          id,
          workspaceId: 'workspace-1',
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
          startedAt: null,
          unlockedAt: null,
          lastError: null,
          recoveryAction: null,
          localBundleState: 'ready',
        }
      : null,
    message: null,
    completedItems: null,
    totalItems: null,
    warnings: [],
    error: null,
  };
}

afterEach(() => useToastStore.getState().clearToasts());

describe('migration notification lifecycle', () => {
  it('notifies only after the production status hook observes completed finalization', async () => {
    const ready = snapshot('ready_to_unlock').run;
    const unlocked = snapshot('unlocked').run;
    if (!ready || !unlocked) throw new Error('Expected migration runs.');
    let active = ready;
    const bridge = {
      getActiveRun: vi.fn(async () => active),
      subscribeProgress: vi.fn(() => () => undefined),
    };
    const open = vi.fn();
    const { result } = renderHook(() => {
      const status = useBenchlingMigrationStatus(bridge, true);
      useBenchlingMigrationNotifications(status.snapshot, open, status.completedRun);
      return status;
    });
    await waitFor(() => expect(result.current.snapshot.run?.state).toBe('ready_to_unlock'));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    active = null;
    act(() => result.current.observeRun(unlocked));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0].message).toContain('ready');
    expect(result.current.snapshot.run).toBeNull();
    act(() => result.current.observeRun(unlocked));
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it.each(['projecting', null] as const)(
    'dismisses completion when the run becomes %s',
    (state) => {
      const open = vi.fn();
      const { rerender } = renderHook(
        ({ value }) => useBenchlingMigrationNotifications(value, open),
        { initialProps: { value: snapshot('unlocked') } }
      );
      expect(useToastStore.getState().toasts).toHaveLength(1);
      const toast = useToastStore.getState().toasts[0];
      expect(toast.message).not.toContain('unlock');
      rerender({ value: snapshot('unlocked') });
      expect(useToastStore.getState().toasts).toHaveLength(1);
      rerender({ value: snapshot(state) });
      expect(useToastStore.getState().toasts.find((item) => item.id === toast.id)?.phase).toBe(
        'exiting'
      );
    }
  );

  it('dismisses an obsolete warning when another run becomes active', () => {
    const { rerender } = renderHook(
      ({ value }) => useBenchlingMigrationNotifications(value, vi.fn()),
      { initialProps: { value: snapshot('action_required') } }
    );
    const toast = useToastStore.getState().toasts[0];
    rerender({ value: snapshot('projecting', 'run-2') });
    expect(useToastStore.getState().toasts.find((item) => item.id === toast.id)?.phase).toBe(
      'exiting'
    );
  });

  it('notifies again when a retried run needs attention, without repeating unchanged status', () => {
    const { rerender } = renderHook(
      ({ value }) => useBenchlingMigrationNotifications(value, vi.fn()),
      { initialProps: { value: snapshot('action_required') } }
    );
    const first = useToastStore.getState().toasts[0].id;
    rerender({ value: snapshot('projecting') });
    rerender({ value: snapshot('action_required') });
    const visible = useToastStore.getState().toasts.filter((toast) => toast.phase === 'visible');
    expect(visible).toHaveLength(1);
    expect(visible[0].id).not.toBe(first);
    rerender({ value: snapshot('action_required') });
    expect(
      useToastStore.getState().toasts.filter((toast) => toast.phase === 'visible')
    ).toHaveLength(1);
  });
});
