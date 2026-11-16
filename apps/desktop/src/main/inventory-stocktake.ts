import {
  applyInventoryStocktake,
  inventoryStocktakePreview,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryStocktakeChoices,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryApplyStocktakeRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventoryStocktakePreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventoryStocktakeChoices,
  context: InventoryExecutionContext
) {
  return inventoryStocktakePreview(state, {
    target,
    sourceText,
    options,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  });
}

export function applyNativeInventoryStocktake(
  state: InventoryState | null,
  request: InventoryApplyStocktakeRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryStocktake(
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
