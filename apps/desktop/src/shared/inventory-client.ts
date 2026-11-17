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
  InventoryStorageConditionsProjection,
  InventoryStock,
  InventoryStockAvailability,
  InventoryStorage,
  InventoryVessel,
  InventoryArchiveArtifact,
  InventoryImportPreview,
  InventoryTablePreview,
  InventoryStocktakePreview,
  InventoryHierarchyPreview,
  InventoryMappedTablePreview,
  InventorySourceRevisionPreview,
  InventoryBenchlingCaptureInspection,
  InventoryBenchlingCapturePreview,
  InventoryImportTarget,
} from '@waypoint/domain-services';
import type { InventoryRenderedLabel } from '@waypoint/domain-services/inventory-label-types';
import type {
  InventoryCatalogUpdatePreviewRequest,
  InventoryExportSnapshotRequest,
  InventoryPreviewImportRequest,
  InventoryApplyImportRequest,
  InventoryPreviewTableRequest,
  InventoryApplyTableRequest,
  InventoryPreviewStocktakeRequest,
  InventoryPreviewHierarchyRequest,
  InventoryPreviewMappedTableRequest,
  InventoryApplyMappedTableRequest,
  InventoryApplyHierarchyRequest,
  InventoryApplyStocktakeRequest,
  InventoryPreviewSourceRevisionRequest,
  InventoryAcknowledgeSourceRequest,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryPrepareLabelRequest,
  InventoryReadRequest,
  InventoryInspectBenchlingCaptureRequest,
  InventoryPreviewBenchlingCaptureRequest,
  InventoryApplyBenchlingCaptureRequest,
  InventoryResolveItemCodeRequest,
  InventoryStorageConditionsRequest,
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

export interface InventoryStorageConditionsSnapshot extends InventoryStorageConditionsProjection {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
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

export interface InventoryExportSnapshot extends InventoryArchiveArtifact {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
}
export type InventoryImportPreviewSnapshot = InventoryImportPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export type InventoryTablePreviewSnapshot = InventoryTablePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryStocktakePreviewSnapshot = InventoryStocktakePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventorySourceRevisionPreviewSnapshot = InventorySourceRevisionPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryHierarchyPreviewSnapshot = InventoryHierarchyPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryMappedTablePreviewSnapshot = InventoryMappedTablePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryBenchlingCaptureSnapshot = InventoryBenchlingCaptureInspection & {
  readonly target: InventoryImportTarget;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export type InventoryBenchlingCapturePreviewSnapshot = InventoryBenchlingCapturePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export interface InventoryClient {
  previewBenchlingCapture(
    input: InventoryPreviewBenchlingCaptureRequest
  ): Promise<InventoryBenchlingCapturePreviewSnapshot>;
  applyBenchlingCapture(
    input: InventoryApplyBenchlingCaptureRequest
  ): Promise<NativeInventoryExecution>;
  inspectBenchlingCapture(
    input: InventoryInspectBenchlingCaptureRequest
  ): Promise<InventoryBenchlingCaptureSnapshot>;
  previewMappedTable(
    input: InventoryPreviewMappedTableRequest
  ): Promise<InventoryMappedTablePreviewSnapshot>;
  applyMappedTable(input: InventoryApplyMappedTableRequest): Promise<NativeInventoryExecution>;
  previewHierarchy(
    input: InventoryPreviewHierarchyRequest
  ): Promise<InventoryHierarchyPreviewSnapshot>;
  applyHierarchy(input: InventoryApplyHierarchyRequest): Promise<NativeInventoryExecution>;
  previewSourceRevision(
    input: InventoryPreviewSourceRevisionRequest
  ): Promise<InventorySourceRevisionPreviewSnapshot>;
  acknowledgeSource(input: InventoryAcknowledgeSourceRequest): Promise<NativeInventoryExecution>;
  previewStocktake(
    input: InventoryPreviewStocktakeRequest
  ): Promise<InventoryStocktakePreviewSnapshot>;
  applyStocktake(input: InventoryApplyStocktakeRequest): Promise<NativeInventoryExecution>;
  exportSnapshot(input: InventoryExportSnapshotRequest): Promise<InventoryExportSnapshot>;
  previewImport(input: InventoryPreviewImportRequest): Promise<InventoryImportPreviewSnapshot>;
  applyImport(input: InventoryApplyImportRequest): Promise<NativeInventoryExecution>;
  previewTable(input: InventoryPreviewTableRequest): Promise<InventoryTablePreviewSnapshot>;
  applyTable(input: InventoryApplyTableRequest): Promise<NativeInventoryExecution>;
  projects(): Promise<readonly InventoryProject[]>;
  catalog(input: InventoryCatalogQuery): Promise<readonly InventoryEquipmentCatalogEntry[]>;
  catalogUpdatePreview(
    input: InventoryCatalogUpdatePreviewRequest
  ): Promise<InventoryEquipmentCatalogUpdatePreview>;
  resolveItemCode(input: InventoryResolveItemCodeRequest): Promise<InventoryItemCodeLookupSnapshot>;
  prepareLabel(input: InventoryPrepareLabelRequest): Promise<InventoryLabelArtifact>;
  storageConditions(
    input: InventoryStorageConditionsRequest
  ): Promise<InventoryStorageConditionsSnapshot>;
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
  const unavailableMutation = async (
    request: Pick<InventoryExecuteRequest, 'inventoryId' | 'operationId'>
  ): Promise<NativeInventoryExecution> => ({
    status: 'rejected',
    inventoryId: request.inventoryId,
    operationId: request.operationId,
    code: 'INVENTORY_OWNER_UNAVAILABLE',
    message: 'Inventory requires the connected desktop owner.',
  });
  return {
    previewBenchlingCapture: unavailable,
    applyBenchlingCapture: unavailableMutation,
    inspectBenchlingCapture: unavailable,
    exportSnapshot: unavailable,
    previewImport: unavailable,
    applyImport: unavailableMutation,
    previewTable: unavailable,
    previewSourceRevision: unavailable,
    acknowledgeSource: unavailableMutation,
    previewStocktake: unavailable,
    previewHierarchy: unavailable,
    previewMappedTable: unavailable,
    applyMappedTable: unavailableMutation,
    applyHierarchy: unavailableMutation,
    applyStocktake: unavailableMutation,
    applyTable: unavailableMutation,
    projects: unavailable,
    catalog: unavailable,
    catalogUpdatePreview: unavailable,
    resolveItemCode: unavailable,
    prepareLabel: unavailable,
    storageConditions: unavailable,
    materials: unavailable,
    inspect: unavailable,
    availability: unavailable,
    execute: unavailableMutation,
    operation: unavailable,
    history: unavailable,
    onChanged: () => () => {},
  };
}

export type {
  InventoryPreviewBenchlingCaptureRequest,
  InventoryApplyBenchlingCaptureRequest,
  InventoryExportSnapshotRequest,
  InventoryPreviewImportRequest,
  InventoryApplyImportRequest,
  InventoryPreviewTableRequest,
  InventoryApplyTableRequest,
  InventoryPreviewStocktakeRequest,
  InventoryPreviewHierarchyRequest,
  InventoryPreviewMappedTableRequest,
  InventoryApplyMappedTableRequest,
  InventoryApplyHierarchyRequest,
  InventoryApplyStocktakeRequest,
  InventoryPreviewSourceRevisionRequest,
  InventoryAcknowledgeSourceRequest,
  InventoryAcceptedRequest,
  InventoryCatalogUpdatePreviewRequest,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryPrepareLabelRequest,
  InventoryReadRequest,
  InventoryInspectBenchlingCaptureRequest,
  InventoryResolveItemCodeRequest,
  InventoryStorageConditionsRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';
