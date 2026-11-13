// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Structure3dAttrs, StructureScene } from '../types';
import {
  attrsPatchFromStructureViewState,
  createQueryInComplexRecipe,
  createHybridRecipe,
  createIllustrativeRecipe,
  createStandardViewRecipes,
  createSpacefillRecipe,
  BUILT_IN_VIEW_RECIPES,
  structureViewStateFromAttrs,
  viewRecipeByIdForScene,
  viewWithGlobalColorMode,
} from './viewRecipe';

const SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene-1',
  sceneKind: 'complex',
  queryAnchor: {
    memberId: 'query',
    label: 'Query',
    targetSelection: { pdbId: '1ABC', authAsymIds: ['A'] },
  },
  activeFocus: { memberId: 'query', label: 'Query' },
  members: [
    {
      memberId: 'query',
      kind: 'protein',
      displayName: 'Query',
      selection: { pdbId: '1ABC', authAsymIds: ['A'] },
    },
    {
      memberId: 'context',
      kind: 'protein',
      displayName: 'Context',
      selection: { pdbId: '1ABC', authAsymIds: ['B'] },
    },
  ],
};

describe('viewRecipe', () => {
  it('keeps shipped primitive recipes while excluding legacy shortcut presets', () => {
    const standardRecipeIds = createStandardViewRecipes().map((recipe) => recipe.id);
    const builtInRecipeIds = BUILT_IN_VIEW_RECIPES.map((recipe) => recipe.id);
    const legacyPresetIds = ['surface-detail', 'atomic-detail', 'confidence'];

    expect(standardRecipeIds).toEqual([
      'cartoon',
      'ball-and-stick',
      'spacefill',
      'surface',
      'illustrative',
      'hybrid',
    ]);
    expect(builtInRecipeIds).toEqual(
      expect.arrayContaining([
        'cartoon',
        'ball-and-stick',
        'spacefill',
        'surface',
        'illustrative',
        'hybrid',
      ])
    );
    for (const legacyPresetId of legacyPresetIds) {
      expect(builtInRecipeIds).not.toContain(legacyPresetId);
    }
  });

  it('creates built-in styles as complete recipes', () => {
    const hybrid = createHybridRecipe();
    const illustrative = createIllustrativeRecipe();
    const spacefill = createSpacefillRecipe();

    expect(hybrid).toMatchObject({
      schemaVersion: 1,
      id: 'hybrid',
      origin: 'builtin',
    });
    expect(hybrid.layers.map((layer) => layer.representation.kind)).toEqual(['cartoon', 'surface']);
    expect(illustrative.layers[0]).toMatchObject({
      target: { kind: 'whole-structure' },
      representation: { kind: 'illustrative' },
    });
    expect(spacefill.layers[0]).toMatchObject({
      target: { kind: 'whole-structure' },
      representation: { kind: 'spacefill' },
      color: { mode: 'element' },
    });
  });

  it('creates complex-aware recipes for style ids', () => {
    const recipe = viewRecipeByIdForScene('illustrative', SCENE);

    expect(recipe).toMatchObject({
      id: 'illustrative',
      name: 'Styled Spacefill',
      origin: 'builtin',
    });
    expect(recipe.layers.map((layer) => layer.target.kind)).toEqual([
      'whole-complex',
      'query-anchor',
      'member-kind',
    ]);
  });

  it('defaults missing view attrs to a recipe-shaped StructureViewState', () => {
    const attrs = {
      source: 'pdb',
      sourceId: '1ABC',
      cameraSnapshot: '{"radius":10}',
    } as Structure3dAttrs;

    const view = structureViewStateFromAttrs(attrs);

    expect(view.activeRecipeId).toBe('cartoon');
    expect(view.recipe.id).toBe('cartoon');
    expect(view.cameraSnapshot).toBe('{"radius":10}');
  });

  it('emits only the canonical view attr for runtime updates', () => {
    const view = viewWithGlobalColorMode(
      structureViewStateFromAttrs({} as Structure3dAttrs),
      'plddt'
    );
    const patch = attrsPatchFromStructureViewState(view);

    expect(Object.keys(patch)).toEqual(['view']);
    expect(patch.view.recipe.layers[0].color.mode).toBe('plddt');
  });

  it('recolors polymer detail layers while preserving muted context and element ligand layers', () => {
    const baseView = {
      schemaVersion: 1 as const,
      activeRecipeId: 'query-in-complex',
      recipe: createQueryInComplexRecipe(),
      showWater: false,
      spin: false,
    };

    const elementView = viewWithGlobalColorMode(baseView, 'element');
    const restoredView = viewWithGlobalColorMode(
      {
        ...elementView,
        layerOverrides: [
          { layerId: 'query-anchor-cartoon', color: { mode: 'element' } },
          { layerId: 'ligands-ball-and-stick', color: { mode: 'element' } },
        ],
      },
      'bfactor'
    );
    const colorByLayerId = new Map(
      restoredView.recipe.layers.map((layer) => [layer.id, layer.color.mode])
    );

    expect(colorByLayerId.get('context-complex-cartoon')).toBe('context-muted');
    expect(colorByLayerId.get('query-anchor-cartoon')).toBe('bfactor');
    expect(colorByLayerId.get('ligands-ball-and-stick')).toBe('element');
    expect(restoredView.layerOverrides).toEqual([
      { layerId: 'query-anchor-cartoon', color: { mode: 'bfactor' } },
      { layerId: 'ligands-ball-and-stick', color: { mode: 'element' } },
    ]);
  });
});
