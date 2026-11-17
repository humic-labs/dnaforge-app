import type { InventoryAmount, InventoryCanonicalAmount } from './inventory-amount';
import type {
  InventoryAvailabilityBlocker,
  InventoryRecordedPrincipal,
  InventorySourceReference,
} from './inventory-types';

export interface InventoryExpectedDelivery {
  readonly id: string;
  readonly name: string;
  readonly supplier: string | null;
  readonly externalReference: InventorySourceReference | null;
  readonly expectation: {
    readonly materialId: string;
    readonly quantity: InventoryCanonicalAmount;
  };
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
  readonly lifecycle:
    | { readonly kind: 'open' }
    | {
        readonly kind: 'remainder-closed';
        readonly remainingAtClose: InventoryCanonicalAmount;
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
        readonly reason: string;
      };
}
export interface InventoryArrivalAllocation {
  readonly id: string;
  readonly lineId: string;
  readonly arrivalId: string;
  readonly componentKey: string;
  readonly quantity: InventoryCanonicalAmount;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
  readonly lifecycle:
    | { readonly kind: 'active' }
    | {
        readonly kind: 'withdrawn';
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
        readonly reason: string;
      };
}
export type InventoryReorderValidityBasis = 'current-recorded-rules' | 'confirmed-current-validity';
export type InventoryReorderActionBasis = 'reserve' | 'withdraw';
export interface InventoryReorderRule {
  readonly id: string;
  readonly name: string;
  readonly materialId: string;
  readonly threshold: InventoryCanonicalAmount;
  readonly validityBasis: InventoryReorderValidityBasis;
  readonly actionBasis: InventoryReorderActionBasis;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
  readonly lifecycle:
    | { readonly kind: 'active' }
    | {
        readonly kind: 'retired';
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
        readonly reason: string;
      };
}
export type InventoryStockroomCommand =
  | {
      readonly kind: 'record-expected-delivery';
      readonly id: string;
      readonly name: string;
      readonly supplier: string | null;
      readonly externalReference: InventorySourceReference | null;
      readonly materialId: string;
      readonly quantity: InventoryAmount;
      readonly reason: string;
    }
  | {
      readonly kind: 'allocate-arrival';
      readonly id: string;
      readonly lineId: string;
      readonly arrivalId: string;
      readonly componentKey: string;
      readonly quantity: InventoryAmount;
      readonly reason: string;
    }
  | {
      readonly kind: 'withdraw-arrival-allocation';
      readonly allocationId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'close-expected-delivery-remainder';
      readonly lineId: string;
      readonly reason: string;
    }
  | { readonly kind: 'reopen-expected-delivery'; readonly lineId: string; readonly reason: string }
  | {
      readonly kind: 'record-reorder-rule';
      readonly id: string;
      readonly name: string;
      readonly materialId: string;
      readonly threshold: InventoryAmount;
      readonly validityBasis: InventoryReorderValidityBasis;
      readonly actionBasis: InventoryReorderActionBasis;
      readonly reason: string;
    }
  | { readonly kind: 'retire-reorder-rule'; readonly ruleId: string; readonly reason: string };

export interface InventoryExpectedDeliveryProgress {
  readonly line: InventoryExpectedDelivery;
  readonly allocated: InventoryCanonicalAmount;
  readonly remaining: InventoryCanonicalAmount;
  readonly progress: 'none-received' | 'partly-received' | 'fully-received';
  readonly allocationIds: readonly string[];
}
export interface InventoryArrivalAllocationBalance {
  readonly arrivalId: string;
  readonly componentKey: string;
  readonly materialId: string;
  readonly received: InventoryCanonicalAmount;
  readonly allocated: InventoryCanonicalAmount;
  readonly unmatched: InventoryCanonicalAmount;
  readonly allocationIds: readonly string[];
}
export interface InventoryReorderExclusion {
  readonly stockId: string;
  readonly blockers: readonly InventoryAvailabilityBlocker[];
  readonly coverageReason: 'validity-not-confirmed' | null;
}
export interface InventoryReorderAssessment {
  readonly rule: InventoryReorderRule;
  readonly knownUnreserved: InventoryCanonicalAmount;
  readonly knownUnreservedKind: 'exact' | 'at-least';
  readonly conclusion: 'adequate' | 'low' | 'needs-measurement';
  readonly knownIncludedStockIds: readonly string[];
  readonly unknownIncludedStockIds: readonly string[];
  readonly excluded: readonly InventoryReorderExclusion[];
  readonly incompatibleStockIds: readonly string[];
  readonly legacyOrMixedValidityStockIds: readonly string[];
  readonly nextBoundaryAt: number | null;
}
export type InventoryReorderAssessmentResult =
  | { readonly kind: 'ready'; readonly assessment: InventoryReorderAssessment }
  | { readonly kind: 'retired'; readonly rule: InventoryReorderRule }
  | {
      readonly kind: 'unavailable';
      readonly rule: InventoryReorderRule;
      readonly code: string;
      readonly message: string;
    };
export interface InventoryStockroomProjection {
  readonly expectedDeliveries: Readonly<Record<string, InventoryExpectedDeliveryProgress>>;
  readonly arrivalComponents: readonly InventoryArrivalAllocationBalance[];
  readonly reorderRules: Readonly<Record<string, InventoryReorderAssessmentResult>>;
}
