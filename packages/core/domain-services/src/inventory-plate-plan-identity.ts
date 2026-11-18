import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import {
  inventoryPlatePlanText,
  parseInventoryPlatePlanDefinition,
} from './inventory-plate-plan-definition';
import type { InventoryTableSha256 } from './inventory-table-types';
import type {
  InventoryPlatePlanIdentity,
  InventoryPlatePlanDefinition,
  InventoryPlatePlanVersionChoices,
  InventoryPlatePlanVersion,
} from './inventory-plate-plan-types';
function identity(value: InventoryPlatePlanIdentity): InventoryPlatePlanIdentity {
  return {
    namespace: inventoryPlatePlanText(value.namespace, 1024, 'plan namespace'),
    planId: inventoryPlatePlanText(value.planId, 1024, 'stable plan ID'),
  };
}
export function inventoryPlatePlanFamilyId(value: InventoryPlatePlanIdentity): string {
  const key = identity(value);
  return `plate-plan:${inventoryTableSha256(canonical(['dnaforge.inventory-plate-plan-family.v1', key.namespace, key.planId])).slice(7)}`;
}
export function inventoryPlatePlanDefinitionSha256(
  definition: InventoryPlatePlanDefinition
): InventoryTableSha256 {
  return inventoryTableSha256(canonical(parseInventoryPlatePlanDefinition(definition)));
}
export function inventoryPlatePlanVersionId(
  value: InventoryPlatePlanIdentity,
  definitionSha256: InventoryTableSha256
): string {
  const key = identity(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(definitionSha256))
    throw new TypeError('Plate-plan version requires an exact definition SHA.');
  return `plate-plan-version:${inventoryTableSha256(canonical(['dnaforge.inventory-plate-plan-version.v1', key.namespace, key.planId, definitionSha256])).slice(7)}`;
}
export function inventoryPlatePlanVersionSaveIntentSha256(
  choices: InventoryPlatePlanVersionChoices
): InventoryTableSha256 {
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-plate-plan-save-intent.v1',
      identity: identity(choices.identity),
      definitionSha256: inventoryPlatePlanDefinitionSha256(choices.definition),
      reason: inventoryPlatePlanText(choices.reason, 2000, 'save reason'),
    })
  );
}
export function inventoryPlatePlanVersionChoices(
  record: InventoryPlatePlanVersion
): InventoryPlatePlanVersionChoices {
  return {
    identity: { ...record.identity },
    definition: structuredClone(record.definition),
    reason: record.reason,
  };
}
