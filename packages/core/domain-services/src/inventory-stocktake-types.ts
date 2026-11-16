import type {
  InventoryAuthority,
  InventoryCommand,
  InventoryItemCustody,
  InventoryPrincipal,
  InventoryQuantity,
  InventoryStockAvailability,
} from './inventory-types';
import type {
  InventoryObservation,
  InventoryObservationFact,
  InventoryObservationSubject,
} from './inventory-observation-types';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';

export interface InventoryStocktakeChoices {
  readonly namespace: string;
  readonly delimiter: ',' | '\t';
  readonly subjects: readonly {
    readonly key: string;
    readonly subject: InventoryObservationSubject;
  }[];
  readonly locations: readonly {
    readonly key: string;
    readonly target:
      | { readonly kind: 'root' }
      | { readonly kind: 'unplaced' }
      | { readonly kind: 'storage'; readonly storageId: string }
      | { readonly kind: 'stack-top'; readonly stackId: string };
  }[];
  readonly decisions: readonly {
    readonly observationId: string;
    readonly choice:
      | { readonly kind: 'record-only' }
      | { readonly kind: 'apply'; readonly reason: string }
      | { readonly kind: 'skip'; readonly reason: string };
  }[];
}
export const INVENTORY_STOCKTAKE_COLUMNS = [
  'observation_id',
  'subject_key',
  'observed_at',
  'quantity_kind',
  'quantity',
  'unit',
  'presence',
  'location_key',
  'slot',
  'reason',
] as const;
export type InventoryStocktakeFields = Readonly<
  Record<(typeof INVENTORY_STOCKTAKE_COLUMNS)[number], string>
>;
export interface InventoryStocktakeIssue {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
}
export interface InventoryStocktakeSubjectSnapshot {
  readonly quantity: InventoryQuantity | null;
  readonly custody: InventoryItemCustody | null;
  readonly availability: InventoryStockAvailability | null;
}
export interface InventoryStocktakeRowPreview {
  readonly index: number;
  readonly observationId: string | null;
  readonly observationKey: string | null;
  readonly fields: InventoryStocktakeFields | null;
  readonly kind: 'record' | 'apply' | 'unchanged' | 'skipped' | 'blocked';
  readonly subject: InventoryObservationSubject | null;
  readonly fact: InventoryObservationFact | null;
  readonly observedAt: number | null;
  readonly existing: InventoryObservation | null;
  readonly before: InventoryStocktakeSubjectSnapshot | null;
  readonly after: InventoryStocktakeSubjectSnapshot | null;
  readonly issues: readonly InventoryStocktakeIssue[];
}
interface InventoryStocktakePreviewFacts {
  readonly schema: 'dnaforge.inventory-stocktake-preview.v1';
  readonly sourceSha256: InventoryTableSha256;
  readonly target: InventoryTableTarget;
  readonly subjectKeys: readonly string[];
  readonly locationKeys: readonly string[];
  readonly rows: readonly InventoryStocktakeRowPreview[];
}
export type InventoryStocktakePreview = InventoryStocktakePreviewFacts &
  (
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryStocktakeIssue[];
        readonly commands: readonly [];
        readonly options: null;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'no-change';
        readonly issues: readonly [];
        readonly commands: readonly [];
        readonly options: InventoryStocktakeChoices;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'ready';
        readonly issues: readonly [];
        readonly commands: readonly InventoryCommand[];
        readonly options: InventoryStocktakeChoices;
        readonly planDigest: InventoryTableSha256;
      }
  );
export interface InventoryStocktakePreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryStocktakeChoices;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
  readonly maxBytes: number;
}
export interface InventoryStocktakeApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryStocktakeChoices;
  readonly expectedPlanDigest: InventoryTableSha256;
}
