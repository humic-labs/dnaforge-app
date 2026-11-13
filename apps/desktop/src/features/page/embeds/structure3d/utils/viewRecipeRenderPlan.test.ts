// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { StructureScene } from '../types';
import {
  createAssemblyOverviewRecipe,
  createAtomicDetailRecipe,
  createFocusInContextRecipe,
  createHybridRecipe,
  createIllustrativeRecipe,
  createInterfaceRecipe,
  createQueryInComplexPreviewRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
  createSurfaceDetailRecipe,
} from './viewRecipe';
import {
  setVisualLayerColor,
  setVisualLayerRepresentation,
  setVisualLayerVisibility,
} from './viewLayerOverrides';
import { compileStructureViewRenderPlan } from './viewRecipeRenderPlan';

const SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:mg1655:atpg',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:1FS0:ENTRY',
  queryAnchor: {
    memberId: 'ecoli-atpG',
    targetSelection: {
      pdbId: '1FS0',
      entityIds: ['2'],
      authAsymIds: ['G'],
    },
  },
  activeFocus: {
    memberId: 'ecoli-atpG',
    role: 'query_anchor',
    mappingStatus: 'mapped_current_sequence',
    selection: {
      pdbId: '1FS0',
      entityIds: ['2'],
      authAsymIds: ['G'],
    },
  },
  members: [],
  layers: [],
  provenance: {
    createdBy: 'structure-drawer',
    provider: 'pdb',
  },
};

const PARTNER_FOCUS_SCENE: StructureScene = {
  ...SCENE,
  activeFocus: {
    memberId: 'ecoli-atpC',
    role: 'partner',
    mappingStatus: 'mapped_workspace',
    selection: {
      pdbId: '1FS0',
      entityIds: ['3'],
      authAsymIds: ['E'],
    },
  },
};

describe('view recipe render plan compiler', () => {
  it('compiles Query in Complex into the default cartoon biological render targets', () => {
    const plan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex',
        recipe: createQueryInComplexRecipe(),
        showWater: false,
        spin: false,
      },
      SCENE
    );

    expect(plan.layers.map((layer) => [layer.id, layer.roles])).toEqual([
      ['context-complex-cartoon', ['context']],
      ['query-anchor-cartoon', ['query']],
      ['ligands-ball-and-stick', ['ligand', 'ion']],
    ]);
    expect(plan.contextSurfaceLayer).toBeUndefined();
    expect(plan.wholeStructureSurfaceOverlayLayer).toBeUndefined();
    expect(plan.primaryLayer?.id).toBe('query-anchor-cartoon');
    expect(plan.polymerRoleOverrides).toEqual({
      context: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
      query: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
      unscoped: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
    });
    expect(plan.hasCompletePolymerRoleCoverage).toBe(true);
  });

  it('compiles Surface Context into a whole-structure surface overlay and cartoon roles', () => {
    const plan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex-surface',
        recipe: createQueryInComplexSurfaceRecipe(),
        showWater: false,
        spin: false,
      },
      SCENE
    );

    expect(plan.layers.map((layer) => [layer.id, layer.roles])).toEqual([
      [
        'whole-structure-surface-overlay',
        ['query', 'context', 'unscoped', 'ligand', 'ion', 'water'],
      ],
      ['query-anchor-cartoon', ['query']],
      ['ligands-ball-and-stick', ['ligand', 'ion']],
    ]);
    expect(plan.contextSurfaceLayer).toBeUndefined();
    expect(plan.wholeStructureSurfaceOverlayLayer?.id).toBe('whole-structure-surface-overlay');
    expect(plan.wholeStructureSurfaceOverlayLayer?.typeParams).toEqual({
      alpha: 0.13,
      quality: 'auto',
    });
    expect(plan.primaryLayer?.id).toBe('query-anchor-cartoon');
    expect(plan.polymerRoleOverrides).toEqual({
      query: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
    });
    expect(plan.roleVisibility).toMatchObject({
      query: true,
      context: false,
      unscoped: false,
      ligand: true,
      ion: true,
      water: false,
    });
    expect(plan.hasCompletePolymerRoleCoverage).toBe(false);
  });

  it('compiles candidate preview to gray context cartoons plus colored query cartoons', () => {
    const plan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex-preview',
        recipe: createQueryInComplexPreviewRecipe(),
        showWater: false,
        spin: false,
      },
      SCENE
    );

    expect(plan.layers.map((layer) => [layer.id, layer.roles, layer.representation])).toEqual([
      ['preview-context-complex-cartoon', ['context'], 'cartoon'],
      ['preview-query-anchor-cartoon', ['query'], 'cartoon'],
      ['preview-ligands-ball-and-stick', ['ligand', 'ion'], 'ball-and-stick'],
    ]);
    expect(plan.contextSurfaceLayer).toBeUndefined();
    expect(plan.wholeStructureSurfaceOverlayLayer).toBeUndefined();
    expect(plan.polymerRoleOverrides).toEqual({
      context: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
      query: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
      unscoped: {
        representation: 'cartoon',
        colorMode: 'chain',
      },
    });
    expect(plan.hasCompletePolymerRoleCoverage).toBe(true);
  });

  it('keeps Hybrid as a whole-structure overlay recipe', () => {
    const plan = compileStructureViewRenderPlan({
      schemaVersion: 1,
      activeRecipeId: 'hybrid',
      recipe: createHybridRecipe(),
      showWater: false,
      spin: false,
    });

    expect(plan.wholeStructureSurfaceOverlayLayer?.id).toBe('hybrid-surface-overlay');
    expect(plan.contextSurfaceLayer).toBeUndefined();
    expect(plan.polymerRoleOverrides).toEqual({
      query: { representation: 'cartoon', colorMode: 'chain' },
      context: { representation: 'cartoon', colorMode: 'chain' },
      unscoped: { representation: 'cartoon', colorMode: 'chain' },
    });
  });

  it('does not spread a query-targeted illustrative layer across context polymers', () => {
    const plan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'illustrative',
        recipe: createIllustrativeRecipe({ kind: 'query-anchor' }),
        showWater: false,
        spin: false,
      },
      SCENE
    );

    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]).toMatchObject({
      id: 'illustrative-spacefill',
      roles: ['query'],
      representation: 'illustrative',
      colorMode: 'chain',
      typeParams: {
        ignoreLight: true,
        sizeFactor: 1,
        quality: 'auto',
      },
    });
    expect(plan.polymerRoleOverrides).toEqual({
      query: {
        representation: 'illustrative',
        colorMode: 'chain',
        typeParams: {
          ignoreLight: true,
          sizeFactor: 1,
          quality: 'auto',
        },
      },
    });
    expect(plan.hasCompletePolymerRoleCoverage).toBe(false);
  });

  it('resolves active focus through scene state without rewriting the query anchor target', () => {
    const plan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'focus-context-test',
        recipe: {
          schemaVersion: 1,
          id: 'focus-context-test',
          name: 'Focus Context Test',
          origin: 'generated',
          layers: [
            {
              id: 'focused-member-cartoon',
              target: { kind: 'active-focus' },
              representation: { kind: 'cartoon' },
              color: { mode: 'chain' },
              visible: true,
              order: 10,
            },
            {
              id: 'query-anchor-reference',
              target: { kind: 'query-anchor' },
              representation: { kind: 'surface' },
              color: { mode: 'context-muted' },
              material: { alpha: 0.18 },
              visible: true,
              order: 20,
            },
          ],
        },
        showWater: false,
        spin: false,
      },
      PARTNER_FOCUS_SCENE
    );

    expect(PARTNER_FOCUS_SCENE.queryAnchor.memberId).toBe('ecoli-atpG');
    expect(PARTNER_FOCUS_SCENE.activeFocus?.memberId).toBe('ecoli-atpC');
    expect(plan.layers.map((layer) => [layer.id, layer.roles])).toEqual([
      ['focused-member-cartoon', ['focus']],
      ['query-anchor-reference', ['query']],
    ]);
  });

  it('compiles Focus in Context differently when focus moves from query to partner', () => {
    const queryFocusPlan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'focus-in-context',
        recipe: createFocusInContextRecipe(),
        showWater: false,
        spin: false,
      },
      SCENE
    );
    const partnerFocusPlan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'focus-in-context',
        recipe: createFocusInContextRecipe(),
        showWater: false,
        spin: false,
      },
      PARTNER_FOCUS_SCENE
    );

    expect(queryFocusPlan.polymerRoleOverrides).toMatchObject({
      context: { representation: 'surface', typeParams: { alpha: 0.2 } },
      query: { representation: 'cartoon' },
      unscoped: { representation: 'cartoon' },
    });
    expect(queryFocusPlan.usesActiveFocusTarget).toBe(true);
    expect(partnerFocusPlan.polymerRoleOverrides).toMatchObject({
      query: { representation: 'surface', typeParams: { alpha: 0.18 } },
      context: { representation: 'surface', typeParams: { alpha: 0.2 } },
      focus: { representation: 'cartoon' },
      unscoped: { representation: 'cartoon' },
    });
    expect(partnerFocusPlan.usesActiveFocusTarget).toBe(true);
  });

  it('compiles newer workflow recipes through the same role-render contract', () => {
    const assemblyPlan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'assembly-overview',
        recipe: createAssemblyOverviewRecipe(),
        showWater: false,
        spin: false,
      },
      PARTNER_FOCUS_SCENE
    );
    const interfacePlan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'interface',
        recipe: createInterfaceRecipe(),
        showWater: false,
        spin: false,
      },
      PARTNER_FOCUS_SCENE
    );
    const surfaceDetailPlan = compileStructureViewRenderPlan({
      schemaVersion: 1,
      activeRecipeId: 'surface-detail',
      recipe: createSurfaceDetailRecipe(),
      showWater: false,
      spin: false,
    });
    const atomicDetailPlan = compileStructureViewRenderPlan({
      schemaVersion: 1,
      activeRecipeId: 'atomic-detail',
      recipe: createAtomicDetailRecipe(),
      showWater: false,
      spin: false,
    });

    expect(assemblyPlan.polymerRoleOverrides).toMatchObject({
      context: { representation: 'surface', typeParams: { alpha: 1 } },
      query: { representation: 'cartoon' },
      unscoped: { representation: 'cartoon' },
    });
    expect(interfacePlan.polymerRoleOverrides).toMatchObject({
      context: { representation: 'surface', typeParams: { alpha: 0.1 } },
      query: { representation: 'cartoon' },
      focus: { representation: 'cartoon' },
    });
    expect(surfaceDetailPlan.wholeStructureSurfaceOverlayLayer?.id).toBe('surface-detail-overlay');
    expect(surfaceDetailPlan.polymerRoleOverrides).toMatchObject({
      query: { representation: 'cartoon' },
      context: { representation: 'cartoon' },
      unscoped: { representation: 'cartoon' },
    });
    expect(atomicDetailPlan.polymerRoleOverrides).toMatchObject({
      query: { representation: 'ball-and-stick', colorMode: 'element' },
      context: { representation: 'ball-and-stick', colorMode: 'element' },
      unscoped: { representation: 'ball-and-stick', colorMode: 'element' },
    });
  });

  it('resolves source-default recipe colors once at the render-plan boundary', () => {
    const alphaFoldPlan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'surface-detail',
        recipe: createSurfaceDetailRecipe(),
        showWater: false,
        spin: false,
      },
      undefined,
      { sourceColorContext: { source: 'alphafold', accession: 'P0ABA6' } }
    );
    const pdbPlan = compileStructureViewRenderPlan(
      {
        schemaVersion: 1,
        activeRecipeId: 'surface-detail',
        recipe: createSurfaceDetailRecipe(),
        showWater: false,
        spin: false,
      },
      undefined,
      { sourceColorContext: { source: 'pdb', sourceId: '1FS0' } }
    );

    expect(
      alphaFoldPlan.layers.find((layer) => layer.id === 'surface-detail-cartoon')
    ).toMatchObject({
      colorMode: 'plddt',
      sourceLayer: expect.objectContaining({ color: { mode: 'source-default' } }),
    });
    expect(
      alphaFoldPlan.layers.find((layer) => layer.id === 'surface-detail-overlay')
    ).toMatchObject({
      colorMode: 'plddt',
      sourceLayer: expect.objectContaining({ color: { mode: 'source-default' } }),
    });
    expect(pdbPlan.layers.find((layer) => layer.id === 'surface-detail-cartoon')).toMatchObject({
      colorMode: 'chain',
      sourceLayer: expect.objectContaining({ color: { mode: 'source-default' } }),
    });
  });

  it('turns hidden visual layers into renderer role visibility overrides', () => {
    const view = setVisualLayerVisibility(
      {
        schemaVersion: 1,
        activeRecipeId: 'focus-in-context',
        recipe: createFocusInContextRecipe(),
        showWater: false,
        spin: false,
      },
      'context-complex-surface',
      false
    );
    const plan = compileStructureViewRenderPlan(view, PARTNER_FOCUS_SCENE);

    expect(plan.layers.find((layer) => layer.id === 'context-complex-surface')).toMatchObject({
      visible: false,
      roles: ['context'],
    });
    expect(plan.roleVisibility).toMatchObject({
      context: false,
      focus: true,
      query: true,
      unscoped: true,
    });
    expect(plan.polymerRoleOverrides).toMatchObject({
      query: { representation: 'surface', typeParams: { alpha: 0.18 } },
      focus: { representation: 'cartoon' },
    });
    expect(plan.polymerRoleOverrides).not.toHaveProperty('context');
  });

  it('compiles visual layer representation overrides into role render overrides', () => {
    const view = setVisualLayerRepresentation(
      {
        schemaVersion: 1,
        activeRecipeId: 'focus-in-context',
        recipe: createFocusInContextRecipe(),
        showWater: false,
        spin: false,
      },
      'context-complex-surface',
      'cartoon'
    );
    const plan = compileStructureViewRenderPlan(view, PARTNER_FOCUS_SCENE);

    expect(plan.layers.find((layer) => layer.id === 'context-complex-surface')).toMatchObject({
      representation: 'cartoon',
      roles: ['context'],
    });
    expect(plan.polymerRoleOverrides).toMatchObject({
      context: { representation: 'cartoon', colorMode: 'chain' },
    });
  });

  it('compiles visual layer color overrides into role render overrides', () => {
    const view = setVisualLayerColor(
      {
        schemaVersion: 1,
        activeRecipeId: 'focus-in-context',
        recipe: createFocusInContextRecipe(),
        showWater: false,
        spin: false,
      },
      'context-complex-surface',
      'bfactor'
    );
    const plan = compileStructureViewRenderPlan(view, PARTNER_FOCUS_SCENE);

    expect(plan.layers.find((layer) => layer.id === 'context-complex-surface')).toMatchObject({
      colorMode: 'bfactor',
      roles: ['context'],
    });
    expect(plan.polymerRoleOverrides).toMatchObject({
      context: { representation: 'surface', colorMode: 'bfactor' },
    });
  });
});
