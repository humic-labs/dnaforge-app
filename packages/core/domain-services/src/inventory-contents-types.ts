import type {
  InventoryQuantityInput,
  InventoryQuality,
  InventoryRecordedPrincipal,
} from './inventory-types';

export type InventoryContentsKnowledge =
  | { readonly kind: 'recorded' }
  | {
      readonly kind: 'unobserved' | 'unidentified';
      readonly reason: string;
      readonly at: number;
      readonly by: InventoryRecordedPrincipal;
    };

export type InventoryVesselContents =
  | { readonly kind: 'declared-empty' }
  | { readonly kind: 'identified'; readonly stockId: string }
  | Exclude<InventoryContentsKnowledge, { readonly kind: 'recorded' }>;

export type InventoryContentsCommand =
  | {
      readonly kind: 'record-vessel-contents';
      readonly vesselId: string;
      readonly knowledge: 'unobserved' | 'unidentified';
      readonly reason: string;
    }
  | {
      readonly kind: 'record-vessels-contents';
      readonly vesselIds: readonly string[];
      readonly knowledge: 'unobserved' | 'unidentified';
      readonly reason: string;
    }
  | { readonly kind: 'declare-vessel-empty'; readonly vesselId: string; readonly reason: string }
  | {
      readonly kind: 'identify-vessel-stock';
      readonly id: string;
      readonly vesselId: string;
      readonly materialId: string;
      readonly quantity: InventoryQuantityInput;
      readonly quality: InventoryQuality;
      readonly reason: string;
    };
