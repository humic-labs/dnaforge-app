import { normalizeStructureViewScores } from './structureScoreState';
import type {
  AdvancedViewerSettings,
  CanvasRenderSettings,
  ColorPrimitive,
  Structure3dAttrs,
  Structure3dColorMode,
  Structure3dRepresentation,
  StructureScene,
  StructureTargetSelector,
  StructureViewState,
  StructureVisualColorMode,
  ViewRecipe,
  VisualLayer,
} from '../types';
import {
  createAssemblyOverviewRecipe,
  createAtomicDetailRecipe,
  createBallAndStickRecipe,
  createCartoonRecipe,
  createConfidenceRecipe,
  createDefaultStructureViewState,
  createFocusInContextRecipe,
  createHybridRecipe,
  createIllustrativeRecipe,
  createInterfaceRecipe,
  createLigandSiteRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
  createSpacefillRecipe,
  createStandardViewRecipes,
  createSurfaceDetailRecipe,
  createSurfaceRecipe,
  visualLayer,
} from './builtinViewRecipes';
import { resolveStructureVisualColorMode } from './structureColorDefaults';
import { visualLayersForView } from './viewLayerOverrides';

export {
  createAssemblyOverviewRecipe,
  createAtomicDetailRecipe,
  createBallAndStickRecipe,
  createCartoonRecipe,
  createConfidenceRecipe,
  createDefaultStructureViewState,
  createFocusInContextRecipe,
  createHybridRecipe,
  createIllustrativeRecipe,
  createInterfaceRecipe,
  createLigandSiteRecipe,
  createQueryInComplexPreviewRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
  createSpacefillRecipe,
  createStandardViewRecipes,
  createStructureViewStateFromRecipe,
  createSurfaceDetailRecipe,
  createSurfaceRecipe,
} from './builtinViewRecipes';

const BUILT_IN_VIEW_RECIPE_FACTORIES: Record<string, () => ViewRecipe> = {
  cartoon: createCartoonRecipe,
  'ball-and-stick': createBallAndStickRecipe,
  spacefill: createSpacefillRecipe,
  surface: createSurfaceRecipe,
  illustrative: createIllustrativeRecipe,
  hybrid: createHybridRecipe,
  'query-in-complex': createQueryInComplexRecipe,
  'query-in-complex-surface': createQueryInComplexSurfaceRecipe,
  'surface-detail': createSurfaceDetailRecipe,
  'atomic-detail': createAtomicDetailRecipe,
  confidence: createConfidenceRecipe,
  'focus-in-context': createFocusInContextRecipe,
  'assembly-overview': createAssemblyOverviewRecipe,
  interface: createInterfaceRecipe,
  'ligand-site': createLigandSiteRecipe,
};

export const BUILT_IN_VIEW_RECIPES: ViewRecipe[] = [
  ...createStandardViewRecipes(),
  createQueryInComplexRecipe(),
  createQueryInComplexSurfaceRecipe(),
  createFocusInContextRecipe(),
  createAssemblyOverviewRecipe(),
  createInterfaceRecipe(),
  createLigandSiteRecipe(),
];

export function builtInViewRecipeById(id: string | null | undefined): ViewRecipe | undefined {
  if (!id) return undefined;
  return BUILT_IN_VIEW_RECIPE_FACTORIES[id]?.();
}

export function viewRecipeByIdForScene(id: string, scene: StructureScene | undefined): ViewRecipe {
  return builtInRecipeForScene(id, scene);
}

export function structureViewStateFromAttrs(attrs: Structure3dAttrs): StructureViewState {
  return normalizeStructureViewScores(
    attrs.view ??
      createDefaultStructureViewState({
        cameraSnapshot: attrs.cameraSnapshot,
        backgroundColor: attrs.backgroundColor,
      }),
    attrs
  );
}

export function attrsPatchFromStructureViewState(
  view: StructureViewState
): Pick<Structure3dAttrs, 'view'> {
  return { view };
}

export function primaryLayerForStructureView(view: StructureViewState): VisualLayer | undefined {
  const layers = visualLayersForView(view).filter((layer) => layer.visible);
  return (
    layers.find((layer) => layer.target.kind === 'active-focus') ??
    layers.find((layer) => layer.target.kind === 'query-anchor') ??
    layers.find((layer) => layer.target.kind === 'whole-structure') ??
    layers.find((layer) => layer.representation.kind !== 'surface') ??
    layers[0]
  );
}

export function representationForStructureView(
  view: StructureViewState
): Structure3dRepresentation {
  return primaryLayerForStructureView(view)?.representation.kind ?? 'cartoon';
}

export function colorModeForStructureView(
  view: StructureViewState,
  sourceColorContext?: Partial<Structure3dAttrs>
): Structure3dColorMode {
  const resolved = resolveStructureVisualColorMode(
    primaryLayerForStructureView(view)?.color.mode,
    sourceColorContext
  );
  return resolved ?? 'chain';
}

export function advancedSettingsForStructureView(
  view: StructureViewState
): Partial<AdvancedViewerSettings> {
  return view.recipe.canvas?.advancedSettings ?? {};
}

export function viewWithCanvasSettings(
  view: StructureViewState,
  settings: Partial<AdvancedViewerSettings>
): StructureViewState {
  return {
    ...view,
    activeRecipeId: null,
    recipe: {
      ...view.recipe,
      canvas: canvasWithAdvancedSettings(view.recipe.canvas, settings),
    },
  };
}

export function viewWithGlobalColorMode(
  view: StructureViewState,
  colorMode: StructureVisualColorMode
): StructureViewState {
  const baseLayersById = new Map(view.recipe.layers.map((layer) => [layer.id, layer]));
  return {
    ...view,
    activeRecipeId: null,
    recipe: {
      ...view.recipe,
      layers: view.recipe.layers.map((layer) =>
        shouldApplyGlobalColorModeToLayer(layer)
          ? { ...layer, color: { mode: colorMode } satisfies ColorPrimitive }
          : layer
      ),
    },
    layerOverrides: view.layerOverrides?.map((override) => {
      const baseLayer = baseLayersById.get(override.layerId);
      if (!baseLayer) return override;
      const effectiveLayer: VisualLayer = {
        ...baseLayer,
        ...(override.visible !== undefined ? { visible: override.visible } : {}),
        ...(override.target ? { target: override.target } : {}),
        ...(override.representation ? { representation: override.representation } : {}),
        ...(override.color ? { color: override.color } : {}),
        ...(override.material ? { material: override.material } : {}),
      };
      return shouldApplyGlobalColorModeToLayer(effectiveLayer)
        ? { ...override, color: { mode: colorMode } }
        : override;
    }),
  };
}

function shouldApplyGlobalColorModeToLayer(layer: Pick<VisualLayer, 'target' | 'color'>): boolean {
  if (layer.color.mode === 'context-muted') return false;
  return targetReceivesGlobalColorMode(layer.target);
}

function targetReceivesGlobalColorMode(target: StructureTargetSelector): boolean {
  switch (target.kind) {
    case 'ligand':
    case 'water':
    case 'context':
    case 'whole-complex':
      return false;
    case 'member-kind':
      return target.memberKinds.some(isPolymerMemberKind);
    default:
      return true;
  }
}

function isPolymerMemberKind(kind: string): boolean {
  return kind === 'protein' || kind === 'rna' || kind === 'dna';
}

function builtInRecipeForScene(id: string, scene: StructureScene | undefined): ViewRecipe {
  if (scene?.sceneKind === 'complex') {
    switch (id) {
      case 'cartoon':
        return complexPrimitiveRecipe('cartoon', 'Cartoon', 'cartoon');
      case 'ball-and-stick':
        return complexPrimitiveRecipe('ball-and-stick', 'Atomic Detail', 'ball-and-stick', {
          colorMode: 'element',
        });
      case 'spacefill':
        return complexPrimitiveRecipe('spacefill', 'Spacefill', 'spacefill', {
          colorMode: 'element',
          material: { sizeFactor: 1, quality: 'auto' },
        });
      case 'surface':
        return complexPrimitiveRecipe('surface', 'Surface', 'surface', {
          canvas: createSurfaceRecipe().canvas,
          material: { quality: 'auto' },
        });
      case 'illustrative':
        return complexPrimitiveRecipe('illustrative', 'Styled Spacefill', 'illustrative', {
          canvas: createIllustrativeRecipe().canvas,
          material: { ignoreLight: true, sizeFactor: 1, quality: 'auto' },
        });
      case 'hybrid':
        return {
          ...createQueryInComplexSurfaceRecipe(),
          id: 'hybrid',
          name: 'Hybrid',
        };
    }
  }
  return builtInViewRecipeById(id) ?? createCartoonRecipe();
}

function complexPrimitiveRecipe(
  id: string,
  name: string,
  representation: Structure3dRepresentation,
  options: {
    colorMode?: StructureVisualColorMode;
    canvas?: CanvasRenderSettings;
    material?: VisualLayer['material'];
  } = {}
): ViewRecipe {
  const colorMode = options.colorMode ?? 'source-default';
  return {
    schemaVersion: 1,
    id,
    name,
    origin: 'builtin',
    layers: [
      visualLayer({
        id: `${id}-context-complex-${representation}`,
        target: { kind: 'whole-complex' },
        representation,
        color: { mode: 'context-muted' },
        ...(options.material ? { material: options.material } : {}),
        order: 10,
      }),
      visualLayer({
        id: `${id}-query-anchor-${representation}`,
        target: { kind: 'query-anchor' },
        representation,
        color: { mode: colorMode },
        ...(options.material ? { material: options.material } : {}),
        order: 20,
      }),
      visualLayer({
        id: `${id}-ligands-ball-and-stick`,
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: options.canvas ?? DEFAULT_CANVAS_SETTINGS,
  };
}

const DEFAULT_CANVAS_SETTINGS: CanvasRenderSettings = {
  outlineEnabled: false,
  aoEnabled: false,
  ambientIntensity: 0.4,
  advancedSettings: {
    outlineEnabled: false,
    aoEnabled: false,
    ambientIntensity: 0.4,
  },
};

function canvasWithAdvancedSettings(
  current: CanvasRenderSettings | undefined,
  advancedSettings: Partial<AdvancedViewerSettings>
): CanvasRenderSettings {
  return {
    ...current,
    advancedSettings,
    outlineEnabled: advancedSettings.outlineEnabled ?? current?.outlineEnabled,
    aoEnabled: advancedSettings.aoEnabled ?? current?.aoEnabled,
    ambientIntensity: advancedSettings.ambientIntensity ?? current?.ambientIntensity,
  };
}
