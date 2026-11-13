// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ChainSequence, StructureScene } from '../types';
import {
  createStructureRenderModel,
  STRUCTURE_CONTEXT_COLOR,
  STRUCTURE_CONTEXT_MOLSTAR_COLOR,
  structureViewStateForScene,
} from './structureRenderModel';
import { viewRecipeByIdForScene } from './viewRecipe';

const CHAINS: ChainSequence[] = [
  chainSequence('G', '2', 'ATP synthase gamma chain'),
  chainSequence('E', '1', 'ATP synthase epsilon chain'),
];

const COMPLEX_SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:mg1655:atpG:1FS0',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:1FS0:ENTRY',
  queryAnchor: {
    memberId: 'member:atpG',
    label: 'atpG',
    targetSelection: {
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      entityIds: ['2'],
      authAsymIds: ['G'],
    },
  },
  activeFocus: {
    memberId: 'member:atpG',
    role: 'query_anchor',
    mappingStatus: 'mapped_current_sequence',
    selection: {
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      entityIds: ['2'],
      authAsymIds: ['G'],
    },
  },
  members: [
    {
      memberId: 'member:atpG',
      kind: 'protein',
      displayName: 'ATP synthase gamma chain',
      pdbEntityId: '2',
      authAsymIds: ['G'],
      selection: {
        providerIdentityKey: 'RCSB:1FS0:ENTRY',
        pdbId: '1FS0',
        entityIds: ['2'],
        authAsymIds: ['G'],
      },
      relationToAnchor: 'query',
      mappingStatus: 'mapped_current_sequence',
    },
    {
      memberId: 'member:atpC',
      kind: 'protein',
      displayName: 'ATP synthase epsilon chain',
      pdbEntityId: '1',
      authAsymIds: ['E'],
      selection: {
        providerIdentityKey: 'RCSB:1FS0:ENTRY',
        pdbId: '1FS0',
        entityIds: ['1'],
        authAsymIds: ['E'],
      },
      relationToAnchor: 'known_partner',
      mappingStatus: 'mapped_workspace',
    },
  ],
  layers: [],
  provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
};

describe('structure render model', () => {
  it('is the shared source of truth for table colors, detail ids, and Molstar palette', () => {
    const view = structureViewStateForScene({
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      scene: COMPLEX_SCENE,
    });

    const model = createStructureRenderModel({
      chains: CHAINS,
      scene: COMPLEX_SCENE,
      view,
    });

    expect(view.activeRecipeId).toBe('query-in-complex');
    expect(model.detailMemberIds).toEqual(['member:atpG']);
    expect(model.molstarPalette).toEqual([0xe6194b, 0x2ca02c]);
    expect(
      model.chainRows.map((row) => [row.chain.chainId, row.detailState, row.displayColor])
    ).toEqual([
      ['G', 'detail', '#e6194b'],
      ['E', 'context', STRUCTURE_CONTEXT_COLOR],
    ]);
    expect(model.chainRows.map((row) => [row.chain.chainId, row.displayMolstarColor])).toEqual([
      ['G', 0xe6194b],
      ['E', STRUCTURE_CONTEXT_MOLSTAR_COLOR],
    ]);
  });

  it('preserves user-selected detail members when defaulting a complex scene to Query in Complex', () => {
    const view = structureViewStateForScene({
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      scene: COMPLEX_SCENE,
      view: {
        schemaVersion: 1,
        activeRecipeId: 'cartoon',
        recipe: {
          schemaVersion: 1,
          id: 'cartoon',
          name: 'Cartoon',
          origin: 'builtin',
          layers: [],
        },
        detailMemberIds: ['member:atpG', 'member:atpC'],
        showWater: false,
        spin: false,
      },
    });

    expect(view).toMatchObject({
      activeRecipeId: 'query-in-complex',
      detailMemberIds: ['member:atpG', 'member:atpC'],
    });
  });

  it('does not promote an already complex-aware Cartoon recipe into Query in Complex', () => {
    const view = structureViewStateForScene({
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      scene: COMPLEX_SCENE,
      view: {
        schemaVersion: 1,
        activeRecipeId: 'cartoon',
        recipe: viewRecipeByIdForScene('cartoon', COMPLEX_SCENE),
        detailMemberIds: ['member:atpG'],
        detailChainInstanceIds: ['g-2-g'],
        showWater: false,
        spin: false,
      },
    });

    expect(view).toMatchObject({
      activeRecipeId: 'cartoon',
      detailMemberIds: ['member:atpG'],
      detailChainInstanceIds: ['g-2-g'],
    });
    expect(view.recipe.layers.map((layer) => layer.target.kind)).toEqual([
      'whole-complex',
      'query-anchor',
      'member-kind',
    ]);
  });

  it('promotes stale Query in Complex surface recipes into the explicit Surface Context recipe', () => {
    const view = structureViewStateForScene({
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      scene: COMPLEX_SCENE,
      view: {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex',
        recipe: {
          schemaVersion: 1,
          id: 'query-in-complex',
          name: 'Query in Complex',
          origin: 'builtin',
          layers: [
            {
              id: 'context-complex-surface',
              target: { kind: 'whole-complex' },
              representation: { kind: 'surface' },
              color: { mode: 'context-muted' },
              material: { alpha: 0.13, quality: 'auto' },
              visible: true,
              order: 10,
            },
          ],
        },
        detailMemberIds: ['member:atpG'],
        showWater: false,
        spin: false,
      },
    });

    expect(view).toMatchObject({
      activeRecipeId: 'query-in-complex-surface',
      recipe: {
        id: 'query-in-complex-surface',
        layers: expect.arrayContaining([
          expect.objectContaining({
            id: 'whole-structure-surface-overlay',
            target: { kind: 'whole-structure' },
            material: expect.objectContaining({ alpha: 0.13 }),
          }),
        ]),
      },
      detailMemberIds: ['member:atpG'],
    });
  });

  it('uses a cartoon-only complex preview view while keeping query detail state', () => {
    const view = structureViewStateForScene(
      {
        source: 'pdb',
        sourceId: 'RCSB:1FS0:ENTRY',
        providerIdentityKey: 'RCSB:1FS0:ENTRY',
        pdbId: '1FS0',
        scene: COMPLEX_SCENE,
      },
      { renderIntent: 'preview' }
    );

    const model = createStructureRenderModel({
      chains: CHAINS,
      scene: COMPLEX_SCENE,
      view,
    });

    expect(view.activeRecipeId).toBe('query-in-complex-preview');
    expect(view.recipe.layers.some((layer) => layer.representation.kind === 'surface')).toBe(false);
    expect(model.detailMemberIds).toEqual(['member:atpG']);
    expect(model.chainRows.map((row) => [row.chain.chainId, row.detailState])).toEqual([
      ['G', 'detail'],
      ['E', 'context'],
    ]);
  });

  it('uses preview-scoped styling before a scoped PDB hit is known to be a complex', () => {
    const view = structureViewStateForScene(
      {
        source: 'pdb',
        sourceId: 'RCSB:6OQW:ENTRY:AUTH_ASYM:G',
        providerIdentityKey: 'RCSB:6OQW:ENTRY:AUTH_ASYM:G',
        pdbId: '6OQW',
        scene: {
          ...COMPLEX_SCENE,
          sceneKind: 'single_query',
          members: [COMPLEX_SCENE.members[0]],
        },
      },
      { renderIntent: 'preview' }
    );

    expect(view.activeRecipeId).toBe('query-in-complex-preview');
    expect(view.renderIntent).toBe('preview');
    expect(view.recipe.id).toBe('query-in-complex-preview');
    expect(view.recipe.layers.some((layer) => layer.representation.kind === 'surface')).toBe(false);
  });

  it('groups same-gene protomers by the query biological source even when resolved residue spans differ', () => {
    const scene: StructureScene = {
      ...COMPLEX_SCENE,
      queryAnchor: {
        ...COMPLEX_SCENE.queryAnchor,
        label: 'atpG',
        targetSelection: {
          providerIdentityKey: 'RCSB:6OQR:ENTRY:AUTH_ASYM:G',
          pdbId: '6OQR',
          entityIds: ['7'],
          authAsymIds: ['G'],
        },
      },
      members: [
        {
          ...COMPLEX_SCENE.members[0],
          memberId: 'member:atpG:G',
          pdbEntityId: '7',
          authAsymIds: ['G'],
          selection: {
            providerIdentityKey: 'RCSB:6OQR:ENTRY',
            pdbId: '6OQR',
            entityIds: ['7'],
            labelAsymIds: ['g1'],
            authAsymIds: ['G'],
            chainIds: ['g1'],
          },
          workspaceFeatureRef: {
            entityId: 'sequence-document:mg1655',
            label: 'atpG',
          },
        },
        {
          memberId: 'member:atpG:Q',
          kind: 'protein',
          displayName: 'ATP synthase gamma chain copy',
          pdbEntityId: '7',
          authAsymIds: ['Q'],
          selection: {
            providerIdentityKey: 'RCSB:6OQR:ENTRY',
            pdbId: '6OQR',
            entityIds: ['7'],
            labelAsymIds: ['q1'],
            authAsymIds: ['Q'],
            chainIds: ['q1'],
          },
          relationToAnchor: 'same_complex',
          mappingStatus: 'unmapped',
        },
        {
          ...COMPLEX_SCENE.members[1],
          pdbEntityId: '1',
          selection: {
            providerIdentityKey: 'RCSB:6OQR:ENTRY',
            pdbId: '6OQR',
            entityIds: ['1'],
            authAsymIds: ['A'],
          },
        },
      ],
    };

    const model = createStructureRenderModel({
      chains: [
        chainSequence('g1', '7', 'ATP synthase gamma chain', {
          authAsymId: 'G',
          residues: 285,
        }),
        chainSequence('q1', '7', 'ATP synthase gamma chain partial copy', {
          authAsymId: 'Q',
          residues: 241,
        }),
        chainSequence('A', '1', 'ATP synthase alpha chain', { residues: 501 }),
      ],
      scene,
      view: {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex',
        recipe: {
          schemaVersion: 1,
          id: 'query-in-complex',
          name: 'Query in Complex',
          origin: 'builtin',
          layers: [],
        },
        showWater: false,
        spin: false,
        detailMemberIds: ['member:atpG:G'],
      },
    });

    const gammaRows = model.chainRows.filter((row) => row.groupLabel === 'atpG');
    expect(gammaRows.map((row) => [row.chain.chainId, row.displayChainId, row.groupId])).toEqual([
      ['g1', 'G', 'query-gene:atpg'],
      ['q1', 'Q', 'query-gene:atpg'],
    ]);
    expect(model.chainGroups.find((group) => group.groupId === 'query-gene:atpg')).toMatchObject({
      groupLabel: 'atpG',
      evidence: 'query-anchor',
      chainCount: 2,
      memberIds: ['member:atpG:G', 'member:atpG:Q'],
    });
    expect(gammaRows.map((row) => [row.displayChainId, row.chain.residues.length])).toEqual([
      ['G', 285],
      ['Q', 241],
    ]);
  });

  it('lets one physical protomer stay detailed while another same-member protomer stays gray', () => {
    const chains = [
      chainSequence('g1', '7', 'ATP synthase gamma chain', {
        authAsymId: 'G',
        residues: 285,
      }),
      chainSequence('q1', '7', 'ATP synthase gamma chain copy', {
        authAsymId: 'Q',
        residues: 241,
      }),
      chainSequence('A', '1', 'ATP synthase alpha chain', { residues: 501 }),
    ];
    const scene: StructureScene = {
      ...COMPLEX_SCENE,
      queryAnchor: {
        ...COMPLEX_SCENE.queryAnchor,
        label: 'atpG',
        targetSelection: {
          providerIdentityKey: 'RCSB:6OQR:ENTRY',
          pdbId: '6OQR',
          entityIds: ['7'],
          authAsymIds: ['G', 'Q'],
        },
      },
      members: [
        {
          ...COMPLEX_SCENE.members[0],
          memberId: 'member:atpG',
          pdbEntityId: '7',
          authAsymIds: ['G', 'Q'],
          selection: {
            providerIdentityKey: 'RCSB:6OQR:ENTRY',
            pdbId: '6OQR',
            entityIds: ['7'],
            authAsymIds: ['G', 'Q'],
          },
        },
        {
          ...COMPLEX_SCENE.members[1],
          selection: {
            providerIdentityKey: 'RCSB:6OQR:ENTRY',
            pdbId: '6OQR',
            entityIds: ['1'],
            authAsymIds: ['A'],
          },
        },
      ],
    };
    const defaultModel = createStructureRenderModel({ chains, scene });
    const selectedChainInstanceId = defaultModel.chainRows.find(
      (row) => row.chain.authAsymId === 'G'
    )?.chainInstanceId;

    expect(selectedChainInstanceId).toBeTruthy();

    const model = createStructureRenderModel({
      chains,
      scene,
      view: {
        schemaVersion: 1,
        activeRecipeId: 'query-in-complex',
        recipe: {
          schemaVersion: 1,
          id: 'query-in-complex',
          name: 'Query in Complex',
          origin: 'builtin',
          layers: [],
        },
        showWater: false,
        spin: false,
        detailMemberIds: ['member:atpG'],
        detailChainInstanceIds: [selectedChainInstanceId!],
      },
    });

    expect(
      model.chainRows.map((row) => [
        row.chain.authAsymId,
        row.memberId,
        row.detailState,
        row.displayMolstarColor,
      ])
    ).toEqual([
      ['G', 'member:atpG', 'detail', 0xe6194b],
      ['Q', 'member:atpG', 'context', STRUCTURE_CONTEXT_MOLSTAR_COLOR],
      ['A', 'member:atpC', 'context', STRUCTURE_CONTEXT_MOLSTAR_COLOR],
    ]);
    expect(model.detailChainInstanceIds).toEqual([selectedChainInstanceId]);
  });

  it('uses one stable group label for generic same-entity partner chains', () => {
    const model = createStructureRenderModel({
      chains: [
        chainSequence('B', '2', 'Chain B', { authAsymId: 'B' }),
        chainSequence('K', '2', 'Chain X', { authAsymId: 'X' }),
        chainSequence('L', '2', 'Chain Y', { authAsymId: 'Y' }),
      ],
      scene: {
        ...COMPLEX_SCENE,
        queryAnchor: {
          ...COMPLEX_SCENE.queryAnchor,
          targetSelection: {
            pdbId: '9FNN',
            entityIds: ['3'],
            authAsymIds: ['E'],
          },
        },
        members: [
          {
            memberId: 'member:B',
            kind: 'protein',
            displayName: 'Chain B',
            pdbEntityId: '2',
            selection: { pdbId: '9FNN', entityIds: ['2'], authAsymIds: ['B'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'unmapped',
          },
          {
            memberId: 'member:X',
            kind: 'protein',
            displayName: 'Chain X',
            pdbEntityId: '2',
            selection: { pdbId: '9FNN', entityIds: ['2'], authAsymIds: ['X'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'unmapped',
          },
          {
            memberId: 'member:Y',
            kind: 'protein',
            displayName: 'Chain Y',
            pdbEntityId: '2',
            selection: { pdbId: '9FNN', entityIds: ['2'], authAsymIds: ['Y'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'unmapped',
          },
        ],
      },
    });

    expect([...new Set(model.chainRows.map((row) => row.groupId))]).toEqual(['pdb-entity:9fnn:2']);
    expect([...new Set(model.chainRows.map((row) => row.groupLabel))]).toEqual(['Entity 2']);
    expect(model.chainGroups).toEqual([
      expect.objectContaining({
        groupId: 'pdb-entity:9fnn:2',
        groupLabel: 'Entity 2',
        chainCount: 3,
        authAsymIds: ['B', 'X', 'Y'],
      }),
    ]);
  });
});

function chainSequence(
  chainId: string,
  entityId: string,
  label: string,
  options: { authAsymId?: string; residues?: number } = {}
): ChainSequence {
  const residueCount = options.residues ?? 2;
  return {
    chainId,
    chainLabel: label,
    baseChain: chainId,
    labelAsymId: chainId,
    authAsymId: options.authAsymId ?? chainId,
    entityId,
    sequence: 'M'.repeat(residueCount),
    residues: Array.from({ length: residueCount }, (_, index) => ({
      position: index + 1,
      name: 'M',
      name3: 'MET',
      value: 90,
    })),
  };
}
