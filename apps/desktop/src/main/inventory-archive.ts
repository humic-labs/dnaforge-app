import { createHash } from 'node:crypto';
import {
  adoptInventoryState,
  createInventoryArchive,
  parseInventoryArchive,
  inventoryImportPreview,
  inventoryImportFailurePreview,
  InventoryArchiveError,
  type InventoryArchiveRuntime,
  type InventoryArchiveSha256,
  type InventoryArchiveCapture,
  type InventoryExecutionContext,
  type InventoryImportBindingObservation,
  type InventoryImportOptions,
  type InventoryImportTarget,
  type InventoryImportPreview,
  type InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryApplyImportRequest,
  NativeInventoryHistoryEntry,
} from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import { applyNativeInventoryMappedTable } from './inventory-mapped-table';
import { applyNativeInventoryBenchlingCapture } from './inventory-benchling-application';
import { applyNativeInventoryTable } from './inventory-table';
import { applyNativeInventoryHierarchy } from './inventory-hierarchy';
import { applyNativeInventoryStocktake } from './inventory-stocktake';
import { applyNativeInventorySourceRevision } from './inventory-source-revision';
import {
  parseNativeInventoryJournalEntry,
  replayNativeInventoryEntries,
} from './inventory-journal';

export const nativeInventorySha256 = (text: string): InventoryArchiveSha256 =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

export const nativeInventoryArchiveRuntime: InventoryArchiveRuntime = {
  maxBytes: NATIVE_DOCUMENT_MAX_BODY_BYTES,
  sha256: nativeInventorySha256,
  replayJournal: ({ source, rows, depth }) =>
    replayNativeInventoryJournal(
      rows.map((row) =>
        parseNativeInventoryJournalEntry(
          {
            inventory_id: source.inventoryId,
            operation_id: row.operationId,
            revision: row.revision,
          },
          source.projectId,
          row
        )
      ),
      depth + 1
    ),
};

export function nativeInventoryArchive(capture: InventoryArchiveCapture) {
  return createInventoryArchive(capture, nativeInventoryArchiveRuntime);
}

export function nativeInventoryImportPreview(
  sourceText: string,
  target: InventoryImportTarget,
  options: InventoryImportOptions,
  bindings: readonly InventoryImportBindingObservation[],
  asOf: number,
  depth = 0
): InventoryImportPreview {
  try {
    const archive = parseInventoryArchive(sourceText, nativeInventoryArchiveRuntime, { depth });
    return inventoryImportPreview(
      archive,
      { target, options, bindings, asOf },
      {
        sha256: nativeInventorySha256,
      }
    );
  } catch (error) {
    if (!(error instanceof InventoryArchiveError)) throw error;
    return inventoryImportFailurePreview(sourceText, target, error.issues, {
      sha256: nativeInventorySha256,
    });
  }
}

export function applyNativeInventoryAdoption(
  target: InventoryState | null,
  request: InventoryApplyImportRequest,
  context: InventoryExecutionContext,
  depth = 0,
  replay?: { readonly receiptContextVersion: 1 | 2 | undefined }
) {
  const archive = parseInventoryArchive(request.sourceText, nativeInventoryArchiveRuntime, {
    depth,
  });
  if (
    replay &&
    replay.receiptContextVersion !== 2 &&
    Number(
      archive.document.content.source.storedSchema?.match(/^dnaforge\.inventory\.v([1-9]\d*)$/)?.[1]
    ) >= 19
  )
    throw new Error(
      'INVENTORY_DATA_INVALID: A legacy receipt cannot adopt a current lot-constraint archive.'
    );
  const preview = inventoryImportPreview(
    archive,
    {
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: target !== null,
        revision: target?.revision ?? 0,
      },
      options: request.options,
      bindings: request.options.bindings.map((binding) => ({ ...binding, kind: 'admitted' })),
      asOf: context.at,
    },
    { sha256: nativeInventorySha256 }
  );
  if (
    preview.kind !== 'ready' ||
    !archive.state ||
    preview.planDigest !== request.expectedPlanDigest ||
    canonicalNativeMutationRequest(preview.options) !==
      canonicalNativeMutationRequest(request.options)
  )
    throw new Error(
      'INVENTORY_DATA_INVALID: The accepted archive adoption plan could not be verified.'
    );
  return adoptInventoryState(
    target,
    archive.state,
    {
      source: {
        archiveSha256: archive.sourceSha256,
        projectId: archive.document.content.source.projectId,
        inventoryId: archive.document.content.source.inventoryId,
        revision: archive.document.content.source.revision,
      },
      materialBindings: Object.fromEntries(
        request.options.bindings.map((binding) => [
          binding.sourceMaterialId,
          binding.destinationMaterialId,
        ])
      ),
    },
    context
  );
}

export function replayNativeInventoryJournal(
  entries: readonly NativeInventoryHistoryEntry[],
  depth = 0
): InventoryState {
  return replayNativeInventoryEntries(
    entries,
    (target, request, context, receiptContextVersion) =>
      applyNativeInventoryAdoption(target, request, context, depth, { receiptContextVersion }),
    applyNativeInventoryTable,
    applyNativeInventoryStocktake,
    applyNativeInventoryHierarchy,
    applyNativeInventorySourceRevision,
    applyNativeInventoryMappedTable,
    applyNativeInventoryBenchlingCapture
  );
}
