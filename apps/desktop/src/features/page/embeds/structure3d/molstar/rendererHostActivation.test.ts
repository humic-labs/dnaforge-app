// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  createRendererHostActivationState,
  enqueueRendererHostActivation,
  enqueueRendererHostSceneOperation,
} from './rendererHostActivation';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('rendererHostActivation', () => {
  it('applies a queued same-structure scene after the preceding scene was cancelled', async () => {
    const state = createRendererHostActivationState('structure:A');
    const started = deferred();
    const finish = deferred();
    const first = enqueueRendererHostActivation(state, {
      structureKey: 'structure:B',
      activate: async () => {
        started.resolve();
        await finish.promise;
        return { status: 'cancelled' as const };
      },
    });
    await started.promise;
    const applyLatestScene = vi.fn(async () => undefined);
    const latest = enqueueRendererHostActivation(state, {
      structureKey: 'structure:B',
      activate: applyLatestScene,
    });
    finish.resolve();

    await expect(first).resolves.toMatchObject({ status: 'stale' });
    await expect(latest).resolves.toMatchObject({ status: 'activated' });
    expect(applyLatestScene).toHaveBeenCalledOnce();
    expect(state.loadedStructureKey).toBe('structure:B');
  });

  it('finishes a pending story mutation before a successor clears the shared pane', async () => {
    const state = createRendererHostActivationState('structure:A');
    const started = deferred(),
      finish = deferred();
    const calls: string[] = [];
    const scene = enqueueRendererHostSceneOperation(state, 'structure:A', async (isCurrent) => {
      calls.push('story:start');
      started.resolve();
      await finish.promise;
      calls.push('story:finish');
      expect(isCurrent()).toBe(false);
      throw Error('obsolete story has no visible structure');
    });
    await started.promise;
    const next = enqueueRendererHostActivation(state, {
      structureKey: 'structure:B',
      activate: async () => {
        calls.push('clear:B');
      },
    });
    await Promise.resolve();
    expect(calls).toEqual(['story:start']);
    finish.resolve();
    await expect(scene).resolves.toMatchObject({ status: 'stale' });
    await expect(next).resolves.toMatchObject({ status: 'activated' });
    expect(calls).toEqual(['story:start', 'story:finish', 'clear:B']);
  });

  it('skips obsolete queued scene edits and preserves genuine current failures', async () => {
    const state = createRendererHostActivationState('structure:A');
    const mutate = vi.fn(async () => undefined);
    const obsolete = enqueueRendererHostSceneOperation(state, 'structure:A', mutate);
    const successor = enqueueRendererHostActivation(state, {
      structureKey: 'structure:B',
      activate: mutate,
    });
    await expect(obsolete).resolves.toMatchObject({ status: 'stale' });
    await successor;
    expect(mutate).toHaveBeenCalledOnce();
    await expect(
      enqueueRendererHostSceneOperation(state, 'structure:B', async () => {
        throw Error('bad current scene');
      })
    ).rejects.toThrow('bad current scene');
  });
  it('coalesces a rapid A -> B -> A request before B starts without touching the plugin', async () => {
    const state = createRendererHostActivationState('structure:A');
    const activateB = vi.fn(async () => undefined);
    const activateA = vi.fn(async () => undefined);

    const b = enqueueRendererHostActivation(state, {
      structureKey: 'structure:B',
      activate: activateB,
    });
    const a = enqueueRendererHostActivation(state, {
      structureKey: 'structure:A',
      activate: activateA,
    });

    await expect(b).resolves.toMatchObject({ status: 'stale', structureKey: 'structure:B' });
    await expect(a).resolves.toMatchObject({ status: 'reused', structureKey: 'structure:A' });
    expect(activateB).not.toHaveBeenCalled();
    expect(activateA).not.toHaveBeenCalled();
    expect(state.loadedStructureKey).toBe('structure:A');
  });

  it('serializes an in-flight B activation and restores A as the last writer', async () => {
    const state = createRendererHostActivationState('structure:A');
    const bStarted = deferred();
    const releaseB = deferred();
    const calls: string[] = [];

    const b = enqueueRendererHostActivation(state, {
      structureKey: 'structure:B',
      activate: async () => {
        calls.push('start:B');
        bStarted.resolve();
        await releaseB.promise;
        calls.push('finish:B');
      },
    });
    await bStarted.promise;

    const a = enqueueRendererHostActivation(state, {
      structureKey: 'structure:A',
      activate: async () => {
        calls.push('activate:A');
      },
    });
    releaseB.resolve();

    await expect(b).resolves.toMatchObject({ status: 'stale', structureKey: 'structure:B' });
    await expect(a).resolves.toMatchObject({ status: 'activated', structureKey: 'structure:A' });
    expect(calls).toEqual(['start:B', 'finish:B', 'activate:A']);
    expect(state.loadedStructureKey).toBe('structure:A');
    expect(state.requestedStructureKey).toBe('structure:A');
  });

  it('keeps the queue usable and the loaded identity empty after activation failure', async () => {
    const state = createRendererHostActivationState('structure:A');

    await expect(
      enqueueRendererHostActivation(state, {
        structureKey: 'structure:B',
        activate: async () => {
          throw new Error('parse failed');
        },
      })
    ).rejects.toThrow('parse failed');
    expect(state.loadedStructureKey).toBeNull();

    await expect(
      enqueueRendererHostActivation(state, {
        structureKey: 'structure:C',
        activate: async () => undefined,
      })
    ).resolves.toMatchObject({ status: 'activated', structureKey: 'structure:C' });
    expect(state.loadedStructureKey).toBe('structure:C');
  });
});
