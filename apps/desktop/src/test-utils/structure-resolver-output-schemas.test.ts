import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertMcpOutput } from './mcp-output-test-helper';
import { molOpenDrawerOutputSchema } from '../features/agent-bridge/structure-tools/output-schemas';
import {
  resolverResultOutputSchema,
  structureReferenceOutputSchema,
} from '../features/agent-bridge/structure-tools/resolver-output-schemas';
import { resolveStructureRequest } from '../features/structure-drawer/api/structure-resolver';
import { pdbXrefStep } from '../features/structure-drawer/api/steps/pdb-xref';
import { uniprotXrefStep } from '../features/structure-drawer/api/steps/uniprot-xref';
import {
  buildFeatureIdentity,
  buildProteinSequenceIdentity,
  makeIdentityEvidence,
} from '../features/structure-drawer/public/api/protein-identity';
import type {
  ResolverResult,
  StructureDrawerRequest,
} from '../features/structure-drawer/public/types/structure-drawer';

const providers = vi.hoisted(() => ({ rcsb: vi.fn(), alphafold: vi.fn() }));
vi.mock('../features/structure-drawer/api/sidecar-client', async (original) => ({
  ...(await original<typeof import('../features/structure-drawer/api/sidecar-client')>()),
  sidecarFetchRcsbMetadata: providers.rcsb,
  sidecarValidateAfdb: providers.alphafold,
}));

function request(dbXrefs: string[]): StructureDrawerRequest {
  const evidence = makeIdentityEvidence({
    kind: 'derived_cds_translation',
    source: 'waypoint',
    confidence: 'authoritative',
    label: 'Synthetic CDS translation',
  });
  const sequence = buildProteinSequenceIdentity({
    lookupSequence: 'MKK',
    source: 'derived_cds',
    startCodon: 'ATG',
    initiatorNormalized: false,
    translationConfig: { geneticCode: 11, frame: 0 },
    evidenceIds: [evidence.id],
  });
  if (!sequence) throw new Error('Synthetic protein identity could not be built');
  return {
    entityId: 'document-fixture',
    translation: 'MKK',
    hints: { dbXrefs },
    proteinIdentity: {
      schemaVersion: 2,
      feature: buildFeatureIdentity({
        type: 'CDS',
        entityId: 'document-fixture',
        label: 'Synthetic CDS',
        circular: false,
        segments: [{ start0: 0, end0: 9, strand: 1 }],
        hintSummary: {
          dbXrefCount: dbXrefs.length,
          hasProteinId: false,
          hasLocusTag: false,
          hasGeneName: false,
        },
      }),
      sequence,
      externalProteins: [],
      resolutionSets: [],
      structures: [],
      evidence: [evidence],
    },
  };
}
async function resolved(kind: 'pdb' | 'uniprot'): Promise<ResolverResult> {
  const result = await resolveStructureRequest(
    request([kind === 'pdb' ? 'PDB:1ABC' : 'UniProtKB/Swiss-Prot:P0A7Y4']),
    new AbortController().signal,
    { steps: [kind === 'pdb' ? pdbXrefStep : uniprotXrefStep] }
  );
  if (!result) throw new Error('Synthetic provider fixture did not resolve');
  return result;
}
function drawerReceipt(result: ResolverResult) {
  return {
    ok: true,
    status: 'rendering',
    bytesReady: true,
    documentId: 'document-fixture',
    resourceUri: 'sequence://document-fixture',
    annotationIndex: 0,
    resolved: result,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  providers.rcsb.mockResolvedValue({
    externalResourceId: 'resource1',
    cacheHit: false,
    pdbId: '1ABC',
    title: 'Synthetic deposited structure',
    method: 'X-RAY DIFFRACTION',
    resolution: 1.8,
    chainCount: 2,
    chainIds: ['A', 'B'],
    polymerTypes: ['Protein'],
    entityDescriptions: ['Synthetic protein'],
    organism: 'Synthetic fixture',
    sourceUrl: 'https://www.rcsb.org/structure/1ABC',
    license: 'CC0',
    attribution: 'Fixture',
    depositionDate: '2020-01-01',
    initialReleaseDate: '2020-02-01',
    revisionDate: '2021-01-01',
    revisionVersion: '1.1',
  });
  providers.alphafold.mockResolvedValue({
    accession: 'P0A7Y4',
    meanPlddt: 87.5,
    latestVersion: 6,
    fragment: 'F1',
    modelId: 'AF-P0A7Y4-F1-model_v6',
    providerIdentityKey: 'AF:P0A7Y4:F1:V6:MODEL:AF-P0A7Y4-F1-model_v6',
  });
});

describe('finite structure resolver MCP contracts', () => {
  it.each(['pdb', 'uniprot'] as const)(
    'validates actual %s resolver candidates, provenance and attached identity ledgers',
    async (kind) => {
      const result = await resolved(kind);
      assertMcpOutput(resolverResultOutputSchema, result);
      assertMcpOutput(molOpenDrawerOutputSchema, drawerReceipt(result));
      expect(result.candidates?.[0].provenance).toMatchObject({
        resolverSource: kind === 'pdb' ? 'pdb_xref' : 'uniprot_xref',
        identity: 1,
      });
      expect(result.proteinIdentity?.sequence).toMatchObject({
        kind: 'protein_sequence',
        canonicalizationStatus: 'renderer_preflight',
        digests: { sha256: expect.any(String) },
      });
      if (kind === 'uniprot')
        expect(result.proteinIdentity?.resolutionSets[0].matches[0]).toMatchObject({
          kind: 'uniprot',
          accession: 'P0A7Y4',
          rank: 0,
          selected: true,
        });
    }
  );

  it.each([
    {
      kind: 'pdb',
      pdbId: '1ABC',
      pdbEntityId: '1',
      labelAsymIds: ['A'],
      authAsymIds: ['A'],
      assemblyId: '1',
      uniprotFallback: { accession: 'P0A7Y4' },
    },
    {
      kind: 'uniprot',
      accession: 'P0A7Y4',
      fragment: 'F1',
      version: 'V6',
      modelId: 'AF-P0A7Y4-F1-model_v6',
    },
    { kind: 'url', url: 'https://files.rcsb.org/download/1ABC.cif' },
    {
      kind: 'data',
      format: 'cif',
      data: 'data_synthetic',
      labelAsymIds: ['A'],
      coordinateModel: { blockIndex: 0, modelIndex: 0 },
    },
  ])('validates the complete finite $kind coordinate reference', (reference) => {
    assertMcpOutput(structureReferenceOutputSchema, reference);
  });

  it.each([
    { kind: 'pdb' },
    { kind: 'uniprot' },
    { kind: 'url' },
    { kind: 'data', format: 'cif' },
    { kind: 'unknown', path: '/arbitrary' },
  ])('rejects an incomplete or unknown coordinate reference $kind', (reference) => {
    expect(() => assertMcpOutput(structureReferenceOutputSchema, reference)).toThrow(
      'MCP output contract rejected'
    );
  });

  it.each([
    { label: 'missing PDB identity', path: ['structure'], value: { kind: 'pdb' } },
    {
      label: 'candidate missing provenance',
      path: ['candidates', '0', 'provenance'],
      remove: true,
    },
    {
      label: 'non-numeric candidate metadata',
      path: ['candidates', '0', 'metadata', 'meanPlddt'],
      value: 'high',
    },
    {
      label: 'undeclared plugin metadata',
      path: ['candidates', '0', 'metadata', 'sizeFactor'],
      value: 0.5,
    },
    {
      label: 'incomplete candidate query identity',
      path: ['candidates', '0', 'provenance', 'queryIdentity'],
      value: { kind: 'protein_sequence' },
    },
    {
      label: 'unknown candidate identity family',
      path: ['candidates', '0', 'provenance', 'structureIdentity', 'kind'],
      value: 'arbitrary',
    },
    {
      label: 'arbitrary resolution match JSON',
      path: ['proteinIdentity', 'resolutionSets', '0', 'matches'],
      value: [{ arbitrary: true }],
    },
    {
      label: 'resolution match missing accession',
      path: ['proteinIdentity', 'resolutionSets', '0', 'matches', '0', 'accession'],
      remove: true,
    },
    {
      label: 'resolution match missing selection',
      path: ['proteinIdentity', 'resolutionSets', '0', 'matches', '0', 'selected'],
      remove: true,
    },
    {
      label: 'resolution match wrong rank type',
      path: ['proteinIdentity', 'resolutionSets', '0', 'matches', '0', 'rank'],
      value: 'first',
    },
    {
      label: 'missing canonical sequence status',
      path: ['proteinIdentity', 'sequence', 'canonicalizationStatus'],
      remove: true,
    },
    {
      label: 'missing sequence digest',
      path: ['proteinIdentity', 'sequence', 'digests', 'sha256'],
      remove: true,
    },
    {
      label: 'feature missing strand',
      path: ['proteinIdentity', 'feature', 'location', 'segments', '0', 'strand'],
      remove: true,
    },
    {
      label: 'unknown external protein family',
      path: ['proteinIdentity', 'externalProteins', '0', 'kind'],
      value: 'arbitrary',
    },
    {
      label: 'incomplete deposited structure identity',
      path: ['proteinIdentity', 'structures'],
      value: [{ kind: 'rcsb', id: 'RCSB:1ABC:ENTRY', evidenceIds: [] }],
    },
    {
      label: 'unknown evidence kind',
      path: ['proteinIdentity', 'evidence', '0', 'kind'],
      value: 'arbitrary',
    },
    {
      label: 'unknown confidence',
      path: ['proteinIdentity', 'evidence', '0', 'confidence'],
      value: 'certain',
    },
    { label: 'unknown resolver source', path: ['source'], value: 'plugin' },
  ])(
    'rejects $label instead of advertising a successful malformed drawer result',
    async (corruption) => {
      const value = structuredClone(await resolved('uniprot'));
      let parent: unknown = value;
      for (const key of corruption.path.slice(0, -1)) {
        if (!parent || typeof parent !== 'object')
          throw new Error(`Malformed test fixture at ${key}`);
        parent = (parent as Record<string, unknown>)[key];
      }
      if (!parent || typeof parent !== 'object') throw new Error('Malformed test fixture parent');
      const field = corruption.path[corruption.path.length - 1];
      if (corruption.remove) delete (parent as Record<string, unknown>)[field];
      else (parent as Record<string, unknown>)[field] = corruption.value;
      expect(() => assertMcpOutput(molOpenDrawerOutputSchema, drawerReceipt(value))).toThrow(
        'MCP output contract rejected'
      );
    }
  );
});
