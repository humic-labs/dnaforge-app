import { z } from 'zod';
import {
  parseInventoryScientificCitation,
  parseInventoryScientificCitationWithdrawal,
  type InventoryErrorCode,
} from '@waypoint/domain-services';
import { notebookSavedSourceSchema } from './notebook-saved-source';
import { protocolRunSavedSourceSchema } from './protocol-packages';
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Boolean(value.trim()) && !value.includes('\0'));
const id = text(512),
  revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value) => value as `sha256:${string}`);
const contextSelection = z
  .object({ kind: z.enum(['notebook-page', 'protocol-run']), entityId: id, sourceSha256: digest })
  .strict();
const predecessor = z
  .object({
    citationId: id,
    citationIntentSha256: digest,
    withdrawalId: id,
    withdrawalIntentSha256: digest,
  })
  .strict();
export const inventoryScientificCitationChoicesSchema = z
  .object({
    identity: z.object({ namespace: text(1024), citationId: text(1024) }).strict(),
    workId: id,
    workIntentSha256: digest,
    context: contextSelection,
    reinstates: predecessor.nullable(),
    reason: text(2000),
  })
  .strict();
export const inventoryScientificCitationWithdrawalChoicesSchema = z
  .object({
    identity: z.object({ namespace: text(1024), withdrawalId: text(1024) }).strict(),
    citationId: id,
    citationIntentSha256: digest,
    workId: id,
    workIntentSha256: digest,
    reason: text(2000),
  })
  .strict();
const scope = z.object({ project: text(4096), inventoryId: text(256) }).strict();
export const inventoryPreviewScientificCitationRequestSchema = scope
  .extend({ expectedRevision: revision, choices: inventoryScientificCitationChoicesSchema })
  .strict();
export const inventoryApplyScientificCitationRequestSchema =
  inventoryPreviewScientificCitationRequestSchema
    .extend({
      kind: z.literal('record-scientific-citation'),
      operationId: text(256),
      expectedPlanDigest: digest,
    })
    .strict();
export const inventoryPreviewScientificCitationWithdrawalRequestSchema = scope
  .extend({
    expectedRevision: revision,
    choices: inventoryScientificCitationWithdrawalChoicesSchema,
  })
  .strict();
export const inventoryApplyScientificCitationWithdrawalRequestSchema =
  inventoryPreviewScientificCitationWithdrawalRequestSchema
    .extend({
      kind: z.literal('withdraw-scientific-citation'),
      operationId: text(256),
      expectedPlanDigest: digest,
    })
    .strict();
export const inventoryScientificCitationCursorSchema = z
  .object({
    querySha256: digest,
    revision,
    after: z
      .object({ at: revision, citationId: z.string().regex(/^scientific-citation:[a-f0-9]{64}$/) })
      .strict(),
  })
  .strict();
export const inventoryScientificCitationsRequestSchema = scope
  .extend({
    workId: id,
    workIntentSha256: digest,
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryScientificCitationCursorSchema.optional(),
  })
  .strict();
export const inventoryScientificCitationSourceRequestSchema = scope
  .extend({ citationId: id })
  .strict();
export type InventoryPreviewScientificCitationRequest = z.infer<
  typeof inventoryPreviewScientificCitationRequestSchema
>;
export type InventoryApplyScientificCitationRequest = z.infer<
  typeof inventoryApplyScientificCitationRequestSchema
>;
export type InventoryPreviewScientificCitationWithdrawalRequest = z.infer<
  typeof inventoryPreviewScientificCitationWithdrawalRequestSchema
>;
export type InventoryApplyScientificCitationWithdrawalRequest = z.infer<
  typeof inventoryApplyScientificCitationWithdrawalRequestSchema
>;
export type InventoryScientificCitationsRequest = z.infer<
  typeof inventoryScientificCitationsRequestSchema
>;
export type InventoryScientificCitationSourceRequest = z.infer<
  typeof inventoryScientificCitationSourceRequestSchema
>;
export type InventoryScientificCitationCursor = z.infer<
  typeof inventoryScientificCitationCursorSchema
>;
function structural<T>(parse: (value: unknown) => T) {
  return z.unknown().transform((value, context) => {
    try {
      return parse(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid citation record.',
      });
      return z.NEVER;
    }
  });
}
const citation = structural(parseInventoryScientificCitation),
  withdrawal = structural(parseInventoryScientificCitationWithdrawal);
const entry = z.object({ citation, withdrawal: withdrawal.nullable() }).strict();
const target = z
  .object({ projectId: id, inventoryId: text(256), present: z.boolean(), revision })
  .strict();
const principal = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('local-profile'), profileKey: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  z.object({ kind: z.literal('agent'), identityId: text(500) }).strict(),
]);
const facts = { projectId: id, inventoryId: text(256), revision, asOf: revision, principal };
const previewFacts = { ...facts, target, workId: id, intentSha256: digest.nullable() };
const issues = z
  .array(
    z
      .object({
        code: text(256).transform((value) => value as InventoryErrorCode),
        pointer: z.string().max(4096),
        message: text(4096),
      })
      .strict()
  )
  .min(1)
  .readonly();
const match = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primary-context'), workId: id, workIntentSha256: digest }).strict(),
  z.object({ kind: z.literal('citation'), entry }).strict(),
]);
const citationPreviewFacts = {
  ...previewFacts,
  schema: z.literal('dnaforge.inventory-scientific-citation-preview.v1'),
};
export const inventoryScientificCitationPreviewSnapshotSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...citationPreviewFacts, kind: z.literal('ready'), citation, planDigest: digest })
    .strict(),
  z.object({ ...citationPreviewFacts, kind: z.literal('no-change'), match }).strict(),
  z.object({ ...citationPreviewFacts, kind: z.literal('blocked'), issues }).strict(),
]);
const withdrawalPreviewFacts = {
  ...previewFacts,
  schema: z.literal('dnaforge.inventory-scientific-citation-withdrawal-preview.v1'),
};
export const inventoryScientificCitationWithdrawalPreviewSnapshotSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        ...withdrawalPreviewFacts,
        kind: z.literal('ready'),
        citation,
        withdrawal,
        planDigest: digest,
      })
      .strict(),
    z
      .object({ ...withdrawalPreviewFacts, kind: z.literal('no-change'), citation, withdrawal })
      .strict(),
    z.object({ ...withdrawalPreviewFacts, kind: z.literal('blocked'), issues }).strict(),
  ]
);
const unavailable = { code: text(256), message: text(4096) };
export const inventoryScientificCitationsReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('ready'),
        projectId: id,
        inventoryId: text(256),
        revision,
        workId: id,
        workIntentSha256: digest,
        entries: z.array(entry).max(50),
        nextCursor: inventoryScientificCitationCursorSchema.nullable(),
      })
      .strict(),
    z.object({ kind: z.literal('unavailable'), ...unavailable, retryable: z.boolean() }).strict(),
  ])
  .transform((value, context) => {
    if (value.kind !== 'ready') return value;
    const seen = new Set<string>();
    for (const [index, row] of value.entries.entries()) {
      const previous = value.entries[index - 1]?.citation;
      if (
        seen.has(row.citation.id) ||
        row.citation.workId !== value.workId ||
        row.citation.workIntentSha256 !== value.workIntentSha256 ||
        (previous &&
          (previous.at > row.citation.at ||
            (previous.at === row.citation.at && previous.id >= row.citation.id))) ||
        (row.withdrawal &&
          (row.withdrawal.citationId !== row.citation.id ||
            row.withdrawal.citationIntentSha256 !== row.citation.intentSha256 ||
            row.withdrawal.workId !== value.workId ||
            row.withdrawal.workIntentSha256 !== value.workIntentSha256))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Citation page scope, reference or ordering is invalid.',
        });
      seen.add(row.citation.id);
    }
    if (value.nextCursor) {
      const last = value.entries.at(-1)?.citation;
      if (
        !last ||
        value.nextCursor.revision !== value.revision ||
        value.nextCursor.after.citationId !== last.id ||
        value.nextCursor.after.at !== last.at
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Citation continuation is invalid.',
        });
    }
    return value;
  });
export const inventoryScientificCitationSourceReadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      citationId: id,
      workId: id,
      sourceSha256: digest,
      source: z.discriminatedUnion('schema', [
        notebookSavedSourceSchema,
        protocolRunSavedSourceSchema,
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
]);
export type InventoryScientificCitationPreviewSnapshot = z.infer<
  typeof inventoryScientificCitationPreviewSnapshotSchema
>;
export type InventoryScientificCitationWithdrawalPreviewSnapshot = z.infer<
  typeof inventoryScientificCitationWithdrawalPreviewSnapshotSchema
>;
export type InventoryScientificCitationsRead = z.infer<
  typeof inventoryScientificCitationsReadSchema
>;
export type InventoryScientificCitationSourceRead = z.infer<
  typeof inventoryScientificCitationSourceReadSchema
>;
