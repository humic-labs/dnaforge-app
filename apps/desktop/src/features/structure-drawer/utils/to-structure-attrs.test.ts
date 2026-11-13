import { describe, it, expect } from 'vitest';
import { resolverResultToStructureAttrs } from './to-structure-attrs';
import type { ProteinIdentityLedger } from '../api/protein-identity';
import type { ResolverResult, StructureDrawerRequest } from '../types/structure-drawer';
import type { Structure3dAttrs } from '../../page/embeds/structure3d/types';

const PDB_RESULT: ResolverResult = {
  source: 'pdb_xref',
  identity: 1,
  structure: { kind: 'pdb', pdbId: '1tup' },
};

const UNIPROT_RESULT: ResolverResult = {
  source: 'uniprot_xref',
  identity: 1,
  structure: { kind: 'uniprot', accession: 'p0ad86' },
  confidenceNote: 'Mean pLDDT 78.4',
};

const URL_RESULT: ResolverResult = {
  source: 'protein_id',
  identity: 1,
  structure: { kind: 'url', url: 'https://files.rcsb.org/download/1TUP.cif' },
};

const DATA_RESULT: ResolverResult = {
  source: 'protein_id',
  identity: 1,
  structure: { kind: 'data', format: 'pdb', data: 'HEADER inline pdb' },
};

const PROTEIN_IDENTITY: ProteinIdentityLedger = {
  schemaVersion: 2,
  feature: {
    kind: 'sequence_feature',
    entityId: 'sequence-document:mg1655',
    featureKey: 'CDS:thrL:190-255',
    label: 'thrL',
    location: {
      segments: [{ start0: 190, end0: 255, strand: 1 }],
      circular: false,
    },
    hintSummary: {
      dbXrefCount: 1,
      hasProteinId: true,
      hasLocusTag: true,
      hasGeneName: true,
    },
    evidenceIds: ['evidence:feature'],
  },
  sequence: {
    kind: 'protein_sequence',
    schemaVersion: 2,
    identityKey: 'protein:thrL',
    canonicalizationStatus: 'renderer_preflight',
    lookupSequence: 'MKRISTTITTTITITTGNGAG',
    canonicalLookupSequence: 'MKRISTTITTTITITTGNGAG',
    length: 21,
    source: 'qualifier_translation',
    startCodon: 'ATG',
    initiatorNormalized: false,
    digests: {
      sha256: 'sha256',
    },
    evidenceIds: ['evidence:translation'],
  },
  externalProteins: [],
  resolutionSets: [],
  structures: [],
  evidence: [
    {
      schemaVersion: 2,
      id: 'evidence:feature',
      kind: 'genbank_gene_name',
      source: 'genbank',
      confidence: 'authoritative',
      label: 'thrL',
    },
    {
      schemaVersion: 2,
      id: 'evidence:translation',
      kind: 'qualifier_translation',
      source: 'genbank',
      confidence: 'authoritative',
      label: 'CDS translation',
    },
  ],
};

const REQUEST: StructureDrawerRequest = {
  translation: 'MKRISTTITTTITITTGNGAG',
  proteinIdentity: PROTEIN_IDENTITY,
  identityRequestKey: 'request:thrL',
  cdsLabel: 'thrL',
  entityId: 'sequence-document:mg1655',
  sourceWorkspaceRoot: '/workspace',
  cdsBounds: { cdsStart: 190, cdsEnd: 255, strand: 1 },
  hints: {
    geneName: 'thrL',
    locusTag: 'b0001',
  },
};

const CANDIDATE_RESULT: ResolverResult = {
  source: 'protein_sequence',
  identity: 1,
  structure: { kind: 'uniprot', accession: 'P00880' },
  recommendedCandidateId: 'rcsb:RCSB:1RBL:ENTRY:all',
  candidates: [
    {
      id: 'rcsb:RCSB:1RBL:ENTRY:all',
      provider: 'pdb',
      structure: { kind: 'pdb', pdbId: '1RBL', providerIdentityKey: 'RCSB:1RBL:ENTRY' },
      label: '1RBL',
      group: 'rcsb',
      rank: 0,
      metadata: {
        pdbId: '1RBL',
        title: 'Rubisco large subunit',
        method: 'X-ray',
        resolution: 2.2,
      },
      provenance: { resolverSource: 'protein_sequence', identity: 1 },
    },
    {
      id: 'alphafold:AF:P00880:F1:LATEST:all',
      provider: 'alphafold',
      structure: {
        kind: 'uniprot',
        accession: 'P00880',
        providerIdentityKey: 'AF:P00880:F1:LATEST',
        fragment: 'F1',
        version: 'LATEST',
      },
      label: 'P00880',
      group: 'alphafold',
      rank: 1,
      metadata: {
        uniprotAccession: 'P00880',
        title: 'AlphaFold P00880',
        organism: 'Synechococcus elongatus',
      },
      provenance: { resolverSource: 'protein_sequence', identity: 1 },
    },
  ],
};

function legacyAttrs(attrs: Structure3dAttrs): Omit<Structure3dAttrs, 'scene' | 'view'> {
  const { scene: _scene, view: _view, ...rest } = attrs;
  return rest;
}

describe('resolverResultToStructureAttrs', () => {
  it('PDB result: maps to source="pdb" + uppercase id + chain coloring', () => {
    const out = resolverResultToStructureAttrs(PDB_RESULT, 'thrL');
    expect(out.structureId).toBe('structure:RCSB:1TUP:ENTRY');
    expect(out.label).toBe('thrL');
    expect(legacyAttrs(out.attrs)).toEqual({
      source: 'pdb',
      sourceId: 'RCSB:1TUP:ENTRY',
      providerIdentityKey: 'RCSB:1TUP:ENTRY',
      pdbId: '1TUP',
      label: 'thrL',
      representation: 'cartoon',
      colorMode: 'chain',
    });
  });

  it('UniProt result: maps to source="alphafold" + uppercase accession + plddt coloring', () => {
    const out = resolverResultToStructureAttrs(UNIPROT_RESULT, 'thrL');
    expect(out.structureId).toBe('structure:AF:P0AD86:F1:LATEST');
    expect(out.label).toBe('thrL');
    expect(legacyAttrs(out.attrs)).toEqual({
      source: 'alphafold',
      sourceId: 'AF:P0AD86:F1:LATEST',
      providerIdentityKey: 'AF:P0AD86:F1:LATEST',
      uniprotId: 'P0AD86',
      accession: 'P0AD86',
      fragment: 'F1',
      version: 'LATEST',
      label: 'thrL',
      representation: 'cartoon',
      colorMode: 'plddt',
    });
  });

  it('uses the committed candidate identity and metadata when candidates are present', () => {
    const out = resolverResultToStructureAttrs(CANDIDATE_RESULT, undefined);
    expect(out.structureId).toBe('structure:alphafold:AF:P00880:F1:LATEST:all');
    expect(out.label).toBe('P00880');
    expect(legacyAttrs(out.attrs)).toEqual({
      source: 'alphafold',
      sourceId: 'AF:P00880:F1:LATEST',
      providerIdentityKey: 'AF:P00880:F1:LATEST',
      uniprotId: 'P00880',
      accession: 'P00880',
      fragment: 'F1',
      version: 'LATEST',
      label: 'P00880',
      title: 'AlphaFold P00880',
      organism: 'Synechococcus elongatus',
      representation: 'cartoon',
      colorMode: 'plddt',
    });
  });

  it('falls back to the accession/pdbId when cdsLabel is absent', () => {
    expect(resolverResultToStructureAttrs(PDB_RESULT, undefined).label).toBe('1TUP');
    expect(resolverResultToStructureAttrs(UNIPROT_RESULT, undefined).label).toBe('P0AD86');
  });

  it('URL result: maps to source="url" and uses the URL as the panel sourceId', () => {
    const out = resolverResultToStructureAttrs(URL_RESULT, undefined);
    expect(out.structureId).toBe('url:https://files.rcsb.org/download/1TUP.cif');
    expect(out.label).toBe('1TUP.cif');
    expect(legacyAttrs(out.attrs)).toEqual({
      source: 'url',
      sourceId: 'https://files.rcsb.org/download/1TUP.cif',
      url: 'https://files.rcsb.org/download/1TUP.cif',
      label: '1TUP.cif',
      representation: 'cartoon',
      colorMode: 'chain',
    });
  });

  it('inline data result: maps to source="file" and hashes raw data for the panel id', () => {
    const out = resolverResultToStructureAttrs(DATA_RESULT, undefined);
    expect(out.structureId).toBe('data:auto:876d0ec5');
    expect(out.structureId).not.toContain('HEADER inline pdb');
    expect(out.label).toBe('Inline PDB');
    expect(legacyAttrs(out.attrs)).toEqual({
      source: 'file',
      sourceId: 'HEADER inline pdb',
      label: 'Inline PDB',
      representation: 'cartoon',
      colorMode: 'chain',
    });
  });

  it('structureId is deterministic (same inputs → same id)', () => {
    const a = resolverResultToStructureAttrs(UNIPROT_RESULT, 'thrL');
    const b = resolverResultToStructureAttrs(UNIPROT_RESULT, 'thrL');
    expect(a.structureId).toBe(b.structureId);
  });

  it('attaches a single-query scene with stable query anchor from the drawer request', () => {
    const scopedResult: ResolverResult = {
      ...PDB_RESULT,
      structure: {
        kind: 'pdb',
        pdbId: '1tup',
        providerIdentityKey: 'RCSB:1TUP:ENTITY:1',
        pdbEntityId: '1',
        labelAsymIds: ['A'],
        authAsymIds: ['A'],
        assemblyId: '1',
      },
    };
    const out = resolverResultToStructureAttrs(scopedResult, 'thrL', REQUEST);

    expect(out.attrs.scene).toMatchObject({
      schemaVersion: 1,
      sceneKind: 'single_query',
      primaryResourceId: 'RCSB:1TUP:ENTITY:1',
      queryAnchor: {
        sourceEntityId: 'sequence-document:mg1655',
        sourceWorkspaceRoot: '/workspace',
        identityRequestKey: 'request:thrL',
        cdsBounds: { cdsStart: 190, cdsEnd: 255, strand: 1 },
        label: 'thrL',
        proteinIdentity: PROTEIN_IDENTITY,
        targetSelection: {
          providerIdentityKey: 'RCSB:1TUP:ENTITY:1',
          pdbId: '1TUP',
          entityIds: ['1'],
          labelAsymIds: ['A'],
          authAsymIds: ['A'],
        },
      },
      activeFocus: {
        role: 'query_anchor',
        mappingStatus: 'mapped_current_sequence',
      },
      members: [
        expect.objectContaining({
          kind: 'protein',
          displayName: 'thrL',
          relationToAnchor: 'query',
          mappingStatus: 'mapped_current_sequence',
          workspaceFeatureRef: {
            entityId: 'sequence-document:mg1655',
            featureKey: 'CDS:thrL:190-255',
            cdsBounds: { cdsStart: 190, cdsEnd: 255, strand: 1 },
            label: 'thrL',
          },
        }),
      ],
    });
    expect(out.attrs.scene?.queryAnchor.memberId).toBe(out.attrs.scene?.activeFocus?.memberId);
    expect(out.attrs.scene?.queryAnchor.targetSelection).not.toBe(
      out.attrs.scene?.members[0].selection
    );
    expect(out.attrs.scene?.queryAnchor.targetSelection.chainIds).toBeUndefined();
    expect(out.attrs.scene?.activeFocus?.selection).not.toBe(
      out.attrs.scene?.queryAnchor.targetSelection
    );
  });

  it('promotes heteromeric PDB candidates into complex scenes with visible context-chain members', () => {
    const result: ResolverResult = {
      source: 'protein_sequence',
      identity: 1,
      structure: {
        kind: 'pdb',
        pdbId: '1FS0',
        providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
        authAsymIds: ['G'],
      },
      recommendedCandidateId: 'rcsb:RCSB:1FS0:ENTRY:AUTH_ASYM:G',
      candidates: [
        {
          id: 'rcsb:RCSB:1FS0:ENTRY:AUTH_ASYM:G',
          provider: 'pdb',
          structure: {
            kind: 'pdb',
            pdbId: '1FS0',
            providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
            authAsymIds: ['G'],
          },
          label: '1FS0',
          group: 'rcsb',
          rank: 0,
          metadata: {
            pdbId: '1FS0',
            title: 'COMPLEX OF GAMMA/EPSILON ATP SYNTHASE FROM E.COLI',
            method: 'X-ray',
            resolution: 2.1,
            chainCount: 2,
            chainIds: ['E', 'G'],
            polymerTypes: ['Protein'],
            entityDescriptions: ['ATP synthase epsilon chain', 'ATP synthase gamma chain'],
          },
          provenance: {
            resolverSource: 'protein_sequence',
            identity: 1,
            structureIdentity: {
              kind: 'rcsb',
              providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
              pdbId: '1FS0',
              authAsymIds: ['G'],
            },
          },
        },
      ],
    };

    const out = resolverResultToStructureAttrs(result, 'atpG', {
      ...REQUEST,
      cdsLabel: 'atpG',
      identityRequestKey: 'request:atpG',
    });

    expect(out.attrs.scene).toMatchObject({
      sceneKind: 'complex',
      primaryResourceId: 'RCSB:1FS0:ENTRY',
      queryAnchor: {
        label: 'atpG',
        targetSelection: {
          providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
          pdbId: '1FS0',
          authAsymIds: ['G'],
        },
      },
      activeFocus: {
        role: 'query_anchor',
        selection: {
          authAsymIds: ['G'],
        },
      },
      members: [
        expect.objectContaining({
          displayName: 'atpG',
          relationToAnchor: 'query',
          authAsymIds: ['G'],
        }),
        expect.objectContaining({
          displayName: 'Chain E',
          relationToAnchor: 'known_partner',
          mappingStatus: 'unmapped',
          authAsymIds: ['E'],
          selection: expect.objectContaining({
            pdbId: '1FS0',
            authAsymIds: ['E'],
          }),
        }),
      ],
    });
    expect(out.attrs.scene?.queryAnchor.memberId).toBe(out.attrs.scene?.activeFocus?.memberId);
    expect(out.attrs.scene?.queryAnchor.targetSelection.chainIds).toBeUndefined();
    expect(out.attrs.scene?.members[1].selection.chainIds).toBeUndefined();
    expect(out.attrs.view).toMatchObject({
      activeRecipeId: 'query-in-complex',
      recipe: {
        id: 'query-in-complex',
        layers: expect.arrayContaining([
          expect.objectContaining({
            target: { kind: 'whole-complex' },
            representation: { kind: 'cartoon' },
            color: { mode: 'context-muted' },
          }),
          expect.objectContaining({
            target: { kind: 'query-anchor' },
            representation: { kind: 'cartoon' },
            color: { mode: 'source-default' },
          }),
        ]),
      },
    });

    const preview = resolverResultToStructureAttrs(
      result,
      'atpG',
      {
        ...REQUEST,
        cdsLabel: 'atpG',
        identityRequestKey: 'request:atpG',
      },
      {
        renderIntent: 'preview',
      }
    );

    expect(preview.attrs.view).toMatchObject({
      activeRecipeId: 'query-in-complex-preview',
      recipe: {
        id: 'query-in-complex-preview',
        layers: expect.arrayContaining([
          expect.objectContaining({
            target: { kind: 'whole-complex' },
            representation: { kind: 'cartoon' },
            color: { mode: 'context-muted' },
          }),
          expect.objectContaining({
            target: { kind: 'query-anchor' },
            representation: { kind: 'cartoon' },
            color: { mode: 'source-default' },
          }),
        ]),
      },
    });
    expect(
      preview.attrs.view?.recipe.layers.some((layer) => layer.representation.kind === 'surface')
    ).toBe(false);
  });

  it('seeds the composable view state for drawer-opened structures', () => {
    const out = resolverResultToStructureAttrs(PDB_RESULT, 'thrL', REQUEST);

    expect(out.attrs.view).toMatchObject({
      schemaVersion: 1,
      activeRecipeId: 'cartoon',
      recipe: {
        id: 'cartoon',
        layers: [
          {
            target: { kind: 'whole-structure' },
            representation: { kind: 'cartoon' },
            color: { mode: 'source-default' },
          },
        ],
      },
      showWater: false,
      spin: false,
    });
  });
});
