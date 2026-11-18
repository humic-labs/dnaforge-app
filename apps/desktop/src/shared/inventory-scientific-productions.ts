import { z } from 'zod';
import {
  parseInventoryScientificProduction,
  parseInventoryScientificProductionChoices,
  parseAcceptedDnaProductionSelection,
  parseInventoryRecordedPrincipal,
  parseInventoryCommand,
  normalizeInventoryAmount,
  inventoryTableCanonicalJson,
  inventoryTableSha256,
  inventoryProtocolRunSourceSha256,
  type InventoryScientificProductionCommand,
  type InventoryErrorCode,
  type InventoryTableSha256,
} from '@waypoint/domain-services';
import { protocolRunSavedSourceSchema } from './protocol-packages';
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !!v.trim() && !v.includes('\0'));
const id = text(1024),
  time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/) as z.ZodType<InventoryTableSha256>;
const structural = <T>(parse: (value: unknown) => T) =>
  z.unknown().transform((value, context) => {
    try {
      return parse(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid production value.',
      });
      return z.NEVER;
    }
  });
export const acceptedDnaProductionSelectionSchema = z
  .object({
    scientificWorkspaceId: id,
    revision: z
      .object({
        kind: z.literal('accepted-object'),
        resourceId: id,
        resourceRevisionId: id,
        workspaceVersionId: id,
        contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      parseAcceptedDnaProductionSelection(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid accepted DNA design selection.',
      });
    }
  });
const canonicalAmount = z
  .object({ value: text(128), unit: z.enum(['uL', 'ng', 'nmol', 'item']) })
  .strict()
  .refine((value) => {
    try {
      return (
        value.value !== '0' &&
        inventoryTableCanonicalJson(normalizeInventoryAmount(value)) ===
          inventoryTableCanonicalJson(value)
      );
    } catch {
      return false;
    }
  });
export const inventoryScientificProductionChoicesSchema = z
  .object({
    identity: z.object({ namespace: text(1024), productionId: text(1024) }).strict(),
    context: z
      .object({ kind: z.literal('protocol-run'), entityId: id, sourceSha256: digest })
      .strict(),
    design: acceptedDnaProductionSelectionSchema,
    inputs: z
      .array(z.object({ stockId: text(512), quantity: canonicalAmount }).strict())
      .min(1)
      .max(253)
      .readonly(),
    output: z.object({ vesselId: id, quantity: canonicalAmount, lotName: text(512) }).strict(),
    method: text(2000),
    reason: text(2000),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      parseInventoryScientificProductionChoices(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid canonical production choices.',
      });
    }
  });
const scope = z.object({ project: text(4096), inventoryId: text(256) }).strict();
const contextIdentity = z.object({ kind: z.literal('protocol-run'), entityId: id }).strict();
export const inventoryScientificProductionDesignCursorSchema = z
  .object({
    querySha256: digest,
    snapshotSha256: digest,
    acceptedHead: id,
    after: z.object({ resourceId: id }).strict(),
  })
  .strict();
export const inventoryScientificProductionCursorSchema = z
  .object({
    querySha256: digest,
    revision: time,
    after: z.object({ at: time, productionId: id }).strict(),
  })
  .strict();
export const inventoryScientificProductionDesignsRequestSchema = scope
  .extend({
    query: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryScientificProductionDesignCursorSchema.optional(),
  })
  .strict();
export const inventoryPreviewScientificProductionRequestSchema = scope
  .extend({ expectedRevision: time, choices: inventoryScientificProductionChoicesSchema })
  .strict();
export const inventoryApplyScientificProductionRequestSchema =
  inventoryPreviewScientificProductionRequestSchema
    .extend({
      kind: z.literal('record-scientific-production'),
      operationId: text(256),
      expectedPlanDigest: digest,
    })
    .strict();
export const inventoryScientificProductionsRequestSchema = scope
  .extend({
    context: contextIdentity.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryScientificProductionCursorSchema.optional(),
  })
  .strict();
export const inventoryScientificProductionRequestSchema = scope
  .extend({ productionId: id, intentSha256: digest })
  .strict();
export const inventoryScientificProductionSourceRequestSchema =
  inventoryScientificProductionRequestSchema;
const production = structural(parseInventoryScientificProduction),
  recorded = structural(parseInventoryRecordedPrincipal);
const principal = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('local-profile'), profileKey: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  z.object({ kind: z.literal('agent'), identityId: text(500) }).strict(),
]);
const unavailable = z
  .object({
    kind: z.literal('unavailable'),
    code: text(256),
    message: text(4096),
    retryable: z.boolean(),
  })
  .strict();
const target = z
  .object({ projectId: id, inventoryId: text(256), present: z.boolean(), revision: time })
  .strict();
const binding = z
  .object({
    kind: z.literal('accepted-dna-design'),
    owner: z.object({ projectId: id, workspaceScope: id, scientificWorkspaceId: id }).strict(),
    selection: acceptedDnaProductionSelectionSchema,
    document: z
      .object({
        name: text(4096),
        molecule: z.literal('DNA'),
        length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        topology: z.enum(['linear', 'circular']),
        scientificSha256: digest,
      })
      .strict(),
  })
  .strict();
const command = z.custom<InventoryScientificProductionCommand>((value) => {
  try {
    const parsed = parseInventoryCommand(value);
    return (
      ['consume', 'create-lot', 'manage-lot', 'receive-lot-stock'].includes(parsed.kind) &&
      inventoryTableCanonicalJson(parsed) === inventoryTableCanonicalJson(value)
    );
  } catch {
    return false;
  }
});
const facts = {
  schema: z.literal('dnaforge.inventory-scientific-production-preview.v1'),
  projectId: id,
  inventoryId: text(256),
  revision: time,
  target,
  productionId: id.nullable(),
  intentSha256: digest.nullable(),
  sourceSha256: digest.nullable(),
  asOf: time,
  principal,
  nextBoundaryAt: time.nullable(),
};
const issue = z
  .object({
    code: text(256) as z.ZodType<InventoryErrorCode>,
    pointer: z.string().max(4096),
    message: text(4096),
  })
  .strict();
export const inventoryScientificProductionPreviewSnapshotSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...facts,
        kind: z.literal('ready'),
        production,
        commands: z.array(command).min(4).max(256).readonly(),
        planDigest: digest,
      })
      .strict(),
    z
      .object({
        ...facts,
        kind: z.literal('no-change'),
        production,
        commands: z.tuple([]).readonly(),
        planDigest: z.null(),
      })
      .strict(),
    z
      .object({
        ...facts,
        kind: z.literal('blocked'),
        production: z.null(),
        commands: z.tuple([]).readonly(),
        planDigest: z.null(),
        issues: z.array(issue).min(1).readonly(),
      })
      .strict(),
    unavailable,
  ])
  .superRefine((v, c) => {
    if (v.kind === 'unavailable') return;
    if (
      v.target.projectId !== v.projectId ||
      v.target.inventoryId !== v.inventoryId ||
      v.target.revision !== v.revision ||
      (v.nextBoundaryAt !== null && v.nextBoundaryAt <= v.asOf)
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Production preview scope or boundary mismatch.',
      });
    if (
      v.kind !== 'blocked' &&
      (v.production.id !== v.productionId ||
        v.production.intentSha256 !== v.intentSha256 ||
        v.production.context.source.sha256 !== v.sourceSha256)
    )
      c.addIssue({ code: z.ZodIssueCode.custom, message: 'Production preview pins mismatch.' });
  });
const header = { projectId: id, inventoryId: text(256), revision: time };
const designDocument = z
  .object({
    name: text(4096),
    length: z.number().int().positive(),
    topology: z.enum(['linear', 'circular']),
    scientificSha256: digest,
  })
  .strict();
const materialAdmission = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('admitted'),
      material: z
        .object({ id, name: text(4096), kind: text(256), registryId: z.string().nullable() })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('unavailable'), code: text(256), message: text(4096) }).strict(),
]);
export const inventoryScientificProductionDesignCandidateSchema = z
  .object({
    selection: acceptedDnaProductionSelectionSchema,
    document: designDocument,
    materialAdmission,
  })
  .strict();
const designHeader = {
  ...header,
  asOf: time,
  principal,
  scientificWorkspaceId: id,
  query: z.string().max(1024),
};
export const inventoryScientificProductionDesignsReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...designHeader,
        kind: z.literal('ready'),
        acceptedHead: id,
        designs: z.array(inventoryScientificProductionDesignCandidateSchema).max(50).readonly(),
        nextCursor: inventoryScientificProductionDesignCursorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...designHeader,
        kind: z.literal('setup-required'),
        acceptedHead: z.null(),
        designs: z.tuple([]).readonly(),
        nextCursor: z.null(),
      })
      .strict(),
    unavailable,
  ])
  .superRefine((value, context) => {
    if (value.kind !== 'ready') return;
    const keys = value.designs.map((row) => row.selection.revision.resourceId),
      last = value.designs.at(-1);
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key, index) => index > 0 && key <= keys[index - 1]) ||
      value.designs.some(
        (row) =>
          row.selection.scientificWorkspaceId !== value.scientificWorkspaceId ||
          row.selection.revision.workspaceVersionId !== value.acceptedHead
      ) ||
      (value.nextCursor &&
        (!last ||
          value.nextCursor.acceptedHead !== value.acceptedHead ||
          value.nextCursor.after.resourceId !== last.selection.revision.resourceId))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Design page ordering, source scope or cursor boundary mismatch.',
      });
  });
const summary = z
  .object({
    id,
    identity: z.object({ namespace: text(1024), productionId: text(1024) }).strict(),
    intentSha256: digest,
    context: z
      .object({
        kind: z.literal('protocol-run'),
        projectId: id,
        workspaceScope: id,
        entityId: id,
        source: z
          .object({
            kind: z.literal('native-observed-saved-source'),
            fileObjectUuid: id,
            sha256: digest,
            title: z.string().max(4096),
          })
          .strict(),
      })
      .strict(),
    design: binding,
    materialBinding: z.object({ sourceMaterialId: id, destinationMaterialId: id }).strict(),
    output: z
      .object({
        lotId: id,
        stockId: id,
        vesselId: id,
        quantity: canonicalAmount,
        lotName: text(512),
      })
      .strict(),
    inputStockCount: z.number().int().min(1).max(253),
    method: text(2000),
    reason: text(2000),
    at: time,
    by: recorded,
  })
  .strict();
const filters = z.object({ context: contextIdentity.nullable() }).strict();
export const inventoryScientificProductionsReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...header,
        kind: z.literal('ready'),
        filters,
        productions: z.array(summary).max(50).readonly(),
        nextCursor: inventoryScientificProductionCursorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...header,
        kind: z.literal('inventory-absent'),
        filters,
        productions: z.tuple([]).readonly(),
        nextCursor: z.null(),
      })
      .strict(),
    unavailable,
  ])
  .superRefine((value, context) => {
    if (value.kind !== 'ready') return;
    const keys = value.productions.map((row) => row.id),
      last = value.productions.at(-1);
    if (
      new Set(keys).size !== keys.length ||
      value.productions.some(
        (row, index) =>
          index > 0 &&
          (row.at < value.productions[index - 1].at ||
            (row.at === value.productions[index - 1].at &&
              row.id <= value.productions[index - 1].id))
      ) ||
      (value.nextCursor &&
        (!last ||
          value.nextCursor.revision !== value.revision ||
          value.nextCursor.after.at !== last.at ||
          value.nextCursor.after.productionId !== last.id))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Production page ordering or cursor boundary mismatch.',
      });
  });
export const inventoryScientificProductionReadSchema = z.discriminatedUnion('kind', [
  z.object({ ...header, kind: z.literal('available'), production }).strict(),
  unavailable,
]);
export const inventoryScientificProductionSourceReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('available'),
        productionId: id,
        intentSha256: digest,
        sourceSha256: digest,
        source: protocolRunSavedSourceSchema,
        design: z
          .object({
            binding,
            representation: z
              .object({ format: z.literal('genbank-v1'), text: z.string().max(17 * 1024 * 1024) })
              .strict(),
            proofSha256: digest,
          })
          .strict(),
      })
      .strict(),
    unavailable,
  ])
  .superRefine((v, c) => {
    if (
      v.kind === 'available' &&
      (inventoryProtocolRunSourceSha256(v.source) !== v.sourceSha256 ||
        inventoryTableSha256(v.design.representation.text).slice(7) !==
          v.design.binding.selection.revision.contentSha256)
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Production retained Run source digest mismatch.',
      });
  });
export type InventoryScientificProductionDesignsRequest = z.infer<
  typeof inventoryScientificProductionDesignsRequestSchema
>;
export type InventoryPreviewScientificProductionRequest = z.infer<
  typeof inventoryPreviewScientificProductionRequestSchema
>;
export type InventoryApplyScientificProductionRequest = z.infer<
  typeof inventoryApplyScientificProductionRequestSchema
>;
export type InventoryScientificProductionsRequest = z.infer<
  typeof inventoryScientificProductionsRequestSchema
>;
export type InventoryScientificProductionRequest = z.infer<
  typeof inventoryScientificProductionRequestSchema
>;
export type InventoryScientificProductionSourceRequest = z.infer<
  typeof inventoryScientificProductionSourceRequestSchema
>;
export type InventoryScientificProductionPreviewSnapshot = z.infer<
  typeof inventoryScientificProductionPreviewSnapshotSchema
>;
export type InventoryScientificProductionDesignsRead = z.infer<
  typeof inventoryScientificProductionDesignsReadSchema
>;
export type InventoryScientificProductionsRead = z.infer<
  typeof inventoryScientificProductionsReadSchema
>;
export type InventoryScientificProductionRead = z.infer<
  typeof inventoryScientificProductionReadSchema
>;
export type InventoryScientificProductionSourceRead = z.infer<
  typeof inventoryScientificProductionSourceReadSchema
>;
export type InventoryScientificProductionCursor = z.infer<
  typeof inventoryScientificProductionCursorSchema
>;
export type InventoryScientificProductionDesignCursor = z.infer<
  typeof inventoryScientificProductionDesignCursorSchema
>;
export type InventoryScientificProductionDesignCandidate = z.infer<
  typeof inventoryScientificProductionDesignCandidateSchema
>;
