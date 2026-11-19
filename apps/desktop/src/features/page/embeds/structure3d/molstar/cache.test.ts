/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  viewerCache,
  enforceCacheLimit,
  recordCacheInsert,
  getPaneRendererHostCacheKey,
  getViewerCacheKey,
  registerActiveWrapper,
  unregisterActiveWrapper,
  hasActiveMolstarViewerHost,
  withActivePlugin,
  clearViewerCache,
  clearViewerCacheLifecycleDiagnostics,
  acquireCachedViewerLease,
  releaseCachedViewerLease,
  PANE_RENDERER_HOST_RELEASE_GRACE_MS,
  getStructureKey,
  getStructureRepresentationDiagnostics,
  requestStructureDrawDiagnostics,
  getViewerCacheLifecycleDiagnostics,
  MOLSTAR_VIEWER_RENDERER_CACHE_VERSION,
  recordPendingCreationAdd,
  recordPendingCreationDelete,
  deleteCachedViewer,
  type ActiveMolstarViewer,
  type CachedViewer,
} from './cache';

function fakeViewer(
  opts: { lastUsed: number; connected: boolean } = { lastUsed: 0, connected: true }
): CachedViewer {
  const container = document.createElement('div');
  if (opts.connected) document.body.appendChild(container);
  return {
    container,
    plugin: { dispose: vi.fn() } as unknown as CachedViewer['plugin'],
    isLoading: false,
    error: null,
    lastUsed: opts.lastUsed,
  };
}

beforeEach(() => {
  clearViewerCache('test-beforeEach');
  clearViewerCacheLifecycleDiagnostics();
  document.body.replaceChildren();
});

describe('getStructureKey', () => {
  it('normalizes display PDB and AlphaFold props into provider identity keys', () => {
    expect(getStructureKey('1rbl')).toBe('provider:RCSB:1RBL:ENTRY');
    expect(getStructureKey(undefined, 'p03817')).toBe('provider:AF:P03817:F1:LATEST');
    expect(
      getStructureKey(undefined, 'P03817', undefined, undefined, {
        provider: 'alphafold',
        externalId: 'AF:P03817:F1:V6',
      })
    ).toBe('provider:AF:P03817:F1:V6:MODEL:AF-P03817-F1-model_v6');
    expect(
      getStructureKey(undefined, 'P03817', undefined, undefined, {
        provider: 'alphafold',
        externalId: 'AF:P03817:F1:V6:MODEL:AF-P03817-F1-model_v6',
      })
    ).toBe('provider:AF:P03817:F1:V6:MODEL:AF-P03817-F1-model_v6');
  });

  it('includes explicit RCSB scope fields in provider identity cache keys', () => {
    expect(
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        labelAsymIds: ['A'],
      })
    ).toBe('provider:RCSB:1RBL:ENTRY:LABEL_ASYM:A');
    expect(
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        labelAsymIds: ['A'],
      })
    ).not.toBe(
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        labelAsymIds: ['B'],
      })
    );
  });

  it('keeps case-sensitive RCSB author-chain scopes as separate viewer cache keys', () => {
    expect(
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
      })
    ).toBe('provider:RCSB:1RBL:ENTRY:AUTH_ASYM:a');
    expect(
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
      })
    ).not.toBe(
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:A',
      })
    );
  });

  it('rejects malformed RCSB provider identities before using a broader viewer cache key', () => {
    expect(() =>
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM',
      })
    ).toThrow('Invalid RCSB structure identity');
    expect(() =>
      getStructureKey(undefined, undefined, undefined, undefined, {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:UNKNOWN:A',
      })
    ).toThrow('Unsupported RCSB scope');
  });
});

describe('getViewerCacheKey', () => {
  it('records the full-entry complex component topology cache migration', () => {
    expect(MOLSTAR_VIEWER_RENDERER_CACHE_VERSION).toBe('renderer-v10-full-entry-complex-build');
  });

  it('includes the Molstar renderer schema so component-builder changes invalidate stale plugins', () => {
    expect(getViewerCacheKey('provider:RCSB:4V8X:ENTRY:AUTH_ASYM:AY,AZ,CY,CZ')).toBe(
      `provider:RCSB:4V8X:ENTRY:AUTH_ASYM:AY,AZ,CY,CZ::${MOLSTAR_VIEWER_RENDERER_CACHE_VERSION}`
    );
    expect(getViewerCacheKey('provider:RCSB:4V8X:ENTRY:AUTH_ASYM:AY,AZ,CY,CZ')).not.toBe(
      'provider:RCSB:4V8X:ENTRY:AUTH_ASYM:AY,AZ,CY,CZ'
    );
    expect(getViewerCacheKey('provider:RCSB:4V8X:ENTRY:AUTH_ASYM:AY,AZ,CY,CZ', 'drawer')).toBe(
      `provider:RCSB:4V8X:ENTRY:AUTH_ASYM:AY,AZ,CY,CZ::${MOLSTAR_VIEWER_RENDERER_CACHE_VERSION}::instance:drawer`
    );
  });

  it('keys a pane renderer host independently from whichever structure tab is active', () => {
    expect(getPaneRendererHostCacheKey('pane:main')).toBe(
      `${MOLSTAR_VIEWER_RENDERER_CACHE_VERSION}::pane-host:pane:main`
    );
    expect(getPaneRendererHostCacheKey('pane:main')).not.toContain('FUN12');
    expect(getPaneRendererHostCacheKey('pane:main')).not.toContain('1FS0');
    expect(getPaneRendererHostCacheKey('pane:other')).not.toBe(
      getPaneRendererHostCacheKey('pane:main')
    );
  });
});

describe('enforceCacheLimit', () => {
  it('does nothing when size <= maxSize', () => {
    viewerCache.set('a', fakeViewer({ lastUsed: 1, connected: true }));
    viewerCache.set('b', fakeViewer({ lastUsed: 2, connected: true }));
    enforceCacheLimit(5);
    expect(viewerCache.size).toBe(2);
  });

  it('evicts oldest entries when exceeding the cap', () => {
    viewerCache.set('a', fakeViewer({ lastUsed: 1, connected: true }));
    viewerCache.set('b', fakeViewer({ lastUsed: 2, connected: true }));
    viewerCache.set('c', fakeViewer({ lastUsed: 3, connected: true }));
    enforceCacheLimit(2);
    expect(viewerCache.size).toBe(2);
    expect(viewerCache.has('a')).toBe(false);
    expect(viewerCache.has('b')).toBe(true);
    expect(viewerCache.has('c')).toBe(true);
  });

  it('prefers disconnected entries over connected ones, regardless of lastUsed', () => {
    viewerCache.set('connected-old', fakeViewer({ lastUsed: 1, connected: true }));
    viewerCache.set('disconnected-new', fakeViewer({ lastUsed: 999, connected: false }));
    viewerCache.set('connected-new', fakeViewer({ lastUsed: 100, connected: true }));
    enforceCacheLimit(2);
    expect(viewerCache.size).toBe(2);
    expect(viewerCache.has('disconnected-new')).toBe(false);
    expect(viewerCache.has('connected-old')).toBe(true);
    expect(viewerCache.has('connected-new')).toBe(true);
  });

  it('disposes the plugin on eviction', () => {
    const evicted = fakeViewer({ lastUsed: 1, connected: false });
    viewerCache.set('to-evict', evicted);
    viewerCache.set('keep', fakeViewer({ lastUsed: 2, connected: true }));
    enforceCacheLimit(1);
    expect(evicted.plugin?.dispose).toHaveBeenCalled();
  });

  it('swallows errors thrown by plugin.dispose', () => {
    const evicted = fakeViewer({ lastUsed: 1, connected: false });
    (evicted.plugin!.dispose as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('plugin already gone');
    });
    viewerCache.set('to-evict', evicted);
    viewerCache.set('keep', fakeViewer({ lastUsed: 2, connected: true }));
    expect(() => enforceCacheLimit(1)).not.toThrow();
    expect(viewerCache.has('to-evict')).toBe(false);
  });

  it('does not evict an active viewer during a transient container detach', () => {
    const active = fakeViewer({ lastUsed: 1, connected: false });
    const inactive = fakeViewer({ lastUsed: 2, connected: false });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    wrapper.appendChild(active.container);
    viewerCache.set('active', active);
    viewerCache.set('inactive', inactive);
    registerActiveWrapper('structure:active', wrapper, active.plugin, 'active');

    active.container.remove();
    enforceCacheLimit(1);

    expect(viewerCache.has('active')).toBe(true);
    expect(viewerCache.has('inactive')).toBe(false);
    expect(active.plugin?.dispose).not.toHaveBeenCalled();
    expect(inactive.plugin?.dispose).toHaveBeenCalled();
  });
});

describe('recordCacheInsert', () => {
  it('inserts a new entry under the cap (default 16) without evicting', () => {
    for (let i = 0; i < 16; i++) {
      recordCacheInsert(`k-${i}`, fakeViewer({ lastUsed: i, connected: true }));
    }
    expect(viewerCache.size).toBe(16);
  });

  it('evicts the oldest when crossing the default cap', () => {
    for (let i = 0; i < 17; i++) {
      recordCacheInsert(`k-${i}`, fakeViewer({ lastUsed: i, connected: true }));
    }
    expect(viewerCache.size).toBe(16);
    expect(viewerCache.has('k-0')).toBe(false);
    expect(viewerCache.has('k-16')).toBe(true);
  });

  it('does not evict the just-inserted disconnected viewer when all existing viewers are connected', () => {
    for (let i = 0; i < 16; i++) {
      recordCacheInsert(`k-${i}`, fakeViewer({ lastUsed: i + 1, connected: true }));
    }

    recordCacheInsert('fresh-disconnected', fakeViewer({ lastUsed: 0, connected: false }));

    expect(viewerCache.size).toBe(16);
    expect(viewerCache.has('fresh-disconnected')).toBe(true);
    expect(viewerCache.has('k-0')).toBe(false);
  });
});

describe('pane renderer host leases', () => {
  it('cancels deferred disposal when the same pane is remounted', async () => {
    vi.useFakeTimers();
    const key = getPaneRendererHostCacheKey('pane:main');
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    viewerCache.set(key, cached);

    acquireCachedViewerLease(key);
    releaseCachedViewerLease(key);
    await vi.advanceTimersByTimeAsync(PANE_RENDERER_HOST_RELEASE_GRACE_MS - 1);
    acquireCachedViewerLease(key);
    await vi.advanceTimersByTimeAsync(PANE_RENDERER_HOST_RELEASE_GRACE_MS + 1);

    expect(viewerCache.get(key)).toBe(cached);
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('disposes an unleased pane renderer after the pane-removal grace period', async () => {
    vi.useFakeTimers();
    const key = getPaneRendererHostCacheKey('pane:closed');
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    viewerCache.set(key, cached);

    acquireCachedViewerLease(key);
    releaseCachedViewerLease(key);
    await vi.advanceTimersByTimeAsync(PANE_RENDERER_HOST_RELEASE_GRACE_MS + 1);

    expect(viewerCache.has(key)).toBe(false);
    expect(cached.plugin?.dispose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('requestStructureDrawDiagnostics', () => {
  const invalidPostDrawStates: Array<{
    label: string;
    mutate: (cached: CachedViewer) => void;
    reason: string;
  }> = [
    {
      label: 'loading a replacement structure',
      mutate: (cached) => {
        cached.isLoading = true;
      },
      reason: 'viewer_loading',
    },
    {
      label: 'in an error state',
      mutate: (cached) => {
        cached.error = 'replacement failed';
      },
      reason: 'viewer_error',
    },
    {
      label: 'between requested and loaded structure identities',
      mutate: (cached) => {
        cached.rendererHostActivation = {
          generation: 2,
          requestedStructureKey: 'structure-B',
          loadedStructureKey: 'structure-A',
          queue: Promise.resolve(),
        };
      },
      reason: 'structure_identity_not_ready',
    },
  ];

  it('proves scientific scene readiness from Molstar didDraw without reading the discarded framebuffer', async () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    container.appendChild(canvas);
    document.body.appendChild(container);
    const getContext = vi.spyOn(canvas, 'getContext');
    let drawListener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    viewerCache.set('structure-key', {
      container,
      plugin: {
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [
                  {
                    cell: { obj: { data: { models: [] } } },
                    components: [{ representations: [{}] }],
                  },
                ],
              },
            },
          },
        },
        canvas3d: {
          reprCount: { value: 1 },
          didDraw: {
            subscribe: (listener: () => void) => {
              drawListener = listener;
              listener();
              return { unsubscribe };
            },
          },
          requestDraw: () => drawListener?.(),
        },
      } as unknown as CachedViewer['plugin'],
      isLoading: false,
      error: null,
      lastUsed: Date.now(),
      loadedStructureKey: 'structure-key',
    });

    await expect(requestStructureDrawDiagnostics('structure-key', 20)).resolves.toEqual([
      expect.objectContaining({
        drewFrame: true,
        canvasRepresentationCount: 1,
        canvasWidth: 640,
        canvasHeight: 480,
        structureCount: 1,
        representationCount: 1,
        scientificContentReady: true,
        reason: 'molstar_did_draw_scientific_scene',
      }),
    ]);
    expect(getContext).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects a didDraw frame when the scientific scene is cleared during the request', async () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    container.appendChild(canvas);
    document.body.appendChild(container);
    let drawListener: (() => void) | undefined;
    const structures = [
      { cell: { obj: { data: { models: [] } } }, components: [{ representations: [{}] }] },
    ];
    const reprCount = { value: 1 };
    viewerCache.set('structure-key', {
      container,
      plugin: {
        managers: {
          structure: {
            hierarchy: { current: { structures } },
          },
        },
        canvas3d: {
          reprCount,
          didDraw: {
            subscribe: (listener: () => void) => {
              drawListener = listener;
              return { unsubscribe: vi.fn() };
            },
          },
          requestDraw: () => {
            structures.splice(0, structures.length);
            reprCount.value = 0;
            drawListener?.();
          },
        },
      } as unknown as CachedViewer['plugin'],
      isLoading: false,
      error: null,
      lastUsed: Date.now(),
      loadedStructureKey: 'structure-key',
    });

    await expect(requestStructureDrawDiagnostics('structure-key', 20)).resolves.toEqual([
      expect.objectContaining({
        drewFrame: true,
        canvasRepresentationCount: 0,
        structureCount: 0,
        representationCount: 0,
        scientificContentReady: false,
        reason: 'scene_not_ready',
      }),
    ]);
  });

  it('rejects a didDraw frame from a viewer replaced under the same cache key', async () => {
    const originalContainer = document.createElement('div');
    const originalCanvas = document.createElement('canvas');
    originalCanvas.width = 640;
    originalCanvas.height = 480;
    originalContainer.appendChild(originalCanvas);
    document.body.appendChild(originalContainer);
    let drawListener: (() => void) | undefined;

    const replacementContainer = document.createElement('div');
    const replacementCanvas = document.createElement('canvas');
    replacementCanvas.width = 800;
    replacementCanvas.height = 600;
    replacementContainer.appendChild(replacementCanvas);
    document.body.appendChild(replacementContainer);
    const replacement = {
      container: replacementContainer,
      plugin: {
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [
                  {
                    cell: { obj: { data: { models: [] } } },
                    components: [{ representations: [{}] }],
                  },
                ],
              },
            },
          },
        },
        canvas3d: { reprCount: { value: 1 } },
      } as unknown as CachedViewer['plugin'],
      isLoading: false,
      error: null,
      lastUsed: Date.now(),
      loadedStructureKey: 'structure-key',
    } satisfies CachedViewer;

    viewerCache.set('structure-key', {
      container: originalContainer,
      plugin: {
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [
                  {
                    cell: { obj: { data: { models: [] } } },
                    components: [{ representations: [{}] }],
                  },
                ],
              },
            },
          },
        },
        canvas3d: {
          reprCount: { value: 1 },
          didDraw: {
            subscribe: (listener: () => void) => {
              drawListener = listener;
              return { unsubscribe: vi.fn() };
            },
          },
          requestDraw: () => {
            viewerCache.set('structure-key', replacement);
            drawListener?.();
          },
        },
      } as unknown as CachedViewer['plugin'],
      isLoading: false,
      error: null,
      lastUsed: Date.now(),
      loadedStructureKey: 'structure-key',
    });

    await expect(requestStructureDrawDiagnostics('structure-key', 20)).resolves.toEqual([
      expect.objectContaining({
        drewFrame: true,
        canvasWidth: 800,
        canvasHeight: 600,
        scientificContentReady: false,
        reason: 'viewer_changed_during_draw',
      }),
    ]);
  });

  it.each(invalidPostDrawStates)(
    'rejects a didDraw frame while the same viewer is $label',
    async ({ mutate, reason }) => {
      const container = document.createElement('div');
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      container.appendChild(canvas);
      document.body.appendChild(container);
      let drawListener: (() => void) | undefined;
      let cached!: CachedViewer;
      cached = {
        container,
        plugin: {
          managers: {
            structure: {
              hierarchy: {
                current: {
                  structures: [
                    {
                      cell: { obj: { data: { models: [] } } },
                      components: [{ representations: [{}] }],
                    },
                  ],
                },
              },
            },
          },
          canvas3d: {
            reprCount: { value: 1 },
            didDraw: {
              subscribe: (listener: () => void) => {
                drawListener = listener;
                return { unsubscribe: vi.fn() };
              },
            },
            requestDraw: () => {
              mutate(cached);
              drawListener?.();
            },
          },
        } as unknown as CachedViewer['plugin'],
        isLoading: false,
        error: null,
        lastUsed: Date.now(),
        loadedStructureKey: 'structure-A',
      };
      viewerCache.set('structure-key', cached);

      await expect(requestStructureDrawDiagnostics('structure-key', 20)).resolves.toEqual([
        expect.objectContaining({
          drewFrame: true,
          scientificContentReady: false,
          reason,
        }),
      ]);
    }
  );
});

describe('viewer cache lifecycle diagnostics', () => {
  it('disposes the plugin exactly once when an error entry is deleted for retry', () => {
    const cached = fakeViewer({ lastUsed: 123, connected: false });
    const dispose = cached.plugin!.dispose as ReturnType<typeof vi.fn>;
    viewerCache.set('failed-first-paint', cached);

    deleteCachedViewer('failed-first-paint', 'cached-error-effect:first-paint-timeout');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(viewerCache.has('failed-first-paint')).toBe(false);
  });

  it('records pending, insert, and delete reasons for live MolStar debugging', () => {
    const cached = fakeViewer({ lastUsed: 123, connected: true });

    recordPendingCreationAdd('structure-key', 'unit-start');
    recordCacheInsert('structure-key', cached);
    recordPendingCreationDelete('structure-key', 'unit-complete');
    deleteCachedViewer('structure-key', 'unit-error-recovery');

    const snapshot = getViewerCacheLifecycleDiagnostics();

    expect(snapshot.cacheKeys).toEqual([]);
    expect(snapshot.pendingKeys).toEqual([]);
    expect(snapshot.events.map((event) => `${event.event}:${event.reason}`)).toEqual([
      'pending-add:unit-start',
      'insert:recordCacheInsert',
      'pending-delete:unit-complete',
      'delete:unit-error-recovery',
    ]);
    expect(snapshot.events[0]).toMatchObject({
      key: 'structure-key',
      pendingKeys: ['structure-key'],
    });
    expect(snapshot.events[1]).toMatchObject({
      key: 'structure-key',
      entry: {
        hasPlugin: true,
        isConnected: true,
        childCount: 0,
        lastUsed: 123,
      },
    });
    expect(snapshot.events[3]).toMatchObject({
      key: 'structure-key',
      existed: true,
      cacheSizeBefore: 1,
      cacheSizeAfter: 0,
      entry: {
        hasPlugin: true,
      },
    });
  });
});

describe('withActivePlugin', () => {
  it('refreshes lastUsed when registering the active wrapper', () => {
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    wrapper.appendChild(cached.container);
    viewerCache.set('pdb:1ABC', cached);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456);

    registerActiveWrapper('pdb:1ABC', wrapper, cached.plugin);

    expect(cached.lastUsed).toBe(123456);
    nowSpy.mockRestore();
  });

  it('runs against the active wrapper for a ready cached viewer', async () => {
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    wrapper.appendChild(cached.container);
    viewerCache.set('pdb:1ABC', cached);
    registerActiveWrapper('pdb:1ABC', wrapper, cached.plugin);

    const result = await withActivePlugin('pdb:1ABC', (active) => ({
      key: active.structureKey,
      plugin: active.plugin,
      wrapper: active.wrapper,
      container: active.container,
    }));

    expect(result).toEqual({
      key: 'pdb:1ABC',
      plugin: cached.plugin,
      wrapper,
      container: cached.container,
    });
  });

  it('throws PLUGIN_NOT_READY when the cached plugin is still loading', async () => {
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    cached.plugin = null;
    cached.isLoading = true;
    viewerCache.set('pdb:1ABC', cached);

    await expect(withActivePlugin('pdb:1ABC', () => undefined)).rejects.toMatchObject({
      code: 'PLUGIN_NOT_READY',
      details: { viewerId: 'pdb:1ABC' },
    });
  });

  it('throws VIEWER_NOT_FOUND when the registered wrapper disconnects', async () => {
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    wrapper.appendChild(cached.container);
    viewerCache.set('pdb:1ABC', cached);
    registerActiveWrapper('pdb:1ABC', wrapper, cached.plugin);
    document.body.removeChild(wrapper);

    await expect(withActivePlugin('pdb:1ABC', () => undefined)).rejects.toMatchObject({
      code: 'VIEWER_NOT_FOUND',
      details: { viewerId: 'pdb:1ABC' },
    });
  });

  it('unregisters only the matching wrapper', async () => {
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    const wrapper = document.createElement('div');
    const otherWrapper = document.createElement('div');
    document.body.append(wrapper, otherWrapper);
    wrapper.appendChild(cached.container);
    viewerCache.set('pdb:1ABC', cached);
    registerActiveWrapper('pdb:1ABC', wrapper, cached.plugin);

    unregisterActiveWrapper('pdb:1ABC', otherWrapper);
    await expect(withActivePlugin('pdb:1ABC', () => 'ok')).resolves.toBe('ok');

    unregisterActiveWrapper('pdb:1ABC', wrapper);
    await expect(withActivePlugin('pdb:1ABC', () => undefined)).rejects.toMatchObject({
      code: 'VIEWER_NOT_FOUND',
    });
  });

  it('reports liveness from connected renderer hosts rather than retained cache entries', () => {
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    wrapper.appendChild(cached.container);
    viewerCache.set('pdb:1ABC', cached);

    expect(hasActiveMolstarViewerHost('pdb:1ABC')).toBe(false);
    registerActiveWrapper('pdb:1ABC', wrapper, cached.plugin);
    expect(hasActiveMolstarViewerHost('pdb:1ABC')).toBe(true);
    wrapper.setAttribute('data-structure-agent-host', 'owning-document');
    expect(hasActiveMolstarViewerHost('pdb:1ABC', 'owning-document')).toBe(true);
    expect(hasActiveMolstarViewerHost('pdb:1ABC', 'retired-source')).toBe(false);

    wrapper.remove();
    expect(hasActiveMolstarViewerHost('pdb:1ABC')).toBe(false);
    expect(viewerCache.has('pdb:1ABC')).toBe(true);
  });

  it('resolves a public structure id to an instance-scoped cached viewer', async () => {
    const cacheKey = getViewerCacheKey('pdb:1ABC', 'tab-1');
    const cached = fakeViewer({ lastUsed: 1, connected: false });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    wrapper.appendChild(cached.container);
    viewerCache.set(cacheKey, cached);
    registerActiveWrapper('pdb:1ABC', wrapper, cached.plugin, cacheKey);

    const result = await withActivePlugin('pdb:1ABC', (active) => ({
      key: active.structureKey,
      plugin: active.plugin,
      wrapper: active.wrapper,
      container: active.container,
    }));

    expect(result).toEqual({
      key: 'pdb:1ABC',
      plugin: cached.plugin,
      wrapper,
      container: cached.container,
    });
  });

  it('keeps another active instance discoverable when one same-structure viewer unmounts', async () => {
    const tabKey = getViewerCacheKey('pdb:1ABC', 'tab-1');
    const drawerKey = getViewerCacheKey('pdb:1ABC', 'drawer-1');
    const tab = fakeViewer({ lastUsed: 1, connected: false });
    const drawer = fakeViewer({ lastUsed: 2, connected: false });
    const tabWrapper = document.createElement('div');
    const drawerWrapper = document.createElement('div');
    document.body.append(tabWrapper, drawerWrapper);
    tabWrapper.appendChild(tab.container);
    drawerWrapper.appendChild(drawer.container);
    viewerCache.set(tabKey, tab);
    viewerCache.set(drawerKey, drawer);
    registerActiveWrapper('pdb:1ABC', tabWrapper, tab.plugin, tabKey);
    registerActiveWrapper('pdb:1ABC', drawerWrapper, drawer.plugin, drawerKey);

    unregisterActiveWrapper('pdb:1ABC', drawerWrapper, drawerKey);

    const result = await withActivePlugin('pdb:1ABC', (active) => ({
      plugin: active.plugin,
      wrapper: active.wrapper,
      container: active.container,
    }));
    expect(result).toEqual({
      plugin: tab.plugin,
      wrapper: tabWrapper,
      container: tab.container,
    });
  });

  it('refuses the previous document in the same pane even when it has the same coordinates', async () => {
    const coordinateKey = `saved-coordinate:sha256:${'a'.repeat(64)}`;
    const cacheKey = getPaneRendererHostCacheKey('pane:main', 'loaded');
    const viewer = fakeViewer({ lastUsed: 1, connected: false });
    const firstOwner = document.createElement('section');
    firstOwner.dataset.structureAgentHost = 'molecular-document:project::first';
    const secondOwner = document.createElement('section');
    secondOwner.dataset.structureAgentHost = 'molecular-document:project::second';
    const firstWrapper = document.createElement('div');
    const secondWrapper = document.createElement('div');
    document.body.append(firstOwner, secondOwner);
    firstOwner.append(firstWrapper);
    secondOwner.append(secondWrapper);
    firstWrapper.append(viewer.container);
    viewerCache.set(cacheKey, viewer);
    registerActiveWrapper(coordinateKey, firstWrapper, viewer.plugin, cacheKey);
    const resolveWrapper = vi.fn((active: ActiveMolstarViewer) => active.wrapper);
    const secondTarget = { cacheKey, registrationId: secondOwner.dataset.structureAgentHost };

    await expect(
      withActivePlugin(coordinateKey, resolveWrapper, secondTarget)
    ).rejects.toMatchObject({
      code: 'VIEWER_NOT_FOUND',
    });
    expect(resolveWrapper).not.toHaveBeenCalled();
    await expect(withActivePlugin(coordinateKey, resolveWrapper, { cacheKey })).resolves.toBe(
      firstWrapper
    );

    secondWrapper.append(viewer.container);
    registerActiveWrapper(coordinateKey, secondWrapper, viewer.plugin, cacheKey);

    await expect(withActivePlugin(coordinateKey, resolveWrapper, secondTarget)).resolves.toBe(
      secondWrapper
    );
    viewer.error = 'Coordinate scene failed to load';
    await expect(
      withActivePlugin(coordinateKey, resolveWrapper, secondTarget)
    ).rejects.toMatchObject({
      code: 'PLUGIN_NOT_READY',
      details: { error: viewer.error },
    });
    await expect(
      withActivePlugin(coordinateKey, resolveWrapper, {
        cacheKey,
        registrationId: firstOwner.dataset.structureAgentHost,
      })
    ).rejects.toMatchObject({ code: 'VIEWER_NOT_FOUND' });
  });

  it('can target an exact active instance cache key when the same source is mounted twice', async () => {
    const tabKey = getViewerCacheKey('pdb:1ABC', 'tab-1');
    const drawerKey = getViewerCacheKey('pdb:1ABC', 'drawer-1');
    const tab = fakeViewer({ lastUsed: 1, connected: false });
    const drawer = fakeViewer({ lastUsed: 2, connected: false });
    const tabWrapper = document.createElement('div');
    const drawerWrapper = document.createElement('div');
    document.body.append(tabWrapper, drawerWrapper);
    tabWrapper.appendChild(tab.container);
    drawerWrapper.appendChild(drawer.container);
    viewerCache.set(tabKey, tab);
    viewerCache.set(drawerKey, drawer);
    registerActiveWrapper('pdb:1ABC', tabWrapper, tab.plugin, tabKey);
    registerActiveWrapper('pdb:1ABC', drawerWrapper, drawer.plugin, drawerKey);

    const result = await withActivePlugin(
      'pdb:1ABC',
      (active) => ({
        plugin: active.plugin,
        wrapper: active.wrapper,
        container: active.container,
        cacheKey: active.cacheKey,
      }),
      { cacheKey: drawerKey }
    );

    expect(result).toEqual({
      plugin: drawer.plugin,
      wrapper: drawerWrapper,
      container: drawer.container,
      cacheKey: drawerKey,
    });
  });
});

describe('getStructureRepresentationDiagnostics', () => {
  it('reports real MolStar representation params from cached plugin state', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    viewerCache.set('structure-key', {
      container,
      plugin: {
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [
                  {
                    cell: { obj: { data: { models: [] } } },
                    components: [
                      {
                        cell: {
                          obj: { label: 'Structure Detail Context' },
                          transform: { ref: 'component-context' },
                        },
                        representations: [
                          {
                            cell: {
                              params: {
                                values: {
                                  type: {
                                    name: 'molecular-surface',
                                    params: { alpha: 0.16, resolution: 2 },
                                  },
                                  colorTheme: {
                                    name: 'uniform',
                                    params: { value: 0x888888 },
                                  },
                                  sizeTheme: { name: 'physical', params: {} },
                                },
                              },
                              transform: {
                                ref: 'repr-context',
                                tags: ['waypoint.structure3d.polymer.context.primary'],
                              },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      } as unknown as CachedViewer['plugin'],
      isLoading: false,
      error: null,
      lastUsed: Date.now(),
    });

    expect(getStructureRepresentationDiagnostics('structure-key')).toEqual([
      expect.objectContaining({
        key: 'structure-key',
        components: [
          {
            label: 'Structure Detail Context',
            ref: 'component-context',
            elementCount: 0,
            chains: [],
            representations: [
              {
                ref: 'repr-context',
                tags: ['waypoint.structure3d.polymer.context.primary'],
                typeName: 'molecular-surface',
                typeParams: { alpha: 0.16, resolution: 2 },
                colorThemeName: 'uniform',
                colorThemeParams: { value: 0x888888 },
                sizeThemeName: 'physical',
                sizeThemeParams: {},
                alpha: 0.16,
              },
            ],
          },
        ],
      }),
    ]);
  });
});
