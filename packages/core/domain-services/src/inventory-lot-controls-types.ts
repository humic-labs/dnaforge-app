import type { InventorySourceReference } from './inventory-configuration-types';
import type { InventoryQuality, InventoryRecordedPrincipal } from './inventory-types';
import type { InventoryStockValidity } from './inventory-validity-types';

export interface InventoryLotConstraints {
  readonly knowledge: 'recorded' | 'legacy-partial';
  readonly lotIds: readonly string[];
}

export type InventoryLotAssessmentValue = 'unassessed' | 'released' | 'quarantined' | 'rejected';
export type InventoryLotControls =
  | { readonly kind: 'legacy-untracked' }
  | {
      readonly kind: 'managed';
      readonly assessment: {
        readonly value: InventoryLotAssessmentValue;
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
        readonly reason: string;
      };
    };

export interface InventoryLotRecall {
  readonly id: string;
  readonly lotId: string;
  readonly observedAt: number | null;
  readonly source: InventorySourceReference | null;
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly lifecycle:
    | { readonly kind: 'active' }
    | {
        readonly kind: 'withdrawn';
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
        readonly reason: string;
      };
}

export type InventoryLotControlCommand =
  | { readonly kind: 'manage-lot'; readonly lotId: string; readonly reason: string }
  | {
      readonly kind: 'assess-lot';
      readonly lotId: string;
      readonly assessment: Exclude<InventoryLotAssessmentValue, 'unassessed'>;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-lot-recall';
      readonly id: string;
      readonly lotId: string;
      readonly observedAt: number | null;
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    }
  | { readonly kind: 'withdraw-lot-recall'; readonly recallId: string; readonly reason: string };

export type InventoryLotEligibilityBlocker =
  | {
      readonly code: 'LOT_NOT_RELEASED';
      readonly lotId: string;
      readonly assessment: Exclude<InventoryLotAssessmentValue, 'released'>;
    }
  | { readonly code: 'LOT_ASSESSMENT_IMPORTED'; readonly lotId: string }
  | {
      readonly code: 'LOT_RECALLED';
      readonly lotId: string;
      readonly recallIds: readonly string[];
    };

export interface InventoryStockEligibility {
  readonly validity: InventoryStockValidity;
  readonly stockId: string;
  readonly stockQuality: InventoryQuality;
  readonly lotConstraints: InventoryLotConstraints;
  readonly coverage: 'unattributed' | 'legacy-partial' | 'legacy-untracked' | 'managed';
  readonly lots: readonly {
    readonly lotId: string;
    readonly controls: InventoryLotControls;
  }[];
  readonly activeRecallIds: readonly string[];
  readonly blockers: readonly (
    | InventoryLotEligibilityBlocker
    | { readonly code: 'STOCK_QUARANTINED' }
  )[];
}
