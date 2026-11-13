// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const installFn = vi.fn();
const retryFn = vi.fn();
const checkManualFn = vi.fn();

function emit(channel: string, payload: unknown): void {
  for (const cb of listeners.get(channel) ?? []) cb(payload);
}

vi.mock('../platform', () => ({
  platform: () => ({
    on: (channel: string, callback: Listener) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(callback);
      return () => {
        set!.delete(callback);
      };
    },
    update: {
      install: (version?: string) => installFn(version),
      retry: () => retryFn(),
      checkManual: () => checkManualFn(),
    },
  }),
}));

import { useUpdateToasts } from './useUpdateToasts';
import { useToastStore } from '../stores/toast-store';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.getState().clearToasts();
  listeners.clear();
  installFn.mockClear();
  installFn.mockResolvedValue({ status: 'started' });
  retryFn.mockClear();
  checkManualFn.mockClear();
});

afterEach(() => {
  useToastStore.getState().clearToasts();
  vi.useRealTimers();
});

function getToasts() {
  return useToastStore.getState().toasts;
}

describe('useUpdateToasts ', () => {
  it('shows manual download progress until restart is ready', () => {
    renderHook(() => useUpdateToasts());
    act(() => emit('update:available', { version: '9.9.9', isManual: true }));
    expect(getToasts()[0].definition).toBe('update-downloading');
    for (const percent of [0, 42.4, 100, 100]) {
      act(() => emit('update:progress', { percent, bytesPerSecond: 0 }));
      expect(getToasts()).toHaveLength(1);
      expect(getToasts()[0].progress?.value).toBe(Math.round(percent));
    }
    act(() => emit('update:downloaded', { version: '9.9.9' }));
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].definition).toBe('update-ready');
    expect(getToasts()[0].actions?.[0].label).toBe('Restart now');
  });

  it('offers only the replacement version when the restart request is superseded', async () => {
    renderHook(() => useUpdateToasts());
    act(() => emit('update:downloaded', { version: '9.9.9' }));
    const first = getToasts()[0].actions![0];
    installFn.mockImplementationOnce(async () => {
      emit('update:downloaded', { version: '9.9.10' });
      return { status: 'failed', message: 'Update changed', readyVersion: '9.9.10' };
    });

    await act(async () => first.onClick());

    expect(installFn).toHaveBeenCalledWith('9.9.9');
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].message).toContain('9.9.10');
    await act(async () => getToasts()[0].actions![0].onClick());
    expect(installFn).toHaveBeenLastCalledWith('9.9.10');
  });

  it('shows only the error if manual preparation fails, with no premature restart', () => {
    renderHook(() => useUpdateToasts());
    act(() => emit('update:available', { version: '9.9.9', isManual: true }));
    act(() => emit('update:progress', { percent: 100, bytesPerSecond: 0 }));
    expect(getToasts()[0].definition).toBe('update-downloading');
    act(() => emit('update:error', { stage: 'download' }));
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].definition).toBe('update-error');
    expect(getToasts()[0].actions?.some((action) => action.label === 'Restart now')).toBe(false);
  });
  describe('subscriptions', () => {
    it('subscribes to update state and download progress channels', () => {
      renderHook(() => useUpdateToasts());
      expect(listeners.get('update:no-update')?.size).toBe(1);
      expect(listeners.get('update:available')?.size).toBe(1);
      expect(listeners.get('update:progress')?.size).toBe(1);
      expect(listeners.get('update:downloaded')?.size).toBe(1);
      expect(listeners.get('update:error')?.size).toBe(1);
    });

    it('unsubscribes from every channel on unmount (no listener leaks)', () => {
      const { unmount } = renderHook(() => useUpdateToasts());
      unmount();
      for (const channel of [
        'update:no-update',
        'update:available',
        'update:progress',
        'update:downloaded',
        'update:error',
      ]) {
        expect(listeners.get(channel)?.size ?? 0).toBe(0);
      }
    });
  });

  describe('update:no-update', () => {
    it('renders an "up to date" info toast for a real check (4s auto-dismiss)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:no-update', { version: '1.2.3' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({
        message: expect.stringContaining('up to date (v1.2.3)'),

        type: 'info',
        duration: 4_000,
      });
    });

    it('renders a clarifying info toast in dev mode using the notice policy (8s)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:no-update', { version: '1.2.3', isDevMode: true }));

      const t = getToasts();
      expect(t[0]).toMatchObject({
        message: expect.stringMatching(/Dev build .*disabled in development/i),
        type: 'info',
        duration: 8_000,
      });
    });
  });

  describe('update:available — silent in renderer', () => {
    it('does not create a toast', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:available', { version: '2.0.0' }));
      expect(getToasts()).toHaveLength(0);
    });

    it('still clears a stale error toast (key behavior preserved from old design)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'check', message: 'transient' }));
      expect(getToasts()).toHaveLength(1);
      act(() => emit('update:available', { version: '2.0.0' }));
      expect(getToasts()).toHaveLength(0);
    });

    it('back-to-back available events stay silent (no stacking)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:available', { version: '2.0.0' }));
      act(() => emit('update:available', { version: '2.0.0' }));
      expect(getToasts()).toHaveLength(0);
    });
  });

  describe('update:progress — silent in renderer', () => {
    it('does not create a toast', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:progress', { percent: 47 }));
      expect(getToasts()).toHaveLength(0);
    });

    it('repeated progress events stay silent', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:progress', { percent: 12 }));
      act(() => emit('update:progress', { percent: 47 }));
      act(() => emit('update:progress', { percent: 88 }));
      expect(getToasts()).toHaveLength(0);
    });
  });

  describe('update:downloaded', () => {
    it('renders a persistent "ready, restart" toast with a Restart action', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({
        message: expect.stringContaining('Update v2.0.0 ready'),

        type: 'info',
        duration: 0,
      });
      expect(t[0].actions).toHaveLength(1);
      expect(t[0].actions![0].label).toBe('Restart now');
    });

    it('Restart invokes installation and dismisses ready without another toast', async () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      const action = getToasts()[0].actions![0];
      await act(async () => action.onClick());
      expect(getToasts()).toHaveLength(0);
      expect(installFn).toHaveBeenCalledTimes(1);
    });

    it('keeps repeated ready events silent while restart consent is pending', async () => {
      let cancel!: (result: { status: 'cancelled' }) => void;
      installFn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            cancel = resolve;
          })
      );
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      const restart = getToasts()[0].actions![0];
      let pending!: ReturnType<typeof restart.onClick>;
      act(() => {
        pending = restart.onClick();
      });
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      expect(getToasts()).toHaveLength(0);
      await act(async () => {
        cancel({ status: 'cancelled' });
        await pending;
      });
      expect(getToasts()).toHaveLength(1);
      expect(getToasts()[0].actions?.[0].label).toBe('Restart now');
    });

    it('restores the same-version ready action when the unsaved-work dialog cancels install', async () => {
      installFn.mockResolvedValueOnce({ status: 'cancelled' });
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const restart = getToasts()[0].actions![0];
      await act(async () => restart.onClick());

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2\.0\.0 ready/);
      expect(t[0].actions?.[0].label).toBe('Restart now');
    });

    it.each([
      {
        label: 'typed main-process failure',
        arrange: () => installFn.mockResolvedValueOnce({ status: 'failed', message: 'refused' }),
      },
      {
        label: 'rejected IPC invoke',
        arrange: () => installFn.mockRejectedValueOnce(new Error('invoke channel closed')),
      },
    ])('restores the same-version ready action after $label', async ({ arrange }) => {
      arrange();
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const restart = getToasts()[0].actions![0];
      await act(async () => restart.onClick());

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2\.0\.0 ready/);
      expect(t[0].actions?.[0].label).toBe('Restart now');
    });

    it('exactly one toast at the end of the happy path (no leftovers from silent events)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:available', { version: '2.0.0' }));
      act(() => emit('update:progress', { percent: 50 }));
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2\.0\.0 ready/);
    });

    it(': same-version re-emit does NOT stack (10-min re-check re-signals downloaded)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2\.0\.0 ready/);
    });

    it(': a newer version supersedes the prior ready toast (still exactly one)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      act(() => emit('update:downloaded', { version: '2.1.0' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2\.1\.0 ready/);
    });
  });

  describe('update:error', () => {
    it('check-stage error: info-toned, 8s auto-dismiss, Retry action', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'check', message: 'no net', reason: 'network' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({
        type: 'info',
        duration: 8_000,
      });
      expect(t[0].message).toMatch(/Couldn.?t reach the update server/);
      expect(t[0].actions![0].label).toBe('Retry');
    });

    it('check-stage no-manifest error: distinct copy, NO Retry action (structural)', () => {
      renderHook(() => useUpdateToasts());
      act(() =>
        emit('update:error', {
          stage: 'check',
          message: 'ENOENT: no such file or directory, open app-update.yml',
          reason: 'no-manifest',
        })
      );

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({
        type: 'info',
        duration: 8_000,
      });
      expect(t[0].message).toMatch(/aren.?t available for this build/i);
      expect(t[0].message).toMatch(/dnaforge\.com/);

      expect(t[0].actions).toBeUndefined();
    });

    it('check-stage unknown error: generic copy, Retry action', () => {
      renderHook(() => useUpdateToasts());
      act(() =>
        emit('update:error', {
          stage: 'check',
          message: 'provider returned an unexpected shape',
          reason: 'unknown',
        })
      );

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({
        type: 'info',
        duration: 8_000,
      });
      expect(t[0].message).toMatch(/Update check failed/);
      expect(t[0].message).not.toMatch(/update server|connection/i);
      expect(t[0].actions).toHaveLength(1);
      expect(t[0].actions![0].label).toBe('Retry');
    });

    it('check-stage error with absent reason: falls back to generic unknown copy', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'check', message: 'legacy payload' }));

      const t = getToasts();
      expect(t[0].message).toMatch(/Update check failed/);
      expect(t[0].actions).toHaveLength(1);
    });

    it('download-stage error: warning-toned, persistent, Retry action', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'download', message: 'connection reset' }));

      const t = getToasts();
      expect(t[0]).toMatchObject({
        type: 'warning',
        duration: 0,
      });
      expect(t[0].message).toMatch(/Update download was interrupted/);
    });

    it('identifies native preparation failure after the download has completed', () => {
      renderHook(() => useUpdateToasts());
      act(() =>
        emit('update:error', {
          stage: 'download',
          operation: 'native-preparation',
          message: 'Native update preparation timed out.',
        })
      );
      expect(getToasts()).toHaveLength(1);
      expect(getToasts()[0].message).toBe('The downloaded update could not be prepared.');
      expect(getToasts()[0].actions?.[0].label).toBe('Retry');
    });

    it('removes an interrupted-download warning when the same update becomes restart-ready', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'download', message: 'connection reset' }));
      expect(getToasts().some((toast) => toast.definition === 'update-error')).toBe(true);
      act(() => emit('update:downloaded', { version: '0.9.16' }));
      expect(getToasts().filter((toast) => toast.definition === 'update-error')).toEqual([]);
      expect(getToasts()).toHaveLength(1);
      expect(getToasts()[0].definition).toBe('update-ready');
      expect(getToasts()[0].message).toContain('0.9.16');
    });

    it('install-stage error restores the same downloaded version so native rejection is retryable', async () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:downloaded', { version: '2.0.0' }));
      await act(async () => getToasts()[0].actions![0].onClick());
      act(() => emit('update:error', { stage: 'install', message: 'signature rejected' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ type: 'info', duration: 0 });
      expect(t[0].message).toMatch(/Update v2\.0\.0 ready/i);
      expect(t[0].actions?.[0].label).toBe('Restart now');
    });

    it('Retry action invokes platform.update.retry() (Bug 5: not install, not checkManual)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'check', message: 'no net', reason: 'network' }));

      getToasts()[0].actions![0].onClick();
      expect(retryFn).toHaveBeenCalledTimes(1);
      expect(installFn).not.toHaveBeenCalled();
      expect(checkManualFn).not.toHaveBeenCalled();
    });

    it('error after silent progress shows only the error toast', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:progress', { percent: 50 }));
      act(() => emit('update:error', { stage: 'download', message: 'reset' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/interrupted/);
    });
  });

  describe('end-to-end happy path', () => {
    it('full lifecycle (available → progress×3 → downloaded) yields one ready toast', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:available', { version: '2.0.0' }));
      act(() => emit('update:progress', { percent: 25 }));
      act(() => emit('update:progress', { percent: 75 }));
      act(() => emit('update:progress', { percent: 99 }));
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2.0.0 ready/);
      expect(t[0].actions![0].label).toBe('Restart now');
    });

    it('available → error shows only the error toast (no stale silent state)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:available', { version: '2.0.0' }));
      act(() => emit('update:error', { stage: 'download', message: 'net dropped' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/interrupted/);
    });

    it('error → error replaces in place (Bug 1 pattern extended to errors)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'download', message: 'first' }));
      act(() => emit('update:error', { stage: 'download', message: 'second' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
    });

    it('error → available clears the stale error toast (no replacement appears)', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'check', message: 'transient' }));
      act(() => emit('update:available', { version: '2.0.0' }));

      expect(getToasts()).toHaveLength(0);
    });

    it('error → downloaded clears the stale error toast', () => {
      renderHook(() => useUpdateToasts());
      act(() => emit('update:error', { stage: 'download', message: 'net' }));
      act(() => emit('update:downloaded', { version: '2.0.0' }));

      const t = getToasts();
      expect(t).toHaveLength(1);
      expect(t[0].message).toMatch(/Update v2.0.0 ready/);
    });
  });
});
