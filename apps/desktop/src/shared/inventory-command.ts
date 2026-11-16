import { z } from 'zod';
import { INVENTORY_LABEL_MEDIA_PROFILE_IDS } from '@waypoint/domain-services/inventory-label-types';
import {
  MAX_INVENTORY_BATCH_COMMANDS,
  parseInventoryCommandBatch,
  type InventoryCommandBatch,
  type InventoryTableChoices,
  type InventoryResolvedTableOptions,
  type InventoryStocktakeChoices,
  type InventoryHierarchyChoices,
  type InventoryMappedTableChoices,
  type InventoryResolvedMappedTableOptions,
  type InventoryImportOptions,
  type InventoryResolvedImportOptions,
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  type InventoryReceiveTableColumn,
  type InventorySourceRevisionChoices,
  type InventoryResolvedSourceRevisionOptions,
} from '@waypoint/domain-services';

const identity = z.string().min(1).max(256);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const profileKey = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value) => value as `sha256:${string}`);

export const inventoryPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-profile'), profileKey }).strict(),
  z.object({ kind: z.literal('agent'), identityId: z.string().min(1).max(500) }).strict(),
]);

export const inventoryReceiptContextSchema = z
  .object({
    version: z.literal(1),
    principal: inventoryPrincipalSchema,
    authority: z.object({ kind: z.literal('local-profile'), profileKey }).strict(),
  })
  .strict();

export const inventoryReadRequestSchema = z
  .object({ project: z.string().min(1).max(4096), inventoryId: identity })
  .strict();

export const inventoryImportBindingSchema = z
  .object({ sourceMaterialId: identity, destinationMaterialId: identity })
  .strict();
export const inventoryResolvedImportBindingSchema = inventoryImportBindingSchema
  .extend({ fingerprint: digest })
  .strict();
export const inventoryExportSnapshotRequestSchema = inventoryReadRequestSchema
  .extend({ format: z.literal('native-v1') })
  .strict();
export const inventoryPreviewImportRequestSchema = inventoryReadRequestSchema
  .extend({
    sourceText: z.string().min(1),
    options: z.object({ bindings: z.array(inventoryImportBindingSchema) }).strict(),
  })
  .strict();
export const inventoryApplyImportRequestSchema = inventoryReadRequestSchema
  .extend({
    kind: z.literal('adopt-archive'),
    operationId: identity,
    expectedRevision: revision,
    sourceText: z.string().min(1),
    options: z.object({ bindings: z.array(inventoryResolvedImportBindingSchema) }).strict(),
    expectedPlanDigest: digest,
  })
  .strict();

const tableMaterial = z.object({ key: identity, materialId: identity }).strict();
const tableResolvedMaterial = tableMaterial.extend({ fingerprint: digest }).strict();
const tableOptions = {
  namespace: identity,
  delimiter: z.enum([',', '\t']),
  locations: z.array(
    z
      .object({
        key: identity,
        target: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('unplaced') }).strict(),
          z.object({ kind: z.literal('storage'), storageId: identity }).strict(),
        ]),
      })
      .strict()
  ),
  vessels: z.array(z.object({ key: identity, vesselId: identity }).strict()),
  skips: z.array(z.object({ sourceId: identity, reason: z.string().min(1).max(4096) }).strict()),
};
export const inventoryTableOptionsSchema = z
  .object({
    ...tableOptions,
    materials: z.array(tableMaterial),
  })
  .strict();
export const inventoryResolvedTableOptionsSchema = z
  .object({
    ...tableOptions,
    materials: z.array(tableResolvedMaterial),
  })
  .strict();
export const inventoryPreviewTableRequestSchema = inventoryReadRequestSchema
  .extend({
    format: z.literal('receive-v1'),
    sourceText: z.string().min(1),
    options: inventoryTableOptionsSchema,
  })
  .strict();
export const inventoryApplyTableRequestSchema = inventoryReadRequestSchema
  .extend({
    kind: z.literal('receive-table'),
    operationId: identity,
    expectedRevision: revision,
    sourceText: z.string().min(1),
    options: inventoryResolvedTableOptionsSchema,
    expectedPlanDigest: digest,
  })
  .strict();

export const inventoryStocktakeOptionsSchema = z
  .object({
    namespace: identity,
    delimiter: z.enum([',', '\t']),
    subjects: z.array(
      z
        .object({
          key: identity,
          subject: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('stock'), stockId: identity }).strict(),
            z
              .object({
                kind: z.literal('item'),
                item: z
                  .object({ kind: z.enum(['storage', 'vessel']), id: z.string().min(1).max(1024) })
                  .strict(),
              })
              .strict(),
          ]),
        })
        .strict()
    ),
    locations: z.array(
      z
        .object({
          key: identity,
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('root') }).strict(),
            z.object({ kind: z.literal('unplaced') }).strict(),
            z.object({ kind: z.literal('storage'), storageId: identity }).strict(),
            z.object({ kind: z.literal('stack-top'), stackId: identity }).strict(),
          ]),
        })
        .strict()
    ),
    decisions: z.array(
      z
        .object({
          observationId: identity,
          choice: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('record-only') }).strict(),
            z.object({ kind: z.literal('apply'), reason: z.string().min(1).max(4096) }).strict(),
            z.object({ kind: z.literal('skip'), reason: z.string().min(1).max(4096) }).strict(),
          ]),
        })
        .strict()
    ),
  })
  .strict();
export const inventoryPreviewStocktakeRequestSchema = inventoryReadRequestSchema
  .extend({
    format: z.literal('stocktake-v1'),
    sourceText: z.string().min(1),
    options: inventoryStocktakeOptionsSchema,
  })
  .strict();
export const inventoryApplyStocktakeRequestSchema = inventoryReadRequestSchema
  .extend({
    kind: z.literal('apply-stocktake'),
    operationId: identity,
    expectedRevision: revision,
    sourceText: z.string().min(1),
    options: inventoryStocktakeOptionsSchema,
    expectedPlanDigest: digest,
  })
  .strict();

const mappedMaterial = z.object({ sourceId: identity, materialId: identity }).strict();
const mappedOptions = {
  namespace: z.string().max(256),
  delimiter: z.enum([',', '\t']),
  columns: z
    .object({
      sourceId: z.string().max(256),
      plate: z.string().max(256),
      well: z.string().max(256),
    })
    .strict(),
  plates: z.array(
    z
      .object({
        sourcePlate: identity,
        storageId: identity,
        positions: z.array(
          z.object({ sourceWell: identity, position: z.string().min(1).max(512) }).strict()
        ),
      })
      .strict()
  ),
  quantity: z.object({ kind: z.literal('unknown'), reason: z.string().max(4096) }).strict(),
  qualities: z.array(
    z
      .object({
        sourceId: identity,
        quality: z.enum(['usable', 'quarantined']),
        reason: z.string().max(4096),
      })
      .strict()
  ),
  evidenceOnlyColumns: z.array(
    z.object({ column: identity, reason: z.string().max(4096) }).strict()
  ),
  skips: z.array(z.object({ sourceId: identity, reason: z.string().max(4096) }).strict()),
};
export const inventoryMappedTableOptionsSchema = z
  .object({ ...mappedOptions, materials: z.array(mappedMaterial) })
  .strict();
export const inventoryResolvedMappedTableOptionsSchema = z
  .object({
    ...mappedOptions,
    namespace: identity,
    columns: z.object({ sourceId: identity, plate: identity, well: identity }).strict(),
    materials: z.array(mappedMaterial.extend({ fingerprint: digest }).strict()),
    quantity: mappedOptions.quantity.extend({ reason: z.string().min(1).max(4096) }).strict(),
    qualities: z.array(
      z
        .object({
          sourceId: identity,
          quality: z.enum(['usable', 'quarantined']),
          reason: z.string().min(1).max(4096),
        })
        .strict()
    ),
    evidenceOnlyColumns: z.array(
      z.object({ column: identity, reason: z.string().min(1).max(4096) }).strict()
    ),
    skips: z.array(z.object({ sourceId: identity, reason: z.string().min(1).max(4096) }).strict()),
  })
  .strict();
export const inventoryPreviewMappedTableRequestSchema = inventoryReadRequestSchema
  .extend({
    format: z.literal('mapped-plate-v1'),
    sourceText: z.string().min(1),
    options: inventoryMappedTableOptionsSchema,
  })
  .strict();
export const inventoryApplyMappedTableRequestSchema = inventoryReadRequestSchema
  .extend({
    kind: z.literal('receive-mapped-table'),
    operationId: identity,
    expectedRevision: revision,
    sourceText: z.string().min(1),
    options: inventoryResolvedMappedTableOptionsSchema,
    expectedPlanDigest: digest,
  })
  .strict();

export const inventoryHierarchyOptionsSchema = z
  .object({
    namespace: identity,
    delimiter: z.enum([',', '\t']),
    parents: z.array(z.object({ key: identity, storageId: identity }).strict()),
    skips: z.array(z.object({ sourceId: identity, reason: z.string().max(4096) }).strict()),
  })
  .strict();
export const inventoryPreviewHierarchyRequestSchema = inventoryReadRequestSchema
  .extend({
    format: z.literal('hierarchy-v1'),
    sourceText: z.string().min(1),
    options: inventoryHierarchyOptionsSchema,
  })
  .strict();
export const inventoryApplyHierarchyRequestSchema = inventoryReadRequestSchema
  .extend({
    kind: z.literal('import-hierarchy'),
    operationId: identity,
    expectedRevision: revision,
    sourceText: z.string().min(1),
    options: inventoryHierarchyOptionsSchema
      .extend({
        skips: z.array(
          z.object({ sourceId: identity, reason: z.string().min(1).max(4096) }).strict()
        ),
      })
      .strict(),
    expectedPlanDigest: digest,
  })
  .strict();

const sourceRevisionAcknowledgement = z
  .object({
    sourceId: identity,
    expectedPreviousRowSha256: digest,
    reason: z.string().max(4096),
  })
  .strict();
const sourceRevisionPreimage = z
  .object({
    sourceId: identity,
    fields: z
      .object(
        Object.fromEntries(
          INVENTORY_RECEIVE_TABLE_COLUMNS.map((column) => [column, z.string()])
        ) as Record<InventoryReceiveTableColumn, z.ZodString>
      )
      .strict(),
  })
  .strict();
export const inventorySourceRevisionOptionsSchema = z
  .object({
    table: inventoryTableOptionsSchema,
    acknowledgements: z.array(sourceRevisionAcknowledgement),
  })
  .strict();
export const inventoryResolvedSourceRevisionOptionsSchema = inventorySourceRevisionOptionsSchema
  .extend({
    acknowledgements: z.array(
      sourceRevisionAcknowledgement.extend({ reason: z.string().min(1).max(4096) }).strict()
    ),
    preimages: z.array(sourceRevisionPreimage),
  })
  .strict();
export const inventoryPreviewSourceRevisionRequestSchema = inventoryReadRequestSchema
  .extend({
    format: z.literal('receive-v1'),
    sourceText: z.string().min(1),
    options: inventorySourceRevisionOptionsSchema,
  })
  .strict();
export const inventoryAcknowledgeSourceRequestSchema = inventoryReadRequestSchema
  .extend({
    kind: z.literal('acknowledge-table-source'),
    operationId: identity,
    expectedRevision: revision,
    sourceText: z.string().min(1),
    options: inventoryResolvedSourceRevisionOptionsSchema,
    expectedPlanDigest: digest,
  })
  .strict();

export const inventoryStorageConditionsRequestSchema = inventoryReadRequestSchema
  .extend({ freshnessMaxAgeMs: revision.nullable() })
  .strict();

export const inventoryCatalogUpdatePreviewRequestSchema = inventoryReadRequestSchema
  .extend({ catalogEntryId: identity })
  .strict();

export const inventoryResolveItemCodeRequestSchema = inventoryReadRequestSchema
  .extend({
    query: z.object({ namespace: z.string().nullable(), value: z.string() }).strict(),
  })
  .strict();

export const inventoryPrepareLabelRequestSchema = inventoryReadRequestSchema
  .extend({
    codeId: z.string().min(1).max(512),
    mediaProfileId: z.enum(INVENTORY_LABEL_MEDIA_PROFILE_IDS),
  })
  .strict();

export const inventoryExecuteRequestSchema = inventoryReadRequestSchema
  .extend({
    operationId: identity,
    expectedRevision: revision,
    commands: z.array(z.unknown()).min(1).max(MAX_INVENTORY_BATCH_COMMANDS),
  })
  .strict()
  .transform((input) => ({
    ...input,
    ...parseInventoryCommandBatch({
      expectedRevision: input.expectedRevision,
      commands: input.commands,
    }),
  }));

export const inventoryAcceptedRequestSchema = z.union([
  inventoryExecuteRequestSchema,
  inventoryApplyImportRequestSchema,
  inventoryApplyTableRequestSchema,
  inventoryApplyStocktakeRequestSchema,
  inventoryAcknowledgeSourceRequestSchema,
  inventoryApplyHierarchyRequestSchema,
  inventoryApplyMappedTableRequestSchema,
]);

export const inventoryOperationRequestSchema = inventoryReadRequestSchema
  .extend({ operationId: identity })
  .strict();

export const inventoryHistoryRequestSchema = inventoryReadRequestSchema
  .extend({
    afterRevision: revision.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const inventoryMaterialQuerySchema = z
  .object({
    project: z.string().min(1).max(4096),
    query: z.string().max(256),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const inventoryCatalogQuerySchema = inventoryMaterialQuerySchema.pick({ project: true });

export const inventoryReceiptSchema = z
  .object({
    status: z.literal('committed'),
    inventoryId: identity,
    operationId: identity,
    revision: revision.min(1),
    actor: z.string().min(1).max(1024),
    recordedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    context: inventoryReceiptContextSchema.optional(),
  })
  .strict();

export type InventoryReadRequest = z.infer<typeof inventoryReadRequestSchema>;
export type InventoryExportSnapshotRequest = z.infer<typeof inventoryExportSnapshotRequestSchema>;
export type InventoryPreviewImportRequest = InventoryReadRequest & {
  readonly sourceText: string;
  readonly options: InventoryImportOptions;
};
export type InventoryApplyImportRequest = InventoryReadRequest & {
  readonly kind: 'adopt-archive';
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly sourceText: string;
  readonly options: InventoryResolvedImportOptions;
  readonly expectedPlanDigest: string;
};
export type InventoryPreviewTableRequest = InventoryReadRequest & {
  readonly format: 'receive-v1';
  readonly sourceText: string;
  readonly options: InventoryTableChoices;
};
export type InventoryApplyTableRequest = InventoryReadRequest & {
  readonly kind: 'receive-table';
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly sourceText: string;
  readonly options: InventoryResolvedTableOptions;
  readonly expectedPlanDigest: `sha256:${string}`;
};
export type InventoryPreviewMappedTableRequest = InventoryReadRequest & {
  readonly format: 'mapped-plate-v1';
  readonly sourceText: string;
  readonly options: InventoryMappedTableChoices;
};
export type InventoryApplyMappedTableRequest = InventoryReadRequest & {
  readonly kind: 'receive-mapped-table';
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly sourceText: string;
  readonly options: InventoryResolvedMappedTableOptions;
  readonly expectedPlanDigest: `sha256:${string}`;
};
export type InventoryPreviewHierarchyRequest = InventoryReadRequest & {
  readonly format: 'hierarchy-v1';
  readonly sourceText: string;
  readonly options: InventoryHierarchyChoices;
};
export type InventoryApplyHierarchyRequest = InventoryReadRequest & {
  readonly kind: 'import-hierarchy';
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly sourceText: string;
  readonly options: InventoryHierarchyChoices;
  readonly expectedPlanDigest: `sha256:${string}`;
};
export type InventoryPreviewStocktakeRequest = InventoryReadRequest & {
  readonly format: 'stocktake-v1';
  readonly sourceText: string;
  readonly options: InventoryStocktakeChoices;
};
export type InventoryApplyStocktakeRequest = InventoryReadRequest & {
  readonly kind: 'apply-stocktake';
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly sourceText: string;
  readonly options: InventoryStocktakeChoices;
  readonly expectedPlanDigest: `sha256:${string}`;
};
export type InventoryPreviewSourceRevisionRequest = InventoryReadRequest & {
  readonly format: 'receive-v1';
  readonly sourceText: string;
  readonly options: InventorySourceRevisionChoices;
};
export type InventoryAcknowledgeSourceRequest = InventoryReadRequest & {
  readonly kind: 'acknowledge-table-source';
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly sourceText: string;
  readonly options: InventoryResolvedSourceRevisionOptions;
  readonly expectedPlanDigest: `sha256:${string}`;
};
export type InventoryAcceptedRequest =
  | InventoryExecuteRequest
  | InventoryApplyImportRequest
  | InventoryApplyTableRequest
  | InventoryApplyStocktakeRequest
  | InventoryAcknowledgeSourceRequest
  | InventoryApplyHierarchyRequest
  | InventoryApplyMappedTableRequest;
export type InventoryStorageConditionsRequest = z.infer<
  typeof inventoryStorageConditionsRequestSchema
>;
export type InventoryResolveItemCodeRequest = z.infer<typeof inventoryResolveItemCodeRequestSchema>;
export type InventoryPrepareLabelRequest = z.infer<typeof inventoryPrepareLabelRequestSchema>;
export type InventoryCatalogUpdatePreviewRequest = z.infer<
  typeof inventoryCatalogUpdatePreviewRequestSchema
>;
export type InventoryExecuteRequest = InventoryReadRequest &
  InventoryCommandBatch & { readonly operationId: string };
export type InventoryOperationRequest = z.infer<typeof inventoryOperationRequestSchema>;
export type InventoryHistoryRequest = z.infer<typeof inventoryHistoryRequestSchema>;
export type NativeInventoryReceipt = z.infer<typeof inventoryReceiptSchema>;
export type NativeInventoryReceiptContext = z.infer<typeof inventoryReceiptContextSchema>;
export interface NativeInventoryRejection {
  readonly status: 'rejected';
  readonly inventoryId: string;
  readonly operationId: string;
  readonly code: string;
  readonly message: string;
  readonly currentRevision?: number;
}
export type NativeInventoryExecution = NativeInventoryReceipt | NativeInventoryRejection;
export interface NativeInventoryHistoryEntry {
  readonly request: InventoryAcceptedRequest;
  readonly receipt: NativeInventoryReceipt;
}
