import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getViewerCacheKey,
  hasActiveMolstarViewerHost,
  viewerCache,
  withActivePlugin,
} from '../page/public/embeds/structure3d/molstar/cache';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { createMolecularExperimentViewer } from './molecular-experiment-viewer';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { freshMolecularTrialScene } from './molecular-trial-fixtures';

const setup = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  controller: vi.fn(),
  scene: vi.fn(),
  bindAssets: vi.fn(),
}));
vi.mock('../page/public/embeds/structure3d/molstar/createViewer', () => ({
  createViewerContainer: setup.create,
}));
vi.mock('../page/public/embeds/structure3d/molstar/molViewSpec', () => ({
  loadMolViewSpecScene: setup.load,
  registerMolViewSpecController: setup.controller,
  getMolViewSpecScene: setup.scene,
  sameLoadedMolViewSpecScene: (a: string, b: string) => a === b,
  bindMolViewSpecPinnedAssets: setup.bindAssets,
}));

describe('background experiment viewer lifecycle', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    viewerCache.clear();
    useStructure3dStore.setState({ expandedStructures: {} });
    vi.clearAllMocks();
    setup.controller.mockReturnValue(vi.fn());
    setup.load.mockResolvedValue(undefined);
    setup.scene.mockReturnValue({ scene: 'pinned-scene' });
    setup.create.mockImplementation(async (options) => {
      const plugin = { dispose: vi.fn(), state: { data: { cells: new Map() } } };
      const cached = {
        container: document.createElement('div'),
        plugin,
        isLoading: false,
        isInitializing: false,
        error: null,
        lastUsed: Date.now(),
      };
      queueMicrotask(async () => {
        await options.onBeforeReveal(plugin);
        options.onComplete();
      });
      return cached;
    });
  });

  const fixture = (id: string) => ({
    structureViewId: id,
    attrs: {
      source: 'file',
      sourceId: 'data_test',
      coordinateSha256: 'a'.repeat(64),
      molViewSpec: 'pinned-scene',
      label: 'Pinned structure',
    },
  });

  it('keeps same-coordinate attempts addressable through separate exact hosts', async () => {
    const one = await createMolecularExperimentViewer(
      fixture('saved-view:one'),
      'One',
      'default',
      'saved-view-replay'
    );
    const two = await createMolecularExperimentViewer(
      fixture('saved-view:two'),
      'Two',
      'default',
      'saved-view-replay'
    );
    expect(one.viewerId).toBe(two.viewerId);
    expect(one.cacheKey).not.toBe(two.cacheKey);
    expect(one.cacheKey).toBe(getViewerCacheKey(one.viewerId, 'structure-panel:saved-view:one'));
    const first = await withActivePlugin(one.viewerId, (active) => active.plugin, {
      cacheKey: one.cacheKey,
    });
    const second = await withActivePlugin(two.viewerId, (active) => active.plugin, {
      cacheKey: two.cacheKey,
    });
    expect(first).not.toBe(second);
    expect(hasActiveMolstarViewerHost(one.viewerId, 'saved-view:one')).toBe(true);
    expect(hasActiveMolstarViewerHost(two.viewerId, 'saved-view:two')).toBe(true);
    expect(hasActiveMolstarViewerHost(one.viewerId, 'saved-view:unowned')).toBe(false);
    expect(useStructure3dStore.getState().expandedStructures['saved-view:one']).toBeDefined();
    expect(setup.load).toHaveBeenCalledTimes(2);
    one.dispose();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(viewerCache.has(two.cacheKey)).toBe(true);
    expect(useStructure3dStore.getState().expandedStructures['saved-view:one']).toBeUndefined();
    two.dispose();
  });

  it('does not expose a registration or retain a plugin after loading fails', async () => {
    const dispose = vi.fn();
    setup.create.mockImplementation(async (options) => {
      queueMicrotask(() => options.onComplete());
      return {
        container: document.createElement('div'),
        plugin: { dispose },
        isLoading: false,
        error: 'Could not draw pinned scene',
        lastUsed: Date.now(),
      };
    });
    await expect(
      createMolecularExperimentViewer(
        fixture('saved-view:broken'),
        'Broken',
        'default',
        'saved-view-replay'
      )
    ).rejects.toThrow('Could not draw pinned scene');
    expect(dispose).toHaveBeenCalledOnce();
    expect(viewerCache.size).toBe(0);
    expect(document.querySelector('[data-protein-experiment-view]')).toBeNull();
    expect(useStructure3dStore.getState().expandedStructures).toEqual({});
  });

  it('binds every saved comparison resource before replaying its scene', async () => {
    const pinnedAssets = [
      {
        name: 'asset-2.cif',
        format: 'cif',
        text: 'data_comparison',
        sha256: 'b'.repeat(64),
        label: 'Comparison state',
      },
    ];
    const base = fixture('saved-view:comparison');
    const view = await createMolecularExperimentViewer(
      { ...base, attrs: { ...base.attrs, molViewSpecAssets: pinnedAssets } },
      'Comparison',
      'default',
      'saved-view-replay'
    );
    const plugin = viewerCache.get(view.cacheKey)!.plugin;
    expect(view.viewerId).toBe(
      `saved-comparison:sha256:${base.attrs.coordinateSha256}:${pinnedAssets[0].sha256}`
    );
    expect(setup.bindAssets).toHaveBeenCalledExactlyOnceWith(plugin, pinnedAssets);
    expect(setup.bindAssets.mock.invocationCallOrder[0]).toBeLessThan(
      setup.load.mock.invocationCallOrder[0]
    );
    view.dispose();
  });

  it('opens a saved story at its persisted snapshot index', async () => {
    const base = fixture('saved-view:story');
    const view = await createMolecularExperimentViewer(
      { ...base, attrs: { ...base.attrs, molViewSpecSnapshotIndex: 1 } },
      'Saved story',
      'default',
      'saved-view-replay'
    );
    expect(setup.load).toHaveBeenCalledExactlyOnceWith(
      viewerCache.get(view.cacheKey)!.plugin,
      'pinned-scene',
      undefined,
      { initialSnapshotIndex: 1 }
    );
    view.dispose();
  });

  it('enforces queued preconditions and forwards native validation before persistence', async () => {
    const view = await createMolecularExperimentViewer(
      fixture('saved-view:conditions'),
      'Conditions',
      'default',
      'saved-view-replay'
    );
    const apply = setup.controller.mock.calls[0][1];
    const beforeApply = vi.fn();
    const validateNative = vi.fn();
    const rendered = vi.fn();
    await apply('next-scene', rendered, { beforeApply, validateNative, initialSnapshotIndex: 2 });
    expect(beforeApply).toHaveBeenCalledOnce();
    expect(setup.load).toHaveBeenLastCalledWith(
      expect.anything(),
      'next-scene',
      expect.any(Function),
      { beforeApply, validateNative, initialSnapshotIndex: 2, rejectDuplicateGeometry: true }
    );
    expect(beforeApply.mock.invocationCallOrder[0]).toBeLessThan(
      setup.load.mock.invocationCallOrder.at(-1)!
    );
    const loaded = setup.load.mock.calls.length;
    await expect(
      apply('stale-scene', rendered, {
        beforeApply: () => {
          throw Error('stale');
        },
      })
    ).rejects.toThrow('stale');
    expect(setup.load).toHaveBeenCalledTimes(loaded);
    expect(rendered).toHaveBeenCalledOnce();
    view.dispose();
  });

  it('refuses the old styled-helper preparation and checks that a fresh scene is unchanged at dispatch', async () => {
    await expect(
      createMolecularExperimentViewer(fixture('saved-view:old-helper'), 'Old')
    ).rejects.toThrow();
    expect(setup.create).not.toHaveBeenCalled();
    const scene = freshMolecularTrialScene([
      { uri: 'structure.cif', format: 'cif', params: { type: 'model' } },
    ]);
    setup.scene.mockReturnValue({ scene });
    const view = await createMolecularExperimentViewer(
      {
        structureViewId: 'saved-view:fresh',
        attrs: {
          source: 'file',
          sourceId: 'data_test',
          coordinateSha256: await coordinateDigest('data_test'),
          molViewSpec: scene,
          label: 'Fresh pinned coordinates',
        },
      },
      'Fresh'
    );
    expect(setup.load).toHaveBeenLastCalledWith(expect.anything(), scene, undefined, {
      initialSnapshotIndex: 0,
      coordinateOnlyInitialLoad: true,
    });
    await expect(view.assertFreshStart()).resolves.toBeUndefined();
    setup.scene.mockReturnValue({ scene: 'prior-styled-scene' });
    await expect(view.assertFreshStart()).rejects.toThrow(/changed before/);
    view.dispose();
  });
});
