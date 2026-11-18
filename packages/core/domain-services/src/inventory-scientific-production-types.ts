import type { ScientificAcceptedDocumentRevision } from './scientific-documents';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryScientificContextSelection,
  InventoryScientificRunContext,
  InventoryProtocolRunSavedSource,
  InventoryScientificVesselSnapshot,
} from './inventory-scientific-types';
import type { InventoryCanonicalAmount } from './inventory-amount';
import type {
  InventoryStock,
  InventoryLot,
  InventoryCommand,
  InventoryErrorCode,
  InventoryRecordedPrincipal,
  InventoryLocalPrincipal,
  InventoryLocalAuthority,
} from './inventory-types';
export type AcceptedDnaProductionRevision = Omit<
  ScientificAcceptedDocumentRevision,
  'sequenceEditParentEventId'
>;
export interface AcceptedDnaProductionSelection {
  readonly scientificWorkspaceId: string;
  readonly revision: AcceptedDnaProductionRevision;
}
export interface VerifiedAcceptedDnaProductionBinding {
  readonly kind: 'accepted-dna-design';
  readonly owner: {
    readonly projectId: string;
    readonly workspaceScope: string;
    readonly scientificWorkspaceId: string;
  };
  readonly selection: AcceptedDnaProductionSelection;
  readonly document: {
    readonly name: string;
    readonly molecule: 'DNA';
    readonly length: number;
    readonly topology: 'linear' | 'circular';
    readonly scientificSha256: InventoryTableSha256;
  };
}
export interface InventoryScientificProductionIdentity {
  readonly namespace: string;
  readonly productionId: string;
}
export interface InventoryScientificProductionChoices {
  readonly identity: InventoryScientificProductionIdentity;
  readonly context: Extract<InventoryScientificContextSelection, { kind: 'protocol-run' }>;
  readonly design: AcceptedDnaProductionSelection;
  readonly inputs: readonly {
    readonly stockId: string;
    readonly quantity: InventoryCanonicalAmount;
  }[];
  readonly output: {
    readonly vesselId: string;
    readonly quantity: InventoryCanonicalAmount;
    readonly lotName: string;
  };
  readonly method: string;
  readonly reason: string;
}
export interface InventoryScientificProduction {
  readonly id: string;
  readonly identity: InventoryScientificProductionIdentity;
  readonly intentSha256: InventoryTableSha256;
  readonly observation: { readonly kind: 'reported-completed-manual-production' };
  readonly context: InventoryScientificRunContext;
  readonly design: VerifiedAcceptedDnaProductionBinding;
  readonly materialBinding: {
    readonly sourceMaterialId: string;
    readonly destinationMaterialId: string;
  };
  readonly inputs: InventoryScientificProductionChoices['inputs'];
  readonly output: {
    readonly lotId: string;
    readonly stockId: string;
    readonly vesselId: string;
    readonly quantity: InventoryCanonicalAmount;
  };
  readonly effects: {
    readonly sources: readonly {
      readonly before: InventoryStock;
      readonly after: InventoryStock;
      readonly vessel: InventoryScientificVesselSnapshot;
    }[];
    readonly lot: { readonly before: null; readonly after: InventoryLot };
    readonly stock: {
      readonly before: null;
      readonly after: InventoryStock;
      readonly vessel: InventoryScientificVesselSnapshot;
    };
  };
  readonly method: string;
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export type InventoryScientificProductionCommand = Extract<
  InventoryCommand,
  { kind: 'consume' | 'create-lot' | 'manage-lot' | 'receive-lot-stock' }
>;
export interface InventoryScientificProductionIssue {
  readonly code: InventoryErrorCode;
  readonly pointer: string;
  readonly message: string;
}
export type InventoryScientificProductionExisting =
  | { readonly kind: 'new' }
  | { readonly kind: 'no-change'; readonly production: InventoryScientificProduction }
  | { readonly kind: 'blocked'; readonly issue: InventoryScientificProductionIssue };
export interface InventoryScientificProductionPreviewInput extends InventoryScientificProductionChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryProtocolRunSavedSource | null;
  readonly designBinding: VerifiedAcceptedDnaProductionBinding | null;
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
}
export interface InventoryScientificProductionApplication extends InventoryScientificProductionChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryProtocolRunSavedSource | null;
  readonly designBinding: VerifiedAcceptedDnaProductionBinding | null;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export interface InventoryScientificProductionPreviewFacts {
  readonly schema: 'dnaforge.inventory-scientific-production-preview.v1';
  readonly target: InventoryTableTarget;
  readonly productionId: string | null;
  readonly intentSha256: InventoryTableSha256 | null;
  readonly sourceSha256: InventoryTableSha256 | null;
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly nextBoundaryAt: number | null;
}
export type InventoryScientificProductionPreview = InventoryScientificProductionPreviewFacts &
  (
    | {
        readonly kind: 'ready';
        readonly production: InventoryScientificProduction;
        readonly commands: readonly InventoryScientificProductionCommand[];
        readonly planDigest: InventoryTableSha256;
      }
    | {
        readonly kind: 'no-change';
        readonly production: InventoryScientificProduction;
        readonly commands: readonly [];
        readonly planDigest: null;
      }
    | {
        readonly kind: 'blocked';
        readonly production: null;
        readonly commands: readonly [];
        readonly planDigest: null;
        readonly issues: readonly [
          InventoryScientificProductionIssue,
          ...InventoryScientificProductionIssue[],
        ];
      }
  );
export interface InventoryScientificProductionSummary {
  readonly id: string;
  readonly identity: InventoryScientificProductionIdentity;
  readonly intentSha256: InventoryTableSha256;
  readonly context: InventoryScientificRunContext;
  readonly design: VerifiedAcceptedDnaProductionBinding;
  readonly materialBinding: InventoryScientificProduction['materialBinding'];
  readonly output: InventoryScientificProduction['output'] & { readonly lotName: string };
  readonly inputStockCount: number;
  readonly method: string;
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryScientificProductionFilter {
  readonly context?: {
    readonly kind: 'protocol-run';
    readonly projectId: string;
    readonly workspaceScope: string;
    readonly entityId: string;
  };
}
