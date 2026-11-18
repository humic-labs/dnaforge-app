import { inventoryRecordedPrincipals, inventoryRecordedAuthorities } from './inventory-attribution';
import type { InventoryState } from './inventory-types';
import type { InventoryActorScope } from './inventory-organization-types';

export function inventoryHasOrganizationAttribution(state: InventoryState): boolean {
  for (const value of inventoryRecordedPrincipals(state))
    if ((value.kind === 'imported' ? value.principal : value).kind === 'organization-account')
      return true;
  for (const value of inventoryRecordedAuthorities(state))
    if ((value.kind === 'imported' ? value.authority : value).kind === 'organization-inventory')
      return true;
  return false;
}
export function assertInventoryActorScope(state: InventoryState, scope: InventoryActorScope): void {
  for (const actor of inventoryRecordedPrincipals(state)) {
    if (actor.kind === 'imported') continue;
    if (
      scope.kind === 'project-local'
        ? actor.kind === 'organization-account'
        : actor.kind !== 'organization-account' || actor.orgId !== scope.orgId
    )
      throw new TypeError('Inventory actor attribution does not match its execution scope.');
  }
  for (const authority of inventoryRecordedAuthorities(state)) {
    if (authority.kind === 'imported') continue;
    if (
      scope.kind === 'project-local'
        ? authority.kind !== 'local-profile'
        : authority.kind !== 'organization-inventory' ||
          authority.orgId !== scope.orgId ||
          authority.inventoryId !== scope.inventoryId
    )
      throw new TypeError('Inventory authority attribution does not match its execution scope.');
  }
}
