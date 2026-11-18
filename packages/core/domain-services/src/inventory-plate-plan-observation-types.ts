import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryPlatePlanBinding,
  InventoryPlatePlanNormalizedBinding,
  InventoryPlatePlanIssue,
} from './inventory-plate-plan-types';
import type { InventoryScientificCitation } from './inventory-scientific-citation-types';
import type {
  InventoryScientificContextSelection,
  InventoryScientificContextSource,
  InventoryScientificTransferCommand,
  InventoryScientificVesselSnapshot,
} from './inventory-scientific-types';
import type {
  InventoryAuthority,
  InventoryPrincipal,
  InventoryRecordedPrincipal,
  InventoryStock,
  InventoryStoragePlacement,
} from './inventory-types';

export interface InventoryPlatePlanObservationIdentity {
  readonly namespace: string;
  readonly observationId: string;
}
export interface InventoryPlatePlanObservationChoices {
  readonly identity: InventoryPlatePlanObservationIdentity;
  readonly context: InventoryScientificContextSelection;
  readonly binding: InventoryPlatePlanBinding;
  readonly reason: string;
}
export interface InventoryPlatePlanObservationPlate {
  readonly id: string;
  readonly name: string;
  readonly layout: { readonly kind: 'fixed-well'; readonly rows: number; readonly columns: number };
  readonly placement: InventoryStoragePlacement;
}
export interface InventoryPlatePlanObservation {
  readonly id: string;
  readonly identity: InventoryPlatePlanObservationIdentity;
  readonly intentSha256: InventoryTableSha256;
  readonly context: InventoryScientificCitation['context'];
  readonly observation: { readonly kind: 'reported-completed-manual-plate-plan' };
  readonly binding: InventoryPlatePlanNormalizedBinding;
  readonly plate: InventoryPlatePlanObservationPlate;
  readonly actions: readonly {
    readonly actionId: string;
    readonly ordinal: number;
    readonly sourceSlotKey: string;
    readonly transfer: InventoryScientificTransferCommand;
  }[];
  readonly effects: {
    readonly sources: readonly {
      readonly sourceSlotKeys: readonly string[];
      readonly before: InventoryStock;
      readonly after: InventoryStock;
      readonly vessel: InventoryScientificVesselSnapshot;
    }[];
    readonly destinations: readonly {
      readonly actionId: string;
      readonly before: null;
      readonly after: InventoryStock;
      readonly vessel: InventoryScientificVesselSnapshot;
    }[];
  };
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
}
export interface InventoryPlatePlanObservationSummary {
  readonly id: string;
  readonly identity: InventoryPlatePlanObservationIdentity;
  readonly intentSha256: InventoryTableSha256;
  readonly versionId: string;
  readonly definitionSha256: InventoryTableSha256;
  readonly planTitle: string;
  readonly context: InventoryPlatePlanObservation['context'];
  readonly plate: Pick<InventoryPlatePlanObservationPlate, 'id' | 'name' | 'layout'>;
  readonly actionCount: number;
  readonly sourceStockCount: number;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
}
export interface InventoryPlatePlanObservationFilter {
  readonly version?: {
    readonly versionId: string;
    readonly definitionSha256: InventoryTableSha256;
  };
  readonly context?: {
    readonly kind: 'notebook-page' | 'protocol-run';
    readonly projectId: string;
    readonly workspaceScope: string;
    readonly entityId: string;
  };
}
export type InventoryPlatePlanObservationExisting =
  | { readonly kind: 'new' }
  | { readonly kind: 'no-change'; readonly observation: InventoryPlatePlanObservation }
  | { readonly kind: 'blocked'; readonly issue: InventoryPlatePlanIssue };
export interface InventoryPlatePlanObservationPreviewInput extends InventoryPlatePlanObservationChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryScientificContextSource | null;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
}
export interface InventoryPlatePlanObservationApplication extends InventoryPlatePlanObservationChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryScientificContextSource | null;
  readonly expectedPlanDigest: InventoryTableSha256;
}
interface PreviewFacts {
  readonly schema: 'dnaforge.inventory-plate-plan-observation-preview.v1';
  readonly target: InventoryTableTarget;
  readonly observationId: string | null;
  readonly intentSha256: InventoryTableSha256 | null;
  readonly sourceSha256: InventoryTableSha256 | null;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly nextBoundaryAt: number | null;
}
export type InventoryPlatePlanObservationPreview = PreviewFacts &
  (
    | {
        readonly kind: 'ready';
        readonly observation: InventoryPlatePlanObservation;
        readonly commands: readonly InventoryScientificTransferCommand[];
        readonly planDigest: InventoryTableSha256;
      }
    | {
        readonly kind: 'no-change';
        readonly observation: InventoryPlatePlanObservation;
        readonly commands: readonly [];
        readonly planDigest: null;
      }
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryPlatePlanIssue[];
        readonly observation: null;
        readonly commands: readonly [];
        readonly planDigest: null;
      }
  );
