import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSequenceAutoSave, type UseSequenceAutoSaveOptions } from './useSequenceAutoSave';

function baseOpts(over: Partial<UseSequenceAutoSaveOptions> = {}): UseSequenceAutoSaveOptions {
  return {
    editEpoch: 1,
    isDirty: true,
    save: vi.fn().mockResolvedValue(true),
    debounceMs: 1000,
    ...over,
  };
}

describe('useSequenceAutoSave (debounced auto-save on edit)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of edits into ONE save after the debounce', async () => {
    const opts = baseOpts();
    const { rerender } = renderHook((p: UseSequenceAutoSaveOptions) => useSequenceAutoSave(p), {
      initialProps: opts,
    });
    rerender({ ...opts, editEpoch: 2 });
    rerender({ ...opts, editEpoch: 3 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(opts.save).toHaveBeenCalledTimes(1);
  });

  it('does nothing while not dirty', async () => {
    const opts = baseOpts({ isDirty: false });
    renderHook(() => useSequenceAutoSave(opts));
    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.save).not.toHaveBeenCalled();
  });

  it('respects enabled: false', async () => {
    const opts = baseOpts({ enabled: false });
    renderHook(() => useSequenceAutoSave(opts));
    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.save).not.toHaveBeenCalled();
  });

  it('swallows a save error without throwing (save surfaces its own toast)', async () => {
    const opts = baseOpts({ save: vi.fn().mockRejectedValue(new Error('disk full')) });
    renderHook(() => useSequenceAutoSave(opts));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(opts.save).toHaveBeenCalledTimes(1);
  });

  it('flush() saves immediately, bypassing the debounce', async () => {
    const opts = baseOpts();
    const { result } = renderHook(() => useSequenceAutoSave(opts));
    let saved = false;
    await act(async () => {
      saved = await result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(opts.save).toHaveBeenCalledTimes(1);
    expect(saved).toBe(true);
  });

  it('flush() reports a failed persistence attempt', async () => {
    const opts = baseOpts({ save: vi.fn().mockResolvedValue(false) });
    const { result } = renderHook(() => useSequenceAutoSave(opts));

    await expect(result.current.flush()).resolves.toBe(false);
  });

  it('serializes overlapping edits into one save plus exactly one rerun', async () => {
    const resolvers: Array<(v: boolean) => void> = [];
    const save = vi
      .fn()
      .mockImplementation(() => new Promise<boolean>((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useSequenceAutoSave(baseOpts({ save })));

    await act(async () => {
      void result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0](true);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      resolvers[1]?.(true);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(save).toHaveBeenCalledTimes(2);
  });

  it('flushes a pending save on unmount (last edit is not dropped)', async () => {
    const opts = baseOpts();
    const { unmount } = renderHook(() => useSequenceAutoSave(opts));
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(opts.save).toHaveBeenCalledTimes(1);
  });
});
