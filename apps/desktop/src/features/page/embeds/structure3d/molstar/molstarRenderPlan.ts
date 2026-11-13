import type {
  ColorPrimitive,
  MaterialPrimitive,
  Structure3dColorMode,
  Structure3dRepresentation,
  StructureScene,
} from '../types';
import type {
  StructureRenderTransaction,
  StructureRenderTransactionLayer,
  StructureRenderTransactionTableRow,
} from '../utils/structureRenderTransaction';
import type {
  PolymerRoleRenderOverrides,
  RenderableStructureRole,
} from '../utils/viewRecipeRenderPlan';
import type { DetailedPolymerChainTarget } from './structureBuilder';

export const MOLSTAR_RENDER_PLAN_NAMESPACE = 'waypoint.structure3d';

export type MolstarRenderPlanComponentRole =
  | 'detail-context-polymer'
  | 'detail-chain-polymer'
  | 'recipe-layer-role';

export type MolstarRenderPlanSelector =
  | {
      kind: 'polymer-context-excluding-detail';
      excludedChainInstanceIds: string[];
      includedChainInstanceIds: string[];
    }
  | {
      kind: 'polymer-chain-instance';
      chainInstanceId: string;
      selection: DetailedPolymerChainTarget['selection'];
      operator?: string;
    }
  | {
      kind: 'recipe-target';
      layerId: string;
      targetKind: StructureRenderTransactionLayer['targetKind'];
      role: RenderableStructureRole;
    };

export interface MolstarRenderPlanComponent {
  tag: string;
  role: MolstarRenderPlanComponentRole;
  selector: MolstarRenderPlanSelector;
  visible: boolean;
  chainInstanceIds?: string[];
}

export interface MolstarRenderPlanRepresentation {
  layerId: string;
  role: RenderableStructureRole;
  kind: StructureRenderTransaction['molstar']['representations'][number]['kind'];
  typeParams?: Record<string, unknown>;
  componentTag: string;
  representationTag: string;
  visible: boolean;
  colorMode: StructureRenderTransaction['molstar']['representations'][number]['colorMode'];
  resolvedMolstarColor?: number;
  material?: MaterialPrimitive;
}

export interface MolstarRenderPlanApplyKeys {
  representation: string;
  detailComponents: string;
  surfaceOverlay: string;
}

export interface MolstarRenderPlan {
  schemaVersion: 1;
  namespace: typeof MOLSTAR_RENDER_PLAN_NAMESPACE;
  sceneId: string | null;
  activeRecipeId: string | null;
  renderIntent: StructureRenderTransaction['renderIntent'];
  planHash: string;
  sourcePaletteId: string;
  expectedPaletteId?: string;
  components: MolstarRenderPlanComponent[];
  representations: MolstarRenderPlanRepresentation[];
  detailChainTargets?: DetailedPolymerChainTarget[];
  defaults: {
    representation: Structure3dRepresentation;
    colorMode: Structure3dColorMode;
    uniprotId?: string;
  };
  rolePlan: {
    polymerOverrides: PolymerRoleRenderOverrides;
    visibility: Partial<Record<RenderableStructureRole, boolean>>;
  };
  componentSync: {
    scene?: StructureScene;
    skipActiveFocusSync: boolean;
    detailMemberIds?: readonly string[];
    detailChainTargets?: readonly DetailedPolymerChainTarget[];
  };
  surfaceOverlay: {
    enabled: boolean;
    typeParams?: Record<string, unknown>;
    colorMode?: ColorPrimitive['mode'];
    targetScope: 'broad';
  };
  color: {
    chainColorPalette?: readonly number[];
  };
  canvas: StructureRenderTransaction['canvas'];
  controls: StructureRenderTransaction['controls'];
  cleanup: {
    namespace: typeof MOLSTAR_RENDER_PLAN_NAMESPACE;
    absentTagPolicy: 'delete';
    surfaceGeometryPolicy: 'preserve-when-selector-stable';
  };
}

export interface CompileMolstarRenderPlanOptions {
  scene?: StructureScene;
  uniprotId?: string;
}

export function compileMolstarRenderPlanFromTransaction(
  transaction: StructureRenderTransaction,
  options: CompileMolstarRenderPlanOptions = {}
): MolstarRenderPlan {
  const detailChainTargets = detailChainTargetsFromTransaction(transaction, options.scene);
  const selectedRows = transaction.table.rows.filter((row) => row.detailVisible);
  const unselectedRows = transaction.table.rows.filter((row) => !row.detailVisible);
  const detailComponents =
    detailChainTargets && detailChainTargets.length > 0
      ? [
          {
            tag: 'waypoint.structure3d.component.detail-context-polymer',
            role: 'detail-context-polymer' as const,
            selector: {
              kind: 'polymer-context-excluding-detail' as const,
              excludedChainInstanceIds: selectedRows.map((row) => row.chainInstanceId),
              includedChainInstanceIds: unselectedRows.map((row) => row.chainInstanceId),
            },
            visible: true,
            chainInstanceIds: unselectedRows.map((row) => row.chainInstanceId),
          },
          ...detailChainTargets.map((target) => ({
            tag: `waypoint.structure3d.component.detail-chain-polymer.${target.targetId}`,
            role: 'detail-chain-polymer' as const,
            selector: {
              kind: 'polymer-chain-instance' as const,
              chainInstanceId: target.targetId,
              selection: target.selection,
              ...(target.operator ? { operator: target.operator } : {}),
            },
            visible: target.visible,
            chainInstanceIds: [target.targetId],
          })),
        ]
      : [];
  const recipeComponents = transaction.molstar.representations.map((representation) => {
    const layer = transaction.layers.find(
      (candidate) => candidate.layerId === representation.layerId
    );
    return {
      tag: representation.componentTag,
      role: 'recipe-layer-role' as const,
      selector: {
        kind: 'recipe-target' as const,
        layerId: representation.layerId,
        targetKind: layer?.targetKind ?? 'whole-structure',
        role: representation.role,
      },
      visible: representation.visible,
    };
  });

  const execution = executionPlanFromTransaction(transaction, detailChainTargets, options);

  return {
    schemaVersion: 1,
    namespace: MOLSTAR_RENDER_PLAN_NAMESPACE,
    sceneId: transaction.sceneId,
    activeRecipeId: transaction.activeRecipeId,
    renderIntent: transaction.renderIntent,
    planHash: transaction.planHash,
    sourcePaletteId: transaction.table.sourcePaletteId,
    ...(transaction.expectedPaletteId ? { expectedPaletteId: transaction.expectedPaletteId } : {}),
    components: uniqueComponents([...recipeComponents, ...detailComponents]),
    representations: transaction.molstar.representations.map((representation) => ({
      layerId: representation.layerId,
      role: representation.role,
      kind: representation.kind,
      ...(representation.typeParams ? { typeParams: { ...representation.typeParams } } : {}),
      componentTag: representation.componentTag,
      representationTag: representation.representationTag,
      visible: representation.visible,
      colorMode: representation.colorMode,
      ...(representation.resolvedMolstarColor !== undefined
        ? { resolvedMolstarColor: representation.resolvedMolstarColor }
        : {}),
      ...(representation.material ? { material: representation.material } : {}),
    })),
    ...(detailChainTargets ? { detailChainTargets } : {}),
    defaults: execution.defaults,
    rolePlan: execution.rolePlan,
    componentSync: execution.componentSync,
    surfaceOverlay: execution.surfaceOverlay,
    color: execution.color,
    canvas: transaction.canvas,
    controls: transaction.controls,
    cleanup: {
      namespace: MOLSTAR_RENDER_PLAN_NAMESPACE,
      absentTagPolicy: 'delete',
      surfaceGeometryPolicy: 'preserve-when-selector-stable',
    },
  };
}

export function molstarRenderPlanApplyKeys(plan: MolstarRenderPlan): MolstarRenderPlanApplyKeys {
  return {
    representation: stableStringify({
      namespace: plan.namespace,
      sceneId: plan.sceneId,
      activeRecipeId: plan.activeRecipeId,
      renderIntent: plan.renderIntent,
      showWater: plan.controls.showWater,
      sideChains: plan.controls.sideChains,
      representations: plan.representations.map((representation) => ({
        layerId: representation.layerId,
        role: representation.role,
        kind: representation.kind,
        typeParams: representation.typeParams ?? null,
        visible: representation.visible,
        colorMode: representation.colorMode,
        resolvedMolstarColor: representation.resolvedMolstarColor ?? null,
        material: representation.material ?? null,
      })),
      canvas: plan.canvas,
      defaults: plan.defaults,
      rolePlan: plan.rolePlan,
    }),
    detailComponents: stableStringify({
      namespace: plan.namespace,
      sourcePaletteId: plan.sourcePaletteId,
      components: plan.components
        .filter((component) => component.role !== 'recipe-layer-role')
        .map((component) => ({
          tag: component.tag,
          role: component.role,
          selector: component.selector,
          visible: component.visible,
          chainInstanceIds: component.chainInstanceIds ?? [],
        })),
      chainColorPalette: plan.color.chainColorPalette ?? [],
    }),
    surfaceOverlay: stableStringify({
      namespace: plan.namespace,
      surfaceComponents: plan.representations
        .filter((representation) => representation.visible && representation.kind === 'surface')
        .map((representation) => ({
          layerId: representation.layerId,
          role: representation.role,
          componentTag: representation.componentTag,
          typeParams: representation.typeParams ?? null,
          colorMode: representation.colorMode,
          resolvedMolstarColor: representation.resolvedMolstarColor ?? null,
          material: representation.material ?? null,
        })),
      surfaceOverlay: plan.surfaceOverlay,
    }),
  };
}

function executionPlanFromTransaction(
  transaction: StructureRenderTransaction,
  detailChainTargets: DetailedPolymerChainTarget[] | undefined,
  options: CompileMolstarRenderPlanOptions
): Pick<MolstarRenderPlan, 'defaults' | 'rolePlan' | 'componentSync' | 'surfaceOverlay' | 'color'> {
  const primaryLayer = primaryLayerForTransaction(transaction.layers);
  const representation = primaryLayer?.representation ?? 'cartoon';
  const colorMode = primaryLayer?.color.resolvedMode ?? 'chain';
  const surfaceLayer = transaction.layers.find(
    (layer) =>
      layer.visible && layer.representation === 'surface' && layer.targetKind === 'whole-structure'
  );
  const detailMemberIds =
    detailChainTargets && transaction.renderIntent !== 'preview'
      ? uniqueSorted(
          transaction.table.rows
            .filter((row) => row.detailVisible)
            .map((row) => (row.memberId ? String(row.memberId) : undefined))
            .filter((memberId): memberId is string => typeof memberId === 'string')
        )
      : undefined;
  const polymerOverrides = polymerRoleOverridesFromTransaction(transaction) ?? {};
  const visibility = roleVisibilityFromTransaction(transaction) ?? {};
  const chainColorPalette = paletteFromSourcePaletteId(transaction.table.sourcePaletteId);

  return {
    defaults: {
      representation,
      colorMode,
      ...(options.uniprotId ? { uniprotId: options.uniprotId } : {}),
    },
    rolePlan: {
      polymerOverrides,
      visibility,
    },
    componentSync: {
      ...(options.scene ? { scene: options.scene } : {}),
      skipActiveFocusSync: transaction.renderIntent === 'preview',
      ...(detailMemberIds !== undefined ? { detailMemberIds } : {}),
      ...(detailChainTargets ? { detailChainTargets } : {}),
    },
    surfaceOverlay: {
      enabled: !!surfaceLayer,
      targetScope: 'broad',
      ...(surfaceLayer?.typeParams ? { typeParams: surfaceLayer.typeParams } : {}),
      ...(surfaceLayer ? { colorMode: surfaceOverlayColorModeForLayer(surfaceLayer) } : {}),
    },
    color: {
      ...(chainColorPalette ? { chainColorPalette } : {}),
    },
  };
}

function primaryLayerForTransaction(
  layers: readonly StructureRenderTransactionLayer[]
): StructureRenderTransactionLayer | undefined {
  const visible = layers.filter(
    (layer) => layer.visible && !isWholeStructureSurfaceOverlayLayer(layer)
  );
  return (
    visible.find((layer) => layer.targetKind === 'active-focus') ??
    visible.find((layer) => layer.targetKind === 'query-anchor') ??
    visible.find((layer) => layer.targetKind === 'whole-structure') ??
    visible.find((layer) => layer.representation !== 'surface') ??
    visible[0]
  );
}

function polymerRoleOverridesFromTransaction(
  transaction: StructureRenderTransaction
): PolymerRoleRenderOverrides | undefined {
  const overrides: PolymerRoleRenderOverrides = {};
  for (const layer of transaction.layers.filter((candidate) => candidate.visible)) {
    if (isWholeStructureSurfaceOverlayLayer(layer)) continue;
    for (const role of layer.roles) {
      if (!isPolymerRole(role)) continue;
      overrides[role] = {
        representation: layer.representation,
        colorMode: role === 'context' ? 'chain' : (layer.color.resolvedMode ?? 'chain'),
        ...(layer.typeParams ? { typeParams: layer.typeParams } : {}),
      };
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function roleVisibilityFromTransaction(
  transaction: StructureRenderTransaction
): Partial<Record<RenderableStructureRole, boolean>> | undefined {
  const visibility: Partial<Record<RenderableStructureRole, boolean>> = {};
  for (const layer of transaction.layers) {
    const isSurfaceOverlayLayer = isWholeStructureSurfaceOverlayLayer(layer);
    for (const role of layer.roles) {
      visibility[role] = (visibility[role] ?? false) || (layer.visible && !isSurfaceOverlayLayer);
    }
  }
  return Object.keys(visibility).length > 0 ? visibility : undefined;
}

function detailChainTargetsFromTransaction(
  transaction: StructureRenderTransaction,
  scene: StructureScene | undefined
): DetailedPolymerChainTarget[] | undefined {
  if (!scene || scene.sceneKind !== 'complex') return undefined;
  if (transaction.renderIntent === 'preview') return undefined;
  if (transaction.chainCatalogStatus !== 'resolved') return undefined;
  if (transaction.table.rows.length === 0) return undefined;

  return transaction.table.rows.map((row) => detailChainTargetFromRow(row, scene));
}

function detailChainTargetFromRow(
  row: StructureRenderTransactionTableRow,
  scene: StructureScene
): DetailedPolymerChainTarget {
  const member = row.memberId
    ? scene.members.find((candidate) => candidate.memberId === row.memberId)
    : undefined;
  const memberSelection = member?.selection ?? scene.queryAnchor.targetSelection;
  const authAsymId = row.authAsymId ?? row.baseChain ?? row.displayChainId;
  const chainId = row.chainId ?? row.baseChain ?? row.labelAsymId ?? authAsymId;
  return {
    targetId: row.chainInstanceId,
    ...(row.memberId ? { memberId: row.memberId } : {}),
    selection: {
      ...(memberSelection.pdbId ? { pdbId: memberSelection.pdbId } : {}),
      ...(memberSelection.accession ? { accession: memberSelection.accession } : {}),
      ...(row.entityId ? { entityIds: [row.entityId] } : {}),
      ...(row.labelAsymId ? { labelAsymIds: [row.labelAsymId] } : {}),
      ...(authAsymId ? { authAsymIds: [authAsymId] } : {}),
      ...(chainId ? { chainIds: [chainId] } : {}),
    },
    ...(row.operator ? { operator: row.operator } : {}),
    visible: row.detailVisible,
    ...(row.detailMolstarColor !== undefined ? { color: row.detailMolstarColor } : {}),
  };
}

function surfaceOverlayColorModeForLayer(
  layer: StructureRenderTransactionLayer
): ColorPrimitive['mode'] {
  if (layer.color.mode === 'source-default') return layer.color.resolvedMode ?? 'chain';
  return layer.color.mode;
}

function isWholeStructureSurfaceOverlayLayer(layer: StructureRenderTransactionLayer): boolean {
  return (
    layer.targetKind === 'whole-structure' &&
    layer.representation === 'surface' &&
    typeof layer.material?.alpha === 'number' &&
    layer.material.alpha < 1
  );
}

function paletteFromSourcePaletteId(sourcePaletteId: string): number[] | undefined {
  if (!sourcePaletteId.startsWith('molstar:')) return undefined;
  const encoded = sourcePaletteId.slice('molstar:'.length);
  if (!encoded || encoded === 'pending-chain-catalog') return undefined;
  return encoded
    .split(',')
    .map((token) => Number.parseInt(token, 16))
    .filter((value) => Number.isFinite(value));
}

function uniqueComponents(
  components: readonly MolstarRenderPlanComponent[]
): MolstarRenderPlanComponent[] {
  const byTag = new Map<string, MolstarRenderPlanComponent>();
  for (const component of components) {
    byTag.set(component.tag, component);
  }
  return [...byTag.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}

function isPolymerRole(role: RenderableStructureRole): role is keyof PolymerRoleRenderOverrides {
  return role === 'query' || role === 'focus' || role === 'context' || role === 'unscoped';
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableStringify);
  if (!value || typeof value !== 'object') return value;

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = normalizeForStableStringify((value as Record<string, unknown>)[key]);
    if (nested !== undefined) normalized[key] = nested;
  }
  return normalized;
}
