import {
  applyInventoryScientificTransfer,
  inventoryNotebookSourceSha256,
  inventoryScientificWorkId,
  parseInventoryArchive,
  type InventoryExecutionContext,
  type InventoryScientificWork,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  notebookSavedSourceSchema,
  type NotebookSavedSource,
} from '../shared/notebook-saved-source';
import type {
  InventoryApplyScientificTransferRequest,
  NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import type { InventoryScientificSourceRead } from '../shared/inventory-client';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

export function applyNativeInventoryScientificTransfer(
  state: InventoryState,
  request: InventoryApplyScientificTransferRequest,
  context: InventoryExecutionContext,
  source: NotebookSavedSource
) {
  return applyInventoryScientificTransfer(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      source: notebookSavedSourceSchema.parse(source),
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
}

export function findNativeInventoryScientificSource(
  work: InventoryScientificWork,
  entries: readonly NativeInventoryHistoryEntry[]
): InventoryScientificSourceRead {
  const visit = (
    history: readonly NativeInventoryHistoryEntry[],
    depth: number
  ): InventoryScientificSourceRead | null => {
    for (const entry of history) {
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (
        request.kind === 'record-scientific-transfer' &&
        inventoryScientificWorkId(request.choices.identity) === work.id
      ) {
        const source = notebookSavedSourceSchema.parse(entry.receipt.context?.scientificSource);
        const sourceSha256 = inventoryNotebookSourceSha256(source);
        if (
          sourceSha256 !== work.context.source.sha256 ||
          source.pageId !== work.context.pageId ||
          source.projectId !== work.context.projectId ||
          source.fileObjectUuid !== work.context.source.fileObjectUuid
        )
          throw new Error(
            'INVENTORY_DATA_INVALID: Scientific context does not match its retained source.'
          );
        return { kind: 'available', workId: work.id, sourceSha256, source };
      }
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
      code: 'INVENTORY_SCIENTIFIC_SOURCE_UNAVAILABLE',
      message: 'The original scientific work context is unavailable.',
    }
  );
}
