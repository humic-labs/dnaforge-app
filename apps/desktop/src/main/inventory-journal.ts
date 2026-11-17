import { createHash } from 'node:crypto';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  projectLegacyInventoryLotConstraints,
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
  type InventoryApplyMappedTableRequest,
  type InventoryApplyBenchlingCaptureRequest,
  type InventoryApplyArrivalRequest,
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
    context: InventoryExecutionContext,
    receiptContextVersion: 1 | 2 | 3 | 4 | 5 | undefined
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
  ) => InventoryTransition,
  mappedTable: (
    target: InventoryState | null,
    request: InventoryApplyMappedTableRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition,
  benchlingCapture: (
    target: InventoryState | null,
    request: InventoryApplyBenchlingCaptureRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition,
  arrival?: (
    target: InventoryState | null,
    request: InventoryApplyArrivalRequest,
    context: InventoryExecutionContext
  ) => InventoryTransition
): InventoryState {
  let state = createInventoryState();
  let highestContextVersion = 1;
  for (const entry of entries) {
    const contextVersion = entry.receipt.context?.version ?? 1;
    const cumulativeLotSemantics = contextVersion >= 2;
    if (contextVersion < highestContextVersion)
      throw new Error(
        'INVENTORY_DATA_INVALID: Inventory receipt semantics cannot return to the legacy version.'
      );
    highestContextVersion = contextVersion;
    const context = entry.receipt.context
      ? {
          at: entry.receipt.recordedAt,
          principal: entry.receipt.context.principal,
          authority: entry.receipt.context.authority,
        }
      : undefined;
    const request = entry.request;
    if (
      !cumulativeLotSemantics &&
      !('kind' in request) &&
      request.commands.some((command) =>
        ['manage-lot', 'assess-lot', 'record-lot-recall', 'withdraw-lot-recall'].includes(
          command.kind
        )
      )
    )
      throw new Error('INVENTORY_DATA_INVALID: Lot controls require current receipt semantics.');
    if (
      contextVersion < 3 &&
      !('kind' in request) &&
      request.commands.some((command) =>
        [
          'record-stock-opening',
          'correct-stock-opening',
          'record-validity-decision',
          'correct-validity-decision',
        ].includes(command.kind)
      )
    )
      throw new Error('INVENTORY_DATA_INVALID: Opening and validity require V3 receipt semantics.');
    if (
      contextVersion < 5 &&
      !('kind' in request) &&
      request.commands.some((command) =>
        [
          'record-expected-delivery',
          'allocate-arrival',
          'withdraw-arrival-allocation',
          'close-expected-delivery-remainder',
          'reopen-expected-delivery',
          'record-reorder-rule',
          'retire-reorder-rule',
        ].includes(command.kind)
      )
    )
      throw new Error('INVENTORY_DATA_INVALID: Stockroom commands require V5 receipt semantics.');
    if (request.expectedRevision !== state.revision)
      throw new Error('INVENTORY_DATA_INVALID: The saved inventory journal is not contiguous.');
    let result: InventoryTransition;
    if ('kind' in request && request.kind === 'receive-arrival') {
      if (contextVersion < 4 || !context || !arrival)
        throw new Error(
          'INVENTORY_DATA_INVALID: Actual arrivals require V4 native receipt semantics.'
        );
      result = arrival(state.revision === 0 ? null : state, request, context);
    } else if ('kind' in request && request.kind === 'import-benchling-capture') {
      if (!context)
        throw new Error(
          'INVENTORY_DATA_INVALID: A physical capture import requires its native receipt context.'
        );
      result = benchlingCapture(state.revision === 0 ? null : state, request, context);
    } else if ('kind' in request && request.kind === 'adopt-archive') {
      if (!context)
        throw new Error('INVENTORY_DATA_INVALID: An adoption requires its native receipt context.');
      result = adoption(
        state.revision === 0 ? null : state,
        request,
        context,
        entry.receipt.context?.version
      );
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
    } else if ('kind' in request && request.kind === 'receive-mapped-table') {
      if (!context)
        throw new Error(
          'INVENTORY_DATA_INVALID: A mapped table import requires its native receipt context.'
        );
      result = mappedTable(state.revision === 0 ? null : state, request, context);
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
    if (
      !cumulativeLotSemantics &&
      (Object.values(result.state.lots).some((lot) => lot.controls.kind === 'managed') ||
        Object.keys(result.state.lotRecalls).length > 0)
    )
      throw new Error(
        'INVENTORY_DATA_INVALID: Lot controls cannot enter through legacy receipt semantics.'
      );
    if (
      contextVersion < 3 &&
      (Object.keys(result.state.openingObservations).length > 0 ||
        Object.keys(result.state.validityFacts).length > 0 ||
        Object.values(result.state.stocks).some(
          (stock) =>
            stock.opening.kind !== 'unobserved' ||
            stock.opening.observationId !== null ||
            stock.validity.kind !== 'legacy-untracked' ||
            stock.inheritedValidity.length > 0
        ) ||
        Object.values(result.state.lots).some(
          (lot) => lot.validity.kind !== 'legacy-untracked' || lot.inheritedValidity.length > 0
        ))
    )
      throw new Error(
        'INVENTORY_DATA_INVALID: Opening and validity cannot enter through pre-V3 receipt semantics.'
      );
    if (contextVersion < 4 && Object.keys(result.state.arrivals).length > 0)
      throw new Error(
        'INVENTORY_DATA_INVALID: Actual arrivals cannot enter through pre-V4 receipt semantics.'
      );
    if (
      contextVersion < 5 &&
      (Object.keys(result.state.expectedDeliveries).length > 0 ||
        Object.keys(result.state.arrivalAllocations).length > 0 ||
        Object.keys(result.state.reorderRules).length > 0)
    )
      throw new Error(
        'INVENTORY_DATA_INVALID: Stockroom facts cannot enter through pre-V5 receipt semantics.'
      );
    state = cumulativeLotSemantics
      ? result.state
      : projectLegacyInventoryLotConstraints(result.state);
  }
  return state;
}
