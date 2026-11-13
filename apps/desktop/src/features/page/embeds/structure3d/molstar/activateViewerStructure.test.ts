import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./structureBuilder', () => ({
  loadStructure: vi.fn(async () => undefined),
}));

vi.mock('./viewerReadiness', () => ({
  waitForFirstPaintBeforeReveal: vi.fn(async () => ({
    width: 640,
    height: 480,
    nonEmptySamples: 1,
  })),
}));

import type { CachedViewer } from './cache';
import { loadStructure } from './structureBuilder';
import { waitForFirstPaintBeforeReveal } from './viewerReadiness';
import { activateViewerStructure } from './activateViewerStructure';
import { MolViewSpecSceneError } from './molViewSpec';
import { requestRendererHostStructure } from './rendererHostActivation';

function cachedHost(loadedStructureKey: string): CachedViewer {
  const container = document.createElement('div');
  container.appendChild(document.createElement('canvas'));
  return {
    container,
    plugin: {
      clear: vi.fn(async () => undefined),
      dispose: vi.fn(),
      canvas3d: {
        props: { camera: { manualReset: false } },
        setProps: vi.fn(),
        commit: vi.fn(),
        camera: {
          setState: vi.fn(),
          transition: { inTransition: false },
        },
      },
    } as unknown as CachedViewer['plugin'],
    isLoading: false,
    error: null,
    lastUsed: 1,
    loadedStructureKey,
  };
}

describe('activateViewerStructure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reapplies a saved scene after its previous host cancelled without changing coordinates', async () => {
    const cached = cachedHost('structure:A');
    const options = {
      structureKey: 'structure:saved-3tyg',
      structureData: 'data_3TYG_ATTACHMENT',
      structureDataFormat: 'mmcif' as const,
      coordinatesOnly: true,
      height: 480,
    };
    await expect(
      activateViewerStructure(cached, {
        ...options,
        onBeforeReveal: async () => {
          throw new MolViewSpecSceneError('VIEW_CHANGED', 'Previous host unmounted.');
        },
      })
    ).resolves.toMatchObject({ status: 'stale' });
    expect(cached.loadedStructureKey).toBeNull();
    expect(cached.error).toBeNull();
    expect(waitForFirstPaintBeforeReveal).not.toHaveBeenCalled();

    const applySavedScene = vi.fn(async () => undefined);
    await expect(
      activateViewerStructure(cached, { ...options, onBeforeReveal: applySavedScene })
    ).resolves.toMatchObject({ status: 'activated' });
    expect(loadStructure).toHaveBeenCalledTimes(2);
    expect(applySavedScene).toHaveBeenCalledOnce();
    expect(waitForFirstPaintBeforeReveal).toHaveBeenCalledOnce();
    expect(cached.loadedStructureKey).toBe(options.structureKey);
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();
  });

  it('clears and reloads the scene without constructing or disposing the pane plugin', async () => {
    const cached = cachedHost('structure:A');
    const originalPlugin = cached.plugin;
    const onBeforeReveal = vi.fn(async () => undefined);

    const result = await activateViewerStructure(cached, {
      structureKey: 'structure:B',
      pdbId: '1FS0',
      height: 480,
      onBeforeReveal,
    });

    expect(result).toMatchObject({ status: 'activated', structureKey: 'structure:B' });
    expect(cached.plugin).toBe(originalPlugin);
    expect(cached.plugin?.clear).toHaveBeenCalledTimes(1);
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();
    expect(cached.plugin?.canvas3d?.setProps).toHaveBeenNthCalledWith(
      1,
      { camera: { manualReset: true } },
      true
    );
    expect(cached.plugin?.canvas3d?.commit).toHaveBeenCalledWith(true);
    expect(cached.plugin?.canvas3d?.setProps).toHaveBeenNthCalledWith(
      2,
      { camera: { manualReset: false } },
      true
    );
    expect(loadStructure).toHaveBeenCalledWith(
      originalPlugin,
      expect.objectContaining({ pdbId: '1FS0' }),
      expect.any(Function)
    );
    expect(onBeforeReveal).toHaveBeenCalledWith(originalPlugin);
    expect(waitForFirstPaintBeforeReveal).toHaveBeenCalledWith(
      originalPlugin,
      expect.any(HTMLCanvasElement),
      expect.any(Function)
    );
    expect(cached.loadedStructureKey).toBe('structure:B');
    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBeNull();
  });

  it('restores the logical camera after structure and style activation but before reveal paint', async () => {
    const cached = cachedHost('structure:A');
    const cameraSnapshot = JSON.stringify({
      position: [21, 58, 166],
      target: [0, 0, 0],
      up: [0, 1, 0],
      radius: 12,
      fog: 50,
      fov: 45,
    });
    const onBeforeReveal = vi.fn(async () => undefined);

    await activateViewerStructure(cached, {
      structureKey: 'structure:B',
      pdbId: '1FS0',
      height: 480,
      cameraSnapshot,
      onBeforeReveal,
    });

    const setState = cached.plugin?.canvas3d?.camera?.setState;
    expect(setState).toHaveBeenCalledWith(JSON.parse(cameraSnapshot), 0);
    expect(onBeforeReveal.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setState!).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(setState!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(waitForFirstPaintBeforeReveal).mock.invocationCallOrder[0]
    );
  });

  it('leaves a failed scene unloaded while retaining the reusable plugin for the next request', async () => {
    const cached = cachedHost('structure:A');
    vi.mocked(loadStructure).mockRejectedValueOnce(new Error('bad coordinates'));

    await expect(
      activateViewerStructure(cached, {
        structureKey: 'structure:B',
        structureData: 'bad',
        structureDataFormat: 'pdb',
        height: 480,
      })
    ).rejects.toThrow('bad coordinates');

    expect(cached.loadedStructureKey).toBeNull();
    expect(cached.isLoading).toBe(false);
    expect(cached.error).toBe('bad coordinates');

    await expect(
      activateViewerStructure(cached, {
        structureKey: 'structure:C',
        structureData: 'good',
        structureDataFormat: 'pdb',
        height: 480,
      })
    ).resolves.toMatchObject({ status: 'activated', structureKey: 'structure:C' });
    expect(cached.loadedStructureKey).toBe('structure:C');
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();
  });

  it('does not publish a stale scene cancellation as a viewer failure', async () => {
    const cached = cachedHost('structure:A');
    const result = await activateViewerStructure(cached, {
      structureKey: 'structure:B',
      height: 480,
      onBeforeReveal: async () => {
        requestRendererHostStructure(cached.rendererHostActivation!, 'structure:C');
        throw new MolViewSpecSceneError('VIEW_CHANGED', 'View changed.', 'unknown');
      },
    });
    expect(result.status).toBe('stale');
    expect(cached.error).toBeNull();
    await expect(
      activateViewerStructure(cached, { structureKey: 'structure:C', height: 480 })
    ).resolves.toMatchObject({ status: 'activated' });
  });
});
