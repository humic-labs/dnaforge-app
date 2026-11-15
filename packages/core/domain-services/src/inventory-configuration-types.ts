import type { MetadataFieldDefinition } from './metadata-fields';
import type {
  InventoryCustodyDestination,
  InventoryExecutionContext,
  InventoryLayout,
  InventoryPhysicalItem,
  InventoryVesselLimits,
} from './inventory-types';
export type InventoryMetadataValue = string | number | boolean | readonly string[] | null;
export type InventoryMetadata = Readonly<Record<string, InventoryMetadataValue>>;
export type InventoryDimension =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly value: string; readonly unit: 'mm' | 'cm' | 'in' };
export interface InventoryDimensions {
  readonly width: InventoryDimension;
  readonly height: InventoryDimension;
  readonly depth: InventoryDimension;
}
export interface InventoryGeometry {
  readonly external: InventoryDimensions;
  readonly usable: InventoryDimensions;
}
export type InventoryOrientation =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly quarterTurns: 0 | 1 | 2 | 3 };
export type InventoryChildPolicy =
  | { readonly kind: 'any-legal' }
  | { readonly kind: 'none' }
  | { readonly kind: 'types'; readonly typeIds: readonly string[] };
export type InventoryPositionRule =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'available';
      readonly childPolicy: InventoryChildPolicy | null;
      readonly usable: InventoryDimensions | null;
    };
export interface InventorySourceReference {
  readonly url: string;
  readonly title: string;
  readonly locator: string;
  readonly readAt: string;
  readonly documentRevision: string | null;
  readonly sha256: string | null;
}
export type InventoryCatalogTarget =
  | { readonly kind: 'type-version'; readonly versionId: string }
  | { readonly kind: 'recipe-version'; readonly versionId: string };
export type InventoryCatalogSelectionState =
  | { readonly kind: 'available' }
  | {
      readonly kind: 'retired';
      readonly at: number;
      readonly by: InventoryExecutionContext['principal'];
      readonly reason: string;
    };
export type InventoryCatalogSelectionBlocker =
  | { readonly code: 'CATALOG_VERSION_RETIRED'; readonly target: InventoryCatalogTarget }
  | {
      readonly code: 'CATALOG_DEPENDENCY_RETIRED';
      readonly target: InventoryCatalogTarget;
      readonly typeVersionIds: readonly string[];
    };
export type InventoryCatalogEligibility =
  | { readonly kind: 'selectable' }
  | {
      readonly kind: 'blocked';
      readonly blockers: readonly InventoryCatalogSelectionBlocker[];
    };
export interface InventoryCatalogVersionStatus {
  readonly target: InventoryCatalogTarget;
  readonly selection: InventoryCatalogSelectionState;
  readonly relationship: 'current' | 'superseded';
  readonly headVersionId: string;
  readonly eligibility: InventoryCatalogEligibility;
  readonly actions: { readonly retire: boolean; readonly restore: boolean };
}
export interface InventoryCatalogProjection {
  readonly typeVersions: Readonly<Record<string, InventoryCatalogVersionStatus>>;
  readonly recipeVersions: Readonly<Record<string, InventoryCatalogVersionStatus>>;
}
export type InventoryPhysicalDefinition =
  | {
      readonly kind: 'storage';
      readonly layout: InventoryLayout;
      readonly childPolicy: InventoryChildPolicy;
      readonly positionRules: Readonly<Record<string, InventoryPositionRule>>;
      readonly geometry: InventoryGeometry;
    }
  | {
      readonly kind: 'vessel';
      readonly mobility: 'movable' | 'fixed-well';
      readonly limits: InventoryVesselLimits;
      readonly geometry: InventoryGeometry;
    };
export interface InventoryPhysicalTypeVersion {
  readonly id: string;
  readonly typeId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly fields: readonly MetadataFieldDefinition[];
  readonly sources: readonly InventorySourceReference[];
  readonly definition: InventoryPhysicalDefinition;
  readonly publishedAt: number;
  readonly publishedBy: InventoryExecutionContext['principal'];
  readonly selection: InventoryCatalogSelectionState;
}
export interface InventoryRecipeComponent {
  readonly key: string;
  readonly parentKey: string | null;
  readonly positionId: string | null;
  readonly name: string;
  readonly typeVersionId: string;
}
export interface InventoryEquipmentModel {
  readonly manufacturer: string;
  readonly model: string;
  readonly partNumber: string | null;
  readonly region: string | null;
  readonly revision: string | null;
}
export interface InventoryEquipmentRecipeVersion {
  readonly id: string;
  readonly recipeId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly model: InventoryEquipmentModel;
  readonly components: readonly InventoryRecipeComponent[];
  readonly sources: readonly InventorySourceReference[];
  readonly publishedAt: number;
  readonly publishedBy: InventoryExecutionContext['principal'];
  readonly selection: InventoryCatalogSelectionState;
}
export interface InventoryPhysicalConfiguration {
  readonly revision: number;
  readonly typeVersionId: string | null;
  readonly metadata: InventoryMetadata;
  readonly geometryOverride: {
    readonly geometry: InventoryGeometry;
    readonly source: InventorySourceReference | null;
    readonly at: number;
    readonly by: InventoryExecutionContext['principal'];
    readonly reason: string;
  } | null;
  readonly orientation: InventoryOrientation;
  readonly unavailablePositions: Readonly<Record<string, string>>;
  readonly recipe: { readonly recipeVersionId: string; readonly componentKey: string } | null;
}
export type InventoryFitSubject =
  | { readonly kind: 'type-version'; readonly versionId: string }
  | {
      readonly kind: 'installed';
      readonly item: InventoryPhysicalItem;
      readonly configurationRevision: number;
    };
export interface InventoryFitEvidence {
  readonly id: string;
  readonly parent: InventoryFitSubject;
  readonly child: InventoryFitSubject;
  readonly positionId: string | null;
  readonly orientations: readonly (0 | 1 | 2 | 3)[];
  readonly result: 'compatible' | 'incompatible';
  readonly basis: 'manufacturer-supported' | 'locally-verified';
  readonly source: InventorySourceReference | null;
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryExecutionContext['principal'];
}
export interface InventoryPlacementCompatibility {
  readonly logical: 'allowed' | 'incompatible';
  readonly fit: 'compatible' | 'incompatible' | 'unknown';
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly evidenceBasis: readonly ('manufacturer-supported' | 'locally-verified')[];
}
export interface InventoryPhysicalItemProjection {
  readonly item: InventoryPhysicalItem;
  readonly configuration: InventoryPhysicalConfiguration;
  readonly type: InventoryPhysicalTypeVersion | null;
  readonly recipe: InventoryEquipmentRecipeVersion | null;
  readonly geometry: InventoryGeometry;
  readonly customized: boolean;
  readonly metadataIssues: {
    readonly malformed: readonly string[];
    readonly incomplete: readonly string[];
  };
  readonly placementCompatibility: InventoryPlacementCompatibility | null;
}
export interface InventoryPhysicalProjection {
  readonly catalog: InventoryCatalogProjection;
  readonly typeVersions: readonly InventoryPhysicalTypeVersion[];
  readonly recipeVersions: readonly InventoryEquipmentRecipeVersion[];
  readonly fitEvidence: readonly InventoryFitEvidence[];
  readonly items: Readonly<Record<string, InventoryPhysicalItemProjection>>;
}
export type InventoryConfigurationCommand =
  | {
      readonly kind: 'retire-catalog-version';
      readonly target: InventoryCatalogTarget;
      readonly reason: string;
    }
  | {
      readonly kind: 'restore-catalog-version';
      readonly target: InventoryCatalogTarget;
      readonly reason: string;
    }
  | {
      readonly kind: 'instantiate-physical-type';
      readonly typeVersionId: string;
      readonly id: string;
      readonly name: string;
      readonly destination: InventoryCustodyDestination;
      readonly metadata: InventoryMetadata;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-item-geometry';
      readonly item: InventoryPhysicalItem;
      readonly geometry: InventoryGeometry;
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'define-physical-type';
      readonly id: string;
      readonly typeId: string;
      readonly name: string;
      readonly description: string;
      readonly fields: readonly MetadataFieldDefinition[];
      readonly sources: readonly InventorySourceReference[];
      readonly definition: InventoryPhysicalDefinition;
    }
  | {
      readonly kind: 'define-equipment-recipe';
      readonly id: string;
      readonly recipeId: string;
      readonly name: string;
      readonly description: string;
      readonly model: InventoryEquipmentModel;
      readonly components: readonly InventoryRecipeComponent[];
      readonly sources: readonly InventorySourceReference[];
    }
  | {
      readonly kind: 'instantiate-equipment-recipe';
      readonly recipeVersionId: string;
      readonly name: string;
      readonly components: readonly {
        readonly key: string;
        readonly id: string;
        readonly metadata: InventoryMetadata;
      }[];
      readonly destination: InventoryCustodyDestination;
      readonly reason: string;
    }
  | {
      readonly kind: 'configure-item';
      readonly item: InventoryPhysicalItem;
      readonly typeVersionId: string | null;
      readonly metadata: InventoryMetadata;
      readonly orientation: InventoryOrientation;
      readonly unavailablePositions: Readonly<Record<string, string>>;
      readonly reason: string;
    }
  | {
      readonly kind: 'reconfigure-storage';
      readonly storageId: string;
      readonly layout: InventoryLayout;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-fit-evidence';
      readonly id: string;
      readonly parent: InventoryFitSubject;
      readonly child: InventoryFitSubject;
      readonly positionId: string | null;
      readonly orientations: readonly (0 | 1 | 2 | 3)[];
      readonly result: 'compatible' | 'incompatible';
      readonly basis: 'manufacturer-supported' | 'locally-verified';
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    };
