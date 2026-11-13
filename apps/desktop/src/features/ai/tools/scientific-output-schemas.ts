import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';
import { sequenceProductCreationSchema } from '../../../shared/sequence-product';

const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionPin = z
  .object({
    resourceRevisionId: z.string(),
    workspaceVersionId: z.string(),
    contentSha256: digest,
  })
  .strict();
export const scientificAcceptedRevisionSchema = revisionPin
  .extend({
    kind: z.literal('accepted-object'),
    operationId: z.string().optional(),
    resourceId: z.string(),
    sequenceEditParentEventId: z.string().nullable(),
  })
  .strict();

const savedSequenceProduct = {
  documentId: z.string(),
  resourceUri: z.string(),
  name: z.string(),
  length: count,
  sequenceSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  acceptedRevision: scientificAcceptedRevisionSchema,
  creationDerivation: sequenceProductCreationSchema,
  gitCommitted: z.boolean(),
};

export const createSequenceProductOutputSchema = z
  .object({
    ok: z.literal(true),
    saved: z.literal(true),
    planned: z.literal(true),
    circular: z.boolean(),
    ...savedSequenceProduct,
  })
  .strict();

const pcrEvidence = {
  ok: z.literal(true),
  planned: z.literal(true),
  candidateCount: count,
  matching: z
    .object({
      mode: z.literal('exact-3-prime-annealing'),
      nonoverlappingSites: z.literal(true),
      maxProductLength: count,
      forwardAnnealingLength: count,
      reverseAnnealingLength: count,
    })
    .strict(),
  inputs: z.array(z.object({ documentId: z.string(), name: z.string(), revision: revisionPin }).strict()),
  candidates: z.array(
    z
      .object({
        index: count,
        length: count,
        templateSegments: z.array(
          z.object({ start: count, end: count, strand: z.union([z.literal(1), z.literal(-1)]) }).strict()
        ),
      })
      .strict()
  ),
};

export const createPcrProductOutputSchema = z.discriminatedUnion('saved', [
  z.object({ ...pcrEvidence, saved: z.literal(false), selectionRequired: z.boolean() }).strict(),
  z
    .object({
      ...pcrEvidence,
      saved: z.literal(true),
      selectedProductIndex: count,
      ...savedSequenceProduct,
    })
    .strict(),
]);

export const listScientificObjectsOutputSchema = z
  .object({
    ok: z.literal(true),
    enrolled: z.boolean(),
    workspaceVersionId: z.string().nullable(),
    objects: z.array(
      z
        .object({
          resourceId: z.string(),
          revisionId: z.string(),
          path: z.string().nullable(),
          lastPath: z.string().nullable(),
          tombstone: z.boolean(),
        })
        .strict()
    ),
  })
  .strict();

export const createStrainOutputSchema = z
  .object({
    ok: z.literal(true),
    strainId: z.string(),
    name: z.string(),
    artifactPath: z.string(),
    planned: z.literal(true),
    created: z.boolean(),
    gitCommitted: z.boolean(),
    acceptedRevision: scientificAcceptedRevisionSchema.nullable(),
    relationships: z.array(jsonObjectSchema),
  })
  .strict();

export const submitScientificChangesOutputSchema = z
  .object({
    ok: z.literal(true),
    accepted: z.literal(true),
    operationId: z.string(),
    replayed: z.boolean(),
    receipt: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('changed'), version: z.string() }).strict(),
      z.object({ outcome: z.literal('no-op'), head: z.string().nullable() }).strict(),
    ]),
    currentHead: z.string().nullable(),
    delivery: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('complete') }).strict(),
        z.object({ kind: z.literal('blocked'), versionId: z.string(), error: z.string() }).strict(),
      ])
      .nullable(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('git-commit'), commit: z.string() }).strict(),
      z.object({ kind: z.literal('working-files') }).strict(),
    ]),
  })
  .strict();

const primerMatchPinsSchema = z.array(
  z
    .object({
      primerId: z.string(),
      name: z.string(),
      artifactRevision: count,
      contentSha256: digest,
      acceptedRevision: scientificAcceptedRevisionSchema.optional(),
    })
    .strict()
);

export const searchPrimerMatchesOutputSchema = z
  .object({
    ok: z.literal(true),
    checked: z.literal(false),
    targetCount: count,
    primerCount: count,
    primerPins: primerMatchPinsSchema,
    targets: z.array(
      z
        .object({
          documentId: z.string(),
          name: z.string(),
          length: count,
          circular: z.boolean(),
          contentSha256: digest,
          acceptedRevision: scientificAcceptedRevisionSchema.nullish(),
          operationId: z.string(),
          state: z.string(),
          targetRevision: z.string(),
          libraryRevision: z.string(),
        })
        .strict()
    ),
    matching: z
      .object({
        maxEditDistance: count,
        maxMismatches: count,
        minThreePrimeMatchLength: count,
        sequenceBasis: z.literal('complete-ordered-DNA-oligo'),
        coordinateSystem: z.literal('zero_based_half_open'),
      })
      .strict(),
    next: z.string(),
  })
  .strict();

export const searchPrimerMatchesPreparationOutputSchema = z
  .object({
    ok: z.literal(true),
    primerPins: primerMatchPinsSchema,
    targets: z.array(
      z
        .object({
          documentId: z.string(),
          name: z.string(),
          length: count,
          circular: z.boolean(),
          contentSha256: digest,
          acceptedRevision: scientificAcceptedRevisionSchema.optional(),
          input: z
            .object({
              targetDocumentId: z.string(),
              referenceSequence: z.string(),
              circular: z.boolean(),
              primers: z.array(
                z.object({ id: z.string(), sequence: z.string(), revision: z.string() }).strict()
              ),
              maxEditDistance: count,
              maxMismatches: count,
              minMatchLength: count,
              minEffectiveTm: z.literal(0),
            })
            .strict(),
        })
        .strict()
    ),
  })
  .strict();
