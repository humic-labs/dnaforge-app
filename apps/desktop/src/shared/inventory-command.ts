import { z } from 'zod';
import {
  MAX_INVENTORY_BATCH_COMMANDS,
  parseInventoryCommandBatch,
  type InventoryCommandBatch,
} from '@waypoint/domain-services';

const identity = z.string().min(1).max(256);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const inventoryReadRequestSchema = z
  .object({ project: z.string().min(1).max(4096), inventoryId: identity })
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

export const inventoryReceiptSchema = z
  .object({
    status: z.literal('committed'),
    inventoryId: identity,
    operationId: identity,
    revision: revision.min(1),
    actor: z.string().min(1).max(1024),
    recordedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export type InventoryReadRequest = z.infer<typeof inventoryReadRequestSchema>;
export type InventoryExecuteRequest = InventoryReadRequest &
  InventoryCommandBatch & { readonly operationId: string };
export type InventoryOperationRequest = z.infer<typeof inventoryOperationRequestSchema>;
export type InventoryHistoryRequest = z.infer<typeof inventoryHistoryRequestSchema>;
export type NativeInventoryReceipt = z.infer<typeof inventoryReceiptSchema>;
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
  readonly request: InventoryExecuteRequest;
  readonly receipt: NativeInventoryReceipt;
}
