/**
 * @vitest-environment jsdom
 */

import { userMessage } from '@waypoint/user-messages';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./utils/structureData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/structureData')>();
  return {
    ...actual,
    fetchStructureData: vi.fn(async () => ({ data: 'data_mock\n', format: 'mmcif' })),
    fetchStructureFromUrl: vi.fn(async () => ({ data: 'data_mock\n', format: 'mmcif' })),
  };
});

vi.mock('./molstar/activateViewerStructure', () => ({
  activateViewerStructure: vi.fn(
    async (
      cached: CachedViewer,
      options: {
        structureKey: string;
        onBeforeReveal?: (plugin: NonNullable<CachedViewer['plugin']>) => Promise<void> | void;
      }
    ) => {
      if (!cached.plugin) throw new Error('test pane renderer is not initialized');
      await options.onBeforeReveal?.(cached.plugin);
      cached.loadedStructureKey = options.structureKey;
      cached.isLoading = false;
      cached.error = null;
      return {
        status: 'activated' as const,
        structureKey: options.structureKey,
        generation: 1,
      };
    }
  ),
}));

import { MolstarViewer, formatMolstarViewerDisplayError } from './MolstarViewer';
import * as molViewSpecRuntime from './molstar/molViewSpec';
import { activateViewerStructure } from './molstar/activateViewerStructure';
import * as molViewSpec from './molstar/molViewSpec';
import {
  applyMolstarRenderPlanAfterReady,
  applyMolstarVisualsFromPlan,
  shouldSkipInitialPostReadyRenderPlanApply,
} from './molstar/applyMolstarRenderPlan';
import type { MolstarRenderPlan } from './molstar/molstarRenderPlan';
import type {
  Structure3dRepresentation,
  StructureViewState,
  StructureVisualColorMode,
  ViewRecipe,
} from './types';
import { scheduleMolstarFrameKicks } from './molstar/viewerFrameKicks';
import {
  applySurfaceOverlayRenderPlan,
  selectSurfaceOverlayTargetComponents,
} from './molstar/surfaceOverlay';
import * as surfaceOverlayRuntime from './molstar/surfaceOverlay';
import { chainIdPaletteParams, contextChainPaletteParams, getColorParams } from './molstarConfigs';
import { polymerRepresentationTag } from './molstar/renderPlan';
import { createStructureRenderModel } from './utils/structureRenderModel';
import {
  clearStructureRenderTransactionDiagnostics,
  getStructureRenderTransactionDiagnostics,
} from './utils/structureRenderTransactionDiagnostics';
import {
  createCartoonRecipe,
  createSurfaceRecipe,
  createQueryInComplexPreviewRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
  createStructureViewStateFromRecipe,
} from './utils/viewRecipe';
import { fetchStructureData } from './utils/structureData';
import {
  clearViewerCache,
  getPaneRendererHostCacheKey,
  getStructureKey,
  getViewerCacheKey,
  pendingCreations,
  viewerCache,
  type CachedViewer,
} from './viewerCache';

const mockedFetchStructureData = vi.mocked(fetchStructureData);
const mockedActivateViewerStructure = vi.mocked(activateViewerStructure);

function makeRepresentationComponent(
  label: string,
  refs: string[],
  tagsByRef: Record<string, string[]> = {}
) {
  return {
    cell: { obj: { label } },
    representations: refs.map((ref) => ({
      cell: {
        transform: { ref, tags: tagsByRef[ref] },
        params: { values: {} },
      },
    })),
  };
}

interface RepresentationPluginOptions {
  beforeCommit?: () => Promise<void> | void;
  applyUpdatesToPluginState?: boolean;
}

function makeRepresentationPlugin(
  components: ReturnType<typeof makeRepresentationComponent>[],
  options: RepresentationPluginOptions = {}
) {
  const updates: Array<{ ref: string; payload: unknown }> = [];
  const commits: unknown[] = [];
  const plugin = {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ cell: {}, components }],
          },
        },
        component: {
          updateRepresentationsTheme: vi.fn(),
        },
      },
    },
    state: {
      data: {
        build: vi.fn(() => {
          const builder = {
            to: vi.fn((ref: string) => ({
              update: vi.fn((payload: unknown) => {
                updates.push({ ref, payload });
                if (options.applyUpdatesToPluginState) {
                  for (const component of components) {
                    const representation = component.representations.find(
                      ({ cell }) => cell.transform.ref === ref
                    );
                    if (representation) representation.cell.params.values = payload;
                  }
                }
                return builder;
              }),
            })),
            commit: vi.fn(async () => {
              await options.beforeCommit?.();
              commits.push(true);
            }),
          };
          return builder;
        }),
      },
    },
  };

  return { plugin, updates, commits };
}

function makeSurfaceOverlayComponent(label: string, componentRef: string) {
  return {
    cell: {
      obj: { label, data: `${componentRef}-component-data` },
      transform: { ref: componentRef },
      parent: { obj: { data: `${componentRef}-structure-data` } },
    },
    representations: [],
  };
}

function makeSurfaceOverlayPlugin(
  components: ReturnType<typeof makeSurfaceOverlayComponent>[],
  existingOverlayRefs: string[] = [],
  options: {
    onCommit?: (
      overlays: Map<
        string,
        {
          transform: { ref: string };
          obj?: { data?: { repr?: { setState: ReturnType<typeof vi.fn> } } };
        }
      >
    ) => void;
    beforeCommit?: (mutation: {
      addRefs: readonly string[];
      deleteRefs: readonly string[];
    }) => Promise<void> | void;
  } = {}
) {
  const overlays = new Map<
    string,
    {
      transform: { ref: string };
      obj?: { data?: { repr?: { setState: ReturnType<typeof vi.fn> } } };
    }
  >();
  const applications: Array<{
    componentRef: string;
    params: unknown;
    options: unknown;
  }> = [];
  const deletions: string[] = [];
  const markerStates: Array<{ ref: string; state: unknown }> = [];
  const representationParams = new Map<string, Record<string, unknown>>();

  for (const ref of existingOverlayRefs) {
    overlays.set(ref, { transform: { ref } });
  }

  const plugin = {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ cell: { obj: { data: 'structure-data' } }, components }],
          },
        },
      },
    },
    state: {
      data: {
        cells: {
          get: vi.fn((ref: string) => overlays.get(ref)),
          has: vi.fn((ref: string) => overlays.has(ref)),
        },
        selectQ: vi.fn(() => Array.from(overlays.values())),
        build: vi.fn(() => {
          const pendingAdds: Array<{
            transform: { ref: string };
            obj?: { data?: { repr?: { setState: ReturnType<typeof vi.fn> } } };
          }> = [];
          const pendingDeletes: string[] = [];
          const pendingUpdates: Array<() => void> = [];
          const builder = {
            to: vi.fn((componentRef: string) => ({
              update: vi.fn(
                (update: (params: Record<string, unknown>) => Record<string, unknown>) => {
                  pendingUpdates.push(() => {
                    representationParams.set(
                      componentRef,
                      update(representationParams.get(componentRef) ?? {})
                    );
                  });
                }
              ),
              apply: vi.fn((_transform: unknown, params: unknown, options: unknown) => {
                const ref = `${componentRef}-surface-overlay-${applications.length}`;
                const input = params as { type: string; typeParams: Record<string, unknown> };
                representationParams.set(ref, {
                  type: { name: input.type, params: input.typeParams },
                });
                const setState = vi.fn((state: unknown) => markerStates.push({ ref, state }));
                pendingAdds.push({ transform: { ref }, obj: { data: { repr: { setState } } } });
                applications.push({ componentRef, params, options });
                return { ref };
              }),
            })),
            delete: vi.fn((ref: string) => {
              pendingDeletes.push(ref);
              deletions.push(ref);
              return builder;
            }),
            commit: vi.fn(async () => {
              await options.beforeCommit?.({
                addRefs: pendingAdds.map((cell) => cell.transform.ref),
                deleteRefs: pendingDeletes,
              });
              for (const ref of pendingDeletes) overlays.delete(ref);
              for (const cell of pendingAdds) overlays.set(cell.transform.ref, cell);
              for (const update of pendingUpdates) update();
              options.onCommit?.(overlays);
            }),
          };
          return builder;
        }),
      },
    },
  };

  return { plugin, overlays, applications, deletions, markerStates, representationParams };
}

function fakePlugin(): CachedViewer['plugin'] {
  return {
    dispose: vi.fn(),
    canvas3d: {
      animate: vi.fn(),
      handleResize: vi.fn(),
      setProps: vi.fn(),
    },
  } as unknown as CachedViewer['plugin'];
}

function seedCachedViewer(cacheKey: string, markerTestId: string): CachedViewer {
  const container = document.createElement('div');
  container.dataset.testid = `cached-container-${markerTestId}`;
  const marker = document.createElement('div');
  marker.dataset.testid = markerTestId;
  marker.textContent = markerTestId;
  container.appendChild(marker);
  const cached: CachedViewer = {
    container,
    plugin: fakePlugin(),
    isLoading: false,
    error: null,
    lastUsed: 1,
  };
  viewerCache.set(cacheKey, cached);
  return cached;
}

function attachCameraStateChangedMock(cached: CachedViewer) {
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn((callback: () => void) => {
    listeners.delete(callback);
  });
  const subscribe = vi.fn((callback: () => void) => {
    listeners.add(callback);
    return {
      unsubscribe: () => unsubscribe(callback),
    };
  });
  const getSnapshot = vi.fn(() => ({
    position: [1, 2, 3],
    target: [0, 0, 0],
    up: [0, 1, 0],
    radius: 12,
    fog: 50,
    fov: 45,
    extraMolstarField: 'not persisted',
  }));
  const drawListeners = new Set<() => void>();
  const drawUnsubscribe = vi.fn((callback: () => void) => drawListeners.delete(callback));
  const drawSubscribe = vi.fn((callback: () => void) => {
    drawListeners.add(callback);
    return { unsubscribe: () => drawUnsubscribe(callback) };
  });
  const canvas3d = {
    ...((cached.plugin as { canvas3d?: object }).canvas3d ?? {}),
    camera: {
      getSnapshot,
      setState: vi.fn(),
      stateChanged: { subscribe },
    },
    didDraw: { subscribe: drawSubscribe },
  };
  cached.plugin = {
    ...(cached.plugin as object),
    canvas3d,
  } as CachedViewer['plugin'];
  return {
    getSnapshot,
    subscribe,
    drawSubscribe,
    drawUnsubscribe,
    emitDraw() {
      for (const listener of [...drawListeners]) listener();
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

function seedRepresentationCachedViewer(
  cacheKey: string,
  markerTestId: string,
  components: ReturnType<typeof makeRepresentationComponent>[],
  options: RepresentationPluginOptions = {}
) {
  const container = document.createElement('div');
  container.dataset.testid = `cached-container-${markerTestId}`;
  const marker = document.createElement('div');
  marker.dataset.testid = markerTestId;
  marker.textContent = markerTestId;
  container.appendChild(marker);

  const { plugin, updates, commits } = makeRepresentationPlugin(components, options);
  const cached: CachedViewer = {
    container,
    plugin: {
      ...plugin,
      canvas3d: {
        animate: vi.fn(),
        handleResize: vi.fn(),
        setProps: vi.fn(),
      },
    } as unknown as CachedViewer['plugin'],
    isLoading: false,
    error: null,
    lastUsed: 1,
  };
  viewerCache.set(cacheKey, cached);
  return { cached, updates, commits };
}

function recipeView(
  recipe: ViewRecipe,
  options: { showWater?: boolean; spin?: boolean } = {}
): StructureViewState {
  return createStructureViewStateFromRecipe(recipe, options);
}

function singleLayerView(
  representation: Structure3dRepresentation,
  colorMode: StructureVisualColorMode,
  options: { spin?: boolean } = {}
): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: null,
    recipe: {
      schemaVersion: 1,
      id: `${representation}-${colorMode}-test`,
      name: 'Test View',
      origin: 'generated',
      layers: [
        {
          id: 'test-primary-layer',
          target: { kind: 'whole-structure' },
          representation: { kind: representation },
          color: { mode: colorMode },
          visible: true,
          order: 10,
        },
      ],
    },
    showWater: false,
    spin: options.spin ?? false,
  };
}

type TestRenderPlanOptions = {
  isCurrent?: () => boolean;
  polymerRoleOverrides?: MolstarRenderPlan['rolePlan']['polymerOverrides'];
  roleVisibility?: MolstarRenderPlan['rolePlan']['visibility'];
  scene?: MolstarRenderPlan['componentSync']['scene'];
  skipActiveFocusSync?: boolean;
  detailMemberIds?: readonly string[];
  detailChainTargets?: MolstarRenderPlan['componentSync']['detailChainTargets'];
  chainColorPalette?: readonly number[];
  componentScope?: 'all' | 'detail';
};

function makeTestRenderPlan(input: {
  representation: MolstarRenderPlan['defaults']['representation'];
  colorMode?: MolstarRenderPlan['defaults']['colorMode'];
  showWater?: boolean;
  uniprotId?: string;
  options?: TestRenderPlanOptions;
}): MolstarRenderPlan {
  const options = input.options ?? {};
  return {
    schemaVersion: 1,
    namespace: 'waypoint.structure3d',
    sceneId: null,
    activeRecipeId: null,
    renderIntent: 'main',
    planHash: 'test-plan',
    sourcePaletteId: options.chainColorPalette?.length
      ? `molstar:${options.chainColorPalette.map((color) => color.toString(16)).join(',')}`
      : 'molstar:test',
    components: [],
    representations: [],
    ...(options.detailChainTargets ? { detailChainTargets: [...options.detailChainTargets] } : {}),
    defaults: {
      representation: input.representation,
      colorMode: input.colorMode ?? 'chain',
      ...(input.uniprotId ? { uniprotId: input.uniprotId } : {}),
    },
    rolePlan: {
      polymerOverrides: options.polymerRoleOverrides ?? {},
      visibility: options.roleVisibility ?? {},
    },
    componentSync: {
      ...(options.scene ? { scene: options.scene } : {}),
      skipActiveFocusSync: options.skipActiveFocusSync ?? false,
      ...(options.detailMemberIds ? { detailMemberIds: options.detailMemberIds } : {}),
      ...(options.detailChainTargets ? { detailChainTargets: options.detailChainTargets } : {}),
    },
    surfaceOverlay: {
      enabled: false,
      targetScope: 'broad',
    },
    color: {
      ...(options.chainColorPalette ? { chainColorPalette: options.chainColorPalette } : {}),
    },
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
    },
    controls: {
      showWater: input.showWater ?? false,
      spin: false,
    },
    cleanup: {
      namespace: 'waypoint.structure3d',
      absentTagPolicy: 'delete',
      surfaceGeometryPolicy: 'preserve-when-selector-stable',
    },
  };
}

async function applyTestVisuals(
  plugin: unknown,
  representation: MolstarRenderPlan['defaults']['representation'],
  colorMode: MolstarRenderPlan['defaults']['colorMode'] = 'chain',
  showWater: boolean = false,
  uniprotId?: string,
  options: TestRenderPlanOptions = {}
): Promise<void> {
  const plan = makeTestRenderPlan({
    representation,
    colorMode,
    showWater,
    uniprotId,
    options,
  });
  await applyMolstarVisualsFromPlan(plugin, plan, {
    isCurrent: options.isCurrent,
    componentScope: options.componentScope,
  });
}

type TestSurfaceOverlayOptions = Parameters<typeof applySurfaceOverlayRenderPlan>[2] & {
  typeParams?: Record<string, unknown>;
  colorMode?: MolstarRenderPlan['surfaceOverlay']['colorMode'];
  targetScope?: MolstarRenderPlan['surfaceOverlay']['targetScope'];
};

function applyTestSurfaceOverlay(
  plugin: unknown,
  enabled: boolean,
  options: TestSurfaceOverlayOptions = {}
): Promise<string[]> {
  const { typeParams, colorMode, targetScope, ...applyOptions } = options;
  return applySurfaceOverlayRenderPlan(
    plugin,
    {
      enabled,
      targetScope: targetScope ?? 'detail-aware',
      ...(typeParams ? { typeParams } : {}),
      ...(colorMode ? { colorMode } : {}),
    },
    applyOptions
  );
}

describe('applyMolstarVisualsFromPlan', () => {
  it('does not expose raw MolStar diagnostic JSON as user-visible error text', () => {
    const rawDiagnostic =
      '"targetId":"a-t-8-asm_1-t","reason":"molstar-returned-null","variant":"entity-polymer","expression":"{\\"head\\":{\\"name\\":\\"structure-query.generator.atom-groups\\"}}"';

    expect(formatMolstarViewerDisplayError(rawDiagnostic)).toBe(userMessage('structure.failed'));
    expect(formatMolstarViewerDisplayError('Structure load timeout after 30000ms')).toBe(
      userMessage('structure.failed')
    );
  });

  it('schedules repeated MolStar frame kicks so post-reveal layout settling cannot leave a blank canvas', () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const canvas3d = {
      handleResize: vi.fn(),
      requestDraw: vi.fn(),
      commit: vi.fn(),
      animate: vi.fn(),
    };

    const cancel = scheduleMolstarFrameKicks(
      { canvas3d },
      {
        requestAnimationFrame: (callback) => {
          callback(0);
          return 0;
        },
        setTimeout: (callback, _delay) => {
          const id = nextTimer++;
          timers.set(id, callback);
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (id) => {
          timers.delete(id as unknown as number);
        },
      }
    );

    expect(canvas3d.handleResize).toHaveBeenCalledTimes(2);
    expect(canvas3d.requestDraw).toHaveBeenCalledTimes(2);
    for (const callback of [...timers.values()]) callback();
    expect(canvas3d.handleResize.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(canvas3d.commit).toHaveBeenCalledWith(true);

    cancel();
    const callsAfterCancel = canvas3d.requestDraw.mock.calls.length;
    for (const callback of [...timers.values()]) callback();
    expect(canvas3d.requestDraw).toHaveBeenCalledTimes(callsAfterCancel);
  });

  it('skips the first post-ready reconcile when the style was already reconciled before reveal', () => {
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: false,
        sceneKind: 'complex',
        isPreviewRender: false,
        hadBeforeRevealReconcile: true,
      })
    ).toBe(true);
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: true,
        sceneKind: 'complex',
        isPreviewRender: false,
        hadBeforeRevealReconcile: true,
      })
    ).toBe(true);
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: false,
        sceneKind: 'complex',
        isPreviewRender: false,
      })
    ).toBe(false);
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: false,
        sceneKind: 'complex',
        isPreviewRender: true,
      })
    ).toBe(true);
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: false,
        sceneKind: 'single_query',
        isPreviewRender: false,
      })
    ).toBe(true);
    expect(
      shouldSkipInitialPostReadyRenderPlanApply({
        wasRestoredFromCache: true,
        sceneKind: 'complex',
        isPreviewRender: false,
      })
    ).toBe(false);
  });

  it('applies surface recipes to the scoped RCSB query polymer while restoring context to the scoped-load baseline', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    await applyTestVisuals(plugin, 'surface', 'chain', false);

    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ name: 'molecular-surface' }),
        colorTheme: expect.objectContaining({ name: 'chain-id' }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-ball-stick',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'ball-and-stick',
          params: expect.objectContaining({ alpha: 0 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ name: 'molecular-surface' }),
        colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
      }),
    });
  });

  it('restores scoped cartoon representation to the same query and context styling used on first load', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false);

    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.objectContaining({ sizeFactor: 0.2 }),
        }),
        colorTheme: { name: 'chain-id', params: chainIdPaletteParams() },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-ball-stick',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'ball-and-stick',
          params: expect.objectContaining({ alpha: 0 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.objectContaining({ sizeFactor: 0.2 }),
        }),
        colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
      }),
    });
  });

  it('applies illustrative recipes coherently to scoped context and query polymers', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    await applyTestVisuals(plugin, 'illustrative', 'chain', false);

    expect(updates).toContainEqual({
      ref: 'context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'spacefill',
          params: expect.objectContaining({ ignoreLight: true }),
        }),
        colorTheme: {
          name: 'illustrative',
          params: { style: { name: 'chain-id', params: contextChainPaletteParams() } },
        },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'spacefill',
          params: expect.objectContaining({ ignoreLight: true }),
        }),
        colorTheme: {
          name: 'illustrative',
          params: { style: { name: 'chain-id', params: chainIdPaletteParams() } },
        },
      }),
    });
  });

  it('applies recipe role overrides for query cartoon in translucent context surface', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      polymerRoleOverrides: {
        query: { representation: 'cartoon', colorMode: 'chain' },
        context: {
          representation: 'surface',
          colorMode: 'chain',
          typeParams: { alpha: 0.2 },
        },
      },
    });

    expect(updates).toContainEqual({
      ref: 'context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'molecular-surface',
          params: expect.objectContaining({ alpha: 0.2 }),
        }),
        colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.objectContaining({ sizeFactor: 0.2 }),
        }),
        colorTheme: { name: 'chain-id', params: chainIdPaletteParams() },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-ball-stick',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'ball-and-stick',
          params: expect.objectContaining({ alpha: 0 }),
        }),
      }),
    });
  });

  it('hides renderer roles from layer visibility overrides', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
      makeRepresentationComponent('Ligand', ['ligand-sticks']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      roleVisibility: {
        context: false,
        ligand: false,
      },
    });

    expect(updates).toContainEqual({
      ref: 'context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          params: expect.objectContaining({ alpha: 0 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'ligand-sticks',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          params: expect.objectContaining({ alpha: 0 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          params: expect.objectContaining({ sizeFactor: 0.2 }),
        }),
      }),
    });
  });

  it('switches checked detail members by updating stable components instead of showing broad scoped components', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Polymer', ['broad-polymer-cartoon']),
      makeRepresentationComponent('Structure Context', ['broad-context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['broad-query-cartoon', 'broad-query-stick']),
      makeRepresentationComponent('Active Focus', ['broad-focus-cartoon']),
      makeRepresentationComponent('Structure Detail Context', ['detail-context-cartoon']),
      makeRepresentationComponent('Detail Member: member:atpG', ['detail-atpg-cartoon']),
      makeRepresentationComponent('Detail Member: member:atpC', ['detail-atpc-cartoon']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      detailMemberIds: ['member:atpC'],
      chainColorPalette: [0x123456, 0xabcdef],
    });

    expect(updates).toContainEqual({
      ref: 'broad-polymer-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'broad-context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'broad-query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'broad-focus-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-atpg-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-atpc-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'chain-id', params: chainIdPaletteParams([0x123456, 0xabcdef]) },
      }),
    });
  });

  it('hides stale broad detail context while toggling stable per-chain detail/context components', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['broad-context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['broad-query-cartoon']),
      makeRepresentationComponent('Structure Detail Context', ['detail-context-cartoon']),
      makeRepresentationComponent('Detail Chain: g-g-3-asm_1-g', ['detail-g-cartoon']),
      makeRepresentationComponent('Detail Context Chain: g-g-3-asm_1-g', ['context-g-cartoon']),
      makeRepresentationComponent('Detail Chain: a-a-1-asm_1-a', ['detail-a-cartoon']),
      makeRepresentationComponent('Detail Context Chain: a-a-1-asm_1-a', ['context-a-cartoon']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      detailMemberIds: ['member:query'],
      chainColorPalette: [0xff00a8, 0xe6194b],
      detailChainTargets: [
        {
          targetId: 'g-g-3-asm_1-g',
          memberId: 'member:query',
          selection: { pdbId: '8DBR', authAsymIds: ['G'], chainIds: ['G'] },
          visible: true,
          color: 0xff00a8,
        },
        {
          targetId: 'a-a-1-asm_1-a',
          memberId: 'member:partner',
          selection: { pdbId: '8DBR', authAsymIds: ['A'], chainIds: ['A'] },
          visible: false,
          color: 0xe6194b,
        },
      ],
    });

    expect(updates).toContainEqual({
      ref: 'broad-context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'broad-query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-g-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'uniform', params: { value: 0xff00a8, saturation: 0, lightness: 0 } },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'context-g-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-a-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'context-a-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
      }),
    });
  });

  it('uses detail-chain row colors for checked cartoons in Chain color mode', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Detail Chain: g-g-3-asm_1-g', ['detail-g-cartoon']),
      makeRepresentationComponent('Detail Chain: a-a-1-asm_1-a', ['detail-a-cartoon']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      roleVisibility: {
        query: true,
        context: true,
        unscoped: false,
      },
      detailChainTargets: [
        {
          targetId: 'g-g-3-asm_1-g',
          memberId: 'member:query',
          selection: { pdbId: '8DBR', authAsymIds: ['G'], chainIds: ['G'] },
          visible: true,
          color: 0xff00a8,
        },
        {
          targetId: 'a-a-1-asm_1-a',
          memberId: 'member:partner',
          selection: { pdbId: '8DBR', authAsymIds: ['A'], chainIds: ['A'] },
          visible: true,
          color: 0xe6194b,
        },
      ],
    });

    expect(updates).toContainEqual({
      ref: 'detail-g-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'uniform', params: { value: 0xff00a8, saturation: 0, lightness: 0 } },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-a-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'uniform', params: { value: 0xe6194b, saturation: 0, lightness: 0 } },
      }),
    });
  });

  it('applies non-chain color themes to checked detail-chain cartoons', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Detail Chain: g-g-3-asm_1-g', ['detail-g-cartoon']),
      makeRepresentationComponent('Detail Chain: a-a-1-asm_1-a', ['detail-a-cartoon']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'bfactor', false, undefined, {
      roleVisibility: {
        query: true,
        context: true,
        unscoped: false,
      },
      detailChainTargets: [
        {
          targetId: 'g-g-3-asm_1-g',
          memberId: 'member:query',
          selection: { pdbId: '8DBR', authAsymIds: ['G'], chainIds: ['G'] },
          visible: true,
          color: 0xff00a8,
        },
        {
          targetId: 'a-a-1-asm_1-a',
          memberId: 'member:partner',
          selection: { pdbId: '8DBR', authAsymIds: ['A'], chainIds: ['A'] },
          visible: true,
          color: 0xe6194b,
        },
      ],
    });

    expect(updates).toContainEqual({
      ref: 'detail-g-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'uncertainty', params: getColorParams('bfactor') },
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-a-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'uncertainty', params: getColorParams('bfactor') },
      }),
    });
  });

  it('keeps Surface Context cartoons limited to selected detail chains', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Detail Chain: chain-a', ['detail-a-cartoon']),
      makeRepresentationComponent('Detail Chain: chain-b', ['detail-b-cartoon']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      roleVisibility: {
        query: true,
        context: false,
        unscoped: false,
      },
      polymerRoleOverrides: {
        query: { representation: 'cartoon', colorMode: 'chain' },
      },
      detailChainTargets: [
        {
          targetId: 'chain-a',
          selection: { pdbId: '8DBR', authAsymIds: ['A'], chainIds: ['A'] },
          visible: true,
          color: 0xff00a8,
        },
        {
          targetId: 'chain-b',
          selection: { pdbId: '8DBR', authAsymIds: ['B'], chainIds: ['B'] },
          visible: false,
          color: 0x999999,
        },
      ],
    });

    expect(updates).toContainEqual({
      ref: 'detail-b-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'detail-a-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.not.objectContaining({ alpha: 0 }),
        }),
        colorTheme: { name: 'uniform', params: { value: 0xff00a8, saturation: 0, lightness: 0 } },
      }),
    });
  });

  it('batches chain-detail representation updates into one MolStar state commit per structure', async () => {
    const { plugin, commits } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['broad-context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['broad-query-cartoon']),
      makeRepresentationComponent('Detail Chain: g-g-3-asm_1-g', ['detail-g-cartoon']),
      makeRepresentationComponent('Detail Chain: a-a-1-asm_1-a', ['detail-a-cartoon']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      detailMemberIds: ['member:query'],
      chainColorPalette: [0xff00a8, 0xe6194b],
      detailChainTargets: [
        {
          targetId: 'g-g-3-asm_1-g',
          memberId: 'member:query',
          selection: { pdbId: '8DBR', authAsymIds: ['G'], chainIds: ['G'] },
          visible: true,
          color: 0xff00a8,
        },
        {
          targetId: 'a-a-1-asm_1-a',
          memberId: 'member:partner',
          selection: { pdbId: '8DBR', authAsymIds: ['A'], chainIds: ['A'] },
          visible: false,
          color: 0xe6194b,
        },
      ],
    });

    expect(commits).toHaveLength(1);
  });

  it('applies ball-and-stick recipes to the scoped RCSB query polymer', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    await applyTestVisuals(plugin, 'ball-and-stick', 'chain', false);

    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.objectContaining({ sizeFactor: 0.15 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-ball-stick',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'ball-and-stick',
          params: expect.objectContaining({ alpha: 1 }),
        }),
        colorTheme: { name: 'chain-id', params: chainIdPaletteParams() },
      }),
    });
  });

  it('uses DNAForge representation tags instead of array order for polymer slots', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent(
        'Query Polymer',
        ['query-detail-out-of-order', 'query-primary-out-of-order'],
        {
          'query-detail-out-of-order': [polymerRepresentationTag('query', 'detail')],
          'query-primary-out-of-order': [polymerRepresentationTag('query', 'primary')],
        }
      ),
    ]);

    await applyTestVisuals(plugin, 'ball-and-stick', 'chain', false);

    expect(updates).toContainEqual({
      ref: 'query-primary-out-of-order',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.objectContaining({ sizeFactor: 0.15 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-detail-out-of-order',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'ball-and-stick',
          params: expect.objectContaining({ alpha: 1 }),
        }),
        colorTheme: { name: 'chain-id', params: chainIdPaletteParams() },
      }),
    });
  });

  it('does not commit stale representation updates after a newer generation wins', async () => {
    const { plugin, commits } = makeRepresentationPlugin([
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);
    let checks = 0;

    await applyTestVisuals(plugin, 'surface', 'chain', false, undefined, {
      isCurrent: () => {
        checks += 1;
        return checks < 3;
      },
    });

    expect(commits).toEqual([]);
  });

  it('propagates representation failures so callers cannot cache a failed render plan', async () => {
    const { plugin } = makeRepresentationPlugin(
      [makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick'])],
      {
        beforeCommit: () => {
          throw new Error('representation commit failed');
        },
      }
    );

    await expect(applyTestVisuals(plugin, 'surface')).rejects.toThrow(
      'representation commit failed'
    );
  });
});

describe('surface overlay render-plan application', () => {
  it('targets scoped query, focus, and context polymers for hybrid overlays', () => {
    const context = makeSurfaceOverlayComponent('Structure Context', 'context-component');
    const focus = makeSurfaceOverlayComponent('Active Focus', 'focus-component');
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const ligand = makeSurfaceOverlayComponent('Ligand', 'ligand-component');

    expect(
      selectSurfaceOverlayTargetComponents([context, focus, query, ligand]).map(
        (component) => component.cell?.transform?.ref
      )
    ).toEqual(['context-component', 'focus-component', 'query-component']);
  });

  it('adds hybrid surface overlays to every scoped polymer layer with recipe params and palettes', async () => {
    const context = makeSurfaceOverlayComponent('Structure Context', 'context-component');
    const focus = makeSurfaceOverlayComponent('Active Focus', 'focus-component');
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const ligand = makeSurfaceOverlayComponent('Ligand', 'ligand-component');
    const { plugin, applications, markerStates } = makeSurfaceOverlayPlugin([
      context,
      focus,
      query,
      ligand,
    ]);

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      typeParams: { alpha: 0.2, quality: 'auto' },
      chainColorPalette: [0x123456, 0xabcdef],
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(refs).toEqual([
      'context-component-surface-overlay-0',
      'focus-component-surface-overlay-1',
      'query-component-surface-overlay-2',
    ]);
    expect(applications.map((application) => application.componentRef)).toEqual([
      'context-component',
      'focus-component',
      'query-component',
    ]);
    expect(applications[0]?.params).toEqual(
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.2,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'chain-id',
        colorParams: contextChainPaletteParams(),
      })
    );
    expect(applications[1]?.params).toEqual(
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.2,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'chain-id',
        colorParams: chainIdPaletteParams([0x123456, 0xabcdef]),
      })
    );
    expect(applications[2]?.params).toEqual(
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.2,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'chain-id',
        colorParams: chainIdPaletteParams([0x123456, 0xabcdef]),
      })
    );
    expect(markerStates).toEqual([
      { ref: 'context-component-surface-overlay-0', state: { markerActions: 0 } },
      { ref: 'focus-component-surface-overlay-1', state: { markerActions: 0 } },
      { ref: 'query-component-surface-overlay-2', state: { markerActions: 0 } },
    ]);
  });

  it('uses muted context color for every Surface Context overlay component', async () => {
    const context = makeSurfaceOverlayComponent('Structure Context', 'context-component');
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const { plugin, applications } = makeSurfaceOverlayPlugin([context, query]);

    await applyTestSurfaceOverlay(plugin, true, {
      typeParams: { alpha: 0.13, quality: 'auto' },
      colorMode: 'context-muted',
      chainColorPalette: [0x123456, 0xabcdef],
      targetScope: 'broad',
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(applications.map((application) => application.params)).toEqual([
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.13,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'chain-id',
        colorParams: contextChainPaletteParams(),
      }),
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.13,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'chain-id',
        colorParams: contextChainPaletteParams(),
      }),
    ]);
  });

  it('keeps context overlays gray while metric-coloring non-context Surface Context overlays', async () => {
    const context = makeSurfaceOverlayComponent('Structure Context', 'context-component');
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const { plugin, applications } = makeSurfaceOverlayPlugin([context, query]);

    await applyTestSurfaceOverlay(plugin, true, {
      typeParams: { alpha: 0.13, quality: 'auto' },
      colorMode: 'plddt',
      chainColorPalette: [0x123456, 0xabcdef],
      targetScope: 'broad',
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(applications.map((application) => application.params)).toEqual([
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.13,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'chain-id',
        colorParams: contextChainPaletteParams(),
      }),
      expect.objectContaining({
        type: 'molecular-surface',
        typeParams: {
          alpha: 0.13,
          quality: 'auto',
          ignoreHydrogens: true,
          ignoreHydrogensVariant: 'all',
        },
        color: 'uncertainty',
        colorParams: getColorParams('plddt'),
      }),
    ]);
  });

  it('does not add colored hybrid overlays for unchecked detail member components', async () => {
    const broadPolymer = makeSurfaceOverlayComponent('Polymer', 'broad-polymer');
    const broadContext = makeSurfaceOverlayComponent('Structure Context', 'broad-context');
    const broadQuery = makeSurfaceOverlayComponent('Query Polymer', 'broad-query');
    const broadFocus = makeSurfaceOverlayComponent('Active Focus', 'broad-focus');
    const context = makeSurfaceOverlayComponent('Structure Detail Context', 'detail-context');
    const checked = makeSurfaceOverlayComponent('Detail Member: member:atpG', 'detail-atpg');
    const unchecked = makeSurfaceOverlayComponent('Detail Member: member:atpC', 'detail-atpc');
    const { plugin, applications } = makeSurfaceOverlayPlugin([
      broadPolymer,
      broadContext,
      broadQuery,
      broadFocus,
      context,
      checked,
      unchecked,
    ]);

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      detailMemberIds: ['member:atpG'],
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(refs).toEqual(['detail-context-surface-overlay-0', 'detail-atpg-surface-overlay-1']);
    expect(applications.map((application) => application.componentRef)).toEqual([
      'detail-context',
      'detail-atpg',
    ]);
    expect(applications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ componentRef: 'detail-atpc' })])
    );
    expect(applications.map((application) => application.componentRef)).not.toEqual(
      expect.arrayContaining(['broad-polymer', 'broad-context', 'broad-query', 'broad-focus'])
    );
    expect(applications[0]?.params).toEqual(
      expect.objectContaining({
        colorParams: contextChainPaletteParams(),
      })
    );
  });

  it('can keep recipe surface overlays on stable broad components across chain toggles', async () => {
    const broadContext = makeSurfaceOverlayComponent('Structure Context', 'broad-context');
    const broadQuery = makeSurfaceOverlayComponent('Query Polymer', 'broad-query');
    const staleDetailContext = makeSurfaceOverlayComponent(
      'Structure Detail Context',
      'stale-detail-context'
    );
    const detailQuery = makeSurfaceOverlayComponent('Detail Chain: chain-a', 'detail-chain-a');
    const { plugin, applications } = makeSurfaceOverlayPlugin([
      broadContext,
      broadQuery,
      staleDetailContext,
      detailQuery,
    ]);

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      targetScope: 'broad',
      detailChainTargets: [
        { targetId: 'chain-a', selection: { chainIds: ['A'] }, visible: true },
        { targetId: 'chain-b', selection: { chainIds: ['B'] }, visible: false },
      ],
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(refs).toEqual(['broad-context-surface-overlay-0', 'broad-query-surface-overlay-1']);
    expect(applications.map((application) => application.componentRef)).toEqual([
      'broad-context',
      'broad-query',
    ]);
    expect(applications.map((application) => application.componentRef)).not.toContain(
      'stale-detail-context'
    );
  });

  it('uses stable per-chain detail components for broad surface overlays when no broad component exists', async () => {
    const detailQueryA = makeSurfaceOverlayComponent('Detail Chain: chain-a', 'detail-chain-a');
    const detailQueryB = makeSurfaceOverlayComponent('Detail Chain: chain-b', 'detail-chain-b');
    const { plugin, applications } = makeSurfaceOverlayPlugin([detailQueryA, detailQueryB]);

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      targetScope: 'broad',
      colorMode: 'context-muted',
      detailChainTargets: [
        { targetId: 'chain-a', selection: { chainIds: ['A'] }, visible: true },
        { targetId: 'chain-b', selection: { chainIds: ['B'] }, visible: false },
      ],
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(refs).toEqual(['detail-chain-a-surface-overlay-0', 'detail-chain-b-surface-overlay-1']);
    expect(applications.map((application) => application.componentRef)).toEqual([
      'detail-chain-a',
      'detail-chain-b',
    ]);
    expect(applications.map((application) => application.params)).toEqual([
      expect.objectContaining({ colorParams: contextChainPaletteParams() }),
      expect.objectContaining({ colorParams: contextChainPaletteParams() }),
    ]);
  });

  it('does not stack duplicate broad surface overlays when the same Surface Context style is applied twice', async () => {
    const broadContext = makeSurfaceOverlayComponent('Structure Context', 'broad-context');
    const broadQuery = makeSurfaceOverlayComponent('Query Polymer', 'broad-query');
    const { plugin, overlays, applications, deletions } = makeSurfaceOverlayPlugin([
      broadContext,
      broadQuery,
    ]);
    const loadRepresentationApi = async () => ({
      createStructureRepresentationParams: vi.fn(
        (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
      ),
      StateTransforms: {
        Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
      },
    });

    const firstRefs = await applyTestSurfaceOverlay(plugin, true, {
      targetScope: 'broad',
      typeParams: { alpha: 0.13, quality: 'auto' },
      colorMode: 'context-muted',
      loadRepresentationApi,
    });
    const secondRefs = await applyTestSurfaceOverlay(plugin, true, {
      targetScope: 'broad',
      trackedOverlayRefs: firstRefs,
      typeParams: { alpha: 0.13, quality: 'auto' },
      colorMode: 'context-muted',
      loadRepresentationApi,
    });

    expect(firstRefs).toEqual(['broad-context-surface-overlay-0', 'broad-query-surface-overlay-1']);
    expect(secondRefs).toEqual(firstRefs);
    expect(deletions).toEqual([]);
    expect([...overlays.keys()]).toEqual(secondRefs);
    expect(applications.map((application) => application.componentRef)).toEqual([
      'broad-context',
      'broad-query',
    ]);
  });

  it('restores identical Surface Context geometry after a recipe round trip without rebuilding it', async () => {
    const context = makeSurfaceOverlayComponent('Structure Context', 'context-component');
    const { plugin, applications, overlays, representationParams } = makeSurfaceOverlayPlugin([
      context,
    ]);
    const loadRepresentationApi = async () => ({
      createStructureRepresentationParams: vi.fn(
        (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
      ),
      StateTransforms: {
        Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
      },
    });
    const options = {
      targetScope: 'broad' as const,
      typeParams: { alpha: 0.13 },
      loadRepresentationApi,
    };
    const first = await applyTestSurfaceOverlay(plugin, true, options);
    await applyTestSurfaceOverlay(plugin, false, { trackedOverlayRefs: first });
    expect(representationParams.get(first[0])).toMatchObject({ type: { params: { alpha: 0 } } });
    const restored = await applyTestSurfaceOverlay(plugin, true, options);
    expect(restored).toEqual(first);
    expect(applications).toHaveLength(1);
    expect([...overlays.keys()]).toEqual(first);
    expect(representationParams.get(first[0])).toMatchObject({ type: { params: { alpha: 0.13 } } });
    context.cell.parent.obj.data = 'replacement-structure-data';
    const changedCoordinates = await applyTestSurfaceOverlay(plugin, true, options);
    expect(changedCoordinates).not.toEqual(first);
    expect(applications).toHaveLength(2);
    expect([...overlays.keys()]).toEqual(changedCoordinates);
    context.cell.obj.data = 'replacement-selected-component-data';
    const changedSelection = await applyTestSurfaceOverlay(plugin, true, options);
    expect(changedSelection).not.toEqual(changedCoordinates);
    expect(applications).toHaveLength(3);
    expect([...overlays.keys()]).toEqual(changedSelection);
  });

  it('retains an in-flight gray surface across a superseded visual generation without rebuilding geometry', async () => {
    const context = makeSurfaceOverlayComponent('Structure Context', 'context-component');
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    let releaseCommit!: () => void;
    const pendingCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let notifyCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const { plugin, applications, overlays, deletions, representationParams } =
      makeSurfaceOverlayPlugin([context, query], [], {
        beforeCommit: async ({ addRefs }) => {
          if (addRefs.length === 0) return;
          notifyCommitStarted();
          await pendingCommit;
        },
      });
    const realApplySurfaceOverlay = surfaceOverlayRuntime.applySurfaceOverlayRenderPlan;
    const surfaceSpy = vi
      .spyOn(surfaceOverlayRuntime, 'applySurfaceOverlayRenderPlan')
      .mockImplementation((currentPlugin, surfacePlan, options) =>
        realApplySurfaceOverlay(currentPlugin, surfacePlan, {
          ...options,
          loadRepresentationApi: async () => ({
            createStructureRepresentationParams: (_plugin, _structureData, params) => params,
            StateTransforms: {
              Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
            },
          }),
        })
      );
    const plan: MolstarRenderPlan = {
      ...makeTestRenderPlan({ representation: 'cartoon' }),
      surfaceOverlay: {
        enabled: true,
        targetScope: 'broad',
        colorMode: 'context-muted',
        typeParams: { alpha: 0.13 },
      },
    };
    let visualCurrent = true;
    const options = {
      isCurrent: () => visualCurrent,
      isSurfaceCurrent: () => true,
      applyVisuals: false,
      applyDetailComponents: false,
      applySurfaceOverlay: true,
    };

    try {
      const firstOutcome = applyMolstarRenderPlanAfterReady(plugin, plan, options).then(
        () => null,
        (error: unknown) => error
      );
      await commitStarted;
      visualCurrent = false;
      releaseCommit();
      await expect(firstOutcome).resolves.toMatchObject({
        name: 'MolstarRenderPlanApplyCancelledError',
      });
      const originalRefs = [
        'context-component-surface-overlay-0',
        'query-component-surface-overlay-1',
      ];
      expect([...overlays.keys()]).toEqual(originalRefs);
      expect(deletions).toEqual([]);

      const currentRefs = await applyMolstarRenderPlanAfterReady(plugin, plan, {
        ...options,
        isCurrent: () => true,
      });

      expect(currentRefs).toEqual(originalRefs);
      expect(applications).toHaveLength(2);
      expect(deletions).toEqual([]);
      for (const ref of originalRefs) {
        expect(representationParams.get(ref)).toMatchObject({
          type: { name: 'molecular-surface', params: { alpha: 0.13 } },
        });
      }
      expect(applications.map(({ params }) => params)).toEqual([
        expect.objectContaining({ colorParams: contextChainPaletteParams() }),
        expect.objectContaining({ colorParams: contextChainPaletteParams() }),
      ]);
    } finally {
      releaseCommit();
      surfaceSpy.mockRestore();
    }
  });

  it('removes an in-flight surface when visual and surface generations both become stale', async () => {
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    let releaseCommit!: () => void;
    const pendingCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let notifyCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const { plugin, overlays, deletions } = makeSurfaceOverlayPlugin([query], [], {
      beforeCommit: async ({ addRefs }) => {
        if (addRefs.length === 0) return;
        notifyCommitStarted();
        await pendingCommit;
      },
    });
    const realApplySurfaceOverlay = surfaceOverlayRuntime.applySurfaceOverlayRenderPlan;
    const surfaceSpy = vi
      .spyOn(surfaceOverlayRuntime, 'applySurfaceOverlayRenderPlan')
      .mockImplementation((currentPlugin, surfacePlan, options) =>
        realApplySurfaceOverlay(currentPlugin, surfacePlan, {
          ...options,
          loadRepresentationApi: async () => ({
            createStructureRepresentationParams: (_plugin, _structureData, params) => params,
            StateTransforms: {
              Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
            },
          }),
        })
      );
    let current = true;
    const options = {
      isCurrent: () => current,
      isSurfaceCurrent: () => current,
      applyVisuals: false,
      applyDetailComponents: false,
      applySurfaceOverlay: true,
    };
    const plan: MolstarRenderPlan = {
      ...makeTestRenderPlan({ representation: 'cartoon' }),
      surfaceOverlay: { enabled: true, targetScope: 'broad', colorMode: 'context-muted' },
    };

    try {
      const outcome = applyMolstarRenderPlanAfterReady(plugin, plan, options).then(
        () => null,
        (error: unknown) => error
      );
      await commitStarted;
      current = false;
      releaseCommit();
      await expect(outcome).resolves.toMatchObject({
        name: 'MolstarRenderPlanApplyCancelledError',
      });
      expect(deletions).toEqual(['query-component-surface-overlay-0']);
      expect(overlays.size).toBe(0);
    } finally {
      releaseCommit();
      surfaceSpy.mockRestore();
    }
  });

  it('preserves existing broad surface overlays during detail-only Surface Context updates', async () => {
    const broadContext = makeSurfaceOverlayComponent('Structure Context', 'broad-context');
    const broadQuery = makeSurfaceOverlayComponent('Query Polymer', 'broad-query');
    const { plugin, applications, deletions } = makeSurfaceOverlayPlugin(
      [broadContext, broadQuery],
      ['broad-context-surface-overlay-0', 'broad-query-surface-overlay-1']
    );

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      targetScope: 'broad',
      trackedOverlayRefs: ['broad-context-surface-overlay-0', 'broad-query-surface-overlay-1'],
      preserveExisting: true,
      typeParams: { alpha: 0.13, quality: 'auto' },
      colorMode: 'context-muted',
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(refs).toEqual(['broad-context-surface-overlay-0', 'broad-query-surface-overlay-1']);
    expect(deletions).toEqual([]);
    expect(applications).toEqual([]);
  });

  it('removes every tagged or tracked hybrid overlay when leaving hybrid mode', async () => {
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const { plugin, overlays, deletions } = makeSurfaceOverlayPlugin(
      [query],
      ['tagged-context-overlay']
    );

    const refs = await applyTestSurfaceOverlay(plugin, false, {
      trackedOverlayRefs: ['tracked-query-overlay'],
    });

    expect(refs).toEqual([]);
    expect(deletions).toEqual(['tagged-context-overlay', 'tracked-query-overlay']);
    expect(overlays.size).toBe(0);
  });

  it('does not commit a stale hybrid overlay after a newer recipe generation wins', async () => {
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const { plugin, overlays, applications } = makeSurfaceOverlayPlugin([query]);
    let isCurrentGeneration = true;

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      isCurrent: () => isCurrentGeneration,
      loadRepresentationApi: async () => {
        isCurrentGeneration = false;
        return {
          createStructureRepresentationParams: vi.fn(
            (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
          ),
          StateTransforms: {
            Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
          },
        };
      },
    });

    expect(refs).toEqual([]);
    expect(applications).toEqual([]);
    expect(overlays.size).toBe(0);
  });

  it('does not run stale hybrid cleanup before checking the active generation', async () => {
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    const { plugin, overlays, deletions } = makeSurfaceOverlayPlugin(
      [query],
      ['new-current-overlay']
    );

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      isCurrent: () => false,
      trackedOverlayRefs: ['new-current-overlay'],
    });

    expect(refs).toEqual([]);
    expect(deletions).toEqual([]);
    expect(overlays.has('new-current-overlay')).toBe(true);
  });

  it('does not let stale hybrid cleanup delete a newer hybrid overlay', async () => {
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    let isCurrentGeneration = true;
    const { plugin, overlays, deletions } = makeSurfaceOverlayPlugin([query], [], {
      onCommit: (currentOverlays) => {
        currentOverlays.set('new-current-overlay', {
          transform: { ref: 'new-current-overlay' },
        });
        isCurrentGeneration = false;
      },
    });

    const refs = await applyTestSurfaceOverlay(plugin, true, {
      isCurrent: () => isCurrentGeneration,
      loadRepresentationApi: async () => ({
        createStructureRepresentationParams: vi.fn(
          (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
        ),
        StateTransforms: {
          Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
        },
      }),
    });

    expect(refs).toEqual([]);
    expect(deletions).toContain('query-component-surface-overlay-0');
    expect(deletions).not.toContain('new-current-overlay');
    expect(overlays.has('new-current-overlay')).toBe(true);
    expect(overlays.has('query-component-surface-overlay-0')).toBe(false);
  });

  it('serializes concurrent current overlay syncs so cleanup cannot delete the sibling overlay', async () => {
    const query = makeSurfaceOverlayComponent('Query Polymer', 'query-component');
    let addCommitCount = 0;
    let releaseBothAdds: () => void = () => undefined;
    const bothAddsStarted = new Promise<void>((resolve) => {
      releaseBothAdds = resolve;
    });
    const { plugin, overlays, deletions } = makeSurfaceOverlayPlugin([query], [], {
      beforeCommit: async ({ addRefs }) => {
        if (addRefs.length === 0) return;
        addCommitCount += 1;
        if (addCommitCount >= 2) releaseBothAdds();
        await Promise.race([bothAddsStarted, new Promise((resolve) => setTimeout(resolve, 25))]);
      },
    });
    const loadRepresentationApi = async () => ({
      createStructureRepresentationParams: vi.fn(
        (_plugin: unknown, _structureData: unknown, params: Record<string, unknown>) => params
      ),
      StateTransforms: {
        Representation: { StructureRepresentation3D: 'StructureRepresentation3D' },
      },
    });

    const [firstRefs, secondRefs] = await Promise.all([
      applyTestSurfaceOverlay(plugin, true, {
        targetScope: 'broad',
        loadRepresentationApi,
      }),
      applyTestSurfaceOverlay(plugin, true, {
        targetScope: 'broad',
        loadRepresentationApi,
      }),
    ]);

    const returnedRefs = new Set([...firstRefs, ...secondRefs]);
    expect(overlays.size).toBeGreaterThan(0);
    expect([...overlays.keys()]).toEqual(expect.arrayContaining([...returnedRefs].slice(-1)));
    expect(deletions).not.toEqual(expect.arrayContaining([...overlays.keys()]));
  });
});

describe('MolstarViewer — Electron E2E stub', () => {
  beforeEach(() => {
    clearViewerCache();
    clearStructureRenderTransactionDiagnostics();
    mockedFetchStructureData.mockClear();
    mockedActivateViewerStructure.mockClear();
    document.body.replaceChildren();
    class MockResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    delete window.__WAYPOINT_E2E_MOLSTAR_STUB__;
    delete window.__WAYPOINT_E2E_MOLSTAR_FETCH_BYTES__;
    clearStructureRenderTransactionDiagnostics();
    clearViewerCache();
    document.body.replaceChildren();
  });

  it('renders a deterministic shell without initializing WebGL', async () => {
    window.__WAYPOINT_E2E_MOLSTAR_STUB__ = true;
    const onLoad = vi.fn();
    const onError = vi.fn();

    render(<MolstarViewer uniprotId="P0AD86" height={240} onLoad={onLoad} onError={onError} />);

    expect(screen.getByTestId('molstar-viewer-stub')).toBeInTheDocument();
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
  });

  it('exposes the shadow render transaction for the exact visible viewer cache key', async () => {
    window.__WAYPOINT_E2E_MOLSTAR_STUB__ = true;
    const renderModel = createStructureRenderModel({
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          entityId: '1',
          sequence: 'AGS',
          residues: [
            { position: 1, name: 'A', name3: 'ALA' },
            { position: 2, name: 'G', name3: 'GLY' },
            { position: 3, name: 'S', name3: 'SER' },
          ],
        },
      ],
    });

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="transaction-preview"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex-preview',
          recipe: createQueryInComplexPreviewRecipe(),
          renderIntent: 'preview',
          showWater: false,
          spin: false,
        }}
        renderModel={renderModel}
      />
    );

    const stub = screen.getByTestId('molstar-viewer-stub');
    await waitFor(() => expect(stub).toHaveAttribute('data-render-intent', 'preview'));
    expect(stub).toHaveAttribute('data-chain-catalog-status', 'resolved');
    const domPlanHash = stub.getAttribute('data-structure-render-plan-hash');
    expect(domPlanHash).toMatch(/^wprtx_/);

    const cacheKey = stub.getAttribute('data-viewer-cache-key');
    expect(cacheKey).toContain('transaction-preview:preview');
    await waitFor(() => {
      expect(getStructureRenderTransactionDiagnostics()).toContainEqual(
        expect.objectContaining({
          key: cacheKey,
          transaction: expect.objectContaining({
            renderIntent: 'preview',
            planHash: domPlanHash,
            chainCatalogStatus: 'resolved',
            invariants: expect.objectContaining({
              previewAllowsSurface: false,
              hasSurfaceLayer: false,
            }),
          }),
        })
      );
    });
  });

  it('does not refetch e2e stub bytes when an equivalent structure identity object is recreated', async () => {
    window.__WAYPOINT_E2E_MOLSTAR_STUB__ = true;
    window.__WAYPOINT_E2E_MOLSTAR_FETCH_BYTES__ = true;
    const identity = {
      provider: 'rcsb' as const,
      externalId: 'RCSB:1ABC:ENTRY:LABEL_ASYM:A,B',
      pdbId: '1ABC',
      labelAsymIds: ['A', 'B'],
    };
    const { rerender } = render(
      <MolstarViewer pdbId="1ABC" structureIdentity={identity} height={240} />
    );

    await waitFor(() => expect(mockedFetchStructureData).toHaveBeenCalledTimes(1));

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        structureIdentity={{ ...identity, labelAsymIds: ['B', 'A'] }}
        height={240}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedFetchStructureData).toHaveBeenCalledTimes(1);
  });

  it('keeps same-structure viewer instances isolated instead of stealing one cached DOM tree', async () => {
    const leftKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'tab-left');
    const rightKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-right');
    seedCachedViewer(leftKey, 'left-molstar-cache');
    seedCachedViewer(rightKey, 'right-molstar-cache');

    render(
      <div>
        <section data-testid="left-viewer">
          <MolstarViewer pdbId="1ABC" viewerInstanceId="tab-left" height={240} />
        </section>
        <section data-testid="right-viewer">
          <MolstarViewer pdbId="1ABC" viewerInstanceId="drawer-right" height={240} />
        </section>
      </div>
    );

    await waitFor(() => {
      expect(screen.getByTestId('left-viewer')).toContainElement(
        screen.getByTestId('left-molstar-cache')
      );
      expect(screen.getByTestId('right-viewer')).toContainElement(
        screen.getByTestId('right-molstar-cache')
      );
    });
  });

  it('reuses one pane renderer when the active structure tab changes', async () => {
    const rendererHostId = 'pane:main';
    const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
    const cached = seedCachedViewer(cacheKey, 'pane-renderer-cache');
    cached.loadedStructureKey = 'provider:RCSB:1AAA:ENTRY';

    const { rerender } = render(
      <MolstarViewer pdbId="1AAA" rendererHostId={rendererHostId} height={240} />
    );

    await waitFor(() => expect(screen.getByTestId('pane-renderer-cache')).toBeInTheDocument());
    expect(mockedActivateViewerStructure).not.toHaveBeenCalled();

    rerender(<MolstarViewer pdbId="2BBB" rendererHostId={rendererHostId} height={240} />);

    await waitFor(() => {
      expect(mockedActivateViewerStructure).toHaveBeenCalledWith(
        cached,
        expect.objectContaining({
          structureKey: 'provider:RCSB:2BBB:ENTRY',
          pdbId: '2BBB',
        })
      );
    });
    expect(viewerCache.size).toBe(1);
    expect(viewerCache.get(cacheKey)).toBe(cached);
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();
  });

  it('restores the target logical camera after a pane renderer changes structures', async () => {
    const rendererHostId = 'pane:camera-restore';
    const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
    const cached = seedCachedViewer(cacheKey, 'pane-camera-restore-cache');
    cached.loadedStructureKey = 'provider:RCSB:1AAA:ENTRY';
    attachCameraStateChangedMock(cached);
    const targetCamera = {
      position: [21, 58, 166],
      target: [0, 0, 0],
      up: [0, 1, 0],
      radius: 12,
      fog: 50,
      fov: 45,
    };

    render(
      <MolstarViewer
        pdbId="2BBB"
        rendererHostId={rendererHostId}
        height={240}
        cameraSnapshot={JSON.stringify(targetCamera)}
      />
    );

    await waitFor(() => expect(mockedActivateViewerStructure).toHaveBeenCalled());
    await waitFor(() =>
      expect(cached.plugin?.canvas3d?.camera?.setState).toHaveBeenCalledWith(targetCamera, 0)
    );
  });

  it('announces readiness after restoring a queued saved camera without another render', async () => {
    const id = 'queued-camera-ready';
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', id);
    const cached = seedCachedViewer(cacheKey, 'queued-camera-ready-cache');
    cached.logicalViewInstanceId = id;
    const camera = attachCameraStateChangedMock(cached);
    const requested = { ...camera.getSnapshot(), position: [10, 20, 30] };
    const scene = JSON.stringify({
      root: { kind: 'root', children: [] },
      metadata: { version: '1', timestamp: '2026-10-08T00:00:00Z' },
    });
    const activeScene = vi
      .spyOn(molViewSpecRuntime, 'activeMolViewSpecScene')
      .mockReturnValue(scene);
    const bindAssets = vi
      .spyOn(molViewSpecRuntime, 'bindMolViewSpecPinnedAssets')
      .mockImplementation(() => {});
    const onLoad = vi.fn();
    let host: ReturnType<typeof render> | undefined;
    try {
      host = render(
        <MolstarViewer
          pdbId="1ABC"
          viewerInstanceId={id}
          height={240}
          molViewSpec={scene}
          cameraSnapshot={JSON.stringify(requested)}
          onLoad={onLoad}
        />
      );
      await waitFor(() =>
        expect(cached.plugin?.canvas3d?.camera.setState).toHaveBeenCalledWith(requested, 0)
      );
      await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    } finally {
      host?.unmount();
      activeScene.mockRestore();
      bindAssets.mockRestore();
    }
  });

  it('retains a manually moved camera when appearance changes before its saved snapshot catches up', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'camera-data-edit');
    const cached = seedCachedViewer(cacheKey, 'camera-data-edit-cache');
    cached.logicalViewInstanceId = 'camera-data-edit';
    const camera = attachCameraStateChangedMock(cached);
    const savedSnapshot = JSON.stringify(camera.getSnapshot());
    const scene = (color: string) =>
      JSON.stringify({
        root: { kind: 'root', children: [] },
        metadata: { version: '1', timestamp: '2026-10-08T00:00:00Z', title: color },
      });
    const activeScene = vi
      .spyOn(molViewSpecRuntime, 'activeMolViewSpecScene')
      .mockReturnValue(scene('before'));
    const bindAssets = vi
      .spyOn(molViewSpecRuntime, 'bindMolViewSpecPinnedAssets')
      .mockImplementation(() => {});
    try {
      const { rerender, unmount } = render(
        <MolstarViewer
          pdbId="1ABC"
          viewerInstanceId="camera-data-edit"
          height={240}
          molViewSpec={scene('before')}
          cameraSnapshot={savedSnapshot}
        />
      );
      await waitFor(() => expect(screen.getByTestId('camera-data-edit-cache')).toBeVisible());
      const nativeCamera = cached.plugin!.canvas3d!.camera;
      const moved = { ...camera.getSnapshot(), position: [12, 25, 73] };
      camera.getSnapshot.mockReturnValue(moved);
      act(() => camera.emitDraw());
      vi.mocked(nativeCamera.setState).mockClear();

      activeScene.mockReturnValue(scene('after'));
      rerender(
        <MolstarViewer
          pdbId="1ABC"
          viewerInstanceId="camera-data-edit"
          height={240}
          molViewSpec={scene('after')}
          cameraSnapshot={savedSnapshot}
        />
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(nativeCamera.setState).not.toHaveBeenCalled();

      const requested = { ...moved, position: [100, 200, 300] };
      rerender(
        <MolstarViewer
          pdbId="1ABC"
          viewerInstanceId="camera-data-edit"
          height={240}
          molViewSpec={scene('after')}
          cameraSnapshot={JSON.stringify(requested)}
        />
      );
      await waitFor(() => expect(nativeCamera.setState).toHaveBeenCalledWith(requested, 0));
      unmount();
    } finally {
      activeScene.mockRestore();
      bindAssets.mockRestore();
    }
  });

  it('restores a saved story camera for a fresh tab while preserving the same live tab camera on reattachment', async () => {
    const rendererHostId = 'pane:saved-camera-reopen';
    const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
    const cached = seedCachedViewer(cacheKey, 'saved-camera-reopen-cache');
    cached.loadedStructureKey = 'provider:RCSB:1ABC:ENTRY';
    Object.assign(cached, { logicalViewInstanceId: 'tab:closed' });
    const readback = attachCameraStateChangedMock(cached);
    const savedCamera = { ...readback.getSnapshot(), position: [10, 20, 30] };
    const changedCamera = { ...savedCamera, position: [40, 50, 60] };
    readback.getSnapshot.mockReturnValue(changedCamera);
    const scene = JSON.stringify({
      kind: 'multiple',
      metadata: { version: '1', timestamp: '2026-10-20T00:00:00.000Z' },
      snapshots: [0, 1].map((index) => ({
        root: { kind: 'root' },
        metadata: { key: `view:${index}`, linger_duration_ms: 1000 },
      })),
    });
    const activeScene = vi.spyOn(molViewSpec, 'activeMolViewSpecScene').mockReturnValue(scene);
    const activeIndex = vi.spyOn(molViewSpec, 'activeMolViewSpecSnapshotIndex').mockReturnValue(1);
    const bindAssets = vi
      .spyOn(molViewSpec, 'bindMolViewSpecPinnedAssets')
      .mockImplementation(() => {});
    const loadScene = vi.spyOn(molViewSpec, 'loadMolViewSpecScene').mockImplementation(async () => {
      readback.getSnapshot.mockReturnValue(savedCamera);
    });
    const onReady = vi.fn();
    const viewer = (id: string) => (
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId={id}
        rendererHostId={rendererHostId}
        molViewSpec={scene}
        molViewSpecSnapshotIndex={1}
        height={240}
        onPluginReady={onReady}
      />
    );
    let host: ReturnType<typeof render> | undefined;
    try {
      host = render(viewer('tab:reopened'));
      await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
      expect(loadScene).toHaveBeenCalledOnce();
      expect(readback.getSnapshot()).toEqual(savedCamera);

      readback.getSnapshot.mockReturnValue(changedCamera);
      host.unmount();
      host = render(viewer('tab:reopened'));
      await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
      expect(loadScene).toHaveBeenCalledOnce();
      expect(readback.getSnapshot()).toEqual(changedCamera);

      host.rerender(viewer('tab:reopened-again'));
      await waitFor(() => expect(loadScene).toHaveBeenCalledTimes(2));
      expect(readback.getSnapshot()).toEqual(savedCamera);
    } finally {
      host?.unmount();
      activeScene.mockRestore();
      activeIndex.mockRestore();
      bindAssets.mockRestore();
      loadScene.mockRestore();
    }
  });

  it('retries a failed pane scene without disposing its reusable renderer', async () => {
    const rendererHostId = 'pane:retry';
    const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
    const cached = seedCachedViewer(cacheKey, 'retry-pane-renderer-cache');
    cached.loadedStructureKey = null;
    cached.error = 'bad coordinates';

    render(<MolstarViewer pdbId="2BBB" rendererHostId={rendererHostId} height={240} />);

    await waitFor(() =>
      expect(screen.getByTestId('molstar-viewer-error')).toHaveTextContent(
        userMessage('structure.failed')
      )
    );
    expect(viewerCache.get(cacheKey)).toBe(cached);
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();

    act(() => screen.getByRole('button', { name: 'Retry 3D structure' }).click());

    await waitFor(() =>
      expect(mockedActivateViewerStructure).toHaveBeenCalledWith(
        cached,
        expect.objectContaining({ structureKey: 'provider:RCSB:2BBB:ENTRY' })
      )
    );
    expect(viewerCache.get(cacheKey)).toBe(cached);
    expect(cached.plugin?.dispose).not.toHaveBeenCalled();
  });

  it.each(['update', 'remount'] as const)(
    'clears a failed pane intent when the user switches to another structure by %s',
    async (transition) => {
      const rendererHostId = 'pane:failed-then-switch';
      const cacheKey = getPaneRendererHostCacheKey(rendererHostId);
      const cached = seedCachedViewer(cacheKey, 'failed-then-switch-cache');
      cached.loadedStructureKey = null;
      cached.error = 'bad coordinates';
      cached.rendererHostActivation = {
        generation: 1,
        requestedStructureKey: 'provider:RCSB:2BBB:ENTRY',
        loadedStructureKey: null,
        queue: Promise.resolve(),
      };
      const view = render(
        <MolstarViewer pdbId="2BBB" rendererHostId={rendererHostId} height={240} />
      );
      await waitFor(() =>
        expect(screen.getByTestId('molstar-viewer-error')).toHaveTextContent(
          userMessage('structure.failed')
        )
      );
      expect(mockedActivateViewerStructure).not.toHaveBeenCalled();

      const next = <MolstarViewer pdbId="3CCC" rendererHostId={rendererHostId} height={240} />;
      if (transition === 'remount') {
        view.unmount();
        render(next);
      } else {
        view.rerender(next);
      }
      await waitFor(() =>
        expect(mockedActivateViewerStructure).toHaveBeenCalledWith(
          cached,
          expect.objectContaining({ structureKey: 'provider:RCSB:3CCC:ENTRY' })
        )
      );
      await waitFor(() => expect(screen.queryByTestId('molstar-viewer-error')).toBeNull());
      expect(viewerCache.get(cacheKey)).toBe(cached);
      expect(cached.plugin?.dispose).not.toHaveBeenCalled();
    }
  );

  it('keeps hover-preview MolStar cache entries isolated from committed loaded viewers', async () => {
    const loadedKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-same-structure');
    const previewKey = getViewerCacheKey(
      'provider:RCSB:1ABC:ENTRY',
      'drawer-same-structure:preview'
    );
    seedCachedViewer(loadedKey, 'loaded-cartoon-cache');
    seedCachedViewer(previewKey, 'preview-cartoon-cache');

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-same-structure"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex-preview',
          recipe: createQueryInComplexPreviewRecipe(),
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('preview-cartoon-cache')).toBeInTheDocument();
      expect(screen.queryByTestId('loaded-cartoon-cache')).not.toBeInTheDocument();
    });
  });

  it('keeps the cartoon preview visible while the committed complex default viewer is still loading', async () => {
    const loadedKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-transition');
    const previewKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-transition:preview');
    seedCachedViewer(previewKey, 'preview-cartoon-cache');
    const loadingLoadedViewer = seedCachedViewer(loadedKey, 'loaded-cartoon-cache');
    loadingLoadedViewer.isLoading = true;

    const { rerender } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-transition"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex-preview',
          recipe: createQueryInComplexPreviewRecipe(),
          renderIntent: 'preview',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => expect(screen.getByTestId('preview-cartoon-cache')).toBeInTheDocument());

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-transition"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex',
          recipe: createQueryInComplexRecipe(),
          renderIntent: 'loaded',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('preview-cartoon-cache')).toBeInTheDocument();
      expect(screen.getByTestId('loaded-cartoon-cache')).toBeInTheDocument();
      expect(screen.getByTestId('cached-container-loaded-cartoon-cache')).toHaveAttribute(
        'data-viewer-transition-stage',
        'staged'
      );
    });
  });

  it('uses the matching preview cache as a remount handoff while the committed viewer is still loading', async () => {
    const loadedKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-remount-transition');
    const previewKey = getViewerCacheKey(
      'provider:RCSB:1ABC:ENTRY',
      'drawer-remount-transition:preview'
    );
    seedCachedViewer(previewKey, 'preview-remount-cache');
    const loadingLoadedViewer = seedCachedViewer(loadedKey, 'loaded-remount-cache');
    loadingLoadedViewer.isLoading = true;

    const { unmount } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-remount-transition"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex-preview',
          recipe: createQueryInComplexPreviewRecipe(),
          renderIntent: 'preview',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => expect(screen.getByTestId('preview-remount-cache')).toBeInTheDocument());
    unmount();

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-remount-transition"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex',
          recipe: createQueryInComplexRecipe(),
          renderIntent: 'loaded',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('preview-remount-cache')).toBeInTheDocument();
      expect(screen.getByTestId('loaded-remount-cache')).toBeInTheDocument();
      expect(screen.getByTestId('cached-container-loaded-remount-cache')).toHaveAttribute(
        'data-viewer-transition-stage',
        'staged'
      );
    });
  });

  it('uses a same-instance preview cache for remount handoff when the committed structure key changes', async () => {
    const identity = {
      provider: 'rcsb' as const,
      externalId: 'RCSB:1ABC:ENTRY:AUTH_ASYM:A',
      pdbId: '1ABC',
      authAsymIds: ['A'],
    };
    const previewKey = getViewerCacheKey(
      'provider:RCSB:1ABC:ENTRY',
      'drawer-scope-transition:preview'
    );
    const loadedKey = getViewerCacheKey(
      getStructureKey(undefined, undefined, undefined, undefined, identity),
      'drawer-scope-transition'
    );
    seedCachedViewer(previewKey, 'preview-scope-cache');
    const loadingLoadedViewer = seedCachedViewer(loadedKey, 'loaded-scope-cache');
    loadingLoadedViewer.isLoading = true;

    const { unmount } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-scope-transition"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex-preview',
          recipe: createQueryInComplexPreviewRecipe(),
          renderIntent: 'preview',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => expect(screen.getByTestId('preview-scope-cache')).toBeInTheDocument());
    unmount();

    render(
      <MolstarViewer
        pdbId="1ABC"
        structureIdentity={identity}
        viewerInstanceId="drawer-scope-transition"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex',
          recipe: createQueryInComplexRecipe(),
          renderIntent: 'loaded',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('preview-scope-cache')).toBeInTheDocument();
      expect(screen.getByTestId('loaded-scope-cache')).toBeInTheDocument();
      expect(screen.getByTestId('cached-container-loaded-scope-cache')).toHaveAttribute(
        'data-viewer-transition-stage',
        'staged'
      );
    });
  });

  it('replaces an older selected structure with the target preview during loaded handoff', async () => {
    const instanceId = 'drawer-replace-transition';
    const oldLoadedKey = getViewerCacheKey('provider:RCSB:1OLD:ENTRY', instanceId);
    const newLoadedKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', instanceId);
    const newPreviewKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', `${instanceId}:preview`);
    seedCachedViewer(oldLoadedKey, 'old-selected-cache');
    const previewCachedViewer = seedCachedViewer(newPreviewKey, 'new-preview-cache');
    const loadingNewLoadedViewer = seedCachedViewer(newLoadedKey, 'new-loaded-cache');
    loadingNewLoadedViewer.isLoading = true;

    const { rerender } = render(
      <MolstarViewer pdbId="1OLD" viewerInstanceId={instanceId} height={240} />
    );

    await waitFor(() => expect(screen.getByTestId('old-selected-cache')).toBeInTheDocument());

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId={instanceId}
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex',
          recipe: createQueryInComplexRecipe(),
          renderIntent: 'loaded',
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(screen.queryByTestId('old-selected-cache')).not.toBeInTheDocument();
      expect(screen.getByTestId('new-preview-cache')).toBeInTheDocument();
      expect(screen.getByTestId('new-loaded-cache')).toBeInTheDocument();
      expect(screen.getByTestId('cached-container-new-loaded-cache')).toHaveAttribute(
        'data-viewer-transition-stage',
        'staged'
      );
      expect(viewerCache.get(newLoadedKey)).toBe(loadingNewLoadedViewer);
      expect(viewerCache.get(newPreviewKey)).toBe(previewCachedViewer);
      expect(previewCachedViewer.plugin?.canvas3d?.handleResize).toHaveBeenCalled();
    });
  });

  it('reattaches a moved viewer instance from an old connected host into its current wrapper', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'tab-moving');
    const cached = seedCachedViewer(cacheKey, 'moving-molstar-cache');
    const oldHost = document.createElement('div');
    document.body.appendChild(oldHost);
    oldHost.appendChild(cached.container);

    render(<MolstarViewer pdbId="1ABC" viewerInstanceId="tab-moving" height={240} />);

    await waitFor(() => {
      expect(screen.getByTestId('moving-molstar-cache')).toBeInTheDocument();
      expect(oldHost).not.toContainElement(screen.getByTestId('moving-molstar-cache'));
    });
  });

  it('applies a complete spin animation config through the visible viewer path', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'spin-visible');
    const cached = seedCachedViewer(cacheKey, 'spin-molstar-cache');

    const { rerender } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="spin-visible"
        height={240}
        view={recipeView(createCartoonRecipe(), { spin: false })}
      />
    );

    await waitFor(() => expect(screen.getByTestId('spin-molstar-cache')).toBeInTheDocument());
    vi.mocked(cached.plugin?.canvas3d?.setProps).mockClear();

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="spin-visible"
        height={240}
        view={recipeView(createCartoonRecipe(), { spin: true })}
      />
    );

    await waitFor(() => {
      expect(cached.plugin?.canvas3d?.setProps).toHaveBeenCalledWith({
        trackball: expect.objectContaining({
          animate: {
            name: 'spin',
            params: {
              speed: expect.any(Number),
              axis: [0, -1, 0],
            },
          },
        }),
      });
    });
    expect(cached.plugin?.canvas3d?.animate).toHaveBeenCalled();
  });

  it('does not rerun heavy representation reconciliation for a spin-only change', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'spin-only-style-change');
    const { cached, updates } = seedRepresentationCachedViewer(
      cacheKey,
      'spin-only-style-change-cache',
      [
        makeRepresentationComponent('Structure Context', ['context-cartoon']),
        makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
      ]
    );

    const { rerender } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="spin-only-style-change"
        height={240}
        view={recipeView(createSurfaceRecipe(), { spin: false })}
      />
    );

    await waitFor(() => {
      expect(updates).toContainEqual({
        ref: 'query-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({ name: 'molecular-surface' }),
        }),
      });
    });
    updates.splice(0, updates.length);
    vi.mocked(cached.plugin?.canvas3d?.setProps).mockClear();

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="spin-only-style-change"
        height={240}
        view={recipeView(createSurfaceRecipe(), { spin: true })}
      />
    );

    await waitFor(() => {
      expect(cached.plugin?.canvas3d?.setProps).toHaveBeenCalledWith({
        trackball: expect.objectContaining({
          animate: expect.objectContaining({ name: 'spin' }),
        }),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updates).toEqual([]);
  });

  it('repairs representation state without publishing errors from a superseded apply', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'superseded-render-plan-repair');
    let shouldBlockNextCommit = false;
    let releaseBlockedCommit: (() => void) | null = null;
    let reportBlockedCommit: (() => void) | null = null;
    const blockedCommitStarted = new Promise<void>((resolve) => {
      reportBlockedCommit = resolve;
    });
    const blockedCommitReleased = new Promise<void>((resolve) => {
      releaseBlockedCommit = resolve;
    });
    const onLoad = vi.fn();
    const { updates, commits } = seedRepresentationCachedViewer(
      cacheKey,
      'superseded-render-plan-repair-cache',
      [
        makeRepresentationComponent('Structure Context', ['context-cartoon']),
        makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
      ],
      {
        applyUpdatesToPluginState: true,
        beforeCommit: async () => {
          if (!shouldBlockNextCommit) return;
          shouldBlockNextCommit = false;
          reportBlockedCommit?.();
          await blockedCommitReleased;
          throw new Error('superseded representation commit failed');
        },
      }
    );

    const { rerender } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="superseded-render-plan-repair"
        height={240}
        view={recipeView(createCartoonRecipe())}
        onLoad={onLoad}
      />
    );

    await waitFor(() => {
      expect(updates).toContainEqual({
        ref: 'query-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({ name: 'cartoon' }),
        }),
      });
      expect(commits.length).toBeGreaterThan(0);
      expect(onLoad).toHaveBeenCalledTimes(1);
    });
    const initialCommitCount = commits.length;
    updates.splice(0, updates.length);

    shouldBlockNextCommit = true;
    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="superseded-render-plan-repair"
        height={240}
        view={recipeView(createSurfaceRecipe())}
      />
    );
    await blockedCommitStarted;
    const staleSurfaceUpdateIndex = updates.findIndex(
      ({ ref, payload }) =>
        ref === 'query-cartoon' &&
        (payload as { type?: { name?: string } }).type?.name === 'molecular-surface'
    );
    expect(staleSurfaceUpdateIndex).toBeGreaterThanOrEqual(0);

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="superseded-render-plan-repair"
        height={240}
        view={recipeView(createCartoonRecipe())}
      />
    );
    releaseBlockedCommit?.();

    await waitFor(() => {
      expect(
        updates
          .slice(staleSurfaceUpdateIndex + 1)
          .some(
            ({ ref, payload }) =>
              ref === 'query-cartoon' &&
              (payload as { type?: { name?: string } }).type?.name === 'cartoon'
          )
      ).toBe(true);
      expect(commits.length).toBeGreaterThan(initialCommitCount);
      expect(screen.queryByTestId('molstar-viewer-error')).not.toBeInTheDocument();
    });
  });

  it('keeps automatic spin camera frames off the persisted React attrs path', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'spin-camera-persistence');
    const cached = seedCachedViewer(cacheKey, 'spin-camera-persistence-cache');
    const camera = attachCameraStateChangedMock(cached);
    const onCameraChange = vi.fn();

    const { rerender } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="spin-camera-persistence"
        height={240}
        view={recipeView(createCartoonRecipe(), { spin: true })}
        onCameraChange={onCameraChange}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId('spin-camera-persistence-cache')).toBeInTheDocument()
    );
    await waitFor(() => expect(camera.subscribe).toHaveBeenCalled());

    act(() => {
      for (let i = 0; i < 8; i += 1) camera.emit();
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(onCameraChange).not.toHaveBeenCalled();

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="spin-camera-persistence"
        height={240}
        view={recipeView(createCartoonRecipe(), { spin: false })}
        onCameraChange={onCameraChange}
      />
    );

    act(() => camera.emit());
    await waitFor(() => expect(onCameraChange).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    expect(JSON.parse(onCameraChange.mock.calls[0][0])).toEqual({
      position: [1, 2, 3],
      target: [0, 0, 0],
      up: [0, 1, 0],
      radius: 12,
      fog: 50,
      fov: 45,
    });
  });

  it('flushes a retiring view camera only to the callback that owns that view', async () => {
    const first = seedCachedViewer(
      getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'camera-owner-a'),
      'camera-owner-a-cache'
    );
    seedCachedViewer(
      getViewerCacheKey('provider:RCSB:2XYZ:ENTRY', 'camera-owner-b'),
      'camera-owner-b-cache'
    );
    const camera = attachCameraStateChangedMock(first);
    const saveFirst = vi.fn();
    const saveSecond = vi.fn();
    const { rerender, unmount } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="camera-owner-a"
        height={240}
        view={recipeView(createCartoonRecipe())}
        onCameraChange={saveFirst}
      />
    );
    await waitFor(() => expect(camera.subscribe).toHaveBeenCalled());
    act(() => camera.emit());
    rerender(
      <MolstarViewer
        pdbId="2XYZ"
        viewerInstanceId="camera-owner-b"
        height={240}
        view={recipeView(createCartoonRecipe())}
        onCameraChange={saveSecond}
      />
    );
    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saveFirst.mock.calls[0][0]).position).toEqual([1, 2, 3]);
    expect(saveSecond).not.toHaveBeenCalled();
    unmount();
    expect(saveSecond).not.toHaveBeenCalled();
  });

  it('flushes a pending manual camera snapshot before a pane deactivates the view', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'camera-flush-on-unmount');
    const cached = seedCachedViewer(cacheKey, 'camera-flush-on-unmount-cache');
    const camera = attachCameraStateChangedMock(cached);
    const onCameraChange = vi.fn();

    const { unmount } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="camera-flush-on-unmount"
        height={240}
        view={recipeView(createCartoonRecipe())}
        onCameraChange={onCameraChange}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId('camera-flush-on-unmount-cache')).toBeInTheDocument()
    );
    await waitFor(() => expect(camera.subscribe).toHaveBeenCalled());

    act(() => camera.emit());
    expect(onCameraChange).not.toHaveBeenCalled();

    unmount();

    expect(onCameraChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onCameraChange.mock.calls[0][0])).toEqual({
      position: [1, 2, 3],
      target: [0, 0, 0],
      up: [0, 1, 0],
      radius: 12,
      fog: 50,
      fov: 45,
    });
  });

  it('persists manual trackball motion from native frames without persisting unchanged redraws or spin', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'trackball-camera');
    const cached = seedCachedViewer(cacheKey, 'trackball-camera-cache');
    const camera = attachCameraStateChangedMock(cached);
    const onCameraChange = vi.fn();
    const { rerender, unmount } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="trackball-camera"
        height={240}
        view={recipeView(createCartoonRecipe())}
        onCameraChange={onCameraChange}
      />
    );
    await waitFor(() => expect(camera.drawSubscribe).toHaveBeenCalled());

    camera.getSnapshot.mockReturnValue({ ...camera.getSnapshot(), position: [3, 2, 1] });
    act(() => camera.emitDraw());
    await waitFor(() => expect(onCameraChange).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    expect(JSON.parse(onCameraChange.mock.calls[0][0]).position).toEqual([3, 2, 1]);
    act(() => {
      camera.emitDraw();
      camera.emitDraw();
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(onCameraChange).toHaveBeenCalledTimes(1);
    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="trackball-camera"
        height={240}
        view={recipeView(createCartoonRecipe(), { spin: true })}
        onCameraChange={onCameraChange}
      />
    );
    camera.getSnapshot.mockReturnValue({ ...camera.getSnapshot(), position: [5, 2, 1] });
    act(() => camera.emitDraw());
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(onCameraChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(camera.drawUnsubscribe).toHaveBeenCalled();
  });

  it('does not rerun heavy representation reconciliation after a before-reveal pass', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'before-reveal-style-pass');
    const { updates } = seedRepresentationCachedViewer(cacheKey, 'before-reveal-style-pass-cache', [
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="before-reveal-style-pass"
        height={240}
        view={recipeView(createSurfaceRecipe())}
      />
    );

    await waitFor(() => {
      expect(
        updates.filter(
          (update) =>
            update.ref === 'context-cartoon' &&
            (update.payload as { type?: { name?: string } }).type?.name === 'molecular-surface'
        )
      ).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      updates.filter(
        (update) =>
          update.ref === 'context-cartoon' &&
          (update.payload as { type?: { name?: string } }).type?.name === 'molecular-surface'
      )
    ).toHaveLength(1);
  });

  it('keeps cached unscoped structure polymers visible when a sequence render model is present', async () => {
    const structureData = 'data_mock\n';
    const cacheKey = getViewerCacheKey(
      getStructureKey(undefined, undefined, undefined, structureData),
      'unscoped-sequence-render-model'
    );
    const { updates } = seedRepresentationCachedViewer(cacheKey, 'unscoped-model-cache', [
      makeRepresentationComponent('Polymer', ['broad-polymer-cartoon']),
    ]);
    const renderModel = createStructureRenderModel({
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'A',
          entityId: '1',
          sequence: 'AGS',
          residues: [
            { position: 1, name: 'A', name3: 'ALA' },
            { position: 2, name: 'G', name3: 'GLY' },
            { position: 3, name: 'S', name3: 'SER' },
          ],
        },
      ],
    });

    render(
      <MolstarViewer
        structureData={structureData}
        viewerInstanceId="unscoped-sequence-render-model"
        height={240}
        view={singleLayerView('spacefill', 'element')}
        renderModel={renderModel}
      />
    );

    await waitFor(() => expect(screen.getByTestId('unscoped-model-cache')).toBeInTheDocument());
    await waitFor(() => {
      expect(updates).toContainEqual({
        ref: 'broad-polymer-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({
            name: 'spacefill',
            params: expect.not.objectContaining({ alpha: 0 }),
          }),
        }),
      });
    });
    expect(updates).not.toContainEqual({
      ref: 'broad-polymer-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({ params: expect.objectContaining({ alpha: 0 }) }),
      }),
    });
  });

  it('keeps default cartoon postprocessing outline-off when reconciling a cached viewer', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'outline-baseline');
    const cached = seedCachedViewer(cacheKey, 'outline-baseline-molstar-cache');

    render(<MolstarViewer pdbId="1ABC" viewerInstanceId="outline-baseline" height={240} />);

    await waitFor(() => {
      expect(cached.plugin?.canvas3d?.setProps).toHaveBeenCalledWith({
        postprocessing: expect.objectContaining({
          outline: { name: 'off', params: {} },
          occlusion: { name: 'off', params: {} },
        }),
        renderer: { ambientIntensity: 0.4 },
      });
    });
  });

  it('preserves MolStar antialiasing while changing recipe postprocessing', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'preserve-canvas-props');
    const cached = seedCachedViewer(cacheKey, 'preserve-canvas-props-molstar-cache');
    if (cached.plugin?.canvas3d) {
      cached.plugin.canvas3d.props = {
        renderer: { preserveRenderer: true },
        postprocessing: { antialiasing: { name: 'smaa', params: {} } },
      };
    }

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="preserve-canvas-props"
        height={240}
        view={recipeView(createSurfaceRecipe())}
      />
    );

    await waitFor(() => {
      expect(cached.plugin?.canvas3d?.setProps).toHaveBeenCalledWith({
        postprocessing: expect.objectContaining({
          antialiasing: { name: 'smaa', params: {} },
          outline: expect.objectContaining({ name: 'on' }),
          occlusion: expect.objectContaining({ name: 'on' }),
        }),
        renderer: {
          preserveRenderer: true,
          ambientIntensity: 0.5,
        },
      });
    });
  });

  it('restores cartoon to outline-off postprocessing after surface mode', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'surface-to-cartoon-outline');
    const cached = seedCachedViewer(cacheKey, 'surface-to-cartoon-outline-molstar-cache');

    const { rerender } = render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="surface-to-cartoon-outline"
        height={240}
        view={recipeView(createSurfaceRecipe())}
      />
    );

    await waitFor(() => {
      expect(cached.plugin?.canvas3d?.setProps).toHaveBeenCalledWith({
        postprocessing: expect.objectContaining({
          outline: expect.objectContaining({ name: 'on' }),
          occlusion: expect.objectContaining({ name: 'on' }),
        }),
        renderer: { ambientIntensity: 0.5 },
      });
    });
    vi.mocked(cached.plugin?.canvas3d?.setProps).mockClear();

    rerender(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="surface-to-cartoon-outline"
        height={240}
        view={recipeView(createCartoonRecipe())}
      />
    );

    await waitFor(() => {
      expect(cached.plugin?.canvas3d?.setProps).toHaveBeenCalledWith({
        postprocessing: expect.objectContaining({
          outline: { name: 'off', params: {} },
          occlusion: { name: 'off', params: {} },
        }),
        renderer: { ambientIntensity: 0.4 },
      });
    });
  });

  it('drives a cached scoped viewer from Query in Complex cartoon recipe state', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'query-in-complex-recipe');
    const { updates } = seedRepresentationCachedViewer(cacheKey, 'query-in-complex-recipe-cache', [
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="query-in-complex-recipe"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex',
          recipe: createQueryInComplexRecipe(),
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(updates).toContainEqual({
        ref: 'context-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({
            name: 'cartoon',
            params: expect.objectContaining({ sizeFactor: 0.2 }),
          }),
        }),
      });
      expect(updates).toContainEqual({
        ref: 'query-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({ name: 'cartoon' }),
        }),
      });
    });
  });

  it('drives a cached scoped viewer from Surface Context recipe state', async () => {
    const cacheKey = getViewerCacheKey(
      'provider:RCSB:1ABC:ENTRY',
      'query-in-complex-surface-recipe'
    );
    const { updates } = seedRepresentationCachedViewer(
      cacheKey,
      'query-in-complex-surface-recipe-cache',
      [
        makeRepresentationComponent('Structure Context', ['context-cartoon']),
        makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
        makeRepresentationComponent('Ligand', ['ligand-sticks']),
        makeRepresentationComponent('Ion', ['ion-sphere']),
      ]
    );

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="query-in-complex-surface-recipe"
        height={240}
        view={{
          schemaVersion: 1,
          activeRecipeId: 'query-in-complex-surface',
          recipe: createQueryInComplexSurfaceRecipe(),
          showWater: false,
          spin: false,
        }}
      />
    );

    await waitFor(() => {
      expect(updates).toContainEqual({
        ref: 'context-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({
            name: 'cartoon',
            params: expect.objectContaining({ alpha: 0 }),
          }),
          colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
        }),
      });
      expect(updates).toContainEqual({
        ref: 'query-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({ name: 'cartoon' }),
        }),
      });
      expect(updates).toContainEqual({
        ref: 'ligand-sticks',
        payload: expect.objectContaining({
          type: expect.objectContaining({
            name: 'ball-and-stick',
            params: expect.objectContaining({ sizeFactor: 0.2 }),
          }),
          colorTheme: { name: 'element-symbol', params: {} },
        }),
      });
      expect(updates).toContainEqual({
        ref: 'ion-sphere',
        payload: expect.objectContaining({
          type: expect.objectContaining({
            name: 'spacefill',
            params: expect.objectContaining({ sizeFactor: 0.6 }),
          }),
          colorTheme: { name: 'element-symbol', params: {} },
        }),
      });
    });
  });

  it('evicts cached load errors and reports them instead of staying in loading state', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-error');
    const cached = seedCachedViewer(cacheKey, 'errored-molstar-cache');
    cached.plugin = undefined;
    cached.error = 'Structure load timeout after 30000ms';
    const onError = vi.fn();

    render(
      <MolstarViewer pdbId="1ABC" viewerInstanceId="drawer-error" height={240} onError={onError} />
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(userMessage('structure.failed'));
      expect(viewerCache.has(cacheKey)).toBe(false);
      expect(screen.queryByTestId('molstar-react-loading-overlay')).not.toBeInTheDocument();
      expect(screen.getByTestId('molstar-viewer-error')).toHaveTextContent(
        userMessage('structure.failed')
      );
    });
    expect(screen.getByRole('button', { name: 'Retry 3D structure' })).toBeEnabled();
  });

  it('reports errors to viewers that join an already-loading cached viewer', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-loading-error');
    const cached = seedCachedViewer(cacheKey, 'loading-error-molstar-cache');
    cached.plugin = undefined;
    cached.isLoading = true;
    const onError = vi.fn();

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-loading-error"
        height={240}
        onError={onError}
      />
    );

    cached.isLoading = false;
    cached.error = 'Pending Molstar creation failed';

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(userMessage('structure.failed'));
      expect(viewerCache.has(cacheKey)).toBe(false);
    });
  });

  it('reports errors to viewers that join a pending creation after the cache row appears', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-pending-error');
    pendingCreations.add(cacheKey);
    const onError = vi.fn();

    render(
      <MolstarViewer
        pdbId="1ABC"
        viewerInstanceId="drawer-pending-error"
        height={240}
        onError={onError}
      />
    );

    const cached = seedCachedViewer(cacheKey, 'pending-error-molstar-cache');
    cached.plugin = undefined;
    cached.error = 'Joined Molstar creation failed';

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(userMessage('structure.failed'));
      expect(viewerCache.has(cacheKey)).toBe(false);
      expect(pendingCreations.has(cacheKey)).toBe(false);
    });
  });

  it('renders a React-owned loading overlay while a pending creation has no attached MolStar DOM yet', () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-pending-overlay');
    pendingCreations.add(cacheKey);

    render(<MolstarViewer pdbId="1ABC" viewerInstanceId="drawer-pending-overlay" height={240} />);

    expect(screen.getByTestId('molstar-react-loading-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('molstar-react-loading-spinner')).toBeInTheDocument();
    expect(screen.getByTestId('molstar-react-loading-progress')).toBeInTheDocument();
    expect(document.querySelector('.molstar-viewer-container')?.children.length).toBe(0);
  });

  it('attaches the pending loading container as soon as the cache row appears', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'drawer-pending-loading');
    pendingCreations.add(cacheKey);

    render(<MolstarViewer pdbId="1ABC" viewerInstanceId="drawer-pending-loading" height={240} />);

    const cached = seedCachedViewer(cacheKey, 'pending-loading-molstar-cache');
    cached.isLoading = true;

    await waitFor(() => {
      expect(screen.getByTestId('pending-loading-molstar-cache')).toBeInTheDocument();
      expect(document.querySelector('.molstar-viewer-container')).toContainElement(
        screen.getByTestId('cached-container-pending-loading-molstar-cache')
      );
    });
    expect(screen.getByTestId('molstar-react-loading-overlay')).toBeInTheDocument();
  });

  it('reconciles default cartoon props onto a restored cached viewer instead of trusting stale plugin state', async () => {
    const cacheKey = getViewerCacheKey('provider:RCSB:1ABC:ENTRY', 'stale-cartoon-cache');
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);
    const cached = seedCachedViewer(cacheKey, 'stale-cartoon-molstar-cache');
    cached.plugin = {
      ...(plugin as object),
      canvas3d: {
        animate: vi.fn(),
        handleResize: vi.fn(),
        setProps: vi.fn(),
      },
    } as CachedViewer['plugin'];

    render(<MolstarViewer pdbId="1ABC" viewerInstanceId="stale-cartoon-cache" height={240} />);

    await waitFor(() => {
      expect(updates).toContainEqual({
        ref: 'context-cartoon',
        payload: expect.objectContaining({
          type: expect.objectContaining({
            name: 'cartoon',
            params: expect.objectContaining({ sizeFactor: 0.2 }),
          }),
          colorTheme: { name: 'chain-id', params: contextChainPaletteParams() },
        }),
      });
    });
  });

  it('applies recipe role overrides to the active focus component separately from context', async () => {
    const { plugin, updates } = makeRepresentationPlugin([
      makeRepresentationComponent('Structure Context', ['context-cartoon']),
      makeRepresentationComponent('Active Focus', ['focus-cartoon', 'focus-ball-stick']),
      makeRepresentationComponent('Query Polymer', ['query-cartoon', 'query-ball-stick']),
    ]);

    await applyTestVisuals(plugin, 'cartoon', 'chain', false, undefined, {
      polymerRoleOverrides: {
        query: {
          representation: 'surface',
          colorMode: 'chain',
          typeParams: { alpha: 0.13 },
        },
        context: {
          representation: 'surface',
          colorMode: 'chain',
          typeParams: { alpha: 0.12 },
        },
        focus: { representation: 'cartoon', colorMode: 'chain' },
      },
    });

    expect(updates).toContainEqual({
      ref: 'context-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'molecular-surface',
          params: expect.objectContaining({ alpha: 0.12 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'focus-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'cartoon',
          params: expect.objectContaining({ sizeFactor: 0.2 }),
        }),
      }),
    });
    expect(updates).toContainEqual({
      ref: 'query-cartoon',
      payload: expect.objectContaining({
        type: expect.objectContaining({
          name: 'molecular-surface',
          params: expect.objectContaining({ alpha: 0.13 }),
        }),
      }),
    });
  });
});
