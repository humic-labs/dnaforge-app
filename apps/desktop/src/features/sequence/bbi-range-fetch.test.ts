// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBbiRangeWithRetry } from './bbi-range-fetch';

afterEach(() => vi.useRealTimers());

describe('BBI range transport recovery', () => {
  it('recovers a transient sidecar failure before the reader sees it', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 206 }));
    const pending = fetchBbiRangeWithRetry('/external/range', {}, fetchImpl);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).status).toBe(206);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent source failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    const response = await fetchBbiRangeWithRetry('/external/range', {}, fetchImpl);
    expect(response.status).toBe(409);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('stops a pending retry when its viewport is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const pending = fetchBbiRangeWithRetry(
      '/external/range',
      { signal: controller.signal },
      fetchImpl
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
