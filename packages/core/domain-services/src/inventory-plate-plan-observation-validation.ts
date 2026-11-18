import { addInventoryAmounts, subtractInventoryAmounts } from './inventory-amount';
import { inventoryWellId, inventoryStoragePositions } from './inventory-layout';
import { inventoryTableCanonicalJson as canonical } from './inventory-table-binding';
import { inventoryPlatePlanDefinitionSha256 } from './inventory-plate-plan-identity';
import {
  inventoryStockValidityInheritance,
  emptyInventoryStockValidity,
} from './inventory-validity';
import {
  inventoryPlatePlanObservationBinding,
  inventoryPlatePlanObservationChoices,
  inventoryPlatePlanObservationId,
  inventoryPlatePlanObservationIntentSha256,
  inventoryPlatePlanObservationStockId,
} from './inventory-plate-plan-observation-identity';
import type { InventoryState } from './inventory-types';
import type { InventoryScientificVesselSnapshot } from './inventory-scientific-types';

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
function vessel(
  state: InventoryState,
  snapshot: InventoryScientificVesselSnapshot,
  stockVesselId: string
) {
  requireFact(
    snapshot.id === stockVesselId && Object.hasOwn(state.vessels, snapshot.id),
    'Observed stock requires its retained vessel identity.'
  );
  if (snapshot.kind === 'fixed-well') {
    requireFact(
      snapshot.placement.kind === 'located',
      'An observed permanent well requires its owning plate position.'
    );
    requireFact(
      snapshot.id === inventoryWellId(snapshot.placement.storageId, snapshot.placement.slotId),
      'Observed permanent-well identity must match its position.'
    );
  }
  if (snapshot.placement.kind === 'located')
    requireFact(
      Object.hasOwn(state.storage, snapshot.placement.storageId),
      'Observed vessel placement must retain its storage identity.'
    );
}
export function validateInventoryPlatePlanObservations(state: InventoryState): void {
  for (const [key, observation] of Object.entries(state.platePlanObservations)) {
    const version = state.platePlanVersions[observation.binding.versionId];
    requireFact(
      version &&
        version.definitionSha256 === observation.binding.definitionSha256 &&
        inventoryPlatePlanDefinitionSha256(version.definition) === version.definitionSha256,
      'Observed plate use must retain its exact saved plan version.'
    );
    const binding = inventoryPlatePlanObservationBinding(observation.binding, version.definition);
    requireFact(
      same(binding, observation.binding),
      'Observed plate binding must retain saved source-role order.'
    );
    requireFact(
      key === observation.id &&
        observation.id === inventoryPlatePlanObservationId(observation.identity),
      'Plate-plan observations require an exact stable occurrence identity.'
    );
    requireFact(
      observation.intentSha256 ===
        inventoryPlatePlanObservationIntentSha256(
          inventoryPlatePlanObservationChoices(observation),
          version.definition
        ),
      'Plate-plan observation intent must match its immutable choices.'
    );
    requireFact(
      observation.at >= version.at &&
        observation.at <= state.lastRecordedAt &&
        observation.context.entityId.startsWith(`${observation.context.workspaceScope}::`),
      'Observed plate use requires its saved-plan/native recording clock and scoped historical source.'
    );
    requireFact(
      observation.plate.id === binding.destinationPlateId &&
        same(observation.plate.layout, version.definition.layout),
      'Observed plate use must retain the complete matching logical geometry.'
    );
    requireFact(
      Object.hasOwn(state.storage, observation.plate.id) &&
        same(state.storage[observation.plate.id].layout, observation.plate.layout),
      'The observed physical plate geometry must remain retained.'
    );
    if (observation.plate.placement.kind === 'located')
      requireFact(
        Object.hasOwn(state.storage, observation.plate.placement.storageId),
        'Observed plate placement must retain its parent identity.'
      );
    const positions = new Set(inventoryStoragePositions(observation.plate)),
      mappings = new Map(binding.sources.map((row) => [row.sourceSlotKey, row.stockId])),
      groups = new Map<string, string[]>();
    for (const row of binding.sources)
      groups.set(row.stockId, [...(groups.get(row.stockId) ?? []), row.sourceSlotKey]);
    requireFact(
      observation.effects.sources.length === groups.size &&
        observation.actions.length === version.definition.transfers.length &&
        observation.effects.destinations.length === observation.actions.length,
      'Completed plate observations require every planned action and exact source/output effects.'
    );
    const sources = new Map(observation.effects.sources.map((row) => [row.before.id, row]));
    requireFact(
      sources.size === groups.size && same([...sources.keys()], [...groups.keys()]),
      'Observed sources must group actual stock identities in binding order.'
    );
    for (const [stockId, roles] of groups) {
      const effect = sources.get(stockId)!;
      requireFact(
        effect &&
          same(effect.sourceSlotKeys, roles) &&
          effect.after.id === stockId &&
          Object.hasOwn(state.stocks, stockId),
        'Observed source effects must retain exact stock and role identities.'
      );
      requireFact(
        effect.before.quantity.kind === 'known' &&
          effect.after.quantity.kind === 'known' &&
          effect.before.quantity.unit === 'uL' &&
          effect.after.quantity.unit === 'uL',
        'Completed plate-plan source effects require known volume balances.'
      );
      const demand = addInventoryAmounts(
        version.definition.transfers
          .filter((row) => roles.includes(row.sourceSlotKey))
          .map((row) => row.quantity),
        'uL'
      );
      requireFact(demand.kind === 'added', 'Observed source demand must be compatible.');
      const remaining = subtractInventoryAmounts(effect.before.quantity, demand.quantity);
      requireFact(
        remaining.kind === 'remaining' &&
          same(remaining.quantity, {
            value: effect.after.quantity.value,
            unit: effect.after.quantity.unit,
          }),
        'Observed source effects must retain the exact cumulative debit.'
      );
      requireFact(
        same({ ...effect.before, quantity: effect.after.quantity }, effect.after),
        'A completed plate transfer cannot rewrite other source facts.'
      );
      vessel(state, effect.vessel, effect.before.vesselId);
    }
    const outputIds = new Set<string>();
    for (const [index, planned] of version.definition.transfers.entries()) {
      const action = observation.actions[index],
        destination = observation.effects.destinations[index],
        sourceId = mappings.get(planned.sourceSlotKey)!,
        source = sources.get(sourceId)!,
        outputId = inventoryPlatePlanObservationStockId(observation.identity, planned.actionId),
        wellId = inventoryWellId(observation.plate.id, planned.destinationPosition);
      requireFact(
        action.actionId === planned.actionId &&
          action.ordinal === index + 1 &&
          action.sourceSlotKey === planned.sourceSlotKey &&
          action.transfer.reason === observation.reason,
        'Observed actions must retain exact saved instruction order and reason.'
      );
      requireFact(
        action.transfer.kind === 'transfer' &&
          action.transfer.sourceStockId === sourceId &&
          same(action.transfer.quantity, planned.quantity) &&
          action.transfer.destination.kind === 'new-stock' &&
          action.transfer.destination.stockId === outputId &&
          action.transfer.destination.vesselId === wellId,
        'Observed action must retain its exact source, volume and deterministic new aliquot.'
      );
      requireFact(
        destination.actionId === planned.actionId &&
          destination.before === null &&
          destination.after.id === outputId &&
          Object.hasOwn(state.stocks, outputId) &&
          !sources.has(outputId) &&
          !outputIds.has(outputId),
        'Observed outputs require distinct retained stocks without source chaining.'
      );
      outputIds.add(outputId);
      requireFact(
        positions.has(planned.destinationPosition) &&
          destination.vessel.kind === 'fixed-well' &&
          destination.vessel.placement.kind === 'located' &&
          destination.vessel.placement.storageId === observation.plate.id &&
          destination.vessel.placement.slotId === planned.destinationPosition &&
          destination.vessel.id === wellId,
        'Observed destination must retain its exact permanent-well position.'
      );
      vessel(state, destination.vessel, destination.after.vesselId);
      const defaults = emptyInventoryStockValidity(),
        expected = {
          ...defaults,
          incidentReviewRootIds: source.before.incidentReviewRootIds,
          inheritedValidity: inventoryStockValidityInheritance(source.before, observation.at),
          id: outputId,
          vesselId: wellId,
          materialId: source.before.materialId,
          source: source.before.source,
          lotConstraints: source.before.lotConstraints,
          quantity: { kind: 'known', ...planned.quantity },
          quality: 'usable',
          composition: source.before.composition,
        };
      requireFact(
        same(destination.after, expected),
        'Observed aliquots must preserve the exact source material, provenance, validity and credited volume.'
      );
    }
  }
}
