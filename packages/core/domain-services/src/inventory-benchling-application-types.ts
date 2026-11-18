import type {
  InventoryLocalAuthority,
  InventoryCommand,
  InventoryHierarchyBinding,
  InventoryLayout,
  InventoryLocalPrincipal,
  InventoryQuality,
  InventoryVesselBinding,
  InventoryTableBinding,
  InventoryTableIssue,
  InventoryTableSha256,
  InventoryTableTarget,
  InventoryReceiveTableFields,
  InventoryResolvedTableOptions,
} from './inventory';

export type InventoryBenchlingPhysicalRecordKind = 'location' | 'box' | 'plate' | 'container';
export type InventoryBenchlingRecordKey<K extends string = InventoryBenchlingPhysicalRecordKind> = {
  readonly kind: K;
  readonly sourceId: string;
};
export type InventoryBenchlingCapturedChoice = {
  readonly kind: 'captured';
  readonly responseId: string;
  readonly pointer: string;
  readonly reason: string | null;
};
export type InventoryBenchlingDeclaredChoice<T> = {
  readonly kind: 'declared';
  readonly value: T;
  readonly reason: string;
};
export type InventoryBenchlingFactChoice<T> =
  | InventoryBenchlingCapturedChoice
  | InventoryBenchlingDeclaredChoice<T>;
export type InventoryBenchlingPlacementBasis =
  | InventoryBenchlingCapturedChoice
  | {
      readonly kind: 'membership';
      readonly responseId: string;
      readonly pointer: string;
      readonly reason: string | null;
    }
  | { readonly kind: 'declared'; readonly reason: string };
export type InventoryBenchlingPositionChoice = {
  readonly value: string;
  readonly basis: 'captured-exact' | 'declared-mapping';
  readonly reason: string | null;
};
export type InventoryBenchlingLocatedChoice =
  | {
      readonly kind: 'source';
      readonly parentSourceId: string;
      readonly position: InventoryBenchlingPositionChoice;
      readonly basis: InventoryBenchlingPlacementBasis;
    }
  | {
      readonly kind: 'existing';
      readonly storageId: string;
      readonly position: InventoryBenchlingPositionChoice;
      readonly basis: InventoryBenchlingPlacementBasis;
      readonly reason: string;
    };
export type InventoryBenchlingStoragePlacementChoice =
  | InventoryBenchlingLocatedChoice
  | {
      readonly kind: 'root';
      readonly basis: InventoryBenchlingPlacementBasis;
    };
export type InventoryBenchlingVesselPlacementChoice =
  | InventoryBenchlingLocatedChoice
  | {
      readonly kind: 'unplaced';
      readonly basis: InventoryBenchlingPlacementBasis;
    };
export type InventoryBenchlingGridLayoutChoice =
  | {
      readonly kind: 'captured-schema';
      readonly schema: InventoryBenchlingRecordKey<'box-schema' | 'plate-schema'>;
      readonly height: InventoryBenchlingCapturedChoice;
      readonly width: InventoryBenchlingCapturedChoice;
    }
  | InventoryBenchlingDeclaredChoice<{ readonly rows: number; readonly columns: number }>;
export type InventoryBenchlingStorageDefinition =
  | {
      readonly kind: 'location';
      readonly layout: InventoryBenchlingDeclaredChoice<InventoryLayout>;
    }
  | { readonly kind: 'box'; readonly layout: InventoryBenchlingGridLayoutChoice }
  | {
      readonly kind: 'plate';
      readonly plateType: InventoryBenchlingFactChoice<'well_plate' | 'matrix_plate'>;
      readonly layout: InventoryBenchlingGridLayoutChoice;
    };
export type InventoryBenchlingQuantityChoice =
  | {
      readonly kind: 'source-volume';
      readonly sourceField: 'quantity' | 'volume';
      readonly selection: InventoryBenchlingCapturedChoice;
    }
  | { readonly kind: 'unknown'; readonly reason: string };
export type InventoryBenchlingContentsChoice =
  | {
      readonly kind: 'empty';
      readonly selection: InventoryBenchlingCapturedChoice;
      readonly quantity: Extract<
        InventoryBenchlingQuantityChoice,
        { readonly kind: 'source-volume' }
      >;
      readonly reason: string;
    }
  | { readonly kind: 'unobserved'; readonly reason: string }
  | {
      readonly kind: 'unidentified';
      readonly selection: InventoryBenchlingCapturedChoice;
      readonly reason: string;
    }
  | {
      readonly kind: 'identify';
      readonly selection: InventoryBenchlingCapturedChoice;
      readonly materialId: string;
      readonly quantity: InventoryBenchlingQuantityChoice;
      readonly quality: { readonly value: InventoryQuality; readonly reason: string };
      readonly reason: string;
    };
export type InventoryBenchlingVesselTarget =
  | {
      readonly kind: 'movable';
      readonly name: InventoryBenchlingFactChoice<string>;
      readonly placement: InventoryBenchlingVesselPlacementChoice;
    }
  | {
      readonly kind: 'fixed-well';
      readonly plateSourceId: string;
      readonly position: InventoryBenchlingPositionChoice;
      readonly basis: InventoryBenchlingPlacementBasis;
    };
export type InventoryBenchlingRecordDecision =
  | {
      readonly record: InventoryBenchlingRecordKey;
      readonly disposition: 'skip';
      readonly reason: string;
    }
  | {
      readonly record: InventoryBenchlingRecordKey<'box-schema' | 'plate-schema'>;
      readonly disposition: 'evidence';
      readonly reason: string;
    }
  | {
      readonly record: InventoryBenchlingRecordKey<'location' | 'box' | 'plate'>;
      readonly disposition: 'storage';
      readonly name: InventoryBenchlingFactChoice<string>;
      readonly definition: InventoryBenchlingStorageDefinition;
      readonly placement: InventoryBenchlingStoragePlacementChoice;
    }
  | {
      readonly record: InventoryBenchlingRecordKey<'container'>;
      readonly disposition: 'vessel';
      readonly target: InventoryBenchlingVesselTarget;
      readonly contents: InventoryBenchlingContentsChoice;
    };
export interface InventoryBenchlingCaptureChoices {
  readonly scopeAcceptance: { readonly kind: 'selected-records'; readonly reason: string };
  readonly records: readonly InventoryBenchlingRecordDecision[];
  readonly sourceIssueDispositions: readonly {
    readonly code: string;
    readonly responseId: string | null;
    readonly bodyPointer: string | null;
    readonly reason: string;
  }[];
  readonly uncapturedPositions: readonly {
    readonly storageSourceId: string;
    readonly positions: readonly string[];
    readonly kind: 'unavailable';
    readonly reason: string;
  }[];
}
export interface InventoryResolvedBenchlingCaptureOptions extends InventoryBenchlingCaptureChoices {
  readonly materials: readonly {
    readonly sourceId: string;
    readonly materialId: string;
    readonly fingerprint: InventoryTableSha256;
  }[];
  readonly resolvedTargets: readonly {
    readonly record: InventoryBenchlingRecordKey;
    readonly target: { readonly kind: 'storage' | 'vessel'; readonly id: string };
  }[];
  readonly normalizedStockRows: readonly InventoryReceiveTableFields[];
  readonly normalizedTableOptions: InventoryResolvedTableOptions;
}
export interface InventoryBenchlingCapturePreviewInput {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryBenchlingCaptureChoices;
  readonly bindings: readonly ({ readonly sourceId: string; readonly materialId: string } & (
    | { readonly kind: 'admitted'; readonly fingerprint: InventoryTableSha256 }
    | { readonly kind: 'unavailable'; readonly reason: string }
  ))[];
  readonly asOf: number;
  readonly principal: InventoryLocalPrincipal;
  readonly authority: InventoryLocalAuthority;
  readonly maxBytes: number;
}
export interface InventoryBenchlingCaptureApplication {
  readonly target: InventoryTableTarget;
  readonly sourceText: string;
  readonly options: InventoryResolvedBenchlingCaptureOptions;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export type InventoryBenchlingCapturePreview = {
  readonly schema: 'dnaforge.inventory-benchling-application-preview.v1';
  readonly sourceSha256: InventoryTableSha256 | null;
  readonly target: InventoryTableTarget;
  readonly uncapturedPositions: readonly {
    readonly storageSourceId: string;
    readonly positions: readonly string[];
    readonly kind: 'unobserved' | 'unavailable';
  }[];
  readonly rows: readonly {
    readonly record: InventoryBenchlingRecordKey<
      InventoryBenchlingPhysicalRecordKind | 'box-schema' | 'plate-schema'
    >;
    readonly kind:
      | 'create'
      | 'bind'
      | 'identify'
      | 'unchanged'
      | 'evidence'
      | 'skipped'
      | 'needs-reconciliation'
      | 'blocked';
    readonly targetId: string | null;
    readonly stockFields?: InventoryReceiveTableFields;
    readonly issues: readonly InventoryTableIssue[];
  }[];
} & (
  | {
      readonly kind: 'blocked';
      readonly issues: readonly InventoryTableIssue[];
      readonly options: null;
      readonly planDigest: null;
    }
  | {
      readonly kind: 'no-change';
      readonly issues: readonly [];
      readonly options: InventoryResolvedBenchlingCaptureOptions;
      readonly planDigest: null;
    }
  | {
      readonly kind: 'ready';
      readonly issues: readonly [];
      readonly options: InventoryResolvedBenchlingCaptureOptions;
      readonly planDigest: InventoryTableSha256;
      readonly commands: readonly InventoryCommand[];
      readonly hierarchyBindingAdditions: Readonly<Record<string, InventoryHierarchyBinding>>;
      readonly vesselBindingAdditions: Readonly<Record<string, InventoryVesselBinding>>;
      readonly tableBindingAdditions: Readonly<Record<string, InventoryTableBinding>>;
    }
);
