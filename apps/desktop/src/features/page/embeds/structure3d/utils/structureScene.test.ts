// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { StructureScene } from '../types';
import { focusStructureSceneMember } from './structureScene';

const BASE_SCENE: StructureScene = {
  schemaVersion: 1,
  sceneId: 'scene:RCSB:1ABC:ENTRY',
  sceneKind: 'complex',
  primaryResourceId: 'RCSB:1ABC:ENTRY',
  queryAnchor: {
    memberId: 'member:query',
    sourceEntityId: 'sequence-document:source',
    sourceWorkspaceRoot: '/workspace',
    label: 'ATPG',
    targetSelection: {
      providerIdentityKey: 'RCSB:1ABC:ENTRY',
      pdbId: '1ABC',
      entityIds: ['1'],
      labelAsymIds: ['A'],
      authAsymIds: ['A'],
    },
  },
  activeFocus: {
    memberId: 'member:query',
    role: 'query_anchor',
    selection: {
      providerIdentityKey: 'RCSB:1ABC:ENTRY',
      pdbId: '1ABC',
      entityIds: ['1'],
      labelAsymIds: ['A'],
      authAsymIds: ['A'],
    },
    mappingStatus: 'mapped_current_sequence',
  },
  members: [
    {
      memberId: 'member:query',
      kind: 'protein',
      displayName: 'ATPG',
      relationToAnchor: 'query',
      mappingStatus: 'mapped_current_sequence',
      selection: {
        providerIdentityKey: 'RCSB:1ABC:ENTRY',
        pdbId: '1ABC',
        entityIds: ['1'],
        labelAsymIds: ['A'],
        authAsymIds: ['A'],
      },
    },
    {
      memberId: 'member:partner',
      kind: 'protein',
      displayName: 'ATP synthase partner',
      relationToAnchor: 'known_partner',
      mappingStatus: 'external_only',
      selection: {
        providerIdentityKey: 'RCSB:1ABC:ENTRY',
        pdbId: '1ABC',
        entityIds: ['2'],
        labelAsymIds: ['B'],
        authAsymIds: ['B'],
      },
    },
  ],
  layers: [
    {
      id: 'layer:model:RCSB:1ABC:ENTRY',
      kind: 'model',
      role: 'query',
      visible: true,
      source: {
        source: 'pdb',
        sourceId: 'RCSB:1ABC:ENTRY',
        providerIdentityKey: 'RCSB:1ABC:ENTRY',
        pdbId: '1ABC',
      },
    },
  ],
  provenance: {
    createdBy: 'structure-drawer',
    resolverSource: 'pdb_xref',
    resolverIdentity: 1,
    provider: 'pdb',
    providerIdentityKey: 'RCSB:1ABC:ENTRY',
  },
};

describe('focusStructureSceneMember', () => {
  it('changes active focus without mutating the query anchor', () => {
    const originalAnchor = BASE_SCENE.queryAnchor;
    const next = focusStructureSceneMember(BASE_SCENE, 'member:partner');

    expect(next).not.toBe(BASE_SCENE);
    expect(next.queryAnchor).toBe(originalAnchor);
    expect(next.queryAnchor).toEqual(BASE_SCENE.queryAnchor);
    expect(next.activeFocus).toEqual({
      memberId: 'member:partner',
      role: 'partner',
      selection: {
        providerIdentityKey: 'RCSB:1ABC:ENTRY',
        pdbId: '1ABC',
        entityIds: ['2'],
        labelAsymIds: ['B'],
        authAsymIds: ['B'],
      },
      mappingStatus: 'external_only',
    });
  });

  it('returns the same scene when the member is unknown', () => {
    expect(focusStructureSceneMember(BASE_SCENE, 'member:missing')).toBe(BASE_SCENE);
  });

  it('copies focused selection arrays so focus edits cannot mutate member selection', () => {
    const next = focusStructureSceneMember(BASE_SCENE, 'member:partner');
    expect(next.activeFocus?.selection.labelAsymIds).toEqual(['B']);
    expect(next.activeFocus?.selection.labelAsymIds).not.toBe(
      BASE_SCENE.members[1].selection.labelAsymIds
    );
  });
});
