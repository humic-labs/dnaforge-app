import { describe, expect, it, vi } from 'vitest';

import { retryIdempotentManagedOperationRequest } from './managed-operation-request-retry';

describe('managed-operation request retry', () => {
  it('bounds persistent transport failure and preserves the original error', async () => {
    const failure = new TypeError('fetch failed');
    const request = vi.fn(async () => Promise.reject(failure));
    const delay = vi.fn(async (_milliseconds: number) => undefined);

    await expect(
      retryIdempotentManagedOperationRequest(request, {
        delay,
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 20,
      })
    ).rejects.toBe(failure);

    expect(request).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([10, 20]);
  });

  it('stops before another request when its owner aborts during retry delay', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => Promise.reject(new TypeError('fetch failed')));
    const delay = vi.fn(async (_milliseconds: number) => {
      controller.abort();
    });

    await expect(
      retryIdempotentManagedOperationRequest(request, {
        signal: controller.signal,
        delay,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(request).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledOnce();
  });
});
