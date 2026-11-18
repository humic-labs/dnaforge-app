import { applyInventoryCommandBatch } from './inventory-state';
import { inventoryPlanStock } from './inventory-plan-semantics';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import { inventoryRecordIdExists } from './inventory-identity';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import { inventoryProtocolRunSourceSha256 } from './inventory-scientific-source';
import { parseProtocolPackage } from './protocol-package';
import { inventoryStockAvailabilityFacts } from './inventory-reservations';
import { inventoryItemCustody } from './inventory-custody';
import {
  inventoryScientificProductionId,
  inventoryScientificProductionIntentSha256,
  inventoryScientificProductionLotId,
  inventoryScientificProductionStockId,
  parseInventoryScientificProductionChoices,
} from './inventory-scientific-production-identity';
import type {
  InventoryState,
  InventoryExecutionContext,
  InventoryTransition,
  InventoryVessel,
} from './inventory-types';
import type { InventoryScientificVesselSnapshot } from './inventory-scientific-types';
import type {
  InventoryScientificProductionChoices,
  InventoryScientificProductionExisting,
  InventoryScientificProductionPreviewInput,
  InventoryScientificProductionApplication,
  InventoryScientificProductionPreview,
  InventoryScientificProductionIssue,
  InventoryScientificProduction,
  InventoryScientificProductionCommand,
  InventoryScientificProductionFilter,
  InventoryScientificProductionSummary,
} from './inventory-scientific-production-types';
export * from './inventory-scientific-production-identity';
const issue = (
  code: InventoryScientificProductionIssue['code'],
  pointer: string,
  message: string
): InventoryScientificProductionIssue => ({ code, pointer, message });
const vesselSnapshot = (value: InventoryVessel): InventoryScientificVesselSnapshot => ({
  id: value.id,
  kind: value.kind,
  name: value.name,
  placement: structuredClone(value.placement),
});
export function inventoryScientificProductionExisting(
  state: InventoryState,
  choices: InventoryScientificProductionChoices
): InventoryScientificProductionExisting {
  const id = inventoryScientificProductionId(choices.identity),
    intent = inventoryScientificProductionIntentSha256(choices),
    existing = state.scientificProductions[id];
  if (existing)
    return existing.intentSha256 === intent
      ? { kind: 'no-change', production: structuredClone(existing) }
      : {
          kind: 'blocked',
          issue: issue(
            'SCIENTIFIC_PRODUCTION_CONFLICT',
            '/identity',
            'This production identity already records different completed work. Preserve its original report.'
          ),
        };
  return inventoryRecordIdExists(state, id)
    ? {
        kind: 'blocked',
        issue: issue('ID_ALREADY_EXISTS', '/identity', 'That inventory identity already exists.'),
      }
    : { kind: 'new' };
}
export function inventoryScientificProductions(
  state: InventoryState,
  filter: InventoryScientificProductionFilter = {}
): readonly InventoryScientificProductionSummary[] {
  return Object.values(state.scientificProductions)
    .filter(
      (row) =>
        !filter.context ||
        (row.context.projectId === filter.context.projectId &&
          row.context.workspaceScope === filter.context.workspaceScope &&
          row.context.entityId === filter.context.entityId)
    )
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) =>
      structuredClone({
        id: row.id,
        identity: row.identity,
        intentSha256: row.intentSha256,
        context: row.context,
        design: row.design,
        materialBinding: row.materialBinding,
        output: { ...row.output, lotName: row.effects.lot.after.name },
        inputStockCount: row.inputs.length,
        method: row.method,
        reason: row.reason,
        at: row.at,
        by: row.by,
      })
    );
}
function prepare(
  state: InventoryState,
  input: InventoryScientificProductionPreviewInput
): { preview: InventoryScientificProductionPreview; state?: InventoryState } {
  let productionId: string | null = null,
    intentSha256: `sha256:${string}` | null = null,
    sourceSha256: `sha256:${string}` | null = null,
    nextBoundaryAt: number | null = null;
  const target = { ...input.target, revision: state.revision, present: state.revision !== 0 };
  const facts = () => ({
    schema: 'dnaforge.inventory-scientific-production-preview.v1' as const,
    target,
    productionId,
    intentSha256,
    sourceSha256,
    asOf: input.asOf,
    principal: structuredClone(input.principal),
    nextBoundaryAt,
  });
  const blocked = (
    value: InventoryScientificProductionIssue
  ): { preview: InventoryScientificProductionPreview } => ({
    preview: {
      ...facts(),
      kind: 'blocked',
      production: null,
      commands: [],
      planDigest: null,
      issues: [value],
    },
  });
  try {
    const choices = parseInventoryScientificProductionChoices(inputChoices(input));
    productionId = inventoryScientificProductionId(choices.identity);
    intentSha256 = inventoryScientificProductionIntentSha256(choices);
    const existing = inventoryScientificProductionExisting(state, choices);
    if (existing.kind === 'blocked') return blocked(existing.issue);
    if (existing.kind === 'no-change')
      return {
        preview: {
          ...facts(),
          sourceSha256: existing.production.context.source.sha256,
          kind: 'no-change',
          production: existing.production,
          commands: [],
          planDigest: null,
        },
      };
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (
      !target.present ||
      input.target.present !== target.present ||
      input.target.revision !== state.revision
    )
      return blocked(
        issue('REVISION_CONFLICT', '/target', 'Inventory changed. Preview this production again.')
      );
    if (state.revision === Number.MAX_SAFE_INTEGER)
      return blocked(
        issue('REVISION_EXHAUSTED', '/target', 'The inventory revision cannot advance safely.')
      );
    if (context.at < state.lastRecordedAt)
      return blocked(
        issue('CLOCK_REGRESSION', '/target', 'Recording time precedes the inventory clock floor.')
      );
    const source = input.source,
      design = input.designBinding;
    if (
      !source ||
      source.schema !== 'dnaforge.protocol-run-saved-source.v1' ||
      source.projectId !== target.projectId ||
      source.runId !== choices.context.entityId ||
      !source.workspaceScope ||
      !source.fileObjectUuid ||
      !source.title ||
      !source.runId.startsWith(`${source.workspaceScope}::`)
    )
      return blocked(
        issue('SCIENTIFIC_CONTEXT_MISMATCH', '/context', 'Choose the exact admitted saved Run.')
      );
    const parsed = parseProtocolPackage(source.originalText);
    if (
      parsed.kind !== 'protocol_run' ||
      `${source.workspaceScope}::${parsed.id.split('::').at(-1)}` !== source.runId
    )
      return blocked(
        issue('SCIENTIFIC_CONTEXT_MISMATCH', '/context', 'The saved Run identity changed.')
      );
    sourceSha256 = inventoryProtocolRunSourceSha256(source);
    if (sourceSha256 !== choices.context.sourceSha256)
      return blocked(issue('SCIENTIFIC_CONTEXT_MISMATCH', '/context', 'The saved Run changed.'));
    if (
      !design ||
      design.kind !== 'accepted-dna-design' ||
      canonical(design.selection) !== canonical(choices.design) ||
      design.owner.projectId !== target.projectId ||
      design.owner.workspaceScope !== source.workspaceScope ||
      design.owner.scientificWorkspaceId !== choices.design.scientificWorkspaceId ||
      design.document.molecule !== 'DNA' ||
      !Number.isSafeInteger(design.document.length) ||
      design.document.length < 1
    )
      return blocked(
        issue(
          'SCIENTIFIC_CONTEXT_MISMATCH',
          '/design',
          'Choose the exact admitted nonempty accepted DNA design.'
        )
      );
    const lotId = inventoryScientificProductionLotId(choices.identity),
      stockId = inventoryScientificProductionStockId(choices.identity);
    if (inventoryRecordIdExists(state, lotId) || inventoryRecordIdExists(state, stockId))
      return blocked(
        issue(
          'ID_ALREADY_EXISTS',
          '/output',
          'A deterministic production output identity already exists.'
        )
      );
    for (const input of choices.inputs) {
      const stock = state.stocks[input.stockId];
      if (stock && stock.vesselId === choices.output.vesselId)
        return blocked(
          issue(
            'STOCK_ALREADY_PRESENT',
            '/output',
            'Production requires an empty output vessel distinct from all inputs.'
          )
        );
      if (stock) {
        const availability = inventoryStockAvailabilityFacts(
          state,
          stock.id,
          context.principal,
          context.at
        ).availability;
        const boundary = (at: number | null) => {
          if (at !== null && at > context.at)
            nextBoundaryAt = nextBoundaryAt === null ? at : Math.min(nextBoundaryAt, at);
        };
        boundary(availability.validity.nextBoundaryAt);
        for (const id of availability.reservationIds) {
          const reservation = state.reservations[id];
          if (reservation?.lifecycle.kind === 'active') boundary(reservation.deadline);
        }
        const custody = inventoryItemCustody(
          state,
          { kind: 'vessel', id: stock.vesselId },
          context.principal,
          context.at
        ).state;
        if (custody.kind === 'checked-out') boundary(custody.dueAt);
      }
    }
    if (state.vessels[choices.output.vesselId]) {
      const custody = inventoryItemCustody(
        state,
        { kind: 'vessel', id: choices.output.vesselId },
        context.principal,
        context.at
      ).state;
      if (custody.kind === 'checked-out' && custody.dueAt !== null && custody.dueAt > context.at)
        nextBoundaryAt =
          nextBoundaryAt === null ? custody.dueAt : Math.min(nextBoundaryAt, custody.dueAt);
    }
    const commands: InventoryScientificProductionCommand[] = [
      ...choices.inputs.map((row) => ({
        kind: 'consume' as const,
        stockId: row.stockId,
        quantity: row.quantity,
        reason: choices.reason,
      })),
      {
        kind: 'create-lot',
        id: lotId,
        materialId: design.selection.revision.resourceId,
        name: choices.output.lotName,
        origin: {
          kind: 'prepared',
          sourceStockIds: choices.inputs.map((row) => row.stockId),
          method: choices.method,
        },
      },
      { kind: 'manage-lot', lotId, reason: choices.reason },
      {
        kind: 'receive-lot-stock',
        id: stockId,
        vesselId: choices.output.vesselId,
        lotId,
        quantity: { kind: 'known', ...choices.output.quantity },
        quality: 'quarantined',
      },
    ];
    const result = applyInventoryCommandBatch(
      structuredClone(state),
      { expectedRevision: state.revision, commands },
      context
    );
    if (!result.ok) return blocked(issue(result.code, '/production', result.message));
    const production: InventoryScientificProduction = {
      id: productionId,
      identity: choices.identity,
      intentSha256,
      observation: { kind: 'reported-completed-manual-production' },
      context: {
        kind: 'protocol-run',
        projectId: source.projectId,
        workspaceScope: source.workspaceScope,
        entityId: source.runId,
        source: {
          kind: 'native-observed-saved-source',
          sha256: sourceSha256,
          fileObjectUuid: source.fileObjectUuid,
          title: source.title,
        },
      },
      design: structuredClone(design),
      materialBinding: {
        sourceMaterialId: choices.design.revision.resourceId,
        destinationMaterialId: design.selection.revision.resourceId,
      },
      inputs: choices.inputs,
      output: {
        lotId,
        stockId,
        vesselId: choices.output.vesselId,
        quantity: choices.output.quantity,
      },
      effects: {
        sources: choices.inputs.map((row) => ({
          before: structuredClone(state.stocks[row.stockId]),
          after: structuredClone(result.state.stocks[row.stockId]),
          vessel: vesselSnapshot(state.vessels[state.stocks[row.stockId].vesselId]),
        })),
        lot: { before: null, after: structuredClone(result.state.lots[lotId]) },
        stock: {
          before: null,
          after: structuredClone(result.state.stocks[stockId]),
          vessel: vesselSnapshot(state.vessels[choices.output.vesselId]),
        },
      },
      method: choices.method,
      reason: choices.reason,
      at: context.at,
      by: context.principal,
    };
    const candidate = parseInventoryState({
      ...result.state,
      scientificProductions: { ...state.scientificProductions, [productionId]: production },
    });
    const planDigest = inventoryTableSha256(
      canonical({
        schema: 'dnaforge.inventory-scientific-production-plan.v1',
        target,
        intentSha256,
        design,
        materialBinding: production.materialBinding,
        commands,
        sources: production.effects.sources.map((row) => ({
          stock: inventoryPlanStock(row.before),
          vessel: state.vessels[row.before.vesselId],
        })),
        destination: state.vessels[choices.output.vesselId],
      })
    );
    return {
      preview: {
        ...facts(),
        kind: 'ready',
        production: candidate.scientificProductions[productionId],
        commands,
        planDigest,
      },
      state: candidate,
    };
  } catch (error) {
    return blocked(
      issue(
        'INVALID_INVENTORY_INPUT',
        '/production',
        error instanceof Error ? error.message : 'Invalid production.'
      )
    );
  }
}
function inputChoices(
  input: InventoryScientificProductionChoices
): InventoryScientificProductionChoices {
  return {
    identity: input.identity,
    context: input.context,
    design: input.design,
    inputs: input.inputs,
    output: input.output,
    method: input.method,
    reason: input.reason,
  };
}
export function inventoryScientificProductionPreview(
  state: InventoryState,
  input: InventoryScientificProductionPreviewInput
): InventoryScientificProductionPreview {
  return prepare(state, input).preview;
}
export function applyInventoryScientificProduction(
  state: InventoryState,
  input: InventoryScientificProductionApplication,
  context: InventoryExecutionContext
): InventoryTransition {
  const result = prepare(state, {
    ...input,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
  });
  if (result.preview.kind === 'no-change') return { ok: true, state };
  if (result.preview.kind === 'blocked')
    return {
      ok: false,
      code: result.preview.issues[0].code,
      message: result.preview.issues[0].message,
    };
  if (!result.state || result.preview.planDigest !== input.expectedPlanDigest)
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message: 'The exact production preview changed. Preview it again.',
    };
  return { ok: true, state: result.state };
}
