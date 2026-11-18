import {
  applyInventoryPlatePlanObservation,
  inventoryPlatePlanObservationId,
  inventoryPlatePlanObservationIntentSha256,
  parseInventoryArchive,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryPlatePlanObservation,
  type InventoryPlatePlanDefinition,
} from '@waypoint/domain-services';
import type {
  InventoryApplyPlatePlanObservationRequest,
  InventoryPlatePlanObservationSourceRead,
} from '../shared/inventory-plate-plan-observations';
import type { NativeInventoryHistoryEntry } from '../shared/inventory-command';
import { verifyNativeInventoryScientificContextSource } from './inventory-scientific-citations';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

export function applyNativeInventoryPlatePlanObservation(
  state: InventoryState,
  request: InventoryApplyPlatePlanObservationRequest,
  context: InventoryExecutionContext,
  source: unknown
) {
  const result = applyInventoryPlatePlanObservation(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      source: verifyNativeInventoryScientificContextSource(request, source),
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
  if (result.ok && result.state.revision !== state.revision + 1)
    throw Error(
      'INVENTORY_DATA_INVALID: A committed occurrence must append exactly one physical observation.'
    );
  return result;
}
export function findNativeInventoryPlatePlanObservationSource(
  observation: InventoryPlatePlanObservation,
  definition: InventoryPlatePlanDefinition,
  entries: readonly NativeInventoryHistoryEntry[]
): InventoryPlatePlanObservationSourceRead {
  const visit = (
    history: readonly NativeInventoryHistoryEntry[],
    depth: number
  ): InventoryPlatePlanObservationSourceRead | null => {
    for (const entry of history) {
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (
        request.kind === 'record-plate-plan-observation' &&
        inventoryPlatePlanObservationId(request.choices.identity) === observation.id
      ) {
        const source = verifyNativeInventoryScientificContextSource(
          request,
          entry.receipt.context?.scientificSource
        );
        if (
          inventoryPlatePlanObservationIntentSha256(request.choices, definition) !==
            observation.intentSha256 ||
          source.projectId !== observation.context.projectId ||
          source.workspaceScope !== observation.context.workspaceScope ||
          source.fileObjectUuid !== observation.context.source.fileObjectUuid ||
          source.title !== observation.context.source.title ||
          request.choices.context.kind !== observation.context.kind ||
          request.choices.context.entityId !== observation.context.entityId ||
          request.choices.context.sourceSha256 !== observation.context.source.sha256
        )
          throw Error(
            'INVENTORY_DATA_INVALID: Occurrence does not match its retained native source.'
          );
        return {
          kind: 'available',
          observationId: observation.id,
          intentSha256: observation.intentSha256,
          sourceSha256: observation.context.source.sha256,
          source,
        };
      }
      if (request.kind === 'adopt-archive') {
        const archive = parseInventoryArchive(request.sourceText, nativeInventoryArchiveRuntime, {
            depth,
          }),
          original = archive.document.content.source;
        const found = visit(
          archive.document.content.history.map((row) =>
            parseNativeInventoryJournalEntry(
              {
                inventory_id: original.inventoryId,
                operation_id: row.operationId,
                revision: row.revision,
              },
              original.projectId,
              { request: JSON.parse(row.requestJson), receipt: JSON.parse(row.receiptJson) }
            )
          ),
          depth + 1
        );
        if (found) return found;
      }
    }
    return null;
  };
  return (
    visit(entries, 0) ?? {
      kind: 'unavailable',
      code: 'INVENTORY_PLATE_PLAN_OBSERVATION_SOURCE_UNAVAILABLE',
      message: 'The retained occurrence source is unavailable.',
      retryable: false,
    }
  );
}
