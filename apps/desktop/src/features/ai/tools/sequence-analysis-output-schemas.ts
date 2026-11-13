import { z } from 'zod';

const count = z.number().int().nonnegative();
const success = { ok: z.literal(true) };
const pendingOperationState = z.enum([
  'queued',
  'running',
  'stopping',
  'failed',
  'canceled',
  'interrupted',
]);
const operationError = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .nullable()
      .optional(),
  })
  .strict();
const trackStatus = z.enum(['pass', 'variants', 'fail', 'incomplete']);
const variantCallBase = z
  .object({
    id: z.string(),
    position: z.number(),
    allele_index: z.number(),
    reference: z.string(),
    alternate: z.string(),
    filters: z.array(z.string()),
    genotype: z.string().nullable(),
    quality: z.number().nullable(),
    allele_fraction: z.number().nullable().optional(),
    alternate_count: z.number().nullable().optional(),
    reference_count: z.number().nullable().optional(),
    total_allele_count: z.number().nullable().optional(),
    unsupported_reason: z.string().nullable().optional(),
  })
  .strict();
const variantCall = z.union([
  variantCallBase.extend({
    proteinContext: z
      .object({ status: z.literal('unavailable'), reason: z.string() })
      .strict(),
  }),
  variantCallBase.extend({
    proteinContext: z
      .object({
        status: z.literal('mapped'),
        basis: z.literal('current coding annotation'),
        moleculeId: z.string().optional(),
        label: z.string(),
        proteinSequenceSha256: z.string(),
        proteinLength: count,
        residues: z.array(z.number().int().positive()),
        effect: z.enum([
          'synonymous',
          'missense',
          'stop-gained',
          'conditional-stop',
          'frameshift',
          'in-frame-insertion',
          'in-frame-deletion',
        ]),
        changes: z.array(
          z.object({ residue: z.number().int().positive(), reference: z.string(), alternate: z.string() }).strict()
        ),
        affectedTail: z
          .object({ start: z.number().int().positive(), end: z.number().int().positive() })
          .strict()
          .optional(),
      })
      .strict(),
    inspection: z
      .object({
        tool: z.literal('inspect_variant_call'),
        arguments: z.object({ analysisId: z.string(), callId: z.string() }).strict(),
      })
      .strict(),
  }),
]);
const variantAnalysisContinuation = z
  .object({
    tool: z.literal('get_variant_analysis'),
    arguments: z
      .object({ analysisId: z.string(), offset: count, limit: z.number().int().positive().max(25) })
      .strict(),
  })
  .strict();

export const analyzeNgsReadsOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    name: z.string(),
    input: z
      .object({
        documentId: z.string(),
        readPath: z.string(),
        referenceSequence: z.string(),
        isCircular: z.boolean(),
        preset: z.enum(['sr', 'map-ont', 'lr:hq', 'map-hifi']),
        threads: z.number(),
        minBaseQuality: z.number(),
        minMappingQuality: z.number(),
        minDepth: z.number(),
        minAlternateCount: z.number(),
        minAlleleFraction: z.number(),
      })
      .strict(),
  })
  .strict();
export const getNgsAnalysisOutputSchema = z.union([
  z
    .object({
      ...success,
      operationId: z.string(),
      status: pendingOperationState,
      error: operationError.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...success,
      operationId: z.string(),
      status: z.literal('imported'),
      analysisId: z.string(),
      sourceSha256: z.string(),
      referenceSha256: z.string(),
      totalReads: count,
      totalBases: count,
      mappedReads: count,
      unmappedReads: count,
      mappingQualityReads: count,
      uncoveredBases: count,
      circularMethod: z.enum(['linear', 'two-origins-central-half']),
      versions: z.record(z.string(), z.string()),
      callCount: count,
      calls: z.array(variantCall),
      nextOffset: count.nullable(),
      continuationTool: z.literal('get_variant_analysis'),
      continuation: variantAnalysisContinuation.optional(),
      countBasis: z.string(),
    })
    .strict(),
]);

export const startVariantCallsOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    chrom: z.string(),
    input: z
      .object({
        variantPath: z.string(),
        references: z.array(z.object({ name: z.string(), length: count }).strict()),
      })
      .strict(),
  })
  .strict();
export const importVariantCallsOutputSchema = z.union([
  z
    .object({
      ...success,
      operationId: z.string(),
      status: pendingOperationState,
      error: operationError.nullable().optional(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      ...success,
      operationId: z.string(),
      status: z.literal('choose-sample'),
      samples: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...success,
      analysisId: z.string(),
      status: z.literal('imported'),
      countBasis: z.string(),
      sample: z.string(),
      referenceSha256: z.string(),
      sourceIdentity: z.string(),
      callCount: count,
      calls: z.array(variantCall),
      callsTruncated: z.boolean(),
      nextOffset: count.nullable(),
      continuationTool: z.literal('get_variant_analysis'),
    })
    .strict(),
]);
export const getVariantAnalysisOutputSchema = z
  .object({
    ...success,
    analysisId: z.string(),
    documentId: z.string(),
    name: z.string(),
    sample: z.string(),
    sourceIdentity: z.string(),
    referenceSha256: z.string(),
    countBasis: z.string(),
    stale: z.boolean(),
    totalCalls: count,
    matchingCalls: count,
    offset: count,
    limit: z.number().int().positive().max(25),
    requestedLimit: z.number().int().positive().max(500),
    nextOffset: count.nullable(),
    calls: z.array(variantCall),
  })
  .strict();

const alleleProduct = z.union([
  z
    .object({
      status: z.literal('unresolved'),
      reason: z.string(),
      basis: z.literal('single-allele'),
    })
    .strict(),
  z
    .object({
      status: z.literal('complete'),
      sequence: z.string(),
      basis: z.literal('single-allele'),
      stop: z
        .object({ residue: z.number(), genomicPositions: z.array(z.number().nullable()) })
        .strict(),
      referenceLength: count,
      alternateToReference: z.array(z.number().nullable()),
      extendedBeyondCds: z.boolean(),
    })
    .strict(),
]);
const proteinInspection = {
  status: z.string(),
  message: z.string(),
  proteinProduct: z.enum(['reference', 'allele', 'comparison']),
  sequence: z.string(),
  alleleProduct: alleleProduct.optional(),
  inspectionTarget: z.object({ document_id: z.string(), protein_key: z.string() }).strict(),
  structureViewId: z.string().optional(),
  structureStatus: z.string(),
  structureError: z
    .object({
      code: z.string(),
      message: z.string(),
      failedStep: z
        .enum([
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
        ])
        .optional(),
    })
    .strict()
    .nullable(),
};
export const inspectVariantCallOutputSchema = z
  .object({ ...success, ...proteinInspection, analysisId: z.string(), callId: z.string() })
  .strict();
export const inspectSequenceVariantOutputSchema = z
  .object({
    ...success,
    ...proteinInspection,
    documentId: z.string(),
    inspectionId: z.string(),
    mutationId: z.string(),
    position: z.number(),
  })
  .strict();

const alignmentInput = z
  .object({
    referenceSequence: z.string(),
    queries: z.array(z.object({ id: z.string(), sequence: z.string() }).strict()),
    algorithm: z.enum(['auto', 'fast', 'accurate', 'ginsi', 'linsi', 'einsi']).optional(),
    isCircular: z.boolean().optional(),
    threads: z.number().optional(),
    timeoutSeconds: z.number().optional(),
  })
  .strict();
export const analyzeCloneOutputSchema = z
  .object({ ...success, documentId: z.string(), sessionId: z.string(), input: alignmentInput })
  .strict();
const cloneReference = z
  .object({ documentId: z.string(), name: z.string(), length: count, circular: z.boolean() })
  .strict();
const mutationEffect = z
  .object({
    featureName: z.string(),
    featureType: z.string(),
    codonPosition: z.number().optional(),
    aminoAcidChange: z.string().optional(),
    classification: z.enum([
      'synonymous',
      'missense',
      'nonsense',
      'readthrough',
      'frameshift',
      'inframe_insertion',
      'inframe_deletion',
      'intergenic',
    ]),
  })
  .strict();
const cloneMutation = z
  .object({
    id: z.string(),
    position: z.number(),
    type: z.enum(['insertion', 'deletion', 'substitution']),
    referenceBase: z.string(),
    alternateBase: z.string(),
    length: count,
    effect: mutationEffect.optional(),
    quality: z.number().optional(),
    inspection: z
      .object({
        tool: z.literal('inspect_sequence_variant'),
        arguments: z
          .object({
            documentId: z.string(),
            sessionId: z.string(),
            trackId: z.string(),
            mutationId: z.string(),
            proteinProduct: z.literal('reference'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const cloneAnalysisIdentity = {
  ...success,
  documentId: z.string(),
  reference: cloneReference,
  sessionId: z.string(),
  operationId: z.string().optional(),
  message: z.string(),
};
export const getCloneAnalysisOutputSchema = z.union([
  z
    .object({
      ...cloneAnalysisIdentity,
      status: z.enum(['not-started', 'active', 'failed', 'canceled', 'interrupted']),
      tracks: z.array(z.never()),
    })
    .strict(),
  z
    .object({
      ...cloneAnalysisIdentity,
      status: z.literal('succeeded'),
      tracks: z.array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            identity: z.number(),
            status: trackStatus,
            mutationCount: count,
            mutations: z.array(cloneMutation),
            mutationsTruncated: z.boolean(),
          })
          .strict()
      ),
    })
    .strict(),
]);

export const runMsaOutputSchema = z
  .object({
    ...success,
    subject_id: z.string(),
    input: z
      .object({
        sequences: z.array(
          z.object({ id: z.string(), name: z.string(), sequence: z.string() }).strict()
        ),
        algorithm: z.literal('auto'),
        threads: z.literal(4),
        timeout_seconds: z.literal(600),
      })
      .strict(),
  })
  .strict();
