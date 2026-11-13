// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Structure3dAttrs } from '../types';
import {
  availableViewRecipesForStructure,
  supportsConfidenceRecipe,
  supportsFocusInContextRecipe,
  supportsQueryInComplexRecipe,
} from './viewRecipeAvailability';

describe('view recipe availability', () => {
  it('shows Query in Complex for top-level scoped PDB attrs', () => {
    expect(
      supportsQueryInComplexRecipe({
        source: 'pdb',
        pdbId: '1FS0',
        pdbEntityId: '2',
      })
    ).toBe(true);
  });

  it('shows Query in Complex for scoped RCSB attrs even when sourceId is the only entry identity', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
      authAsymIds: ['G'],
    };

    expect(supportsQueryInComplexRecipe(attrs)).toBe(true);
    expect(availableViewRecipesForStructure(attrs).map((recipe) => recipe.id)).toEqual([
      'query-in-complex',
      'query-in-complex-surface',
      'assembly-overview',
      'illustrative',
      'ball-and-stick',
    ]);
  });

  it('shows Query in Complex when scope is only present on the StructureScene query anchor', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpg',
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
        members: [],
        layers: [],
        provenance: {
          createdBy: 'structure-drawer',
          provider: 'pdb',
        },
      },
    };

    expect(supportsQueryInComplexRecipe(attrs)).toBe(true);
  });

  it('exposes recipe-backed standard and complex views while preserving focus support detection', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: 'RCSB:1FS0:ENTRY',
      providerIdentityKey: 'RCSB:1FS0:ENTRY',
      pdbId: '1FS0',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:mg1655:atpg',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '1FS0', authAsymIds: ['G'] },
        },
        activeFocus: {
          memberId: 'member:atpG',
          role: 'query_anchor',
          mappingStatus: 'mapped_current_sequence',
          selection: { pdbId: '1FS0', authAsymIds: ['G'] },
        },
        members: [
          {
            memberId: 'member:atpG',
            kind: 'protein',
            displayName: 'ATP synthase gamma chain',
            selection: { pdbId: '1FS0', authAsymIds: ['G'] },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
          {
            memberId: 'member:atpC',
            kind: 'protein',
            displayName: 'ATP synthase epsilon chain',
            selection: { pdbId: '1FS0', authAsymIds: ['E'] },
            relationToAnchor: 'known_partner',
            mappingStatus: 'mapped_workspace',
          },
        ],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
      },
    };

    expect(supportsFocusInContextRecipe(attrs)).toBe(true);
    const complexRecipes = availableViewRecipesForStructure(attrs);
    expect(complexRecipes.map((recipe) => recipe.id)).toEqual([
      'query-in-complex',
      'query-in-complex-surface',
      'assembly-overview',
      'illustrative',
      'ball-and-stick',
    ]);
    expect(complexRecipes.map((recipe) => recipe.name)).toEqual([
      'Cartoon Context',
      'Surface Context',
      'Solid Surface Context',
      'Styled Spacefill',
      'Atomic Detail',
    ]);
    expect(
      supportsFocusInContextRecipe({
        ...attrs,
        scene: attrs.scene
          ? { ...attrs.scene, members: attrs.scene.members.slice(0, 1) }
          : undefined,
      })
    ).toBe(false);
  });

  it('uses the same core recipe menu for AlphaFold and PDB monomers', () => {
    const alphafoldAttrs: Structure3dAttrs = {
      source: 'alphafold',
      accession: 'P0AB96',
      sourceId: 'AF:P0AB96:F1:LATEST',
    };
    const pdbAttrs: Structure3dAttrs = {
      source: 'pdb',
      pdbId: '1FS0',
      sourceId: 'RCSB:1FS0:ENTRY',
    };

    expect(availableViewRecipesForStructure(alphafoldAttrs).map((recipe) => recipe.id)).toEqual([
      'cartoon',
      'ball-and-stick',
      'spacefill',
      'surface',
      'illustrative',
      'hybrid',
    ]);
    expect(availableViewRecipesForStructure(pdbAttrs).map((recipe) => recipe.id)).toEqual([
      'cartoon',
      'ball-and-stick',
      'spacefill',
      'surface',
      'illustrative',
      'hybrid',
    ]);
  });

  it('keeps AlphaFold confidence as a data/color capability, not a provider-specific recipe', () => {
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      accession: 'P0AB96',
      sourceId: 'AF:P0AB96:F1:LATEST',
    };

    expect(supportsQueryInComplexRecipe(attrs)).toBe(false);
    expect(supportsConfidenceRecipe(attrs)).toBe(true);
    expect(availableViewRecipesForStructure(attrs).map((recipe) => recipe.id)).not.toContain(
      'confidence'
    );
  });

  it('supports complex context recipes from scene capabilities, not from PDB provider identity', () => {
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      sourceId: 'AF:P39702:F1:LATEST',
      providerIdentityKey: 'AF:P39702:F1:V6:MODEL:AF-P39702-F1-model_v6',
      accession: 'P39702',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:s288c:vps8-context',
        sceneKind: 'complex',
        primaryResourceId: 'AF:P39702:F1:LATEST',
        queryAnchor: {
          memberId: 'member:vps8',
          targetSelection: {
            accession: 'P39702',
            chainIds: ['A'],
          },
        },
        activeFocus: {
          memberId: 'member:vps8',
          role: 'query_anchor',
          mappingStatus: 'mapped_current_sequence',
          selection: {
            accession: 'P39702',
            chainIds: ['A'],
          },
        },
        members: [
          {
            memberId: 'member:vps8',
            kind: 'protein',
            displayName: 'Vps8',
            selection: { accession: 'P39702', chainIds: ['A'] },
            relationToAnchor: 'query',
            mappingStatus: 'mapped_current_sequence',
          },
        ],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'alphafold' },
      },
    };

    expect(supportsQueryInComplexRecipe(attrs)).toBe(true);
    expect(availableViewRecipesForStructure(attrs).map((recipe) => recipe.id)).toEqual([
      'query-in-complex',
      'query-in-complex-surface',
      'assembly-overview',
      'illustrative',
      'ball-and-stick',
    ]);
  });
});
