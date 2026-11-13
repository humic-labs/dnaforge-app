import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onCb: null as null | ((...a: unknown[]) => void),
  getStatus: () => Promise.resolve('ready'),
  mode: 'normal' as 'normal' | 'throw' | 'no-on',
}));

vi.mock('../platform', () => ({
  platform: () => {
    if (h.mode === 'throw') throw new Error('browser mode — no IPC bridge');
    return {
      config: { getSidecarStatus: () => h.getStatus() },
      on:
        h.mode === 'no-on'
          ? undefined
          : (_channel: string, cb: (...a: unknown[]) => void) => {
              h.onCb = cb;
              return () => {
                h.onCb = null;
              };
            },
    };
  },
}));

import { useSidecarStatus } from './use-sidecar-status';

describe('useSidecarStatus — the Starting-Analysis-Engine race is structurally closed', () => {
  beforeEach(() => {
    h.onCb = null;
    h.getStatus = () => Promise.resolve('ready');
    h.mode = 'normal';
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('REGRESSION: recovers when the one-shot push was missed (mount pull reconciles)', async () => {
    h.getStatus = () => Promise.resolve('ready');
    const { result } = renderHook(() => useSidecarStatus('starting'));
    expect(result.current).toBe('starting');
    await waitFor(() => expect(result.current).toBe('ready'));
  });

  it('recovers when the initial pull rejects and a later poll succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    h.getStatus = () =>
      calls++ === 0
        ? Promise.reject(new Error('temporarily unavailable'))
        : Promise.resolve('ready');

    const { result } = renderHook(() => useSidecarStatus('starting'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe('starting');

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(result.current).toBe('ready');
  });

  it('still applies later push transitions (subscription intact)', async () => {
    h.getStatus = () => Promise.resolve('starting');
    const { result } = renderHook(() => useSidecarStatus('starting'));
    await waitFor(() => expect(result.current).toBe('starting'));
    act(() => h.onCb?.('ready'));
    await waitFor(() => expect(result.current).toBe('ready'));
  });

  it('AppBar variant (initial "") also reconciles to ready via the pull', async () => {
    h.getStatus = () => Promise.resolve('ready');
    const { result } = renderHook(() => useSidecarStatus(''));
    await waitFor(() => expect(result.current).toBe('ready'));
  });

  it('keeps pulling while non-ready so a stale restarting state converges', async () => {
    vi.useFakeTimers();
    let calls = 0;
    h.getStatus = () => Promise.resolve(calls++ === 0 ? 'restarting' : 'ready');

    const { result } = renderHook(() => useSidecarStatus('restarting'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe('restarting');

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(result.current).toBe('ready');
  });

  it('browser mode (no IPC bridge) does not crash; returns initial', () => {
    h.mode = 'throw';
    const { result } = renderHook(() => useSidecarStatus('starting'));
    expect(result.current).toBe('starting');
  });

  it('missing on() (older preload) still reconciles via the pull', async () => {
    h.mode = 'no-on';
    h.getStatus = () => Promise.resolve('ready');
    const { result } = renderHook(() => useSidecarStatus('starting'));
    await waitFor(() => expect(result.current).toBe('ready'));
  });
});
