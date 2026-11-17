import {
  applyInventoryArrival,
  inventoryArrivalPreview,
  type InventoryArrivalChoices,
  type InventoryArrivalPreviewInput,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryApplyArrivalRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventoryArrivalPreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventoryArrivalChoices,
  bindings: InventoryArrivalPreviewInput['bindings'],
  context: InventoryExecutionContext
) {
  return inventoryArrivalPreview(state, {
    target,
    sourceText,
    options: { components: options.components },
    bindings,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  });
}

export function applyNativeInventoryArrival(
  state: InventoryState | null,
  request: InventoryApplyArrivalRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryArrival(
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
