import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChainSequence, StructureScene, StructureViewState } from '../types';
import {
  createStructureRenderModel,
  STRUCTURE_CONTEXT_MOLSTAR_COLOR,
} from '../utils/structureRenderModel';
import { compileStructureRenderTransaction } from '../utils/structureRenderTransaction';
import {
  createIllustrativeRecipe,
  createQueryInComplexRecipe,
  createQueryInComplexSurfaceRecipe,
} from '../utils/viewRecipe';
import {
  compileMolstarRenderPlanFromTransaction,
  molstarRenderPlanApplyKeys,
} from './molstarRenderPlan';

const CHAINS: ChainSequence[] = [
  chainSequence('G', '2', { authAsymId: 'G' }),
  chainSequence('Q', '2', { authAsymId: 'Q' }),
  chainSequence('A', '1', { authAsymId: 'A' }),
];

const SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:mg1655:atpG:3OAA',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:3OAA:ENTRY',
  queryAnchor: {
    memberId: 'member:atpG',
    label: 'atpG',
    targetSelection: {
      providerIdentityKey: 'RCSB:3OAA:ENTRY',
      pdbId: '3OAA',
      entityIds: ['2'],
      authAsymIds: ['G', 'Q'],
    },
  },
  activeFocus: {
    memberId: 'member:atpG',
    role: 'query_anchor',
    mappingStatus: 'mapped_current_sequence',
    selection: {
      providerIdentityKey: 'RCSB:3OAA:ENTRY',
      pdbId: '3OAA',
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
        providerIdentityKey: 'RCSB:3OAA:ENTRY',
        pdbId: '3OAA',
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
        providerIdentityKey: 'RCSB:3OAA:ENTRY',
        pdbId: '3OAA',
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

describe('MolStar render plan compiler', () => {
  it('compiles exact detail chain selectors and context exclusion from transaction rows', () => {
    const baseModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const selectedG = chainInstanceIdByAuth(baseModel, 'G');
    const selectedA = chainInstanceIdByAuth(baseModel, 'A');
    const transaction = compileTransaction(queryInComplexView([selectedG, selectedA]));

    const plan = compileMolstarRenderPlanFromTransaction(transaction, { scene: SCENE });

    expect(plan.schemaVersion).toBe(1);
    expect(plan.namespace).toBe('waypoint.structure3d');
    expect(plan.planHash).toBe(transaction.planHash);
    expect(
      plan.detailChainTargets?.map((target) => [target.targetId, target.visible, target.color])
    ).toEqual([
      [selectedG, true, 0xe6194b],
      [chainInstanceIdByAuth(baseModel, 'Q'), false, 0x2ca02c],
      [selectedA, true, 0x1f77ff],
    ]);
    expect(plan.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'waypoint.structure3d.component.detail-context-polymer',
          role: 'detail-context-polymer',
          selector: {
            kind: 'polymer-context-excluding-detail',
            excludedChainInstanceIds: [selectedG, selectedA],
            includedChainInstanceIds: [chainInstanceIdByAuth(baseModel, 'Q')],
          },
        }),
        expect.objectContaining({
          tag: `waypoint.structure3d.component.detail-chain-polymer.${selectedA}`,
          role: 'detail-chain-polymer',
          selector: expect.objectContaining({
            kind: 'polymer-chain-instance',
            chainInstanceId: selectedA,
            selection: {
              pdbId: '3OAA',
              entityIds: ['1'],
              labelAsymIds: ['A'],
              authAsymIds: ['A'],
              chainIds: ['A'],
            },
          }),
          visible: true,
        }),
      ])
    );
  });

  it('derives executor inputs from the plan, not from retired viewer props', () => {
    const baseModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const selectedG = chainInstanceIdByAuth(baseModel, 'G');
    const transaction = compileTransaction(queryInComplexSurfaceView([selectedG]));
    const plan = compileMolstarRenderPlanFromTransaction(transaction, {
      scene: SCENE,
      uniprotId: 'P0ABA6',
    });

    expect(plan.defaults).toMatchObject({
      representation: 'cartoon',
      colorMode: 'chain',
      uniprotId: 'P0ABA6',
    });
    expect(plan.controls).toMatchObject({ showWater: true, spin: true });
    expect(plan.surfaceOverlay).toMatchObject({
      enabled: true,
      colorMode: 'context-muted',
      targetScope: 'broad',
    });
    expect(plan.componentSync.scene).toBe(SCENE);
    expect(
      plan.componentSync.detailChainTargets?.map((target) => [target.targetId, target.visible])
    ).toEqual([
      [selectedG, true],
      [chainInstanceIdByAuth(baseModel, 'Q'), false],
      [chainInstanceIdByAuth(baseModel, 'A'), false],
    ]);
    expect(plan.color.chainColorPalette).toEqual([0xe6194b, 0x2ca02c, 0x1f77ff]);
  });

  it('partitions apply keys so chain toggles do not recompute broad representation or surface', () => {
    const baseModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const g = chainInstanceIdByAuth(baseModel, 'G');
    const a = chainInstanceIdByAuth(baseModel, 'A');
    const first = compileMolstarRenderPlanFromTransaction(
      compileTransaction(queryInComplexSurfaceView([g])),
      { scene: SCENE }
    );
    const second = compileMolstarRenderPlanFromTransaction(
      compileTransaction(queryInComplexSurfaceView([g, a])),
      { scene: SCENE }
    );
    const firstKeys = molstarRenderPlanApplyKeys(first);
    const secondKeys = molstarRenderPlanApplyKeys(second);

    expect(secondKeys.representation).toBe(firstKeys.representation);
    expect(secondKeys.surfaceOverlay).toBe(firstKeys.surfaceOverlay);
    expect(secondKeys.detailComponents).not.toBe(firstKeys.detailComponents);
  });

  it('keeps selected chains detail-colored and unselected chains context-gray through Illustrative plan compilation', () => {
    const baseModel = createStructureRenderModel({ chains: CHAINS, scene: SCENE });
    const g = chainInstanceIdByAuth(baseModel, 'G');
    const a = chainInstanceIdByAuth(baseModel, 'A');
    const transaction = compileTransaction(illustrativeView([g, a]));
    const plan = compileMolstarRenderPlanFromTransaction(transaction, { scene: SCENE });

    expect(plan.defaults.representation).toBe('illustrative');
    expect(plan.rolePlan.polymerOverrides).toMatchObject({
      context: { representation: 'illustrative', colorMode: 'chain' },
    });
    expect(
      Object.fromEntries(plan.detailChainTargets!.map((target) => [target.targetId, target.color]))
    ).toMatchObject({
      [g]: 0xe6194b,
      [a]: 0x1f77ff,
      [chainInstanceIdByAuth(baseModel, 'Q')]: 0x2ca02c,
    });
    expect(
      transaction.table.rows.find(
        (row) => row.chainInstanceId === chainInstanceIdByAuth(baseModel, 'Q')
      )
    ).toMatchObject({
      detailVisible: false,
      displayMolstarColor: STRUCTURE_CONTEXT_MOLSTAR_COLOR,
    });
  });
});

describe('MolStar render authority guard', () => {
  it('keeps MolstarViewer from importing retired MolStar writer modules directly', () => {
    const source = readFileSync(resolve(__dirname, '../MolstarViewer.tsx'), 'utf8');
    const executorSource = readFileSync(resolve(__dirname, './applyMolstarRenderPlan.ts'), 'utf8');
    const retiredWriter = `${'apply'}Representation`;
    const retiredStyleBridge = `${'viewer'}Style${'Reconciler'}`;
    const retiredScene = `${'scene'}Reconciler`;

    expect(source).not.toMatch(new RegExp(`from ['"]\\.\\/molstar\\/${retiredWriter}['"]`));
    expect(source).not.toMatch(/from ['"]\.\/molstar\/surfaceOverlay['"]/);
    expect(source).not.toMatch(new RegExp(`from ['"]\\.\\/molstar\\/${retiredStyleBridge}['"]`));
    expect(executorSource).not.toMatch(new RegExp(`from ['"]\\.\\/${retiredWriter}['"]`));
    expect(executorSource).not.toMatch(new RegExp(`from ['"]\\.\\/${retiredStyleBridge}['"]`));
    expect(existsSync(resolve(__dirname, `./${retiredWriter}.ts`))).toBe(false);
    expect(existsSync(resolve(__dirname, `./${retiredStyleBridge}.ts`))).toBe(false);
    expect(existsSync(resolve(__dirname, `./${retiredScene}.ts`))).toBe(false);
  });
});

function compileTransaction(view: StructureViewState) {
  return compileStructureRenderTransaction({
    scene: SCENE,
    view,
    renderModel: createStructureRenderModel({ chains: CHAINS, scene: SCENE, view }),
  });
}

function queryInComplexView(detailChainInstanceIds: string[]): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: 'query-in-complex',
    recipe: createQueryInComplexRecipe(),
    detailChainInstanceIds,
    showWater: false,
    spin: false,
  };
}

function queryInComplexSurfaceView(detailChainInstanceIds: string[]): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: 'query-in-complex-surface',
    recipe: createQueryInComplexSurfaceRecipe(),
    detailChainInstanceIds,
    showWater: true,
    spin: true,
  };
}

function illustrativeView(detailChainInstanceIds: string[]): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: 'illustrative',
    recipe: createIllustrativeRecipe({ kind: 'whole-complex' }),
    detailChainInstanceIds,
    showWater: false,
    spin: false,
  };
}

function chainInstanceIdByAuth(
  model: ReturnType<typeof createStructureRenderModel>,
  authAsymId: string
): string {
  const row = model.chainRows.find((candidate) => candidate.chain.authAsymId === authAsymId);
  if (!row) throw new Error(`Missing chain with auth_asym_id ${authAsymId}`);
  return row.chainInstanceId;
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
