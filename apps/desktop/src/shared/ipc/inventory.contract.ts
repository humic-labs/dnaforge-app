import { defineGroup, event, invoke } from './contract';
import type {
  InventoryPreviewPlatePlanObservationRequest,
  InventoryApplyPlatePlanObservationRequest,
  InventoryPlatePlanObservationsRequest,
  InventoryPlatePlanObservationRequest,
  InventoryPlatePlanObservationSourceRequest,
  InventoryPlatePlanObservationPreviewSnapshot,
  InventoryPlatePlanObservationsRead,
  InventoryPlatePlanObservationRead,
  InventoryPlatePlanObservationSourceRead,
} from '../inventory-plate-plan-observations';
import type {
  InventoryPreviewPlatePlanVersionRequest,
  InventoryApplyPlatePlanVersionRequest,
  InventoryPlatePlanVersionsRequest,
  InventoryPlatePlanVersionRequest,
  InventoryPreviewPlatePlanBindingRequest,
  InventoryPlatePlanVersionPreviewSnapshot,
  InventoryPlatePlanVersionsRead,
  InventoryPlatePlanVersionRead,
  InventoryPlatePlanBindingPreviewSnapshot,
} from '../inventory-plate-plans';
import type {
  InventoryPreviewScientificCitationRequest,
  InventoryApplyScientificCitationRequest,
  InventoryPreviewScientificCitationWithdrawalRequest,
  InventoryApplyScientificCitationWithdrawalRequest,
  InventoryScientificCitationsRequest,
  InventoryScientificCitationSourceRequest,
  InventoryScientificCitationPreviewSnapshot,
  InventoryScientificCitationWithdrawalPreviewSnapshot,
  InventoryScientificCitationsRead,
  InventoryScientificCitationSourceRead,
} from '../inventory-scientific-citations';

import type {
  InventoryScientificWorksForContextRequest,
  InventoryScientificWorksForContextRead,
} from '../inventory-scientific-read';
import type {
  InventoryEquipmentCatalogEntry,
  InventoryEquipmentCatalogUpdatePreview,
  InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryScientificContextsRequest,
  InventoryScientificContextsV2Request,
  InventoryScientificContextsV2Snapshot,
  InventoryPreviewScientificTransferV2Request,
  InventoryScientificTransferV2PreviewSnapshot,
  InventoryApplyScientificTransferV2Request,
  InventoryScientificContextsSnapshot,
  InventoryPreviewScientificTransferRequest,
  InventoryScientificTransferPreviewSnapshot,
  InventoryApplyScientificTransferRequest,
  InventoryScientificSourceRequest,
  InventoryScientificSourceRead,
  InventoryPreviewArrivalRequest,
  InventoryApplyArrivalRequest,
  InventoryArrivalDocumentRequest,
  InventoryArrivalPreviewSnapshot,
  InventoryArrivalDocumentRead,
  InventoryStockroomSnapshot,
  InventoryChanged,
  InventoryInspectBenchlingCaptureRequest,
  InventoryBenchlingCaptureSnapshot,
  InventoryPreviewBenchlingCaptureRequest,
  InventoryApplyBenchlingCaptureRequest,
  InventoryBenchlingCapturePreviewSnapshot,
  InventoryExportSnapshotRequest,
  InventoryPreviewImportRequest,
  InventoryApplyImportRequest,
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryPreviewTableRequest,
  InventoryApplyTableRequest,
  InventoryTablePreviewSnapshot,
  InventoryPreviewStocktakeRequest,
  InventoryApplyStocktakeRequest,
  InventoryStocktakePreviewSnapshot,
  InventoryHierarchyPreviewSnapshot,
  InventoryPreviewMappedTableRequest,
  InventoryApplyMappedTableRequest,
  InventoryMappedTablePreviewSnapshot,
  InventoryPreviewHierarchyRequest,
  InventoryApplyHierarchyRequest,
  InventoryPreviewSourceRevisionRequest,
  InventoryAcknowledgeSourceRequest,
  InventorySourceRevisionPreviewSnapshot,
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
  previewPlatePlanObservation: invoke<
    [request: InventoryPreviewPlatePlanObservationRequest],
    InventoryPlatePlanObservationPreviewSnapshot
  >(),
  applyPlatePlanObservation: invoke<
    [request: InventoryApplyPlatePlanObservationRequest],
    NativeInventoryExecution
  >(),
  platePlanObservations: invoke<
    [request: InventoryPlatePlanObservationsRequest],
    InventoryPlatePlanObservationsRead
  >(),
  platePlanObservation: invoke<
    [request: InventoryPlatePlanObservationRequest],
    InventoryPlatePlanObservationRead
  >(),
  platePlanObservationSource: invoke<
    [request: InventoryPlatePlanObservationSourceRequest],
    InventoryPlatePlanObservationSourceRead
  >(),

  previewPlatePlanVersion: invoke<
    [request: InventoryPreviewPlatePlanVersionRequest],
    InventoryPlatePlanVersionPreviewSnapshot
  >(),
  applyPlatePlanVersion: invoke<
    [request: InventoryApplyPlatePlanVersionRequest],
    NativeInventoryExecution
  >(),
  platePlanVersions: invoke<
    [request: InventoryPlatePlanVersionsRequest],
    InventoryPlatePlanVersionsRead
  >(),
  platePlanVersion: invoke<
    [request: InventoryPlatePlanVersionRequest],
    InventoryPlatePlanVersionRead
  >(),
  previewPlatePlanBinding: invoke<
    [request: InventoryPreviewPlatePlanBindingRequest],
    InventoryPlatePlanBindingPreviewSnapshot
  >(),

  previewScientificCitation: invoke<
    [request: InventoryPreviewScientificCitationRequest],
    InventoryScientificCitationPreviewSnapshot
  >(),
  applyScientificCitation: invoke<
    [request: InventoryApplyScientificCitationRequest],
    NativeInventoryExecution
  >(),
  previewScientificCitationWithdrawal: invoke<
    [request: InventoryPreviewScientificCitationWithdrawalRequest],
    InventoryScientificCitationWithdrawalPreviewSnapshot
  >(),
  applyScientificCitationWithdrawal: invoke<
    [request: InventoryApplyScientificCitationWithdrawalRequest],
    NativeInventoryExecution
  >(),
  scientificCitations: invoke<
    [request: InventoryScientificCitationsRequest],
    InventoryScientificCitationsRead
  >(),
  scientificCitationSource: invoke<
    [request: InventoryScientificCitationSourceRequest],
    InventoryScientificCitationSourceRead
  >(),
  scientificWorksForContext: invoke<
    [request: InventoryScientificWorksForContextRequest],
    InventoryScientificWorksForContextRead
  >(),
  scientificContextsV2: invoke<
    [request: InventoryScientificContextsV2Request],
    InventoryScientificContextsV2Snapshot
  >(),
  previewScientificTransferV2: invoke<
    [request: InventoryPreviewScientificTransferV2Request],
    InventoryScientificTransferV2PreviewSnapshot
  >(),
  applyScientificTransferV2: invoke<
    [request: InventoryApplyScientificTransferV2Request],
    NativeInventoryExecution
  >(),
  scientificContexts: invoke<
    [request: InventoryScientificContextsRequest],
    InventoryScientificContextsSnapshot
  >(),
  previewScientificTransfer: invoke<
    [request: InventoryPreviewScientificTransferRequest],
    InventoryScientificTransferPreviewSnapshot
  >(),
  applyScientificTransfer: invoke<
    [request: InventoryApplyScientificTransferRequest],
    NativeInventoryExecution
  >(),
  scientificSource: invoke<
    [request: InventoryScientificSourceRequest],
    InventoryScientificSourceRead
  >(),
  stockroom: invoke<[request: InventoryReadRequest], InventoryStockroomSnapshot | null>(),
  previewArrival: invoke<
    [request: InventoryPreviewArrivalRequest],
    InventoryArrivalPreviewSnapshot
  >(),
  applyArrival: invoke<[request: InventoryApplyArrivalRequest], NativeInventoryExecution>(),
  arrivalDocument: invoke<
    [request: InventoryArrivalDocumentRequest],
    InventoryArrivalDocumentRead
  >(),
  previewBenchlingCapture: invoke<
    [request: InventoryPreviewBenchlingCaptureRequest],
    InventoryBenchlingCapturePreviewSnapshot
  >(),
  applyBenchlingCapture: invoke<
    [request: InventoryApplyBenchlingCaptureRequest],
    NativeInventoryExecution
  >(),
  inspectBenchlingCapture: invoke<
    [request: InventoryInspectBenchlingCaptureRequest],
    InventoryBenchlingCaptureSnapshot
  >(),
  previewMappedTable: invoke<
    [request: InventoryPreviewMappedTableRequest],
    InventoryMappedTablePreviewSnapshot
  >(),
  applyMappedTable: invoke<[request: InventoryApplyMappedTableRequest], NativeInventoryExecution>(),
  previewHierarchy: invoke<
    [request: InventoryPreviewHierarchyRequest],
    InventoryHierarchyPreviewSnapshot
  >(),
  applyHierarchy: invoke<[request: InventoryApplyHierarchyRequest], NativeInventoryExecution>(),
  previewSourceRevision: invoke<
    [request: InventoryPreviewSourceRevisionRequest],
    InventorySourceRevisionPreviewSnapshot
  >(),
  acknowledgeSource: invoke<
    [request: InventoryAcknowledgeSourceRequest],
    NativeInventoryExecution
  >(),
  previewStocktake: invoke<
    [request: InventoryPreviewStocktakeRequest],
    InventoryStocktakePreviewSnapshot
  >(),
  applyStocktake: invoke<[request: InventoryApplyStocktakeRequest], NativeInventoryExecution>(),
  exportSnapshot: invoke<[request: InventoryExportSnapshotRequest], InventoryExportSnapshot>(),
  previewImport: invoke<[request: InventoryPreviewImportRequest], InventoryImportPreviewSnapshot>(),
  applyImport: invoke<[request: InventoryApplyImportRequest], NativeInventoryExecution>(),
  previewTable: invoke<[request: InventoryPreviewTableRequest], InventoryTablePreviewSnapshot>(),
  applyTable: invoke<[request: InventoryApplyTableRequest], NativeInventoryExecution>(),
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
