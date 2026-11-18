import { z } from 'zod';
import {
  parseInventoryRunValueAttribution,
  parseInventoryRunValueAttributionWithdrawal,
  parseInventoryPlatePlanObservation,
  parseInventoryRecordedPrincipal,
  inventoryRunValueJson,
  inventoryRunValueRowSha256,
  type InventoryErrorCode,
} from '@waypoint/domain-services';
import { protocolRunSavedSourceSchema } from './protocol-packages';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !!v.trim() && !v.includes('\0'));
const id = text(512),
  revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .refine((v): v is `sha256:${string}` => v.startsWith('sha256:'));
const collection = z.enum(['inputs', 'outputs', 'measurements']);
const key = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const runValue = z
  .object({ entityId: id, sourceSha256: sha, collection, key, rowSha256: sha })
  .strict();
const physical = z
  .object({
    observationId: id,
    observationIntentSha256: sha,
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('source-stock'), stockId: id }).strict(),
      z.object({ kind: z.literal('output-action'), actionId: id, stockId: id }).strict(),
    ]),
  })
  .strict();
const predecessor = z
  .object({
    attributionId: id,
    attributionIntentSha256: sha,
    withdrawalId: id,
    withdrawalIntentSha256: sha,
  })
  .strict();
export const inventoryRunValueAttributionChoicesSchema = z
  .object({
    identity: z.object({ namespace: text(1024), attributionId: text(1024) }).strict(),
    runValue,
    physical,
    predecessor: predecessor.nullable(),
    reason: text(2000),
  })
  .strict();
export const inventoryRunValueAttributionWithdrawalChoicesSchema = z
  .object({
    identity: z.object({ namespace: text(1024), withdrawalId: text(1024) }).strict(),
    attributionId: id,
    attributionIntentSha256: sha,
    reason: text(2000),
  })
  .strict();
const scope = z.object({ project: text(4096), inventoryId: text(256) }).strict();
export const inventoryPreviewRunValueAttributionRequestSchema = scope
  .extend({ expectedRevision: revision, choices: inventoryRunValueAttributionChoicesSchema })
  .strict();
export const inventoryApplyRunValueAttributionRequestSchema =
  inventoryPreviewRunValueAttributionRequestSchema
    .extend({
      kind: z.literal('record-run-value-attribution'),
      operationId: text(256),
      expectedPlanDigest: sha,
    })
    .strict();
export const inventoryPreviewRunValueAttributionWithdrawalRequestSchema = scope
  .extend({
    expectedRevision: revision,
    choices: inventoryRunValueAttributionWithdrawalChoicesSchema,
  })
  .strict();
export const inventoryApplyRunValueAttributionWithdrawalRequestSchema =
  inventoryPreviewRunValueAttributionWithdrawalRequestSchema
    .extend({
      kind: z.literal('withdraw-run-value-attribution'),
      operationId: text(256),
      expectedPlanDigest: sha,
    })
    .strict();
export const inventoryRunValueCandidateCursorSchema = z
  .object({
    querySha256: sha,
    revision,
    sourceSha256: sha,
    after: z.object({ ordinal: revision, rowSha256: sha }).strict(),
  })
  .strict();
export const inventoryRunValueCandidatesRequestSchema = scope
  .extend({
    runId: id,
    collection: collection.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryRunValueCandidateCursorSchema.optional(),
  })
  .strict();
export const inventoryRunValueAttributionCursorSchema = z
  .object({
    querySha256: sha,
    revision,
    after: z
      .object({
        at: revision,
        attributionId: z.string().regex(/^run-value-attribution:[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export const inventoryRunValueAttributionsRequestSchema = scope
  .extend({
    run: z.object({ entityId: id }).strict().optional(),
    slot: z.object({ collection, key }).strict().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryRunValueAttributionCursorSchema.optional(),
  })
  .strict()
  .refine((v) => !v.slot || !!v.run, 'A slot filter requires its exact Run.');
export const inventoryRunValueAttributionRequestSchema = scope
  .extend({
    attributionId: z.string().regex(/^run-value-attribution:[a-f0-9]{64}$/),
    intentSha256: sha,
  })
  .strict();
export const inventoryRunValueAttributionSourceRequestSchema =
  inventoryRunValueAttributionRequestSchema;
function structural<T>(parse: (v: unknown) => T) {
  return z.unknown().transform((v, c) => {
    try {
      return parse(v);
    } catch (e) {
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : 'Invalid saved value data.',
      });
      return z.NEVER;
    }
  });
}
const rawRow = structural((v) => {
  const row = inventoryRunValueJson(v);
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw Error('A complete raw saved row is required.');
  return row as Readonly<Record<string, unknown>>;
});
const attribution = structural(parseInventoryRunValueAttribution),
  withdrawal = structural(parseInventoryRunValueAttributionWithdrawal),
  observation = structural(parseInventoryPlatePlanObservation);
const sourceMetadata = z
  .object({
    kind: z.literal('native-observed-saved-source'),
    projectId: id,
    workspaceScope: id,
    fileObjectUuid: id,
    title: text(17 * 1024 * 1024),
  })
  .strict();
const origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-actual') }).strict(),
  z.object({ kind: z.literal('frozen-declaration'), definitionSha256: sha }).strict(),
]);
const valueKind = z.enum(['text', 'number', 'boolean', 'date']);
const eligibility = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('eligible'), valueKind }).strict(),
  z.object({ kind: z.literal('unsupported'), code: text(256), message: text(4096) }).strict(),
]);
const run = z
  .object({
    entityId: id,
    projectId: id,
    workspaceScope: id,
    fileObjectUuid: id,
    title: text(17 * 1024 * 1024),
    sourceSha256: sha,
  })
  .strict();
const candidate = z
  .object({
    ordinal: revision,
    collection,
    key: z
      .string()
      .min(1)
      .max(17 * 1024 * 1024),
    rowSha256: sha,
    row: rawRow,
    origin: origin.nullable(),
    eligibility,
  })
  .strict();
const unavailable = { code: text(256), message: text(4096), retryable: z.boolean() };
const facts = { projectId: id, inventoryId: text(256), revision };
const target = z.object({ ...facts, present: z.boolean() }).strict();
const principal = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('local-profile'), profileKey: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  z.object({ kind: z.literal('agent'), identityId: text(500) }).strict(),
]);
const entry = z.object({ attribution, withdrawal: withdrawal.nullable() }).strict();
const issues = z
  .array(
    z
      .object({
        code: text(256).refine((v): v is InventoryErrorCode => !!v),
        pointer: z.string().max(4096),
        message: text(4096),
      })
      .strict()
  )
  .min(1)
  .readonly();
const previewFacts = {
  ...facts,
  target,
  asOf: revision,
  principal,
  attributionId: id.nullable(),
  intentSha256: sha.nullable(),
  sourceSha256: sha.nullable(),
};
const recordFacts = {
  ...previewFacts,
  schema: z.literal('dnaforge.inventory-run-value-attribution-preview.v1'),
};
export const inventoryRunValueAttributionPreviewSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ ...recordFacts, kind: z.literal('ready'), attribution, planDigest: sha }).strict(),
  z.object({ ...recordFacts, kind: z.literal('no-change'), entry }).strict(),
  z.object({ ...recordFacts, kind: z.literal('blocked'), issues }).strict(),
  z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
]);
const withdrawalFacts = {
  ...previewFacts,
  schema: z.literal('dnaforge.inventory-run-value-attribution-withdrawal-preview.v1'),
};
export const inventoryRunValueAttributionWithdrawalPreviewSnapshotSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        ...withdrawalFacts,
        kind: z.literal('ready'),
        attribution,
        withdrawal,
        planDigest: sha,
      })
      .strict(),
    z.object({ ...withdrawalFacts, kind: z.literal('no-change'), entry }).strict(),
    z.object({ ...withdrawalFacts, kind: z.literal('blocked'), issues }).strict(),
    z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
  ]
);
const filter = z.object({ collection: collection.nullable() }).strict();
export const inventoryRunValueCandidatesReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...facts,
        kind: z.literal('ready'),
        asOf: revision,
        run,
        filter,
        rows: z.array(candidate).max(50).readonly(),
        nextCursor: inventoryRunValueCandidateCursorSchema.nullable(),
      })
      .strict(),
    z.object({ ...facts, kind: z.literal('inventory-absent'), runId: id, filter }).strict(),
    z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
  ])
  .superRefine((v, c) => {
    if (v.kind !== 'ready') return;
    for (const row of v.rows) {
      if (
        row.rowSha256 !== inventoryRunValueRowSha256(row.collection, row.row) ||
        row.row.key !== row.key
      )
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Saved row pin mismatch.' });
    }
    if (v.projectId !== v.run.projectId || v.run.workspaceScope !== v.run.projectId)
      c.addIssue({ code: z.ZodIssueCode.custom, message: 'Run candidate scope mismatch.' });
  });
const summary = z
  .object({
    id,
    identity: z.object({ namespace: text(1024), attributionId: text(1024) }).strict(),
    intentSha256: sha,
    runValue,
    physical,
    predecessor: predecessor.nullable(),
    source: sourceMetadata,
    slotLabel: text(17 * 1024 * 1024),
    valueKind,
    at: revision,
    by: structural(parseInventoryRecordedPrincipal),
    reason: text(2000),
  })
  .strict();
const filters = z
  .object({
    run: z.object({ entityId: id }).strict().nullable(),
    slot: z.object({ collection, key }).strict().nullable(),
  })
  .strict();
export const inventoryRunValueAttributionsReadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...facts,
      kind: z.literal('ready'),
      filters,
      entries: z
        .array(z.object({ attribution: summary, withdrawal: withdrawal.nullable() }).strict())
        .max(50)
        .readonly(),
      nextCursor: inventoryRunValueAttributionCursorSchema.nullable(),
    })
    .strict(),
  z.object({ ...facts, kind: z.literal('inventory-absent'), filters }).strict(),
  z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
]);
const currentRow = z.object({ rowSha256: sha, row: rawRow, eligibility }).strict();
export const inventoryRunValueAttributionComparisonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('same-source'), run, row: currentRow }).strict(),
  z.object({ kind: z.literal('changed-source-same-row'), run, row: currentRow }).strict(),
  z.object({ kind: z.literal('changed-row'), run, row: currentRow }).strict(),
  z.object({ kind: z.literal('missing-row'), run }).strict(),
  z.object({ kind: z.literal('replaced-binding'), run }).strict(),
  z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
]);
export const inventoryRunValueAttributionReadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...facts,
      kind: z.literal('available'),
      asOf: revision,
      attribution,
      withdrawal: withdrawal.nullable(),
      observation,
      currentComparison: inventoryRunValueAttributionComparisonSchema,
    })
    .strict(),
  z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
]);
export const inventoryRunValueAttributionSourceReadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...facts,
      kind: z.literal('available'),
      attributionId: id,
      intentSha256: sha,
      sourceSha256: sha,
      source: protocolRunSavedSourceSchema,
    })
    .strict(),
  z.object({ kind: z.literal('unavailable'), ...unavailable }).strict(),
]);
export type InventoryRunValueCandidatesRequest = z.infer<
  typeof inventoryRunValueCandidatesRequestSchema
>;
export type InventoryPreviewRunValueAttributionRequest = z.infer<
  typeof inventoryPreviewRunValueAttributionRequestSchema
>;
export type InventoryApplyRunValueAttributionRequest = z.infer<
  typeof inventoryApplyRunValueAttributionRequestSchema
>;
export type InventoryPreviewRunValueAttributionWithdrawalRequest = z.infer<
  typeof inventoryPreviewRunValueAttributionWithdrawalRequestSchema
>;
export type InventoryApplyRunValueAttributionWithdrawalRequest = z.infer<
  typeof inventoryApplyRunValueAttributionWithdrawalRequestSchema
>;
export type InventoryRunValueAttributionsRequest = z.infer<
  typeof inventoryRunValueAttributionsRequestSchema
>;
export type InventoryRunValueAttributionRequest = z.infer<
  typeof inventoryRunValueAttributionRequestSchema
>;
export type InventoryRunValueAttributionSourceRequest = z.infer<
  typeof inventoryRunValueAttributionSourceRequestSchema
>;
export type InventoryRunValueCandidatesRead = z.infer<typeof inventoryRunValueCandidatesReadSchema>;
export type InventoryRunValueAttributionPreviewSnapshot = z.infer<
  typeof inventoryRunValueAttributionPreviewSnapshotSchema
>;
export type InventoryRunValueAttributionWithdrawalPreviewSnapshot = z.infer<
  typeof inventoryRunValueAttributionWithdrawalPreviewSnapshotSchema
>;
export type InventoryRunValueAttributionsRead = z.infer<
  typeof inventoryRunValueAttributionsReadSchema
>;
export type InventoryRunValueAttributionRead = z.infer<
  typeof inventoryRunValueAttributionReadSchema
>;
export type InventoryRunValueAttributionSourceRead = z.infer<
  typeof inventoryRunValueAttributionSourceReadSchema
>;
export type InventoryRunValueCandidateCursor = z.infer<
  typeof inventoryRunValueCandidateCursorSchema
>;
export type InventoryRunValueAttributionCursor = z.infer<
  typeof inventoryRunValueAttributionCursorSchema
>;
