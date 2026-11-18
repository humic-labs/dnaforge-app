import type { InventoryProtocolRunSavedSource } from './inventory-scientific-types';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryLocalAuthority,
  InventoryErrorCode,
  InventoryLocalPrincipal,
  InventoryRecordedPrincipal,
} from './inventory-types';
import type {
  ProtocolRunValueOrigin,
  ProtocolSimpleRunValue,
  ProtocolSimpleValueKind,
} from './protocol-value-edit';

export interface InventoryRunValueAttributionIdentity {
  readonly namespace: string;
  readonly attributionId: string;
}
export interface InventoryRunValueAttributionWithdrawalIdentity {
  readonly namespace: string;
  readonly withdrawalId: string;
}
export type InventoryRunValueCollection = 'inputs' | 'outputs' | 'measurements';
export interface InventoryRunValueSelection {
  readonly entityId: string;
  readonly sourceSha256: InventoryTableSha256;
  readonly collection: InventoryRunValueCollection;
  readonly key: string;
  readonly rowSha256: InventoryTableSha256;
}
export interface InventoryRunValuePhysicalSelection {
  readonly observationId: string;
  readonly observationIntentSha256: InventoryTableSha256;
  readonly subject:
    | { readonly kind: 'source-stock'; readonly stockId: string }
    | { readonly kind: 'output-action'; readonly actionId: string; readonly stockId: string };
}
export interface InventoryRunValueAttributionPredecessor {
  readonly attributionId: string;
  readonly attributionIntentSha256: InventoryTableSha256;
  readonly withdrawalId: string;
  readonly withdrawalIntentSha256: InventoryTableSha256;
}
export interface InventoryRunValueAttributionChoices {
  readonly identity: InventoryRunValueAttributionIdentity;
  readonly runValue: InventoryRunValueSelection;
  readonly physical: InventoryRunValuePhysicalSelection;
  readonly predecessor: InventoryRunValueAttributionPredecessor | null;
  readonly reason: string;
}
export type InventoryRunValueSnapshot = Readonly<Record<string, unknown>> & {
  readonly key: string;
  readonly label: string;
  readonly value: ProtocolSimpleRunValue & Readonly<Record<string, unknown>>;
  readonly recordedAt?: string;
};
export interface InventoryRunValueSourceMetadata {
  readonly kind: 'native-observed-saved-source';
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly fileObjectUuid: string;
  readonly title: string;
}
export interface InventoryRunValueAttribution extends InventoryRunValueAttributionChoices {
  readonly id: string;
  readonly intentSha256: InventoryTableSha256;
  readonly source: InventoryRunValueSourceMetadata;
  readonly valueSnapshot: InventoryRunValueSnapshot;
  readonly origin: ProtocolRunValueOrigin;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryRunValueAttributionWithdrawalChoices {
  readonly identity: InventoryRunValueAttributionWithdrawalIdentity;
  readonly attributionId: string;
  readonly attributionIntentSha256: InventoryTableSha256;
  readonly reason: string;
}
export interface InventoryRunValueAttributionWithdrawal extends InventoryRunValueAttributionWithdrawalChoices {
  readonly id: string;
  readonly intentSha256: InventoryTableSha256;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryRunValueAttributionEntry {
  readonly attribution: InventoryRunValueAttribution;
  readonly withdrawal: InventoryRunValueAttributionWithdrawal | null;
}
export interface InventoryRunValueAttributionSummary extends Omit<
  InventoryRunValueAttribution,
  'valueSnapshot' | 'origin'
> {
  readonly slotLabel: string;
  readonly valueKind: ProtocolSimpleValueKind;
}
export interface InventoryRunValueAttributionFilter {
  readonly run?: {
    readonly projectId: string;
    readonly workspaceScope: string;
    readonly entityId: string;
  };
  readonly slot?: { readonly collection: InventoryRunValueCollection; readonly key: string };
}
export interface InventoryRunValueAttributionIssue {
  readonly code: InventoryErrorCode;
  readonly pointer: string;
  readonly message: string;
}
export type InventoryRunValueAttributionExisting =
  | { readonly kind: 'new' }
  | { readonly kind: 'no-change'; readonly entry: InventoryRunValueAttributionEntry }
  | { readonly kind: 'blocked'; readonly issue: InventoryRunValueAttributionIssue };
export type InventoryRunValueAttributionWithdrawalExisting =
  | { readonly kind: 'new'; readonly attribution: InventoryRunValueAttribution }
  | {
      readonly kind: 'no-change';
      readonly attribution: InventoryRunValueAttribution;
      readonly withdrawal: InventoryRunValueAttributionWithdrawal;
    }
  | { readonly kind: 'blocked'; readonly issue: InventoryRunValueAttributionIssue };
export interface InventoryRunValueRunHeader {
  readonly entityId: string;
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly fileObjectUuid: string;
  readonly title: string;
  readonly sourceSha256: InventoryTableSha256;
}
export type InventoryRunValueEligibility =
  | { readonly kind: 'eligible'; readonly valueKind: ProtocolSimpleValueKind }
  | { readonly kind: 'unsupported'; readonly code: string; readonly message: string };
export interface InventoryRunValueCandidate {
  readonly collection: InventoryRunValueCollection;
  readonly key: string;
  readonly rowSha256: InventoryTableSha256;
  readonly row: Readonly<Record<string, unknown>>;
  readonly origin: ProtocolRunValueOrigin | null;
  readonly eligibility: InventoryRunValueEligibility;
}
export interface InventoryRunValueCandidates {
  readonly run: InventoryRunValueRunHeader;
  readonly rows: readonly InventoryRunValueCandidate[];
}
export interface InventoryRunValueAttributionSelected {
  readonly runValue: InventoryRunValueSelection;
  readonly source: InventoryRunValueSourceMetadata;
  readonly valueSnapshot: InventoryRunValueSnapshot;
  readonly origin: ProtocolRunValueOrigin;
}
export type InventoryRunValueAttributionComparison =
  | {
      readonly kind: 'same-source' | 'changed-source-same-row' | 'changed-row';
      readonly run: InventoryRunValueRunHeader;
      readonly row: {
        readonly rowSha256: InventoryTableSha256;
        readonly row: Readonly<Record<string, unknown>>;
        readonly eligibility: InventoryRunValueEligibility;
      };
    }
  | { readonly kind: 'missing-row' | 'replaced-binding'; readonly run: InventoryRunValueRunHeader }
  | {
      readonly kind: 'unavailable';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };
interface NativeInput {
  readonly target: InventoryTableTarget;
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
}
export interface InventoryRunValueAttributionPreviewInput
  extends InventoryRunValueAttributionChoices, NativeInput {
  readonly source: InventoryProtocolRunSavedSource | null;
}
export interface InventoryRunValueAttributionWithdrawalPreviewInput
  extends InventoryRunValueAttributionWithdrawalChoices, NativeInput {}
export interface InventoryRunValueAttributionApplication extends InventoryRunValueAttributionChoices {
  readonly target: InventoryTableTarget;
  readonly source: InventoryProtocolRunSavedSource | null;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export interface InventoryRunValueAttributionWithdrawalApplication extends InventoryRunValueAttributionWithdrawalChoices {
  readonly target: InventoryTableTarget;
  readonly expectedPlanDigest: InventoryTableSha256;
}
interface PreviewFacts<Schema extends string> {
  readonly schema: Schema;
  readonly target: InventoryTableTarget;
  readonly attributionId: string | null;
  readonly intentSha256: InventoryTableSha256 | null;
  readonly sourceSha256: InventoryTableSha256 | null;
}
export type InventoryRunValueAttributionPreview =
  PreviewFacts<'dnaforge.inventory-run-value-attribution-preview.v1'> &
    (
      | {
          readonly kind: 'ready';
          readonly attribution: InventoryRunValueAttribution;
          readonly planDigest: InventoryTableSha256;
        }
      | { readonly kind: 'no-change'; readonly entry: InventoryRunValueAttributionEntry }
      | { readonly kind: 'blocked'; readonly issues: readonly InventoryRunValueAttributionIssue[] }
    );
export type InventoryRunValueAttributionWithdrawalPreview =
  PreviewFacts<'dnaforge.inventory-run-value-attribution-withdrawal-preview.v1'> &
    (
      | {
          readonly kind: 'ready';
          readonly attribution: InventoryRunValueAttribution;
          readonly withdrawal: InventoryRunValueAttributionWithdrawal;
          readonly planDigest: InventoryTableSha256;
        }
      | { readonly kind: 'no-change'; readonly entry: InventoryRunValueAttributionEntry }
      | { readonly kind: 'blocked'; readonly issues: readonly InventoryRunValueAttributionIssue[] }
    );
