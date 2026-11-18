import {
  applyInventoryRunValueAttribution,
  applyInventoryRunValueAttributionWithdrawal,
  inventoryRunValueAttributionId,
  inventoryRunValueAttributionIntentSha256,
  inventoryRunValueAttributionSelection,
  parseInventoryArchive,
  type InventoryRunValueAttribution,
  type InventoryExecutionContext,
  type InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryApplyRunValueAttributionRequest,
  InventoryApplyRunValueAttributionWithdrawalRequest,
} from '../shared/inventory-run-value-attributions';
import type { NativeInventoryHistoryEntry } from '../shared/inventory-command';
import {
  protocolRunSavedSourceSchema,
  type ProtocolRunSavedSource,
} from '../shared/protocol-packages';
import { verifyNativeInventoryScientificContextSource } from './inventory-scientific-citations';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';
import { canonicalNativeMutationRequest as canonical } from './native-mutation-request';

export function verifyNativeInventoryRunValueAttributionSource(
  request: InventoryApplyRunValueAttributionRequest,
  source: unknown
): ProtocolRunSavedSource {
  const packet = protocolRunSavedSourceSchema.parse(source);
  verifyNativeInventoryScientificContextSource(
    {
      project: request.project,
      choices: {
        context: {
          kind: 'protocol-run',
          entityId: request.choices.runValue.entityId,
          sourceSha256: request.choices.runValue.sourceSha256,
        },
      },
    },
    packet
  );
  const selected = inventoryRunValueAttributionSelection(packet, request.choices.runValue);
  if (canonical(selected.runValue) !== canonical(request.choices.runValue))
    throw Error('INVENTORY_DATA_INVALID: Saved Run row pin mismatch.');
  return packet;
}
export function applyNativeInventoryRunValueAttribution(
  state: InventoryState,
  request: InventoryApplyRunValueAttributionRequest,
  context: InventoryExecutionContext,
  source: unknown
) {
  return applyInventoryRunValueAttribution(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      source: verifyNativeInventoryRunValueAttributionSource(request, source),
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
}
export function applyNativeInventoryRunValueAttributionWithdrawal(
  state: InventoryState,
  request: InventoryApplyRunValueAttributionWithdrawalRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryRunValueAttributionWithdrawal(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
}
export function findNativeInventoryRunValueAttributionSource(
  record: InventoryRunValueAttribution,
  entries: readonly NativeInventoryHistoryEntry[]
): ProtocolRunSavedSource | null {
  const visit = (
    history: readonly NativeInventoryHistoryEntry[],
    depth: number
  ): ProtocolRunSavedSource | null => {
    for (const entry of history) {
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (
        request.kind === 'record-run-value-attribution' &&
        inventoryRunValueAttributionId(request.choices.identity) === record.id
      ) {
        const source = verifyNativeInventoryRunValueAttributionSource(
          request,
          entry.receipt.context?.scientificSource
        );
        const selected = inventoryRunValueAttributionSelection(source, record.runValue);
        if (
          inventoryRunValueAttributionIntentSha256(request.choices) !== record.intentSha256 ||
          canonical(selected.runValue) !== canonical(record.runValue) ||
          canonical(selected.source) !== canonical(record.source) ||
          canonical(selected.valueSnapshot) !== canonical(record.valueSnapshot) ||
          canonical(selected.origin) !== canonical(record.origin)
        )
          throw Error(
            'INVENTORY_DATA_INVALID: The saved attribution does not match its original Run witness.'
          );
        return source;
      }
      if (request.kind === 'adopt-archive') {
        const archive = parseInventoryArchive(request.sourceText, nativeInventoryArchiveRuntime, {
            depth,
          }),
          original = archive.document.content.source;
        const source = visit(
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
        if (source) return source;
      }
    }
    return null;
  };
  return visit(entries, 0);
}
