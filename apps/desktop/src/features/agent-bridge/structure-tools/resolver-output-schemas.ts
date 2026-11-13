import { z } from 'zod';
import { molecularCatalogObservationSchema } from '../../../shared/molecular-catalog';
import type {
  ResolverResult,
  ResolverSource,
  StructureCandidate,
  StructureRef,
} from '../../structure-drawer/public/types/structure-drawer';
import type {
  ExternalProteinMatch,
  FeatureIdentity,
  IdentityEvidence,
  ProteinIdentityLedger,
  ProteinSequenceIdentity,
  StructureIdentity,
} from '../../structure-drawer/public/api/protein-identity';

const strings = z.array(z.string());
const count = z.number().int().nonnegative();
export const resolverSourceOutputSchema = z.enum([
  'saved_coordinates',
  'computed_coordinates',
  'pdb_xref',
  'uniprot_xref',
  'protein_sequence',
  'rcsb_sequence',
  'protein_id',
  'refseq_xref',
  'geneid_xref',
  'locus_tag',
  'gene_sequence_overlap',
  'gene_organism',
]) satisfies z.ZodType<ResolverSource>;

export const pdbStructureReferenceOutputSchema = z
  .object({
    kind: z.literal('pdb'),
    pdbId: z.string(),
    providerIdentityKey: z.string().optional(),
    pdbEntityId: z.string().optional(),
    labelAsymIds: strings.optional(),
    authAsymIds: strings.optional(),
    assemblyId: z.string().optional(),
    uniprotFallback: z.object({ accession: z.string() }).strict().optional(),
  })
  .strict();
export const uniprotStructureReferenceOutputSchema = z
  .object({
    kind: z.literal('uniprot'),
    accession: z.string(),
    providerIdentityKey: z.string().optional(),
    fragment: z.string().optional(),
    version: z.string().optional(),
    modelId: z.string().optional(),
  })
  .strict();
export const urlStructureReferenceOutputSchema = z
  .object({ kind: z.literal('url'), url: z.string() })
  .strict();
export const inlineStructureReferenceOutputSchema = z
  .object({
    kind: z.literal('data'),
    format: z.enum(['pdb', 'cif']),
    data: z.string(),
    labelAsymIds: strings.optional(),
    coordinateModel: z.object({ blockIndex: count, modelIndex: count }).strict().optional(),
    catalogProvenance: molecularCatalogObservationSchema.optional(),
  })
  .strict();
export const structureReferenceOutputSchema = z.discriminatedUnion('kind', [
  pdbStructureReferenceOutputSchema,
  uniprotStructureReferenceOutputSchema,
  urlStructureReferenceOutputSchema,
  inlineStructureReferenceOutputSchema,
]) satisfies z.ZodType<StructureRef>;

const externalMatchKind = z.enum(['exact_sequence', 'xref', 'id_mapping', 'name_search']);
const externalUniProtIdentity = z
  .object({
    kind: z.literal('uniprot'),
    id: z.string(),
    accession: z.string(),
    providerIdentityKey: z.string(),
    reviewed: z.boolean().optional(),
    taxonId: z.number().optional(),
    organism: z.string().optional(),
    match: externalMatchKind,
    sequenceIdentity: z.number().optional(),
    checksumMd5: z.string().optional(),
    rankReasons: strings.optional(),
    lastValidatedAt: z.string().optional(),
    evidenceIds: strings,
  })
  .strict();
export const externalProteinMatchOutputSchema = externalUniProtIdentity.extend({
  rank: z.number(),
  rankReasons: strings,
  selected: z.boolean(),
}) satisfies z.ZodType<ExternalProteinMatch>;
const externalProteinIdentity = z.discriminatedUnion('kind', [
  externalUniProtIdentity,
  z
    .object({
      kind: z.enum(['refseq_protein', 'genbank_protein', 'ncbi_gene', 'gene_symbol']),
      id: z.string(),
      taxonId: z.number().optional(),
      evidenceIds: strings,
    })
    .strict(),
]);
export const featureIdentityOutputSchema = z
  .object({
    kind: z.literal('sequence_feature'),
    entityId: z.string().optional(),
    featureKey: z.string(),
    label: z.string().optional(),
    location: z
      .object({
        segments: z.array(
          z
            .object({
              start0: z.number(),
              end0: z.number(),
              strand: z.union([z.literal(1), z.literal(-1)]),
            })
            .strict()
        ),
        circular: z.boolean(),
      })
      .strict(),
    hintSummary: z
      .object({
        dbXrefCount: count,
        hasProteinId: z.boolean(),
        hasLocusTag: z.boolean(),
        hasGeneName: z.boolean(),
        taxonId: z.number().optional(),
      })
      .strict(),
    evidenceIds: strings,
  })
  .strict() satisfies z.ZodType<FeatureIdentity>;
export const proteinSequenceIdentityOutputSchema = z
  .object({
    kind: z.literal('protein_sequence'),
    schemaVersion: z.literal(2),
    identityKey: z.string(),
    canonicalizationStatus: z.enum(['renderer_preflight', 'sidecar_confirmed']),
    lookupSequence: z.string(),
    canonicalLookupSequence: z.string(),
    length: count,
    source: z.enum([
      'allele_translation',
      'qualifier_translation',
      'derived_cds',
      'standalone_protein_entity',
    ]),
    rawSequence: z.string().optional(),
    derivedSequence: z.string().optional(),
    qualifierSequence: z.string().optional(),
    startCodon: z.string().nullable(),
    initiatorNormalized: z.boolean(),
    translationConfig: z
      .object({
        geneticCode: z.number(),
        frame: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      })
      .strict()
      .optional(),
    digests: z.object({ md5: z.string().optional(), sha256: z.string() }).strict(),
    evidenceIds: strings,
  })
  .strict() satisfies z.ZodType<ProteinSequenceIdentity>;
export const structureIdentityOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rcsb'),
      id: z.string(),
      pdbId: z.string(),
      providerIdentityKey: z.string(),
      pdbEntityId: z.string().optional(),
      labelAsymIds: strings.optional(),
      authAsymIds: strings.optional(),
      assemblyId: z.string().optional(),
      uniprotIds: strings.optional(),
      referenceSequenceIds: strings.optional(),
      entitySequenceLength: count.optional(),
      chainCoverage: z.number().optional(),
      source: z.enum(['direct_xref', 'uniprot_xref', 'rcsb_metadata', 'sequence_similarity']),
      sequenceIdentity: z.number().optional(),
      coverage: z.number().optional(),
      lastValidatedAt: z.string().optional(),
      evidenceIds: strings,
    })
    .strict(),
  z
    .object({
      kind: z.literal('alphafold'),
      id: z.string(),
      accession: z.string(),
      providerIdentityKey: z.string(),
      modelId: z.string().optional(),
      version: z.string().optional(),
      fragment: z.string().optional(),
      source: z.enum(['uniprot_accession', 'provider_validation']),
      meanPlddt: z.number().optional(),
      lastValidatedAt: z.string().optional(),
      evidenceIds: strings,
    })
    .strict(),
]) satisfies z.ZodType<StructureIdentity>;
export const identityEvidenceOutputSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string(),
    kind: z.enum([
      'allele_translation',
      'qualifier_translation',
      'qualifier_translation_invalid',
      'qualifier_translation_mismatch',
      'derived_cds_translation',
      'registered_protein_entity',
      'initiator_normalization',
      'internal_stop',
      'non_standard_residue',
      'protein_invalid_residue',
      'canonicalization_mismatch',
      'genbank_db_xref',
      'genbank_protein_id',
      'genbank_locus_tag',
      'genbank_gene_name',
      'label_gene_token',
      'exact_sequence_checksum',
      'exact_sequence_no_match',
      'ambiguous_exact_sequence',
      'provider_cross_reference',
      'provider_validation',
      'provider_metadata',
      'provider_no_match',
      'provider_error',
      'provider_timeout',
      'provider_unavailable',
      'similarity_search',
    ]),
    source: z.enum(['genbank', 'sequence_viewer', 'uniprot', 'rcsb', 'alphafold', 'waypoint']),
    confidence: z.enum(['authoritative', 'exact', 'strong', 'heuristic', 'degraded']),
    label: z.string(),
    details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict() satisfies z.ZodType<IdentityEvidence>;
export const proteinResolutionSetOutputSchema = z
  .object({
    kind: z.literal('protein_resolution_set'),
    queryMd5: z.string(),
    selectedExternalProteinId: z.string().nullable(),
    matches: z.array(externalProteinMatchOutputSchema),
    evidenceIds: strings,
  })
  .strict();
export const proteinIdentityLedgerOutputSchema = z
  .object({
    schemaVersion: z.literal(2),
    feature: featureIdentityOutputSchema.optional(),
    sequence: proteinSequenceIdentityOutputSchema,
    externalProteins: z.array(externalProteinIdentity),
    resolutionSets: z.array(proteinResolutionSetOutputSchema),
    structures: z.array(structureIdentityOutputSchema),
    evidence: z.array(identityEvidenceOutputSchema),
  })
  .strict() satisfies z.ZodType<ProteinIdentityLedger>;

export const structureCandidateMetadataOutputSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    method: z.string().optional(),
    resolution: z.number().optional(),
    chainCount: count.optional(),
    chainIds: strings.optional(),
    polymerTypes: strings.optional(),
    entityDescriptions: strings.optional(),
    organism: z.string().optional(),
    sourceUrl: z.string().optional(),
    license: z.string().optional(),
    attribution: z.string().optional(),
    depositionDate: z.string().optional(),
    initialReleaseDate: z.string().optional(),
    revisionDate: z.string().optional(),
    revisionVersion: z.string().optional(),
    meanPlddt: z.number().optional(),
    uniprotAccession: z.string().optional(),
    pdbId: z.string().optional(),
  })
  .strict();
const candidateExternalProtein = externalProteinMatchOutputSchema.pick({
  kind: true,
  accession: true,
  reviewed: true,
  match: true,
  checksumMd5: true,
  rank: true,
  rankReasons: true,
});
export const structureCandidateProvenanceOutputSchema = z
  .object({
    resolverSource: resolverSourceOutputSchema,
    identity: z.number(),
    sequenceIdentity: z.number().optional(),
    externalProtein: candidateExternalProtein.optional(),
    queryIdentity: z
      .object({
        kind: z.literal('protein_sequence'),
        canonicalForm: z.literal('waypoint-protein-v2'),
        checksumMd5: z.string(),
        checksumSha256: z.string(),
        ineligible: z.boolean(),
        evidenceKinds: strings,
      })
      .strict()
      .optional(),
    structureIdentity: z
      .object({
        kind: z.enum(['rcsb', 'alphafold']),
        providerIdentityKey: z.string(),
        pdbId: z.string().optional(),
        pdbEntityId: z.string().optional(),
        labelAsymIds: strings.optional(),
        authAsymIds: strings.optional(),
        assemblyId: z.string().optional(),
        accession: z.string().optional(),
        version: z.string().optional(),
        fragment: z.string().optional(),
        modelId: z.string().optional(),
      })
      .strict()
      .optional(),
    externalResourceId: z.string().optional(),
    cacheHit: z.boolean().optional(),
  })
  .strict();
export const structureCandidateOutputSchema = z
  .object({
    id: z.string(),
    provider: z.enum(['pdb', 'alphafold']),
    structure: structureReferenceOutputSchema,
    label: z.string(),
    group: z.enum(['rcsb', 'alphafold']),
    rank: z.number(),
    metadata: structureCandidateMetadataOutputSchema,
    provenance: structureCandidateProvenanceOutputSchema,
  })
  .strict() satisfies z.ZodType<StructureCandidate>;
export const resolverResultOutputSchema = z
  .object({
    source: resolverSourceOutputSchema,
    identity: z.number(),
    structure: structureReferenceOutputSchema,
    proteinIdentity: proteinIdentityLedgerOutputSchema.optional(),
    recommendedCandidateId: z.string().optional(),
    candidates: z.array(structureCandidateOutputSchema).optional(),
    confidenceNote: z.string().optional(),
  })
  .strict() satisfies z.ZodType<ResolverResult>;
