import { z } from 'zod';

const text = z.string();
const identity = z.string().min(1);
const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rawSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const success = { ok: z.literal(true) };
const textMediaType = z.enum([
  'text/html',
  'text/plain',
  'application/xml',
  'text/xml',
  'application/jats+xml',
]);
const rect = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .strict();
const parser = z
  .object({ name: identity, version: identity, mode: identity, configuration: text.optional() })
  .strict();
export const capturedPaperSourceSchema = z
  .object({
    sourceId: identity,
    kind: z.literal('captured_text'),
    title: identity,
    mediaType: textMediaType,
    sha256,
    capturedAt: identity,
    originalUrl: z.string().url(),
    canonicalUrl: z.string().url(),
    text: identity,
  })
  .strict();
const capturedBlock = z
  .object({ blockId: identity, start: count, end: positive, text: identity })
  .strict();
export const capturePaperSourceOutputSchema = z
  .object({ ...success, source: capturedPaperSourceSchema, blocks: z.array(capturedBlock) })
  .strict();
export const readPdfOutputSchema = z
  .object({
    ...success,
    path: identity,
    sha256: rawSha256,
    sourceSha256: sha256,
    parser,
    pageCount: positive,
    pages: z.array(
      z
        .object({
          page: positive,
          text,
          blocks: z.array(
            z
              .object({
                blockId: identity,
                page: positive,
                kind: z.enum([
                  'heading',
                  'paragraph',
                  'caption',
                  'list-item',
                  'table',
                  'text-item',
                ]),
                text,
                rect,
              })
              .strict()
          ),
        })
        .strict()
    ),
    truncated: z.boolean(),
  })
  .strict();
export const createProtocolFromPdfOutputSchema = z
  .object({
    ...success,
    pdfPath: identity,
    protocolPath: identity,
    sha256: rawSha256,
    pageCount: positive,
    stepCount: positive,
    candidateSetId: identity,
    candidateId: identity,
    candidateOrdinal: positive,
    candidateStatus: z.enum(['proposed', 'selected']),
  })
  .strict();
export const capturePaperUrlOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...success,
      kind: z.literal('captured_text'),
      responseSha256: sha256,
      byteCount: count,
      source: capturedPaperSourceSchema,
      blocks: z.array(capturedBlock),
    })
    .strict(),
  z
    .object({
      ...success,
      kind: z.literal('pdf'),
      pdfPath: identity,
      sha256,
      byteCount: count,
      reusedExisting: z.boolean(),
      remoteSource: z
        .object({
          originalUrl: z.string().url(),
          canonicalUrl: z.string().url(),
          mediaType: z.literal('application/pdf'),
          capturedAt: identity,
          title: identity,
        })
        .strict(),
    })
    .strict(),
]);
const graphIdentifier = z
  .object({ scheme: z.enum(['pmid', 'pmcid', 'doi']), value: identity, node_id: identity })
  .strict();
export const recordPaperReferenceTraceOutputSchema = z
  .object({
    ...success,
    source_uri: identity,
    source_sha256: rawSha256,
    edge_count: count,
    identifiers: z.array(graphIdentifier),
    replayed: z.boolean(),
  })
  .strict();
const graphSource = z
  .object({
    kind: z.enum(['pdf', 'captured_text']),
    path: text.nullable().optional(),
    title: text.nullable().optional(),
    media_type: text.nullable().optional(),
  })
  .strict();
const emptyMetadata = z.object({}).strict();
const graphEvidence = z
  .object({
    block_ids: z.array(identity),
    quote: identity,
    locator: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pdf_rects'), page: positive, rects: z.array(rect) }).strict(),
      z.object({ kind: z.literal('text_span'), start: count, end: positive }).strict(),
    ]),
  })
  .strict();
export const getPaperReferenceGraphOutputSchema = z
  .object({
    ...success,
    source_uri: identity,
    nodes: z.array(
      z
        .object({
          id: identity,
          kind: z.enum(['paper_source', 'publication_identifier']),
          sha256: rawSha256.nullable().optional(),
          source: z.union([graphSource, emptyMetadata]).nullable().optional(),
          scheme: z.enum(['pmid', 'pmcid', 'doi']).nullable().optional(),
          value: text.nullable().optional(),
        })
        .strict()
    ),
    edges: z.array(
      z
        .object({
          id: identity,
          source_node_id: identity,
          target_node_id: identity,
          relationship: z.enum(['identifies_as', 'cites', 'uses_method_from', 'supplement_to']),
          evidence: text,
          trace: z.union([graphEvidence, emptyMetadata]),
        })
        .strict()
    ),
    truncated: z.boolean(),
  })
  .strict();
export const createProtocolCandidateOutputSchema = z
  .object({
    ...success,
    protocolPath: identity,
    candidateSetId: identity,
    candidateId: identity,
    candidateOrdinal: positive,
    candidateStatus: z.enum(['proposed', 'selected']),
    sourceSha256: sha256,
    stepCount: positive,
    gapCount: count,
    entityId: identity,
  })
  .strict();
export const getProtocolCandidatesOutputSchema = z
  .object({
    ...success,
    candidates: z.array(
      z
        .object({
          protocolPath: identity,
          title: text,
          candidateSetId: identity,
          candidateId: identity,
          ordinal: positive,
          status: z.enum(['proposed', 'selected', 'rejected']),
          sourceKinds: z.array(z.enum(['pdf', 'captured_text'])),
          sourceHashes: z.array(sha256),
          draftRevision: positive,
          draftState: z.enum(['draft', 'finalized']),
          stepCount: count,
          gapCount: count,
        })
        .strict()
    ),
  })
  .strict();
export const selectProtocolCandidateOutputSchema = z
  .object({
    ...success,
    path: identity,
    candidateSetId: identity,
    candidateId: identity,
    candidateStatus: z.literal('selected'),
    draftRevision: positive,
    replayed: z.boolean(),
  })
  .strict();
const gap = z
  .object({
    gapId: identity,
    stepId: identity,
    missing: identity,
    attemptedResolution: z.array(identity),
  })
  .strict();
const blocker = z.object({ code: z.literal('preview_rejected'), message: text }).strict();
export const previewFinalizePaperProtocolOutputSchema = z.discriminatedUnion('canFinalize', [
  z
    .object({
      ...success,
      canFinalize: z.literal(true),
      path: identity,
      expectedRevision: positive,
      contentHash: sha256,
      sourceHashes: z.array(sha256),
      unresolvedGaps: z.array(gap),
      previewFingerprint: sha256,
      previewExpiresAt: identity,
      blockers: z.array(blocker).max(0),
    })
    .strict(),
  z
    .object({
      ...success,
      canFinalize: z.literal(false),
      path: identity,
      expectedRevision: positive,
      unresolvedGaps: z.array(gap).max(0),
      blockers: z.array(blocker).min(1),
    })
    .strict(),
]);
export const finalizePaperProtocolOutputSchema = z
  .object({
    ...success,
    path: identity,
    state: z.literal('finalized'),
    draftRevision: positive,
    acceptedVersionId: identity,
    contentHash: sha256,
    sourceHashes: z.array(sha256),
    unresolvedGapCount: count,
    replayed: z.boolean(),
  })
  .strict();
export const reopenPaperProtocolOutputSchema = z
  .object({
    ...success,
    path: identity,
    state: z.literal('draft'),
    acceptedVersionId: identity,
    draftRevision: positive,
    replayed: z.boolean(),
  })
  .strict();
export const reviseProtocolStepOutputSchema = z
  .object({
    ...success,
    path: identity,
    stepId: identity,
    revisionId: identity,
    title: text,
    contentText: text,
    sourceStatus: text.nullable(),
    sourceSpanCount: count,
  })
  .strict();
export const openProtocolReviewOutputSchema = z
  .object({
    ...success,
    pdfTabId: identity,
    protocolTabId: identity,
    pdfPanelId: identity,
    protocolPanelId: identity,
    chatPanelId: identity,
  })
  .strict();
