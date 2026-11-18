import { addInventoryAmounts } from './inventory-amount';
import { applyInventoryCommandBatch } from './inventory-state';
import { inventoryStockAvailabilityFacts } from './inventory-reservations';
import { inventoryItemCustody } from './inventory-custody';
import { inventoryStoragePositions, inventoryWellId } from './inventory-layout';
import { inventoryRecordIdExists } from './inventory-identity';
import { parseInventoryExecutionContext } from './inventory-validation';
import {
  parseInventoryPlatePlanDefinition,
  inventoryPlatePlanText,
} from './inventory-plate-plan-definition';
import { inventoryPlatePlanDefinitionSha256 } from './inventory-plate-plan-identity';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryState, InventoryCommand } from './inventory-types';
import type {
  InventoryPlatePlanBindingPreviewInput,
  InventoryPlatePlanBindingPreview,
  InventoryPlatePlanSourceDemandFacts,
  InventoryPlatePlanNormalizedBinding,
  InventoryPlatePlanIssue,
} from './inventory-plate-plan-types';
import type { InventoryTableSha256 } from './inventory-table-types';
export function inventoryPlatePlanBindingPreview(
  state: InventoryState,
  input: InventoryPlatePlanBindingPreviewInput
): InventoryPlatePlanBindingPreview {
  let bindingSha256: InventoryTableSha256 | null = null,
    nextBoundaryAt: number | null = null,
    normalized: InventoryPlatePlanNormalizedBinding | null = null;
  const sources: InventoryPlatePlanSourceDemandFacts[] = [],
    observedTarget = { ...input.target, present: state.revision !== 0, revision: state.revision };
  const facts = () => ({
    schema: 'dnaforge.inventory-plate-plan-binding-preview.v1' as const,
    target: observedTarget,
    versionId: input.binding.versionId,
    definitionSha256: input.binding.definitionSha256,
    bindingSha256,
    asOf: input.asOf,
    principal: structuredClone(input.principal),
    nextBoundaryAt,
  });
  const blocked = (
    code: InventoryPlatePlanIssue['code'],
    pointer: string,
    message: string
  ): InventoryPlatePlanBindingPreview => ({
    ...facts(),
    kind: 'blocked',
    issues: [{ code, pointer, message }],
    sources: structuredClone(sources),
    binding: normalized,
  });
  const boundary = (at: number | null) => {
    if (at !== null && at > input.asOf)
      nextBoundaryAt = nextBoundaryAt === null ? at : Math.min(nextBoundaryAt, at);
  };
  try {
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (input.target.revision !== state.revision || input.target.present !== observedTarget.present)
      return blocked(
        'REVISION_CONFLICT',
        '/target',
        'The inventory changed. Check the binding again.'
      );
    if (context.at < state.lastRecordedAt)
      return blocked(
        'CLOCK_REGRESSION',
        '/target',
        'The trusted timestamp precedes the inventory clock floor.'
      );
    const version = state.platePlanVersions[input.binding.versionId];
    if (
      !version ||
      version.definitionSha256 !== input.binding.definitionSha256 ||
      inventoryPlatePlanDefinitionSha256(version.definition) !== version.definitionSha256
    )
      return blocked(
        'PLATE_PLAN_VERSION_MISMATCH',
        '/binding/versionId',
        'Choose the exact saved plan version and definition pin.'
      );
    const definition = parseInventoryPlatePlanDefinition(version.definition),
      slots = new Set(definition.sourceSlots.map((row) => row.key)),
      mappings = new Map<string, string>();
    for (const row of input.binding.sources) {
      inventoryPlatePlanText(row.sourceSlotKey, 512, 'source role');
      inventoryPlatePlanText(row.stockId, 512, 'source stock ID');
      if (!slots.has(row.sourceSlotKey) || mappings.has(row.sourceSlotKey))
        return blocked(
          'INVALID_INVENTORY_INPUT',
          '/binding/sources',
          'Map every exact source role once, without extra or duplicate roles.'
        );
      mappings.set(row.sourceSlotKey, row.stockId);
    }
    if (mappings.size !== slots.size)
      return blocked(
        'INVALID_INVENTORY_INPUT',
        '/binding/sources',
        'Every declared source role needs one explicit stock binding.'
      );
    inventoryPlatePlanText(input.binding.destinationPlateId, 512, 'physical plate ID');
    normalized = {
      versionId: version.id,
      definitionSha256: version.definitionSha256,
      destinationPlateId: input.binding.destinationPlateId,
      sources: definition.sourceSlots.map((slot) => ({
        sourceSlotKey: slot.key,
        stockId: mappings.get(slot.key)!,
      })),
    };
    bindingSha256 = inventoryTableSha256(
      canonical([
        'dnaforge.inventory-plate-plan-binding.v1',
        input.target.projectId,
        input.target.inventoryId,
        normalized,
      ])
    );
    const grouped = new Map<string, string[]>();
    for (const row of normalized.sources)
      grouped.set(row.stockId, [...(grouped.get(row.stockId) ?? []), row.sourceSlotKey]);
    for (const [stockId, sourceSlotKeys] of grouped) {
      const stock = state.stocks[stockId];
      if (!stock)
        return blocked(
          'STOCK_NOT_FOUND',
          '/binding/sources',
          'Choose an existing source stock from the captured inventory.'
        );
      const vessel = state.vessels[stock.vesselId],
        availability = inventoryStockAvailabilityFacts(
          state,
          stockId,
          context.principal,
          context.at
        ).availability;
      const demand = addInventoryAmounts(
        definition.transfers
          .filter((row) => sourceSlotKeys.includes(row.sourceSlotKey))
          .map((row) => row.quantity),
        'uL'
      );
      if (demand.kind !== 'added' || demand.quantity.unit !== 'uL')
        return blocked(
          'QUANTITY_DIMENSION_MISMATCH',
          '/binding/sources',
          'Plan demand must use volume amounts.'
        );
      sources.push(
        structuredClone({
          sourceSlotKeys,
          stock,
          vessel,
          availability,
          demand: { value: demand.quantity.value, unit: 'uL' },
        })
      );
      boundary(availability.validity.nextBoundaryAt);
      for (const id of availability.reservationIds) {
        const reservation = state.reservations[id];
        if (reservation?.lifecycle.kind === 'active') boundary(reservation.deadline);
      }
      const custody = inventoryItemCustody(
        state,
        { kind: 'vessel', id: vessel.id },
        context.principal,
        context.at
      ).state;
      if (custody.kind === 'checked-out') boundary(custody.dueAt);
    }
    const plate = state.storage[normalized.destinationPlateId];
    if (!plate)
      return blocked(
        'STORAGE_NOT_FOUND',
        '/binding/destinationPlateId',
        'Choose an existing physical plate.'
      );
    if (plate.lifecycle !== 'active')
      return blocked(
        'STORAGE_DISPOSED',
        '/binding/destinationPlateId',
        'The selected physical plate is disposed.'
      );
    if (
      plate.layout.kind !== 'fixed-well' ||
      plate.layout.rows !== definition.layout.rows ||
      plate.layout.columns !== definition.layout.columns
    )
      return blocked(
        'INCOMPATIBLE_LAYOUT',
        '/binding/destinationPlateId',
        'The physical fixed-well layout must exactly match the saved definition.'
      );
    const custody = inventoryItemCustody(
      state,
      { kind: 'storage', id: plate.id },
      context.principal,
      context.at
    ).state;
    if (custody.kind === 'checked-out') boundary(custody.dueAt);
    const positions = new Set(inventoryStoragePositions(plate));
    const destinations = definition.transfers.map((row, index) => ({
      actionId: row.actionId,
      ordinal: index + 1,
      position: row.destinationPosition,
      vesselId: inventoryWellId(plate.id, row.destinationPosition),
    }));
    for (const row of destinations) {
      const vessel = state.vessels[row.vesselId];
      if (
        !positions.has(row.position) ||
        !vessel ||
        vessel.kind !== 'fixed-well' ||
        vessel.placement.kind !== 'located' ||
        vessel.placement.storageId !== plate.id ||
        vessel.placement.slotId !== row.position
      )
        return blocked(
          'INCOMPATIBLE_LAYOUT',
          '/binding/destinationPlateId',
          'The permanent destination well does not match its plate owner.'
        );
    }
    const commands: InventoryCommand[] = [];
    for (const [index, transfer] of definition.transfers.entries()) {
      const stockId = `plate-plan-simulation:${inventoryTableSha256(canonical(['dnaforge.inventory-plate-plan-simulation.v1', input.target.projectId, input.target.inventoryId, version.id, bindingSha256, transfer.actionId])).slice(7)}`;
      if (inventoryRecordIdExists(state, stockId))
        return blocked(
          'ID_ALREADY_EXISTS',
          '/binding',
          'A transient simulation identifier collides with an existing inventory record.'
        );
      commands.push({
        kind: 'transfer',
        sourceStockId: mappings.get(transfer.sourceSlotKey)!,
        quantity: transfer.quantity,
        destination: { kind: 'new-stock', stockId, vesselId: destinations[index].vesselId },
        reason: 'Read-only plate-plan feasibility simulation',
      });
    }
    const simulated = applyInventoryCommandBatch(
      structuredClone(state),
      { expectedRevision: state.revision, commands },
      context
    );
    if (!simulated.ok) return blocked(simulated.code, '/binding', simulated.message);
    const projected = sources.map((row) => {
      const remaining = simulated.state.stocks[row.stock.id].quantity;
      if (remaining.kind !== 'known' || remaining.unit !== 'uL')
        throw new TypeError('Successful volume simulation requires a known remaining volume.');
      return { ...row, projectedRemaining: { value: remaining.value, unit: 'uL' as const } };
    });
    return {
      ...facts(),
      kind: 'ready',
      binding: normalized,
      plate: structuredClone(plate),
      sources: projected,
      destinations,
    };
  } catch (error) {
    return blocked(
      'INVALID_INVENTORY_INPUT',
      '/binding',
      error instanceof Error ? error.message : 'The plan binding is invalid.'
    );
  }
}
