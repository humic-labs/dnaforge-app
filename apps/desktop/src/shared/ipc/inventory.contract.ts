import { defineGroup, event, invoke } from './contract';
import type {
  InventoryEquipmentCatalogEntry,
  InventoryEquipmentCatalogUpdatePreview,
  InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryChanged,
  InventoryExportSnapshotRequest,
  InventoryPreviewImportRequest,
  InventoryApplyImportRequest,
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryCatalogQuery,
  InventoryCatalogUpdatePreviewRequest,
  InventoryAvailabilitySnapshot,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryMaterialPage,
  InventoryMaterialQuery,
  InventoryOperationRequest,
  InventoryProject,
  InventoryReadRequest,
  InventoryResolveItemCodeRequest,
  InventoryItemCodeLookupSnapshot,
  InventoryPrepareLabelRequest,
  InventoryLabelArtifact,
  InventoryStorageConditionsRequest,
  InventoryStorageConditionsSnapshot,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from '../inventory-client';

export const inventoryContract = defineGroup('inventory', {
  exportSnapshot: invoke<[request: InventoryExportSnapshotRequest], InventoryExportSnapshot>(),
  previewImport: invoke<[request: InventoryPreviewImportRequest], InventoryImportPreviewSnapshot>(),
  applyImport: invoke<[request: InventoryApplyImportRequest], NativeInventoryExecution>(),
  projects: invoke<[], readonly InventoryProject[]>(),
  catalog: invoke<[request: InventoryCatalogQuery], readonly InventoryEquipmentCatalogEntry[]>(),
  catalogUpdatePreview: invoke<
    [request: InventoryCatalogUpdatePreviewRequest],
    InventoryEquipmentCatalogUpdatePreview
  >(),
  resolveItemCode: invoke<
    [request: InventoryResolveItemCodeRequest],
    InventoryItemCodeLookupSnapshot
  >(),
  prepareLabel: invoke<[request: InventoryPrepareLabelRequest], InventoryLabelArtifact>(),
  storageConditions: invoke<
    [request: InventoryStorageConditionsRequest],
    InventoryStorageConditionsSnapshot
  >(),
  materials: invoke<[request: InventoryMaterialQuery], InventoryMaterialPage>(),
  inspect: invoke<[request: InventoryReadRequest], InventoryState | null>(),
  availability: invoke<[request: InventoryReadRequest], InventoryAvailabilitySnapshot | null>(),
  execute: invoke<[request: InventoryExecuteRequest], NativeInventoryExecution>(),
  operation: invoke<[request: InventoryOperationRequest], NativeInventoryReceipt | null>(),
  history: invoke<[request: InventoryHistoryRequest], readonly NativeInventoryHistoryEntry[]>(),
  onChanged: event<[event: InventoryChanged]>().channel('inventory:changed'),
});
