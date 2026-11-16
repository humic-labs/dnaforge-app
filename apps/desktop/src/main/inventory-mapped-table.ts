import {
  applyInventoryMappedTable,
  inventoryMappedTablePreview,
  type InventoryExecutionContext,
  type InventoryMappedTableBindingObservation,
  type InventoryMappedTableChoices,
  type InventoryState,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryApplyMappedTableRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventoryMappedTablePreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventoryMappedTableChoices,
  bindings: readonly InventoryMappedTableBindingObservation[],
  context: InventoryExecutionContext
) {
  return inventoryMappedTablePreview(state, {
    target,
    sourceText,
    options,
    bindings,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  });
}
export function applyNativeInventoryMappedTable(
  state: InventoryState | null,
  request: InventoryApplyMappedTableRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryMappedTable(
    state,
    {
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state !== null,
        revision: state?.revision ?? 0,
      },
      sourceText: request.sourceText,
      options: request.options,
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context,
    NATIVE_DOCUMENT_MAX_BODY_BYTES
  );
}
