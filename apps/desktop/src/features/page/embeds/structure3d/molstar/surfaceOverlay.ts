import {
  chainIdPaletteParams,
  contextChainPaletteParams,
  getMolstarColorThemeSpec,
} from '../molstarConfigs';
import type { ColorPrimitive, Structure3dColorMode } from '../types';
import {
  detailChainIdFromComponentLabel,
  detailContextChainIdFromComponentLabel,
  detailMemberIdFromComponentLabel,
  isContextPolymerComponentLabel,
  isFocusPolymerComponentLabel,
  isQueryPolymerComponentLabel,
  STRUCTURE_COMPONENT_LABELS,
} from './componentLabels';
import type { DetailedPolymerChainTarget } from './structureBuilder';
import type { MolstarPlugin } from './cache';

export const SURFACE_OVERLAY_TAG = 'surface-overlay';

export type SurfaceOverlayComponentLike = {
  cell?: {
    obj?: { label?: string; data?: unknown };
    transform?: { ref?: string };
    parent?: { obj?: { data?: unknown } };
  };
};

type SurfaceOverlayCellLike = {
  transform?: { ref?: string };
  obj?: { data?: { repr?: { setState?: (state: { markerActions: number }) => void } } };
};

type SurfaceOverlayQuery = {
  root: {
    subtree: () => {
      withTag: (tag: string) => unknown;
    };
  };
};

type SurfaceOverlayRemovalOptions = {
  includeTagged?: boolean;
  excludeRefs?: readonly string[];
};

type SurfaceOverlayColorSpec = {
  color: string;
  colorParams: Record<string, unknown>;
};

type SurfaceOverlayBuildTarget = {
  label: string;
  componentRef: string;
  structureData: unknown;
  componentData: unknown;
};

type SurfaceOverlayDiagnosticEvent = {
  event: string;
  surfaceOverlayEnabled?: boolean;
  preserveExisting?: boolean;
  trackedOverlayRefs?: readonly string[];
  existingRefs?: readonly string[];
  targetCount?: number;
  targetLabels?: readonly string[];
  overlayRefs?: readonly string[];
  deletedRefs?: readonly string[];
};

function recordSurfaceOverlayDiagnostic(event: SurfaceOverlayDiagnosticEvent): void {
  const globalWithDiagnostics = globalThis as {
    __WAYPOINT_MOLSTAR_SURFACE_OVERLAY_LOG__?: SurfaceOverlayDiagnosticEvent[];
  };
  const existing = globalWithDiagnostics.__WAYPOINT_MOLSTAR_SURFACE_OVERLAY_LOG__;
  const log = Array.isArray(existing) ? existing : [];
  log.push(event);
  if (log.length > 250) log.splice(0, log.length - 250);
  globalWithDiagnostics.__WAYPOINT_MOLSTAR_SURFACE_OVERLAY_LOG__ = log;
}

const surfaceOverlayApplyQueues = new WeakMap<object, Promise<unknown>>();
const retainedSurfaceOverlays = new WeakMap<
  MolstarPlugin,
  { signature: string; structureData: unknown[]; componentData: unknown[]; refs: string[] }
>();

async function setSurfaceOverlayAlpha(
  plugin: MolstarPlugin,
  refs: readonly string[],
  alpha: number
): Promise<void> {
  const builder = plugin.state.data.build();
  for (const ref of refs) {
    builder.to(ref).update((params) => ({
      ...params,
      type: { ...params.type, params: { ...params.type.params, alpha } },
    }));
  }
  await builder.commit();
}

function surfaceOverlayQueueKey(plugin: unknown): object | null {
  return typeof plugin === 'object' && plugin !== null ? plugin : null;
}

export type SurfaceOverlayRepresentationApi = {
  createStructureRepresentationParams: (
    plugin: unknown,
    structureData: unknown,
    params: Record<string, unknown>
  ) => unknown;
  StateTransforms: {
    Representation: {
      StructureRepresentation3D: unknown;
    };
  };
};

export type SurfaceOverlayRenderPlan = {
  enabled: boolean;
  typeParams?: Record<string, unknown>;
  colorMode?: ColorPrimitive['mode'];
  targetScope: 'broad' | 'detail-aware';
};

export type SurfaceOverlayApplyOptions = {
  trackedOverlayRefs?: readonly string[];
  isCurrent?: () => boolean;
  loadRepresentationApi?: () => Promise<SurfaceOverlayRepresentationApi>;
  chainColorPalette?: readonly number[];
  detailMemberIds?: readonly string[];
  detailChainTargets?: readonly DetailedPolymerChainTarget[];
  preserveExisting?: boolean;
};

type ResolvedSurfaceOverlayApplyOptions = SurfaceOverlayApplyOptions &
  Required<Pick<SurfaceOverlayRenderPlan, 'targetScope'>> &
  Pick<SurfaceOverlayRenderPlan, 'typeParams' | 'colorMode'>;

export function selectSurfaceOverlayTargetComponents<T extends SurfaceOverlayComponentLike>(
  components: readonly T[]
): T[] {
  return components.filter((component) => {
    const label = component.cell?.obj?.label || '';
    return (
      isQueryPolymerComponentLabel(label) ||
      isFocusPolymerComponentLabel(label) ||
      isContextPolymerComponentLabel(label)
    );
  });
}

const STRUCTURE_COLOR_MODES = new Set<Structure3dColorMode>([
  'chain',
  'element',
  'plddt',
  'bfactor',
  'alphamissense',
]);

function isStructureColorMode(mode: ColorPrimitive['mode']): mode is Structure3dColorMode {
  return STRUCTURE_COLOR_MODES.has(mode as Structure3dColorMode);
}

function surfaceOverlayColorSpecForComponentLabel(
  label: string,
  colorMode?: ColorPrimitive['mode'],
  chainColorPalette?: readonly number[]
): SurfaceOverlayColorSpec {
  if (isContextPolymerComponentLabel(label)) {
    return { color: 'chain-id', colorParams: contextChainPaletteParams() };
  }

  if (colorMode === 'context-muted') {
    return { color: 'chain-id', colorParams: contextChainPaletteParams() };
  }

  if (
    colorMode &&
    isStructureColorMode(colorMode) &&
    colorMode !== 'chain' &&
    colorMode !== 'alphamissense'
  ) {
    const colorSpec = getMolstarColorThemeSpec(colorMode, false, chainColorPalette);
    return { color: colorSpec.colorTheme, colorParams: colorSpec.colorParams };
  }

  return {
    color: 'chain-id',
    colorParams: chainIdPaletteParams(chainColorPalette),
  };
}

async function loadSurfaceOverlayRepresentationApi(): Promise<SurfaceOverlayRepresentationApi> {
  const [{ createStructureRepresentationParams }, { StateTransforms }] = await Promise.all([
    import('molstar/lib/mol-plugin-state/helpers/structure-representation-params'),
    import('molstar/lib/mol-plugin-state/transforms'),
  ]);

  return {
    createStructureRepresentationParams:
      createStructureRepresentationParams as unknown as SurfaceOverlayRepresentationApi['createStructureRepresentationParams'],
    StateTransforms:
      StateTransforms as unknown as SurfaceOverlayRepresentationApi['StateTransforms'],
  };
}

export function selectSurfaceOverlayCells(plugin: MolstarPlugin | null): SurfaceOverlayCellLike[] {
  try {
    if (!plugin) return [];
    return (
      plugin.state.data.selectQ?.(((q: SurfaceOverlayQuery) =>
        q.root.subtree().withTag(SURFACE_OVERLAY_TAG)) as never) || []
    );
  } catch {
    return [];
  }
}

async function removeSurfaceOverlayRepresentations(
  plugin: MolstarPlugin | null,
  trackedOverlayRefs: readonly string[] = [],
  options: SurfaceOverlayRemovalOptions = {}
): Promise<void> {
  if (!plugin?.state?.data?.build) return;

  const refs = new Set<string>();
  if (options.includeTagged !== false) {
    for (const overlay of selectSurfaceOverlayCells(plugin)) {
      if (overlay.transform?.ref) refs.add(overlay.transform.ref);
    }
  }
  for (const ref of trackedOverlayRefs) {
    if (ref) refs.add(ref);
  }

  if (refs.size === 0) return;
  for (const ref of options.excludeRefs ?? []) {
    refs.delete(ref);
  }
  if (refs.size === 0) return;
  recordSurfaceOverlayDiagnostic({
    event: 'remove',
    deletedRefs: [...refs],
    trackedOverlayRefs,
  });

  const builder = plugin.state.data.build();
  for (const ref of refs) {
    builder.delete(ref);
  }
  await builder.commit();
}

export async function applySurfaceOverlayRenderPlan(
  plugin: MolstarPlugin | null,
  plan: SurfaceOverlayRenderPlan,
  options: SurfaceOverlayApplyOptions = {}
): Promise<string[]> {
  const resolvedOptions: ResolvedSurfaceOverlayApplyOptions = {
    ...options,
    targetScope: plan.targetScope,
    ...(plan.typeParams ? { typeParams: plan.typeParams } : {}),
    ...(plan.colorMode ? { colorMode: plan.colorMode } : {}),
  };
  const queueKey = surfaceOverlayQueueKey(plugin);
  if (!queueKey) {
    return applySurfaceOverlayRenderPlanNow(plugin, plan.enabled, resolvedOptions);
  }

  const previous = surfaceOverlayApplyQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => applySurfaceOverlayRenderPlanNow(plugin, plan.enabled, resolvedOptions));
  surfaceOverlayApplyQueues.set(
    queueKey,
    next.catch(() => undefined)
  );
  return next;
}

async function applySurfaceOverlayRenderPlanNow(
  plugin: MolstarPlugin | null,
  surfaceOverlayEnabled: boolean,
  options: ResolvedSurfaceOverlayApplyOptions
): Promise<string[]> {
  if (!plugin?.state?.data) return [];

  const isCurrent = options.isCurrent || (() => true);
  if (!isCurrent()) return [];
  recordSurfaceOverlayDiagnostic({
    event: 'start',
    surfaceOverlayEnabled,
    preserveExisting: options.preserveExisting,
    trackedOverlayRefs: options.trackedOverlayRefs,
  });

  if (!surfaceOverlayEnabled) {
    const retained = retainedSurfaceOverlays.get(plugin);
    if (retained?.refs.length && retained.refs.every((ref) => plugin.state.data.cells.has(ref))) {
      await setSurfaceOverlayAlpha(plugin, retained.refs, 0);
      if (!isCurrent()) return [];
      await removeSurfaceOverlayRepresentations(plugin, options.trackedOverlayRefs, {
        excludeRefs: retained.refs,
      });
      recordSurfaceOverlayDiagnostic({ event: 'hidden', overlayRefs: retained.refs });
      return [];
    }
    retainedSurfaceOverlays.delete(plugin);
    await removeSurfaceOverlayRepresentations(plugin, options.trackedOverlayRefs);
    return [];
  }

  if (surfaceOverlayEnabled && options.preserveExisting) {
    const existingRefs = selectSurfaceOverlayCells(plugin)
      .map((overlay) => overlay.transform?.ref)
      .filter((ref): ref is string => !!ref);
    recordSurfaceOverlayDiagnostic({
      event: 'preserve-check',
      existingRefs,
      preserveExisting: true,
    });
    if (existingRefs.length > 0) return existingRefs;
  }

  if (!isCurrent()) {
    return [];
  }

  const targets = await waitForSurfaceOverlayBuildTargets(plugin, options, isCurrent);
  recordSurfaceOverlayDiagnostic({
    event: 'targets',
    targetCount: targets.length,
    targetLabels: targets.map((target) => target.label),
  });
  if (!isCurrent()) return [];
  if (targets.length === 0) return [];

  const signature = JSON.stringify({
    targets: targets.map((target) => ({
      ref: target.componentRef,
      color: surfaceOverlayColorSpecForComponentLabel(
        target.label,
        options.colorMode,
        options.chainColorPalette
      ),
    })),
    typeParams: { alpha: 0.2, ...options.typeParams },
  });
  const retained = retainedSurfaceOverlays.get(plugin);
  if (
    retained?.signature === signature &&
    retained.refs.length === targets.length &&
    retained.structureData.length === targets.length &&
    targets.every(
      (target, index) =>
        target.structureData === retained.structureData[index] &&
        target.componentData !== undefined &&
        target.componentData === retained.componentData[index]
    ) &&
    retained.refs.every((ref) => plugin.state.data.cells.has(ref))
  ) {
    await setSurfaceOverlayAlpha(
      plugin,
      retained.refs,
      typeof options.typeParams?.alpha === 'number' ? options.typeParams.alpha : 0.2
    );
    if (!isCurrent()) return [];
    await removeSurfaceOverlayRepresentations(plugin, options.trackedOverlayRefs, {
      excludeRefs: retained.refs,
    });
    recordSurfaceOverlayDiagnostic({ event: 'reused', overlayRefs: retained.refs });
    return retained.refs;
  }

  const loadRepresentationApi =
    options.loadRepresentationApi || loadSurfaceOverlayRepresentationApi;
  const { createStructureRepresentationParams, StateTransforms } = await loadRepresentationApi();

  if (!isCurrent()) {
    return [];
  }

  const builder = plugin.state.data.build();
  const overlays: { ref: string; label: string }[] = [];
  for (const target of targets) {
    const colorSpec = surfaceOverlayColorSpecForComponentLabel(
      target.label,
      options.colorMode,
      options.chainColorPalette
    );
    const reprParams = createStructureRepresentationParams(plugin, target.structureData, {
      type: 'molecular-surface',
      typeParams: {
        alpha: 0.2,
        ...options.typeParams,
        ignoreHydrogens: true,
        ignoreHydrogensVariant: 'all',
      },
      color: colorSpec.color,
      colorParams: colorSpec.colorParams,
    });

    const selector = builder
      .to(target.componentRef)
      .apply(
        StateTransforms.Representation.StructureRepresentation3D as never,
        reprParams as never,
        {
          tags: [SURFACE_OVERLAY_TAG],
        }
      );

    if (!isCurrent()) {
      return [];
    }
    overlays.push({ ref: selector.ref, label: target.label });
  }

  await builder.commit();
  const overlayRefs = overlays.map(({ ref }) => ref);
  if (!isCurrent()) {
    await removeSurfaceOverlayRepresentations(plugin, overlayRefs, { includeTagged: false });
    return [];
  }

  for (const overlay of overlays) {
    recordSurfaceOverlayDiagnostic({
      event: 'created',
      overlayRefs: [overlay.ref],
      targetLabels: [overlay.label],
    });
    const overlayCell = plugin.state.data.cells?.get?.(overlay.ref);
    const repr = overlayCell?.obj?.data?.repr;
    if (repr?.setState) {
      repr.setState({ markerActions: 0 });
    }
  }

  await removeSurfaceOverlayRepresentations(plugin, options.trackedOverlayRefs, {
    excludeRefs: overlayRefs,
  });

  recordSurfaceOverlayDiagnostic({
    event: 'complete',
    overlayRefs,
  });

  retainedSurfaceOverlays.set(plugin, {
    signature,
    structureData: targets.map((target) => target.structureData),
    componentData: targets.map((target) => target.componentData),
    refs: overlayRefs,
  });

  return overlayRefs;
}

async function waitForSurfaceOverlayBuildTargets(
  plugin: MolstarPlugin | null,
  options: ResolvedSurfaceOverlayApplyOptions,
  isCurrent: () => boolean
): Promise<SurfaceOverlayBuildTarget[]> {
  for (const delayMs of [0, 16, 50, 100, 200]) {
    if (!isCurrent()) return [];
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const targets = surfaceOverlayBuildTargets(plugin, options);
    if (targets.length > 0) return targets;
  }
  return [];
}

function surfaceOverlayBuildTargets(
  plugin: MolstarPlugin | null,
  options: ResolvedSurfaceOverlayApplyOptions
): SurfaceOverlayBuildTarget[] {
  if (!plugin) return [];
  const { structures } = plugin.managers?.structure?.hierarchy?.current || {};
  if (!structures || structures.length === 0) return [];

  const detailMemberIds =
    options.detailMemberIds !== undefined ? new Set(options.detailMemberIds) : undefined;
  const detailChainTargetsById = new Map(
    (options.detailChainTargets ?? []).map((target) => [target.targetId, target] as const)
  );
  const targetScope = options.targetScope ?? 'detail-aware';
  const targets: SurfaceOverlayBuildTarget[] = [];

  for (const structure of structures) {
    if (!structure.cell) continue;
    const allOverlayComponents = selectSurfaceOverlayTargetComponents(
      (structure.components || []) as SurfaceOverlayComponentLike[]
    );
    const broadOverlayComponents = allOverlayComponents.filter((component) => {
      const label = component.cell?.obj?.label || '';
      return (
        label !== STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer &&
        !detailMemberIdFromComponentLabel(label) &&
        !detailChainIdFromComponentLabel(label) &&
        !detailContextChainIdFromComponentLabel(label)
      );
    });
    const perChainComponents = allOverlayComponents.filter((component) => {
      const label = component.cell?.obj?.label || '';
      return (
        detailChainIdFromComponentLabel(label) !== null ||
        detailContextChainIdFromComponentLabel(label) !== null
      );
    });
    const components =
      targetScope === 'broad'
        ? broadOverlayComponents.length > 0
          ? broadOverlayComponents
          : perChainComponents.length > 0
            ? perChainComponents
            : []
        : allOverlayComponents;

    for (const component of components) {
      const label = component.cell?.obj?.label || '';
      const detailMemberId = detailMemberIdFromComponentLabel(label);
      const detailChainId = detailChainIdFromComponentLabel(label);
      const detailContextChainId = detailContextChainIdFromComponentLabel(label);
      if (targetScope !== 'broad' && detailChainTargetsById.size > 0) {
        const detailTarget = detailChainId ? detailChainTargetsById.get(detailChainId) : undefined;
        const contextTarget = detailContextChainId
          ? detailChainTargetsById.get(detailContextChainId)
          : undefined;
        if (detailTarget && !detailTarget.visible) continue;
        if (contextTarget && contextTarget.visible) continue;
        if (
          !detailTarget &&
          !contextTarget &&
          label !== STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer
        ) {
          continue;
        }
      } else if (targetScope !== 'broad' && detailMemberIds) {
        if (detailMemberId && !detailMemberIds.has(detailMemberId)) continue;
        if (!detailMemberId && label !== STRUCTURE_COMPONENT_LABELS.rcsbDetailContextPolymer) {
          continue;
        }
      }

      const componentRef = component.cell?.transform?.ref;
      if (!componentRef) continue;
      const structureData = component.cell?.parent?.obj?.data || structure.cell?.obj?.data;
      if (!structureData) continue;
      targets.push({
        label,
        componentRef,
        structureData,
        componentData: component.cell?.obj?.data,
      });
    }
  }

  return targets;
}
