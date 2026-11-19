import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MolstarPlugin } from './cache';
import {
  STRUCTURE_INTERACTION_SETTLE_TIMEOUT_MESSAGE,
  waitForDimensions,
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

function setLayoutSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height });
}

describe('waitForDimensions', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('uses the fallback size at once when presentation hides an attached container', async () => {
    vi.useFakeTimers();
    const container = document.body.appendChild(document.createElement('div'));
    container.checkVisibility = () => false;
    const canvas = container.appendChild(document.createElement('canvas'));
    let settled = false;
    void waitForDimensions(container, canvas, 420, () => {}).then(() => {
      settled = true;
    });

    await advance(0);

    expect(settled).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([600, 420]);
  });

  it('keeps waiting for a container that is still being attached', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    container.checkVisibility = () => false;
    const canvas = container.appendChild(document.createElement('canvas'));
    let settled = false;
    void waitForDimensions(container, canvas, 420, () => {}).then(() => {
      settled = true;
    });

    await advance(100);
    expect(settled).toBe(false);

    document.body.append(container);
    container.checkVisibility = () => true;
    setLayoutSize(container, 800, 500);
    setLayoutSize(canvas, 800, 500);
    await advance(50);

    expect(settled).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([800, 500]);
  });
});

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

  it('keeps pointer interactions pending until picking and marking programs finish linking', async () => {
    vi.useFakeTimers();
    const plugin = readinessPlugin({ busy: false, representations: 2, canvasRepresentations: 2 });
    let compiled = false;
    const linkPrograms = vi.fn();
    const finalizePrograms = vi.fn(() => compiled);
    Object.assign(plugin, {
      canvas3dContext: { webgl: { resources: { linkPrograms, finalizePrograms } } },
    });
    let ready = false;
    const result = waitForPluginInteractionReady(plugin, {
      hardCeilingMs: 1_000,
      stableMs: 50,
      pollMs: 25,
    }).then(() => {
      ready = true;
    });
    await advance(100);
    expect(ready).toBe(false);
    expect(linkPrograms).toHaveBeenCalledWith(['pick', 'marking']);
    expect(finalizePrograms).toHaveBeenCalledWith(['pick', 'marking'], false);
    compiled = true;
    await advance(100);
    await result;
    expect(ready).toBe(true);
  });

  it('waits for the outline and overlay programs used by the first visible highlight', async () => {
    vi.useFakeTimers();
    const plugin = readinessPlugin({ busy: false, representations: 1, canvasRepresentations: 1 });
    const marking = { enabled: true };
    let compiled = false;
    const prepare = vi.fn(() => compiled);
    Object.assign(plugin.canvas3d!, { props: { marking } });
    Object.assign(plugin, {
      canvas3dContext: {
        webgl: { resources: { linkPrograms: vi.fn(), finalizePrograms: () => true } },
        passes: { draw: { marking: { prepare } } },
      },
    });
    let ready = false;
    const result = waitForPluginInteractionReady(plugin, { stableMs: 50, pollMs: 25 }).then(() => {
      ready = true;
    });
    await advance(100);
    expect(ready).toBe(false);
    expect(prepare).toHaveBeenCalledWith(marking);
    compiled = true;
    await advance(100);
    await result;
    expect(ready).toBe(true);
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
