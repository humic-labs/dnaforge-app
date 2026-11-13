import { describe, expect, it } from 'vitest';

import { createAgentHelperLifecycleTracker } from '../helper-lifecycle';

describe('agent helper lifecycle', () => {
  it('increments its monotonic generation before invoking the helper operation', async () => {
    const tracker = createAgentHelperLifecycleTracker();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = tracker.track(async () => {
      expect(tracker.snapshot()).toEqual({ active: 1, started: 1, settled: 0, peakActive: 1 });
      await gate;
      return 'detected';
    });

    expect(tracker.snapshot()).toEqual({ active: 1, started: 1, settled: 0, peakActive: 1 });
    release?.();
    await expect(operation).resolves.toBe('detected');
    expect(tracker.snapshot()).toEqual({ active: 0, started: 1, settled: 1, peakActive: 1 });
  });

  it('tracks overlapping helpers without losing starts or settlements', async () => {
    const tracker = createAgentHelperLifecycleTracker();
    const releases: Array<() => void> = [];
    const start = (): Promise<void> =>
      tracker.track(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      );

    const first = start();
    const second = start();
    expect(tracker.snapshot()).toEqual({ active: 2, started: 2, settled: 0, peakActive: 2 });

    releases.shift()?.();
    await first;
    expect(tracker.snapshot()).toEqual({ active: 1, started: 2, settled: 1, peakActive: 2 });

    releases.shift()?.();
    await second;
    expect(tracker.snapshot()).toEqual({ active: 0, started: 2, settled: 2, peakActive: 2 });
  });

  it('settles rejected and synchronously throwing operations in finally', async () => {
    const tracker = createAgentHelperLifecycleTracker();

    await expect(tracker.track(async () => Promise.reject(new Error('rejected')))).rejects.toThrow(
      'rejected'
    );
    await expect(
      tracker.track(() => {
        throw new Error('threw before returning a promise');
      })
    ).rejects.toThrow('threw before returning a promise');

    expect(tracker.snapshot()).toEqual({ active: 0, started: 2, settled: 2, peakActive: 1 });
  });
});
