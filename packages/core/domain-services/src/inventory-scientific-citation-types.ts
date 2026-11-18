import type {
  InventoryScientificContextSelection,
  InventoryScientificContextSource,
} from './inventory-scientific-types';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryLocalAuthority,
  InventoryErrorCode,
  InventoryLocalPrincipal,
  InventoryRecordedPrincipal,
  InventoryTransition,
  InventoryExecutionContext,
  InventoryState,
} from './inventory-types';

export interface InventoryScientificCitationIdentity {
  readonly namespace: string;
  readonly citationId: string;
}
export interface InventoryScientificCitationWithdrawalIdentity {
  readonly namespace: string;
  readonly withdrawalId: string;
}
export interface InventoryScientificCitationPredecessor {
  readonly citationId: string;
  readonly citationIntentSha256: InventoryTableSha256;
  readonly withdrawalId: string;
  readonly withdrawalIntentSha256: InventoryTableSha256;
}
export interface InventoryScientificCitationChoices {
  readonly identity: InventoryScientificCitationIdentity;
  readonly workId: string;
  readonly workIntentSha256: InventoryTableSha256;
  readonly context: InventoryScientificContextSelection;
  readonly reinstates: InventoryScientificCitationPredecessor | null;
  readonly reason: string;
}
export interface InventoryScientificCitation {
  readonly id: string;
  readonly identity: InventoryScientificCitationIdentity;
  readonly intentSha256: InventoryTableSha256;
  readonly workId: string;
  readonly workIntentSha256: InventoryTableSha256;
  readonly reinstates: InventoryScientificCitationPredecessor | null;
  readonly context: {
    readonly kind: 'notebook-page' | 'protocol-run';
    readonly projectId: string;
    readonly workspaceScope: string;
    readonly entityId: string;
    readonly source: {
      readonly kind: 'native-observed-saved-source';
      readonly sha256: InventoryTableSha256;
      readonly fileObjectUuid: string;
      readonly title: string;
    };
  };
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
}
export interface InventoryScientificCitationWithdrawalChoices {
  readonly identity: InventoryScientificCitationWithdrawalIdentity;
  readonly citationId: string;
  readonly citationIntentSha256: InventoryTableSha256;
  readonly workId: string;
  readonly workIntentSha256: InventoryTableSha256;
  readonly reason: string;
}
export interface InventoryScientificCitationWithdrawal extends InventoryScientificCitationWithdrawalChoices {
  readonly id: string;
  readonly intentSha256: InventoryTableSha256;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryScientificCitationEntry {
  readonly citation: InventoryScientificCitation;
  readonly withdrawal: InventoryScientificCitationWithdrawal | null;
}
export interface InventoryScientificCitationIssue {
  readonly code: InventoryErrorCode;
  readonly pointer: string;
  readonly message: string;
}
export type InventoryScientificCitationMatch =
  | {
      readonly kind: 'primary-context';
      readonly workId: string;
      readonly workIntentSha256: InventoryTableSha256;
    }
  | { readonly kind: 'citation'; readonly entry: InventoryScientificCitationEntry };
export type InventoryScientificCitationExisting =
  | { readonly kind: 'new' }
  | { readonly kind: 'no-change'; readonly match: InventoryScientificCitationMatch }
  | { readonly kind: 'blocked'; readonly issue: InventoryScientificCitationIssue };
export type InventoryScientificCitationWithdrawalExisting =
  | { readonly kind: 'new'; readonly citation: InventoryScientificCitation }
  | {
      readonly kind: 'no-change';
      readonly citation: InventoryScientificCitation;
      readonly withdrawal: InventoryScientificCitationWithdrawal;
    }
  | { readonly kind: 'blocked'; readonly issue: InventoryScientificCitationIssue };
interface PreviewFacts<Schema extends string> {
  readonly schema: Schema;
  readonly target: InventoryTableTarget;
  readonly workId: string;
  readonly intentSha256: InventoryTableSha256 | null;
}
export type InventoryScientificCitationPreview =
  PreviewFacts<'dnaforge.inventory-scientific-citation-preview.v1'> &
    (
      | {
          readonly kind: 'ready';
          readonly citation: InventoryScientificCitation;
          readonly planDigest: InventoryTableSha256;
        }
      | { readonly kind: 'no-change'; readonly match: InventoryScientificCitationMatch }
      | { readonly kind: 'blocked'; readonly issues: readonly InventoryScientificCitationIssue[] }
    );
export type InventoryScientificCitationWithdrawalPreview =
  PreviewFacts<'dnaforge.inventory-scientific-citation-withdrawal-preview.v1'> &
    (
      | {
          readonly kind: 'ready';
          readonly citation: InventoryScientificCitation;
          readonly withdrawal: InventoryScientificCitationWithdrawal;
          readonly planDigest: InventoryTableSha256;
        }
      | {
          readonly kind: 'no-change';
          readonly citation: InventoryScientificCitation;
          readonly withdrawal: InventoryScientificCitationWithdrawal;
        }
      | { readonly kind: 'blocked'; readonly issues: readonly InventoryScientificCitationIssue[] }
    );
interface PreviewInput {
  readonly target: InventoryTableTarget;
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
}
export interface InventoryScientificCitationPreviewInput
  extends InventoryScientificCitationChoices, PreviewInput {
  readonly source: InventoryScientificContextSource | null;
}
export interface InventoryScientificCitationWithdrawalPreviewInput
  extends InventoryScientificCitationWithdrawalChoices, PreviewInput {}
export interface InventoryScientificCitationApplication extends InventoryScientificCitationChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryScientificContextSource | null;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export interface InventoryScientificCitationWithdrawalApplication extends InventoryScientificCitationWithdrawalChoices {
  readonly target: InventoryTableTarget;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export type InventoryScientificCitationApply = (
  state: InventoryState,
  input: InventoryScientificCitationApplication,
  context: InventoryExecutionContext
) => InventoryTransition;
