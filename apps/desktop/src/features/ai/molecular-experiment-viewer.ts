import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { structureKeyOverrideForAttrs } from '../page/public/embeds/structure3d/utils/structureSourceIdentity';
import {
  deleteCachedViewer,
  getViewerCacheKey,
  recordCacheInsert,
  registerActiveWrapper,
  unregisterActiveWrapper,
  viewerCache,
  type CachedViewer,
} from '../page/public/embeds/structure3d/molstar/cache';
import { createViewerContainer } from '../page/public/embeds/structure3d/molstar/createViewer';
import {
  getMolViewSpecScene,
  loadMolViewSpecScene,
  registerMolViewSpecController,
  sameLoadedMolViewSpecScene,
  bindMolViewSpecPinnedAssets,
} from '../page/public/embeds/structure3d/molstar/molViewSpec';
import {
  setMolViewSpecRenderProfile,
  type MolecularRenderProfileSelection,
} from '../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import { assertFreshMolecularTrialAttributes } from './molecular-trial-fixtures';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';

export type MolecularExperimentViewer = {
  structureViewId: string;
  viewerId: string;
  cacheKey: string;
  assertFreshStart(): Promise<void>;
  dispose(): void;
};

export async function createMolecularExperimentViewer(
  fixture: { structureViewId: string; attrs: unknown },
  label: string,
  renderProfile: MolecularRenderProfileSelection = 'default',
  purpose: 'fresh-author' | 'saved-view-replay' = 'fresh-author'
): Promise<MolecularExperimentViewer> {
  const source = fixture.attrs as Partial<Structure3dAttrs> | null;
  if (
    !source ||
    source.source !== 'file' ||
    typeof source.sourceId !== 'string' ||
    !source.sourceId ||
    typeof source.molViewSpec !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(source.coordinateSha256 ?? '')
  )
    throw new Error('A background experiment requires pinned coordinates and a saved scene.');
  if (purpose === 'fresh-author') await assertFreshMolecularTrialAttributes(source);
  const attrs = {
    ...source,
    structureViewIdentity: {
      schemaVersion: 1 as const,
      structureViewId: fixture.structureViewId,
      bindingId: null,
    },
  } as Structure3dAttrs;
  const viewerId = structureKeyOverrideForAttrs(attrs);
  if (!viewerId) throw new Error('The pinned viewer identity is unavailable.');
  const cacheKey = getViewerCacheKey(viewerId, `structure-panel:${fixture.structureViewId}`);
  if (
    viewerCache.has(cacheKey) ||
    useStructure3dStore.getState().expandedStructures[fixture.structureViewId]
  )
    throw new Error('This background structure view is already owned by another attempt.');
  const wrapper = document.createElement('div');
  wrapper.dataset.proteinExperimentView = fixture.structureViewId;
  wrapper.dataset.structureAgentHost = fixture.structureViewId;
  Object.assign(wrapper.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '768px',
    height: '768px',
    pointerEvents: 'none',
  });
  document.body.append(wrapper);
  let cached: CachedViewer | undefined;
  let unregisterController: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unregisterController?.();
    unregisterActiveWrapper(viewerId, wrapper, cacheKey);
    useStructure3dStore.getState().unregisterStructure(fixture.structureViewId);
    if (cached && viewerCache.get(cacheKey) === cached)
      deleteCachedViewer(cacheKey, 'protein-experiment-release');
    else cached?.plugin?.dispose();
    wrapper.remove();
  };
  try {
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    cached = await createViewerContainer({
      structureKey: viewerId,
      structureData: attrs.sourceId,
      coordinatesOnly: true,
      ...(purpose === 'fresh-author' ? { coordinateOnlyInitialLoad: true as const } : {}),
      height: 768,
      onBeforeReveal: async (plugin) => {
        setMolViewSpecRenderProfile(plugin, renderProfile);
        bindMolViewSpecPinnedAssets(plugin, attrs.molViewSpecAssets);
        await loadMolViewSpecScene(plugin, attrs.molViewSpec!, undefined, {
          initialSnapshotIndex: attrs.molViewSpecSnapshotIndex ?? 0,
          ...(purpose === 'fresh-author' ? { coordinateOnlyInitialLoad: true as const } : {}),
        });
      },
      onComplete: complete,
    });
    wrapper.append(cached.container);
    recordCacheInsert(cacheKey, cached);
    await completed;
    if (cached.error || !cached.plugin || cached.isLoading)
      throw new Error(cached.error ?? 'The background Mol* viewer did not become ready.');
    const plugin = cached.plugin;
    if (!sameLoadedMolViewSpecScene(getMolViewSpecScene(plugin).scene, attrs.molViewSpec!))
      throw new Error('The background viewer did not load the exact pinned scene.');
    const initialCamera = JSON.stringify(plugin.canvas3d?.camera.getSnapshot() ?? null);
    registerActiveWrapper(viewerId, wrapper, plugin, cacheKey);
    useStructure3dStore
      .getState()
      .registerStructure(
        fixture.structureViewId,
        attrs,
        `${label} · ${attrs.label ?? 'Structure'}`
      );
    let sceneQueue: Promise<void> = Promise.resolve();
    const isCurrent = () =>
      !disposed && wrapper.isConnected && viewerCache.get(cacheKey)?.plugin === plugin;
    unregisterController = registerMolViewSpecController(
      plugin,
      async (scene, onRendered, options) => {
        const operation = sceneQueue
          .catch(() => undefined)
          .then(async () => {
            if (!isCurrent()) throw new Error('The background attempt has ended.');
            options?.beforeApply?.();
            await loadMolViewSpecScene(plugin, scene, isCurrent, {
              ...options,
              rejectDuplicateGeometry: true,
            });
            onRendered?.();
          });
        sceneQueue = operation;
        await operation;
      }
    );
    const assertFreshStart = async () => {
      if (purpose !== 'fresh-author') throw new Error('Saved-view replay cannot dispatch a model.');
      await sceneQueue;
      if (
        !isCurrent() ||
        !sameLoadedMolViewSpecScene(getMolViewSpecScene(plugin).scene, attrs.molViewSpec!)
      )
        throw new Error('The authoring scene changed before its fresh model start.');
      const selected = plugin.managers?.structure?.selection?.stats?.elementCount ?? 0;
      const hasRepresentation = [...plugin.state.data.cells.values()].some(
        (cell) =>
          PluginStateObject.Molecule.Structure.Representation3D.is(cell.obj) ||
          PluginStateObject.Shape.Representation3D.is(cell.obj)
      );
      if (
        selected ||
        hasRepresentation ||
        JSON.stringify(plugin.canvas3d?.camera.getSnapshot() ?? null) !== initialCamera
      )
        throw new Error(
          'Fresh authoring refuses prior native representations, selections or camera context.'
        );
    };
    return {
      structureViewId: fixture.structureViewId,
      viewerId,
      cacheKey,
      assertFreshStart,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
