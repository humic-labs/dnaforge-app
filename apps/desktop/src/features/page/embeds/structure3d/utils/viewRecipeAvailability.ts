import type { Structure3dAttrs, ViewRecipe } from '../types';
import {
  createAssemblyOverviewRecipe,
  createQueryInComplexPreviewRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
  createStandardViewRecipes,
  viewRecipeByIdForScene,
} from './viewRecipe';
import { structureVisualizationCapabilitiesFor } from './structureVisualizationCapabilities';

export function availableViewRecipesForStructure(data: Structure3dAttrs | undefined): ViewRecipe[] {
  if (!data) return [];
  const capabilities = structureVisualizationCapabilitiesFor(data);

  if (capabilities.renderIntent === 'preview') {
    return [createQueryInComplexPreviewRecipe()];
  }

  if (capabilities.supportsComplexContext) {
    return [
      createQueryInComplexRecipe(),
      createQueryInComplexSurfaceRecipe(),
      createAssemblyOverviewRecipe(),
      viewRecipeByIdForScene('illustrative', data.scene),
      viewRecipeByIdForScene('ball-and-stick', data.scene),
    ];
  }

  return createStandardViewRecipes();
}

export function supportsConfidenceRecipe(data: Structure3dAttrs | undefined): boolean {
  return structureVisualizationCapabilitiesFor(data).scoreColorModes.includes('plddt');
}

export function supportsQueryInComplexRecipe(data: Structure3dAttrs | undefined): boolean {
  return structureVisualizationCapabilitiesFor(data).supportsComplexContext;
}

export function supportsFocusInContextRecipe(data: Structure3dAttrs | undefined): boolean {
  if (!supportsQueryInComplexRecipe(data)) return false;
  return (data?.scene?.members.length ?? 0) > 1;
}
