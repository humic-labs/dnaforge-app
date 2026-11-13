import { z } from 'zod';
import { managedTrackRegistrationStartSchema } from './track-registration-operation';

const success = { ok: z.literal(true) };
const count = z.number().int().nonnegative();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const documentRevision = z.string().min(1).max(512);
const annotationDocumentRevision = z.string().regex(/^annotation-document-v1:sha256:[a-f0-9]{64}$/);

                                                                                                
const annotationFeature = z
  .object({
    name: z.string(),
    accession: z.string().optional(),
    start: z.number().int(),
    end: z.number().int(),
    strand: z.number().int(),
    identity: z.number(),
    coverage: z.number(),
    fragment: z.boolean(),
    type: z.string().optional(),
    description: z.string().optional(),
    ref_start: z.number().int(),
    ref_end: z.number().int(),
    ref_length: z.number().int(),
    db_source: z.enum(['protein', 'nucleotide', 'rna']),
  })
  .strict();
const annotationResult = z
  .object({
    features: z.array(annotationFeature),
    sequence_length: z.number().int(),
    error: z.string().min(1).nullable().optional(),
  })
  .strict();

export const inspectAnnotationOutputOutputSchema = z
  .object({
    ...success,
    targetDocumentId: z.string(),
    targetDocumentRevision: annotationDocumentRevision,
    outputSha256: digest,
    analyzedInputRevision: z.null(),
    result: annotationResult,
    candidates: z.array(
      z.object({ id: z.string(), index: count, feature: annotationFeature }).strict()
    ),
  })
  .strict();
export const applyAnnotationOutputOutputSchema = z
  .object({
    ...success,
    status: z.enum(['saved', 'already-applied']),
    targetDocumentRevision: annotationDocumentRevision,
  })
  .strict();

                                                                                            
export const operationsAnnotationInspectOutputSchema = z
  .object({
    ...success,
    result: z
      .object({
        operationId: z.string(),
        targetDocumentId: z.string(),
        operationVersion: z.number().int().positive(),
        resultSha256: digest,
        targetDocumentRevision: annotationDocumentRevision,
        analyzedInputRevision: documentRevision,
        candidates: z.array(
          z
            .object({
              id: z.string(),
              index: count,
              sourceFeature: annotationFeature,
              feature: annotationFeature,
              substitutionOverlap: z.boolean(),
            })
            .strict()
        ),
        applicable: z.boolean(),
        blockReason: z.string().optional(),
        coordinates: z.enum(['exact', 'mapped']),
        transitionCount: count,
      })
      .strict(),
  })
  .strict();
const documentCheckpoint = z.union([
  z
    .object({
      status: z.literal('committed'),
      commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    })
    .strict(),
  z.object({ status: z.literal('not-required') }).strict(),
  z.object({ status: z.literal('failed'), reason: z.string().min(1).max(2048) }).strict(),
]);
export const operationsAnnotationApplyOutputSchema = z
  .object({
    ...success,
    operationId: z.string(),
    actionId: z.string(),
    result: z
      .object({
        status: z.literal('saved'),
        targetDocumentRevision: documentRevision,
        checkpoint: documentCheckpoint,
        display: z.enum(['refreshed', 'pending', 'not-required']),
        displayError: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const operationsGenomeIndexingStartOutputSchema = z
  .object({
    ...success,
    input: z
      .object({
        input: z.string(),
        outputDir: z.string(),
        name: z.string(),
        workspaceRoot: z.string(),
      })
      .strict(),
  })
  .strict();
export const operationsTrackRegistrationStartOutputSchema = z
  .object({ ...success, input: managedTrackRegistrationStartSchema })
  .strict();
const alignedFileGeneration = z
  .object({
    canonicalPath: z.string(),
    size: count,
    mtimeNs: z.string(),
    ctimeNs: z.string(),
    device: z.string().optional(),
    inode: z.string().optional(),
  })
  .strict();
const alignedReadSourceGeneration = z
  .object({
    contract: z.literal('aligned-read-source-generation.v1'),
    alignment: alignedFileGeneration,
    index: alignedFileGeneration,
    reference: alignedFileGeneration.optional(),
    referenceIndex: alignedFileGeneration.optional(),
  })
  .strict();
export const operationsAlignmentCoveragePreparationStartOutputSchema = z
  .object({
    ...success,
    input: z
      .object({
        assemblyId: z.string(),
        bamPath: z.string(),
        indexPath: z.string(),
        referencePath: z.string().optional(),
        sourceGeneration: alignedReadSourceGeneration,
        chroms: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export const operationsAlignmentIndexPreparationStartOutputSchema = z
  .object({ ...success, input: z.object({ bamPath: z.string() }).strict() })
  .strict();
export const operationsVariantSourcePreparationStartOutputSchema = z
  .object({
    ...success,
    assemblyId: z.string(),
    input: z
      .object({
        variantPath: z.string(),
        references: z.array(
          z
            .object({ name: z.string(), length: count, aliases: z.array(z.string()).optional() })
            .strict()
        ),
      })
      .strict(),
  })
  .strict();
