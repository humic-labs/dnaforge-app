import {
  inventoryTableSha256,
  parseInventoryArchive,
  readInventoryArrivalDocument,
  type InventoryArrival,
  type InventoryArrivalDocumentRead,
  type InventoryArrivalDocumentReadInput,
} from '@waypoint/domain-services';
import type { NativeInventoryHistoryEntry } from '../shared/inventory-command';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

export function findNativeInventoryArrivalDocument(
  arrival: InventoryArrival,
  entries: readonly NativeInventoryHistoryEntry[],
  input: InventoryArrivalDocumentReadInput
): InventoryArrivalDocumentRead {
  const visit = (
    history: readonly NativeInventoryHistoryEntry[],
    depth: number
  ): InventoryArrivalDocumentRead | null => {
    for (const entry of history) {
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (
        request.kind === 'receive-arrival' &&
        inventoryTableSha256(request.sourceText) === arrival.sourceSha256
      )
        return readInventoryArrivalDocument(arrival, request.sourceText, input);
      if (request.kind === 'adopt-archive') {
        const archive = parseInventoryArchive(request.sourceText, nativeInventoryArchiveRuntime, {
          depth,
        });
        const source = archive.document.content.source;
        const found = visit(
          archive.document.content.history.map((row) =>
            parseNativeInventoryJournalEntry(
              {
                inventory_id: source.inventoryId,
                operation_id: row.operationId,
                revision: row.revision,
              },
              source.projectId,
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
      code: 'INVENTORY_ARRIVAL_SOURCE_UNAVAILABLE',
      message: 'The retained original arrival source is unavailable.',
    }
  );
}
