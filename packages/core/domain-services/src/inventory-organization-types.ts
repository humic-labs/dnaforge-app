import type { InventoryAmount } from './inventory-amount';
import type { InventoryCommand, InventoryQuality } from './inventory-types';

export type InventoryActorScope =
  | { readonly kind: 'project-local' }
  | {
      readonly kind: 'organization-inventory';
      readonly orgId: string;
      readonly inventoryId: string;
    };
export type InventoryOrganizationTarget = Extract<
  InventoryActorScope,
  { kind: 'organization-inventory' }
>;
export interface InventoryOrganizationPrincipal {
  readonly kind: 'organization-account';
  readonly orgId: string;
  readonly accountId: string;
}
export interface InventoryOrganizationAuthority {
  readonly kind: 'organization-inventory';
  readonly orgId: string;
  readonly inventoryId: string;
  readonly accountId: string;
}
export interface InventoryOrganizationExecutionContext {
  readonly at: number;
  readonly principal: InventoryOrganizationPrincipal;
  readonly authority: InventoryOrganizationAuthority;
}
export interface InventoryOrganizationBootstrapAction {
  readonly kind: 'bootstrap';
  readonly reason: string;
  readonly storage: readonly Extract<InventoryCommand, { kind: 'create-layout-storage' }>[];
  readonly vessels: readonly Extract<InventoryCommand, { kind: 'create-vessel' }>[];
  readonly stocks: readonly {
    readonly id: string;
    readonly vesselId: string;
    readonly materialId: string;
    readonly quantity: InventoryAmount;
    readonly quality: InventoryQuality;
  }[];
}
export type InventoryOrganizationAction =
  | Extract<InventoryCommand, { kind: 'consume' | 'move-storage' | 'move-vessel' }>
  | InventoryOrganizationBootstrapAction;
