import {
  applyInventoryHierarchy,
  inventoryHierarchyPreview,
  type InventoryExecutionContext,
  type InventoryHierarchyChoices,
  type InventoryState,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryApplyHierarchyRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventoryHierarchyPreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventoryHierarchyChoices,
  context: InventoryExecutionContext
) {
  return inventoryHierarchyPreview(state, {
    target,
    sourceText,
    options,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  });
}
export function applyNativeInventoryHierarchy(
  state: InventoryState | null,
  request: InventoryApplyHierarchyRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryHierarchy(
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
