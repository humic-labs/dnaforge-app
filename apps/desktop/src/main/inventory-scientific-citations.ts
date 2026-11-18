import {
  applyInventoryScientificCitation,
  applyInventoryScientificCitationWithdrawal,
  inventoryScientificCitationId,
  inventoryScientificCitationIntentSha256,
  inventoryNotebookSourceSha256,
  inventoryProtocolRunSourceSha256,
  parseInventoryArchive,
  parseProtocolPackage,
  type InventoryExecutionContext,
  type InventoryScientificCitation,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  notebookSavedSourceSchema,
  type NotebookSavedSource,
} from '../shared/notebook-saved-source';
import {
  protocolRunSavedSourceSchema,
  type ProtocolRunSavedSource,
} from '../shared/protocol-packages';
import type {
  InventoryApplyScientificCitationRequest,
  InventoryApplyScientificCitationWithdrawalRequest,
  InventoryScientificCitationSourceRead,
} from '../shared/inventory-scientific-citations';
import type { NativeInventoryHistoryEntry } from '../shared/inventory-command';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

export function verifyNativeInventoryScientificCitationSource(
  request: InventoryApplyScientificCitationRequest,
  source: unknown
): NotebookSavedSource | ProtocolRunSavedSource {
  const context = request.choices.context;
  const packet =
    context.kind === 'notebook-page'
      ? notebookSavedSourceSchema.parse(source)
      : protocolRunSavedSourceSchema.parse(source);
  const entityId =
    packet.schema === 'dnaforge.notebook-saved-source.v1' ? packet.pageId : packet.runId;
  const sourceSha256 =
    packet.schema === 'dnaforge.notebook-saved-source.v1'
      ? inventoryNotebookSourceSha256(packet)
      : inventoryProtocolRunSourceSha256(packet);
  if (packet.schema === 'dnaforge.protocol-run-saved-source.v1') {
    const parsed = parseProtocolPackage(packet.originalText);
    if (
      parsed.kind !== 'protocol_run' ||
      `${packet.workspaceScope}::${parsed.id.split('::').at(-1)}` !== packet.runId
    )
      throw Error('INVENTORY_DATA_INVALID: Citation Run source identity mismatch.');
  }
  if (
    packet.projectId !== request.project ||
    entityId !== context.entityId ||
    sourceSha256 !== context.sourceSha256 ||
    !entityId.startsWith(`${packet.workspaceScope}::`)
  )
    throw Error('INVENTORY_DATA_INVALID: Citation source witness mismatch.');
  return packet;
}
export function applyNativeInventoryScientificCitation(
  state: InventoryState,
  request: InventoryApplyScientificCitationRequest,
  context: InventoryExecutionContext,
  source: unknown
) {
  return applyInventoryScientificCitation(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      source: verifyNativeInventoryScientificCitationSource(request, source),
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
}
export function applyNativeInventoryScientificCitationWithdrawal(
  state: InventoryState,
  request: InventoryApplyScientificCitationWithdrawalRequest,
  context: InventoryExecutionContext
) {
  return applyInventoryScientificCitationWithdrawal(
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
export function findNativeInventoryScientificCitationSource(
  citation: InventoryScientificCitation,
  entries: readonly NativeInventoryHistoryEntry[]
): InventoryScientificCitationSourceRead {
  const visit = (
    history: readonly NativeInventoryHistoryEntry[],
    depth: number
  ): InventoryScientificCitationSourceRead | null => {
    for (const entry of history) {
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (
        request.kind === 'record-scientific-citation' &&
        inventoryScientificCitationId(request.choices.identity) === citation.id
      ) {
        const source = verifyNativeInventoryScientificCitationSource(
          request,
          entry.receipt.context?.scientificSource
        );
        if (
          inventoryScientificCitationIntentSha256(request.choices) !== citation.intentSha256 ||
          request.choices.workId !== citation.workId ||
          request.choices.workIntentSha256 !== citation.workIntentSha256 ||
          source.projectId !== citation.context.projectId ||
          source.workspaceScope !== citation.context.workspaceScope ||
          source.fileObjectUuid !== citation.context.source.fileObjectUuid ||
          source.title !== citation.context.source.title ||
          request.choices.context.kind !== citation.context.kind ||
          request.choices.context.entityId !== citation.context.entityId ||
          request.choices.context.sourceSha256 !== citation.context.source.sha256
        )
          throw Error('INVENTORY_DATA_INVALID: Citation does not match its retained source.');
        return {
          kind: 'available',
          citationId: citation.id,
          workId: citation.workId,
          sourceSha256: citation.context.source.sha256,
          source,
        };
      }
      if (request.kind === 'adopt-archive') {
        const archive = parseInventoryArchive(request.sourceText, nativeInventoryArchiveRuntime, {
            depth,
          }),
          source = archive.document.content.source;
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
      code: 'INVENTORY_SCIENTIFIC_CITATION_SOURCE_UNAVAILABLE',
      message: 'The original saved citation source is unavailable.',
    }
  );
}
