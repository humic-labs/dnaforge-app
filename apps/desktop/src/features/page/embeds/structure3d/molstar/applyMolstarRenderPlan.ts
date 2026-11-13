import { applyResidueColorLayer, clearResidueColorLayer } from '../residueColorTheme';
import {
  COLOR_SCALE_PRESETS,
  DEFAULT_ADVANCED_SETTINGS,
  type AdvancedViewerSettings,
  type ResidueColorLayer,
  type Structure3dRepresentation,
} from '../types';
import { fetchAlphaMissenseData } from '../utils/alphaMissenseData';
import { setPluginSpin } from '../viewerCache';
import {
  ILLUSTRATIVE_AMBIENT,
  getIonTypeParams,
  getLigandConfig,
  getWaterTypeParams,
  type LigandConfig,
  type RepresentationConfig,
} from '../molstarConfigs';
import {
  detailChainIdFromComponentLabel,
  detailContextChainIdFromComponentLabel,
  detailMemberIdFromComponentLabel,
  isBroadPolymerComponentLabel,
  STRUCTURE_COMPONENT_LABELS,
} from './componentLabels';
import {
  HIDDEN_BALL_AND_STICK_TYPE_PARAMS,
  getPolymerRepresentationConfigForRole,
  polymerRenderRoleForComponentLabel,
  polymerRepresentationSlotForCell,
  type PolymerRenderRole,
  type PolymerRepresentationSlot,
} from './renderPlan';
import { applySurfaceOverlayRenderPlan, selectSurfaceOverlayCells } from './surfaceOverlay';
import {
  syncActiveFocusPolymerComponents,
  type DetailedPolymerChainTarget,
} from './structureBuilder';
import { requestMolstarFrame } from './viewerFrameKicks';
import {
  molstarRenderPlanApplyKeys,
  type MolstarRenderPlan,
  type MolstarRenderPlanApplyKeys,
} from './molstarRenderPlan';
import type { RenderableStructureRole } from '../utils/viewRecipeRenderPlan';
import type { MolstarPlugin } from './cache';

export type { MolstarRenderPlanApplyKeys } from './molstarRenderPlan';

type ApplyRepresentationsOptions = {
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  componentScope?: 'all' | 'detail';
  applyComponentSync?: boolean;
};

type MolstarHierarchyRepresentation = {
  cell?: {
    obj?: { label?: string; tags?: unknown };
    transform?: { ref?: string; tags?: unknown };
    params?: { values?: Partial<MolstarRepresentationUpdate> };
  };
};

type MolstarHierarchyComponent = {
  cell?: { obj?: { label?: string }; transform?: { ref?: string } };
  representations?: readonly MolstarHierarchyRepresentation[];
};

type MolstarHierarchyStructure = {
  cell?: unknown;
  components?: readonly MolstarHierarchyComponent[];
};

type MolstarRepresentationUpdate = {
  type: { name: string; params: Record<string, unknown> };
  colorTheme?: { name: string; params: Record<string, unknown> };
  sizeTheme?: { name: string; params: Record<string, unknown> };
};

type MolstarRenderPlanBuilder = {
  to: (ref: string) => { update: (update: MolstarRepresentationUpdate) => unknown };
  commit: () => Promise<unknown> | unknown;
};

type MolstarComponentThemeManager = {
  updateRepresentationsTheme: (
    components: readonly MolstarHierarchyComponent[],
    theme: { color: string; colorParams: Record<string, unknown> }
  ) => Promise<unknown> | unknown;
};

type MolstarRenderPlanPlugin = {
  managers?: {
    structure?: {
      hierarchy?: {
        current: {
          structures?: readonly MolstarHierarchyStructure[];
        };
      };
      component?: MolstarComponentThemeManager;
    };
  };
  state?: {
    data?: {
      build?: () => MolstarRenderPlanBuilder | undefined;
    };
  };
};

type VisualsPlanContext = {
  plan: MolstarRenderPlan;
  defaultPolymerConfig: RepresentationConfig;
  ligandConfig: LigandConfig;
  showVisibleBackboneSideChains: boolean;
  detailMemberIds: Set<string> | undefined;
  detailChainTargetsById: Map<string, DetailedPolymerChainTarget>;
  componentScope: 'all' | 'detail';
  surfaceOverlayRefs: Set<string>;
  alphaMissenseData: Map<number, number> | null;
};

type StructureFallbackContext = {
  useScopedDetailContextFallback: boolean;
  useBroadContextFallback: boolean;
};

const MOLSTAR_RENDER_PLAN_APPLY_CANCELLED = 'MolStar render plan apply cancelled';
const ELEMENT_COLOR = 'element-symbol';

class MolstarRenderPlanApplyCancelledError extends Error {
  constructor() {
    super(MOLSTAR_RENDER_PLAN_APPLY_CANCELLED);
    this.name = 'MolstarRenderPlanApplyCancelledError';
  }
}

export function renderPlanApplyKeys(plan: MolstarRenderPlan): MolstarRenderPlanApplyKeys {
  return molstarRenderPlanApplyKeys(plan);
}

export function renderPlanApplySignature(keys: MolstarRenderPlanApplyKeys): string {
  return JSON.stringify({
    representation: keys.representation,
    detailComponents: keys.detailComponents,
    surfaceOverlay: keys.surfaceOverlay,
  });
}

export function didRenderPlanApplyKeyChange(
  previous: MolstarRenderPlanApplyKeys | null,
  current: MolstarRenderPlanApplyKeys,
  key: keyof MolstarRenderPlanApplyKeys
): boolean {
  return !previous || previous[key] !== current[key];
}

export function shouldSkipInitialPostReadyRenderPlanApply(input: {
  wasRestoredFromCache: boolean;
  sceneKind?: MolstarRenderPlan['componentSync']['scene'] extends infer Scene
    ? Scene extends { sceneKind?: infer Kind }
      ? Kind
      : undefined
    : undefined;
  isPreviewRender: boolean;
  hadBeforeRevealReconcile?: boolean;
  renderPlanChangedSinceBeforeReveal?: boolean;
}): boolean {
  if (input.renderPlanChangedSinceBeforeReveal) return false;
  if (input.hadBeforeRevealReconcile) return true;
  if (input.wasRestoredFromCache) return false;
  if (input.sceneKind === 'complex' && !input.isPreviewRender) return false;
  return true;
}

export function isMolstarRenderPlanApplyCancelledError(error: unknown): boolean {
  return (
    error instanceof MolstarRenderPlanApplyCancelledError ||
    (error instanceof Error && error.message === MOLSTAR_RENDER_PLAN_APPLY_CANCELLED)
  );
}

const renderPlanApplyQueues = new WeakMap<MolstarPlugin, Promise<unknown>>();

function enqueueRenderPlanApply(
  plugin: MolstarPlugin,
  apply: () => Promise<string[]>
): Promise<string[]> {
  const previous = renderPlanApplyQueues.get(plugin) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(apply);
  renderPlanApplyQueues.set(
    plugin,
    next.catch(() => undefined)
  );
  return next;
}

export function applyMolstarRenderPlanBeforeReveal(
  ...args: Parameters<typeof applyMolstarRenderPlanBeforeRevealNow>
): Promise<string[]> {
  return enqueueRenderPlanApply(args[0], () => applyMolstarRenderPlanBeforeRevealNow(...args));
}

async function applyMolstarRenderPlanBeforeRevealNow(
  plugin: MolstarPlugin,
  plan: MolstarRenderPlan,
  options: {
    isCurrent: () => boolean;
    signal?: AbortSignal;
    trackedOverlayRefs?: readonly string[];
    forceRepresentationApply?: boolean;
  }
): Promise<string[]> {
  assertRenderPlanApplyCurrent(options.isCurrent);
  const applyOverlay = () =>
    applySurfaceOverlayRenderPlan(plugin, plan.surfaceOverlay, {
      trackedOverlayRefs: options.trackedOverlayRefs,
      isCurrent: options.isCurrent,
      chainColorPalette: plan.color.chainColorPalette,
      detailMemberIds: plan.componentSync.detailMemberIds,
      detailChainTargets: plan.componentSync.detailChainTargets,
    });
  const clearSurfaceBeforeVisuals = !plan.surfaceOverlay.enabled;
  if (clearSurfaceBeforeVisuals) {
    await applyOverlay();
    assertRenderPlanApplyCurrent(options.isCurrent);
  }

  if (options.forceRepresentationApply || needsRepresentationApply(plan)) {
    await applyMolstarVisualsFromPlan(plugin, plan, {
      isCurrent: options.isCurrent,
      signal: options.signal,
    });
  }

  assertRenderPlanApplyCurrent(options.isCurrent);
  const overlayRefs = clearSurfaceBeforeVisuals ? [] : await applyOverlay();

  assertRenderPlanApplyCurrent(options.isCurrent);
  applyCanvasPostprocessingFromPlan(plugin, plan);
  setPluginSpin(plugin, plan.controls.spin);
  requestMolstarFrame(plugin);
  return overlayRefs;
}

export function applyMolstarRenderPlanAfterReady(
  ...args: Parameters<typeof applyMolstarRenderPlanAfterReadyNow>
): Promise<string[]> {
  return enqueueRenderPlanApply(args[0], () => applyMolstarRenderPlanAfterReadyNow(...args));
}

async function applyMolstarRenderPlanAfterReadyNow(
  plugin: MolstarPlugin,
  plan: MolstarRenderPlan,
  options: {
    isCurrent: () => boolean;
    isSurfaceCurrent?: () => boolean;
    signal?: AbortSignal;
    trackedOverlayRefs?: readonly string[];
    applyVisuals: boolean;
    applyDetailComponents: boolean;
    applySurfaceOverlay: boolean;
  }
): Promise<string[]> {
  assertRenderPlanApplyCurrent(options.isCurrent);
  const applyOverlay = () =>
    applySurfaceOverlayRenderPlan(plugin, plan.surfaceOverlay, {
      trackedOverlayRefs: options.trackedOverlayRefs,
      isCurrent: options.isSurfaceCurrent ?? options.isCurrent,
      chainColorPalette: plan.color.chainColorPalette,
      detailMemberIds: plan.componentSync.detailMemberIds,
      detailChainTargets: plan.componentSync.detailChainTargets,
      preserveExisting: false,
    });
  const clearSurfaceBeforeVisuals = options.applySurfaceOverlay && !plan.surfaceOverlay.enabled;
  if (clearSurfaceBeforeVisuals) {
    await applyOverlay();
    assertRenderPlanApplyCurrent(options.isCurrent);
  }

  if (options.applyVisuals) {
    await applyMolstarVisualsFromPlan(plugin, plan, {
      isCurrent: options.isCurrent,
      signal: options.signal,
      applyComponentSync: options.applyDetailComponents,
    });
  } else if (options.applyDetailComponents) {
    await applyMolstarVisualsFromPlan(plugin, plan, {
      isCurrent: options.isCurrent,
      signal: options.signal,
      applyComponentSync: true,
    });
  }

  assertRenderPlanApplyCurrent(options.isCurrent);
  const overlayRefs = clearSurfaceBeforeVisuals
    ? []
    : options.applySurfaceOverlay
      ? await applyOverlay()
      : [...(options.trackedOverlayRefs ?? [])];

  assertRenderPlanApplyCurrent(options.isCurrent);
  applyCanvasPostprocessingFromPlan(plugin, plan);
  setPluginSpin(plugin, plan.controls.spin);
  requestMolstarFrame(plugin);
  return overlayRefs;
}

export async function applyMolstarVisualsFromPlan(
  plugin: MolstarPlugin,
  plan: MolstarRenderPlan,
  options: ApplyRepresentationsOptions = {}
): Promise<void> {
  if (!plugin?.managers?.structure?.hierarchy) return;
  const isCurrent = options.isCurrent || (() => true);

  try {
    if (!isCurrent()) return;
    if (options.applyComponentSync !== false && !plan.componentSync.skipActiveFocusSync) {
      await syncActiveFocusPolymerComponents(
        plugin,
        plan.componentSync.scene,
        isCurrent,
        plan.componentSync.detailMemberIds,
        plan.componentSync.detailChainTargets
      );
      if (!isCurrent()) return;
    }

    const renderPlugin = molstarRenderPlanPlugin(plugin);
    const structures = renderPlugin.managers?.structure?.hierarchy?.current.structures;
    if (!structures || structures.length === 0) return;

    const colorMode = plan.defaults.colorMode;
    let alphaMissenseData: Map<number, number> | null = null;
    if (colorMode === 'alphamissense' && plan.defaults.uniprotId) {
      alphaMissenseData = await fetchAlphaMissenseData(plan.defaults.uniprotId, {
        signal: options.signal,
      });
      if (!isCurrent()) return;
    }

    const context: VisualsPlanContext = {
      plan,
      defaultPolymerConfig: polymerConfigForRole('unscoped', plan),
      ligandConfig: getLigandConfig(plan.defaults.representation),
      showVisibleBackboneSideChains: plan.controls.sideChains?.visibleBackbones === true,
      detailMemberIds: plan.componentSync.detailMemberIds
        ? new Set(plan.componentSync.detailMemberIds)
        : undefined,
      detailChainTargetsById: new Map(
        (plan.componentSync.detailChainTargets ?? []).map(
          (target) => [target.targetId, target] as const
        )
      ),
      componentScope: options.componentScope ?? 'all',
      surfaceOverlayRefs: new Set(
        selectSurfaceOverlayCells(plugin)
          .map((overlay) => overlay.transform?.ref)
          .filter((ref): ref is string => !!ref)
      ),
      alphaMissenseData,
    };

    for (const structure of structures) {
      if (!isCurrent()) return;
      if (!structure.cell) continue;
      await applyStructureVisualsFromPlan(renderPlugin, structure, context, isCurrent);
    }
  } catch (error) {
    if (isMolstarRenderPlanApplyCancelledError(error)) throw error;
    console.warn('[MolstarViewer] Failed to apply MolStar render plan representations:', error);
    throw error;
  }
}

function molstarRenderPlanPlugin(plugin: MolstarPlugin): MolstarRenderPlanPlugin {
  const hierarchy = plugin.managers?.structure?.hierarchy;
  const component = plugin.managers?.structure?.component;
  return {
    managers: {
      structure: {
        hierarchy: hierarchy
          ? {
              get current() {
                return hierarchy.current;
              },
            }
          : undefined,
        component: component
          ? {
              updateRepresentationsTheme: (components, theme) =>
                Reflect.apply(component.updateRepresentationsTheme, component, [components, theme]),
            }
          : undefined,
      },
    },
    state: {
      data: {
        build: () => {
          const builder = plugin.state?.data?.build?.();
          return builder ? wrapRenderPlanBuilder(builder) : undefined;
        },
      },
    },
  };
}

function wrapRenderPlanBuilder(
  builder: ReturnType<MolstarPlugin['state']['data']['build']>
): MolstarRenderPlanBuilder {
  return {
    to: (ref: string) => {
      const node = builder.to(ref);
      return {
        update: (params: MolstarRepresentationUpdate) =>
          (node.update as (params: MolstarRepresentationUpdate) => unknown).call(node, {
            ...params,
            type: {
              ...params.type,

              params: {
                ...params.type.params,
                ignoreHydrogens: true,
                ignoreHydrogensVariant: 'all',
              },
            },
          }),
      };
    },
    commit: () => builder.commit(),
  };
}

async function applyStructureVisualsFromPlan(
  plugin: MolstarRenderPlanPlugin,
  structure: MolstarHierarchyStructure,
  context: VisualsPlanContext,
  isCurrent: () => boolean
): Promise<void> {
  const components = structure.components || [];
  const fallback = detailContextFallback(components, context.plan);
  const builder = plugin.state?.data?.build?.();
  if (!builder) return;

  let hasChanges = false;
  for (const component of components) {
    if (applyComponentRepresentationUpdates(builder, component, context, fallback)) {
      hasChanges = true;
    }
  }

  if (hasChanges) {
    if (!isCurrent()) return;
    await builder.commit();
    if (!isCurrent()) return;
  }

  if (context.componentScope === 'detail') return;
  await applyPolymerThemeAndResidueColor(plugin, components, context, isCurrent);
}

function detailContextFallback(
  components: readonly MolstarHierarchyComponent[],
  plan: MolstarRenderPlan
): StructureFallbackContext {
  const hasScopedDetailContextFallback = components.some(
    (component) =>
      component.cell?.obj?.label === STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer
  );
  const existingDetailContextChainTargetIds = new Set(
    components
      .map((component) => detailContextChainIdFromComponentLabel(component.cell?.obj?.label ?? ''))
      .filter((targetId): targetId is string => targetId !== null)
  );
  const hasMissingDetailContextChainTarget = (plan.componentSync.detailChainTargets ?? []).some(
    (target) => !target.visible && !existingDetailContextChainTargetIds.has(target.targetId)
  );
  const useScopedDetailContextFallback =
    hasScopedDetailContextFallback && hasMissingDetailContextChainTarget;
  return {
    useScopedDetailContextFallback,
    useBroadContextFallback: !useScopedDetailContextFallback && hasMissingDetailContextChainTarget,
  };
}

function applyComponentRepresentationUpdates(
  builder: MolstarRenderPlanBuilder,
  component: MolstarHierarchyComponent,
  context: VisualsPlanContext,
  fallback: StructureFallbackContext
): boolean {
  const label = component.cell?.obj?.label || '';
  const representations = component.representations || [];
  const managedRepresentations = representations.filter((repr) => {
    const ref = repr.cell?.transform?.ref;
    return !ref || !context.surfaceOverlayRefs.has(ref);
  });

  let hasChanges = false;
  for (const [reprIndex, repr] of managedRepresentations.entries()) {
    if (!repr.cell?.transform?.ref) continue;
    if (applyManagedRepresentationUpdate(builder, repr, reprIndex, label, context, fallback)) {
      hasChanges = true;
    }
  }
  return hasChanges;
}

function applyManagedRepresentationUpdate(
  builder: MolstarRenderPlanBuilder,
  repr: MolstarHierarchyRepresentation,
  reprIndex: number,
  label: string,
  context: VisualsPlanContext,
  fallback: StructureFallbackContext
): boolean {
  const reprRef = repr.cell?.transform?.ref;
  if (!reprRef) return false;

  const plan = context.plan;
  const representation = plan.defaults.representation;
  const polymerRole = polymerRenderRoleForComponentLabel(label);
  const nonPolymerRole = nonPolymerRenderRoleForComponentLabel(label);
  const renderRole = polymerRole ?? nonPolymerRole;
  const polymerSlot = polymerRole
    ? polymerRepresentationSlotForCell(polymerRole, repr, reprIndex)
    : null;
  const roleRepresentation = polymerRole
    ? (plan.rolePlan.polymerOverrides[polymerRole]?.representation ?? representation)
    : representation;
  const polymerConfig = polymerRole
    ? polymerConfigForRole(polymerRole, plan)
    : context.defaultPolymerConfig;
  const detailMemberId = detailMemberIdFromComponentLabel(label);
  const detailChainId = detailChainIdFromComponentLabel(label);
  const detailContextChainId = detailContextChainIdFromComponentLabel(label);
  const isDetailScopedComponent =
    label === STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer ||
    detailMemberId !== null ||
    detailChainId !== null ||
    detailContextChainId !== null;
  if (context.componentScope === 'detail' && !isDetailScopedComponent) return false;

  const detailChainTarget = detailChainId
    ? context.detailChainTargetsById.get(detailChainId)
    : undefined;
  const detailContextChainTarget = detailContextChainId
    ? context.detailChainTargetsById.get(detailContextChainId)
    : undefined;
  const chainTargetRenderRole: PolymerRenderRole | null = detailChainTarget
    ? detailChainTarget.visible
      ? 'query'
      : null
    : detailContextChainTarget
      ? 'context'
      : null;
  const effectivePolymerRole = chainTargetRenderRole ?? polymerRole;
  const effectiveRoleRepresentation = effectivePolymerRole
    ? (plan.rolePlan.polymerOverrides[effectivePolymerRole]?.representation ?? representation)
    : roleRepresentation;
  const effectivePolymerConfig = effectivePolymerRole
    ? polymerConfigForRole(effectivePolymerRole, plan)
    : polymerConfig;
  const effectiveRoleColorMode = effectivePolymerRole
    ? (plan.rolePlan.polymerOverrides[effectivePolymerRole]?.colorMode ?? plan.defaults.colorMode)
    : plan.defaults.colorMode;
  const enforcedChainColor =
    effectiveRoleColorMode === 'chain' &&
    detailChainTarget?.visible &&
    detailChainTarget.color !== undefined
      ? detailChainTarget.color
      : undefined;
  const baseRoleIsVisible = effectivePolymerRole
    ? plan.rolePlan.visibility[effectivePolymerRole] !== false
    : renderRole
      ? plan.rolePlan.visibility[renderRole] !== false
      : true;
  const roleIsVisible = resolveRoleVisibility({
    label,
    baseRoleIsVisible,
    detailChainTarget,
    detailContextChainTarget,
    detailChainId,
    detailContextChainId,
    detailMemberId,
    detailMemberIds: context.detailMemberIds,
    detailChainTargetsById: context.detailChainTargetsById,
    useScopedDetailContextFallback: fallback.useScopedDetailContextFallback,
    useBroadContextFallback: fallback.useBroadContextFallback,
  });

  if (!roleIsVisible) {
    const currentParams = repr.cell?.params?.values;
    const currentType = currentParams?.type;
    if (polymerRole && currentType?.name) {
      builder.to(reprRef).update({
        ...currentParams,
        type: { name: currentType.name, params: { ...currentType.params, alpha: 0 } },
      });
      return true;
    }
    updateHiddenRoleRepresentation(builder, reprRef, {
      polymerRole,
      polymerSlot,
      nonPolymerRole,
      polymerConfig: effectivePolymerConfig,
      ligandConfig: context.ligandConfig,
      representation,
    });
    return true;
  }

  if (
    effectivePolymerRole === 'query' ||
    effectivePolymerRole === 'focus' ||
    effectivePolymerRole === 'unscoped' ||
    effectivePolymerRole === 'context'
  ) {
    return updateVisiblePolymerRepresentation(builder, reprRef, {
      polymerRole: effectivePolymerRole,
      polymerSlot,
      roleRepresentation: effectiveRoleRepresentation,
      polymerConfig: effectivePolymerConfig,
      enforcedChainColor,
      showVisibleBackboneSideChains: context.showVisibleBackboneSideChains,
    });
  }

  return updateNonPolymerRepresentation(builder, reprRef, {
    label,
    ligandConfig: context.ligandConfig,
    representation,
    showWater: plan.controls.showWater,
  });
}

function resolveRoleVisibility(input: {
  label: string;
  baseRoleIsVisible: boolean;
  detailChainTarget: DetailedPolymerChainTarget | undefined;
  detailContextChainTarget: DetailedPolymerChainTarget | undefined;
  detailChainId: string | null;
  detailContextChainId: string | null;
  detailMemberId: string | null;
  detailMemberIds: Set<string> | undefined;
  detailChainTargetsById: Map<string, DetailedPolymerChainTarget>;
  useScopedDetailContextFallback: boolean;
  useBroadContextFallback: boolean;
}): boolean {
  let roleIsVisible = input.baseRoleIsVisible;
  if (input.detailChainTargetsById.size > 0) {
    if (input.detailChainTarget) {
      roleIsVisible = input.baseRoleIsVisible && input.detailChainTarget.visible;
    } else if (input.detailContextChainTarget) {
      roleIsVisible =
        !input.useScopedDetailContextFallback &&
        !input.useBroadContextFallback &&
        input.baseRoleIsVisible &&
        !input.detailContextChainTarget.visible;
    } else if (input.label === STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer) {
      roleIsVisible = input.useScopedDetailContextFallback && input.baseRoleIsVisible;
    } else if (input.label === STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer) {
      roleIsVisible = input.useBroadContextFallback && input.baseRoleIsVisible;
    } else if (
      input.detailChainId ||
      input.detailContextChainId ||
      input.detailMemberId ||
      isBroadPolymerComponentLabel(input.label)
    ) {
      roleIsVisible = false;
    }
  } else if (input.detailMemberIds) {
    if (input.detailMemberId) {
      roleIsVisible = input.detailMemberIds.has(input.detailMemberId);
    } else if (isBroadPolymerComponentLabel(input.label)) {
      roleIsVisible = false;
    }
  }
  return roleIsVisible;
}

function updateHiddenRoleRepresentation(
  builder: MolstarRenderPlanBuilder,
  reprRef: string,
  input: {
    polymerRole: PolymerRenderRole | null;
    polymerSlot: PolymerRepresentationSlot | null;
    nonPolymerRole: RenderableStructureRole | null;
    polymerConfig: RepresentationConfig;
    ligandConfig: LigandConfig;
    representation: Structure3dRepresentation;
  }
): void {
  if (input.polymerRole) {
    if (input.polymerSlot === 'detail') {
      builder.to(reprRef).update(hiddenBallAndStickUpdate());
    } else {
      builder.to(reprRef).update({
        type: {
          name: input.polymerConfig.type,
          params: { ...input.polymerConfig.typeParams, alpha: 0 },
        },
        colorTheme: {
          name: input.polymerConfig.colorTheme,
          params: input.polymerConfig.colorParams,
        },
        sizeTheme: { name: input.polymerConfig.sizeTheme, params: {} },
      });
    }
    return;
  }

  if (input.nonPolymerRole === 'ligand') {
    builder.to(reprRef).update({
      type: {
        name: input.ligandConfig.type,
        params: { ...input.ligandConfig.typeParams, alpha: 0 },
      },
      colorTheme: { name: ELEMENT_COLOR, params: {} },
      sizeTheme: { name: 'physical', params: {} },
    });
    return;
  }

  if (input.nonPolymerRole === 'ion') {
    builder.to(reprRef).update({
      type: {
        name: 'spacefill',
        params: { ...getIonTypeParams(input.representation), alpha: 0 },
      },
      colorTheme: { name: ELEMENT_COLOR, params: {} },
      sizeTheme: { name: 'physical', params: {} },
    });
    return;
  }

  if (input.nonPolymerRole === 'water') {
    builder.to(reprRef).update({
      type: { name: 'spacefill', params: getWaterTypeParams(input.representation, false) },
      colorTheme: { name: 'uniform', params: { value: 0x888888 } },
      sizeTheme: { name: 'physical', params: {} },
    });
  }
}

function updateVisiblePolymerRepresentation(
  builder: MolstarRenderPlanBuilder,
  reprRef: string,
  input: {
    polymerRole: PolymerRenderRole;
    polymerSlot: PolymerRepresentationSlot | null;
    roleRepresentation: Structure3dRepresentation;
    polymerConfig: RepresentationConfig;
    enforcedChainColor: number | undefined;
    showVisibleBackboneSideChains: boolean;
  }
): boolean {
  if (input.polymerRole === 'context') {
    if (input.polymerSlot === 'detail') {
      builder.to(reprRef).update(hiddenBallAndStickUpdate());
      return true;
    }
    if (input.polymerSlot !== 'primary') return false;
    builder.to(reprRef).update({
      type: {
        name: input.polymerConfig.type,
        params: input.polymerConfig.typeParams,
      },
      colorTheme: {
        name: input.polymerConfig.colorTheme,
        params: input.polymerConfig.colorParams,
      },
      sizeTheme: { name: input.polymerConfig.sizeTheme, params: {} },
    });
    return true;
  }

  if (input.roleRepresentation === 'ball-and-stick') {
    if (input.polymerSlot === 'primary') {
      builder.to(reprRef).update({
        type: {
          name: 'cartoon',
          params: {
            quality: 'auto',
            sizeFactor: 0.15,

            dnaforgeNucleotideExclude: ['all'],
          },
        },
        colorTheme: polymerColorTheme(input.polymerConfig, input.enforcedChainColor),
        sizeTheme: { name: 'uniform', params: {} },
      });
      return true;
    }
    if (input.polymerSlot === 'detail') {
      builder.to(reprRef).update({
        type: {
          name: 'ball-and-stick',
          params: {
            quality: 'auto',
            sizeFactor: 0.12,
            sizeAspectRatio: 2 / 3,
            alpha: 1,
          },
        },
        colorTheme: polymerColorTheme(input.polymerConfig, input.enforcedChainColor),
        sizeTheme: { name: 'physical', params: {} },
      });
      return true;
    }
    return false;
  }

  if (input.polymerSlot === 'primary') {
    builder.to(reprRef).update({
      type: {
        name: input.polymerConfig.type,
        params: {
          ...input.polymerConfig.typeParams,
          dnaforgeNucleotideExclude: input.showVisibleBackboneSideChains ? ['all'] : [],
        },
      },
      colorTheme: polymerColorTheme(input.polymerConfig, input.enforcedChainColor),
      sizeTheme: { name: input.polymerConfig.sizeTheme, params: {} },
    });
    return true;
  }

  if (input.polymerSlot === 'detail') {
    builder.to(reprRef).update({
      type: {
        name: 'ball-and-stick',
        params: input.showVisibleBackboneSideChains
          ? {
              quality: 'auto',
              sizeFactor: 0.12,
              sizeAspectRatio: 2 / 3,
              alpha: 1,
            }
          : { quality: 'auto', ...HIDDEN_BALL_AND_STICK_TYPE_PARAMS },
      },
      colorTheme: { name: ELEMENT_COLOR, params: {} },
      sizeTheme: { name: 'physical', params: {} },
    });
    return true;
  }

  return false;
}

function updateNonPolymerRepresentation(
  builder: MolstarRenderPlanBuilder,
  reprRef: string,
  input: {
    label: string;
    ligandConfig: LigandConfig;
    representation: Structure3dRepresentation;
    showWater: boolean;
  }
): boolean {
  if (input.label === 'Ligand') {
    builder.to(reprRef).update({
      type: { name: input.ligandConfig.type, params: input.ligandConfig.typeParams },
      colorTheme: { name: ELEMENT_COLOR, params: {} },
      sizeTheme: { name: 'physical', params: {} },
    });
    return true;
  }
  if (input.label === 'Ion') {
    builder.to(reprRef).update({
      type: { name: 'spacefill', params: getIonTypeParams(input.representation) },
      colorTheme: { name: ELEMENT_COLOR, params: {} },
      sizeTheme: { name: 'physical', params: {} },
    });
    return true;
  }
  if (input.label === 'Water') {
    builder.to(reprRef).update({
      type: {
        name: 'spacefill',
        params: getWaterTypeParams(input.representation, input.showWater),
      },
      colorTheme: { name: 'uniform', params: { value: 0x888888 } },
      sizeTheme: { name: 'physical', params: {} },
    });
    return true;
  }
  return false;
}

function hiddenBallAndStickUpdate(): MolstarRepresentationUpdate {
  return {
    type: {
      name: 'ball-and-stick',
      params: { quality: 'auto', ...HIDDEN_BALL_AND_STICK_TYPE_PARAMS },
    },
    colorTheme: { name: ELEMENT_COLOR, params: {} },
    sizeTheme: { name: 'physical', params: {} },
  };
}

async function applyPolymerThemeAndResidueColor(
  plugin: MolstarRenderPlanPlugin,
  components: readonly MolstarHierarchyComponent[],
  context: VisualsPlanContext,
  isCurrent: () => boolean
): Promise<void> {
  const polymerComponents = components.filter(
    (component) => component.cell?.obj?.label === STRUCTURE_COMPONENT_LABELS.polymer
  );
  if (polymerComponents.length > 0) {
    if (!isCurrent()) return;
    const themeManager = plugin.managers?.structure?.component;
    if (themeManager) {
      await themeManager.updateRepresentationsTheme(polymerComponents, {
        color: context.defaultPolymerConfig.colorTheme,
        colorParams: context.defaultPolymerConfig.colorParams,
      });
    }
    if (!isCurrent()) return;
  }

  const colorMode = context.plan.defaults.colorMode;
  const alphaMissenseData = context.alphaMissenseData;
  if (colorMode === 'alphamissense' && alphaMissenseData && alphaMissenseData.size > 0) {
    if (!isCurrent()) return;
    const values: Record<number, number> = {};
    for (const [pos, score] of alphaMissenseData) {
      values[pos] = score;
    }

    const sourceId = context.plan.defaults.uniprotId;
    const layer: ResidueColorLayer = {
      id: `alphamissense-${sourceId}`,
      label: 'AlphaMissense Pathogenicity',
      sourceType: 'alphamissense',
      sourceId,
      values,
      domain: [0, 1],
      colorScale: COLOR_SCALE_PRESETS.alphamissense,
      metadata: {
        fetchedAt: Date.now(),
        description: 'AlphaMissense pathogenicity predictions',
        citation: 'Cheng et al. Science 2023',
      },
    };

    const success = await applyResidueColorLayer(plugin, layer);
    if (!isCurrent()) return;
    if (!success) {
      console.warn('[MolstarViewer] Failed to apply AlphaMissense coloring');
    }
  } else if (colorMode !== 'alphamissense') {
    if (!isCurrent()) return;
    await clearResidueColorLayer(plugin);
    if (!isCurrent()) return;
  } else if (colorMode === 'alphamissense' && !alphaMissenseData) {
    console.warn('[MolstarViewer] AlphaMissense data not available for this UniProt ID');
  }
}

function assertRenderPlanApplyCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new MolstarRenderPlanApplyCancelledError();
}

function needsRepresentationApply(plan: MolstarRenderPlan): boolean {
  return (
    plan.defaults.representation !== 'cartoon' ||
    plan.defaults.colorMode !== 'chain' ||
    plan.controls.showWater ||
    Object.keys(plan.rolePlan.polymerOverrides).length > 0 ||
    Object.keys(plan.rolePlan.visibility).length > 0 ||
    plan.controls.sideChains?.visibleBackbones === true ||
    plan.componentSync.detailMemberIds !== undefined ||
    !!plan.componentSync.detailChainTargets?.length ||
    !!plan.color.chainColorPalette?.length
  );
}

function polymerConfigForRole(
  role: PolymerRenderRole,
  plan: MolstarRenderPlan
): RepresentationConfig {
  const override = plan.rolePlan.polymerOverrides[role];
  const config = getPolymerRepresentationConfigForRole(
    role,
    override?.representation ?? plan.defaults.representation,
    override?.colorMode ?? plan.defaults.colorMode,
    plan.color.chainColorPalette
  );

  return override?.typeParams
    ? { ...config, typeParams: { ...config.typeParams, ...override.typeParams } }
    : config;
}

function chainUniformColorTheme(color: number): {
  name: 'uniform';
  params: Record<string, unknown>;
} {
  return {
    name: 'uniform',
    params: {
      value: color,
      saturation: 0,
      lightness: 0,
    },
  };
}

function polymerColorTheme(
  config: RepresentationConfig,
  enforcedChainColor: number | undefined
): {
  name: string;
  params: Record<string, unknown>;
} {
  if (enforcedChainColor !== undefined) return chainUniformColorTheme(enforcedChainColor);
  return {
    name: config.colorTheme,
    params: config.colorParams,
  };
}

function nonPolymerRenderRoleForComponentLabel(label: string): RenderableStructureRole | null {
  if (label === 'Ligand') return 'ligand';
  if (label === 'Ion') return 'ion';
  if (label === 'Water') return 'water';
  return null;
}

function applyCanvasPostprocessingFromPlan(plugin: unknown, plan: MolstarRenderPlan): void {
  const canvas = (plugin as { canvas3d?: { props?: unknown; setProps?: (props: unknown) => void } })
    ?.canvas3d;
  if (!canvas?.setProps) return;

  const representationDefaults: Partial<AdvancedViewerSettings> =
    plan.defaults.representation === 'surface'
      ? {
          aoEnabled: true,
          aoBias: 0.6,
          outlineEnabled: true,
          outlineThreshold: 0.4,
          ambientIntensity: 0.5,
        }
      : plan.defaults.representation === 'illustrative'
        ? {
            aoEnabled: true,
            aoBias: 0.8,
            outlineEnabled: true,
            ambientIntensity: ILLUSTRATIVE_AMBIENT,
          }
        : {};
  const advancedSettings = plan.canvas.advancedSettings;
  const settings: AdvancedViewerSettings = {
    ...DEFAULT_ADVANCED_SETTINGS,
    ...representationDefaults,
    ...advancedSettings,
  };

  const aoEnabled = advancedSettings?.aoEnabled ?? (plan.canvas.aoEnabled || settings.aoEnabled);
  const outlineEnabled =
    advancedSettings?.outlineEnabled ?? (plan.canvas.outlineEnabled || settings.outlineEnabled);

  const postprocessing: Record<string, unknown> = {
    shadow: { name: 'off', params: {} },
    outline: outlineEnabled
      ? {
          name: 'on',
          params: {
            scale: settings.outlineScale,
            threshold: settings.outlineThreshold,
            color: settings.outlineColor,
            includeTransparent: true,
          },
        }
      : { name: 'off', params: {} },
    occlusion: aoEnabled
      ? {
          name: 'on',
          params: {
            samples: 32,
            multiScale: { name: 'off', params: {} },
            radius: settings.aoRadius,
            bias: settings.aoBias,
            blurKernelSize: 15,
            blurDepthBias: 0.5,
            resolutionScale: 1,
            color: 0x000000,
            transparentThreshold: 0.4,
          },
        }
      : { name: 'off', params: {} },
  };

  const currentCanvasProps =
    canvas.props && typeof canvas.props === 'object'
      ? (canvas.props as Record<string, unknown>)
      : {};
  const currentPostprocessing =
    currentCanvasProps.postprocessing && typeof currentCanvasProps.postprocessing === 'object'
      ? (currentCanvasProps.postprocessing as Record<string, unknown>)
      : {};
  const currentRenderer =
    currentCanvasProps.renderer && typeof currentCanvasProps.renderer === 'object'
      ? (currentCanvasProps.renderer as Record<string, unknown>)
      : {};

  canvas.setProps({
    postprocessing: {
      ...currentPostprocessing,
      ...postprocessing,
    },
    renderer: {
      ...currentRenderer,
      ambientIntensity: settings.ambientIntensity,
    },
  });
}
