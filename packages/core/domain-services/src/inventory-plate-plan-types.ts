import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryAuthority,
  InventoryErrorCode,
  InventoryPrincipal,
  InventoryRecordedPrincipal,
  InventoryStock,
  InventoryVessel,
  InventoryStockAvailability,
  InventoryStorage,
} from './inventory-types';
export interface InventoryPlatePlanIdentity {
  readonly namespace: string;
  readonly planId: string;
}
export interface InventoryPlatePlanVolume {
  readonly value: string;
  readonly unit: 'uL';
}
export type InventoryPlatePlanBalance = InventoryPlatePlanVolume;
export interface InventoryPlatePlanDefinition {
  readonly schema: 'dnaforge.inventory-plate-plan-definition.v1';
  readonly title: string;
  readonly layout: { readonly kind: 'fixed-well'; readonly rows: number; readonly columns: number };
  readonly sourceSlots: readonly { readonly key: string; readonly label: string }[];
  readonly transfers: readonly {
    readonly actionId: string;
    readonly sourceSlotKey: string;
    readonly destinationPosition: string;
    readonly quantity: InventoryPlatePlanVolume;
    readonly label: string;
  }[];
}
export interface InventoryPlatePlanVersionChoices {
  readonly identity: InventoryPlatePlanIdentity;
  readonly definition: InventoryPlatePlanDefinition;
  readonly reason: string;
}
export interface InventoryPlatePlanVersion extends InventoryPlatePlanVersionChoices {
  readonly id: string;
  readonly definitionSha256: InventoryTableSha256;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryPlatePlanVersionSummary {
  readonly id: string;
  readonly identity: InventoryPlatePlanIdentity;
  readonly definitionSha256: InventoryTableSha256;
  readonly title: string;
  readonly layout: InventoryPlatePlanDefinition['layout'];
  readonly sourceSlotCount: number;
  readonly transferCount: number;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly reason: string;
}
export interface InventoryPlatePlanIssue {
  readonly code: InventoryErrorCode;
  readonly pointer: string;
  readonly message: string;
}
export type InventoryPlatePlanVersionExisting =
  | { readonly kind: 'new' }
  | { readonly kind: 'no-change'; readonly version: InventoryPlatePlanVersion }
  | { readonly kind: 'blocked'; readonly issue: InventoryPlatePlanIssue };
export interface InventoryPlatePlanVersionPreviewInput extends InventoryPlatePlanVersionChoices {
  readonly target: InventoryTableTarget;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
}
export interface InventoryPlatePlanVersionApplication extends InventoryPlatePlanVersionChoices {
  readonly target: InventoryTableTarget;
  readonly expectedPlanDigest: InventoryTableSha256;
}
interface VersionPreviewFacts {
  readonly schema: 'dnaforge.inventory-plate-plan-version-preview.v1';
  readonly target: InventoryTableTarget;
  readonly versionId: string | null;
  readonly definitionSha256: InventoryTableSha256 | null;
}
export type InventoryPlatePlanVersionPreview = VersionPreviewFacts &
  (
    | {
        readonly kind: 'ready';
        readonly version: InventoryPlatePlanVersion;
        readonly planDigest: InventoryTableSha256;
      }
    | { readonly kind: 'no-change'; readonly version: InventoryPlatePlanVersion }
    | { readonly kind: 'blocked'; readonly issues: readonly InventoryPlatePlanIssue[] }
  );
export interface InventoryPlatePlanBinding {
  readonly versionId: string;
  readonly definitionSha256: InventoryTableSha256;
  readonly destinationPlateId: string;
  readonly sources: readonly { readonly sourceSlotKey: string; readonly stockId: string }[];
}
export type InventoryPlatePlanNormalizedBinding = InventoryPlatePlanBinding;
export interface InventoryPlatePlanSourceDemandFacts {
  readonly sourceSlotKeys: readonly string[];
  readonly stock: InventoryStock;
  readonly vessel: InventoryVessel;
  readonly availability: InventoryStockAvailability;
  readonly demand: InventoryPlatePlanVolume;
}
export interface InventoryPlatePlanBindingPreviewInput {
  readonly target: InventoryTableTarget;
  readonly binding: InventoryPlatePlanBinding;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
}
interface BindingPreviewFacts {
  readonly schema: 'dnaforge.inventory-plate-plan-binding-preview.v1';
  readonly target: InventoryTableTarget;
  readonly versionId: string;
  readonly definitionSha256: InventoryTableSha256;
  readonly bindingSha256: InventoryTableSha256 | null;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly nextBoundaryAt: number | null;
}
export type InventoryPlatePlanBindingPreview = BindingPreviewFacts &
  (
    | {
        readonly kind: 'ready';
        readonly binding: InventoryPlatePlanNormalizedBinding;
        readonly plate: InventoryStorage;
        readonly sources: readonly (InventoryPlatePlanSourceDemandFacts & {
          readonly projectedRemaining: InventoryPlatePlanBalance;
        })[];
        readonly destinations: readonly {
          readonly actionId: string;
          readonly ordinal: number;
          readonly position: string;
          readonly vesselId: string;
        }[];
      }
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryPlatePlanIssue[];
        readonly sources: readonly InventoryPlatePlanSourceDemandFacts[];
        readonly binding: InventoryPlatePlanNormalizedBinding | null;
      }
  );
export interface InventoryPlatePlanDiagramArtifact {
  readonly versionId: string;
  readonly definitionSha256: InventoryTableSha256;
  readonly mediaType: 'image/svg+xml';
  readonly fileName: string;
  readonly svg: string;
  readonly sha256: InventoryTableSha256;
}
export type InventoryPlatePlanDiagramResult =
  | { readonly kind: 'rendered'; readonly artifact: InventoryPlatePlanDiagramArtifact }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };
