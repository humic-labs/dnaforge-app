import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import {
  inventoryPlatePlanText,
  parseInventoryPlatePlanDefinition,
} from './inventory-plate-plan-definition';
import { inventoryPlatePlanDefinitionSha256 } from './inventory-plate-plan-identity';
import type {
  InventoryPlatePlanDefinition,
  InventoryPlatePlanNormalizedBinding,
} from './inventory-plate-plan-types';
import type {
  InventoryPlatePlanObservation,
  InventoryPlatePlanObservationChoices,
  InventoryPlatePlanObservationIdentity,
} from './inventory-plate-plan-observation-types';

export function inventoryPlatePlanObservationId(
  identity: InventoryPlatePlanObservationIdentity
): string {
  inventoryPlatePlanText(identity.namespace, 1024, 'observation namespace');
  inventoryPlatePlanText(identity.observationId, 1024, 'stable occurrence identity');
  return `plate-plan-observation:${inventoryTableSha256(canonical(['dnaforge.inventory-plate-plan-observation.v1', identity.namespace, identity.observationId])).slice(7)}`;
}
export function inventoryPlatePlanObservationStockId(
  identity: InventoryPlatePlanObservationIdentity,
  actionId: string
): string {
  inventoryPlatePlanText(actionId, 512, 'saved action identity');
  return `plate-plan-observation-stock:${inventoryTableSha256(canonical(['dnaforge.inventory-plate-plan-observation-stock.v1', inventoryPlatePlanObservationId(identity), actionId])).slice(7)}`;
}
export function inventoryPlatePlanObservationBinding(
  binding: InventoryPlatePlanNormalizedBinding,
  definition: InventoryPlatePlanDefinition
): InventoryPlatePlanNormalizedBinding {
  const admitted = parseInventoryPlatePlanDefinition(definition);
  inventoryPlatePlanText(binding.versionId, 512, 'saved plan version');
  inventoryPlatePlanText(binding.destinationPlateId, 512, 'physical destination plate');
  if (binding.definitionSha256 !== inventoryPlatePlanDefinitionSha256(admitted))
    throw new TypeError('The exact saved plan definition pin is required.');
  const roles = new Set(admitted.sourceSlots.map((row) => row.key)),
    mappings = new Map<string, string>();
  for (const row of binding.sources) {
    inventoryPlatePlanText(row.stockId, 512, 'source stock identity');
    if (!roles.has(row.sourceSlotKey) || mappings.has(row.sourceSlotKey))
      throw new TypeError('Every exact source role must be mapped once.');
    mappings.set(row.sourceSlotKey, row.stockId);
  }
  if (mappings.size !== roles.size)
    throw new TypeError('Every declared source role requires an explicit stock binding.');
  return {
    versionId: binding.versionId,
    definitionSha256: binding.definitionSha256,
    destinationPlateId: binding.destinationPlateId,
    sources: admitted.sourceSlots.map((row) => ({
      sourceSlotKey: row.key,
      stockId: mappings.get(row.key)!,
    })),
  };
}
export function inventoryPlatePlanObservationIntentSha256(
  input: InventoryPlatePlanObservationChoices,
  definition: InventoryPlatePlanDefinition
) {
  inventoryPlatePlanObservationId(input.identity);
  inventoryPlatePlanText(input.reason, 2000, 'completed manual occurrence reason');
  inventoryPlatePlanText(input.context.entityId, 512, 'saved scientific context identity');
  if (
    (input.context.kind !== 'notebook-page' && input.context.kind !== 'protocol-run') ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.context.sourceSha256)
  )
    throw new TypeError('Choose an exact saved Notebook or Protocol Run source.');
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-plate-plan-observation-intent.v1',
      identity: { ...input.identity },
      context: { ...input.context },
      binding: inventoryPlatePlanObservationBinding(input.binding, definition),
      reason: input.reason,
    })
  );
}
export function inventoryPlatePlanObservationChoices(
  record: InventoryPlatePlanObservation
): InventoryPlatePlanObservationChoices {
  return structuredClone({
    identity: record.identity,
    context: {
      kind: record.context.kind,
      entityId: record.context.entityId,
      sourceSha256: record.context.source.sha256,
    },
    binding: record.binding,
    reason: record.reason,
  });
}
