// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  chainMatchesScopes,
  filterHighlightGroupsForScopes,
  filterSequenceDataForScopes,
  scopedResidueOrNull,
} from './structureScope';
import type { ChainSequence, LigandInfo, ResidueLocation, Structure3dAttrs } from '../types';

describe('structureScope', () => {
  it('treats RCSB entity id as a first-class scope for rows and Molstar interactions', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:ENTITY:1',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:ENTITY:1',
      pdbEntityId: '1',
    };
    const inScopeResidue: ResidueLocation = {
      chain: 'A',
      position: 10,
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
    };
    const outOfScopeResidue: ResidueLocation = {
      chain: 'B',
      position: 10,
      labelAsymId: 'B',
      authAsymId: 'L',
      entityId: '2',
    };

    expect(scopedResidueOrNull(inScopeResidue, attrs)).toBe(inScopeResidue);
    expect(scopedResidueOrNull(outOfScopeResidue, attrs)).toBeNull();
  });

  it('does not match entity-scoped structures when extracted entity metadata is missing', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:ENTITY:1',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:ENTITY:1',
      pdbEntityId: '1',
    };

    expect(chainMatchesScopes({ chain: 'A', labelAsymId: 'A', authAsymId: 'H' }, attrs)).toBe(
      false
    );
  });

  it('filters sequence rows by entity id even when chain ids are otherwise valid', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:ENTITY:1',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:ENTITY:1',
      pdbEntityId: '1',
    };
    const chains: ChainSequence[] = [
      {
        chainId: 'A',
        chainLabel: 'Chain A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        sequence: 'MK',
        residues: [],
      },
      {
        chainId: 'H',
        chainLabel: 'Chain H',
        labelAsymId: 'H',
        authAsymId: 'B',
        entityId: '2',
        sequence: 'GA',
        residues: [],
      },
    ];

    expect(filterSequenceDataForScopes(chains, attrs)?.map((chain) => chain.chainId)).toEqual([
      'A',
    ]);
  });

  it('keeps all complex chains visible even when the original query anchor is scoped', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY:ENTITY:2',
      providerIdentityKey: 'RCSB:1FS0:ENTRY:ENTITY:2',
      pdbEntityId: '2',
      authAsymIds: ['G'],
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpG:1FS0',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: {
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
            selection: {
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
            selection: {
              pdbId: '1FS0',
              entityIds: ['3'],
              authAsymIds: ['E'],
            },
            relationToAnchor: 'known_partner',
            mappingStatus: 'mapped_workspace',
          },
        ],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
    };
    const chains: ChainSequence[] = [
      {
        chainId: 'G',
        chainLabel: 'Chain G',
        authAsymId: 'G',
        entityId: '2',
        sequence: 'MK',
        residues: [],
      },
      {
        chainId: 'E',
        chainLabel: 'Chain E',
        authAsymId: 'E',
        entityId: '3',
        sequence: 'GA',
        residues: [],
      },
    ];

    expect(filterSequenceDataForScopes(chains, attrs)?.map((chain) => chain.chainId)).toEqual([
      'G',
      'E',
    ]);
    expect(chainMatchesScopes({ chain: 'E', authAsymId: 'E', entityId: '3' }, attrs)).toBe(true);
  });

  it('normalizes auth-scope saved highlights to the in-scope label chain before Molstar sees them', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
      authAsymIds: ['H'],
    };
    const scopedChains: ChainSequence[] = [
      {
        chainId: 'A',
        chainLabel: 'Chain A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        sequence: 'MK',
        residues: [],
      },
    ];

    expect(
      filterHighlightGroupsForScopes(
        [
          {
            id: 'auth-chain-selection',
            label: 'Auth chain H',
            selections: [{ chain: 'H', ranges: [[2, 2]] }],
          },
        ],
        scopedChains,
        attrs
      )
    ).toEqual([
      {
        id: 'auth-chain-selection',
        label: 'Auth chain H',
        selections: [{ chain: 'A', ranges: [[2, 2]] }],
      },
    ]);
  });

  it('retains a ligand-only scoped highlight when there is no polymer chain row', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:3OAA:ENTRY:AUTH_ASYM:A',
      authAsymIds: ['A'],
    };
    const ligands: LigandInfo[] = [
      {
        name: 'MG',
        chainId: 'A',
        position: 601,
        atomCount: 1,
        labelAsymId: 'C',
        authAsymId: 'A',
        entityId: '7',
      },
    ];

    expect(
      filterHighlightGroupsForScopes(
        [
          {
            id: 'agent-highlight:3OAA',
            label: 'Magnesium',
            selections: [{ chain: 'A', labelAsymId: 'C', compId: 'MG', ranges: [[601, 601]] }],
          },
        ],
        [],
        attrs,
        ligands
      )
    ).toEqual([
      {
        id: 'agent-highlight:3OAA',
        label: 'Magnesium',
        selections: [{ chain: 'C', labelAsymId: 'C', compId: 'MG', ranges: [[601, 601]] }],
      },
    ]);
  });
});
