import type {
  CanvasRenderSettings,
  MaterialPrimitive,
  Structure3dAttrs,
  Structure3dColorMode,
  StructureScene,
  StructureTargetSelector,
  StructureViewState,
} from '../types';
import { STRUCTURE_CONTEXT_MOLSTAR_COLOR, type StructureRenderModel } from './structureRenderModel';
import {
  compileStructureViewRenderPlan,
  type CompiledVisualLayer,
  type RenderableStructureRole,
} from './viewRecipeRenderPlan';
import {
  molstarComponentTag,
  molstarRepresentationTag,
  visualLayerId,
  visualLayerStableKey,
  type ChainInstanceId,
  type MolstarComponentTag,
  type MolstarRepresentationTag,
  type StructureChainGroupId,
  type StructureMemberId,
  type VisualLayerId,
  type VisualLayerStableKey,
} from './structureIds';

export type StructureRenderTransactionIntent = 'preview' | 'loaded';
export type StructureRenderChainCatalogStatus = 'resolved' | 'pending';

export interface StructureRenderTransactionInput {
  scene?: StructureScene;
  view?: StructureViewState;
  renderModel?: StructureRenderModel;
  sourceColorContext?: Partial<Structure3dAttrs>;
  expectedPaletteId?: string;
}

export interface StructureRenderTransactionLayer {
  layerId: VisualLayerId;
  order: number;
  visible: boolean;
  targetKind: StructureTargetSelector['kind'];
  target: StructureTargetSelector;
  roles: RenderableStructureRole[];
  representation: CompiledVisualLayer['representation'];
  typeParams?: Record<string, unknown>;
  color: {
    mode: CompiledVisualLayer['sourceLayer']['color']['mode'];
    resolvedMode?: Structure3dColorMode;
    resolvedMolstarColor?: number;
  };
  material?: MaterialPrimitive;
  stableLayerKey: VisualLayerStableKey;
}

export interface StructureRenderTransactionTableRow {
  chainInstanceId: ChainInstanceId;
  displayChainId: string;
  chainId?: string;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
  memberId?: StructureMemberId;
  groupId: StructureChainGroupId;
  groupLabel: string;
  detailVisible: boolean;
  detailMolstarColor?: number;
  displayMolstarColor?: number;
}

export interface StructureRenderTransactionTable {
  sourcePaletteId: string;
  expectedPaletteId?: string;
  rows: StructureRenderTransactionTableRow[];
  chainColors: Record<string, number | null>;
}

export interface StructureRenderTransactionMolstarRepresentation {
  layerId: VisualLayerId;
  role: RenderableStructureRole;
  kind: CompiledVisualLayer['representation'];
  typeParams?: Record<string, unknown>;
  componentTag: MolstarComponentTag;
  representationTag: MolstarRepresentationTag;
  visible: boolean;
  colorMode: Structure3dColorMode;
  resolvedMolstarColor?: number;
  material?: MaterialPrimitive;
}

export interface StructureRenderTransactionMolstarPlan {
  sourcePaletteId: string;
  expectedPaletteId?: string;
  chainColors: Record<string, number | null>;
  representations: StructureRenderTransactionMolstarRepresentation[];
}

export interface StructureRenderTransaction {
  schemaVersion: 1;
  renderIntent: StructureRenderTransactionIntent;
  sceneId: string | null;
  activeRecipeId: string | null;
  chainCatalogStatus: StructureRenderChainCatalogStatus;
  expectedPaletteId?: string;
  planHash: string;
  layers: StructureRenderTransactionLayer[];
  table: StructureRenderTransactionTable;
  molstar: StructureRenderTransactionMolstarPlan;
  canvas: Required<Pick<CanvasRenderSettings, 'outlineEnabled' | 'aoEnabled'>> &
    Pick<CanvasRenderSettings, 'advancedSettings' | 'ambientIntensity'>;
  controls: {
    showWater: boolean;
    spin: boolean;
    sideChains: {
      visibleBackbones: boolean;
      selection: boolean;
    };
  };
  invariants: {
    previewAllowsSurface: boolean;
    hasSurfaceLayer: boolean;
    surfaceLayerKeys: string[];
  };
}

export function compileStructureRenderTransaction({
  scene,
  view,
  renderModel,
  sourceColorContext,
  expectedPaletteId,
}: StructureRenderTransactionInput): StructureRenderTransaction {
  const renderIntent = resolveRenderIntent(view);
  const renderPlan = view
    ? compileStructureViewRenderPlan(view, scene, { sourceColorContext })
    : null;
  const layers = (renderPlan?.layers ?? []).map(transactionLayerFromCompiledLayer);
  const table = transactionTableFromRenderModel(renderModel, expectedPaletteId);
  const molstar = transactionMolstarPlanFromLayers(layers, table);
  const canvas = {
    outlineEnabled: renderPlan?.canvas?.outlineEnabled ?? false,
    aoEnabled: renderPlan?.canvas?.aoEnabled ?? false,
    ...(renderPlan?.canvas?.advancedSettings
      ? { advancedSettings: renderPlan.canvas.advancedSettings }
      : {}),
    ...(renderPlan?.canvas?.ambientIntensity !== undefined
      ? { ambientIntensity: renderPlan.canvas.ambientIntensity }
      : {}),
  };
  const controls = {
    showWater: view?.showWater ?? false,
    spin: view?.spin ?? false,
    sideChains: {
      visibleBackbones: view?.residueVisualization?.sideChains?.visibleBackbones ?? false,
      selection: view?.residueVisualization?.sideChains?.selection ?? false,
    },
  };
  const surfaceLayerKeys = layers
    .filter((layer) => layer.visible && layer.representation === 'surface')
    .map((layer) => layer.stableLayerKey);
  const chainCatalogStatus: StructureRenderChainCatalogStatus = renderModel
    ? 'resolved'
    : 'pending';

  const withoutHash = {
    schemaVersion: 1 as const,
    renderIntent,
    sceneId: scene?.sceneId ?? null,
    activeRecipeId: view?.activeRecipeId ?? null,
    ...(expectedPaletteId ? { expectedPaletteId } : {}),
    chainCatalogStatus,
    layers,
    table,
    molstar,
    canvas,
    controls,
    invariants: {
      previewAllowsSurface: renderIntent === 'preview' && surfaceLayerKeys.length > 0,
      hasSurfaceLayer: surfaceLayerKeys.length > 0,
      surfaceLayerKeys,
    },
  };

  return {
    ...withoutHash,
    planHash: structureRenderTransactionHash(withoutHash),
  };
}

export function transactionSurfaceLayerKeys(
  transaction: Pick<StructureRenderTransaction, 'layers'>
): string[] {
  return transaction.layers
    .filter((layer) => layer.visible && layer.representation === 'surface')
    .map((layer) => layer.stableLayerKey);
}

export function structureRenderTransactionHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wprtx_${hash.toString(16).padStart(8, '0')}`;
}

function resolveRenderIntent(
  view: StructureViewState | undefined
): StructureRenderTransactionIntent {
  return view?.renderIntent === 'preview' || view?.activeRecipeId === 'query-in-complex-preview'
    ? 'preview'
    : 'loaded';
}

function transactionLayerFromCompiledLayer(
  layer: CompiledVisualLayer
): StructureRenderTransactionLayer {
  const resolvedMolstarColor = resolvedMolstarColorForLayer(layer);
  return {
    layerId: visualLayerId(layer.id),
    order: layer.order,
    visible: layer.visible,
    targetKind: layer.target.kind,
    target: layer.target,
    roles: [...layer.roles],
    representation: layer.representation,
    ...(layer.typeParams ? { typeParams: { ...layer.typeParams } } : {}),
    color: {
      mode: layer.sourceLayer.color.mode,
      ...(layer.colorMode ? { resolvedMode: layer.colorMode } : {}),
      ...(resolvedMolstarColor !== undefined ? { resolvedMolstarColor } : {}),
    },
    ...(layer.sourceLayer.material ? { material: { ...layer.sourceLayer.material } } : {}),
    stableLayerKey: stableLayerKey(layer),
  };
}

function transactionTableFromRenderModel(
  renderModel: StructureRenderModel | undefined,
  expectedPaletteId?: string
): StructureRenderTransactionTable {
  const sourcePaletteId = renderModel
    ? `molstar:${renderModel.molstarPalette.map((color) => color.toString(16).padStart(6, '0')).join(',')}`
    : 'molstar:pending-chain-catalog';
  const rows =
    renderModel?.chainRows.map((row): StructureRenderTransactionTableRow => {
      return {
        chainInstanceId: row.chainInstanceId,
        displayChainId: row.displayChainId,
        ...(row.chain.chainId ? { chainId: row.chain.chainId } : {}),
        ...(row.chain.baseChain ? { baseChain: row.chain.baseChain } : {}),
        ...(row.chain.labelAsymId ? { labelAsymId: row.chain.labelAsymId } : {}),
        ...(row.chain.authAsymId ? { authAsymId: row.chain.authAsymId } : {}),
        ...(row.chain.entityId ? { entityId: row.chain.entityId } : {}),
        ...(row.chain.operator ? { operator: row.chain.operator } : {}),
        ...(row.memberId ? { memberId: row.memberId } : {}),
        groupId: row.groupId,
        groupLabel: row.groupLabel,
        detailVisible: row.detailVisible,
        ...(row.detailMolstarColor !== undefined
          ? { detailMolstarColor: row.detailMolstarColor }
          : {}),
        ...(row.displayMolstarColor !== undefined
          ? { displayMolstarColor: row.displayMolstarColor }
          : {}),
      };
    }) ?? [];

  return {
    sourcePaletteId,
    ...(expectedPaletteId ? { expectedPaletteId } : {}),
    rows,
    chainColors: Object.fromEntries(
      rows.map((row) => [row.chainInstanceId, row.displayMolstarColor ?? null])
    ),
  };
}

function transactionMolstarPlanFromLayers(
  layers: readonly StructureRenderTransactionLayer[],
  table: StructureRenderTransactionTable
): StructureRenderTransactionMolstarPlan {
  return {
    sourcePaletteId: table.sourcePaletteId,
    ...(table.expectedPaletteId ? { expectedPaletteId: table.expectedPaletteId } : {}),
    chainColors: table.chainColors,
    representations: layers.flatMap((layer) =>
      layer.roles.map((role) => ({
        layerId: layer.layerId,
        role,
        kind: layer.representation,
        ...(layer.typeParams ? { typeParams: { ...layer.typeParams } } : {}),
        componentTag: waypointComponentTag(layer, role),
        representationTag: waypointRepresentationTag(layer, role),
        visible: layer.visible,
        colorMode: executableColorModeForRole(layer, role),
        ...(executableMolstarColorForRole(layer, role) !== undefined
          ? { resolvedMolstarColor: executableMolstarColorForRole(layer, role) }
          : {}),
        ...(layer.material ? { material: { ...layer.material } } : {}),
      }))
    ),
  };
}

function stableLayerKey(layer: CompiledVisualLayer): VisualLayerStableKey {
  const alpha = layer.sourceLayer.material?.alpha ?? 'none';
  return visualLayerStableKey(
    [
      `layer:${layer.id}`,
      `target:${layer.target.kind}`,
      `repr:${layer.representation}`,
      `color:${layer.sourceLayer.color.mode}`,
      `alpha:${alpha}`,
    ].join('|')
  );
}

function resolvedMolstarColorForLayer(layer: CompiledVisualLayer): number | undefined {
  if (layer.sourceLayer.color.mode === 'context-muted') return STRUCTURE_CONTEXT_MOLSTAR_COLOR;
  if (layer.sourceLayer.color.mode === 'uniform') return layer.sourceLayer.color.value;
  return undefined;
}

function executableColorModeForRole(
  layer: StructureRenderTransactionLayer,
  role: RenderableStructureRole
): Structure3dColorMode {
  if (role === 'context') return 'chain';
  return layer.color.resolvedMode ?? 'chain';
}

function executableMolstarColorForRole(
  layer: StructureRenderTransactionLayer,
  role: RenderableStructureRole
): number | undefined {
  if (role === 'context') return STRUCTURE_CONTEXT_MOLSTAR_COLOR;
  return layer.color.resolvedMolstarColor;
}

function waypointComponentTag(
  layer: StructureRenderTransactionLayer,
  role: RenderableStructureRole
): MolstarComponentTag {
  return molstarComponentTag(`waypoint.structure3d.component.${layer.layerId}.${role}`);
}

function waypointRepresentationTag(
  layer: StructureRenderTransactionLayer,
  role: RenderableStructureRole
): MolstarRepresentationTag {
  return molstarRepresentationTag(
    `waypoint.structure3d.representation.${layer.layerId}.${role}.${layer.representation}`
  );
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
