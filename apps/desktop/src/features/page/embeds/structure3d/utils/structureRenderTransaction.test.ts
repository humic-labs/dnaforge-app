// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ChainSequence, StructureScene, StructureViewState } from '../types';
import {
  createQueryInComplexPreviewRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
  createSurfaceDetailRecipe,
  viewRecipeByIdForScene,
} from './viewRecipe';
import {
  createStructureRenderModel,
  STRUCTURE_CONTEXT_MOLSTAR_COLOR,
} from './structureRenderModel';
import {
  compileStructureRenderTransaction,
  transactionSurfaceLayerKeys,
} from './structureRenderTransaction';

const CHAINS: ChainSequence[] = [
  chainSequence('G', '2', { authAsymId: 'G' }),
  chainSequence('Q', '2', { authAsymId: 'Q' }),
  chainSequence('A', '1', { authAsymId: 'A' }),
];

const SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:mg1655:atpG:6OQR',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:6OQR:ENTRY',
  queryAnchor: {
    memberId: 'member:atpG',
    label: 'atpG',
    targetSelection: {
      providerIdentityKey: 'RCSB:6OQR:ENTRY',
      pdbId: '6OQR',
      entityIds: ['2'],
      authAsymIds: ['G', 'Q'],
    },
  },
  activeFocus: {
    memberId: 'member:atpG',
    role: 'query_anchor',
    mappingStatus: 'mapped_current_sequence',
    selection: {
      providerIdentityKey: 'RCSB:6OQR:ENTRY',
      pdbId: '6OQR',
      entityIds: ['2'],
      authAsymIds: ['G', 'Q'],
    },
  },
  members: [
    {
      memberId: 'member:atpG',
      kind: 'protein',
      displayName: 'ATP synthase gamma chain',
      pdbEntityId: '2',
      authAsymIds: ['G', 'Q'],
      selection: {
        providerIdentityKey: 'RCSB:6OQR:ENTRY',
        pdbId: '6OQR',
        entityIds: ['2'],
        authAsymIds: ['G', 'Q'],
      },
      identifiers: { geneNames: ['atpG'] },
      relationToAnchor: 'query',
      mappingStatus: 'mapped_current_sequence',
    },
    {
      memberId: 'member:atpA',
      kind: 'protein',
      displayName: 'ATP synthase alpha chain',
      pdbEntityId: '1',
      authAsymIds: ['A'],
      selection: {
        providerIdentityKey: 'RCSB:6OQR:ENTRY',
        pdbId: '6OQR',
        entityIds: ['1'],
        authAsymIds: ['A'],
      },
      identifiers: { geneNames: ['atpA'] },
      relationToAnchor: 'known_partner',
      mappingStatus: 'mapped_workspace',
    },
  ],
  layers: [],
  provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
};

describe('structure render transaction compiler', () => {
  it('makes preview cartoon-only by construction', () => {
    const view = viewState('query-in-complex-preview');
    const renderModel = createStructureRenderModel({
      chains: CHAINS,
      scene: SCENE,
      view,
    });
    const transaction = compileStructureRenderTransaction({
      scene: SCENE,
      view,
      renderModel,
    });

    expect(transaction.renderIntent).toBe('preview');
    expect(transaction.planHash).toMatch(/^wprtx_/);
    expect(transaction.invariants.previewAllowsSurface).toBe(false);
    expect(transaction.layers.every((layer) => layer.representation !== 'surface')).toBe(true);
    expect(transaction.canvas.outlineEnabled).toBe(false);
    expect(transaction.canvas.aoEnabled).toBe(false);
    expect(transaction.molstar.representations.every((repr) => repr.kind !== 'surface')).toBe(true);
    expect(
      transaction.table.rows.map((row) => [
        row.chainInstanceId,
        row.displayChainId,
        row.detailVisible,
      ])
    ).toEqual([
      [chainInstanceIdByAuth(renderModel, 'G'), 'G', true],
      [chainInstanceIdByAuth(renderModel, 'Q'), 'Q', true],
      [chainInstanceIdByAuth(renderModel, 'A'), 'A', false],
    ]);
  });

  it('uses one transaction source of truth for table and MolStar chain colors', () => {
    const view = {
      ...viewState('query-in-complex'),
      residueVisualization: {
        sideChains: {
          visibleBackbones: true,
          selection: true,
        },
      },
    };
    const renderModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE, view });
    const transaction = compileStructureRenderTransaction({
      scene: SCENE,
      view,
      renderModel,
      expectedPaletteId: 'fixture:atpg-6oqr:query-in-complex',
    });

    expect(transaction.expectedPaletteId).toBe('fixture:atpg-6oqr:query-in-complex');
    expect(transaction.table.expectedPaletteId).toBe('fixture:atpg-6oqr:query-in-complex');
    expect(transaction.molstar.expectedPaletteId).toBe('fixture:atpg-6oqr:query-in-complex');
    expect(transaction.table.sourcePaletteId).toBe(transaction.molstar.sourcePaletteId);
    expect(transaction.controls.sideChains).toEqual({
      visibleBackbones: true,
      selection: true,
    });
    expect(
      transaction.table.rows.map((row) => [row.chainInstanceId, row.displayMolstarColor])
    ).toEqual([
      [chainInstanceIdByAuth(renderModel, 'G'), 0xe6194b],
      [chainInstanceIdByAuth(renderModel, 'Q'), 0x2ca02c],
      [chainInstanceIdByAuth(renderModel, 'A'), STRUCTURE_CONTEXT_MOLSTAR_COLOR],
    ]);
    expect(transaction.molstar.chainColors).toEqual(transaction.table.chainColors);
  });

  it('keeps chain-instance colors stable across uncheck and re-check ordering', () => {
    const defaultModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const g = chainInstanceIdByAuth(defaultModel, 'G');
    const q = chainInstanceIdByAuth(defaultModel, 'Q');
    const a = chainInstanceIdByAuth(defaultModel, 'A');
    const first = compileForQueryContext([g, a]);
    const second = compileForQueryContext([a]);
    const third = compileForQueryContext([a, g]);

    expect(colorForChain(first, g)).toBe(0xe6194b);
    expect(colorForChain(first, a)).toBe(0x1f77ff);
    expect(colorForChain(second, g)).toBe(STRUCTURE_CONTEXT_MOLSTAR_COLOR);
    expect(colorForChain(third, g)).toBe(0xe6194b);
    expect(colorForChain(third, a)).toBe(0x1f77ff);
    expect(colorForChain(third, q)).toBe(STRUCTURE_CONTEXT_MOLSTAR_COLOR);
  });

  it('keeps Surface Context as one stable broad gray surface layer plus selected cartoons', () => {
    const defaultModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const selectedChainInstanceId = chainInstanceIdByAuth(defaultModel, 'G');
    const view = viewState('query-in-complex-surface', {
      detailChainInstanceIds: [selectedChainInstanceId],
    });
    const renderModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE, view });
    const transaction = compileStructureRenderTransaction({
      scene: SCENE,
      view,
      renderModel,
    });

    expect(transaction.renderIntent).toBe('loaded');
    expect(transaction.invariants.previewAllowsSurface).toBe(false);
    expect(transaction.layers.filter((layer) => layer.representation === 'surface')).toEqual([
      expect.objectContaining({
        layerId: 'whole-structure-surface-overlay',
        targetKind: 'whole-structure',
        color: {
          mode: 'context-muted',
          resolvedMode: 'chain',
          resolvedMolstarColor: STRUCTURE_CONTEXT_MOLSTAR_COLOR,
        },
        material: expect.objectContaining({ alpha: 0.13, quality: 'auto' }),
      }),
    ]);
    expect(transactionSurfaceLayerKeys(transaction)).toEqual([
      'layer:whole-structure-surface-overlay|target:whole-structure|repr:surface|color:context-muted|alpha:0.13',
    ]);
    expect(transaction.table.rows.map((row) => [row.chainInstanceId, row.detailVisible])).toEqual([
      [chainInstanceIdByAuth(renderModel, 'G'), true],
      [chainInstanceIdByAuth(renderModel, 'Q'), false],
      [chainInstanceIdByAuth(renderModel, 'A'), false],
    ]);
  });

  it('does not change broad surface identity when chain detail selection changes', () => {
    const defaultModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const first = compileForSurfaceContext([chainInstanceIdByAuth(defaultModel, 'G')]);
    const second = compileForSurfaceContext([chainInstanceIdByAuth(defaultModel, 'Q')]);

    expect(transactionSurfaceLayerKeys(first)).toEqual(transactionSurfaceLayerKeys(second));
    expect(first.planHash).not.toBe(second.planHash);
    expect(first.table.rows.map((row) => [row.chainInstanceId, row.detailVisible])).toEqual([
      [chainInstanceIdByAuth(defaultModel, 'G'), true],
      [chainInstanceIdByAuth(defaultModel, 'Q'), false],
      [chainInstanceIdByAuth(defaultModel, 'A'), false],
    ]);
    expect(second.table.rows.map((row) => [row.chainInstanceId, row.detailVisible])).toEqual([
      [chainInstanceIdByAuth(defaultModel, 'G'), false],
      [chainInstanceIdByAuth(defaultModel, 'Q'), true],
      [chainInstanceIdByAuth(defaultModel, 'A'), false],
    ]);
  });

  it('keeps source-default semantic color out of the MolStar executable transaction plan', () => {
    const view: StructureViewState = {
      schemaVersion: 1,
      activeRecipeId: 'surface-detail',
      recipe: createSurfaceDetailRecipe(),
      renderIntent: 'loaded',
      showWater: false,
      spin: false,
    };
    const transaction = compileStructureRenderTransaction({
      scene: SCENE,
      view,
      renderModel: createStructureRenderModel({ chains: CHAINS, scene: SCENE, view }),
      sourceColorContext: { source: 'alphafold', accession: 'P0ABA6' },
    });

    expect(
      transaction.layers.find((layer) => layer.layerId === 'surface-detail-cartoon')
    ).toMatchObject({
      color: { mode: 'source-default', resolvedMode: 'plddt' },
    });
    expect(
      transaction.molstar.representations
        .filter((representation) => representation.layerId === 'surface-detail-cartoon')
        .map((representation) => [representation.role, representation.colorMode])
    ).toEqual([
      ['query', 'plddt'],
      ['context', 'chain'],
      ['unscoped', 'plddt'],
      ['ligand', 'plddt'],
      ['ion', 'plddt'],
      ['water', 'plddt'],
    ]);
    expect(
      transaction.molstar.representations.some(
        (representation) => representation.colorMode === 'source-default'
      )
    ).toBe(false);
  });

  it('forces executable context polymer roles through gray context color even for Atomic Detail', () => {
    const atomicDetailRecipe = viewRecipeByIdForScene('ball-and-stick', SCENE);
    expect(
      atomicDetailRecipe.layers.find((layer) => layer.target.kind === 'whole-complex')?.color
    ).toEqual({ mode: 'context-muted' });
    const malformedSavedRecipe = {
      ...atomicDetailRecipe,
      layers: atomicDetailRecipe.layers.map((layer) =>
        layer.target.kind === 'whole-complex'
          ? { ...layer, color: { mode: 'element' as const } }
          : layer
      ),
    };
    const view: StructureViewState = {
      schemaVersion: 1,
      activeRecipeId: 'ball-and-stick',
      recipe: malformedSavedRecipe,
      renderIntent: 'loaded',
      detailMemberIds: ['member:atpG'],
      showWater: false,
      spin: false,
    };
    const transaction = compileStructureRenderTransaction({
      scene: SCENE,
      view,
      renderModel: createStructureRenderModel({ chains: CHAINS, scene: SCENE, view }),
    });

    expect(
      transaction.layers.find(
        (layer) => layer.layerId === 'ball-and-stick-context-complex-ball-and-stick'
      )
    ).toMatchObject({
      color: { mode: 'element', resolvedMode: 'element' },
    });
    expect(
      transaction.molstar.representations.filter(
        (representation) => representation.role === 'context'
      )
    ).toEqual([
      expect.objectContaining({
        layerId: 'ball-and-stick-context-complex-ball-and-stick',
        kind: 'ball-and-stick',
        colorMode: 'chain',
        resolvedMolstarColor: STRUCTURE_CONTEXT_MOLSTAR_COLOR,
      }),
    ]);
    expect(
      transaction.molstar.representations.filter(
        (representation) => representation.role === 'query'
      )
    ).toEqual([
      expect.objectContaining({
        layerId: 'ball-and-stick-query-anchor-ball-and-stick',
        kind: 'ball-and-stick',
        colorMode: 'element',
      }),
    ]);
  });
});

function compileForSurfaceContext(detailChainInstanceIds: string[]) {
  const view = viewState('query-in-complex-surface', { detailChainInstanceIds });
  return compileStructureRenderTransaction({
    scene: SCENE,
    view,
    renderModel: createStructureRenderModel({ chains: CHAINS, scene: SCENE, view }),
  });
}

function compileForQueryContext(detailChainInstanceIds: string[]) {
  const view = viewState('query-in-complex', { detailChainInstanceIds });
  return compileStructureRenderTransaction({
    scene: SCENE,
    view,
    renderModel: createStructureRenderModel({ chains: CHAINS, scene: SCENE, view }),
  });
}

function colorForChain(
  transaction: ReturnType<typeof compileStructureRenderTransaction>,
  chainInstanceId: string
): number | null {
  return transaction.molstar.chainColors[chainInstanceId] ?? null;
}

function chainInstanceIdByAuth(
  model: ReturnType<typeof createStructureRenderModel>,
  authAsymId: string
): string {
  const row = model.chainRows.find((candidate) => candidate.chain.authAsymId === authAsymId);
  if (!row) throw new Error(`Missing chain with auth_asym_id ${authAsymId}`);
  return row.chainInstanceId;
}

function viewState(
  recipeId: 'query-in-complex' | 'query-in-complex-preview' | 'query-in-complex-surface',
  overrides: Partial<StructureViewState> = {}
): StructureViewState {
  const recipe =
    recipeId === 'query-in-complex-preview'
      ? createQueryInComplexPreviewRecipe()
      : recipeId === 'query-in-complex-surface'
        ? createQueryInComplexSurfaceRecipe()
        : createQueryInComplexRecipe();

  return {
    schemaVersion: 1,
    activeRecipeId: recipeId,
    recipe,
    renderIntent: recipeId === 'query-in-complex-preview' ? 'preview' : 'loaded',
    detailMemberIds: ['member:atpG'],
    showWater: false,
    spin: false,
    ...overrides,
  };
}

function chainSequence(
  chainId: string,
  entityId: string,
  options: { authAsymId: string }
): ChainSequence {
  return {
    chainId,
    chainLabel: `Chain ${options.authAsymId}`,
    baseChain: chainId,
    labelAsymId: chainId,
    authAsymId: options.authAsymId,
    entityId,
    sequence: 'M'.repeat(10),
    residues: Array.from({ length: 10 }, (_, index) => ({
      position: index + 1,
      name: 'M',
      name3: 'MET',
      value: 90,
    })),
  };
}
