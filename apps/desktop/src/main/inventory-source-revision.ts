import {
  applyInventorySourceRevision,
  inventorySourceRevisionPreview,
  type InventoryExecutionContext,
  type InventorySourceRevisionChoices,
  type InventorySourceRevisionPreimage,
  type InventoryState,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryAcknowledgeSourceRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventorySourceRevisionPreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventorySourceRevisionChoices,
  preimages: readonly InventorySourceRevisionPreimage[],
  context: InventoryExecutionContext
) {
  return inventorySourceRevisionPreview(state, {
    target,
    sourceText,
    options,
    preimages,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  });
}

export function applyNativeInventorySourceRevision(
  state: InventoryState | null,
  request: InventoryAcknowledgeSourceRequest,
  context: InventoryExecutionContext
) {
  return applyInventorySourceRevision(
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
