import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../canvas/public/types';

const controls = vi.hoisted(() => ({
  hydrated: false,
  panels: {} as Record<string, { tabs: Tab[] }>,
  onChange: undefined as (() => void) | undefined,
  onHydration: undefined as (() => void) | undefined,
  setOpenVersions: vi.fn(async () => undefined),
  unsubscribe: vi.fn(),
  unsubscribeHydration: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ referenceAssets: { setOpenVersions: controls.setOpenVersions } }),
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({ panels: controls.panels }),
    subscribe: (callback: () => void) => {
      controls.onChange = callback;
      return controls.unsubscribe;
    },
    persist: {
      hasHydrated: () => controls.hydrated,
      onFinishHydration: (callback: () => void) => {
        controls.onHydration = callback;
        return controls.unsubscribeHydration;
      },
    },
  },
}));
import {
  installReferenceVersionUsageTracking,
  openReferenceVersions,
} from './reference-version-usage';

function tab(generationId: string, bundle = true): Tab {
  return {
    id: generationId,
    type: 'sequence',
    title: 'Reference',
    entityId: generationId,
    indexedGenome: {
      sourcePath: `/cache/grch38/generations/${generationId}/prepared/chr1/chr1.fa`,
      assembly: { assemblyId: 'grch38' },
      ...(bundle ? { assemblyPortableBundleFingerprint: generationId } : {}),
    },
  } as Tab;
}

beforeEach(() => {
  vi.clearAllMocks();
  controls.hydrated = false;
  controls.panels = {};
  controls.onChange = undefined;
  controls.onHydration = undefined;
});

describe('reference version reader leases', () => {
  it('acknowledges a second opening of the same version without reporting viewport changes', async () => {
    const first = tab('previous');
    const second = { ...tab('previous'), id: 'second-view' };
    controls.hydrated = true;
    controls.panels = { active: { tabs: [first] } };
    const stop = installReferenceVersionUsageTracking();
    try {
      await vi.waitFor(() => expect(controls.setOpenVersions).toHaveBeenCalledTimes(1));
      controls.panels.active.tabs = [first, second];
      controls.onChange?.();
      await vi.waitFor(() => expect(controls.setOpenVersions).toHaveBeenCalledTimes(2));
      expect(controls.setOpenVersions).toHaveBeenLastCalledWith([
        { catalogId: 'grch38', generationId: 'previous' },
      ]);
      controls.onChange?.();
      await Promise.resolve();
      expect(controls.setOpenVersions).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('deduplicates versions across inactive tabs and retains legacy generation paths', () => {
    expect(
      openReferenceVersions([tab('old'), tab('old'), tab('legacy', false), { id: 'text' } as Tab])
    ).toEqual([
      { catalogId: 'grch38', generationId: 'old' },
      { catalogId: 'grch38', generationId: 'legacy' },
    ]);
  });

  it('reports all restored panels before allowing collection, then releases only closed tabs', async () => {
    const stop = installReferenceVersionUsageTracking();
    controls.onChange?.();
    await Promise.resolve();
    expect(controls.setOpenVersions).not.toHaveBeenCalled();
    controls.panels = { active: { tabs: [tab('current')] }, inactive: { tabs: [tab('previous')] } };
    controls.hydrated = true;
    controls.onHydration?.();
    await vi.waitFor(() =>
      expect(controls.setOpenVersions).toHaveBeenCalledWith([
        { catalogId: 'grch38', generationId: 'current' },
        { catalogId: 'grch38', generationId: 'previous' },
      ])
    );
    controls.panels.active.tabs = [];
    controls.onChange?.();
    await vi.waitFor(() =>
      expect(controls.setOpenVersions).toHaveBeenLastCalledWith([
        { catalogId: 'grch38', generationId: 'previous' },
      ])
    );
    stop();
    expect(controls.unsubscribe).toHaveBeenCalledOnce();
    expect(controls.unsubscribeHydration).toHaveBeenCalledOnce();
  });
});
