import type {
  InventoryLocalAuthority,
  InventoryCommand,
  InventoryLayout,
  InventoryLocalPrincipal,
  InventoryStoragePlacement,
} from './inventory-types';
import type {
  InventoryTableIssue,
  InventoryTableSha256,
  InventoryTableTarget,
} from './inventory-table-types';

export interface InventoryHierarchyBinding {
  readonly namespace: string;
  readonly sourceId: string;
  readonly rowSha256: InventoryTableSha256;
  readonly storageId: string;
  readonly destination: InventoryStoragePlacement;
}
export interface InventoryHierarchyChoices {
  readonly namespace: string;
  readonly delimiter: ',' | '\t';
  readonly parents: readonly { readonly key: string; readonly storageId: string }[];
  readonly skips: readonly { readonly sourceId: string; readonly reason: string }[];
}
export const INVENTORY_HIERARCHY_COLUMNS = [
  'source_id',
  'name',
  'layout_kind',
  'positions',
  'rows',
  'columns',
  'capacity',
  'parent_kind',
  'parent_key',
  'slot',
] as const;
export type InventoryHierarchyFields = Readonly<
  Record<(typeof INVENTORY_HIERARCHY_COLUMNS)[number], string>
>;
export interface InventoryHierarchyRowPreview {
  readonly index: number;
  readonly sourceId: string | null;
  readonly fields: InventoryHierarchyFields | null;
  readonly kind: 'create' | 'unchanged' | 'skipped' | 'blocked';
  readonly storageId: string | null;
  readonly layout: InventoryLayout | null;
  readonly destination: InventoryStoragePlacement | null;
  readonly reason: string | null;
  readonly issues: readonly InventoryTableIssue[];
}
interface InventoryHierarchyPreviewFacts {
  readonly schema: 'dnaforge.inventory-hierarchy-preview.v1';
  readonly sourceSha256: InventoryTableSha256;
  readonly target: InventoryTableTarget;
  readonly parentKeys: readonly string[];
  readonly rows: readonly InventoryHierarchyRowPreview[];
}
export type InventoryHierarchyPreview = InventoryHierarchyPreviewFacts &
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
        readonly options: InventoryHierarchyChoices;
        readonly planDigest: null;
      }
    | {
        readonly kind: 'ready';
        readonly issues: readonly [];
        readonly commands: readonly InventoryCommand[];
        readonly bindingAdditions: Readonly<Record<string, InventoryHierarchyBinding>>;
        readonly options: InventoryHierarchyChoices;
        readonly planDigest: InventoryTableSha256;
      }
  );
export interface InventoryHierarchyPreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryHierarchyChoices;
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
  readonly maxBytes: number;
}
export interface InventoryHierarchyApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryHierarchyChoices;
  readonly expectedPlanDigest: InventoryTableSha256;
}
