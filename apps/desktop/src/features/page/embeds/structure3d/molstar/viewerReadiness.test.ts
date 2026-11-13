import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MolstarPlugin } from './cache';
import {
  STRUCTURE_INTERACTION_SETTLE_TIMEOUT_MESSAGE,
  waitForPluginInteractionReady,
} from './viewerReadiness';

function readinessPlugin(state: {
  busy: boolean;
  representations: number;
  canvasRepresentations: number;
}): MolstarPlugin {
  const component = {
    get representations() {
      return Array.from({ length: state.representations }, () => ({}));
    },
  };
  return {
    get isBusy() {
      return state.busy;
    },
    behaviors: {
      state: {
        isUpdating: {
          get value() {
            return state.busy;
          },
        },
      },
    },
    managers: {
      structure: {
        hierarchy: {
          current: { structures: [{ components: [component] }] },
        },
      },
    },
    canvas3d: {
      reprCount: {
        get value() {
          return state.canvasRepresentations;
        },
      },
    },
  } as unknown as MolstarPlugin;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe('waitForPluginInteractionReady', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for camera motion to finish before accepting a saved-view capture', async () => {
    vi.useFakeTimers();
    const plugin = readinessPlugin({ busy: false, representations: 1, canvasRepresentations: 1 });
    let moving = true;
    let position = 10;
    Object.assign(plugin.canvas3d!, {
      camera: {
        transition: {
          get inTransition() {
            return moving;
          },
        },
        getSnapshot: () => ({ position: [position, 0, 0], target: [0, 0, 0] }),
      },
    });
    let resolved = false;
    const readiness = waitForPluginInteractionReady(plugin, {
      includeCamera: true,
      hardCeilingMs: 1_000,
      stableMs: 100,
      pollMs: 25,
    }).then((result) => {
      resolved = true;
      return result;
    });
    await advance(250);
    expect(resolved).toBe(false);
    moving = false;
    await advance(75);
    position = 20;
    await advance(75);
    expect(resolved).toBe(false);
    await advance(50);
    await expect(readiness).resolves.toMatchObject({ representationCount: 1 });
  });

  it('does not resolve while Molstar is still updating representations', async () => {
    vi.useFakeTimers();
    const state = { busy: true, representations: 12, canvasRepresentations: 4 };
    const plugin = readinessPlugin(state);
    let resolved = false;
    const readiness = waitForPluginInteractionReady(plugin, {
      hardCeilingMs: 1_000,
      stableMs: 100,
      pollMs: 25,
    }).then((result) => {
      resolved = true;
      return result;
    });

    await advance(250);
    expect(resolved).toBe(false);
    state.representations = 169;
    state.canvasRepresentations = 112;
    state.busy = false;
    await advance(100);
    expect(resolved).toBe(false);
    await advance(25);

    await expect(readiness).resolves.toMatchObject({
      representationCount: 169,
      canvasRepresentationCount: 112,
    });
  });

  it('restarts the stable window when the representation graph changes', async () => {
    vi.useFakeTimers();
    const state = { busy: false, representations: 12, canvasRepresentations: 4 };
    const readiness = waitForPluginInteractionReady(readinessPlugin(state), {
      hardCeilingMs: 1_000,
      stableMs: 100,
      pollMs: 25,
    });

    await advance(75);
    state.representations = 13;
    state.canvasRepresentations = 5;
    await advance(75);
    let resolved = false;
    readiness.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await advance(50);

    await expect(readiness).resolves.toMatchObject({
      representationCount: 13,
      canvasRepresentationCount: 5,
    });
  });

  it('fails closed when Molstar never settles', async () => {
    vi.useFakeTimers();
    const state = { busy: true, representations: 12, canvasRepresentations: 4 };
    const readiness = waitForPluginInteractionReady(readinessPlugin(state), {
      hardCeilingMs: 100,
      stableMs: 50,
      pollMs: 25,
    });
    const rejection = expect(readiness).rejects.toThrow(
      STRUCTURE_INTERACTION_SETTLE_TIMEOUT_MESSAGE
    );

    await advance(125);
    await rejection;
  });

  it('releases a superseded readiness poll without waiting for the hard ceiling', async () => {
    vi.useFakeTimers();
    const state = { busy: true, representations: 12, canvasRepresentations: 4 };
    let current = true;
    const readiness = waitForPluginInteractionReady(readinessPlugin(state), {
      hardCeilingMs: 30_000,
      stableMs: 100,
      pollMs: 25,
      isCurrent: () => current,
    });

    await advance(75);
    current = false;
    await advance(25);

    await expect(readiness).resolves.toBeNull();
  });
});
