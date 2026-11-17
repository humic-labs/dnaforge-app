import {
  applyInventoryBenchlingCapture,
  inventoryBenchlingCapturePreview,
  type InventoryBenchlingCaptureChoices,
  type InventoryBenchlingCapturePreviewInput,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTableTarget,
} from '@waypoint/domain-services';
import type { InventoryApplyBenchlingCaptureRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

export function nativeInventoryBenchlingCapturePreview(
  state: InventoryState | null,
  target: InventoryTableTarget,
  sourceText: string,
  options: InventoryBenchlingCaptureChoices,
  bindings: InventoryBenchlingCapturePreviewInput['bindings'],
  context: InventoryExecutionContext
) {
  return inventoryBenchlingCapturePreview(state, {
    target,
    sourceText,
    options: {
      scopeAcceptance: options.scopeAcceptance,
      records: options.records,
      sourceIssueDispositions: options.sourceIssueDispositions,
      uncapturedPositions: options.uncapturedPositions,
    },
    bindings,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  });
}

export function applyNativeInventoryBenchlingCapture(
  state: InventoryState | null,
  request: InventoryApplyBenchlingCaptureRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryBenchlingCapture(
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
