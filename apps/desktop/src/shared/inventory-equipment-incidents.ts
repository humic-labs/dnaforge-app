import { z } from 'zod';
import {
  parseInventoryEquipmentIncidentActionChoices,
  parseInventoryEquipmentIncidentActionSummary,
  parseInventoryEquipmentIncidentSummary,
  parseInventoryEquipmentIncidentFact,
  parseInventoryEquipmentIncidentSubjectProjection,
  parseInventoryEquipmentIncidentFactSummary,
  parseInventoryEquipmentIncidentManualFactProjection,
  parseInventoryCommand,
  type InventoryEquipmentIncidentActionChoices,
  type InventoryEquipmentIncidentCurrentStatus,
  type InventoryTableSha256,
} from '@waypoint/domain-services';
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !!v.trim() && !v.includes('\0'));
const id = text(1024),
  time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/) as z.ZodType<InventoryTableSha256>;
const structural = <T>(parse: (v: unknown) => T) =>
  z.unknown().transform((v, c) => {
    try {
      return parse(v);
    } catch (e) {
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : 'Invalid incident value.',
      });
      return z.NEVER;
    }
  });
const pin = z.object({ incidentId: id, intentSha256: digest }).strict();
const factPin = z.object({ factId: id, intentSha256: digest }).strict();
const rootPin = z.object({ rootId: id, intentSha256: digest }).strict();
const item = z.object({ kind: z.enum(['storage', 'vessel']), id }).strict();
const destination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }).strict(),
  z.object({ kind: z.literal('unplaced') }).strict(),
  z.object({ kind: z.literal('located'), storageId: id, slotId: id }).strict(),
  z.object({ kind: z.literal('stack-top'), stackId: id }).strict(),
]);
const reason = text(2000);
const action = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('report'),
      equipment: z.object({ storageId: id, configurationRevision: time }).strict(),
      noticedAt: time.nullable(),
      description: reason,
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('manual-temperature'),
      incident: pin,
      reading: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('measured'),
            temperature: z.object({ value: text(128), unit: z.literal('C') }).strict(),
            observedAt: time,
            pointLabel: reason,
          })
          .strict(),
        z.object({ kind: z.literal('withdrawn') }).strict(),
      ]),
      supersedes: factPin.nullable(),
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('completed-relocation'),
      incident: pin,
      moves: z.array(z.object({ item, destination }).strict()).min(1).max(256).readonly(),
      corrects: factPin.nullable(),
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('impact-review'),
      incident: pin,
      subjects: z
        .array(z.object({ root: rootPin, supersedes: factPin.nullable() }).strict())
        .min(1)
        .max(1000)
        .readonly(),
      disposition: z.enum(['keep-incident-restriction', 'remove-incident-restriction']),
      basis: reason,
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve'),
      incident: pin,
      resolution: z.enum(['reported-resolved', 'reported-in-error']),
      reason,
    })
    .strict(),
]);
export const inventoryEquipmentIncidentActionChoicesSchema = z
  .object({ identity: z.object({ namespace: id, actionId: id }).strict(), action })
  .strict()
  .superRefine((v, c) => {
    try {
      parseInventoryEquipmentIncidentActionChoices(v);
    } catch (e) {
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : 'Invalid incident action.',
      });
    }
  }) as z.ZodType<InventoryEquipmentIncidentActionChoices>;
const scope = z.object({ project: text(4096), inventoryId: text(256) }).strict();
export const inventoryEquipmentIncidentCursorSchema = z
  .object({
    querySha256: digest,
    revision: time,
    after: z.object({ at: time, incidentId: id }).strict(),
  })
  .strict();
export const inventoryEquipmentIncidentSubjectCursorSchema = z
  .object({ querySha256: digest, revision: time, after: z.object({ subjectKey: id }).strict() })
  .strict();
export const inventoryEquipmentIncidentFactCursorSchema = z
  .object({
    querySha256: digest,
    revision: time,
    after: z.object({ at: time, factId: id }).strict(),
  })
  .strict();
const limit = z.number().int().min(1).max(50).optional(),
  freshness = time.nullable().optional();
export const inventoryPreviewEquipmentIncidentActionRequestSchema = scope
  .extend({ expectedRevision: time, choices: inventoryEquipmentIncidentActionChoicesSchema })
  .strict();
export const inventoryApplyEquipmentIncidentActionRequestSchema =
  inventoryPreviewEquipmentIncidentActionRequestSchema
    .extend({
      kind: z.literal('record-equipment-incident-action'),
      operationId: text(256),
      expectedPlanDigest: digest,
    })
    .strict();
export const inventoryEquipmentIncidentsRequestSchema = scope
  .extend({
    equipmentId: id.optional(),
    status: z.enum(['open', 'resolved']).optional(),
    limit,
    cursor: inventoryEquipmentIncidentCursorSchema.optional(),
  })
  .strict();
export const inventoryEquipmentIncidentRequestSchema = scope.extend(pin.shape).strict();
export const inventoryEquipmentIncidentSubjectsRequestSchema =
  inventoryEquipmentIncidentRequestSchema
    .extend({
      view: z.enum(['initial', 'current', 'review']),
      freshnessMaxAgeMs: freshness,
      limit,
      cursor: inventoryEquipmentIncidentSubjectCursorSchema.optional(),
    })
    .strict();
const factKind = z.enum([
  'manual-temperature',
  'completed-relocation',
  'impact-review',
  'resolve',
  'contents-identified',
  'contents-episode-closed',
]);
export const inventoryEquipmentIncidentFactsRequestSchema = inventoryEquipmentIncidentRequestSchema
  .extend({
    query: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('page'),
          factKind: factKind.optional(),
          freshnessMaxAgeMs: freshness,
          limit,
          cursor: inventoryEquipmentIncidentFactCursorSchema.optional(),
        })
        .strict(),
      z.object({ kind: z.literal('fact'), fact: factPin, freshnessMaxAgeMs: freshness }).strict(),
    ]),
  })
  .strict();
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
const header = { projectId: id, inventoryId: text(256), revision: time, asOf: time, principal };
const counts = z
  .object({
    capturedHolders: time,
    capturedVessels: time,
    createdReviewRoots: time,
    identifiedContentsBridges: time,
    relocatedHolders: time,
    reviewedRoots: time,
  })
  .strict();
const current: z.ZodType<InventoryEquipmentIncidentCurrentStatus> = z
  .object({
    lifecycle: z.enum(['open', 'resolved']),
    resolution: factPin.nullable(),
    review: z
      .object({ pending: time, kept: time, removed: time, importedRemovalUnconfirmed: time })
      .strict(),
  })
  .strict();
const summary = structural(parseInventoryEquipmentIncidentSummary),
  actionSummary = structural(parseInventoryEquipmentIncidentActionSummary),
  fact = structural(parseInventoryEquipmentIncidentFact);
const previewFacts = {
  ...header,
  schema: z.literal('dnaforge.inventory-equipment-incident-action-preview.v1'),
  target: z
    .object({ projectId: id, inventoryId: text(256), present: z.boolean(), revision: time })
    .strict(),
  actionId: id.nullable(),
  intentSha256: digest.nullable(),
  incidentId: id.nullable(),
  nextBoundaryAt: time.nullable(),
};
export const inventoryEquipmentIncidentActionPreviewSnapshotSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...previewFacts,
      kind: z.literal('ready'),
      record: actionSummary,
      effectCounts: counts,
      commands: z.array(structural(parseInventoryCommand)).max(256).readonly(),
      planDigest: digest,
    })
    .strict(),
  z
    .object({
      ...previewFacts,
      kind: z.literal('no-change'),
      record: actionSummary,
      current,
      commands: z.tuple([]).readonly(),
      planDigest: z.null(),
    })
    .strict(),
  z
    .object({
      ...previewFacts,
      kind: z.literal('blocked'),
      record: z.null(),
      commands: z.tuple([]).readonly(),
      planDigest: z.null(),
      issues: z
        .array(
          z.object({ code: text(256), pointer: z.string().max(4096), message: text(4096) }).strict()
        )
        .min(1)
        .readonly(),
    })
    .strict(),
]);
const filters = z
  .object({ equipmentId: id.nullable(), status: z.enum(['open', 'resolved']).nullable() })
  .strict();
export const inventoryEquipmentIncidentsReadSchema = z.union([
  unavailable,
  z.object({ ...header, kind: z.literal('inventory-absent'), filters }).strict(),
  z
    .object({
      ...header,
      kind: z.literal('ready'),
      filters,
      incidents: z
        .array(z.object({ incident: summary, current }).strict())
        .max(50)
        .readonly(),
      nextCursor: inventoryEquipmentIncidentCursorSchema.nullable(),
    })
    .strict(),
]);
export const inventoryEquipmentIncidentReadSchema = z.union([
  unavailable,
  z.object({ ...header, kind: z.literal('available'), incident: summary, current }).strict(),
]);
export const inventoryEquipmentIncidentSubjectsReadSchema = z.union([
  unavailable,
  z
    .object({
      ...header,
      kind: z.literal('ready'),
      incident: pin,
      view: z.enum(['initial', 'current', 'review']),
      freshnessMaxAgeMs: time.nullable(),
      subjects: z
        .array(structural(parseInventoryEquipmentIncidentSubjectProjection))
        .max(50)
        .readonly(),
      nextCursor: inventoryEquipmentIncidentSubjectCursorSchema.nullable(),
      nextBoundaryAt: time.nullable(),
    })
    .strict(),
]);
export const inventoryEquipmentIncidentFactsReadSchema = z.union([
  unavailable,
  z
    .object({
      ...header,
      kind: z.literal('ready'),
      incident: pin,
      query: z
        .object({
          kind: z.literal('page'),
          factKind: factKind.nullable(),
          freshnessMaxAgeMs: time.nullable(),
        })
        .strict(),
      facts: z.array(structural(parseInventoryEquipmentIncidentFactSummary)).max(50).readonly(),
      nextCursor: inventoryEquipmentIncidentFactCursorSchema.nullable(),
      nextBoundaryAt: time.nullable(),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal('available'),
      incident: pin,
      fact,
      manual: structural(parseInventoryEquipmentIncidentManualFactProjection).nullable(),
      freshnessMaxAgeMs: time.nullable(),
      nextBoundaryAt: time.nullable(),
    })
    .strict(),
]);
export type InventoryPreviewEquipmentIncidentActionRequest = z.infer<
  typeof inventoryPreviewEquipmentIncidentActionRequestSchema
>;
export type InventoryApplyEquipmentIncidentActionRequest = z.infer<
  typeof inventoryApplyEquipmentIncidentActionRequestSchema
>;
export type InventoryEquipmentIncidentsRequest = z.infer<
  typeof inventoryEquipmentIncidentsRequestSchema
>;
export type InventoryEquipmentIncidentRequest = z.infer<
  typeof inventoryEquipmentIncidentRequestSchema
>;
export type InventoryEquipmentIncidentSubjectsRequest = z.infer<
  typeof inventoryEquipmentIncidentSubjectsRequestSchema
>;
export type InventoryEquipmentIncidentFactsRequest = z.infer<
  typeof inventoryEquipmentIncidentFactsRequestSchema
>;
export type InventoryEquipmentIncidentActionPreviewSnapshot = z.infer<
  typeof inventoryEquipmentIncidentActionPreviewSnapshotSchema
>;
export type InventoryEquipmentIncidentsRead = z.infer<typeof inventoryEquipmentIncidentsReadSchema>;
export type InventoryEquipmentIncidentRead = z.infer<typeof inventoryEquipmentIncidentReadSchema>;
export type InventoryEquipmentIncidentSubjectsRead = z.infer<
  typeof inventoryEquipmentIncidentSubjectsReadSchema
>;
export type InventoryEquipmentIncidentFactsRead = z.infer<
  typeof inventoryEquipmentIncidentFactsReadSchema
>;
