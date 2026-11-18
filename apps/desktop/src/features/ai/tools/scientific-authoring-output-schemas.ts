import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';
import { entityNavigationTargetSchema } from '../../../shared/entity-navigation';
import { sequenceProductCreationSchema } from '../../../shared/sequence-product';
import {
  assemblyPrimerSchema,
  assemblyPrimerSourceSiteSchema,
  assemblyTmContextSchema,
  agentMutationClaimSchema,
  savedPrimerLinkOriginSchema,
} from './design-output-schemas';

const success = { ok: z.literal(true) };
const count = z.number().int().nonnegative();
const acceptedRevision = z
  .object({
    kind: z.literal('accepted-object'),
    operationId: z.string().optional(),
    contentSha256: z.string(),
    resourceId: z.string(),
    resourceRevisionId: z.string(),
    workspaceVersionId: z.string(),
    sequenceEditParentEventId: z.string().nullable(),
  })
  .strict();
const sourceRevision = acceptedRevision.pick({
  resourceRevisionId: true,
  workspaceVersionId: true,
  contentSha256: true,
});
const navigation = {
  target: entityNavigationTargetSchema.optional(),
  externalUrl: z.string().nullable(),
  shellCommand: z.string().nullable(),
};

export const getEntityLinkOutputSchema = z
  .object({
    ...success,
    target: entityNavigationTargetSchema,
    externalUrl: z.string(),
    shellCommand: z.string(),
  })
  .strict();

const fastaWitness = {
  path: z.string(),
  workspaceRoot: z.string(),
  entityId: z.string(),
  bindingId: z.string(),
  objectUuid: z.string().nullable(),
  sourceFingerprint: z.string(),
  revision: z.string(),
};
const declaredFasta = z
  .object({
    ...success,
    ...fastaWitness,
    status: z.literal('declared'),
    kind: z.enum(['sequence', 'protein']),
    authority: z.enum(['native-declaration', 'canonical-source']),
  })
  .strict();
export const inspectFastaKindOutputSchema = z.union([
  declaredFasta,
  z
    .object({
      ...success,
      ...fastaWitness,
      status: z.enum(['legacy-compatible', 'needs-classification']),
      storedKind: z.enum(['sequence', 'protein']),
      legacyReadView: z.enum(['sequence', 'protein']),
      readOnly: z.literal(true),
    })
    .strict(),
]);
export const classifyFastaOutputSchema = declaredFasta
  .extend({
    stopRequested: z.literal(true).optional(),
  })
  .strict();

export const removePrimerBindingOutputSchema = z
  .object({
    ...success,
    changed: z.boolean(),
    primerId: z.string(),
    artifactRevision: count,
    bindingCount: count,
    gitCommitted: z.boolean(),
  })
  .strict();
export const deletePrimerOutputSchema = z.union([
  z.object({ ...success, deleted: z.literal(false), reason: z.literal('not_found') }).strict(),
  z
    .object({
      ...success,
      deleted: z.literal(true),
      primerId: z.string(),
      gitCommitted: z.boolean(),
    })
    .strict(),
]);
export const updateAssemblyPrimerOutputSchema = z
  .object({
    ...success,
    changed: z.literal(true),
    designId: z.string(),
    designVersion: count,
    primer: assemblyPrimerSchema.optional(),
    warnings: z.array(z.string()),
    mutation: agentMutationClaimSchema,
  })
  .strict();
const savedDesignPrimerSchema = z
  .object({
    primerId: z.string(),
    name: z.string(),
    partNumber: count,
    direction: z.enum(['forward', 'reverse']),
    sequence: z.string(),
    bindingSequence: z.string(),
    tailSequence: z.string(),
    tmC: z.number().nullable(),
    sourceSite: assemblyPrimerSourceSiteSchema.nullable(),
    status: z.enum([
      'linked',
      'draft-primer-changed',
      'oligo-bases-changed',
      'oligo-unavailable',
      'match-available',
      'ambiguous',
      'unsaved',
    ]),
    savedOligo: z
      .object({
        oligoId: z.string(),
        catalogNumber: z.string(),
        name: z.string(),
        artifactRevision: count,
        linkedArtifactRevision: count.nullable(),
        linkedAtDesignVersion: count.nullable(),
        via: savedPrimerLinkOriginSchema.nullable(),
        oligoBindingSplit: z.enum(['same', 'missing', 'different', 'unavailable']),
        tmC: z.number().nullable(),
        tmConcentrationNm: z.number().nullable(),
        tmModelLabel: z.string().nullable(),
      })
      .strict()
      .nullable(),
    candidateOligoIds: z.array(z.string()),
    sourceAttachment: z.union([
      z
        .object({
          state: z.literal('agrees'),
          binding: z
            .object({
              id: z.string(),
              placement: z.string(),
              confirmed: z.boolean(),
              sourceDigest: z.string().nullable(),
            })
            .strict(),
        })
        .strict(),
      z.object({ state: z.enum(['differs', 'none']) }).strict(),
    ]),
  })
  .strict();
export const saveDesignPrimersOutputSchema = z
  .object({
    ...success,
    changed: z.boolean(),
    designId: z.string(),
    designVersion: count,
    linked: z.array(
      z
        .object({
          primerId: z.string(),
          oligoId: z.string(),
          via: savedPrimerLinkOriginSchema,
        })
        .strict()
    ),
    kept: z.array(z.string()),
    ambiguous: z.array(z.object({ primerId: z.string(), oligoIds: z.array(z.string()) }).strict()),
    unsaved: z.array(z.string()),
    unresolved: z.array(
      z
        .object({
          primerId: z.string(),
          state: z.enum([
            'current',
            'draft-primer-changed',
            'oligo-bases-changed',
            'oligo-unavailable',
          ]),
          oligoId: z.string(),
        })
        .strict()
    ),
    bindingSplitRestored: z.array(
      z
        .object({
          primerId: z.string(),
          oligoId: z.string(),
          artifactRevision: count,
        })
        .strict()
    ),
    failed: z.array(z.object({ primerId: z.string(), message: z.string() }).strict()),
    tm: assemblyTmContextSchema,
    primers: z.array(savedDesignPrimerSchema),
  })
  .strict();

interface NotebookNode {
  type?: string;
  text?: string;
  attrs?: z.infer<typeof jsonObjectSchema>;
  marks?: { type: string; attrs?: z.infer<typeof jsonObjectSchema> }[];
  content?: NotebookNode[];
}
const notebookNode: z.ZodType<NotebookNode> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      attrs: jsonObjectSchema.optional(),
      marks: z
        .array(z.object({ type: z.string(), attrs: jsonObjectSchema.optional() }).strict())
        .optional(),
      content: z.array(notebookNode).optional(),
    })
    .strict()
);
export const getNotebookOutputSchema = z
  .object({
    ...success,
    notebookId: z.string(),
    workspaceRoot: z.string(),
    title: z.string(),
    revision: z.string(),
    content: notebookNode,
    packagePath: z.string(),
    provenance: z.array(jsonObjectSchema),
  })
  .strict();
export const createNotebookOutputSchema = getNotebookOutputSchema
  .extend({
    ...navigation,
    referenceId: z.string(),
    inlineLink: z.string(),
  })
  .strict();
export const updateNotebookOutputSchema = createNotebookOutputSchema;
export const createNotebookReferenceOutputSchema = z
  .object({
    ...success,
    ...navigation,
    referenceId: z.string(),
    inlineLink: z.string().optional(),
    entityId: z.string(),
    entityType: z.enum(['sequence', 'sequence_region', 'primer', 'assembly', 'notebook']),
    workspaceRoot: z.string().nullable(),
    registryEntityId: z.string().optional(),
    primerId: z.string().nullable().optional(),
    localOnly: z.boolean().optional(),
    reused: z.literal(true).optional(),
  })
  .strict();

export const listScientificObjectsOutputSchema = z
  .object({
    ...success,
    enrolled: z.boolean(),
    workspaceVersionId: z.string().nullable(),
    objects: z.array(
      z
        .object({
          resourceId: z.string(),
          revisionId: z.string(),
          path: z.string().nullable(),
          lastPath: z.string().nullable(),
          tombstone: z.literal(false),
        })
        .strict()
    ),
  })
  .strict();
export const createStrainOutputSchema = z
  .object({
    ...success,
    strainId: z.string(),
    name: z.string(),
    artifactPath: z.string(),
    planned: z.literal(true),
    created: z.boolean(),
    gitCommitted: z.boolean(),
    acceptedRevision: acceptedRevision.nullable(),
    relationships: z.array(
      z
        .object({
          type: z.string(),
          fromEntityId: z.string(),
          toEntityId: z.string(),
          payload: jsonObjectSchema,
        })
        .strict()
    ),
  })
  .strict();
export const submitScientificChangesOutputSchema = z
  .object({
    ...success,
    accepted: z.literal(true),
    operationId: z.string(),
    replayed: z.boolean(),
    receipt: z.union([
      z.object({ outcome: z.literal('changed'), version: z.string() }).strict(),
      z.object({ outcome: z.literal('no-op'), head: z.string().nullable() }).strict(),
    ]),
    currentHead: z.string().nullable(),
    delivery: z.union([
      z.null(),
      z.object({ kind: z.literal('complete') }).strict(),
      z.object({ kind: z.literal('blocked'), versionId: z.string(), error: z.string() }).strict(),
    ]),
    source: z.union([
      z.object({ kind: z.literal('initialize-empty-namespace') }).strict(),
      z.object({ kind: z.literal('working-files') }).strict(),
      z.object({ kind: z.literal('git-commit'), commit: z.string() }).strict(),
    ]),
  })
  .strict();

const savedProduct = {
  documentId: z.string(),
  resourceUri: z.string(),
  name: z.string(),
  length: count,
  sequenceSha256: z.string(),
  acceptedRevision,
  creationDerivation: sequenceProductCreationSchema,
  gitCommitted: z.boolean(),
};
export const createSequenceProductOutputSchema = z
  .object({
    ...success,
    ...savedProduct,
    saved: z.literal(true),
    planned: z.literal(true),
    circular: z.boolean(),
  })
  .strict();
const pcrEvidence = {
  ...success,
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
  inputs: z.array(
    z.object({ documentId: z.string(), name: z.string(), revision: sourceRevision }).strict()
  ),
  candidates: z.array(
    z
      .object({
        index: count,
        length: count,
        templateSegments: z.array(
          z
            .object({
              start: count,
              end: count,
              strand: z.union([z.literal(1), z.literal(-1)]),
            })
            .strict()
        ),
      })
      .strict()
  ),
};
export const createPcrProductOutputSchema = z.union([
  z.object({ ...pcrEvidence, saved: z.literal(false), selectionRequired: z.boolean() }).strict(),
  z
    .object({
      ...pcrEvidence,
      ...savedProduct,
      saved: z.literal(true),
      selectedProductIndex: count,
    })
    .strict(),
]);
export const searchPrimerMatchesOutputSchema = z
  .object({
    ...success,
    primerPins: z.array(
      z
        .object({
          primerId: z.string(),
          name: z.string(),
          artifactRevision: count,
          contentSha256: z.string(),
          acceptedRevision: acceptedRevision.optional(),
        })
        .strict()
    ),
    targets: z.array(
      z
        .object({
          documentId: z.string(),
          name: z.string(),
          length: count,
          circular: z.boolean(),
          contentSha256: z.string(),
          acceptedRevision: acceptedRevision.optional(),
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
              minEffectiveTm: z.number(),
            })
            .strict(),
        })
        .strict()
    ),
  })
  .strict();
