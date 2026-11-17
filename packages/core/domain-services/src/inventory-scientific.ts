import { normalizeInventoryAmount } from './inventory-amount';
import { inventoryRecordIdExists } from './inventory-identity';
import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryState } from './inventory-validation';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryTableSha256 } from './inventory-table-types';
import {
  inventoryNotebookSourceSha256,
  inventoryScientificWorkId,
  inventoryScientificStockId,
  inventoryScientificTransferIntentSha256,
} from './inventory-scientific-source';
export {
  inventoryNotebookSourceSha256,
  inventoryScientificWorkId,
  inventoryScientificStockId,
  inventoryScientificTransferIntentSha256,
} from './inventory-scientific-source';
import type {
  InventoryErrorCode,
  InventoryState,
  InventoryTransition,
  InventoryVessel,
} from './inventory-types';
import type {
  InventoryScientificTransferApply,
  InventoryScientificTransferChoices,
  InventoryScientificTransferCommand,
  InventoryScientificTransferExisting,
  InventoryScientificTransferPreview,
  InventoryScientificTransferPreviewInput,
  InventoryScientificVesselSnapshot,
  InventoryScientificWork,
} from './inventory-scientific-types';

export function inventoryScientificTransferExisting(
  state: Pick<InventoryState, 'scientificWorks'>,
  input: InventoryScientificTransferChoices
): InventoryScientificTransferExisting {
  const id = inventoryScientificWorkId(input.identity),
    intentSha256 = inventoryScientificTransferIntentSha256(input),
    work = Object.hasOwn(state.scientificWorks, id) ? state.scientificWorks[id] : undefined;
  if (!work) return { kind: 'new' };
  return {
    kind: work.intentSha256 === intentSha256 ? 'no-change' : 'conflict',
    work: structuredClone(work),
  };
}
function vesselSnapshot(vessel: InventoryVessel): InventoryScientificVesselSnapshot {
  return {
    id: vessel.id,
    kind: vessel.kind,
    name: vessel.name,
    placement: { ...vessel.placement },
  };
}
function prepare(
  state: InventoryState,
  input: InventoryScientificTransferPreviewInput
): { preview: InventoryScientificTransferPreview; state?: InventoryState } {
  let workId: string | null = null,
    intentSha256: InventoryTableSha256 | null = null,
    sourceSha256: InventoryTableSha256 | null = null;
  const facts = () => ({
    schema: 'dnaforge.inventory-scientific-transfer-preview.v1' as const,
    target: structuredClone(input.target),
    workId,
    intentSha256,
    sourceSha256,
  });
  const blocked = (
    code: InventoryErrorCode,
    message: string
  ): { preview: InventoryScientificTransferPreview } => ({
    preview: {
      ...facts(),
      kind: 'blocked',
      issues: [{ code, pointer: '/transfer', message }],
      work: null,
      commands: [],
      planDigest: null,
    },
  });
  try {
    workId = inventoryScientificWorkId(input.identity);
    intentSha256 = inventoryScientificTransferIntentSha256(input);
    const existing = inventoryScientificTransferExisting(state, input);
    if (existing.kind === 'conflict')
      return blocked(
        'SCIENTIFIC_WORK_CONFLICT',
        'This physical-work identity already records different work. Preserve it and record an explicit correction.'
      );
    if (existing.kind === 'no-change')
      return {
        preview: {
          ...facts(),
          sourceSha256: existing.work.context.source.sha256,
          kind: 'no-change',
          work: existing.work,
          commands: [],
          planDigest: null,
        },
      };
    if (inventoryRecordIdExists(state, workId))
      return blocked('ID_ALREADY_EXISTS', 'That scientific-work identifier already exists.');
    if (!input.target.present || input.target.revision !== state.revision)
      return blocked(
        'REVISION_CONFLICT',
        'The inventory changed. Preview the physical work again.'
      );
    const source = input.source;
    if (
      !source ||
      source.schema !== 'dnaforge.notebook-saved-source.v1' ||
      source.projectId !== input.target.projectId ||
      source.pageId !== input.pageId ||
      !source.workspaceScope ||
      !source.pageId.startsWith(`${source.workspaceScope}::`) ||
      !source.fileObjectUuid ||
      !source.title ||
      !source.content ||
      typeof source.content !== 'object' ||
      Array.isArray(source.content)
    )
      return blocked(
        'SCIENTIFIC_CONTEXT_MISMATCH',
        'The completed work requires its exact admitted saved notebook source in this project.'
      );
    sourceSha256 = inventoryNotebookSourceSha256(source);
    if (sourceSha256 !== input.expectedSourceSha256)
      return blocked(
        'SCIENTIFIC_CONTEXT_MISMATCH',
        'The saved notebook source changed. Inspect it and preview the transfer again.'
      );
    const command: InventoryScientificTransferCommand = {
      kind: 'transfer',
      sourceStockId: input.sourceStockId,
      quantity: normalizeInventoryAmount(input.quantity),
      destination: {
        kind: 'new-stock',
        stockId: inventoryScientificStockId(input.identity),
        vesselId: input.destinationVesselId,
      },
      reason: input.reason,
    };
    const transition = applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands: [command] },
      { at: input.asOf, principal: input.principal, authority: input.authority }
    );
    if (!transition.ok) return blocked(transition.code, transition.message);
    const before = state.stocks[command.sourceStockId],
      after = transition.state.stocks[command.sourceStockId],
      destination = transition.state.stocks[command.destination.stockId];
    const work: InventoryScientificWork = {
      id: workId,
      identity: { ...input.identity },
      intentSha256,
      context: {
        kind: 'notebook-page',
        projectId: source.projectId,
        workspaceScope: source.workspaceScope,
        pageId: source.pageId,
        source: {
          kind: 'native-observed-saved-source',
          sha256: sourceSha256,
          fileObjectUuid: source.fileObjectUuid,
          title: source.title,
        },
      },
      observation: { kind: 'completed-manual-transfer' },
      transfer: command,
      effects: {
        source: {
          before: structuredClone(before),
          after: structuredClone(after),
          vessel: vesselSnapshot(state.vessels[before.vesselId]),
        },
        destination: {
          before: null,
          after: structuredClone(destination),
          vessel: vesselSnapshot(state.vessels[destination.vesselId]),
        },
      },
      at: input.asOf,
      by: { ...input.principal },
      reason: input.reason,
    };
    const planDigest = inventoryTableSha256(
      canonical({
        schema: 'dnaforge.inventory-scientific-transfer-plan.v1',
        target: input.target,
        intentSha256,
        sourceSha256,
        principal: input.principal,
        authority: input.authority,
        sourceStock: before,
        destinationVessel: state.vessels[destination.vesselId],
      })
    );
    const candidate = parseInventoryState({
      ...transition.state,
      scientificWorks: Object.assign(Object.create(null), state.scientificWorks, {
        [work.id]: work,
      }),
    });
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        work: candidate.scientificWorks[work.id],
        commands: [command],
        planDigest,
      },
      state: candidate,
    };
  } catch (cause) {
    return blocked(
      'INVALID_INVENTORY_INPUT',
      cause instanceof Error ? cause.message : 'The scientific transfer is invalid.'
    );
  }
}
export function inventoryScientificTransferPreview(
  state: InventoryState,
  input: InventoryScientificTransferPreviewInput
): InventoryScientificTransferPreview {
  return prepare(state, input).preview;
}
export const applyInventoryScientificTransfer: InventoryScientificTransferApply = (
  state,
  input,
  context
): InventoryTransition => {
  const prepared = prepare(state, {
    ...input,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
  });
  if (prepared.preview.kind === 'no-change') return { ok: true, state };
  if (prepared.preview.kind === 'blocked') {
    const first = prepared.preview.issues[0];
    return {
      ok: false,
      code: first.code,
      message: first.message,
    };
  }
  if (!prepared.state || prepared.preview.planDigest !== input.expectedPlanDigest)
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message:
        'The transfer observation changed. Preview it again before recording completed work.',
    };
  return { ok: true, state: prepared.state };
};
