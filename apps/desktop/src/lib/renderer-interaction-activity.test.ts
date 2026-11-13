// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cooperateWithRendererInteraction,
  markRendererInteractionActivity,
  rendererInteractionCooperationIfNeeded,
  rendererInteractionQuietDelayMs,
  resetRendererInteractionActivityForTest,
} from './renderer-interaction-activity';

describe('renderer interaction activity arbitration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    resetRendererInteractionActivityForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetRendererInteractionActivityForTest();
    vi.useRealTimers();
  });

  it('lets inactive work proceed after its bounded batch yield', async () => {
    const cooperation = cooperateWithRendererInteraction(16);
    await vi.runAllTimersAsync();
    await expect(cooperation).resolves.toBeUndefined();
  });

  it('yields through the browser scheduler without installing a zero-delay timer', async () => {
    const yieldTask = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('scheduler', { yield: yieldTask });
    const cooperation = cooperateWithRendererInteraction(16);
    expect(yieldTask).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await cooperation;
  });

  it('still waits for input to be quiet after a scheduled yield', async () => {
    vi.stubGlobal('scheduler', { yield: vi.fn().mockResolvedValue(undefined) });
    markRendererInteractionActivity();
    let completed = false;
    const cooperation = cooperateWithRendererInteraction(16).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(completed).toBe(false);
    markRendererInteractionActivity();
    await vi.advanceTimersByTimeAsync(249);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cooperation;
    expect(completed).toBe(true);
  });

  it('cancels a scheduled yield without waiting for the browser to resume its task', async () => {
    const deferred = Promise.withResolvers<void>();
    vi.stubGlobal('scheduler', { yield: vi.fn(() => deferred.promise) });
    const controller = new AbortController();
    const cooperation = cooperateWithRendererInteraction(16, { signal: controller.signal });
    let cancelled = false;
    const observed = cooperation.catch((error) => {
      expect(error).toMatchObject({ name: 'AbortError' });
      cancelled = true;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(cancelled).toBe(true);
    } finally {
      deferred.resolve();
      await observed;
    }
  });

  it('keeps the quiet fast path allocation-free but arbitrates the next item during a gesture', async () => {
    expect(rendererInteractionCooperationIfNeeded(1)).toBeNull();

    markRendererInteractionActivity();
    let completed = false;
    const cooperation = rendererInteractionCooperationIfNeeded(1);
    expect(cooperation).not.toBeNull();
    void cooperation!.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cooperation;
    expect(completed).toBe(true);
  });

  it('pauses passive work until a sustained gesture has been quiet for 250ms', async () => {
    markRendererInteractionActivity();
    expect(rendererInteractionQuietDelayMs()).toBe(250);
    let completed = false;
    const cooperation = cooperateWithRendererInteraction(1).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(completed).toBe(false);
    expect(rendererInteractionQuietDelayMs()).toBe(1);
    markRendererInteractionActivity();
    await vi.advanceTimersByTimeAsync(249);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cooperation;
    expect(completed).toBe(true);
    expect(rendererInteractionQuietDelayMs()).toBe(0);
  });

  it('releases a paused passive scan immediately when its owning renderer unmounts', async () => {
    markRendererInteractionActivity();
    const controller = new AbortController();
    const cooperation = cooperateWithRendererInteraction(1, { signal: controller.signal });

    controller.abort();

    await expect(cooperation).rejects.toMatchObject({ name: 'AbortError' });
  });
});
