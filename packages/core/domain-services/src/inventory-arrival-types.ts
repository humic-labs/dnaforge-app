import type {
  InventoryAuthority,
  InventoryCommand,
  InventoryExecutionContext,
  InventoryPrincipal,
  InventoryQuality,
  InventoryQuantity,
  InventoryQuantityInput,
  InventoryRecordedPrincipal,
  InventorySourceReference,
  InventoryState,
  InventoryVesselPlacement,
} from './inventory-types';
import type {
  InventoryTableBindingObservation,
  InventoryTableIssue,
  InventoryTableResolvedMaterial,
  InventoryTableSha256,
  InventoryTableTarget,
} from './inventory-table-types';

export interface InventoryArrivalIdentity {
  readonly namespace: string;
  readonly arrivalId: string;
}
export type InventoryArrivalCoverage =
  | { readonly kind: 'full' }
  | { readonly kind: 'excerpt'; readonly reason: string };
export interface InventoryArrivalDocumentInput {
  readonly key: string;
  readonly mediaType: 'text/plain' | 'text/csv' | 'application/json' | 'application/pdf';
  readonly body: { readonly encoding: 'utf8' | 'base64'; readonly value: string };
  readonly reference: InventorySourceReference | null;
  readonly coverage: InventoryArrivalCoverage;
}
export interface InventoryArrivalDocumentMetadata extends Omit<
  InventoryArrivalDocumentInput,
  'body'
> {
  readonly sha256: InventoryTableSha256;
  readonly byteLength: number;
}
export type InventoryArrivalEvidenceLocator =
  | { readonly kind: 'utf8-byte-range'; readonly startByte: number; readonly endByte: number }
  | { readonly kind: 'json-pointer'; readonly pointer: string }
  | { readonly kind: 'pdf-region'; readonly page1Based: number; readonly description: string };
export interface InventoryArrivalSelection {
  readonly documentKey: string;
  readonly expectedSha256: InventoryTableSha256;
  readonly locator: InventoryArrivalEvidenceLocator;
  readonly verbatim: string;
}
export interface InventoryArrivalSupplierClaimInput {
  readonly key: string;
  readonly subject:
    | { readonly kind: 'delivery' }
    | { readonly kind: 'package'; readonly packageKey: string }
    | { readonly kind: 'component'; readonly componentKey: string };
  readonly selection: InventoryArrivalSelection;
  readonly claim:
    | { readonly kind: 'supplier-qc'; readonly resultText: string }
    | { readonly kind: 'quantity'; readonly valueLexeme: string; readonly unitText: string }
    | {
        readonly kind: 'identifier';
        readonly role: 'product' | 'packaging-batch' | 'component-batch';
        readonly value: string;
      }
    | { readonly kind: 'date-or-condition'; readonly text: string };
}
export interface InventoryArrivalRecordedSupplierClaim extends InventoryArrivalSupplierClaimInput {
  readonly verification: 'exact-text-selection' | 'operator-cited-pdf-region';
}
export interface InventoryArrivalPackage {
  readonly key: string;
  readonly label: string;
  readonly productCode: string | null;
  readonly packagingBatch: string | null;
}
export interface InventoryArrivalSourceComponent {
  readonly key: string;
  readonly packageKey: string | null;
  readonly label: string;
  readonly productCode: string | null;
  readonly componentBatch: string | null;
}
export interface InventoryArrivalSource {
  readonly schema: 'dnaforge.inventory-arrival-source.v1';
  readonly identity: InventoryArrivalIdentity;
  readonly supplier: string | null;
  readonly observedAt: number | null;
  readonly observationReason: string;
  readonly scope: {
    readonly kind: 'selected-components' | 'complete-listed-manifest';
    readonly reason: string;
  };
  readonly documents: readonly InventoryArrivalDocumentInput[];
  readonly packages: readonly InventoryArrivalPackage[];
  readonly components: readonly InventoryArrivalSourceComponent[];
  readonly claims: readonly InventoryArrivalSupplierClaimInput[];
}
export type InventoryArrivalQuantityBasis =
  | { readonly kind: 'measurement'; readonly reason: string }
  | { readonly kind: 'supplier-declared'; readonly claimKey: string; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };
export type InventoryArrivalLotChoice =
  | { readonly kind: 'existing'; readonly lotId: string; readonly reason: string }
  | { readonly kind: 'unattributed'; readonly reason: string }
  | {
      readonly kind: 'new';
      readonly lotKey: string;
      readonly name: string;
      readonly supplier: string;
      readonly lotNumber: string;
      readonly managementReason: string;
    };
export type InventoryArrivalComponentChoice = { readonly componentKey: string } & (
  | {
      readonly kind: 'identified';
      readonly materialId: string;
      readonly lot: InventoryArrivalLotChoice;
      readonly quantity: InventoryQuantityInput;
      readonly quantityBasis: InventoryArrivalQuantityBasis;
      readonly stockQuality: { readonly value: InventoryQuality; readonly reason: string };
      readonly vessel: { readonly name: string; readonly placement: InventoryVesselPlacement };
    }
  | {
      readonly kind: 'unidentified-physical' | 'unobserved-physical';
      readonly vessel: { readonly name: string; readonly placement: InventoryVesselPlacement };
      readonly reason: string;
    }
  | { readonly kind: 'observed-missing' | 'evidence-only'; readonly reason: string }
);
export interface InventoryArrivalChoices {
  readonly components: readonly InventoryArrivalComponentChoice[];
}
export interface InventoryArrivalResolvedTarget {
  readonly componentKey: string;
  readonly lotId: string | null;
  readonly stockId: string | null;
  readonly vesselId: string | null;
}
export interface InventoryResolvedArrivalOptions extends InventoryArrivalChoices {
  readonly materials: readonly InventoryTableResolvedMaterial[];
  readonly targets: readonly InventoryArrivalResolvedTarget[];
}
export interface InventoryArrivalRecordedComponent extends InventoryArrivalSourceComponent {
  readonly choice: InventoryArrivalComponentChoice;
  readonly target: InventoryArrivalResolvedTarget;
  readonly receivedQuantity: InventoryQuantity | null;
}
export interface InventoryArrival {
  readonly id: string;
  readonly identity: InventoryArrivalIdentity;
  readonly sourceSha256: InventoryTableSha256;
  readonly admissionSha256: InventoryTableSha256;
  readonly supplier: string | null;
  readonly observedAt: number | null;
  readonly observationReason: string;
  readonly scope: InventoryArrivalSource['scope'];
  readonly documents: readonly InventoryArrivalDocumentMetadata[];
  readonly packages: readonly InventoryArrivalPackage[];
  readonly claims: readonly InventoryArrivalRecordedSupplierClaim[];
  readonly components: readonly InventoryArrivalRecordedComponent[];
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryArrivalPreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryArrivalChoices;
  readonly bindings: readonly InventoryTableBindingObservation[];
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
  readonly maxBytes: number;
}
interface InventoryArrivalPreviewFacts {
  readonly schema: 'dnaforge.inventory-arrival-preview.v1';
  readonly target: InventoryTableTarget;
  readonly sourceSha256: InventoryTableSha256 | null;
  readonly arrivalId: string | null;
}
export type InventoryArrivalPreview = InventoryArrivalPreviewFacts &
  (
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryTableIssue[];
        readonly options: null;
        readonly planDigest: null;
        readonly commands: readonly [];
        readonly arrival: null;
      }
    | {
        readonly kind: 'no-change';
        readonly issues: readonly [];
        readonly options: InventoryResolvedArrivalOptions;
        readonly planDigest: null;
        readonly commands: readonly [];
        readonly arrival: InventoryArrival;
      }
    | {
        readonly kind: 'ready';
        readonly issues: readonly [];
        readonly options: InventoryResolvedArrivalOptions;
        readonly planDigest: InventoryTableSha256;
        readonly commands: readonly InventoryCommand[];
        readonly arrival: InventoryArrival;
      }
  );
export interface InventoryArrivalApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryResolvedArrivalOptions;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export interface InventoryArrivalDocumentReadInput {
  readonly arrivalId: string;
  readonly documentKey: string;
  readonly expectedSha256: InventoryTableSha256;
}
export type InventoryArrivalDocumentRead =
  | {
      readonly kind: 'available';
      readonly arrivalId: string;
      readonly document: InventoryArrivalDocumentMetadata;
      readonly body: InventoryArrivalDocumentInput['body'];
    }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string };
export type InventoryArrivalState = InventoryState | null;
export type InventoryArrivalContext = InventoryExecutionContext;
