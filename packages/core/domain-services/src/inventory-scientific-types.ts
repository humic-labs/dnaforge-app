import type { InventoryAmount, InventoryCanonicalAmount } from './inventory-amount';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryLocalAuthority,
  InventoryExecutionContext,
  InventoryErrorCode,
  InventoryLocalPrincipal,
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
export interface InventoryProtocolRunSavedSource {
  readonly schema: 'dnaforge.protocol-run-saved-source.v1';
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly runId: string;
  readonly fileObjectUuid: string;
  readonly title: string;
  readonly originalText: string;
}
export type InventoryScientificContextSource =
  | InventoryNotebookSavedSource
  | InventoryProtocolRunSavedSource;
export interface InventoryScientificRunContext {
  readonly kind: 'protocol-run';
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly entityId: string;
  readonly source: InventoryScientificNotebookContext['source'];
}
export type InventoryScientificContextSelection =
  | {
      readonly kind: 'notebook-page';
      readonly entityId: string;
      readonly sourceSha256: InventoryTableSha256;
    }
  | {
      readonly kind: 'protocol-run';
      readonly entityId: string;
      readonly sourceSha256: InventoryTableSha256;
    };
export interface InventoryScientificTransferChoicesV2 extends Omit<
  InventoryScientificTransferChoices,
  'pageId' | 'expectedSourceSha256'
> {
  readonly context: InventoryScientificContextSelection;
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
  readonly context: InventoryScientificNotebookContext | InventoryScientificRunContext;
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
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
}
interface InventoryScientificTransferPreviewFacts<Schema extends string> {
  readonly schema: Schema;
  readonly target: InventoryTableTarget;
  readonly workId: string | null;
  readonly intentSha256: InventoryTableSha256 | null;
  readonly sourceSha256: InventoryTableSha256 | null;
}
type InventoryScientificTransferPreviewOf<Schema extends string> =
  InventoryScientificTransferPreviewFacts<Schema> &
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
export type InventoryScientificTransferPreview =
  InventoryScientificTransferPreviewOf<'dnaforge.inventory-scientific-transfer-preview.v1'>;
export type InventoryScientificTransferPreviewV2 =
  InventoryScientificTransferPreviewOf<'dnaforge.inventory-scientific-transfer-preview.v2'>;
export interface InventoryScientificTransferApplication extends InventoryScientificTransferChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryNotebookSavedSource | null;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export interface InventoryScientificTransferPreviewInputV2 extends InventoryScientificTransferChoicesV2 {
  readonly target: InventoryTableTarget;
  readonly source: InventoryScientificContextSource | null;
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
}
export interface InventoryScientificTransferApplicationV2 extends InventoryScientificTransferChoicesV2 {
  readonly target: InventoryTableTarget;
  readonly source: InventoryScientificContextSource | null;
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
