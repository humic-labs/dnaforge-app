import type { PolymerRenderRole } from '../molstar/renderPlan';
import type {
  CanvasRenderSettings,
  Structure3dAttrs,
  Structure3dColorMode,
  Structure3dRepresentation,
  StructureScene,
  StructureTargetSelector,
  StructureViewState,
  VisualLayer,
} from '../types';
import { resolveStructureVisualColorMode } from './structureColorDefaults';
import { visualLayersForView } from './viewLayerOverrides';

export interface PolymerRoleRenderOverride {
  representation?: Structure3dRepresentation;
  colorMode?: Structure3dColorMode;
  typeParams?: Record<string, unknown>;
}

export type PolymerRoleRenderOverrides = Partial<
  Record<PolymerRenderRole, PolymerRoleRenderOverride>
>;

export type RenderableStructureRole = PolymerRenderRole | 'ligand' | 'ion' | 'water';

export interface CompiledVisualLayer {
  id: string;
  order: number;
  visible: boolean;
  target: StructureTargetSelector;
  roles: RenderableStructureRole[];
  representation: Structure3dRepresentation;
  colorMode?: Structure3dColorMode;
  typeParams?: Record<string, unknown>;
  sourceLayer: VisualLayer;
}

export interface CompiledStructureViewRenderPlan {
  activeRecipeId: string | null;
  layers: CompiledVisualLayer[];
  primaryLayer?: CompiledVisualLayer;
  wholeStructureSurfaceOverlayLayer?: CompiledVisualLayer;
  contextSurfaceLayer?: CompiledVisualLayer;
  polymerRoleOverrides?: PolymerRoleRenderOverrides;
  roleVisibility?: Partial<Record<RenderableStructureRole, boolean>>;
  usesActiveFocusTarget: boolean;
  hasCompletePolymerRoleCoverage: boolean;
  canvas?: CanvasRenderSettings;
}

const REQUIRED_POLYMER_ROLES: PolymerRenderRole[] = ['query', 'context', 'unscoped'];

export interface CompileStructureViewRenderPlanOptions {
  sourceColorContext?: Partial<Structure3dAttrs>;
}

export function compileStructureViewRenderPlan(
  view: StructureViewState,
  scene?: StructureScene,
  options: CompileStructureViewRenderPlanOptions = {}
): CompiledStructureViewRenderPlan {
  const layers = visualLayersForView(view)
    .map((layer) => compileVisualLayer(layer, scene, options.sourceColorContext))
    .sort((left, right) => left.order - right.order);
  const visibleLayers = layers.filter((layer) => layer.visible);
  const wholeStructureSurfaceOverlayLayer = visibleLayers.find(isWholeStructureSurfaceOverlayLayer);
  const roleVisibility = compileRoleVisibility(layers, wholeStructureSurfaceOverlayLayer);
  const contextSurfaceLayer = visibleLayers.find(isContextSurfaceLayer);
  const primaryLayer = primaryRenderableLayer(visibleLayers, wholeStructureSurfaceOverlayLayer);
  const usesActiveFocusTarget = visibleLayers.some((layer) => layer.target.kind === 'active-focus');
  const polymerRoleOverrides = compilePolymerRoleOverrides(
    visibleLayers,
    wholeStructureSurfaceOverlayLayer,
    primaryLayer
  );
  const hasCompletePolymerRoleCoverage = REQUIRED_POLYMER_ROLES.every(
    (role) => !!polymerRoleOverrides[role]
  );

  return {
    activeRecipeId: view.activeRecipeId,
    layers,
    primaryLayer,
    wholeStructureSurfaceOverlayLayer,
    contextSurfaceLayer,
    polymerRoleOverrides:
      Object.keys(polymerRoleOverrides).length > 0 ? polymerRoleOverrides : undefined,
    roleVisibility: Object.keys(roleVisibility).length > 0 ? roleVisibility : undefined,
    usesActiveFocusTarget,
    hasCompletePolymerRoleCoverage,
    canvas: view.recipe.canvas,
  };
}

function compileVisualLayer(
  layer: VisualLayer,
  scene?: StructureScene,
  sourceColorContext?: Partial<Structure3dAttrs>
): CompiledVisualLayer {
  return {
    id: layer.id,
    order: layer.order,
    visible: layer.visible,
    target: layer.target,
    roles: renderableRolesForTarget(layer.target, scene),
    representation: layer.representation.kind,
    colorMode: molstarColorModeForLayer(layer, sourceColorContext),
    typeParams: typeParamsForLayer(layer),
    sourceLayer: layer,
  };
}

function compilePolymerRoleOverrides(
  visibleLayers: readonly CompiledVisualLayer[],
  wholeStructureSurfaceOverlayLayer: CompiledVisualLayer | undefined,
  primaryLayer: CompiledVisualLayer | undefined
): PolymerRoleRenderOverrides {
  const overrides: PolymerRoleRenderOverrides = {};

  for (const layer of visibleLayers) {
    if (layer === wholeStructureSurfaceOverlayLayer) continue;
    for (const role of layer.roles) {
      if (!isPolymerRole(role)) continue;
      overrides[role] = overrideForLayer(layer);
    }
  }

  if (!overrides.unscoped && overrides.query && overrides.context) {
    overrides.unscoped = primaryLayer ? overrideForLayer(primaryLayer) : overrides.query;
  }

  return overrides;
}

function compileRoleVisibility(
  layers: readonly CompiledVisualLayer[],
  wholeStructureSurfaceOverlayLayer: CompiledVisualLayer | undefined
): Partial<Record<RenderableStructureRole, boolean>> {
  const targetedRoles = new Set<RenderableStructureRole>();
  const visibleRoles = new Set<RenderableStructureRole>();

  for (const layer of layers) {
    const isSurfaceOverlayLayer = layer === wholeStructureSurfaceOverlayLayer;
    for (const role of layer.roles) {
      targetedRoles.add(role);
      if (layer.visible && !isSurfaceOverlayLayer) visibleRoles.add(role);
    }
  }

  const visibility: Partial<Record<RenderableStructureRole, boolean>> = {};
  for (const role of targetedRoles) {
    visibility[role] = visibleRoles.has(role);
  }

  const polymerVisibilityValues = [visibility.query, visibility.focus, visibility.context].filter(
    (value): value is boolean => value !== undefined
  );
  if (visibility.unscoped === undefined && polymerVisibilityValues.length > 0) {
    visibility.unscoped = polymerVisibilityValues.some(Boolean);
  }

  return visibility;
}

function overrideForLayer(layer: CompiledVisualLayer): PolymerRoleRenderOverride {
  const override: PolymerRoleRenderOverride = {
    representation: layer.representation,
  };
  if (layer.colorMode) override.colorMode = layer.colorMode;
  if (layer.typeParams) override.typeParams = layer.typeParams;
  return override;
}

function renderableRolesForTarget(
  target: StructureTargetSelector,
  scene?: StructureScene
): RenderableStructureRole[] {
  switch (target.kind) {
    case 'whole-structure':
      return ['query', 'context', 'unscoped', 'ligand', 'ion', 'water'];
    case 'whole-complex':
    case 'context':
      return ['context'];
    case 'query-anchor':
      return ['query'];
    case 'active-focus':
      return scene?.activeFocus?.memberId === scene?.queryAnchor.memberId ? ['query'] : ['focus'];
    case 'member':
      if (target.memberId === scene?.queryAnchor.memberId) return ['query'];
      return ['context'];
    case 'member-kind': {
      const roles: RenderableStructureRole[] = [];
      if (target.memberKinds.includes('ligand')) roles.push('ligand');
      if (target.memberKinds.includes('ion')) roles.push('ion');
      if (target.memberKinds.includes('water')) roles.push('water');
      if (
        target.memberKinds.some((kind) => kind === 'protein' || kind === 'rna' || kind === 'dna')
      ) {
        roles.push('context');
      }
      return roles;
    }
    case 'ligand':
      return ['ligand'];
    case 'water':
      return ['water'];
    case 'chain':
    case 'saved-selection':
      return ['query', 'context', 'unscoped'];
  }
}

function primaryRenderableLayer(
  visibleLayers: readonly CompiledVisualLayer[],
  wholeStructureSurfaceOverlayLayer: CompiledVisualLayer | undefined
): CompiledVisualLayer | undefined {
  const layers = visibleLayers.filter((layer) => layer !== wholeStructureSurfaceOverlayLayer);
  return (
    layers.find((layer) => layer.target.kind === 'active-focus') ??
    layers.find((layer) => layer.target.kind === 'query-anchor') ??
    layers.find((layer) => layer.target.kind === 'whole-structure') ??
    layers.find((layer) => layer.representation !== 'surface') ??
    layers[0]
  );
}

function isWholeStructureSurfaceOverlayLayer(layer: CompiledVisualLayer): boolean {
  return (
    layer.target.kind === 'whole-structure' &&
    layer.representation === 'surface' &&
    typeof layer.sourceLayer.material?.alpha === 'number' &&
    layer.sourceLayer.material.alpha < 1
  );
}

function isContextSurfaceLayer(layer: CompiledVisualLayer): boolean {
  return (
    (layer.target.kind === 'whole-complex' || layer.target.kind === 'context') &&
    layer.representation === 'surface' &&
    typeof layer.sourceLayer.material?.alpha === 'number' &&
    layer.sourceLayer.material.alpha < 1
  );
}

function molstarColorModeForLayer(
  layer: VisualLayer,
  sourceColorContext?: Partial<Structure3dAttrs>
): Structure3dColorMode | undefined {
  const mode = layer.color.mode;
  if (mode === 'context-muted') return 'chain';
  return resolveStructureVisualColorMode(mode, sourceColorContext);
}

function typeParamsForLayer(layer: VisualLayer): Record<string, unknown> | undefined {
  const params: Record<string, unknown> = {};
  if (typeof layer.material?.alpha === 'number') params.alpha = layer.material.alpha;
  if (typeof layer.material?.sizeFactor === 'number') params.sizeFactor = layer.material.sizeFactor;
  if (typeof layer.material?.ignoreLight === 'boolean')
    params.ignoreLight = layer.material.ignoreLight;
  if (layer.material?.quality) params.quality = layer.material.quality;
  return Object.keys(params).length > 0 ? params : undefined;
}

function isPolymerRole(role: RenderableStructureRole): role is PolymerRenderRole {
  return role === 'query' || role === 'focus' || role === 'context' || role === 'unscoped';
}
