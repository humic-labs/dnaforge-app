import { parseInventoryCommandBatch } from './inventory-validation';
import { applyInventoryOrganizationAction } from './inventory-organization';
import { applyInventoryParsedCommandBatch } from './inventory-state';
import type {
  InventoryOrganizationAction,
  InventoryOrganizationExecutionContext,
} from './inventory-organization-types';
import type { InventoryCommand, InventoryState, InventoryTransition } from './inventory-types';
export const organizationTarget = {
  kind: 'organization-inventory' as const,
  orgId: 'org',
  inventoryId: 'inventory',
};
export const organizationContext = (
  accountId = 'alice',
  at = 100
): InventoryOrganizationExecutionContext => ({
  at,
  principal: { kind: 'organization-account', orgId: 'org', accountId },
  authority: { kind: 'organization-inventory', orgId: 'org', inventoryId: 'inventory', accountId },
});
export const organizationBootstrap: InventoryOrganizationAction = {
  kind: 'bootstrap',
  reason: 'Record existing initial physical inventory',
  storage: [
    {
      kind: 'create-layout-storage',
      id: 'rack',
      name: 'Rack',
      layout: { kind: 'named', slots: ['A', 'B', 'C'] },
      placement: { kind: 'root' },
    },
  ],
  vessels: [
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Tube',
      placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
    },
  ],
  stocks: [
    {
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material',
      quantity: { value: '10', unit: 'uL' },
      quality: 'usable',
    },
  ],
};
export function organizationResult(result: InventoryTransition): InventoryState {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
export function organizationFixture(): InventoryState {
  return organizationResult(
    applyInventoryOrganizationAction(null, {
      target: organizationTarget,
      expectedRevision: 0,
      action: organizationBootstrap,
      context: organizationContext(),
      admittedMaterialIds: ['material'],
    })
  );
}
export function organizationCommands(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  accountId = 'alice',
  at = 100
) {
  return organizationResult(
    applyInventoryParsedCommandBatch(
      state,
      parseInventoryCommandBatch({ expectedRevision: state.revision, commands }),
      organizationContext(accountId, at)
    )
  );
}
