// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { readBbiWithSharedAbortRecovery } from './bbi-read-abort-recovery';

describe('BBI shared index cancellation', () => {
  it('retries a live query when a canceled neighbor owned their shared index read', async () => {
    const canceled = new AbortController();
    const live = new AbortController();
    let rejectShared!: (error: Error) => void;
    const shared = new Promise<number>((_resolve, reject) => {
      rejectShared = reject;
    });
    const liveRead = vi.fn().mockReturnValueOnce(shared).mockResolvedValueOnce(42);
    const canceledResult = readBbiWithSharedAbortRecovery(() => shared, canceled.signal);
    const liveResult = readBbiWithSharedAbortRecovery(liveRead, live.signal);
    const results = Promise.allSettled([canceledResult, liveResult]);
    canceled.abort();
    const cause = new DOMException('signal is aborted without reason', 'AbortError');
    rejectShared(new Error('aborted fetching /external/range', { cause }));

    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) },
      { status: 'fulfilled', value: 42 },
    ]);
    expect(liveRead).toHaveBeenCalledTimes(2);
  });

  it.each(['HTTP 404 fetching /external/range', 'compressed block extends past the input buffer'])(
    'preserves the actual read failure: %s',
    async (message) => {
      const error = new Error(message);
      const read = vi.fn().mockRejectedValue(error);
      await expect(readBbiWithSharedAbortRecovery(read, new AbortController().signal)).rejects.toBe(
        error
      );
      expect(read).toHaveBeenCalledTimes(1);
    }
  );

  it('bounds shared cancellation recovery to one retry', async () => {
    const error = new Error('wrapped cancellation', {
      cause: new DOMException('aborted', 'AbortError'),
    });
    const read = vi.fn().mockRejectedValue(error);
    await expect(readBbiWithSharedAbortRecovery(read, new AbortController().signal)).rejects.toBe(
      error
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never starts a query that its owner already canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn().mockResolvedValue(42);
    await expect(readBbiWithSharedAbortRecovery(read, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(read).not.toHaveBeenCalled();
  });
});
