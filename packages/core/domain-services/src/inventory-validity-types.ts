import type { InventorySourceReference } from './inventory-configuration-types';
import type { InventoryRecordedPrincipal } from './inventory-types';

export type InventoryOpeningState =
  | { readonly kind: 'unobserved'; readonly observationId: null }
  | {
      readonly kind: 'unobserved' | 'sealed-observed' | 'opened-observed';
      readonly observationId: string;
    };

interface InventoryOpeningFacts {
  readonly id: string;
  readonly stockId: string;
  readonly source: InventorySourceReference | null;
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export type InventoryOpeningObservation = InventoryOpeningFacts &
  (
    | {
        readonly kind: 'initial';
        readonly value: 'sealed' | 'opened';
        readonly observedAt: number | null;
        readonly supersedesId: null;
      }
    | {
        readonly kind: 'opening' | 'correction';
        readonly value: 'opened';
        readonly observedAt: number | null;
        readonly supersedesId: string;
      }
    | {
        readonly kind: 'correction';
        readonly value: 'unobserved';
        readonly observedAt: null;
        readonly supersedesId: string;
      }
  );

export type InventoryValidityOwner =
  | { readonly kind: 'lot'; readonly lotId: string }
  | { readonly kind: 'stock'; readonly stockId: string };
export type InventoryValidityRule =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'not-required' }
  | { readonly kind: 'absolute'; readonly deadlineAt: number }
  | {
      readonly kind: 'after-opening';
      readonly openingStockId: string;
      readonly elapsedMs: number;
    };
export type InventoryValiditySourcePrecision =
  | 'unknown'
  | 'year'
  | 'month'
  | 'date'
  | 'instant'
  | 'elapsed-duration';
export interface InventoryValidityDecisionInput {
  readonly rule: InventoryValidityRule;
  readonly sourceText: string;
  readonly sourcePrecision: InventoryValiditySourcePrecision;
  readonly source: InventorySourceReference | null;
  readonly reason: string;
}
export interface InventoryValidityFact extends InventoryValidityDecisionInput {
  readonly id: string;
  readonly rootId: string;
  readonly supersedesId: string | null;
  readonly owner: InventoryValidityOwner;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export type InventoryValidityManagement =
  | { readonly kind: 'legacy-untracked' }
  | { readonly kind: 'managed'; readonly rootIds: readonly string[] };
export interface InventoryInheritedValidity {
  readonly rootId: string;
  readonly openingNoLaterThan: number | null;
}

interface InventoryOpeningInput {
  readonly id: string;
  readonly stockId: string;
  readonly source: InventorySourceReference | null;
  readonly reason: string;
}
export type InventoryOpeningCommand =
  | (InventoryOpeningInput & {
      readonly kind: 'record-stock-opening';
      readonly value: 'sealed' | 'opened';
      readonly observedAt: number | null;
    })
  | (InventoryOpeningInput & {
      readonly kind: 'correct-stock-opening';
      readonly supersedesId: string;
    } & (
        | { readonly value: 'opened'; readonly observedAt: number | null }
        | { readonly value: 'unobserved'; readonly observedAt: null }
      ));
export type InventoryValidityCommand =
  | (InventoryValidityDecisionInput & {
      readonly kind: 'record-validity-decision';
      readonly id: string;
      readonly owner: InventoryValidityOwner;
    })
  | (InventoryValidityDecisionInput & {
      readonly kind: 'correct-validity-decision';
      readonly id: string;
      readonly supersedesId: string;
    });

interface InventoryValidityFamilyReference {
  readonly rootId: string;
  readonly headId: string;
}
export type InventoryValidityBlocker = InventoryValidityFamilyReference &
  (
    | { readonly code: 'VALIDITY_UNRESOLVED' | 'VALIDITY_ASSESSMENT_IMPORTED' }
    | { readonly code: 'MATERIAL_EXPIRED'; readonly deadlineAt: number }
    | { readonly code: 'OPENING_REQUIRED'; readonly openingStockId: string }
    | {
        readonly code: 'OPENING_TIME_UNKNOWN';
        readonly openingStockId: string;
        readonly observationId: string | null;
      }
    | {
        readonly code: 'VALIDITY_CHRONOLOGY_CONFLICT';
        readonly openingStockId: string;
        readonly observationId: string | null;
        readonly openingNoLaterThan: number;
      }
  );
export type InventoryValidityAdmission =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'blocked';
      readonly blockers: readonly [InventoryValidityBlocker, ...InventoryValidityBlocker[]];
    };
export interface InventoryEffectiveValidityFamily extends InventoryValidityFamilyReference {
  readonly owner: InventoryValidityOwner;
  readonly rule: InventoryValidityRule;
  readonly authority: 'local' | 'imported';
  readonly state: 'not-required' | 'awaiting-opening' | 'current' | 'expired' | 'unresolved';
  readonly deadlineAt: number | null;
  readonly openingNoLaterThan: number | null;
  readonly opening: {
    readonly stockId: string;
    readonly state: InventoryOpeningState;
    readonly observation: InventoryOpeningObservation | null;
  } | null;
}
export interface InventoryStockValidity {
  readonly asOf: number;
  readonly coverage: 'legacy-untracked' | 'managed' | 'mixed';
  readonly state: 'legacy-untracked' | 'current' | 'expired' | 'unresolved';
  readonly effectiveDeadlineAt: number | null;
  readonly nextBoundaryAt: number | null;
  readonly reserve: InventoryValidityAdmission;
  readonly withdraw: InventoryValidityAdmission;
  readonly families: readonly InventoryEffectiveValidityFamily[];
}
