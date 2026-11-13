// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ChainSequence, Structure3dAttrs, StructureMemberSelection } from '../types';
import ATPG_COMPLEX_CATALOG_RAW from '../../../../../../../../test-fixtures/structure-complexes/mg1655-atpg-complexes.json?raw';
import RESULT_LISTING_CATALOG_RAW from '../../../../../../../../test-fixtures/structure-complexes/mg1655-structure-result-listings.json?raw';
import {
  fullPdbEntryIdentity,
  promoteScopedPdbSceneFromChains,
  shouldLoadFullPdbEntryForScene,
} from './scopedPdbSceneUpgrade';
import { createQueryInComplexPreviewRecipe } from './builtinViewRecipes';

interface CaseMember {
  memberId: string;
  role: string;
  entityId: string;
  chains: string[];
}

interface ComplexCase {
  fixtureId: string;
  coverageClass: string;
  underlyingSequencePolicy: 'all_members_in_source' | 'external_only_members_absent_from_source';
  pdbId: string;
  primaryEntityId: string;
  primaryChains: string[];
  members: CaseMember[];
}

interface ComplexCatalog {
  cases: ComplexCase[];
}

interface ResultListingCase {
  caseId: string;
  resultClass: 'co_complex' | 'non_cocomplex';
  gene: string;
  resultListing: {
    hasPdbResults: boolean;
    representativeStructures: Array<{
      pdbId: string;
      coComplexEvidence:
        | 'heteromeric_protein'
        | 'protein_nucleic_acid_complex'
        | 'homomeric_or_single_entity';
    }>;
  };
}

interface ResultListingCatalog {
  cases: ResultListingCase[];
}

type ScopeVariant = {
  variantId: string;
  sourceId: string;
  providerIdentityKey: string;
  attrsScope: Pick<Structure3dAttrs, 'pdbEntityId' | 'labelAsymIds' | 'authAsymIds' | 'assemblyId'>;
  selection: StructureMemberSelection;
};

const atpGComplexCatalog = JSON.parse(ATPG_COMPLEX_CATALOG_RAW) as ComplexCatalog;
const resultListingCatalog = JSON.parse(RESULT_LISTING_CATALOG_RAW) as ResultListingCatalog;

describe('scoped PDB scene compatibility promotion fixture pressure tests', () => {
  it('promotes every real MG1655 atpG co-complex across scoped identifier variants', () => {
    const cases = atpGComplexCatalog.cases;
    const fixtureRuns = cases.flatMap((fixtureCase) =>
      selectorVariantsForCase(fixtureCase).map((variant) => ({ fixtureCase, variant }))
    );

    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(fixtureRuns.length).toBeGreaterThanOrEqual(100);

    for (const { fixtureCase, variant } of fixtureRuns) {
      const attrs = scopedSingleQueryAttrs(fixtureCase, variant);
      const originalQueryAnchor = attrs.scene!.queryAnchor;
      const chains = chainSequencesForCase(fixtureCase);
      const promoted = promoteScopedPdbSceneFromChains(attrs, chains);

      expect(
        shouldLoadFullPdbEntryForScene(attrs),
        `${fixtureCase.fixtureId} ${variant.variantId} should request full-entry bytes`
      ).toBe(true);
      expect(promoted, `${fixtureCase.fixtureId} ${variant.variantId}`).not.toBeNull();
      expect(promoted!.scene?.sceneKind).toBe('complex');
      expect(promoted!.scene?.primaryResourceId).toBe(fullPdbEntryIdentity(fixtureCase.pdbId));
      expect(promoted!.scene?.queryAnchor).toBe(originalQueryAnchor);
      expect(promoted!.scene?.activeFocus).toEqual(attrs.scene!.activeFocus);
      expect(promoted!.scene?.members[0].memberId).toBe(attrs.scene!.members[0].memberId);
      expect(promoted!.scene?.members[0].relationToAnchor).toBe('query');
      const expectedQueryChains = expectedQueryChainsForVariant(fixtureCase, variant);
      expect(promoted!.scene?.members[0].selection.authAsymIds).toEqual(
        expect.arrayContaining(expectedQueryChains)
      );
      if (expectedQueryChains.length < fixtureCase.primaryChains.length) {
        const unselectedPrimaryChains = fixtureCase.primaryChains.filter(
          (chain) => !expectedQueryChains.includes(chain)
        );
        for (const chain of unselectedPrimaryChains) {
          expect(promoted!.scene?.members[0].selection.authAsymIds).not.toContain(chain);
        }
      }
      expect(promoted!.scene?.members.length).toBeGreaterThan(1);
      expect(
        promoted!.scene?.members.some((member) => member.relationToAnchor === 'known_partner')
      ).toBe(true);
      expect(promoted!.scene?.layers).toEqual([
        expect.objectContaining({
          id: `layer:model:${fullPdbEntryIdentity(fixtureCase.pdbId)}`,
          source: expect.objectContaining({
            sourceId: fullPdbEntryIdentity(fixtureCase.pdbId),
            providerIdentityKey: fullPdbEntryIdentity(fixtureCase.pdbId),
            pdbId: fixtureCase.pdbId,
          }),
        }),
      ]);
    }
  });

  it('does not promote non-co-complex or AlphaFold-only fixture shapes into complex scenes', () => {
    const nonCoComplexCases = resultListingCatalog.cases.filter(
      (fixtureCase) => fixtureCase.resultClass === 'non_cocomplex'
    );

    expect(nonCoComplexCases).toHaveLength(5);

    for (const fixtureCase of nonCoComplexCases) {
      if (!fixtureCase.resultListing.hasPdbResults) {
        const attrs = alphaFoldSingleQueryAttrs(fixtureCase.gene);
        expect(shouldLoadFullPdbEntryForScene(attrs)).toBe(false);
        expect(promoteScopedPdbSceneFromChains(attrs, [])).toBeNull();
        continue;
      }

      const pdbId = fixtureCase.resultListing.representativeStructures[0]?.pdbId ?? '1ABC';
      const attrs = scopedSingleQueryAttrs(
        {
          fixtureId: fixtureCase.caseId,
          coverageClass: 'non_cocomplex',
          underlyingSequencePolicy: 'all_members_in_source',
          pdbId,
          primaryEntityId: '1',
          primaryChains: ['A'],
          members: [
            { memberId: fixtureCase.gene, role: 'query_anchor', entityId: '1', chains: ['A'] },
          ],
        },
        {
          variantId: 'auth-single-top-level',
          sourceId: `RCSB:${pdbId}:ENTRY:AUTH_ASYM:A`,
          providerIdentityKey: `RCSB:${pdbId}:ENTRY:AUTH_ASYM:A`,
          attrsScope: { authAsymIds: ['A'] },
          selection: { pdbId, authAsymIds: ['A'], chainIds: ['A'] },
        }
      );

      expect(
        promoteScopedPdbSceneFromChains(attrs, [
          chainSequence({ chainId: 'A', entityId: '1' }),
          chainSequence({ chainId: 'B', entityId: '1' }),
        ]),
        `${fixtureCase.caseId} homomeric/single-entity shape`
      ).toBeNull();
    }
  });

  it('requires real context chains and keeps single-chain scoped scenes as single-query views', () => {
    const fixtureCase = atpGComplexCatalog.cases[0];
    const variant = selectorVariantsForCase(fixtureCase)[0];
    const attrs = scopedSingleQueryAttrs(fixtureCase, variant);

    expect(promoteScopedPdbSceneFromChains(attrs, null)).toBeNull();
    expect(promoteScopedPdbSceneFromChains(attrs, [])).toBeNull();
    expect(
      promoteScopedPdbSceneFromChains(attrs, [
        chainSequence({
          chainId: fixtureCase.primaryChains[0],
          entityId: fixtureCase.primaryEntityId,
        }),
      ])
    ).toBeNull();
  });

  it('preserves preview intent when sequence extraction promotes a scoped entry to a complex', () => {
    const fixtureCase = atpGComplexCatalog.cases[1];
    const variant = selectorVariantsForCase(fixtureCase)[0];
    const attrs = scopedSingleQueryAttrs(fixtureCase, variant);
    attrs.view = {
      schemaVersion: 1,
      activeRecipeId: 'query-in-complex-preview',
      recipe: createQueryInComplexPreviewRecipe(),
      showWater: false,
      spin: false,
    };

    const promoted = promoteScopedPdbSceneFromChains(attrs, chainSequencesForCase(fixtureCase));

    expect(promoted?.scene?.sceneKind).toBe('complex');
    expect(promoted?.view?.activeRecipeId).toBe('query-in-complex-preview');
    expect(promoted?.view?.recipe.id).toBe('query-in-complex-preview');
  });

  it('preserves explicit preview intent when a metadata-poor scoped hit starts as single-query cartoon', () => {
    const fixtureCase = atpGComplexCatalog.cases.find((item) => item.pdbId === '6OQR')!;
    const variant = selectorVariantsForCase(fixtureCase)[0];
    const attrs = scopedSingleQueryAttrs(fixtureCase, variant);
    attrs.view = {
      schemaVersion: 1,
      activeRecipeId: 'cartoon',
      recipe: {
        schemaVersion: 1,
        id: 'cartoon',
        name: 'Cartoon',
        origin: 'builtin',
        layers: [],
      },
      renderIntent: 'preview',
      showWater: false,
      spin: false,
    };

    const promoted = promoteScopedPdbSceneFromChains(attrs, chainSequencesForCase(fixtureCase));

    expect(promoted?.scene?.sceneKind).toBe('complex');
    expect(promoted?.view?.activeRecipeId).toBe('query-in-complex-preview');
    expect(promoted?.view?.recipe.id).toBe('query-in-complex-preview');
    expect(
      promoted?.view?.recipe.layers.some((layer) => layer.representation.kind === 'surface')
    ).toBe(false);
  });

  it('keeps same-entity unselected protomers as gray context members for direct chain scopes', () => {
    const attrs = scopedSingleQueryAttrs(
      {
        fixtureId: 'regression-same-entity-protomer',
        coverageClass: 'heteromeric_complex',
        underlyingSequencePolicy: 'all_members_in_source',
        pdbId: '6OQT',
        primaryEntityId: '7',
        primaryChains: ['G', 'Q'],
        members: [
          { memberId: 'atpG', role: 'query_anchor', entityId: '7', chains: ['G', 'Q'] },
          { memberId: 'atpA', role: 'known_partner', entityId: '1', chains: ['A'] },
        ],
      },
      {
        variantId: 'entity-auth-direct',
        sourceId: 'RCSB:6OQT:ENTRY:ENTITY:7:AUTH_ASYM:G',
        providerIdentityKey: 'RCSB:6OQT:ENTRY:ENTITY:7:AUTH_ASYM:G',
        attrsScope: { pdbEntityId: '7', authAsymIds: ['G'] },
        selection: { pdbId: '6OQT', entityIds: ['7'], authAsymIds: ['G'], chainIds: ['G'] },
      }
    );

    const promoted = promoteScopedPdbSceneFromChains(attrs, [
      chainSequence({ chainId: 'G', entityId: '7', label: 'ATP synthase gamma chain' }),
      chainSequence({ chainId: 'Q', entityId: '7', label: 'ATP synthase gamma copy' }),
      chainSequence({ chainId: 'A', entityId: '1', label: 'ATP synthase alpha chain' }),
    ]);

    expect(promoted?.scene?.members[0].selection.authAsymIds).toEqual(['G']);
    expect(
      promoted?.scene?.members.find((member) => member.selection.authAsymIds?.includes('Q'))
        ?.memberId
    ).toBe('member:scene:regression-same-entity-protomer:entity-auth-direct:chain:Q-Q-7-Q');
  });
});

function selectorVariantsForCase(fixtureCase: ComplexCase): ScopeVariant[] {
  const pdbId = fixtureCase.pdbId;
  const fullEntry = fullPdbEntryIdentity(pdbId);
  const firstChain = fixtureCase.primaryChains[0];
  const allPrimaryChains = fixtureCase.primaryChains;
  const entityId = fixtureCase.primaryEntityId;

  return [
    {
      variantId: 'auth-single-top-level',
      sourceId: `${fullEntry}:AUTH_ASYM:${firstChain}`,
      providerIdentityKey: `${fullEntry}:AUTH_ASYM:${firstChain}`,
      attrsScope: { authAsymIds: [firstChain] },
      selection: { pdbId, authAsymIds: [firstChain], chainIds: [firstChain] },
    },
    {
      variantId: 'auth-all-primary-top-level',
      sourceId: `${fullEntry}:AUTH_ASYM:${allPrimaryChains.join(',')}`,
      providerIdentityKey: `${fullEntry}:AUTH_ASYM:${allPrimaryChains.join(',')}`,
      attrsScope: { authAsymIds: [...allPrimaryChains] },
      selection: { pdbId, authAsymIds: [...allPrimaryChains], chainIds: [...allPrimaryChains] },
    },
    {
      variantId: 'entity-top-level',
      sourceId: `${fullEntry}:ENTITY:${entityId}`,
      providerIdentityKey: `${fullEntry}:ENTITY:${entityId}`,
      attrsScope: { pdbEntityId: entityId },
      selection: { pdbId, entityIds: [entityId], chainIds: [...allPrimaryChains] },
    },
    {
      variantId: 'label-single-top-level',
      sourceId: `${fullEntry}:LABEL_ASYM:${firstChain}`,
      providerIdentityKey: `${fullEntry}:LABEL_ASYM:${firstChain}`,
      attrsScope: { labelAsymIds: [firstChain] },
      selection: { pdbId, labelAsymIds: [firstChain], chainIds: [firstChain] },
    },
    {
      variantId: 'assembly-auth-top-level',
      sourceId: `${fullEntry}:ASSEMBLY:1:AUTH_ASYM:${firstChain}`,
      providerIdentityKey: `${fullEntry}:ASSEMBLY:1:AUTH_ASYM:${firstChain}`,
      attrsScope: { assemblyId: '1', authAsymIds: [firstChain] },
      selection: { pdbId, authAsymIds: [firstChain], chainIds: [firstChain] },
    },
    {
      variantId: 'entity-auth-top-level',
      sourceId: `${fullEntry}:ENTITY:${entityId}:AUTH_ASYM:${firstChain}`,
      providerIdentityKey: `${fullEntry}:ENTITY:${entityId}:AUTH_ASYM:${firstChain}`,
      attrsScope: { pdbEntityId: entityId, authAsymIds: [firstChain] },
      selection: {
        pdbId,
        entityIds: [entityId],
        authAsymIds: [firstChain],
        chainIds: [firstChain],
      },
    },
    {
      variantId: 'auth-scope-in-source-only',
      sourceId: `${fullEntry}:AUTH_ASYM:${firstChain}`,
      providerIdentityKey: `${fullEntry}:AUTH_ASYM:${firstChain}`,
      attrsScope: {},
      selection: { pdbId, authAsymIds: [firstChain], chainIds: [firstChain] },
    },
    {
      variantId: 'entity-scope-in-source-only',
      sourceId: `${fullEntry}:ENTITY:${entityId}`,
      providerIdentityKey: `${fullEntry}:ENTITY:${entityId}`,
      attrsScope: {},
      selection: { pdbId, entityIds: [entityId], chainIds: [...allPrimaryChains] },
    },
    {
      variantId: 'scene-selection-only',
      sourceId: fullEntry,
      providerIdentityKey: fullEntry,
      attrsScope: {},
      selection: { pdbId, authAsymIds: [firstChain], chainIds: [firstChain] },
    },
  ];
}

function expectedQueryChainsForVariant(fixtureCase: ComplexCase, variant: ScopeVariant): string[] {
  if (variant.selection.authAsymIds?.length) return variant.selection.authAsymIds;
  if (variant.selection.labelAsymIds?.length) return variant.selection.labelAsymIds;
  if (variant.selection.chainIds?.length) return variant.selection.chainIds;
  return fixtureCase.primaryChains;
}

function scopedSingleQueryAttrs(fixtureCase: ComplexCase, variant: ScopeVariant): Structure3dAttrs {
  const queryMemberId = `member:${fixtureCase.fixtureId}:query`;
  const selection: StructureMemberSelection = {
    providerIdentityKey: variant.providerIdentityKey,
    ...variant.selection,
  };

  return {
    source: 'pdb',
    sourceId: variant.sourceId,
    providerIdentityKey: variant.providerIdentityKey,
    pdbId: fixtureCase.pdbId,
    ...variant.attrsScope,
    label: fixtureCase.fixtureId,
    colorMode: 'chain',
    scene: {
      schemaVersion: 1,
      sceneId: `scene:${fixtureCase.fixtureId}:${variant.variantId}`,
      sceneKind: 'single_query',
      primaryResourceId: variant.providerIdentityKey,
      queryAnchor: {
        memberId: queryMemberId,
        label: 'atpG',
        targetSelection: { ...selection },
      },
      activeFocus: {
        memberId: queryMemberId,
        role: 'query_anchor',
        mappingStatus: 'mapped_current_sequence',
        selection: { ...selection },
      },
      members: [
        {
          memberId: queryMemberId,
          kind: 'protein',
          displayName: 'ATP synthase gamma chain',
          relationToAnchor: 'query',
          mappingStatus: 'mapped_current_sequence',
          selection,
          ...(variant.attrsScope.pdbEntityId
            ? { pdbEntityId: variant.attrsScope.pdbEntityId }
            : {}),
          ...(variant.attrsScope.labelAsymIds
            ? { labelAsymIds: [...variant.attrsScope.labelAsymIds] }
            : {}),
          ...(variant.attrsScope.authAsymIds
            ? { authAsymIds: [...variant.attrsScope.authAsymIds] }
            : {}),
        },
      ],
      layers: [
        {
          id: `layer:model:${variant.providerIdentityKey}`,
          kind: 'model',
          role: 'query',
          visible: true,
          source: {
            source: 'pdb',
            sourceId: variant.providerIdentityKey,
            providerIdentityKey: variant.providerIdentityKey,
            pdbId: fixtureCase.pdbId,
          },
        },
      ],
      provenance: {
        createdBy: 'structure-drawer',
        provider: 'pdb',
        providerIdentityKey: variant.providerIdentityKey,
      },
    },
  };
}

function alphaFoldSingleQueryAttrs(label: string): Structure3dAttrs {
  return {
    source: 'alphafold',
    sourceId: 'AF:P0AB96:F1:LATEST',
    providerIdentityKey: 'AF:P0AB96:F1:LATEST',
    accession: 'P0AB96',
    label,
    scene: {
      schemaVersion: 1,
      sceneId: `scene:${label}:alphafold`,
      sceneKind: 'single_query',
      primaryResourceId: 'AF:P0AB96:F1:LATEST',
      queryAnchor: {
        memberId: `member:${label}:query`,
        label,
        targetSelection: { accession: 'P0AB96' },
      },
      activeFocus: {
        memberId: `member:${label}:query`,
        role: 'query_anchor',
        mappingStatus: 'mapped_current_sequence',
        selection: { accession: 'P0AB96' },
      },
      members: [
        {
          memberId: `member:${label}:query`,
          kind: 'protein',
          displayName: label,
          selection: { accession: 'P0AB96' },
          relationToAnchor: 'query',
          mappingStatus: 'mapped_current_sequence',
        },
      ],
      layers: [],
      provenance: { createdBy: 'structure-drawer', provider: 'alphafold' },
    },
  };
}

function chainSequencesForCase(fixtureCase: ComplexCase): ChainSequence[] {
  return fixtureCase.members.flatMap((member) =>
    member.chains.map((chainId) =>
      chainSequence({
        chainId,
        entityId: member.entityId,
        label: `${member.memberId} chain ${chainId}`,
      })
    )
  );
}

function chainSequence({
  chainId,
  entityId,
  label,
}: {
  chainId: string;
  entityId: string;
  label?: string;
}): ChainSequence {
  return {
    chainId,
    chainLabel: label ?? `Chain ${chainId}`,
    baseChain: chainId,
    labelAsymId: chainId,
    authAsymId: chainId,
    entityId,
    sequence: 'MAG',
    residues: [
      { position: 1, name: 'M', name3: 'MET', value: 90 },
      { position: 2, name: 'A', name3: 'ALA', value: 90 },
      { position: 3, name: 'G', name3: 'GLY', value: 90 },
    ],
  };
}
