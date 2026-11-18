import {
  applyInventoryScientificTransfer,
  applyInventoryScientificTransferV2,
  inventoryProtocolRunSourceSha256,
  parseProtocolPackage,
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
  InventoryApplyScientificTransferV2Request,
  NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import type { InventoryScientificSourceRead } from '../shared/inventory-client';
import {
  protocolRunSavedSourceSchema,
  type ProtocolRunSavedSource,
} from '../shared/protocol-packages';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

export function applyNativeInventoryScientificTransfer(
  state: InventoryState,
  request: InventoryApplyScientificTransferRequest | InventoryApplyScientificTransferV2Request,
  context: InventoryExecutionContext,
  source: NotebookSavedSource | ProtocolRunSavedSource
) {
  if (request.kind === 'record-scientific-transfer-v2') {
    const verified =
      source.schema === 'dnaforge.notebook-saved-source.v1'
        ? notebookSavedSourceSchema.parse(source)
        : protocolRunSavedSourceSchema.parse(source);
    if (verified.schema === 'dnaforge.protocol-run-saved-source.v1')
      parseProtocolPackage(verified.originalText);
    return applyInventoryScientificTransferV2(
      state,
      {
        ...request.choices,
        target: {
          projectId: request.project,
          inventoryId: request.inventoryId,
          present: state.revision !== 0,
          revision: state.revision,
        },
        source: verified,
        expectedPlanDigest: request.expectedPlanDigest,
      },
      context
    );
  }
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
        (request.kind === 'record-scientific-transfer' ||
          request.kind === 'record-scientific-transfer-v2') &&
        inventoryScientificWorkId(request.choices.identity) === work.id
      ) {
        const retained = entry.receipt.context?.scientificSource;
        const source =
          retained?.schema === 'dnaforge.protocol-run-saved-source.v1'
            ? protocolRunSavedSourceSchema.parse(retained)
            : notebookSavedSourceSchema.parse(retained);
        const sourceSha256 =
          source.schema === 'dnaforge.notebook-saved-source.v1'
            ? inventoryNotebookSourceSha256(source)
            : inventoryProtocolRunSourceSha256(source);
        const sourceId =
          source.schema === 'dnaforge.notebook-saved-source.v1' ? source.pageId : source.runId;
        const workId =
          work.context.kind === 'notebook-page' ? work.context.pageId : work.context.entityId;
        if (source.schema === 'dnaforge.protocol-run-saved-source.v1')
          parseProtocolPackage(source.originalText);
        if (
          sourceSha256 !== work.context.source.sha256 ||
          sourceId !== workId ||
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
