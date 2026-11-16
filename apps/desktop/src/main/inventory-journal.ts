import { createHash } from 'node:crypto';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTransition,
} from '@waypoint/domain-services';
import {
  inventoryAcceptedRequestSchema,
  inventoryReceiptSchema,
  type InventoryAcceptedRequest,
  type InventoryApplyImportRequest,
  type InventoryApplyTableRequest,
  type InventoryApplyStocktakeRequest,
  type InventoryApplyHierarchyRequest,
  type InventoryAcknowledgeSourceRequest,
  type NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import { canonicalNativeMutationRequest } from './native-mutation-request';

export interface NativeInventoryJournalRow {
  readonly inventory_id: string;
  readonly operation_id: string;
  readonly revision: number;
  readonly request_json: string;
  readonly receipt_json: string;
}

export function nativeInventoryRequestDigest(request: InventoryAcceptedRequest): string {
  return `sha256:${createHash('sha256').update(canonicalNativeMutationRequest(request)).digest('hex')}`;
}

export function parseNativeInventoryJournalEntry(
  row: Pick<NativeInventoryJournalRow, 'inventory_id' | 'operation_id' | 'revision'>,
  project: string,
  input: { readonly request: unknown; readonly receipt: unknown }
): NativeInventoryHistoryEntry {
  const request = inventoryAcceptedRequestSchema.parse(input.request);
  const receipt = inventoryReceiptSchema.parse(input.receipt);
  if (
    request.project !== project ||
    request.inventoryId !== row.inventory_id ||
    request.operationId !== row.operation_id ||
    request.expectedRevision + 1 !== row.revision ||
    receipt.inventoryId !== row.inventory_id ||
    receipt.operationId !== row.operation_id ||
    receipt.revision !== row.revision ||
    receipt.requestDigest !== nativeInventoryRequestDigest(request)
  )
    throw new Error('INVENTORY_DATA_INVALID: The saved inventory journal could not be verified.');
  return { request, receipt };
}

export function replayNativeInventoryEntries(
  entries: readonly NativeInventoryHistoryEntry[],
  adoption: (
    target: InventoryState | null,
    request: InventoryApplyImportRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition,
  table: (
    target: InventoryState | null,
    request: InventoryApplyTableRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition,
  stocktake: (
    target: InventoryState | null,
    request: InventoryApplyStocktakeRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition,
  hierarchy: (
    target: InventoryState | null,
    request: InventoryApplyHierarchyRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition,
  sourceRevision: (
    target: InventoryState | null,
    request: InventoryAcknowledgeSourceRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition
): InventoryState {
  let state = createInventoryState();
  for (const entry of entries) {
    const context = entry.receipt.context
      ? {
          at: entry.receipt.recordedAt,
          principal: entry.receipt.context.principal,
          authority: entry.receipt.context.authority,
        }
      : undefined;
    const request = entry.request;
    if (request.expectedRevision !== state.revision)
      throw new Error('INVENTORY_DATA_INVALID: The saved inventory journal is not contiguous.');
    let result: InventoryTransition;
    if ('kind' in request && request.kind === 'adopt-archive') {
      if (!context)
        throw new Error('INVENTORY_DATA_INVALID: An adoption requires its native receipt context.');
      result = adoption(state.revision === 0 ? null : state, request, context);
    } else if ('kind' in request && request.kind === 'receive-table') {
      if (!context)
        throw new Error(
          'INVENTORY_DATA_INVALID: A table import requires its native receipt context.'
        );
      result = table(state.revision === 0 ? null : state, request, context);
    } else if ('kind' in request && request.kind === 'apply-stocktake') {
      if (!context)
        throw new Error('INVENTORY_DATA_INVALID: A stocktake requires its native receipt context.');
      result = stocktake(state.revision === 0 ? null : state, request, context);
    } else if ('kind' in request && request.kind === 'import-hierarchy') {
      if (!context)
        throw new Error(
          'INVENTORY_DATA_INVALID: A hierarchy import requires its native receipt context.'
        );
      result = hierarchy(state.revision === 0 ? null : state, request, context);
    } else if ('kind' in request && request.kind === 'acknowledge-table-source') {
      if (!context)
        throw new Error(
          'INVENTORY_DATA_INVALID: A source acknowledgement requires its native receipt context.'
        );
      result = sourceRevision(state.revision === 0 ? null : state, request, context);
    } else {
      result = applyInventoryCommandBatch(
        state,
        { expectedRevision: request.expectedRevision, commands: request.commands },
        context
      );
    }
    if (!result.ok)
      throw new Error('INVENTORY_DATA_INVALID: The saved inventory journal could not be replayed.');
    state = result.state;
  }
  return state;
}
