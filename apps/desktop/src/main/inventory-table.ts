import {
  applyInventoryTable,
  inventoryTablePreview,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTableBindingObservation,
  type InventoryTableChoices,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryApplyTableRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventoryTablePreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventoryTableChoices,
  bindings: readonly InventoryTableBindingObservation[],
  context: InventoryExecutionContext
) {
  return inventoryTablePreview(state, {
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

export function applyNativeInventoryTable(
  state: InventoryState | null,
  request: InventoryApplyTableRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryTable(
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
