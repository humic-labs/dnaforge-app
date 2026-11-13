import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useToolboxBadge, useToolboxStatus, _resetToolboxState } from './useToolboxStatus';
import { sidecarScenarios } from '../test/scenarios';
import { serviceManager } from '../services/service-manager';

const TEST_SIDECAR_BASE_URL = 'http://toolbox-sidecar.test.invalid';

function stubElectronRenderer(getStatus: () => Promise<string> = async () => 'ready'): void {
  Reflect.set(globalThis, 'electronAPI', {
    config: { getSidecarStatus: getStatus },
  });
}

function clearElectronRenderer(): void {
  Reflect.deleteProperty(globalThis, 'electronAPI');
}

describe('toolbox polling outside Electron', () => {
  beforeEach(() => {
    _resetToolboxState();
    clearElectronRenderer();
    serviceManager.setBaseUrl(TEST_SIDECAR_BASE_URL);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    _resetToolboxState();
    clearElectronRenderer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports unavailable without making a request that can only fail auth or CORS', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToolboxStatus());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loadState).toBe('unavailable');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the poll timer when the badge is the only browser-only subscriber', async () => {
    vi.useFakeTimers();
    renderHook(() => useToolboxBadge());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not classify the permanent browser-only context as a fast-retry error', async () => {
    const { result } = renderHook(() => useToolboxStatus());

    await waitFor(() => expect(result.current.loadState).not.toBe('loading'));
    expect(result.current.loadState).not.toBe('error');
  });
});

describe('useToolboxBadge', () => {
  beforeEach(() => {
    _resetToolboxState();
    stubElectronRenderer();
    serviceManager.setBaseUrl(TEST_SIDECAR_BASE_URL);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    _resetToolboxState();
    clearElectronRenderer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns null when all ready', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        capabilities: [{ id: 'x', status: 'ready', tier: 'base', components: [] }],
      }),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('does not request protected toolbox status until the sidecar session is ready', async () => {
    vi.useFakeTimers();
    let sidecarStatus = 'starting';
    stubElectronRenderer(async () => sidecarStatus);
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: [] }),
    });

    const { result } = renderHook(() => useToolboxStatus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loadState).toBe('loading');
    expect(fetchMock).not.toHaveBeenCalled();

    sidecarStatus = 'ready';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.loadState).toBe('loaded');
  });

  it('returns "downloading" when any downloading', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        capabilities: [{ id: 'x', status: 'downloading', tier: 'base', components: [] }],
      }),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBe('downloading');
    });
  });

  it('returns "error" when any error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        capabilities: [{ id: 'x', status: 'error', tier: 'base', components: [] }],
      }),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBe('error');
    });
  });

  it('returns null on fetch error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('retries transient sidecar startup failures quickly instead of waiting for the stable poll interval', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error('sidecar not listening yet')).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        capabilities: [{ id: 'annotation', status: 'ready', tier: 'base', components: [] }],
      }),
    });

    const { result } = renderHook(() => useToolboxStatus());

    await waitFor(() => {
      expect(result.current.loadState).toBe('error');
    });

    await waitFor(
      () => {
        expect(result.current.loadState).toBe('loaded');
      },
      { timeout: 2_500 }
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for main to publish a ready sidecar generation before issuing a protected request', async () => {
    vi.useFakeTimers();
    let sidecarStatus = 'starting';
    stubElectronRenderer(async () => sidecarStatus);
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: [] }),
    });

    const { result } = renderHook(() => useToolboxStatus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loadState).toBe('loading');
    expect(fetchMock).not.toHaveBeenCalled();

    sidecarStatus = 'ready';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(result.current.loadState).toBe('loaded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('contains a rejected action request and still refetches status', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const ready = {
      ok: true,
      json: async () => ({ capabilities: [] }),
    };
    fetchMock.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('POST failed'));
    fetchMock.mockResolvedValueOnce(ready);

    const { result } = renderHook(() => useToolboxStatus());
    await waitFor(() => expect(result.current.loadState).toBe('loaded'));

    await act(async () => {
      await expect(result.current.retry('annotation')).resolves.toBeUndefined();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${TEST_SIDECAR_BASE_URL}/toolbox/retry/annotation`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', headers: expect.any(Headers) })
    );
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Headers).has('X-DNAForge-Session')).toBe(
      false
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`${TEST_SIDECAR_BASE_URL}/toolbox/status`);
  });

  it('stops polling when an action observes that renderer authority is unavailable', async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ capabilities: [] }),
    });

    const { result } = renderHook(() => useToolboxStatus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loadState).toBe('loaded');
    expect(vi.getTimerCount()).toBe(1);

    clearElectronRenderer();
    await act(async () => {
      await result.current.retry('annotation');
    });

    expect(result.current.loadState).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not force a re-render on repeated polls that resolve to the same badge value', async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error('sidecar offline'));

    renderHook(() => useToolboxStatus());
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useToolboxBadge();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBeNull();
    const settledRenderCount = renderCount;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(renderCount).toBe(settledRenderCount);
  });
});

describe('useToolboxBadge with scenario presets', () => {
  beforeEach(() => {
    _resetToolboxState();
    stubElectronRenderer();
    serviceManager.setBaseUrl(TEST_SIDECAR_BASE_URL);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    _resetToolboxState();
    clearElectronRenderer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns null for fullyReady scenario', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => sidecarScenarios.fullyReady(),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('returns "downloading" for downloadingTools scenario', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => sidecarScenarios.downloadingTools(50),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBe('downloading');
    });
  });

  it('returns "error" for toolsError scenario', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => sidecarScenarios.toolsError(),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBe('error');
    });
  });

  it('returns "downloading" for freshInstall (annotation unavailable but mafft also unavailable)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => sidecarScenarios.freshInstall(),
    });
    const { result } = renderHook(() => useToolboxBadge());
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});
