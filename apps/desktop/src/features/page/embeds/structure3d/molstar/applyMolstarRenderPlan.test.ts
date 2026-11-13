import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MOLSTAR_RENDER_PLAN_NAMESPACE, type MolstarRenderPlan } from './molstarRenderPlan';

const surfaceOverlayMocks = vi.hoisted(() => ({
  applySurfaceOverlayRenderPlan: vi.fn(
    async (
      ..._args: Parameters<typeof import('./surfaceOverlay').applySurfaceOverlayRenderPlan>
    ) => ['rebuilt-surface-ref']
  ),
  selectSurfaceOverlayCells: vi.fn(() => []),
}));
const structureBuilderMocks = vi.hoisted(() => ({
  syncActiveFocusPolymerComponents: vi.fn(async () => undefined),
}));

vi.mock('./surfaceOverlay', () => surfaceOverlayMocks);
vi.mock('./structureBuilder', () => structureBuilderMocks);

import {
  applyMolstarRenderPlanAfterReady,
  applyMolstarRenderPlanBeforeReveal,
  shouldSkipInitialPostReadyRenderPlanApply,
} from './applyMolstarRenderPlan';

describe('applyMolstarRenderPlanAfterReady', () => {
  it('serializes before-reveal and ready updates sharing one native plugin', async () => {
    const plugin = emptyPlugin();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    structureBuilderMocks.syncActiveFocusPolymerComponents.mockImplementationOnce(
      async () => pending
    );
    const beforeReveal = applyMolstarRenderPlanBeforeReveal(plugin, enabledSurfacePlan(), {
      isCurrent: () => true,
      forceRepresentationApply: true,
    });
    await vi.waitFor(() =>
      expect(structureBuilderMocks.syncActiveFocusPolymerComponents).toHaveBeenCalledTimes(1)
    );
    const ready = applyMolstarRenderPlanAfterReady(plugin, syncablePlan(), {
      isCurrent: () => true,
      applyVisuals: false,
      applyDetailComponents: false,
      applySurfaceOverlay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeRelease = surfaceOverlayMocks.applySurfaceOverlayRenderPlan.mock.calls.length;
    release();
    await Promise.all([beforeReveal, ready]);
    expect(callsBeforeRelease).toBe(0);
    expect(
      surfaceOverlayMocks.applySurfaceOverlayRenderPlan.mock.calls.map((call) => call[1].enabled)
    ).toEqual([true, false]);
  });

  it('removes a disabled surface before waiting for slow component reconciliation', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    structureBuilderMocks.syncActiveFocusPolymerComponents.mockImplementationOnce(
      async () => pending
    );
    const apply = applyMolstarRenderPlanAfterReady(emptyPlugin(), syncablePlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['old-surface-ref'],
      applyVisuals: true,
      applyDetailComponents: true,
      applySurfaceOverlay: true,
    });
    await vi.waitFor(() =>
      expect(structureBuilderMocks.syncActiveFocusPolymerComponents).toHaveBeenCalledTimes(1)
    );
    const callsBeforeRelease = surfaceOverlayMocks.applySurfaceOverlayRenderPlan.mock.calls.length;
    release();
    await apply;
    expect(callsBeforeRelease).toBe(1);
    expect(surfaceOverlayMocks.applySurfaceOverlayRenderPlan).toHaveBeenCalledWith(
      expect.anything(),
      syncablePlan().surfaceOverlay,
      expect.objectContaining({ trackedOverlayRefs: ['old-surface-ref'] })
    );
  });

  it('reconciles a recipe changed after before-reveal completion and before first paint', () => {
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: false,
        sceneKind: 'complex',
        isPreviewRender: false,
        hadBeforeRevealReconcile: true,
        renderPlanChangedSinceBeforeReveal: true,
      })
    ).toBe(false);
  });

  beforeEach(() => {
    surfaceOverlayMocks.applySurfaceOverlayRenderPlan.mockClear();
    surfaceOverlayMocks.selectSurfaceOverlayCells.mockClear();
    structureBuilderMocks.syncActiveFocusPolymerComponents.mockClear();
  });

  it('does not run component sync for representation-only updates', async () => {
    await applyMolstarRenderPlanAfterReady(emptyPlugin(), syncablePlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['stable-surface-ref'],
      applyVisuals: true,
      applyDetailComponents: false,
      applySurfaceOverlay: false,
    });

    expect(structureBuilderMocks.syncActiveFocusPolymerComponents).not.toHaveBeenCalled();
  });

  it('runs component sync when detail components changed', async () => {
    await applyMolstarRenderPlanAfterReady(emptyPlugin(), syncablePlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['stable-surface-ref'],
      applyVisuals: true,
      applyDetailComponents: true,
      applySurfaceOverlay: false,
    });

    expect(structureBuilderMocks.syncActiveFocusPolymerComponents).toHaveBeenCalledTimes(1);
  });

  it('keeps detail-only updates out of the surface overlay executor while reconciling broad visibility', async () => {
    const plugin = pluginWithBroadContextRepresentation();
    const refs = await applyMolstarRenderPlanAfterReady(plugin, enabledSurfacePlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['stable-surface-ref'],
      applyVisuals: false,
      applyDetailComponents: true,
      applySurfaceOverlay: false,
    });

    expect(refs).toEqual(['stable-surface-ref']);
    expect(surfaceOverlayMocks.applySurfaceOverlayRenderPlan).not.toHaveBeenCalled();
    expect(plugin.__test.updates).toEqual([
      {
        ref: 'broad-context-repr',
        update: expect.objectContaining({
          type: expect.objectContaining({
            params: expect.objectContaining({ alpha: 0 }),
          }),
        }),
      },
    ]);
  });

  it('uses the realized broad context as a last-resort context fallback', async () => {
    const plugin = pluginWithBroadContextRepresentation();
    await applyMolstarRenderPlanAfterReady(plugin, chainTargetFallbackPlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['stable-surface-ref'],
      applyVisuals: false,
      applyDetailComponents: true,
      applySurfaceOverlay: false,
    });

    expect(plugin.__test.updates).toContainEqual({
      ref: 'broad-context-repr',
      update: expect.objectContaining({
        type: expect.objectContaining({
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: expect.objectContaining({ name: 'chain-id' }),
      }),
    });
  });

  it('preserves existing geometry and themes when hiding a polymer, then applies the next recipe when visible', async () => {
    const plugin = pluginWithBroadContextRepresentation({
      name: 'cartoon',
      params: { alpha: 1, quality: 'auto' },
    });
    const surfacePlan = {
      ...enabledSurfacePlan(),
      rolePlan: {
        polymerOverrides: { context: { representation: 'surface', colorMode: 'context-muted' } },
        visibility: {},
      },
    } as MolstarRenderPlan;
    await applyMolstarRenderPlanAfterReady(plugin, surfacePlan, {
      isCurrent: () => true,
      applyVisuals: true,
      applyDetailComponents: false,
      applySurfaceOverlay: false,
    });
    expect(plugin.__test.updates).toEqual([
      {
        ref: 'broad-context-repr',
        update: {
          colorTheme: { name: 'uniform', params: { value: 0xb8b8b8 } },
          sizeTheme: { name: 'uniform', params: { value: 1.75 } },
          type: {
            name: 'cartoon',
            params: {
              alpha: 0,
              quality: 'auto',
              ignoreHydrogens: true,
              ignoreHydrogensVariant: 'all',
            },
          },
        },
      },
    ]);

    plugin.__test.updates.length = 0;
    await applyMolstarRenderPlanAfterReady(
      plugin,
      {
        ...chainTargetFallbackPlan(),
        rolePlan: surfacePlan.rolePlan,
      },
      {
        isCurrent: () => true,
        applyVisuals: true,
        applyDetailComponents: false,
        applySurfaceOverlay: false,
      }
    );
    expect(plugin.__test.updates).toContainEqual({
      ref: 'broad-context-repr',
      update: expect.objectContaining({
        type: expect.objectContaining({
          name: 'molecular-surface',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: expect.objectContaining({ name: 'chain-id' }),
      }),
    });
  });

  it('uses a scoped detail-context fallback instead of incomplete per-chain context components', async () => {
    const plugin = pluginWithScopedDetailContextFallback();
    await applyMolstarRenderPlanAfterReady(plugin, chainTargetFallbackPlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['stable-surface-ref'],
      applyVisuals: false,
      applyDetailComponents: true,
      applySurfaceOverlay: false,
    });

    const updates = new Map(plugin.__test.updates.map((update) => [update.ref, update.update]));
    expect(updates.get('fallback-context-repr')).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: expect.objectContaining({ name: 'chain-id' }),
      })
    );
    expect(updates.get('context-a-repr')).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({
          params: expect.objectContaining({ alpha: 0 }),
        }),
      })
    );
    expect(updates.get('detail-a-repr')).toEqual(
      expect.objectContaining({
        colorTheme: expect.objectContaining({
          name: 'uniform',
          params: expect.objectContaining({ value: 0x123456 }),
        }),
      })
    );
  });

  it('shows hidden polymer side-chain slots for visible backbones without changing the base recipe', async () => {
    const plugin = pluginWithVisibleDetailSideChainSlot();
    const basePlan = chainTargetFallbackPlan();
    await applyMolstarRenderPlanAfterReady(
      plugin,
      {
        ...basePlan,
        controls: {
          ...basePlan.controls,
          sideChains: { visibleBackbones: true, selection: false },
        },
      },
      {
        isCurrent: () => true,
        trackedOverlayRefs: ['stable-surface-ref'],
        applyVisuals: true,
        applyDetailComponents: false,
        applySurfaceOverlay: false,
      }
    );

    const updates = new Map(plugin.__test.updates.map((update) => [update.ref, update.update]));
    expect(updates.get('detail-a-primary-repr')).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({ name: 'cartoon' }),
      })
    );
    expect(updates.get('detail-a-side-chain-repr')).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({
          name: 'ball-and-stick',
          params: expect.objectContaining({ alpha: 1, sizeFactor: 0.12 }),
        }),
        colorTheme: expect.objectContaining({ name: 'element-symbol' }),
      })
    );
  });

  it('preserves the chosen opacity and color for an atomistic primary representation', async () => {
    const plugin = pluginWithVisibleDetailSideChainSlot();
    const basePlan = chainTargetFallbackPlan();
    await applyMolstarRenderPlanAfterReady(
      plugin,
      {
        ...basePlan,
        rolePlan: {
          ...basePlan.rolePlan,
          polymerOverrides: {
            ...basePlan.rolePlan.polymerOverrides,
            query: {
              representation: 'spacefill',
              colorMode: 'chain',
              typeParams: { alpha: 0.3 },
            },
          },
        },
      },
      {
        isCurrent: () => true,
        trackedOverlayRefs: ['stable-surface-ref'],
        applyVisuals: true,
        applyDetailComponents: false,
        applySurfaceOverlay: false,
      }
    );

    const updates = new Map(plugin.__test.updates.map((update) => [update.ref, update.update]));
    expect(updates.get('detail-a-primary-repr')).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({
          name: 'spacefill',
          params: expect.objectContaining({ alpha: 0.3 }),
        }),
        colorTheme: expect.objectContaining({
          name: 'uniform',
          params: expect.objectContaining({ value: 0x123456 }),
        }),
      })
    );
  });

  it.each(['ball-and-stick', 'spacefill'] as const)(
    'keeps hydrogen suppression after switching raw representations to %s',
    async (representation) => {
      const plugin = pluginWithVisibleDetailSideChainSlot([
        componentWithRepresentation('Ligand', 'ligand-repr'),
        componentWithRepresentation('Ion', 'ion-repr'),
        componentWithRepresentation('Water', 'water-repr'),
      ]);
      const basePlan = chainTargetFallbackPlan();
      await applyMolstarRenderPlanAfterReady(
        plugin,
        {
          ...basePlan,
          defaults: { ...basePlan.defaults, representation },
          rolePlan: {
            ...basePlan.rolePlan,
            polymerOverrides: {
              query: {
                representation,
                colorMode: 'chain',
                typeParams: { ignoreHydrogens: false, ignoreHydrogensVariant: 'non-polar' },
              },
            },
          },
          controls: { ...basePlan.controls, showWater: true },
        },
        {
          isCurrent: () => true,
          applyVisuals: true,
          applyDetailComponents: false,
          applySurfaceOverlay: false,
        }
      );

      expect(plugin.__test.updates.map(({ ref }) => ref)).toEqual([
        'detail-a-primary-repr',
        'detail-a-side-chain-repr',
        'ligand-repr',
        'ion-repr',
        'water-repr',
      ]);
      for (const { update } of plugin.__test.updates) {
        expect(update).toMatchObject({
          type: { params: { ignoreHydrogens: true, ignoreHydrogensVariant: 'all' } },
        });
      }
    }
  );

  it('still applies the surface overlay when the surface key changes', async () => {
    const refs = await applyMolstarRenderPlanAfterReady({}, enabledSurfacePlan(), {
      isCurrent: () => true,
      trackedOverlayRefs: ['old-surface-ref'],
      applyVisuals: false,
      applyDetailComponents: false,
      applySurfaceOverlay: true,
    });

    expect(refs).toEqual(['rebuilt-surface-ref']);
    expect(surfaceOverlayMocks.applySurfaceOverlayRenderPlan).toHaveBeenCalledTimes(1);
    expect(surfaceOverlayMocks.applySurfaceOverlayRenderPlan).toHaveBeenCalledWith(
      {},
      enabledSurfacePlan().surfaceOverlay,
      expect.objectContaining({
        trackedOverlayRefs: ['old-surface-ref'],
        preserveExisting: false,
      })
    );
  });
});

function enabledSurfacePlan(): MolstarRenderPlan {
  return {
    ...syncablePlan(),
    componentSync: {
      skipActiveFocusSync: false,
      detailChainTargets: [
        {
          targetId: 'chain-a',
          selection: { chainIds: ['A'] },
          visible: true,
          color: 0x123456,
        },
      ],
    },
    surfaceOverlay: {
      enabled: true,
      colorMode: 'context-muted',
      targetScope: 'broad',
    },
  };
}

function chainTargetFallbackPlan(): MolstarRenderPlan {
  return {
    ...syncablePlan(),
    componentSync: {
      skipActiveFocusSync: false,
      detailChainTargets: [
        {
          targetId: 'chain-a',
          selection: { chainIds: ['A'] },
          visible: true,
          color: 0x123456,
        },
        {
          targetId: 'chain-b',
          selection: { chainIds: ['B'] },
          visible: false,
          color: 0x00a6d6,
        },
      ],
    },
    rolePlan: {
      polymerOverrides: {
        context: { representation: 'cartoon', colorMode: 'context-muted' },
        query: { representation: 'cartoon', colorMode: 'chain' },
      },
      visibility: {},
    },
  };
}

function syncablePlan(): MolstarRenderPlan {
  return {
    schemaVersion: 1,
    namespace: MOLSTAR_RENDER_PLAN_NAMESPACE,
    sceneId: 'scene:test',
    activeRecipeId: 'query-in-complex-surface',
    renderIntent: 'loaded',
    planHash: 'plan:test',
    sourcePaletteId: 'palette:test',
    components: [],
    representations: [],
    defaults: {
      representation: 'cartoon',
      colorMode: 'chain',
    },
    rolePlan: {
      polymerOverrides: {},
      visibility: {},
    },
    componentSync: {
      skipActiveFocusSync: false,
    },
    surfaceOverlay: {
      enabled: false,
      targetScope: 'broad',
    },
    color: {},
    canvas: {
      backgroundColor: 'transparent',
      showAxes: false,
    },
    controls: {
      spin: false,
      showWater: false,
      sideChains: {
        visibleBackbones: false,
        selection: false,
      },
    },
    cleanup: {
      namespace: MOLSTAR_RENDER_PLAN_NAMESPACE,
      absentTagPolicy: 'delete',
      surfaceGeometryPolicy: 'preserve-when-selector-stable',
    },
  };
}

function emptyPlugin(): unknown {
  return {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [],
          },
        },
      },
    },
  };
}

function pluginWithScopedDetailContextFallback(): {
  __test: {
    updates: Array<{ ref: string; update: unknown }>;
    builder: {
      to: ReturnType<typeof vi.fn>;
      commit: ReturnType<typeof vi.fn>;
    };
  };
  managers: unknown;
  state: unknown;
} {
  const updates: Array<{ ref: string; update: unknown }> = [];
  const builder = {
    to: vi.fn((ref: string) => ({
      update: (update: unknown) => updates.push({ ref, update }),
    })),
    commit: vi.fn(async () => undefined),
  };

  return {
    __test: { updates, builder },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { id: 'structure-cell' },
                components: [
                  componentWithRepresentation('Structure Detail Context', 'fallback-context-repr'),
                  componentWithRepresentation('Detail Context Chain: chain-a', 'context-a-repr'),
                  componentWithRepresentation('Detail Chain: chain-a', 'detail-a-repr'),
                ],
              },
            ],
          },
        },
      },
    },
    state: {
      data: {
        build: vi.fn(() => builder),
      },
    },
  };
}

function pluginWithBroadContextRepresentation(currentType?: {
  name: string;
  params: Record<string, unknown>;
}): unknown {
  const updates: Array<{ ref: string; update: unknown }> = [];
  const builder = {
    to: vi.fn((ref: string) => ({
      update: (update: unknown) => updates.push({ ref, update }),
    })),
    commit: vi.fn(async () => undefined),
  };

  return {
    __test: { updates, builder },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { id: 'structure-cell' },
                components: [
                  componentWithRepresentation(
                    'Structure Context',
                    'broad-context-repr',
                    currentType
                  ),
                ],
              },
            ],
          },
        },
      },
    },
    state: {
      data: {
        build: vi.fn(() => builder),
      },
    },
  };
}

function pluginWithVisibleDetailSideChainSlot(additionalComponents: unknown[] = []): {
  __test: {
    updates: Array<{ ref: string; update: unknown }>;
    builder: {
      to: ReturnType<typeof vi.fn>;
      commit: ReturnType<typeof vi.fn>;
    };
  };
  managers: unknown;
  state: unknown;
} {
  const updates: Array<{ ref: string; update: unknown }> = [];
  const builder = {
    to: vi.fn((ref: string) => ({
      update: (update: unknown) => updates.push({ ref, update }),
    })),
    commit: vi.fn(async () => undefined),
  };

  return {
    __test: { updates, builder },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { id: 'structure-cell' },
                components: [
                  componentWithRepresentations('Detail Chain: chain-a', [
                    'detail-a-primary-repr',
                    'detail-a-side-chain-repr',
                  ]),
                  ...additionalComponents,
                ],
              },
            ],
          },
        },
      },
    },
    state: {
      data: {
        build: vi.fn(() => builder),
      },
    },
  };
}

function componentWithRepresentation(
  label: string,
  representationRef: string,
  currentType?: { name: string; params: Record<string, unknown> }
): unknown {
  return componentWithRepresentations(label, [representationRef], currentType);
}

function componentWithRepresentations(
  label: string,
  representationRefs: string[],
  currentType?: { name: string; params: Record<string, unknown> }
): unknown {
  return {
    cell: { obj: { label } },
    representations: representationRefs.map((representationRef) => ({
      cell: {
        params: currentType
          ? {
              values: {
                type: currentType,
                colorTheme: { name: 'uniform', params: { value: 0xb8b8b8 } },
                sizeTheme: { name: 'uniform', params: { value: 1.75 } },
              },
            }
          : undefined,
        transform: {
          ref: representationRef,
        },
      },
    })),
  };
}
