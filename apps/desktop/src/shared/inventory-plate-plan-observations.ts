import { z } from 'zod';
import {
  inventoryPlatePlanText,
  parseInventoryPlatePlanObservation,
  parseInventoryRecordedPrincipal,
  parseInventoryCommand,
  inventoryTableCanonicalJson,
  inventoryNotebookSourceSha256,
  inventoryProtocolRunSourceSha256,
  type InventoryErrorCode,
  type InventoryTableSha256,
  type InventoryScientificTransferCommand,
} from '@waypoint/domain-services';
import { inventoryPlatePlanBindingSchema } from './inventory-plate-plans';
import { notebookSavedSourceSchema } from './notebook-saved-source';
import { protocolRunSavedSourceSchema } from './protocol-packages';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => {
      try {
        inventoryPlatePlanText(value, max, 'field');
        return true;
      } catch {
        return false;
      }
    });
const id = text(512),
  time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/) as z.ZodType<InventoryTableSha256>;
const identity = z.object({ namespace: text(1024), observationId: text(1024) }).strict();
const contextIdentity = z
  .object({ kind: z.enum(['notebook-page', 'protocol-run']), entityId: id })
  .strict();
const selection = contextIdentity.extend({ sourceSha256: digest }).strict();
const version = z.object({ versionId: id, definitionSha256: digest }).strict();
const scope = z.object({ project: text(4096), inventoryId: text(256) }).strict();
export const inventoryPlatePlanObservationChoicesSchema = z
  .object({
    identity,
    context: selection,
    binding: inventoryPlatePlanBindingSchema,
    reason: text(2000),
  })
  .strict();
export const inventoryPreviewPlatePlanObservationRequestSchema = scope
  .extend({ expectedRevision: time, choices: inventoryPlatePlanObservationChoicesSchema })
  .strict();
export const inventoryApplyPlatePlanObservationRequestSchema =
  inventoryPreviewPlatePlanObservationRequestSchema
    .extend({
      kind: z.literal('record-plate-plan-observation'),
      operationId: text(256),
      expectedPlanDigest: digest,
    })
    .strict();
export const inventoryPlatePlanObservationCursorSchema = z
  .object({
    querySha256: digest,
    revision: time,
    after: z
      .object({
        at: time,
        observationId: z.string().regex(/^plate-plan-observation:[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export const inventoryPlatePlanObservationsRequestSchema = scope
  .extend({
    version: version.optional(),
    context: contextIdentity.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryPlatePlanObservationCursorSchema.optional(),
  })
  .strict();
export const inventoryPlatePlanObservationRequestSchema = scope
  .extend({ observationId: id, intentSha256: digest })
  .strict();
export const inventoryPlatePlanObservationSourceRequestSchema =
  inventoryPlatePlanObservationRequestSchema;
export type InventoryPreviewPlatePlanObservationRequest = z.infer<
  typeof inventoryPreviewPlatePlanObservationRequestSchema
>;
export type InventoryApplyPlatePlanObservationRequest = z.infer<
  typeof inventoryApplyPlatePlanObservationRequestSchema
>;
export type InventoryPlatePlanObservationsRequest = z.infer<
  typeof inventoryPlatePlanObservationsRequestSchema
>;
export type InventoryPlatePlanObservationRequest = z.infer<
  typeof inventoryPlatePlanObservationRequestSchema
>;
export type InventoryPlatePlanObservationSourceRequest = z.infer<
  typeof inventoryPlatePlanObservationSourceRequestSchema
>;
export type InventoryPlatePlanObservationCursor = z.infer<
  typeof inventoryPlatePlanObservationCursorSchema
>;
function structural<T>(parse: (value: unknown) => T) {
  return z.unknown().transform((value, context) => {
    try {
      return parse(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid observation record.',
      });
      return z.NEVER;
    }
  });
}
const observation = structural(parseInventoryPlatePlanObservation),
  recorded = structural(parseInventoryRecordedPrincipal);
const principal = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('local-profile'), profileKey: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  z.object({ kind: z.literal('agent'), identityId: text(500) }).strict(),
]);
const target = z
  .object({ projectId: id, inventoryId: text(256), present: z.boolean(), revision: time })
  .strict();
const issues = z
  .array(
    z
      .object({
        code: text(256) as z.ZodType<InventoryErrorCode>,
        pointer: z.string().max(4096),
        message: text(4096),
      })
      .strict()
  )
  .min(1)
  .readonly();
const command = z.custom<InventoryScientificTransferCommand>((value) => {
  try {
    const parsed = parseInventoryCommand(value);
    return (
      parsed.kind === 'transfer' &&
      parsed.destination.kind === 'new-stock' &&
      !('mixing' in parsed) &&
      inventoryTableCanonicalJson(parsed) === inventoryTableCanonicalJson(value)
    );
  } catch {
    return false;
  }
});
const unavailable = z
  .object({
    kind: z.literal('unavailable'),
    code: text(256),
    message: text(4096),
    retryable: z.boolean(),
  })
  .strict();
const previewFacts = {
  schema: z.literal('dnaforge.inventory-plate-plan-observation-preview.v1'),
  projectId: id,
  inventoryId: text(256),
  revision: time,
  target,
  observationId: id.nullable(),
  intentSha256: digest.nullable(),
  sourceSha256: digest.nullable(),
  asOf: time,
  principal,
  nextBoundaryAt: time.nullable(),
};
export const inventoryPlatePlanObservationPreviewSnapshotSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...previewFacts,
        kind: z.literal('ready'),
        observation,
        commands: z.array(command).min(1).max(256).readonly(),
        planDigest: digest,
      })
      .strict(),
    z
      .object({
        ...previewFacts,
        kind: z.literal('no-change'),
        observation,
        commands: z.tuple([]).readonly(),
        planDigest: z.null(),
      })
      .strict(),
    z
      .object({
        ...previewFacts,
        kind: z.literal('blocked'),
        issues,
        observation: z.null(),
        commands: z.tuple([]).readonly(),
        planDigest: z.null(),
      })
      .strict(),
    unavailable,
  ])
  .transform((value, context) => {
    if (value.kind === 'unavailable') return value;
    if (
      value.target.projectId !== value.projectId ||
      value.target.inventoryId !== value.inventoryId ||
      value.target.revision !== value.revision ||
      (value.nextBoundaryAt !== null && value.nextBoundaryAt <= value.asOf)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Observation preview scope, revision or boundary is invalid.',
      });
    if (
      value.kind !== 'blocked' &&
      (value.observation.id !== value.observationId ||
        value.observation.intentSha256 !== value.intentSha256 ||
        value.observation.context.source.sha256 !== value.sourceSha256)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Observation preview pins do not match its record.',
      });
    if (
      value.kind === 'ready' &&
      inventoryTableCanonicalJson(value.commands) !==
        inventoryTableCanonicalJson(value.observation.actions.map((row) => row.transfer))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Observation preview commands do not match its ordered actions.',
      });
    return value;
  });
const layout = z
  .object({
    kind: z.literal('fixed-well'),
    rows: z.number().int().min(1).max(10000),
    columns: z.number().int().min(1).max(10000),
  })
  .strict()
  .refine((value) => value.rows * value.columns <= 10000);
const savedContext = z
  .object({
    kind: z.enum(['notebook-page', 'protocol-run']),
    projectId: id,
    workspaceScope: id,
    entityId: id,
    source: z
      .object({
        kind: z.literal('native-observed-saved-source'),
        sha256: digest,
        fileObjectUuid: id,
        title: text(17 * 1024 * 1024),
      })
      .strict(),
  })
  .strict();
const summary = z
  .object({
    id,
    identity,
    intentSha256: digest,
    versionId: id,
    definitionSha256: digest,
    planTitle: text(200),
    context: savedContext,
    plate: z.object({ id, name: text(200), layout }).strict(),
    actionCount: z.number().int().min(1).max(256),
    sourceStockCount: z.number().int().min(1).max(256),
    at: time,
    by: recorded,
    reason: text(2000),
  })
  .strict();
const filters = z
  .object({ version: version.nullable(), context: contextIdentity.nullable() })
  .strict();
export const inventoryPlatePlanObservationsReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('ready'),
        projectId: id,
        inventoryId: text(256),
        revision: time,
        filters,
        observations: z.array(summary).max(50).readonly(),
        nextCursor: inventoryPlatePlanObservationCursorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('inventory-absent'),
        projectId: id,
        inventoryId: text(256),
        filters,
      })
      .strict(),
    unavailable,
  ])
  .transform((value, context) => {
    if (value.kind !== 'ready') return value;
    const seen = new Set<string>();
    for (const [index, row] of value.observations.entries()) {
      const previous = value.observations[index - 1],
        filter = value.filters;
      if (
        seen.has(row.id) ||
        (previous && (previous.at > row.at || (previous.at === row.at && previous.id >= row.id))) ||
        (filter.version &&
          (row.versionId !== filter.version.versionId ||
            row.definitionSha256 !== filter.version.definitionSha256)) ||
        (filter.context &&
          (row.context.projectId !== value.projectId ||
            row.context.workspaceScope !== value.projectId ||
            row.context.kind !== filter.context.kind ||
            row.context.entityId !== filter.context.entityId))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Observation page ordering or filter scope is invalid.',
        });
      seen.add(row.id);
    }
    if (value.nextCursor) {
      const last = value.observations.at(-1);
      if (
        !last ||
        value.nextCursor.revision !== value.revision ||
        value.nextCursor.after.observationId !== last.id ||
        value.nextCursor.after.at !== last.at
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Observation cursor does not match the page.',
        });
    }
    return value;
  });
export const inventoryPlatePlanObservationReadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      projectId: id,
      inventoryId: text(256),
      revision: time,
      observation,
    })
    .strict(),
  unavailable,
]);
export const inventoryPlatePlanObservationSourceReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('available'),
        observationId: id,
        intentSha256: digest,
        sourceSha256: digest,
        source: z.discriminatedUnion('schema', [
          notebookSavedSourceSchema,
          protocolRunSavedSourceSchema,
        ]),
      })
      .strict(),
    unavailable,
  ])
  .transform((value, context) => {
    if (
      value.kind === 'available' &&
      (value.source.schema === 'dnaforge.notebook-saved-source.v1'
        ? inventoryNotebookSourceSha256(value.source)
        : inventoryProtocolRunSourceSha256(value.source)) !== value.sourceSha256
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The retained source packet does not match its pin.',
      });
    return value;
  });
export type InventoryPlatePlanObservationPreviewSnapshot = z.infer<
  typeof inventoryPlatePlanObservationPreviewSnapshotSchema
>;
export type InventoryPlatePlanObservationsRead = z.infer<
  typeof inventoryPlatePlanObservationsReadSchema
>;
export type InventoryPlatePlanObservationRead = z.infer<
  typeof inventoryPlatePlanObservationReadSchema
>;
export type InventoryPlatePlanObservationSourceRead = z.infer<
  typeof inventoryPlatePlanObservationSourceReadSchema
>;
