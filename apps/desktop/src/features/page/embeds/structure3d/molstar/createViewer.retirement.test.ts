import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { createViewerContainer } from './createViewer';
import { deleteCachedViewer, recordCacheInsert, viewerCache } from './cache';
import { initializePlugin } from './pluginConfig';
import { loadStructure } from './structureBuilder';

vi.mock('./pluginConfig', () => ({ initializePlugin: vi.fn(), setPluginSpin: vi.fn() }));
vi.mock('./structureBuilder', () => ({ loadStructure: vi.fn() }));
vi.mock('./nucleotidePresentation', () => ({ registerMolecularRenderProfileVisuals: vi.fn() }));
vi.mock('./yieldToMain', () => ({ yieldToMain: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./viewerReadiness', () => ({
  waitForDimensions: vi.fn().mockResolvedValue(undefined),
  waitForPluginInteractionReady: vi.fn().mockResolvedValue({ structureCount: 1 }),
  waitForFirstPaintBeforeReveal: vi.fn().mockResolvedValue({}),
}));

function createPluginFixture(): PluginContext {
  const plugin = new PluginContext({ behaviors: [] });
  vi.spyOn(plugin, 'dispose');
  return plugin;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const key of viewerCache.keys()) deleteCachedViewer(key);
});

it('disposes a plugin acquired after its cache entry retired without loading or publishing it', async () => {
  let resolvePlugin!: (plugin: Awaited<ReturnType<typeof initializePlugin>>) => void;
  vi.mocked(initializePlugin).mockReturnValue(
    new Promise((resolve) => {
      resolvePlugin = resolve;
    })
  );
  const onLoad = vi.fn();
  const onError = vi.fn();
  const onComplete = vi.fn();
  const cached = await createViewerContainer({
    structureKey: 'retired-host',
    onLoad,
    onError,
    onComplete,
  });
  recordCacheInsert('retired-host', cached);
  await vi.waitFor(() => expect(initializePlugin).toHaveBeenCalledOnce());
  deleteCachedViewer('retired-host');
  const plugin = createPluginFixture();
  resolvePlugin(plugin);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(plugin.dispose).toHaveBeenCalledOnce();
  expect(cached.plugin).toBeNull();
  expect(viewerCache.has('retired-host')).toBe(false);
  expect(loadStructure).not.toHaveBeenCalled();
  expect(onLoad).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
});

it('retires an acquired plugin while structure loading is pending without publishing completion', async () => {
  let resolveLoad!: () => void;
  vi.mocked(loadStructure).mockReturnValue(
    new Promise<void>((resolve) => {
      resolveLoad = resolve;
    })
  );
  const plugin = createPluginFixture();
  vi.mocked(initializePlugin).mockResolvedValue(plugin);
  const onLoad = vi.fn();
  const onComplete = vi.fn();
  const onError = vi.fn();
  const cached = await createViewerContainer({
    structureKey: 'loading-host',
    onLoad,
    onComplete,
    onError,
  });
  recordCacheInsert('loading-host', cached);
  await vi.waitFor(() => expect(loadStructure).toHaveBeenCalledOnce());
  deleteCachedViewer('loading-host');
  resolveLoad();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(plugin.dispose).toHaveBeenCalledOnce();
  expect(cached.plugin).toBe(plugin);
  expect(cached.resourcePhase).toBe('retired');
  expect(cached.loadedStructureKey).toBeNull();
  expect(onLoad).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
