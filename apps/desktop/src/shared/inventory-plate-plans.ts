import { z } from 'zod';
import {
  parseInventoryPlatePlanDefinition,
  normalizeInventoryAmount,
  parseInventoryPlatePlanVolume,
  inventoryPlatePlanText,
  inventoryPlatePlanVersionId,
  inventoryTableSha256,
  parseInventoryPlatePlanVersion,
  parseInventoryRecordedPrincipal,
  parseInventoryStock,
  parseInventoryVessel,
  parseInventoryStorage,
  type InventoryErrorCode,
  type InventoryTableSha256,
} from '@waypoint/domain-services';
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
const identity = z.object({ namespace: text(1024), planId: text(1024) }).strict();
const layout = z
  .object({
    kind: z.literal('fixed-well'),
    rows: z.number().int().min(1).max(10000),
    columns: z.number().int().min(1).max(10000),
  })
  .strict()
  .refine((value) => value.rows * value.columns <= 10000);
function volume(positive: boolean) {
  return z
    .object({ value: z.string().min(1).max(128), unit: z.literal('uL') })
    .strict()
    .refine((value) => {
      try {
        parseInventoryPlatePlanVolume(value, positive);
        return true;
      } catch {
        return false;
      }
    });
}
const positiveVolume = volume(true),
  balance = volume(false);
export const inventoryPlatePlanDefinitionSchema = z
  .object({
    schema: z.literal('dnaforge.inventory-plate-plan-definition.v1'),
    title: text(200),
    layout,
    sourceSlots: z
      .array(z.object({ key: id, label: text(200) }).strict())
      .min(1)
      .max(256)
      .readonly(),
    transfers: z
      .array(
        z
          .object({
            actionId: id,
            sourceSlotKey: id,
            destinationPosition: id,
            quantity: positiveVolume,
            label: text(200),
          })
          .strict()
      )
      .min(1)
      .max(256)
      .readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      parseInventoryPlatePlanDefinition(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid canonical plan definition.',
      });
    }
  });
export const inventoryPlatePlanVersionChoicesSchema = z
  .object({ identity, definition: inventoryPlatePlanDefinitionSchema, reason: text(2000) })
  .strict();
const scope = z.object({ project: text(4096), inventoryId: text(256) }).strict();
export const inventoryPreviewPlatePlanVersionRequestSchema = scope
  .extend({ expectedRevision: time, choices: inventoryPlatePlanVersionChoicesSchema })
  .strict();
export const inventoryApplyPlatePlanVersionRequestSchema =
  inventoryPreviewPlatePlanVersionRequestSchema
    .extend({
      kind: z.literal('save-plate-plan-version'),
      operationId: text(256),
      expectedPlanDigest: digest,
    })
    .strict();
export const inventoryPlatePlanVersionCursorSchema = z
  .object({
    querySha256: digest,
    revision: time,
    after: z
      .object({ at: time, versionId: z.string().regex(/^plate-plan-version:[a-f0-9]{64}$/) })
      .strict(),
  })
  .strict();
export const inventoryPlatePlanVersionsRequestSchema = scope
  .extend({
    identity: identity.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryPlatePlanVersionCursorSchema.optional(),
  })
  .strict();
export const inventoryPlatePlanVersionRequestSchema = scope
  .extend({ versionId: id, definitionSha256: digest })
  .strict();
export const inventoryPlatePlanBindingSchema = z
  .object({
    versionId: id,
    definitionSha256: digest,
    destinationPlateId: id,
    sources: z
      .array(z.object({ sourceSlotKey: id, stockId: id }).strict())
      .min(1)
      .max(256)
      .readonly(),
  })
  .strict();
export const inventoryPreviewPlatePlanBindingRequestSchema = scope
  .extend({ expectedRevision: time, binding: inventoryPlatePlanBindingSchema })
  .strict();
export type InventoryPreviewPlatePlanVersionRequest = z.infer<
  typeof inventoryPreviewPlatePlanVersionRequestSchema
>;
export type InventoryApplyPlatePlanVersionRequest = z.infer<
  typeof inventoryApplyPlatePlanVersionRequestSchema
>;
export type InventoryPlatePlanVersionsRequest = z.infer<
  typeof inventoryPlatePlanVersionsRequestSchema
>;
export type InventoryPlatePlanVersionRequest = z.infer<
  typeof inventoryPlatePlanVersionRequestSchema
>;
export type InventoryPreviewPlatePlanBindingRequest = z.infer<
  typeof inventoryPreviewPlatePlanBindingRequestSchema
>;
export type InventoryPlatePlanVersionCursor = z.infer<typeof inventoryPlatePlanVersionCursorSchema>;
function structural<T>(parse: (value: unknown) => T) {
  return z.unknown().transform((value, context) => {
    try {
      return parse(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid inventory record.',
      });
      return z.NEVER;
    }
  });
}
const version = structural(parseInventoryPlatePlanVersion),
  recorded = structural(parseInventoryRecordedPrincipal),
  stock = structural(parseInventoryStock),
  vessel = structural(parseInventoryVessel),
  storage = structural(parseInventoryStorage);
const principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-profile'), profileKey: text(512) }).strict(),
  z.object({ kind: z.literal('agent'), identityId: text(512) }).strict(),
]);
const target = z
  .object({ projectId: id, inventoryId: text(256), present: z.boolean(), revision: time })
  .strict();
const snapshot = { projectId: id, inventoryId: text(256), revision: time, asOf: time, principal };
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
const versionFacts = {
  ...snapshot,
  schema: z.literal('dnaforge.inventory-plate-plan-version-preview.v1'),
  target,
  versionId: id.nullable(),
  definitionSha256: digest.nullable(),
};
export const inventoryPlatePlanVersionPreviewSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ ...versionFacts, kind: z.literal('ready'), version, planDigest: digest }).strict(),
  z.object({ ...versionFacts, kind: z.literal('no-change'), version }).strict(),
  z.object({ ...versionFacts, kind: z.literal('blocked'), issues }).strict(),
]);
const summary = z
  .object({
    id,
    identity,
    definitionSha256: digest,
    title: text(200),
    layout,
    sourceSlotCount: z.number().int().min(1).max(256),
    transferCount: z.number().int().min(1).max(256),
    at: time,
    by: recorded,
    reason: text(2000),
  })
  .strict();
const unavailable = {
  kind: z.literal('unavailable'),
  code: text(256),
  message: text(4096),
  retryable: z.boolean(),
};
export const inventoryPlatePlanVersionsReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('ready'),
        projectId: id,
        inventoryId: text(256),
        revision: time,
        identity: identity.nullable(),
        versions: z.array(summary).max(50),
        nextCursor: inventoryPlatePlanVersionCursorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('inventory-absent'),
        projectId: id,
        inventoryId: text(256),
        identity: identity.nullable(),
      })
      .strict(),
    z.object(unavailable).strict(),
  ])
  .transform((value, context) => {
    if (value.kind !== 'ready') return value;
    const seen = new Set<string>();
    value.versions.forEach((row, index) => {
      const prior = value.versions[index - 1];
      if (
        seen.has(row.id) ||
        inventoryPlatePlanVersionId(row.identity, row.definitionSha256) !== row.id ||
        (value.identity &&
          (row.identity.namespace !== value.identity.namespace ||
            row.identity.planId !== value.identity.planId)) ||
        (prior && (prior.at > row.at || (prior.at === row.at && prior.id >= row.id)))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Plan-version page identity, order or filter is invalid.',
        });
      seen.add(row.id);
    });
    if (value.nextCursor) {
      const last = value.versions.at(-1);
      if (
        !last ||
        value.nextCursor.revision !== value.revision ||
        value.nextCursor.after.versionId !== last.id ||
        value.nextCursor.after.at !== last.at
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Plan-version continuation is invalid.',
        });
    }
    return value;
  });
const diagram = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rendered'),
      artifact: z
        .object({
          versionId: id,
          definitionSha256: digest,
          mediaType: z.literal('image/svg+xml'),
          fileName: text(256),
          svg: z
            .string()
            .min(1)
            .max(17 * 1024 * 1024),
          sha256: digest,
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('refused'), code: text(256), message: text(4096) }).strict(),
]);
export const inventoryPlatePlanVersionReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('available'),
        projectId: id,
        inventoryId: text(256),
        revision: time,
        version,
        diagram,
      })
      .strict(),
    z.object(unavailable).strict(),
  ])
  .transform((value, context) => {
    if (value.kind === 'available' && value.diagram.kind === 'rendered') {
      const artifact = value.diagram.artifact;
      if (
        artifact.versionId !== value.version.id ||
        artifact.definitionSha256 !== value.version.definitionSha256 ||
        artifact.sha256 !== inventoryTableSha256(artifact.svg) ||
        artifact.fileName !==
          `plate-plan-${value.version.id.slice('plate-plan-version:'.length)}.svg`
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The diagram does not match its exact saved version and SVG bytes.',
        });
    }
    return value;
  });
const sourceReference = z
  .object({
    url: z.string(),
    title: z.string(),
    locator: z.string(),
    readAt: z.string(),
    documentRevision: z.string().nullable(),
    sha256: z.string().nullable(),
  })
  .strict();
const openingState = z.union([
  z.object({ kind: z.literal('unobserved'), observationId: z.null() }).strict(),
  z
    .object({
      kind: z.enum(['unobserved', 'sealed-observed', 'opened-observed']),
      observationId: id,
    })
    .strict(),
]);
const openingFacts = {
  id,
  stockId: id,
  source: sourceReference.nullable(),
  reason: text(2000),
  at: time,
  by: recorded,
};
const openingObservation = z.union([
  z
    .object({
      ...openingFacts,
      kind: z.literal('initial'),
      value: z.enum(['sealed', 'opened']),
      observedAt: time.nullable(),
      supersedesId: z.null(),
    })
    .strict(),
  z
    .object({
      ...openingFacts,
      kind: z.enum(['opening', 'correction']),
      value: z.literal('opened'),
      observedAt: time.nullable(),
      supersedesId: id,
    })
    .strict(),
  z
    .object({
      ...openingFacts,
      kind: z.literal('correction'),
      value: z.literal('unobserved'),
      observedAt: z.null(),
      supersedesId: id,
    })
    .strict(),
]);
const validityReference = { rootId: id, headId: id };
const validityBlockerOptions = [
  z
    .object({
      ...validityReference,
      code: z.enum(['VALIDITY_UNRESOLVED', 'VALIDITY_ASSESSMENT_IMPORTED']),
    })
    .strict(),
  z
    .object({ ...validityReference, code: z.literal('MATERIAL_EXPIRED'), deadlineAt: time })
    .strict(),
  z
    .object({ ...validityReference, code: z.literal('OPENING_REQUIRED'), openingStockId: id })
    .strict(),
  z
    .object({
      ...validityReference,
      code: z.literal('OPENING_TIME_UNKNOWN'),
      openingStockId: id,
      observationId: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...validityReference,
      code: z.literal('VALIDITY_CHRONOLOGY_CONFLICT'),
      openingStockId: id,
      observationId: id.nullable(),
      openingNoLaterThan: time,
    })
    .strict(),
] as const;
const validityBlocker = z.discriminatedUnion('code', validityBlockerOptions);
const validityAdmission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allowed') }).strict(),
  z
    .object({
      kind: z.literal('blocked'),
      blockers: z.array(validityBlocker).nonempty().readonly(),
    })
    .strict(),
]);
const validityOwner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lot'), lotId: id }).strict(),
  z.object({ kind: z.literal('stock'), stockId: id }).strict(),
]);
const validityRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unresolved') }).strict(),
  z.object({ kind: z.literal('not-required') }).strict(),
  z.object({ kind: z.literal('absolute'), deadlineAt: time }).strict(),
  z.object({ kind: z.literal('after-opening'), openingStockId: id, elapsedMs: time }).strict(),
]);
const validity = z
  .object({
    asOf: time,
    coverage: z.enum(['legacy-untracked', 'managed', 'mixed']),
    state: z.enum(['legacy-untracked', 'current', 'expired', 'unresolved']),
    effectiveDeadlineAt: time.nullable(),
    nextBoundaryAt: time.nullable(),
    reserve: validityAdmission,
    withdraw: validityAdmission,
    families: z
      .array(
        z
          .object({
            ...validityReference,
            owner: validityOwner,
            rule: validityRule,
            authority: z.enum(['local', 'imported']),
            state: z.enum(['not-required', 'awaiting-opening', 'current', 'expired', 'unresolved']),
            deadlineAt: time.nullable(),
            openingNoLaterThan: time.nullable(),
            opening: z
              .object({
                stockId: id,
                state: openingState,
                observation: openingObservation.nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict()
      )
      .readonly(),
  })
  .strict();
const physicalItem = z.object({ kind: z.enum(['storage', 'vessel']), id }).strict();
const blocker = z.discriminatedUnion('code', [
  ...validityBlockerOptions,
  z
    .object({
      code: z.literal('LOT_NOT_RELEASED'),
      lotId: id,
      assessment: z.enum(['unassessed', 'quarantined', 'rejected']),
    })
    .strict(),
  z.object({ code: z.literal('LOT_ASSESSMENT_IMPORTED'), lotId: id }).strict(),
  z
    .object({ code: z.literal('LOT_RECALLED'), lotId: id, recallIds: z.array(id).readonly() })
    .strict(),
  z.object({ code: z.literal('POSITION_UNAVAILABLE'), item: physicalItem }).strict(),
  z.object({ code: z.literal('ITEM_CHECKED_OUT'), item: physicalItem, holder: recorded }).strict(),
  z.object({ code: z.literal('ITEM_IN_TRANSIT'), item: physicalItem }).strict(),
  z.object({ code: z.literal('ITEM_MISSING'), item: physicalItem }).strict(),
  z
    .object({
      code: z.enum([
        'QUANTITY_UNKNOWN',
        'STOCK_QUARANTINED',
        'VESSEL_DISPOSED',
        'ALLOCATION_SHORTFALL',
        'EXPIRY_PENDING',
      ]),
    })
    .strict(),
  z.object({ code: z.literal('ITEM_RESERVED'), reservationIds: z.array(id).readonly() }).strict(),
  z
    .object({ code: z.literal('INCIDENT_REVIEW_REQUIRED'), rootIds: z.array(id).readonly() })
    .strict(),
]);
const admission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allowed') }).strict(),
  z
    .object({ kind: z.literal('blocked'), blockers: z.array(blocker).nonempty().readonly() })
    .strict(),
]);
const amountShape = z
  .object({ value: z.string(), unit: z.enum(['uL', 'ng', 'nmol', 'item']) })
  .strict();
const canonicalAmount = (value: { value: string; unit: 'uL' | 'ng' | 'nmol' | 'item' }) => {
  try {
    const normalized = normalizeInventoryAmount(value);
    return normalized.value === value.value && normalized.unit === value.unit;
  } catch {
    return false;
  }
};
const amount = amountShape.refine(canonicalAmount);
const quantity = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('unknown'), unit: z.enum(['uL', 'ng', 'nmol', 'item']) }).strict(),
    amountShape.extend({ kind: z.literal('known') }).strict(),
  ])
  .refine((value) => value.kind === 'unknown' || canonicalAmount(value));
const volumeQuantity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z
    .object({
      kind: z.literal('known'),
      value: z
        .string()
        .min(1)
        .max(128)
        .refine((value) => {
          try {
            normalizeInventoryAmount({ value, unit: 'uL' });
            return true;
          } catch {
            return false;
          }
        }),
      unit: z.enum(['L', 'mL', 'uL', 'nL']),
    })
    .strict(),
]);
const availability = z
  .object({
    validity,
    actions: z.object({ reserve: admission, withdraw: admission }).strict(),
    stockId: id,
    onHand: quantity,
    held: amount,
    unreserved: quantity,
    mine: amount,
    deadVolume: volumeQuantity,
    blockers: z.array(blocker).readonly(),
    reservationIds: z.array(id).readonly(),
  })
  .strict();
const demandFacts = {
  sourceSlotKeys: z.array(id).min(1).max(256).readonly(),
  stock,
  vessel,
  availability,
  demand: positiveVolume,
};
const bindingFacts = {
  ...snapshot,
  schema: z.literal('dnaforge.inventory-plate-plan-binding-preview.v1'),
  target,
  versionId: id,
  definitionSha256: digest,
  bindingSha256: digest.nullable(),
  nextBoundaryAt: time.nullable(),
};
export const inventoryPlatePlanBindingPreviewSnapshotSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...bindingFacts,
      kind: z.literal('ready'),
      binding: inventoryPlatePlanBindingSchema,
      plate: storage,
      sources: z
        .array(z.object({ ...demandFacts, projectedRemaining: balance }).strict())
        .min(1)
        .max(256)
        .readonly(),
      destinations: z
        .array(
          z
            .object({
              actionId: id,
              ordinal: z.number().int().min(1).max(256),
              position: id,
              vesselId: id,
            })
            .strict()
        )
        .max(256)
        .readonly(),
    })
    .strict(),
  z
    .object({
      ...bindingFacts,
      kind: z.literal('blocked'),
      issues,
      sources: z.array(z.object(demandFacts).strict()).max(256).readonly(),
      binding: inventoryPlatePlanBindingSchema.nullable(),
    })
    .strict(),
  z.object(unavailable).strict(),
]);
export type InventoryPlatePlanVersionPreviewSnapshot = z.infer<
  typeof inventoryPlatePlanVersionPreviewSnapshotSchema
>;
export type InventoryPlatePlanVersionsRead = z.infer<typeof inventoryPlatePlanVersionsReadSchema>;
export type InventoryPlatePlanVersionRead = z.infer<typeof inventoryPlatePlanVersionReadSchema>;
export type InventoryPlatePlanBindingPreviewSnapshot = z.infer<
  typeof inventoryPlatePlanBindingPreviewSnapshotSchema
>;
