import type {
  InventoryLocalAuthority,
  InventoryExecutionContext,
  InventoryLocalPrincipal,
  InventoryQuality,
  InventoryState,
} from './inventory-types';
import type {
  InventoryReceiveTableFields,
  InventoryTableChoices,
  InventoryTableIssue,
  InventoryTablePreview,
  InventoryTableSha256,
  InventoryTableTarget,
} from './inventory-table-types';

export interface InventoryMappedTableMaterial {
  readonly sourceId: string;
  readonly materialId: string;
}
export interface InventoryResolvedMappedTableMaterial extends InventoryMappedTableMaterial {
  readonly fingerprint: InventoryTableSha256;
}
export interface InventoryMappedTableChoices {
  readonly namespace: string;
  readonly delimiter: ',' | '\t';
  readonly columns: {
    readonly sourceId: string;
    readonly plate: string;
    readonly well: string;
  };
  readonly materials: readonly InventoryMappedTableMaterial[];
  readonly plates: readonly {
    readonly sourcePlate: string;
    readonly storageId: string;
    readonly positions: readonly { readonly sourceWell: string; readonly position: string }[];
  }[];
  readonly quantity: { readonly kind: 'unknown'; readonly reason: string };
  readonly qualities: readonly {
    readonly sourceId: string;
    readonly quality: InventoryQuality;
    readonly reason: string;
  }[];
  readonly evidenceOnlyColumns: readonly { readonly column: string; readonly reason: string }[];
  readonly skips: readonly { readonly sourceId: string; readonly reason: string }[];
}
export interface InventoryResolvedMappedTableOptions extends Omit<
  InventoryMappedTableChoices,
  'materials'
> {
  readonly materials: readonly InventoryResolvedMappedTableMaterial[];
}
export type InventoryMappedTableBindingObservation = InventoryMappedTableMaterial &
  (
    | { readonly kind: 'admitted'; readonly fingerprint: InventoryTableSha256 }
    | { readonly kind: 'unavailable'; readonly reason: string }
  );
export interface InventoryMappedSourcePlate {
  readonly sourcePlate: string;
  readonly sourceWells: readonly string[];
}
export interface InventoryMappedSourceRow {
  readonly index: number;
  readonly sourceId: string | null;
  readonly sourceFields: Readonly<Record<string, string>> | null;
  readonly sourcePlate: string | null;
  readonly sourceWell: string | null;
  readonly materialId: string | null;
  readonly vesselId: string | null;
  readonly position: string | null;
  readonly quality: InventoryQuality | null;
  readonly kind: 'normalized' | 'skipped' | 'blocked';
  readonly fields: InventoryReceiveTableFields | null;
  readonly issues: readonly InventoryTableIssue[];
}
interface InventoryMappedNormalizationFacts {
  readonly sourceSha256: InventoryTableSha256;
  readonly headers: readonly string[];
  readonly sourceIds: readonly string[];
  readonly sourcePlates: readonly InventoryMappedSourcePlate[];
  readonly rows: readonly InventoryMappedSourceRow[];
}
export type InventoryMappedTableNormalization = InventoryMappedNormalizationFacts &
  (
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryTableIssue[];
        readonly normalizedSourceText: null;
        readonly tableOptions: null;
      }
    | {
        readonly kind: 'normalized';
        readonly issues: readonly [];
        readonly normalizedSourceText: string;
        readonly tableOptions: InventoryTableChoices;
      }
  );
export interface InventoryMappedTableRowPreview extends Omit<InventoryMappedSourceRow, 'kind'> {
  readonly kind: 'create' | 'unchanged' | 'skipped' | 'blocked';
  readonly stockId: string | null;
}
interface InventoryMappedTablePreviewFacts {
  readonly schema: 'dnaforge.inventory-mapped-table-preview.v1';
  readonly sourceSha256: InventoryTableSha256;
  readonly target: InventoryTableTarget;
  readonly headers: readonly string[];
  readonly sourceIds: readonly string[];
  readonly sourcePlates: readonly InventoryMappedSourcePlate[];
  readonly rows: readonly InventoryMappedTableRowPreview[];
  readonly normalizedSourceText: string | null;
  readonly innerPreview: InventoryTablePreview | null;
}
export type InventoryMappedTablePreview = InventoryMappedTablePreviewFacts &
  (
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryTableIssue[];
        readonly options: null;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'no-change';
        readonly issues: readonly [];
        readonly options: InventoryResolvedMappedTableOptions;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'ready';
        readonly issues: readonly [];
        readonly options: InventoryResolvedMappedTableOptions;
        readonly planDigest: InventoryTableSha256;
      }
  );
export interface InventoryMappedTablePreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryMappedTableChoices;
  readonly bindings: readonly InventoryMappedTableBindingObservation[];
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
  readonly maxBytes: number;
}
export interface InventoryMappedTableApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryResolvedMappedTableOptions;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export type InventoryMappedTableState = InventoryState | null;
export type InventoryMappedTableContext = InventoryExecutionContext;
