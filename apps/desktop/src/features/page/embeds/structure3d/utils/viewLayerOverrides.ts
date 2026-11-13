import type {
  MaterialPrimitive,
  RepresentationPrimitive,
  Structure3dRepresentation,
  StructureTargetSelector,
  StructureVisualColorMode,
  StructureViewState,
  ViewRecipe,
  VisualLayer,
  VisualLayerOverride,
} from '../types';

export function visualLayersForView(view: StructureViewState): VisualLayer[] {
  if (!view.layerOverrides?.length) return view.recipe.layers;

  const overridesById = new Map(
    view.layerOverrides.map((override) => [override.layerId, override])
  );

  return view.recipe.layers.map((layer) => {
    const override = overridesById.get(layer.id);
    if (!override) return layer;

    return {
      ...layer,
      target: override.target ?? layer.target,
      representation: override.representation ?? layer.representation,
      color: override.color ?? layer.color,
      material: override.material ? { ...layer.material, ...override.material } : layer.material,
      visible: override.visible ?? layer.visible,
    };
  });
}

export function viewRecipeWithLayerOverrides(view: StructureViewState): ViewRecipe {
  if (!view.layerOverrides?.length) return view.recipe;
  return {
    ...view.recipe,
    layers: visualLayersForView(view),
  };
}

export function clearVisualLayerOverrides(view: StructureViewState): StructureViewState {
  if (!view.layerOverrides?.length) return view;
  return {
    ...view,
    layerOverrides: undefined,
  };
}

export function setVisualLayerVisibility(
  view: StructureViewState,
  layerId: string,
  visible: boolean
): StructureViewState {
  return updateVisualLayerOverride(view, layerId, (baseLayer, override) => {
    const nextOverride: Partial<VisualLayerOverride> & { layerId: string } = {
      ...override,
      visible,
    };
    if (baseLayer.visible === visible) delete nextOverride.visible;
    return nextOverride;
  });
}

export function setVisualLayerRepresentation(
  view: StructureViewState,
  layerId: string,
  representation: Structure3dRepresentation
): StructureViewState {
  return updateVisualLayerOverride(view, layerId, (baseLayer, override) => {
    const nextOverride: Partial<VisualLayerOverride> & { layerId: string } = {
      ...override,
      representation: { kind: representation } satisfies RepresentationPrimitive,
    };
    if (baseLayer.representation.kind === representation) delete nextOverride.representation;
    return nextOverride;
  });
}

export function setVisualLayerTarget(
  view: StructureViewState,
  layerId: string,
  target: StructureTargetSelector
): StructureViewState {
  return updateVisualLayerOverride(view, layerId, (baseLayer, override) => {
    const nextOverride: Partial<VisualLayerOverride> & { layerId: string } = {
      ...override,
      target,
    };
    if (sameTargetSelector(baseLayer.target, target)) delete nextOverride.target;
    return nextOverride;
  });
}

export function setVisualLayerColor(
  view: StructureViewState,
  layerId: string,
  colorMode: StructureVisualColorMode
): StructureViewState {
  return updateVisualLayerOverride(view, layerId, (baseLayer, override) => {
    const nextOverride: Partial<VisualLayerOverride> & { layerId: string } = {
      ...override,
      color: { mode: colorMode },
    };
    if (baseLayer.color.mode === colorMode) delete nextOverride.color;
    return nextOverride;
  });
}

export function setVisualLayerAlpha(
  view: StructureViewState,
  layerId: string,
  alpha: number
): StructureViewState {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  return updateVisualLayerOverride(view, layerId, (baseLayer, override) => {
    const nextMaterial: MaterialPrimitive = {
      ...override.material,
      alpha: clampedAlpha,
    };
    if (baseLayer.material?.alpha === clampedAlpha) delete nextMaterial.alpha;

    const nextOverride = {
      ...override,
      material: Object.keys(nextMaterial).length > 0 ? nextMaterial : undefined,
    };
    if (!nextOverride.material) delete nextOverride.material;
    return nextOverride;
  });
}

function updateVisualLayerOverride(
  view: StructureViewState,
  layerId: string,
  updateOverride: (
    baseLayer: VisualLayer,
    override: Partial<VisualLayerOverride> & { layerId: string }
  ) => Partial<VisualLayerOverride> & { layerId: string }
): StructureViewState {
  const baseLayer = view.recipe.layers.find((layer) => layer.id === layerId);
  if (!baseLayer) return view;

  const nextOverrides: VisualLayerOverride[] = [];
  let updatedExistingOverride = false;

  for (const override of view.layerOverrides ?? []) {
    if (override.layerId !== layerId) {
      nextOverrides.push(override);
      continue;
    }

    updatedExistingOverride = true;
    const nextOverride = updateOverride(baseLayer, { ...override });
    if (hasLayerOverrideValues(nextOverride)) nextOverrides.push(nextOverride);
  }

  if (!updatedExistingOverride) {
    const nextOverride = updateOverride(baseLayer, { layerId });
    if (hasLayerOverrideValues(nextOverride)) nextOverrides.push(nextOverride);
  }

  return {
    ...view,
    layerOverrides: nextOverrides.length > 0 ? nextOverrides : undefined,
  };
}

function hasLayerOverrideValues(override: Partial<VisualLayerOverride>): boolean {
  return (
    override.visible !== undefined ||
    override.target !== undefined ||
    override.representation !== undefined ||
    override.color !== undefined ||
    override.material !== undefined
  );
}

function sameTargetSelector(
  left: StructureTargetSelector,
  right: StructureTargetSelector
): boolean {
  return stableStringify(left) === stableStringify(right);
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
