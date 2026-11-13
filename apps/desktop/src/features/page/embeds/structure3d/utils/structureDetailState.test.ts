// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ChainSequence, StructureScene, StructureViewState } from '../types';
import {
  defaultDetailMemberIds,
  detailMemberForChain,
  effectiveDetailChainInstanceIds,
  effectiveDetailMemberIds,
  isChainInDetailedMembers,
  orderChainsForStructureTable,
  setDetailChainInstanceVisibility,
  setDetailMemberVisibility,
} from './structureDetailState';

const SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:complex',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:6OQT:ENTRY',
  queryAnchor: {
    memberId: 'member:query',
    label: 'atpG',
    targetSelection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G', 'Q'] },
  },
  activeFocus: {
    memberId: 'member:query',
    role: 'query_anchor',
    mappingStatus: 'mapped_current_sequence',
    selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G', 'Q'] },
  },
  members: [
    {
      memberId: 'member:query',
      kind: 'protein',
      displayName: 'ATP synthase gamma chain',
      selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G', 'Q'] },
      relationToAnchor: 'query',
      mappingStatus: 'mapped_current_sequence',
    },
    {
      memberId: 'member:alpha',
      kind: 'protein',
      displayName: 'ATP synthase alpha chain',
      selection: { pdbId: '6OQT', entityIds: ['1'], authAsymIds: ['A'] },
      relationToAnchor: 'known_partner',
      mappingStatus: 'unmapped',
    },
  ],
  layers: [],
  provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
};

const VIEW: StructureViewState = {
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
};

describe('structure detail member state', () => {
  it('defaults detail rendering to the query anchor member', () => {
    expect(defaultDetailMemberIds(SCENE)).toEqual(['member:query']);
    expect(effectiveDetailMemberIds(SCENE, VIEW)).toEqual(['member:query']);
  });

  it('distinguishes undefined default detail from an intentional empty detail set', () => {
    expect(effectiveDetailMemberIds(SCENE, { ...VIEW, detailMemberIds: [] })).toEqual([]);
  });

  it('toggles members without mutating the query anchor', () => {
    const next = setDetailMemberVisibility(VIEW, SCENE, 'member:alpha', true);
    expect(next.detailMemberIds).toEqual(['member:query', 'member:alpha']);
    expect(SCENE.queryAnchor.memberId).toBe('member:query');

    const hidden = setDetailMemberVisibility(next, SCENE, 'member:query', false);
    expect(hidden.detailMemberIds).toEqual(['member:alpha']);
  });

  it('toggles physical chain instances independently from member ids', () => {
    const next = setDetailChainInstanceVisibility(VIEW, 'g-7-g', false, ['g-7-g', 'q-7-q']);

    expect(effectiveDetailChainInstanceIds(next)).toEqual(['q-7-q']);
    expect(next.detailMemberIds).toBeUndefined();
    expect(SCENE.queryAnchor.memberId).toBe('member:query');

    const restored = setDetailChainInstanceVisibility(next, 'g-7-g', true, ['q-7-q']);
    expect(restored.detailChainInstanceIds).toEqual(['q-7-q', 'g-7-g']);
  });

  it('sanitizes invalid persisted detail ids before they reach renderer state', () => {
    const dirtyView = {
      ...VIEW,
      detailMemberIds: ['member:query', null, '', 'member:alpha'],
      detailChainInstanceIds: ['g-7-g', undefined, '', 'q-7-q'],
    } as unknown as StructureViewState;

    expect(effectiveDetailMemberIds(SCENE, dirtyView)).toEqual(['member:query', 'member:alpha']);
    expect(effectiveDetailChainInstanceIds(dirtyView)).toEqual(['g-7-g', 'q-7-q']);
    expect(setDetailMemberVisibility(dirtyView, SCENE, null as unknown as string, true)).toEqual(
      expect.objectContaining({
        detailMemberIds: ['member:query', 'member:alpha'],
        detailChainInstanceIds: ['g-7-g', 'q-7-q'],
      })
    );
  });

  it('treats every explicitly selected query protomer as detailed by default', () => {
    expect(
      isChainInDetailedMembers({
        chain: chain('G', '7'),
        scene: SCENE,
        view: VIEW,
      })
    ).toBe(true);
    expect(
      isChainInDetailedMembers({
        chain: chain('Q', '7'),
        scene: SCENE,
        view: VIEW,
      })
    ).toBe(true);
    expect(
      isChainInDetailedMembers({
        chain: chain('A', '1'),
        scene: SCENE,
        view: VIEW,
      })
    ).toBe(false);
  });

  it('maps sequence chains back to the scene member that owns the row control', () => {
    expect(detailMemberForChain(chain('G', '7'), SCENE)?.memberId).toBe('member:query');
    expect(detailMemberForChain(chain('Q', '7'), SCENE)?.memberId).toBe('member:query');
    expect(detailMemberForChain(chain('A', '1'), SCENE)?.memberId).toBe('member:alpha');
  });

  it('does not treat a label chain id as an auth-asym match when explicit auth differs', () => {
    const labelHAuthB = { ...chain('H', '2'), authAsymId: 'B' };
    expect(detailMemberForChain(labelHAuthB, SCENE)?.memberId).toBeUndefined();
    expect(
      detailMemberForChain({ ...labelHAuthB, entityId: '1' }, SCENE)?.memberId
    ).toBeUndefined();
  });

  it('prefers explicit author-chain ids over ambiguous chainIds for label/auth divergent rows', () => {
    const scene: StructureScene = {
      ...SCENE,
      members: [
        {
          ...SCENE.members[0],
          selection: {
            pdbId: '6OQR',
            authAsymIds: ['A'],
            chainIds: ['A'],
          },
        },
      ],
    };

    const labelAAuthW = { ...chain('A', '1'), labelAsymId: 'A', authAsymId: 'W' };
    const labelWAuthA = { ...chain('W', '1'), labelAsymId: 'W', authAsymId: 'A' };

    expect(detailMemberForChain(labelAAuthW, scene)).toBeUndefined();
    expect(detailMemberForChain(labelWAuthA, scene)?.memberId).toBe('member:query');
  });

  it('does not broaden a direct query-chain selection to unchecked same-entity protomers', () => {
    const scene: StructureScene = {
      ...SCENE,
      queryAnchor: {
        ...SCENE.queryAnchor,
        targetSelection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
      },
      activeFocus: {
        ...SCENE.activeFocus!,
        selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
      },
      members: [
        {
          ...SCENE.members[0],
          selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
        },
        {
          memberId: 'member:gamma-copy',
          kind: 'protein',
          displayName: 'ATP synthase gamma chain copy',
          selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['Q'], chainIds: ['Q'] },
          relationToAnchor: 'known_partner',
          mappingStatus: 'unmapped',
        },
        SCENE.members[1],
      ],
    };

    expect(
      isChainInDetailedMembers({
        chain: chain('G', '7'),
        scene,
        view: VIEW,
      })
    ).toBe(true);
    expect(
      isChainInDetailedMembers({
        chain: chain('Q', '7'),
        scene,
        view: VIEW,
      })
    ).toBe(false);
    expect(detailMemberForChain(chain('Q', '7'), scene)?.memberId).toBe('member:gamma-copy');
  });

  it('still supports entity-only selections when no direct chain scope exists', () => {
    const entityOnlyScene: StructureScene = {
      ...SCENE,
      members: [
        {
          ...SCENE.members[0],
          selection: { pdbId: '6OQT', entityIds: ['7'] },
        },
        SCENE.members[1],
      ],
    };

    expect(detailMemberForChain(chain('Q', '7'), entityOnlyScene)?.memberId).toBe('member:query');
  });

  it('pins the original query-anchor protomer before other same-protein chains', () => {
    const scene: StructureScene = {
      ...SCENE,
      queryAnchor: {
        ...SCENE.queryAnchor,
        targetSelection: { pdbId: '6OQT', authAsymIds: ['G'], chainIds: ['G'] },
      },
      members: [
        {
          ...SCENE.members[0],
          selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G', 'Q'] },
        },
        SCENE.members[1],
      ],
    };

    expect(
      orderChainsForStructureTable(
        [chain('A', '1'), chain('Q', '7'), chain('G', '7'), chain('B', '2')],
        scene
      ).map((orderedChain) => orderedChain.chainId)
    ).toEqual(['G', 'Q', 'A', 'B']);
  });

  it('keeps same-entity query protomers adjacent in the table without marking them detailed', () => {
    const scene: StructureScene = {
      ...SCENE,
      queryAnchor: {
        ...SCENE.queryAnchor,
        targetSelection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
      },
      members: [
        {
          ...SCENE.members[0],
          selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
        },
        {
          memberId: 'member:gamma-copy',
          kind: 'protein',
          displayName: 'ATP synthase gamma chain copy',
          selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['Q'], chainIds: ['Q'] },
          relationToAnchor: 'same_complex',
          mappingStatus: 'unmapped',
        },
        SCENE.members[1],
      ],
    };

    expect(
      orderChainsForStructureTable(
        [chain('A', '1'), chain('Q', '7'), chain('G', '7'), chain('B', '2')],
        scene
      ).map((orderedChain) => orderedChain.chainId)
    ).toEqual(['G', 'Q', 'A', 'B']);
    expect(
      isChainInDetailedMembers({
        chain: chain('Q', '7'),
        scene,
        view: VIEW,
      })
    ).toBe(false);
  });
});

function chain(chainId: string, entityId: string): ChainSequence {
  return {
    chainId,
    chainLabel: `Chain ${chainId}`,
    baseChain: chainId,
    labelAsymId: chainId,
    authAsymId: chainId,
    entityId,
    sequence: 'MA',
    residues: [
      { position: 1, name: 'M', name3: 'MET' },
      { position: 2, name: 'A', name3: 'ALA' },
    ],
  };
}
