import type { InventoryAmount, InventoryCanonicalAmount } from './inventory-amount';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryAuthority,
  InventoryExecutionContext,
  InventoryErrorCode,
  InventoryPrincipal,
  InventoryRecordedPrincipal,
  InventoryState,
  InventoryStock,
  InventoryTransition,
  InventoryVessel,
} from './inventory-types';

export interface InventoryScientificWorkIdentity {
  readonly namespace: string;
  readonly workId: string;
}
export interface InventoryNotebookSavedSource {
  readonly schema: 'dnaforge.notebook-saved-source.v1';
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly pageId: string;
  readonly fileObjectUuid: string;
  readonly title: string;
  readonly content: unknown;
}
export interface InventoryScientificNotebookContext {
  readonly kind: 'notebook-page';
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly pageId: string;
  readonly source: {
    readonly kind: 'native-observed-saved-source';
    readonly sha256: InventoryTableSha256;
    readonly fileObjectUuid: string;
    readonly title: string;
  };
}
export interface InventoryScientificTransferChoices {
  readonly identity: InventoryScientificWorkIdentity;
  readonly pageId: string;
  readonly expectedSourceSha256: InventoryTableSha256;
  readonly sourceStockId: string;
  readonly destinationVesselId: string;
  readonly quantity: InventoryAmount;
  readonly reason: string;
}
export interface InventoryScientificTransferCommand {
  readonly kind: 'transfer';
  readonly sourceStockId: string;
  readonly quantity: InventoryCanonicalAmount;
  readonly destination: {
    readonly kind: 'new-stock';
    readonly stockId: string;
    readonly vesselId: string;
  };
  readonly reason: string;
}
export type InventoryScientificVesselSnapshot = Pick<
  InventoryVessel,
  'id' | 'kind' | 'name' | 'placement'
>;
export interface InventoryScientificWork {
  readonly id: string;
  readonly identity: InventoryScientificWorkIdentity;
  readonly intentSha256: InventoryTableSha256;
  readonly context: InventoryScientificNotebookContext;
  readonly observation: { readonly kind: 'completed-manual-transfer' };
  readonly transfer: InventoryScientificTransferCommand;
  readonly effects: {
    readonly source: {
      readonly before: InventoryStock;
      readonly after: InventoryStock;
      readonly vessel: InventoryScientificVesselSnapshot;
    };
    readonly destination: {
      readonly before: null;
      readonly after: InventoryStock;
      readonly vessel: InventoryScientificVesselSnapshot;
    };
  };
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
}
export interface InventoryScientificTransferPreviewInput extends InventoryScientificTransferChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryNotebookSavedSource | null;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
}
interface InventoryScientificTransferPreviewFacts {
  readonly schema: 'dnaforge.inventory-scientific-transfer-preview.v1';
  readonly target: InventoryTableTarget;
  readonly workId: string | null;
  readonly intentSha256: InventoryTableSha256 | null;
  readonly sourceSha256: InventoryTableSha256 | null;
}
export type InventoryScientificTransferPreview = InventoryScientificTransferPreviewFacts &
  (
    | {
        readonly kind: 'ready';
        readonly work: InventoryScientificWork;
        readonly commands: readonly [InventoryScientificTransferCommand];
        readonly planDigest: InventoryTableSha256;
      }
    | {
        readonly kind: 'no-change';
        readonly work: InventoryScientificWork;
        readonly commands: readonly [];
        readonly planDigest: null;
      }
    | {
        readonly kind: 'blocked';
        readonly issues: readonly {
          readonly code: InventoryErrorCode;
          readonly pointer: string;
          readonly message: string;
        }[];
        readonly work: null;
        readonly commands: readonly [];
        readonly planDigest: null;
      }
  );
export interface InventoryScientificTransferApplication extends InventoryScientificTransferChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryNotebookSavedSource | null;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export type InventoryScientificTransferExisting =
  | { readonly kind: 'new' }
  | { readonly kind: 'no-change' | 'conflict'; readonly work: InventoryScientificWork };

export type InventoryScientificTransferApply = (
  state: InventoryState,
  input: InventoryScientificTransferApplication,
  context: InventoryExecutionContext
) => InventoryTransition;
