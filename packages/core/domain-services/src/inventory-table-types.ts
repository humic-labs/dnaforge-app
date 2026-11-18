import type { InventoryTableSourceRevision } from './inventory-source-revision-types';
import type {
  InventoryLocalAuthority,
  InventoryCommand,
  InventoryExecutionContext,
  InventoryLocalPrincipal,
  InventoryState,
  InventoryVesselPlacement,
} from './inventory-types';

export type InventoryTableSha256 = `sha256:${string}`;
export interface InventoryTableBinding {
  readonly sourceRevisions: readonly InventoryTableSourceRevision[];
  readonly namespace: string;
  readonly sourceId: string;
  readonly rowSha256: InventoryTableSha256;
  readonly stockId: string;
  readonly vesselId: string;
  readonly materialId: string;
  readonly destination:
    | { readonly kind: 'new-vessel'; readonly placement: InventoryVesselPlacement }
    | { readonly kind: 'existing-vessel' };
}
export interface InventoryTableMaterialChoice {
  readonly key: string;
  readonly materialId: string;
}
export interface InventoryTableResolvedMaterial extends InventoryTableMaterialChoice {
  readonly fingerprint: InventoryTableSha256;
}
export interface InventoryTableChoices {
  readonly namespace: string;
  readonly delimiter: ',' | '\t';
  readonly materials: readonly InventoryTableMaterialChoice[];
  readonly locations: readonly {
    readonly key: string;
    readonly target:
      | { readonly kind: 'unplaced' }
      | { readonly kind: 'storage'; readonly storageId: string };
  }[];
  readonly vessels: readonly { readonly key: string; readonly vesselId: string }[];
  readonly skips: readonly { readonly sourceId: string; readonly reason: string }[];
}
export interface InventoryResolvedTableOptions extends Omit<InventoryTableChoices, 'materials'> {
  readonly materials: readonly InventoryTableResolvedMaterial[];
}
export type InventoryTableBindingObservation = InventoryTableMaterialChoice &
  (
    | { readonly kind: 'admitted'; readonly fingerprint: InventoryTableSha256 }
    | { readonly kind: 'unavailable'; readonly reason: string }
  );
export interface InventoryTableTarget {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly present: boolean;
  readonly revision: number;
}
export interface InventoryTableIssue {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
}
export const INVENTORY_RECEIVE_TABLE_COLUMNS = [
  'source_id',
  'name',
  'material_key',
  'quantity_kind',
  'quantity',
  'unit',
  'quality',
  'vessel_kind',
  'vessel_key',
  'location_key',
  'slot',
] as const;
export type InventoryReceiveTableColumn = (typeof INVENTORY_RECEIVE_TABLE_COLUMNS)[number];
export type InventoryReceiveTableFields = Readonly<Record<InventoryReceiveTableColumn, string>>;
export interface InventoryTableRowPreview {
  readonly index: number;
  readonly sourceId: string | null;
  readonly fields: InventoryReceiveTableFields | null;
  readonly kind: 'create' | 'unchanged' | 'skipped' | 'blocked';
  readonly stockId: string | null;
  readonly vesselId: string | null;
  readonly reason: string | null;
  readonly issues: readonly InventoryTableIssue[];
}
interface InventoryTablePreviewFacts {
  readonly schema: 'dnaforge.inventory-table-preview.v1';
  readonly sourceSha256: InventoryTableSha256;
  readonly target: InventoryTableTarget;
  readonly rows: readonly InventoryTableRowPreview[];
  readonly materialKeys: readonly string[];
  readonly locationKeys: readonly string[];
  readonly vesselKeys: readonly string[];
  readonly bindings: readonly InventoryTableBindingObservation[];
}
export type InventoryTablePreview = InventoryTablePreviewFacts &
  (
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryTableIssue[];
        readonly commands: readonly [];
        readonly bindingAdditions: Readonly<Record<string, never>>;
        readonly options: null;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'no-change';
        readonly issues: readonly [];
        readonly commands: readonly [];
        readonly bindingAdditions: Readonly<Record<string, never>>;
        readonly options: InventoryResolvedTableOptions;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'ready';
        readonly issues: readonly [];
        readonly commands: readonly InventoryCommand[];
        readonly bindingAdditions: Readonly<Record<string, InventoryTableBinding>>;
        readonly options: InventoryResolvedTableOptions;
        readonly planDigest: InventoryTableSha256;
      }
  );
export interface InventoryTablePreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryTableChoices;
  readonly bindings: readonly InventoryTableBindingObservation[];
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
  readonly maxBytes: number;
}
export interface InventoryTableApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryResolvedTableOptions;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export type InventoryTableState = InventoryState | null;
export type InventoryTableContext = InventoryExecutionContext;
