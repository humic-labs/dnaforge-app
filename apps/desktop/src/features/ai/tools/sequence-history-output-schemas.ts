import { z } from 'zod';
import { jsonValueSchema } from '../../../shared/json-value';

const count = z.number().int().nonnegative();
const success = { ok: z.literal(true) };
const topology = z.enum(['circular', 'linear']);
const runStatus = z.enum(['completed', 'failed', 'prepared', 'canceled', 'interrupted']);
const trackStatus = z.enum(['pass', 'variants', 'fail', 'incomplete']);
                                                                                   
const retainedJsonValue = jsonValueSchema.describe(
  'Retained JSON data whose keys and nested values belong to the saved item or evidence format. Private filesystem locators are removed before this bounded projection.'
);

export const getSequencePackageHistoryOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    currentHeadId: z.string().nullable(),
    currentProductStatus: z.enum(['verified', 'drifted', 'unavailable', 'legacy']),
    legacyCurrentHasNoSnapshot: z.boolean(),
    totalRevisionCount: count,
    revisionOffset: count,
    revisions: z.array(
      z
        .object({
          revisionId: z.string(),
          parentId: z.string().nullable(),
          kind: z.enum([
            'adopted',
            'sequence-save',
            'metadata-update',
            'assembly-finalization',
            'evidence-update',
            'sequencing-apply',
            'member-update',
            'restore',
          ]),
          createdAt: z.string(),
          name: z.string(),
          referenceSha256: z.string(),
          topology: topology.nullable(),
          sourceItemIds: z.array(z.string()),
        })
        .strict()
    ),
    nextRevisionOffset: count.nullable(),
    totalItemCount: count,
    itemOffset: count,
    items: z.array(
      z
        .object({ itemId: z.string(), label: z.string(), sourceRevisionIds: z.array(z.string()) })
        .strict()
    ),
    nextItemOffset: count.nullable(),
    totalEvidenceCount: count,
    evidenceOffset: count,
    evidenceRuns: z.array(
      z
        .object({
          runId: z.string(),
          sessionId: z.string(),
          status: runStatus,
          createdAt: z.string(),
          checkpointId: z.string().nullable(),
          referenceSha256: z.string(),
          readCount: count,
          reviewCount: count,
        })
        .strict()
    ),
    nextEvidenceOffset: count.nullable(),
  })
  .strict();

const historyItemIdentity = {
  ...success,
  documentId: z.string(),
  revisionId: z.string(),
  itemId: z.string(),
};
                                                                                      
export const readSequencePackageHistoryItemOutputSchema = z.union([
  z
    .object({
      ...historyItemIdentity,
      present: z.literal(false),
      valueSha256: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...historyItemIdentity,
      present: z.literal(true),
      referenceSha256: z.string(),
      topology,
      lengthBp: count,
      window: z
        .object({ start: z.number(), end: z.number(), bases: z.string() })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...historyItemIdentity,
      present: z.literal(true),
      sha256: z.string(),
      sizeBytes: count,
    })
    .strict(),
  z
    .object({
      ...historyItemIdentity,
      present: z.literal(true),
      valueSha256: z.string().nullable().optional(),
      value: retainedJsonValue,
      valuePreview: z.string().optional(),
      valueTruncated: z.literal(true).optional(),
      serializedLength: count.optional(),
    })
    .strict(),
]);

const evidenceRunIdentity = {
  ...success,
  documentId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  status: runStatus,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  testedReference: z
    .object({
      sha256: z.string(),
      sequenceRevision: z.string(),
      topology,
      checkpointId: z.string().nullable(),
    })
    .strict(),
  producer: z
    .object({
      kind: z.literal('pairwise-session-alignment'),
      algorithm: z.literal('auto'),
      threads: z.number(),
      timeoutSeconds: z.number(),
      isCircular: z.boolean(),
    })
    .strict()
    .nullable(),
  queries: z.array(
    z.object({ queryId: z.string(), label: z.string(), sha256: z.string() }).strict()
  ),
  resultSha256: z.string().nullable(),
  reviewCount: count,
};
export const readSequencePackageEvidenceRunOutputSchema = z.union([
  z
    .object({
      ...evidenceRunIdentity,
      artifactStatus: z.literal('unavailable'),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      ...evidenceRunIdentity,
      artifactStatus: z.literal('verified'),
      latestReview: z.array(
        z
          .object({
            queryId: z.string(),
            status: trackStatus,
            userStatus: trackStatus.nullable(),
            userOverrideReason: z.string().nullable(),
            mutationCount: count,
            mutations: z.array(retainedJsonValue).optional(),
            mutationsTruncated: z.boolean(),
          })
          .strict()
      ),
    })
    .strict(),
]);

export const previewSequencePackageRestoreOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    previewFingerprint: z.string(),
    currentHeadId: z.string(),
    currentMarkerSha256: z.string(),
    currentProductSha256: z.string(),
    selectedSources: z.record(
      z.string(),
      z.object({ revisionId: z.string(), valueSha256: z.string() }).strict()
    ),
    changedItems: z.array(z.string()),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();
export const applySequencePackageRestoreOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    revisionId: z.string(),
    alreadyPublished: z.boolean(),
    durableStage: z.literal('package-revision-published'),
    delivery: z
      .object({
        registry: z.literal('completed'),
        git: z.enum(['committed', 'not-a-repository']),
        gitError: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const attachmentPreviewIdentity = {
  ...success,
  documentId: z.string(),
  previewFingerprint: z.string(),
  operationId: z.string(),
  currentHeadId: z.string(),
  attachmentId: z.string(),
  createdAt: z.string(),
  expectedMarkerSha256: z.string(),
  expectedProductSha256: z.string(),
};
const attachmentSource = {
  memberId: z.string(),
  fileName: z.string(),
  sourceSha256: z.string(),
  sourceSizeBytes: count,
};
const previousAttachment = { previousMemberId: z.string(), previousSha256: z.string() };
export const previewSequenceUserAttachmentMutationOutputSchema = z.union([
  z
    .object({ ...attachmentPreviewIdentity, kind: z.literal('attach'), ...attachmentSource })
    .strict(),
  z
    .object({
      ...attachmentPreviewIdentity,
      kind: z.literal('replace'),
      ...attachmentSource,
      ...previousAttachment,
    })
    .strict(),
  z
    .object({ ...attachmentPreviewIdentity, kind: z.literal('detach'), ...previousAttachment })
    .strict(),
]);
export const applySequenceUserAttachmentMutationOutputSchema = z
  .object({
    ...success,
    documentId: z.string(),
    kind: z.enum(['attach', 'replace', 'detach']),
    attachmentId: z.string(),
    revisionId: z.string(),
    alreadyPublished: z.boolean(),
    sourceSha256: z.string().nullable(),
    durableStage: z.literal('package-revision-published'),
  })
  .strict();
