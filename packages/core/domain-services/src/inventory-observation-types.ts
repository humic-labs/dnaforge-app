import type {
  InventoryCustodyDestination,
  InventoryPhysicalItem,
  InventoryQuantity,
  InventoryRecordedPrincipal,
} from './inventory-types';

export type InventoryObservationSubject =
  | { readonly kind: 'stock'; readonly stockId: string }
  | { readonly kind: 'item'; readonly item: InventoryPhysicalItem };
export type InventoryObservationFact =
  | { readonly kind: 'quantity'; readonly quantity: InventoryQuantity }
  | { readonly kind: 'presence'; readonly value: 'missing' }
  | {
      readonly kind: 'presence';
      readonly value: 'found';
      readonly destination: InventoryCustodyDestination;
    };
export interface InventoryObservationInput {
  readonly namespace: string;
  readonly observationId: string;
  readonly subject: InventoryObservationSubject;
  readonly observedAt: number | null;
  readonly fact: InventoryObservationFact;
  readonly reason: string;
}
export interface InventoryObservation extends InventoryObservationInput {
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly application:
    | { readonly kind: 'unapplied' }
    | {
        readonly kind: 'applied';
        readonly reason: string;
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
      };
}
export type InventoryObservationCommand =
  | ({ readonly kind: 'record-inventory-observation' } & InventoryObservationInput)
  | {
      readonly kind: 'apply-inventory-observation';
      readonly observationKey: string;
      readonly reason: string;
    };
