import type {
  InventoryLocalAuthority,
  InventoryExecutionContext,
  InventoryItemCustody,
  InventoryLocalPrincipal,
  InventoryRecordedPrincipal,
  InventoryState,
  InventoryStock,
  InventoryStockAvailability,
  InventoryVessel,
} from './inventory-types';
import type {
  InventoryReceiveTableFields,
  InventoryTableBinding,
  InventoryTableChoices,
  InventoryTableIssue,
  InventoryTableSha256,
  InventoryTableTarget,
} from './inventory-table-types';

export interface InventoryTableSourceRevision {
  readonly previousRowSha256: InventoryTableSha256;
  readonly rowSha256: InventoryTableSha256;
  readonly fields: InventoryReceiveTableFields;
  readonly destination: InventoryTableBinding['destination'];
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}

export interface InventorySourceRevisionAcknowledgement {
  readonly sourceId: string;
  readonly expectedPreviousRowSha256: InventoryTableSha256;
  readonly reason: string;
}

export interface InventorySourceRevisionPreimage {
  readonly sourceId: string;
  readonly fields: InventoryReceiveTableFields;
}

export interface InventorySourceRevisionChoices {
  readonly table: InventoryTableChoices;
  readonly acknowledgements: readonly InventorySourceRevisionAcknowledgement[];
}

export interface InventoryResolvedSourceRevisionOptions extends InventorySourceRevisionChoices {
  readonly preimages: readonly InventorySourceRevisionPreimage[];
}

export interface InventorySourceRevisionActual {
  readonly stock: InventoryStock;
  readonly vessel: InventoryVessel;
  readonly custody: InventoryItemCustody;
  readonly availability: InventoryStockAvailability;
}

export interface InventorySourceRevisionRowPreview {
  readonly index: number;
  readonly sourceId: string | null;
  readonly bindingKey: string | null;
  readonly kind: 'unchanged' | 'needs-acknowledgement' | 'proposed' | 'skipped' | 'blocked';
  readonly previousRowSha256: InventoryTableSha256 | null;
  readonly previousFields: InventoryReceiveTableFields | null;
  readonly revisedFields: InventoryReceiveTableFields | null;
  readonly binding: InventoryTableBinding | null;
  readonly destination: InventoryTableBinding['destination'] | null;
  readonly actual: InventorySourceRevisionActual | null;
  readonly reason: string | null;
  readonly issues: readonly InventoryTableIssue[];
}

interface InventorySourceRevisionPreviewFacts {
  readonly schema: 'dnaforge.inventory-source-revision-preview.v1';
  readonly sourceSha256: InventoryTableSha256;
  readonly target: InventoryTableTarget;
  readonly materialKeys: readonly string[];
  readonly locationKeys: readonly string[];
  readonly vesselKeys: readonly string[];
  readonly rows: readonly InventorySourceRevisionRowPreview[];
}

export type InventorySourceRevisionPreview = InventorySourceRevisionPreviewFacts &
  (
    | {
        readonly kind: 'blocked' | 'needs-acknowledgement';
        readonly issues: readonly InventoryTableIssue[];
        readonly options: null;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'no-change';
        readonly issues: readonly [];
        readonly options: InventoryResolvedSourceRevisionOptions;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'ready';
        readonly issues: readonly [];
        readonly options: InventoryResolvedSourceRevisionOptions;
        readonly planDigest: InventoryTableSha256;
      }
  );

export interface InventorySourceRevisionPreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventorySourceRevisionChoices;
  readonly preimages: readonly InventorySourceRevisionPreimage[];
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
  readonly maxBytes: number;
}

export interface InventorySourceRevisionApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryResolvedSourceRevisionOptions;
  readonly expectedPlanDigest: InventoryTableSha256;
}

export type InventorySourceRevisionState = InventoryState | null;
export type InventorySourceRevisionContext = InventoryExecutionContext;
