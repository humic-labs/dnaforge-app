import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { nebFetchMock, trackToolErrorMock } = vi.hoisted(() => ({
  nebFetchMock: vi.fn(),
  trackToolErrorMock: vi.fn(),
}));

vi.mock('../../design/algorithms/neb-tm-client', () => ({
  makeNebFetch: () => nebFetchMock,
}));

vi.mock('@waypoint/scientific-artifacts/shared/primers/tm/tm-calculator', () => ({
  calculateTmNN: vi.fn(() => 58.4),
}));

vi.mock('../../../lib/analytics', () => ({
  trackToolError: trackToolErrorMock,
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));

import { usePrimerTm } from './usePrimerTm';
import { useSettingsStore } from '../../junction-workbench/settings';
import { DEFAULT_TM_MODEL } from '../../design/algorithms/tm-model';

const SEQ = 'ATCGATCGATCGATCGATCG';

function resolvedNeb(tm: number) {
  return { tm, nebApiVersion: '0.19.0', fetchedAt: '2026-07-22T00:00:00.000Z' };
}

describe('usePrimerTm — NEB product-code switching  / ', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nebFetchMock.mockReset();
    trackToolErrorMock.mockReset();
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL });
  });

  afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL });
  });

  it('local model: instant, synchronous, never unavailable, never calls NEB', () => {
    const { result } = renderHook(() => usePrimerTm(SEQ));
    expect(result.current.modelKind).toBe('local');
    expect(result.current.tm).toBe(58.4);
    expect(result.current.verified).toBe(false);
    expect(result.current.unavailable).toBe(false);
    expect(nebFetchMock).not.toHaveBeenCalled();
  });

  it('switching to an NEB product code: stays silent (not verified, not unavailable) while the fetch is in flight', () => {
    nebFetchMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => usePrimerTm(SEQ));

    act(() => {
      useSettingsStore.getState().setTmModel({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
    });

    expect(result.current.modelKind).toBe('neb');
    expect(result.current.verified).toBe(false);

    expect(result.current.unavailable).toBe(false);

    expect(result.current.tm).toBe(58.4);
    expect(trackToolErrorMock).not.toHaveBeenCalled();
  });

  it('resolves to the verified NEB value once the debounced fetch completes; no telemetry on success', async () => {
    nebFetchMock.mockResolvedValueOnce(resolvedNeb(71.2));
    const { result } = renderHook(() => usePrimerTm(SEQ));

    act(() => {
      useSettingsStore.getState().setTmModel({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.verified).toBe(true);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.tm).toBe(71.2);
    expect(nebFetchMock).toHaveBeenCalledTimes(1);
    expect(trackToolErrorMock).not.toHaveBeenCalled();
  });

  it("switching from one resolved NEB code to another: clears verified immediately, then resolves to the NEW code's own value", async () => {
    nebFetchMock.mockResolvedValueOnce(resolvedNeb(71.2));
    const { result } = renderHook(() => usePrimerTm(SEQ));

    act(() => {
      useSettingsStore.getState().setTmModel({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.tm).toBe(71.2);
    expect(result.current.verified).toBe(true);

    nebFetchMock.mockResolvedValueOnce(resolvedNeb(68.9));
    act(() => {
      useSettingsStore
        .getState()
        .setTmModel({ kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' });
    });

    expect(result.current.verified).toBe(false);
    expect(result.current.unavailable).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.verified).toBe(true);
    expect(result.current.tm).toBe(68.9);
    expect(nebFetchMock).toHaveBeenCalledTimes(2);
    expect(nebFetchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ prodcode: 'phusion-0' })
    );
    expect(trackToolErrorMock).not.toHaveBeenCalled();
  });

  it('rapid selector changes within the debounce window only fetch the FINAL selection (no stale intermediate result wins)', async () => {
    nebFetchMock.mockResolvedValueOnce(resolvedNeb(70.9));
    const { result } = renderHook(() => usePrimerTm(SEQ));

    act(() => {
      useSettingsStore.getState().setTmModel({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => {
      useSettingsStore
        .getState()
        .setTmModel({ kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.verified).toBe(true);
    expect(result.current.tm).toBe(70.9);

    expect(nebFetchMock).toHaveBeenCalledTimes(1);
    expect(nebFetchMock).toHaveBeenCalledWith(expect.objectContaining({ prodcode: 'phusion-0' }));
  });

  it('a rejected NEB fetch settles into unavailable:true with the local estimate, and logs telemetry once (never throws)', async () => {
    nebFetchMock.mockRejectedValueOnce(new Error('rate limited'));
    const { result } = renderHook(() => usePrimerTm(SEQ));

    act(() => {
      useSettingsStore.getState().setTmModel({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
    });

    expect(result.current.unavailable).toBe(false);
    expect(trackToolErrorMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.verified).toBe(false);
    expect(result.current.unavailable).toBe(true);
    expect(result.current.tm).toBe(58.4);
    expect(trackToolErrorMock).toHaveBeenCalledTimes(1);
    expect(trackToolErrorMock).toHaveBeenCalledWith('primers', 'sidebar', 'provider_unavailable');
  });
});
