import { createHash } from 'node:crypto';
import {
  applyInventoryCommandBatch,
  inventoryNotebookSourceSha256,
  inventoryProtocolRunSourceSha256,
  parseProtocolPackage,
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
  type InventoryApplyScientificTransferRequest,
  type InventoryAcknowledgeSourceRequest,
  type NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import { protocolRunSavedSourceSchema } from '../shared/protocol-packages';
import { notebookSavedSourceSchema } from '../shared/notebook-saved-source';
import { applyNativeInventoryScientificTransfer } from './inventory-scientific';
import {
  applyNativeInventoryScientificCitation,
  applyNativeInventoryScientificCitationWithdrawal,
  verifyNativeInventoryScientificCitationSource,
} from './inventory-scientific-citations';
import { applyNativeInventoryPlatePlanObservation } from './inventory-plate-plan-observations';
import { applyNativeInventoryPlatePlanVersion } from './inventory-plate-plans';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import {
  applyNativeInventoryRunValueAttribution,
  applyNativeInventoryRunValueAttributionWithdrawal,
  verifyNativeInventoryRunValueAttributionSource,
} from './inventory-run-value-attributions';

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
  const scientific =
    'kind' in request &&
    (request.kind === 'record-scientific-transfer' ||
      request.kind === 'record-scientific-transfer-v2' ||
      request.kind === 'record-scientific-citation' ||
      request.kind === 'record-plate-plan-observation' ||
      request.kind === 'record-run-value-attribution');
  if (scientific) {
    const version = receipt.context?.version;
    const retained = receipt.context?.scientificSource;
    if (
      !retained ||
      !version ||
      version < 6 ||
      (request.kind === 'record-scientific-transfer-v2' && version < 7) ||
      (request.kind === 'record-scientific-citation' && version < 8) ||
      (request.kind === 'record-plate-plan-observation' && version < 10) ||
      (request.kind === 'record-run-value-attribution' && version < 11)
    )
      throw new Error(
        'INVENTORY_DATA_INVALID: Scientific work requires its matching native source witness.'
      );
    if (request.kind === 'record-scientific-citation')
      verifyNativeInventoryScientificCitationSource(request, retained);
    if (request.kind === 'record-run-value-attribution')
      verifyNativeInventoryRunValueAttributionSource(request, retained);
    const selection =
      request.kind === 'record-scientific-transfer'
        ? {
            kind: 'notebook-page',
            entityId: request.choices.pageId,
            sourceSha256: request.choices.expectedSourceSha256,
          }
        : request.kind === 'record-run-value-attribution'
          ? {
              kind: 'protocol-run',
              entityId: request.choices.runValue.entityId,
              sourceSha256: request.choices.runValue.sourceSha256,
            }
          : request.choices.context;
    if (selection.kind === 'notebook-page') {
      const source = notebookSavedSourceSchema.parse(retained);
      if (
        source.pageId !== selection.entityId ||
        inventoryNotebookSourceSha256(source) !== selection.sourceSha256 ||
        source.projectId !== request.project
      )
        throw new Error('INVENTORY_DATA_INVALID: Notebook witness mismatch.');
    } else {
      if (version < 7)
        throw new Error('INVENTORY_DATA_INVALID: Run witnesses require V7 semantics.');
      const source = protocolRunSavedSourceSchema.parse(retained);
      parseProtocolPackage(source.originalText);
      if (
        source.runId !== selection.entityId ||
        inventoryProtocolRunSourceSha256(source) !== selection.sourceSha256 ||
        source.projectId !== request.project
      )
        throw new Error('INVENTORY_DATA_INVALID: Run witness mismatch.');
    }
  } else if (receipt.context?.scientificSource)
    throw new Error('INVENTORY_DATA_INVALID: Only scientific work may retain a source witness.');
  if (
    'kind' in request &&
    request.kind === 'withdraw-run-value-attribution' &&
    (receipt.context?.version ?? 1) < 11
  )
    throw Error('INVENTORY_DATA_INVALID: Run value attribution withdrawal requires V11 semantics.');
  if (
    'kind' in request &&
    request.kind === 'withdraw-scientific-citation' &&
    (receipt.context?.version ?? 1) < 8
  )
    throw Error('INVENTORY_DATA_INVALID: Citation withdrawal requires V8 semantics.');
  if (
    'kind' in request &&
    request.kind === 'save-plate-plan-version' &&
    (receipt.context?.version ?? 1) < 9
  )
    throw Error('INVENTORY_DATA_INVALID: Plate-plan versions require V9 semantics.');
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
    receiptContextVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | undefined
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
  ) => InventoryTransition,
  options: { readonly allowRunValueAttributions?: boolean } = {}
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
    if (
      'kind' in request &&
      (request.kind === 'record-run-value-attribution' ||
        request.kind === 'withdraw-run-value-attribution')
    ) {
      if (contextVersion < 11 || !context || options.allowRunValueAttributions === false)
        throw Error(
          'INVENTORY_DATA_INVALID: Saved Run value attribution requires V11 semantics without a pre-V11 ancestor.'
        );
      result =
        request.kind === 'record-run-value-attribution'
          ? applyNativeInventoryRunValueAttribution(
              state,
              request,
              context,
              entry.receipt.context?.scientificSource
            )
          : applyNativeInventoryRunValueAttributionWithdrawal(state, request, context);
    } else if ('kind' in request && request.kind === 'record-plate-plan-observation') {
      if (contextVersion < 10 || !context || !entry.receipt.context?.scientificSource)
        throw Error(
          'INVENTORY_DATA_INVALID: Completed manual occurrences require V10 native source semantics.'
        );
      result = applyNativeInventoryPlatePlanObservation(
        state,
        request,
        context,
        entry.receipt.context.scientificSource
      );
    } else if ('kind' in request && request.kind === 'save-plate-plan-version') {
      if (contextVersion < 9 || !context)
        throw Error('INVENTORY_DATA_INVALID: Plate-plan versions require V9 semantics.');
      result = applyNativeInventoryPlatePlanVersion(state, request, context);
    } else if (
      'kind' in request &&
      (request.kind === 'record-scientific-citation' ||
        request.kind === 'withdraw-scientific-citation')
    ) {
      if (contextVersion < 8 || !context)
        throw Error('INVENTORY_DATA_INVALID: Saved citations require V8 semantics.');
      result =
        request.kind === 'record-scientific-citation'
          ? applyNativeInventoryScientificCitation(
              state,
              request,
              context,
              entry.receipt.context?.scientificSource
            )
          : applyNativeInventoryScientificCitationWithdrawal(state, request, context);
    } else if (
      'kind' in request &&
      (request.kind === 'record-scientific-transfer' ||
        request.kind === 'record-scientific-transfer-v2')
    ) {
      if (
        contextVersion < 6 ||
        (request.kind === 'record-scientific-transfer-v2' && contextVersion < 7) ||
        !context ||
        !entry.receipt.context?.scientificSource
      )
        throw new Error(
          'INVENTORY_DATA_INVALID: Scientific work requires V6 native receipt semantics.'
        );
      result = applyNativeInventoryScientificTransfer(
        state,
        request,
        context,
        entry.receipt.context.scientificSource
      );
    } else if ('kind' in request && request.kind === 'receive-arrival') {
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
    if (contextVersion < 9 && Object.keys(result.state.platePlanVersions).length > 0)
      throw Error(
        'INVENTORY_DATA_INVALID: Plate-plan versions cannot enter through pre-V9 receipt semantics.'
      );
    if (contextVersion < 10 && Object.keys(result.state.platePlanObservations).length > 0)
      throw Error(
        'INVENTORY_DATA_INVALID: Manual plan occurrences cannot enter through pre-V10 receipt semantics.'
      );
    if (
      (contextVersion < 11 || options.allowRunValueAttributions === false) &&
      (Object.keys(result.state.runValueAttributions).length > 0 ||
        Object.keys(result.state.runValueAttributionWithdrawals).length > 0)
    )
      throw Error(
        'INVENTORY_DATA_INVALID: Saved Run value attributions cannot enter through pre-V11 semantics or ancestry.'
      );
    state = cumulativeLotSemantics
      ? result.state
      : projectLegacyInventoryLotConstraints(result.state);
  }
  return state;
}
