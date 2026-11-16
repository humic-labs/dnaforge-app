import type {
  InventoryAvailability,
  InventoryEquipmentCatalogEntry,
  InventoryEquipmentCatalogUpdatePreview,
  InventoryItemCodeResolution,
  InventoryItemCode,
  InventoryItemCustody,
  InventoryLocationPathEntry,
  InventoryPhysicalItem,
  InventoryPhysicalItemProjection,
  InventoryPrincipal,
  InventoryState,
  InventoryStock,
  InventoryStockAvailability,
  InventoryStorage,
  InventoryVessel,
} from '@waypoint/domain-services';
import type { InventoryRenderedLabel } from '@waypoint/domain-services/inventory-label-types';
import type {
  InventoryCatalogUpdatePreviewRequest,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryPrepareLabelRequest,
  InventoryReadRequest,
  InventoryResolveItemCodeRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';

export interface InventoryProject {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly pinned: boolean;
  readonly defaultInventoryId: string;
}

export interface InventoryMaterial {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly registryId: string | null;
}

export interface InventoryMaterialQuery {
  readonly project: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface InventoryCatalogQuery {
  readonly project: string;
}

export interface InventoryMaterialPage {
  readonly items: readonly InventoryMaterial[];
  readonly nextCursor: string | null;
}

export interface InventoryChanged {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly operationId: string;
}

export interface InventoryAvailabilitySnapshot extends InventoryAvailability {
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
}

export interface InventoryItemCodeTargetSnapshot {
  readonly item: InventoryPhysicalItem;
  readonly record: InventoryStorage | InventoryVessel;
  readonly custody: InventoryItemCustody;
  readonly physical: InventoryPhysicalItemProjection;
  readonly currentLocationPath: readonly InventoryLocationPathEntry[] | null;
  readonly stocks: readonly {
    readonly stock: InventoryStock;
    readonly availability: InventoryStockAvailability;
  }[];
}

export interface InventoryItemCodeLookupSnapshot {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly resolution: InventoryItemCodeResolution;
  readonly targets: readonly InventoryItemCodeTargetSnapshot[];
}

export interface InventoryLabelArtifact {
  readonly schema: 'dnaforge.inventory-label-artifact.v1';
  readonly projectId: string;
  readonly inventoryId: string;
  readonly sourceRevision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly binding: InventoryItemCode;
  readonly target: InventoryItemCodeTargetSnapshot;
  readonly rendered: InventoryRenderedLabel;
  readonly svgSha256: string;
}

export interface InventoryClient {
  projects(): Promise<readonly InventoryProject[]>;
  catalog(input: InventoryCatalogQuery): Promise<readonly InventoryEquipmentCatalogEntry[]>;
  catalogUpdatePreview(
    input: InventoryCatalogUpdatePreviewRequest
  ): Promise<InventoryEquipmentCatalogUpdatePreview>;
  resolveItemCode(input: InventoryResolveItemCodeRequest): Promise<InventoryItemCodeLookupSnapshot>;
  prepareLabel(input: InventoryPrepareLabelRequest): Promise<InventoryLabelArtifact>;
  materials(input: InventoryMaterialQuery): Promise<InventoryMaterialPage>;
  inspect(input: InventoryReadRequest): Promise<InventoryState | null>;
  availability(input: InventoryReadRequest): Promise<InventoryAvailabilitySnapshot | null>;
  execute(input: InventoryExecuteRequest): Promise<NativeInventoryExecution>;
  operation(input: InventoryOperationRequest): Promise<NativeInventoryReceipt | null>;
  history(input: InventoryHistoryRequest): Promise<readonly NativeInventoryHistoryEntry[]>;
  onChanged(listener: (event: InventoryChanged) => void): () => void;
}

export function unavailableInventoryClient(): InventoryClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('INVENTORY_OWNER_UNAVAILABLE: Inventory requires the connected desktop owner.');
  };
  return {
    projects: unavailable,
    catalog: unavailable,
    catalogUpdatePreview: unavailable,
    resolveItemCode: unavailable,
    prepareLabel: unavailable,
    materials: unavailable,
    inspect: unavailable,
    availability: unavailable,
    execute: async (request) => ({
      status: 'rejected',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      code: 'INVENTORY_OWNER_UNAVAILABLE',
      message: 'Inventory requires the connected desktop owner.',
    }),
    operation: unavailable,
    history: unavailable,
    onChanged: () => () => {},
  };
}

export type {
  InventoryCatalogUpdatePreviewRequest,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryPrepareLabelRequest,
  InventoryReadRequest,
  InventoryResolveItemCodeRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';
