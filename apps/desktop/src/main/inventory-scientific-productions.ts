import {
  applyInventoryScientificProduction,
  inventoryScientificProductionId,
  inventoryScientificProductionIntentSha256,
  parseInventoryArchive,
  inventoryTableCanonicalJson,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryScientificProduction,
} from '@waypoint/domain-services';
import { verifyAcceptedDnaProductionWitness } from '@waypoint/scientific-artifacts';
import type {
  InventoryApplyScientificProductionRequest,
  InventoryScientificProductionSourceRead,
} from '../shared/inventory-scientific-productions';
import type { NativeInventoryHistoryEntry } from '../shared/inventory-command';
import { verifyNativeInventoryScientificContextSource } from './inventory-scientific-citations';
import { nativeInventoryArchiveRuntime, nativeInventorySha256 } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';
export function verifyNativeInventoryScientificProductionSources(
  request: InventoryApplyScientificProductionRequest,
  source: unknown,
  design: unknown
) {
  const run = verifyNativeInventoryScientificContextSource(request, source),
    verified = verifyAcceptedDnaProductionWitness(design);
  if (
    run.schema !== 'dnaforge.protocol-run-saved-source.v1' ||
    verified.binding.owner.projectId !== request.project ||
    verified.binding.owner.workspaceScope !== run.workspaceScope ||
    inventoryTableCanonicalJson(verified.binding.selection) !==
      inventoryTableCanonicalJson(request.choices.design)
  )
    throw Error('INVENTORY_DATA_INVALID: Production witnesses do not match the accepted report.');
  return { run, verified };
}
export function applyNativeInventoryScientificProduction(
  state: InventoryState,
  request: InventoryApplyScientificProductionRequest,
  context: InventoryExecutionContext,
  source: unknown,
  design: unknown
) {
  const { run, verified } = verifyNativeInventoryScientificProductionSources(
    request,
    source,
    design
  );
  return applyInventoryScientificProduction(
    state,
    {
      ...request.choices,
      target: {
        projectId: request.project,
        inventoryId: request.inventoryId,
        present: state.revision !== 0,
        revision: state.revision,
      },
      source: run,
      designBinding: verified.binding,
      expectedPlanDigest: request.expectedPlanDigest,
    },
    context
  );
}
export function findNativeInventoryScientificProductionSource(
  production: InventoryScientificProduction,
  entries: readonly NativeInventoryHistoryEntry[]
): InventoryScientificProductionSourceRead {
  const visit = (
    history: readonly NativeInventoryHistoryEntry[],
    depth: number
  ): InventoryScientificProductionSourceRead | null => {
    for (const entry of history) {
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (
        request.kind === 'record-scientific-production' &&
        inventoryScientificProductionId(request.choices.identity) === production.id
      ) {
        const { run, verified } = verifyNativeInventoryScientificProductionSources(
          request,
          entry.receipt.context?.scientificSource,
          entry.receipt.context?.acceptedDesign
        );
        if (
          inventoryScientificProductionIntentSha256(request.choices) !== production.intentSha256 ||
          inventoryTableCanonicalJson(verified.binding) !==
            inventoryTableCanonicalJson(production.design) ||
          run.projectId !== production.context.projectId ||
          run.workspaceScope !== production.context.workspaceScope ||
          run.fileObjectUuid !== production.context.source.fileObjectUuid ||
          request.choices.context.sourceSha256 !== production.context.source.sha256
        )
          throw Error('INVENTORY_DATA_INVALID: Production does not match its retained witnesses.');
        return {
          kind: 'available',
          productionId: production.id,
          intentSha256: production.intentSha256,
          sourceSha256: production.context.source.sha256,
          source: run,
          design: {
            binding: verified.binding,
            representation: verified.representation,
            proofSha256: nativeInventorySha256(
              inventoryTableCanonicalJson(entry.receipt.context!.acceptedDesign)
            ),
          },
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
      code: 'INVENTORY_SCIENTIFIC_PRODUCTION_SOURCE_UNAVAILABLE',
      message: 'The original production witnesses are unavailable.',
      retryable: false,
    }
  );
}
